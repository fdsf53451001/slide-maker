import {
  type ImageModelOptionSet,
  type ImageOptionValues,
  type ImageProfileOverride,
  selectedChoice,
} from "@slide-maker/core";
import { DEFAULT_IMAGES_REQUEST_SIZE, type OpenAiImageApiShape } from "./image-profile.js";

/**
 * 各家影像模型「可調什麼」的宣告。
 *
 * 這裡是**唯一**還看模型名的地方，而且看的結果只決定「UI 上列出哪些選項」：猜不中就少一組
 * 選項、使用者看得見也講得出來，不是送出請求時靜默少送欄位。加一家新模型＝在下面多註冊一
 * 筆，UI 與伺服器一行都不用改。
 *
 * 註冊時只列**真的支援**的檔位。列一個端點不吃的值，使用者選了之後拿到的是 gateway 的不透
 * 明 400，比不給選項更糟——選項不是選好玩的。
 */

/** Gemini 系吃的解析度檔位（chat translator 會翻成原生的 `imageConfig.imageSize`）。 */
const GEMINI_IMAGE_SIZES = [
  { id: "1k", label: "1K" },
  { id: "2k", label: "2K（推薦）" },
  { id: "4k", label: "4K" },
] as const;

/**
 * `2K` 是畫質的關鍵而非可有可無的調校，所以它同時是「沒設定時」的預設值：2026-07-31 實測
 * 不送時模型只回 1376×768，正規化得**放大 1.40×**；送 `2K` 回 2752×1536，變成**下採樣
 * 0.70×**——放大會糊，下採樣反而銳利。端到端跑真實投影片 fixture：銳利度（Laplacian 變異數）
 * 99.3 → 430.1、0.87–1.0 頻段高頻能量 0.0042% → 0.0300%，代價只有耗時 +17%、token +16%。
 * （拿純色測試圖估會低估收益、高估成本：那組只有 34.8 → 66.9，成本卻是 +60%／+36%。影像的
 * 量測一律要用有內容的 fixture。）`4K` 回 5504×3072／9 MB，對 1920×1080 畫布是浪費。
 */
const GEMINI_DEFAULT_IMAGE_SIZE = "2k";

const geminiChatOptionSet: ImageModelOptionSet = {
  id: "gemini-chat",
  label: "Gemini 影像系列",
  fields: [
    {
      kind: "select",
      id: "imageSize",
      label: "輸出解析度",
      hint: "2K 是實測最佳：不指定時模型只回 1376×768，放大到畫布會糊；4K 只是更大更慢。",
      unsetLabel: "2K（模型預設）",
      choices: [...GEMINI_IMAGE_SIZES],
    },
  ],
  resolve(values: ImageOptionValues): ImageProfileOverride {
    const field = geminiChatOptionSet.fields[0];
    const chosen = field?.kind === "select" ? selectedChoice(field, values) : undefined;
    const resolution = chosen ?? GEMINI_DEFAULT_IMAGE_SIZE;
    return { sizing: { mode: "image_size", resolution: resolution as "1k" | "2k" | "4k" } };
  },
};

/**
 * gpt-image 系的 `size` 只接受幾組固定像素字串，所以這裡列的是尺寸而不是「畫質檔位」——
 * 兩者本來就不是同一種東西，硬套成 1K/2K/4K 會憑空發明這個端點沒有的概念。
 * 本專案畫布是 16:9，橫向那組最接近，故為預設。
 */
const gptImageOptionSet: ImageModelOptionSet = {
  id: "gpt-image",
  label: "gpt-image 系列",
  fields: [
    {
      kind: "select",
      id: "size",
      label: "輸出尺寸",
      hint: "這個端點只接受這幾組尺寸。畫布是 16:9，橫向那組最接近。",
      unsetLabel: `${DEFAULT_IMAGES_REQUEST_SIZE}（模型預設）`,
      choices: [
        { id: "1536x1024", label: "1536×1024（橫向）" },
        { id: "1024x1024", label: "1024×1024（方形）" },
        { id: "1024x1536", label: "1024×1536（直向）" },
      ],
    },
  ],
  resolve(values: ImageOptionValues): ImageProfileOverride {
    const field = gptImageOptionSet.fields[0];
    const chosen = field?.kind === "select" ? selectedChoice(field, values) : undefined;
    return { sizing: { mode: "size", value: chosen ?? DEFAULT_IMAGES_REQUEST_SIZE } };
  },
};

/**
 * xAI Grok Imagine 走 `aspect_ratio`＋`resolution`，不吃 `size`（送 `size` 是 2026-08-28 那次
 * 生成失敗的直接原因）。比例由畫布推導，所以這裡只有解析度一格。
 *
 * 檔位沿用 xAI 的命名；**只有 `2k` 有實機依據**（那是這條通道唯一跑成功過的值），其餘兩個
 * 是依同一組命名推得的，尚未逐一實測。真的踩到端點拒絕時，正確的處置是把那個檔位從這份
 * 清單移掉，而不是在 transport 裡補一個例外。
 */
const grokImagineOptionSet: ImageModelOptionSet = {
  id: "grok-imagine",
  label: "Grok Imagine 系列",
  fields: [
    {
      kind: "select",
      id: "resolution",
      label: "輸出解析度",
      hint: "這個端點用比例＋解析度描述輸出，不吃像素字串。比例固定跟著畫布走。",
      unsetLabel: "2K（模型預設）",
      choices: [
        { id: "1k", label: "1K" },
        { id: "2k", label: "2K（推薦）" },
        { id: "4k", label: "4K" },
      ],
    },
  ],
  resolve(values: ImageOptionValues): ImageProfileOverride {
    const field = grokImagineOptionSet.fields[0];
    const chosen = field?.kind === "select" ? selectedChoice(field, values) : undefined;
    return { sizing: { mode: "aspect_ratio", resolution: (chosen ?? "2k") as "1k" | "2k" | "4k" } };
  },
};

/**
 * 模型名 → option set。比對的是**去掉 vendor 前綴之後**的名字：同一個模型在不同 gateway 上
 * 的 id 寫法本來就不同（CLI2Proxy 的 `grok-imagine-image-2.0` vs OpenRouter 的
 * `x-ai/grok-imagine-image-quality`），只比對開頭會漏掉其中一種寫法。
 */
const MODEL_OPTION_SETS: ReadonlyArray<{ pattern: RegExp; set: ImageModelOptionSet }> = [
  { pattern: /^gemini-.*image/i, set: geminiChatOptionSet },
  { pattern: /^grok-imagine-image/i, set: grokImagineOptionSet },
  { pattern: /^gpt-image/i, set: gptImageOptionSet },
];

function bareModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * 這個模型在這條 transport 上可調什麼；認不出來回 undefined（UI 那格就只剩「依端點預設」）。
 *
 * transport 也會篩：Gemini 系的 `image_size` 只有 chat translator 認得，把它列在 images 這條
 * REST 路徑上等於給一個送出去會被忽略的選項。
 */
export function imageOptionSet(
  shape: OpenAiImageApiShape,
  model: string,
): ImageModelOptionSet | undefined {
  // OpenRouter 的 /images 端點目前不吃任何尺寸欄位，整條通道沒有可調項。
  if (shape === "openrouter-image") return undefined;
  const bare = bareModelName(model);
  const matched = MODEL_OPTION_SETS.find((entry) => entry.pattern.test(bare))?.set;
  if (!matched) return undefined;
  const wantsChat = matched === geminiChatOptionSet;
  return wantsChat === (shape === "chat") ? matched : undefined;
}

/** 供伺服器驗證與測試列舉用；順序即 UI 上的順序。 */
export const IMAGE_OPTION_SETS: ReadonlyArray<ImageModelOptionSet> = [
  geminiChatOptionSet,
  grokImagineOptionSet,
  gptImageOptionSet,
];

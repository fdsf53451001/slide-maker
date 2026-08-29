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
 * xAI Grok Imagine 走 `aspect_ratio`＋`resolution`，不吃 `size`。比例由畫布推導，所以這裡只有
 * 解析度一格。
 *
 * 2026-08-30 實測（CLI2Proxy → xAI，`grok-imagine-image-2.0`，每個候選 3 次，有內容的
 * fixture，銳利度＝正規化到 1920×1080 後的 Laplacian 變異數）：
 *
 * | 送什麼 | 回傳尺寸  | 銳利度 | 耗時  |
 * | ------ | --------- | ------ | ----- |
 * | 不送   | 1024×1024 | 188.1  | 16.9s |
 * | `1k`   | 1280×720  | 356.6  | 16.9s |
 * | `2k`   | 2816×1584 | 1104.4 | 22.0s |
 * | `4k`   | 1280×720  | 354.7  | 16.3s |
 *
 * 三件事：①`2k` 是唯一會下採樣的檔位（2816×1584 → 1920×1080），銳利度是次佳的 3.1 倍，代價
 * 只有 +5 秒，所以它是預設；②**`4k` 沒有列進來**——它回的尺寸與銳利度都與 `1k` 相同，代表端點
 * 根本不認得這個值，列出來就是一個「選了跟沒選一樣」的假選項；③不送尺寸會拿到 1024×1024 方形，
 * cover 到 16:9 要裁掉上下四成，而且是所有選項裡最糊的——這條通道沒有「不指定」這個好選擇。
 */
const grokImagineOptionSet: ImageModelOptionSet = {
  id: "grok-imagine",
  label: "Grok Imagine 系列",
  fields: [
    {
      kind: "select",
      id: "resolution",
      label: "輸出解析度",
      hint: "2K 回 2816×1584（下採樣到畫布，最銳利）；1K 回 1280×720，放大到畫布會糊。",
      unsetLabel: "2K（模型預設）",
      choices: [
        { id: "1k", label: "1K" },
        { id: "2k", label: "2K（推薦）" },
      ],
    },
  ],
  resolve(values: ImageOptionValues): ImageProfileOverride {
    const field = grokImagineOptionSet.fields[0];
    const chosen = field?.kind === "select" ? selectedChoice(field, values) : undefined;
    return {
      sizing: { mode: "aspect_ratio", resolution: (chosen ?? "2k") as "1k" | "2k" | "4k" },
      // 2026-08-30 實測：這個端點的硬上限是 8000（超過回 400 `Prompt length exceeds the
      // maximum allowed length of 8000`），而本專案的影像合約**光是規則段**就 8376 字元／
      // 8412 bytes，完整 prompt 9533 字元／9921 bytes——也就是說即使簡報內容是空的也塞不下。
      // 宣告出來讓它在送出**之前**就明確失敗（帶得出兩個數字），而不是拿一句英文 400 回來。
      // 這個模型因此在合約縮短之前實質不可用；截斷不是解法，見下方那段實測。
      promptMaxBytes: GROK_IMAGINE_PROMPT_MAX_BYTES,
    };
  },
};

/**
 * 為什麼不能靠截斷把 prompt 塞進 8000。
 *
 * 2026-08-30 直接把完整 prompt 硬切到 8000 bytes 送出去（就是 2026-08-28 那版的做法），拿回來
 * 的是一張標題為 **"Hybrid Cloud Adoption: Strategic Drivers and Outcomes"** 的投影片——與餵進去
 * 的簡報內容（導入成效、42→9 分鐘、複核比例、錯誤率）毫無關係。原因是切點落在規則段中間：
 * `UNTRUSTED_PRESENTATION_JSON` 之後那 1445 bytes 的簡報資料整段沒送出去，模型只收到半份規則，
 * 於是自己編了一個題目。圖畫得很漂亮、也「成功」回傳——這是最難察覺的一種失效。
 */
const GROK_IMAGINE_PROMPT_MAX_BYTES = 8000;

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

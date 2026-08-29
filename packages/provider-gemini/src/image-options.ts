import {
  type ImageModelOptionSet,
  type ImageOptionValues,
  type ImageProfileOverride,
  selectedChoice,
} from "@slide-maker/core";

/**
 * 原生 `:generateContent` 上這些影像模型可調什麼。形狀與 provider-openai 的 option set 相同
 * （同一個 core 介面），差別只在這裡沒有 transport 分支——原生端點只有一種。
 *
 * 只列真的支援的檔位：列一個端點不吃的值，使用者選了之後拿到的是不透明的 400。
 */

/**
 * `2K` 同時是唯一有實測依據的推薦值與「沒設定時」的預設：2026-07-31 實測不送 `imageSize` 時
 * 模型只回 1376×768，正規化得**放大 1.40×**；送 `2K` 回 2752×1536，變成**下採樣 0.70×**——
 * 放大會糊，下採樣反而銳利。端到端跑真實投影片 fixture：銳利度（Laplacian 變異數）
 * 99.3 → 430.1、0.87–1.0 頻段高頻能量 0.0042% → 0.0300%，代價只有耗時 +17%、token +16%。
 * `4K` 回 5504×3072／9 MB，對 1920×1080 畫布是浪費。
 */
const DEFAULT_IMAGE_SIZE = "2k";

export const geminiNativeOptionSet: ImageModelOptionSet = {
  id: "gemini-native",
  label: "Gemini 原生影像",
  fields: [
    {
      kind: "select",
      id: "imageSize",
      label: "輸出解析度",
      hint: "2K 是實測最佳：不指定時模型只回 1376×768，放大到畫布會糊；4K 只是更大更慢。",
      unsetLabel: "2K（模型預設）",
      choices: [
        { id: "1k", label: "1K" },
        { id: "2k", label: "2K（推薦）" },
        { id: "4k", label: "4K" },
      ],
    },
  ],
  resolve(values: ImageOptionValues): ImageProfileOverride {
    const field = geminiNativeOptionSet.fields[0];
    const chosen = field?.kind === "select" ? selectedChoice(field, values) : undefined;
    const resolution = (chosen ?? DEFAULT_IMAGE_SIZE) as "1k" | "2k" | "4k";
    return { sizing: { mode: "image_size", resolution } };
  },
};

/**
 * 這個模型可調什麼。原生端點目前所有影像模型共用同一組（都吃 `imageConfig.imageSize`），
 * 所以不看模型名；哪天有例外，就在這裡分流，而不是在 transport 裡補判斷。
 */
export function geminiImageOptionSet(_model: string): ImageModelOptionSet {
  return geminiNativeOptionSet;
}

import { type ResolvedImageProfile, SafeProviderError, utf8ByteLength } from "@slide-maker/core";

/**
 * Maintained image transports:
 *  - `images` / `chat`：CLI2Proxy 相容端點的兩個 adapter（/images/* 與 /chat/completions）。
 *  - `openrouter-image`：OpenRouter 專用 /images 端點（input_references 帶參考圖）。
 */
export type OpenAiImageApiShape = "images" | "chat" | "openrouter-image";

/** Images API 未指定時的請求尺寸（gpt-image 系接受的 16:9 檔位）。 */
export const DEFAULT_IMAGES_REQUEST_SIZE = "1536x1024";

/**
 * 單次請求的影像張數上限，依 transport 而異：chat／openrouter 把影像 base64 內嵌進 JSON
 * body，卡的是 token 與 body 大小；images 是 multipart file part，卡的是端點自身對
 * `image[]` 的張數上限。profile 沒有覆寫時用這裡的值。
 */
/**
 * 沒有任何設定時，一個影像模型同時跑幾個 job。
 *
 * 2 是既有值：往上調撞的是 gateway 的限流（那一整批會一起失敗），往下調到 1 是「一次只跑
 * 一頁」，慢但最不容易被擋。要改的是模型庫的設定，不是這個常數。
 */
export const DEFAULT_IMAGE_CONCURRENCY = 2;

export const MAX_IMAGES_REFERENCES = 16;
export const MAX_CHAT_REFERENCES = 8;
export const MAX_OPENROUTER_REFERENCES = 8;

export const MAX_REFERENCES_BY_SHAPE: Record<OpenAiImageApiShape, number> = {
  images: MAX_IMAGES_REFERENCES,
  chat: MAX_CHAT_REFERENCES,
  "openrouter-image": MAX_OPENROUTER_REFERENCES,
};

/**
 * profile 宣告的張數上限只能**往下**調：端點自身的上限是物理限制，設得比它高只會換來
 * gateway 的不透明 400，而 `jobs.ts` 的 `limitReferences` 會以為還塞得下。
 */
export function referenceLimitFor(
  shape: OpenAiImageApiShape,
  profile: ResolvedImageProfile,
): number {
  const hard = MAX_REFERENCES_BY_SHAPE[shape];
  return profile.maxReferenceImages === undefined
    ? hard
    : Math.min(profile.maxReferenceImages, hard);
}

/**
 * prompt 超過 profile 宣告的位元組上限時**丟具名錯誤，不截斷**（理由見
 * `imageModelProfileSchema.promptMaxBytes`）。未設上限＝不檢查，這是預設。
 */
export function assertPromptBudget(prompt: string, profile: ResolvedImageProfile): void {
  const max = profile.promptMaxBytes;
  if (max === undefined) return;
  const bytes = utf8ByteLength(prompt);
  if (bytes <= max) return;
  throw new SafeProviderError(
    "OPENAI_IMAGE_PROMPT_TOO_LONG",
    `這一頁的生成說明有 ${bytes} 位元組，超過此模型設定的 ${max} 位元組上限。` +
      `請減少這一頁的參考圖或縮短大綱內容，或到模型庫調整這個模型的 prompt 上限。`,
  );
}

/**
 * transport 自己的預設尺寸講法——**與模型無關**，只表達「這條路徑在沒有任何設定時送什麼」。
 * 哪個模型該送什麼由 `image-options.ts` 的 option set 決定，那裡才是唯一看模型名的地方。
 *
 * images 預設送 `size`：這條 REST 路徑上絕大多數模型（gpt-image 系）都吃它，而且不送的話
 * 端點會用自己的預設尺寸。chat 與 openrouter 預設不送：那兩條沒有共通的尺寸欄位，而嚴格的
 * OpenAI 端點可能直接拒絕未知欄位。
 */
export function transportDefaultProfile(
  shape: OpenAiImageApiShape,
  requestSize?: string,
): ResolvedImageProfile {
  if (shape === "images")
    return { sizing: { mode: "size", value: requestSize ?? DEFAULT_IMAGES_REQUEST_SIZE } };
  return { sizing: { mode: "none" } };
}

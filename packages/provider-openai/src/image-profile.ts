import { type ResolvedImageProfile, SafeProviderError, utf8ByteLength } from "@slide-maker/core";

/**
 * Maintained image transports:
 *  - `images` / `chat`：CLI2Proxy 相容端點的兩個 adapter（/images/* 與 /chat/completions）。
 *  - `openrouter-image`：OpenRouter 專用 /images 端點（input_references 帶參考圖）。
 */
export type OpenAiImageApiShape = "images" | "chat" | "openrouter-image";

/**
 * gpt-image 系沒選時送的尺寸（那條端點只接受幾組固定字串，這組最接近 16:9 畫布）。
 * 只有 gpt-image 的 option set 用得到它——**不是**所有 images 通道模型的預設值。
 */
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
 * transport 自己的預設：**一律不送尺寸參數**。
 *
 * 這裡曾經對 `images` 通道無條件送 `size:"1536x1024"`（那是重構前為 gpt-image 寫的）。拿掉
 * 的理由是那個值只是**剛好** OpenAI 吃：別家的 OpenAI-compatible 端點未必認得這個字串，
 * 送過去就是一個不透明的 400；就算認得，值域也未必一樣。送一個猜的值等於賭對方跟 OpenAI
 * 一致——而「假設沒見過的模型會照 OpenAI 的規矩來」正是整個 option set 機制要拔掉的東西。
 *
 * 不送則是把決定權交回端點自己的預設，那是它最清楚的事。真正需要指定尺寸的模型（gpt-image
 * 系就是）由自己的 option set 講出來，連「沒選時送什麼」都在那份宣告裡（`resolve({})`），
 * 所以這一層不必也不該替任何人代言。
 */
export function transportDefaultProfile(): ResolvedImageProfile {
  return { sizing: { mode: "none" } };
}

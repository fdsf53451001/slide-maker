import { type ImageModelProfile, SafeProviderError, utf8ByteLength } from "@slide-maker/core";

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
export function referenceLimitFor(shape: OpenAiImageApiShape, profile: ImageModelProfile): number {
  const hard = MAX_REFERENCES_BY_SHAPE[shape];
  return profile.maxReferenceImages === undefined
    ? hard
    : Math.min(profile.maxReferenceImages, hard);
}

/**
 * prompt 超過 profile 宣告的位元組上限時**丟具名錯誤，不截斷**（理由見
 * `imageModelProfileSchema.promptMaxBytes`）。未設上限＝不檢查，這是預設。
 */
export function assertPromptBudget(prompt: string, profile: ImageModelProfile): void {
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
 * 從模型名猜這是不是 Gemini 系。
 *
 * **這個猜測只准出現在這裡**：它是「建立 provider 時算一次預設值」，結果會落進一個具名
 * 的 profile 物件、可被模型庫 entry 覆寫、而且在產物 metadata 裡看得到。送出請求的那一刻
 * 不再有任何模型名判斷——那正是拿掉的東西：`/^grok-imagine-image/i` 對走 gateway 的真實
 * id `x-ai/grok-imagine-image-quality` 不匹配，整段靜默失效，失效的樣子與沒寫過完全相同。
 * 同一個雷這裡也還在：走 OpenRouter 形式命名的 gemini（`google/gemini-...`）猜不中，
 * 但猜不中的後果現在是「預設值不對，去 UI 改一格」而不是「送出的請求少了關鍵欄位」。
 */
function looksLikeGeminiFamily(model: string): boolean {
  return /^gemini-/i.test(model);
}

/**
 * transport ＋ 模型名推導出的預設 profile。模型庫 entry 有設定時一律以 entry 為準。
 *
 * Gemini 系的 `image_size` 檔位取 `2k`，這是畫質的關鍵而非可有可無的調校：2026-07-31
 * 實測（AI Studio 原生端點與 CLIProxyAPI 的 chat translator 行為一致）不送時模型只回
 * 1376×768，`rasterToCanvasPng` 得**放大 1.40×** 才填滿 1920×1080；送 `2K` 回 2752×1536，
 * 變成**下採樣 0.70×**——放大會糊，下採樣反而銳利。端到端跑真實投影片 fixture：銳利度
 * （Laplacian 變異數）99.3 → 430.1、0.87–1.0 頻段高頻能量 0.0042% → 0.0300%，代價是
 * 耗時 +17%、token +16%（3296 → 3819）。（拿純色測試圖估會低估收益、高估成本：那組只有
 * 34.8 → 66.9，成本卻是 +60%／+36%。影像的量測一律要用有內容的 fixture。）`4k` 回
 * 5504×3072／9 MB，對這個畫布是浪費。與 `packages/provider-gemini` 是同一個決定。
 *
 * 非 Gemini 的 chat 路由與 OpenRouter 不送尺寸：那兩條沒有對應的 translator，而嚴格的
 * OpenAI 端點可能直接拒絕未知欄位。
 */
export function defaultImageProfile(
  shape: OpenAiImageApiShape,
  model: string,
  requestSize?: string,
): ImageModelProfile {
  if (shape === "chat")
    return {
      sizing: looksLikeGeminiFamily(model)
        ? { mode: "image_size", resolution: "2k" }
        : { mode: "none" },
    };
  if (shape === "openrouter-image") return { sizing: { mode: "none" } };
  return { sizing: { mode: "size", value: requestSize ?? DEFAULT_IMAGES_REQUEST_SIZE } };
}

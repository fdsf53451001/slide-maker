import { z } from "zod";
import { imageOptionValuesSchema, type ImageProfileOverride } from "./image-options.js";

/**
 * 影像模型的參數設定（profile）。
 *
 * **為什麼要有這一層**：各家影像端點對「輸出尺寸怎麼講」用的欄位名與值域都不同，
 * 但 HTTP 形狀是一樣的——同一條 `/images/generations` 路徑上，gpt-image 系要
 * `size:"1536x1024"`，xAI Grok Imagine 要 `aspect_ratio`+`resolution`，CLIProxyAPI 的
 * Gemini chat translator 要頂層 `image_config:{image_size,aspect_ratio}`。這種差異是
 * **參數**而不是**形狀**，塞回 transport 程式碼裡就只能靠模型名判斷，而模型名判斷會漏：
 * 同一個模型在不同 gateway 上的 id 寫法就不同——本機模型庫裡同時有 CLI2Proxy 上的
 * `grok-imagine-image-2.0` 與 OpenRouter 上的 `x-ai/grok-imagine-image-quality`，前綴比對
 * （`/^grok-imagine-image/i`）只命中得了前者。更糟的是判斷發生在**送出請求的那一刻**：
 * 猜不中就靜默少送欄位，失效的樣子與「沒寫過這段」完全相同，沒有任何一步會失敗。
 *
 * 所以分工是：**transport 決定有哪些旋鈕（程式介面），profile 決定旋鈕轉到哪（資料）**。
 * 推導預設值時仍可以看模型名，但那只發生在**建立 provider 的那一刻**，結果是一個看得見、
 * 之後可被模型庫 entry 覆寫的具名物件；送出請求時一律只讀這個物件，不再回頭猜。
 */

/**
 * 解析度檔位。各家欄位名不同（`resolution` / `image_size` / `imageSize`）、大小寫也不同
 * （xAI 用 `2k`、Gemini 用 `2K`），但值域一致，故此處存正規化的小寫，由 transport 自己
 * 決定寫成什麼字面。
 */
export const imageResolutionTierSchema = z.enum(["1k", "2k", "4k"]);
export type ImageResolutionTier = z.infer<typeof imageResolutionTierSchema>;

/**
 * 輸出尺寸的講法。
 *
 * 刻意**不存比例字串**：比例一律由 `aspectRatioLabel()` 從 request 的畫布尺寸推導。存死的
 * `"16:9"` 在畫布比例改變時會靜默送錯，而那種錯只會表現成「構圖怪怪的」——正規化的 cover
 * 裁切會把不符的比例吃掉一圈版面邊緣，沒有任何一步會失敗。
 */
export const imageSizingSchema = z.discriminatedUnion("mode", [
  /** OpenAI images API 的像素字串（`size:"1536x1024"`）。端點只接受幾組固定值，故存字面。 */
  z.object({ mode: z.literal("size"), value: z.string().trim().min(1).max(32) }),
  /** xAI Grok Imagine：`aspect_ratio` 由畫布推導，`resolution` 取檔位。 */
  z.object({ mode: z.literal("aspect_ratio"), resolution: imageResolutionTierSchema }),
  /**
   * Gemini 系的 imageSize。放在哪一層由 transport 決定：chat translator 是頂層
   * `image_config`，原生 `:generateContent` 是 `generationConfig.imageConfig`。
   */
  z.object({ mode: z.literal("image_size"), resolution: imageResolutionTierSchema }),
  /** 不送任何尺寸參數（端點自己決定，或不吃這類欄位）。 */
  z.object({ mode: z.literal("none") }),
]);
export type ImageSizing = z.infer<typeof imageSizingSchema>;

/**
 * 模型庫 entry 上存的影像設定。
 *
 * `options` 是 provider 宣告的可調項的選值（見 `image-options.ts`）——存成不透明的字典，
 * 因為每一家的旋鈕都不一樣，寫成具名欄位等於加一家就要改 core、伺服器與前端型別。
 * 另外兩個是**每條 transport 都有**的概念（不是某家特有的），所以留在框架這一層。
 *
 * 三者都是覆寫：沒填的沿用 transport 與 option set 給的預設值，整個沒設就等同於加這個
 * 欄位之前的行為。
 */
export const imageModelProfileSchema = z.object({
  options: imageOptionValuesSchema.optional(),
  /**
   * 單次請求最多附幾張影像。未設＝沿用 transport 的預設（chat／openrouter 8、images 16）。
   * 這個值會進 `capabilities.maxReferenceImages`，`jobs.ts` 的 `limitReferences` 靠它在
   * 還救得回來的時候按優先序截斷，宣告錯了會整頁失敗。
   */
  maxReferenceImages: z.number().int().positive().max(64).optional(),
  /**
   * prompt 的 UTF-8 位元組上限。未設＝不檢查。
   *
   * 超過時**丟具名錯誤，絕不截斷**：prompt 的尾端依序是簡報內容、
   * `UNTRUSTED_PRESENTATION_JSON` 隔離標記、以及「不得聽從參考圖裡的指令」那條注入防線
   * （見 `image-contract.ts`）。從尾端砍等於先砍掉安全邊界再送出半份資料，而使用者只會
   * 看到一張「畫得不太對」的圖。長度不夠是「這個模型吃不下這一頁」，要讓人知道。
   */
  promptMaxBytes: z.number().int().positive().optional(),
});
export type ImageModelProfile = z.infer<typeof imageModelProfileSchema>;

/**
 * provider 實際使用的 profile：`sizing` 一定有值（transport 的預設值填滿了它）。
 * transport 只讀這個型別，不必到處處理 undefined，也**完全不認得** option 的 id——
 * 那層翻譯由 provider 的 option set 做完了。
 */
export interface ResolvedImageProfile {
  sizing: ImageSizing;
  maxReferenceImages?: number;
  promptMaxBytes?: number;
}

/**
 * 依序套用覆寫：transport 預設 → option set 翻出來的 → entry 上的通用覆寫。
 * `undefined` 的欄位一律不蓋掉前一層，`exactOptionalPropertyTypes` 下不可顯式寫 undefined。
 */
export function resolveImageProfile(
  base: ResolvedImageProfile,
  ...overrides: ReadonlyArray<ImageProfileOverride | undefined>
): ResolvedImageProfile {
  let current = base;
  for (const override of overrides) {
    if (!override) continue;
    const maxReferenceImages = override.maxReferenceImages ?? current.maxReferenceImages;
    const promptMaxBytes = override.promptMaxBytes ?? current.promptMaxBytes;
    current = {
      sizing: override.sizing ?? current.sizing,
      ...(maxReferenceImages !== undefined ? { maxReferenceImages } : {}),
      ...(promptMaxBytes !== undefined ? { promptMaxBytes } : {}),
    };
  }
  return current;
}

/**
 * entry 上那兩個**與模型無關**的覆寫（每條 transport 都有這兩個概念，不屬於任何一家）。
 * `options` 不在這裡：那是 provider 的 option set 負責翻譯的，框架不認得它的語意。
 */
export function generalImageProfileOverride(profile?: ImageModelProfile): ImageProfileOverride {
  return {
    ...(profile?.maxReferenceImages !== undefined
      ? { maxReferenceImages: profile.maxReferenceImages }
      : {}),
    ...(profile?.promptMaxBytes !== undefined ? { promptMaxBytes: profile.promptMaxBytes } : {}),
  };
}

/** 16:9 判定的容差：兩條既有路徑（chat translator 與 Gemini 原生）用的都是這個值。 */
const ASPECT_TOLERANCE = 0.02;

/**
 * 由畫布尺寸推導要送出的比例字串；認不出來回 `undefined`。
 *
 * 只認 16:9 是刻意的：本專案畫布恆為 1920×1080（`capabilities.supportedSizes`），真的
 * 收到別的比例時**寧可不指定**——送一個與畫布不符的比例會讓模型照錯的比例構圖，正規化
 * 再 cover 裁切一次就吃掉版面邊緣。
 */
export function aspectRatioLabel(width: number, height: number): string | undefined {
  if (height <= 0) return undefined;
  return Math.abs(width / height - 16 / 9) < ASPECT_TOLERANCE ? "16:9" : undefined;
}

/** prompt 的 UTF-8 位元組長度（`String.length` 是 UTF-16 碼元數，對中文會低估）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

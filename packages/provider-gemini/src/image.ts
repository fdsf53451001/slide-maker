import {
  aspectRatioLabel,
  buildImageGenerationContract,
  type ImageModelProfile,
  type ResolvedImageProfile,
  resolveImageProfile,
  SafeProviderError,
  utf8ByteLength,
  type GeneratedImage,
  type ImageGenerationContext,
  type ImageGenerationRequest,
  type ImageProvider,
  type ImageProviderCapabilities,
  type ProviderAvailability,
  type ProviderPreflightResult,
  withProviderUsage,
} from "@slide-maker/core";
import {
  maskAwareDataUrl,
  parseDataUri,
  rasterToCanvasPng,
  readImageAsDataUrl,
} from "@slide-maker/provider-openai";
import {
  candidateParts,
  generateContent,
  GEMINI_IMAGE_INPUT_FALLBACK,
  GEMINI_IMAGE_OUTPUT_FALLBACK,
  probeReady,
  rethrowAsGeminiError,
  type GeminiClientConfig,
} from "./http.js";
import { parseGeminiUsage } from "./usage.js";

export interface GeminiImageOptions {
  config: GeminiClientConfig;
  model: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "gemini-image"。 */
  id?: string;
  /**
   * 這個模型的參數覆寫（模型庫 entry 上存的那份）。沒填的欄位沿用
   * `DEFAULT_GEMINI_IMAGE_PROFILE`——原生端點只有一種 transport，所以預設值不必看模型名。
   */
  profile?: ImageModelProfile;
}

// 與 provider-openai 的 chat transport 對齊：單次請求塞太多張圖會撐爆 JSON body。
export const MAX_REFERENCES = 8;

/**
 * 原生端點的預設 profile。`imageSize` 取 `2k` 是畫質的關鍵而非可有可無的調校，實測依據
 * 見 `provider-openai` 的 `defaultImageProfile()`——那是同一個決定，兩條路都要送。
 */
export const DEFAULT_GEMINI_IMAGE_PROFILE: ResolvedImageProfile = {
  sizing: { mode: "image_size", resolution: "2k" },
};

interface InlineDataPart {
  inlineData: { mimeType: string; data: string };
}
type ContentPart = { text: string } | InlineDataPart;

/**
 * 只加 invocation 與回應格式指令，內容／風格／reference 規則一律來自共用合約。
 * 模式與 `provider-openai` 的 `chatPrompt()` 相同。
 */
function imagePrompt(request: ImageGenerationRequest): string {
  return [
    request.edit
      ? "Edit the supplied 16:9 presentation slide and return exactly one raster image."
      : "Generate exactly one complete 16:9 presentation slide as a raster image.",
    "Return the image as inline image data in the response. Do not return SVG, HTML, Markdown, code, a data URI in text, or a textual description.",
    buildImageGenerationContract(request),
  ].join("\n");
}

function validateEditReferences(request: ImageGenerationRequest): void {
  if (!request.edit) return;
  if (!request.references[request.edit.baseImageIndex])
    throw new SafeProviderError("GEMINI_IMAGE_BASE_MISSING", "找不到要編輯的基底影像。");
  if (
    request.edit.maskImageIndex !== undefined &&
    !request.references[request.edit.maskImageIndex]
  ) {
    throw new SafeProviderError("GEMINI_IMAGE_MASK_MISSING", "找不到遮罩影像。");
  }
}

/**
 * 安全讀取本機參考圖並轉成 `inlineData` part（沿用 provider-openai 的檔案驗證）。
 *
 * masked edit 的遮罩那張（index === edit.maskImageIndex）是「白框＋透明底」，視覺模型
 * 會把透明底攤成白色而看不到白框，故先經 `maskAwareDataUrl` 攤平成不透明黑底 PNG。
 */
async function inlineReference(
  path: string,
  index: number,
  request: ImageGenerationRequest,
): Promise<InlineDataPart> {
  try {
    const url = maskAwareDataUrl(await readImageAsDataUrl(path), index, request);
    const { mediaType, bytes } = parseDataUri(url);
    return { inlineData: { mimeType: mediaType, data: Buffer.from(bytes).toString("base64") } };
  } catch (error) {
    rethrowAsGeminiError(error, GEMINI_IMAGE_INPUT_FALLBACK);
  }
}

/**
 * 抽出回應中的第一張圖。part 可能同時帶 thoughtSignature，故只看 inlineData 鍵。
 *
 * mimeType 一律以回應宣告的為準，不可假設是哪一種：2026-07-22 實測
 * `gemini-3.1-flash-image`、`gemini-3-pro-image`、`gemini-3.1-flash-lite-image` 回
 * `image/jpeg`，而 `gemini-2.5-flash-image` 回 `image/png`。缺 mimeType 才退 PNG。
 */
export function extractInlineImage(payload: unknown): { mediaType: string; bytes: Uint8Array } {
  for (const part of candidateParts(payload)) {
    const inline = part.inlineData;
    if (typeof inline?.data !== "string" || inline.data.length === 0) continue;
    const mediaType = typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
    try {
      return parseDataUri(`data:${mediaType};base64,${inline.data}`);
    } catch (error) {
      rethrowAsGeminiError(error, GEMINI_IMAGE_OUTPUT_FALLBACK);
    }
  }
  throw new SafeProviderError(
    "GEMINI_IMAGE_MISSING",
    "Gemini 回應缺少 raster 圖片資料；請使用支援圖片輸出的模型。",
  );
}

/**
 * AI Studio 原生 `:generateContent` 影像通道。
 *
 * Gemini 沒有獨立的 edit／mask 端點——遮罩就是「再多一張參考圖」，語意全由共用合約的
 * TEXT REMOVAL／editing 條款承擔，因此三種影像任務（生成／編輯／遮罩去字）走同一條路。
 */
export class GeminiImageProvider implements ImageProvider {
  readonly id: string;
  readonly name = "Gemini 原生影像";
  readonly availability: ProviderAvailability;
  readonly maxConcurrency = 2;
  readonly capabilities: ImageProviderCapabilities;
  readonly #options: GeminiImageOptions;
  readonly #profile: ResolvedImageProfile;

  constructor(options: GeminiImageOptions) {
    this.id = options.id ?? "gemini-image";
    this.#options = options;
    this.#profile = resolveImageProfile(DEFAULT_GEMINI_IMAGE_PROFILE, options.profile);
    this.capabilities = {
      fullSlideGeneration: true,
      referenceImages: true,
      imageEditing: true,
      maskedEditing: true,
      multipleReferenceImages: true,
      // 宣告出來，jobs.ts 才能在組 references 時就按優先序截斷；下面的 throw 仍留著當
      // 最後一道防線（provider 被別的呼叫端直接使用時它是唯一的把關）。
      // profile 只能**往下**調：端點自身的上限是物理限制，設得比它高只會換來不透明的
      // 400，而 jobs.ts 的 limitReferences 會以為還塞得下。
      maxReferenceImages: Math.min(
        this.#profile.maxReferenceImages ?? MAX_REFERENCES,
        MAX_REFERENCES,
      ),
      supportedSizes: [{ width: 1920, height: 1080 }],
      reproducibleParameters: [],
    };
    const configured = Boolean(options.config.baseUrl && options.config.apiKey && options.model);
    this.availability = configured
      ? { status: "available" }
      : { status: "unavailable", reason: "需設定 Gemini 連線的 base URL、API key 與模型名稱。" };
  }

  async preflight(): Promise<ProviderPreflightResult> {
    if (this.availability.status !== "available") return { status: "disabled" };
    return { status: await probeReady(this.#options.config) };
  }

  async generate(
    request: ImageGenerationRequest,
    context?: ImageGenerationContext,
  ): Promise<GeneratedImage> {
    if (context?.signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
    if (this.availability.status !== "available")
      throw new SafeProviderError("GEMINI_IMAGE_DISABLED", "Gemini 影像 provider 未設定。");
    const referenceLimit = this.capabilities.maxReferenceImages ?? MAX_REFERENCES;
    if (request.references.length > referenceLimit)
      throw new SafeProviderError(
        "GEMINI_IMAGE_REFERENCES_LIMIT",
        `Gemini 圖片生成每頁最多接受 ${referenceLimit} 張參考圖。`,
      );
    validateEditReferences(request);
    await context?.onProgress?.({ phase: "launching" });
    const prompt = imagePrompt(request);
    // profile 有宣告 prompt 上限時**丟具名錯誤，不截斷**：prompt 尾端依序是簡報內容、
    // UNTRUSTED_PRESENTATION_JSON 隔離標記與注入防線，從尾端砍等於先砍掉安全邊界。
    const promptMaxBytes = this.#profile.promptMaxBytes;
    if (promptMaxBytes !== undefined) {
      const bytes = utf8ByteLength(prompt);
      if (bytes > promptMaxBytes)
        throw new SafeProviderError(
          "GEMINI_IMAGE_PROMPT_TOO_LONG",
          `這一頁的生成說明有 ${bytes} 位元組，超過此模型設定的 ${promptMaxBytes} 位元組上限。` +
            `請減少這一頁的參考圖或縮短大綱內容，或到模型庫調整這個模型的 prompt 上限。`,
        );
    }

    // 參考圖接在文字之後、依 request.references 原順序 append——合約文字裡的
    // `Image N` 編號就是靠這個順序對齊，實測 Gemini 確實遵守。
    const parts: ContentPart[] = [{ text: prompt }];
    for (const [index, reference] of request.references.entries())
      parts.push(await inlineReference(reference.path, index, request));

    const payload = await generateContent(
      this.#options.config,
      this.#options.model,
      {
        contents: [{ role: "user", parts }],
        generationConfig: {
          // 只要 IMAGE：2026-07-22 對四個影像模型實測全數 200（gemini-3.1-flash-image、
          // gemini-3-pro-image、gemini-2.5-flash-image、gemini-3.1-flash-lite-image），
          // 沒有任何一個要求併帶 "TEXT"。
          responseModalities: ["IMAGE"],
          ...(imageConfigFields(this.#profile, request.width, request.height) ?? {}),
          // 2026-07-23 實測（6 取樣 vs 6 對照）：temperature 0 使文字抽離的漏抹率大幅
          // 下降（平均 ~22 區 → ~5 區）；一般生成／編輯不帶 temperature，保留預設創意度。
          ...(request.edit?.purpose === "text-removal" ? { temperature: 0 } : {}),
        },
      },
      context?.signal,
    );
    await context?.onProgress?.({ phase: "validating_output" });
    // 回應可能是 JPEG 或 PNG（依模型而異；`imageSize:"2K"` 下實測 2752×1536），一律交給
    // 共用的 cover 正規化轉成 canvas 尺寸的 PNG——2K 對 1920×1080 是下採樣，見 profile。
    // usage 先解出來，解圖再包進 withProviderUsage：`GEMINI_IMAGE_MISSING`（模型不支援
    // 圖片輸出、只回了文字）是**往返成功之後**才失敗的，token 已經燒掉，錯誤必須把它帶走。
    const usage = parseGeminiUsage(payload);
    const { mediaType, bytes } = withProviderUsage(usage, () => extractInlineImage(payload));
    let png: Uint8Array;
    try {
      png = await rasterToCanvasPng(bytes, mediaType, request.width, request.height);
    } catch (error) {
      rethrowAsGeminiError(error, GEMINI_IMAGE_OUTPUT_FALLBACK);
    }
    return {
      bytes: png,
      mediaType: "image/png",
      extension: "png",
      model: this.#options.model,
      parameters: { ...request.parameters, transport: "gemini-generate-content" },
      usage,
    };
  }
}

/**
 * 原生 `generationConfig.imageConfig`。送不送、送哪個檔位一律由 profile 決定；預設值與
 * 其實測依據見 `DEFAULT_GEMINI_IMAGE_PROFILE`。
 *
 * `aspectRatio` 與 `imageSize` **分開判斷**：解析度與比例無關，所以非 16:9 時仍然要送
 * `imageSize`。本專案畫布恆為 16:9（`capabilities.supportedSizes` 只有 1920×1080），那個
 * 分支實務上打不到，純屬防禦：真的收到別的比例時寧可不指定 aspectRatio，因為送一個與畫布
 * 不符的比例會讓模型照錯的比例構圖，正規化再 cover 裁切一次就吃掉版面邊緣。
 */
function imageConfigFields(
  profile: ResolvedImageProfile,
  width: number,
  height: number,
): { imageConfig: { imageSize: string; aspectRatio?: string } } | undefined {
  const sizing = profile.sizing;
  // `size`／`aspect_ratio` 是 OpenAI-compatible REST 端點的講法，原生端點沒有對應欄位。
  if (sizing.mode !== "image_size") return undefined;
  const ratio = aspectRatioLabel(width, height);
  return {
    imageConfig: {
      imageSize: sizing.resolution.toUpperCase(),
      ...(ratio ? { aspectRatio: ratio } : {}),
    },
  };
}

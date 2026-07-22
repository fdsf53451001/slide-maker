import {
  buildImageGenerationContract,
  SafeProviderError,
  type GeneratedImage,
  type ImageGenerationContext,
  type ImageGenerationRequest,
  type ImageProvider,
  type ImageProviderCapabilities,
  type ProviderAvailability,
  type ProviderPreflightResult,
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

export interface GeminiImageOptions {
  config: GeminiClientConfig;
  model: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "gemini-image"。 */
  id?: string;
}

// 與 provider-openai 的 chat transport 對齊：單次請求塞太多張圖會撐爆 JSON body。
const MAX_REFERENCES = 8;

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

  constructor(options: GeminiImageOptions) {
    this.id = options.id ?? "gemini-image";
    this.#options = options;
    this.capabilities = {
      fullSlideGeneration: true,
      referenceImages: true,
      imageEditing: true,
      maskedEditing: true,
      multipleReferenceImages: true,
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
    if (request.references.length > MAX_REFERENCES)
      throw new SafeProviderError(
        "GEMINI_IMAGE_REFERENCES_LIMIT",
        `Gemini 圖片生成每頁最多接受 ${MAX_REFERENCES} 張參考圖。`,
      );
    validateEditReferences(request);
    await context?.onProgress?.({ phase: "launching" });

    // 參考圖接在文字之後、依 request.references 原順序 append——合約文字裡的
    // `Image N` 編號就是靠這個順序對齊，實測 Gemini 確實遵守。
    const parts: ContentPart[] = [{ text: imagePrompt(request) }];
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
          ...(aspectRatio(request.width, request.height) ?? {}),
        },
      },
      context?.signal,
    );
    await context?.onProgress?.({ phase: "validating_output" });
    // 回應可能是 JPEG 或 PNG（依模型而異，實測 1376×768），一律交給共用的 cover
    // 正規化轉成 canvas 尺寸的 PNG。
    const { mediaType, bytes } = extractInlineImage(payload);
    let png: Uint8Array;
    try {
      png = rasterToCanvasPng(bytes, mediaType, request.width, request.height);
    } catch (error) {
      rethrowAsGeminiError(error, GEMINI_IMAGE_OUTPUT_FALLBACK);
    }
    return {
      bytes: png,
      mediaType: "image/png",
      extension: "png",
      model: this.#options.model,
      parameters: { ...request.parameters, transport: "gemini-generate-content" },
    };
  }
}

/**
 * 本專案畫布恆為 16:9（`capabilities.supportedSizes` 只有 1920×1080），所以非 16:9 分支
 * 實務上打不到，純屬防禦：真的收到別的比例時寧可不指定 aspectRatio，因為送一個與畫布
 * 不符的比例會讓模型照錯的比例構圖，正規化再 cover 裁切一次就吃掉版面邊緣。
 */
function aspectRatio(
  width: number,
  height: number,
): { imageConfig: { aspectRatio: string } } | undefined {
  if (height <= 0) return undefined;
  return Math.abs(width / height - 16 / 9) < 0.02
    ? { imageConfig: { aspectRatio: "16:9" } }
    : undefined;
}

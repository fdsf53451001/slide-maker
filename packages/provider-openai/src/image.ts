import {
  SafeProviderError,
  type GeneratedImage,
  type ImageGenerationContext,
  type ImageGenerationRequest,
  type ImageProvider,
  type ImageProviderCapabilities,
  type ProviderAvailability,
  type ProviderPreflightResult,
} from "@slide-maker/core";
import { type OpenAiClientConfig, probeReady } from "./http.js";
import { generateViaImagesApi } from "./image-api.js";
import { generateViaChat } from "./image-chat.js";
import { generateViaOpenRouter } from "./image-openrouter.js";

/**
 * Maintained image transports (Codex app-server lives in provider-codex):
 *  - `images` / `chat`：CLI2Proxy 相容端點的兩個 adapter（/images/* 與 /chat/completions）。
 *  - `openrouter-image`：OpenRouter 專用 /images 端點（input_references 帶參考圖）。
 */
export type OpenAiImageApiShape = "images" | "chat" | "openrouter-image";

export interface OpenAiImageOptions {
  config: OpenAiClientConfig;
  model: string;
  /** `chat` supports GPT tool-based and Gemini native image output; `images` targets image-only models. */
  apiShape?: OpenAiImageApiShape;
  /** Images API request size before normalization to the project canvas. */
  requestSize?: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "openai-image"。 */
  id?: string;
}

export class OpenAiCompatibleImageProvider implements ImageProvider {
  readonly id: string;
  readonly name = "OpenAI 相容影像";
  readonly availability: ProviderAvailability;
  readonly maxConcurrency = 2;
  readonly capabilities: ImageProviderCapabilities;
  readonly #options: OpenAiImageOptions;

  constructor(options: OpenAiImageOptions) {
    this.id = options.id ?? "openai-image";
    this.#options = options;
    // 兩種 transport 都支援參考圖：chat 走 image_url parts；images 走 /images/edits 的 image[] 陣列。
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
      : {
          status: "unavailable",
          reason:
            "需設定 SLIDE_MAKER_OPENAI_BASE_URL、SLIDE_MAKER_OPENAI_API_KEY 與 SLIDE_MAKER_OPENAI_IMAGE_MODEL。",
        };
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
      throw new SafeProviderError("OPENAI_IMAGE_DISABLED", "OpenAI 影像 provider 未設定。");
    const shape = this.#options.apiShape ?? "images";
    const size = this.#options.requestSize ?? "1536x1024";
    await context?.onProgress?.({ phase: "launching" });
    const bytes =
      shape === "chat"
        ? await generateViaChat(this.#options.config, this.#options.model, request, context?.signal)
        : shape === "openrouter-image"
          ? await generateViaOpenRouter(
              this.#options.config,
              this.#options.model,
              request,
              context?.signal,
            )
          : await generateViaImagesApi(
              this.#options.config,
              this.#options.model,
              request,
              size,
              context?.signal,
            );
    await context?.onProgress?.({ phase: "validating_output" });
    const transport =
      shape === "chat"
        ? "openai-chat"
        : shape === "openrouter-image"
          ? "openrouter-image"
          : "openai-images";
    return {
      bytes,
      mediaType: "image/png",
      extension: "png",
      model: this.#options.model,
      parameters: {
        ...request.parameters,
        transport,
        ...(shape === "images" ? { size } : {}),
      },
    };
  }
}

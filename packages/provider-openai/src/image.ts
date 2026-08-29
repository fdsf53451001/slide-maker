import {
  generalImageProfileOverride,
  type ImageModelProfile,
  type ResolvedImageProfile,
  resolveImageProfile,
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
import { imageOptionSet } from "./image-options.js";
import {
  DEFAULT_IMAGE_CONCURRENCY,
  type OpenAiImageApiShape,
  referenceLimitFor,
  transportDefaultProfile,
} from "./image-profile.js";

export type { OpenAiImageApiShape };

export interface OpenAiImageOptions {
  config: OpenAiClientConfig;
  model: string;
  /** `chat` supports GPT tool-based and Gemini native image output; `images` targets image-only models. */
  apiShape?: OpenAiImageApiShape;
  /**
   * Images API request size before normalization to the project canvas.
   * `profile` 未給時作為預設 profile 的 `sizing.value`；給了 `profile` 就以它為準。
   */
  requestSize?: string;
  /**
   * 這個模型的參數覆寫（模型庫 entry 上存的那份）。沒填的欄位沿用 transport 與 option set
   * 給的預設值。推導只發生在建構這一刻，送出請求時一律只讀 resolve 之後的物件。
   */
  profile?: ImageModelProfile;
  /** 系統設定的全局並行數；entry 自己填了就以 entry 為準。 */
  systemMaxConcurrency?: number;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "openai-image"。 */
  id?: string;
}

export class OpenAiCompatibleImageProvider implements ImageProvider {
  readonly id: string;
  readonly name = "OpenAI 相容影像";
  readonly availability: ProviderAvailability;
  readonly maxConcurrency: number;
  readonly capabilities: ImageProviderCapabilities;
  readonly #options: OpenAiImageOptions;
  readonly #shape: OpenAiImageApiShape;
  readonly #profile: ResolvedImageProfile;

  constructor(options: OpenAiImageOptions) {
    this.id = options.id ?? "openai-image";
    this.#options = options;
    this.#shape = options.apiShape ?? "images";
    // 三層：transport 預設 → 這個模型的 option set 翻出來的 → entry 上與模型無關的覆寫。
    // option set 的 `resolve({})` 就是這個模型的預設行為，所以「沒設定」與「使用者選了」
    // 走的是同一條路，不會分岔成兩套規則。
    const optionSet = imageOptionSet(this.#shape, options.model);
    this.#profile = resolveImageProfile(
      transportDefaultProfile(this.#shape, options.requestSize),
      // 系統的全局預設排在 entry 之前：entry 沒填才輪到它。
      options.systemMaxConcurrency === undefined
        ? undefined
        : { maxConcurrency: options.systemMaxConcurrency },
      optionSet?.resolve(options.profile?.options ?? {}),
      generalImageProfileOverride(options.profile),
    );
    this.maxConcurrency = this.#profile.maxConcurrency ?? DEFAULT_IMAGE_CONCURRENCY;
    // 兩種 transport 都支援參考圖：chat 走 image_url parts；images 走 /images/edits 的 image[] 陣列。
    this.capabilities = {
      fullSlideGeneration: true,
      referenceImages: true,
      imageEditing: true,
      maskedEditing: true,
      multipleReferenceImages: true,
      // 上限依 transport 而異（chat／openrouter 卡 JSON body 大小＝8，images 卡端點自身的
      // `image[]` 張數＝16），profile 可以再往下調。宣告的必須是**這個實例真的會走的那
      // 一條**，否則 jobs.ts 會依一個不存在的上限截斷（或不截斷而撞上 transport 的 throw）。
      maxReferenceImages: referenceLimitFor(this.#shape, this.#profile),
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
    const shape = this.#shape;
    const profile = this.#profile;
    await context?.onProgress?.({ phase: "launching" });
    const generated =
      shape === "chat"
        ? await generateViaChat(
            this.#options.config,
            this.#options.model,
            request,
            profile,
            context?.signal,
          )
        : shape === "openrouter-image"
          ? await generateViaOpenRouter(
              this.#options.config,
              this.#options.model,
              request,
              profile,
              context?.signal,
            )
          : await generateViaImagesApi(
              this.#options.config,
              this.#options.model,
              request,
              profile,
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
      bytes: generated.bytes,
      mediaType: "image/png",
      extension: "png",
      model: this.#options.model,
      parameters: {
        ...request.parameters,
        transport,
        // 產物 metadata 帶著實際送出的尺寸參數，之後查「這張是用什麼設定生的」才有依據。
        ...(profile.sizing.mode === "size" ? { size: profile.sizing.value } : {}),
        ...(profile.sizing.mode === "aspect_ratio" || profile.sizing.mode === "image_size"
          ? { resolution: profile.sizing.resolution }
          : {}),
      },
      usage: generated.usage,
    };
  }
}

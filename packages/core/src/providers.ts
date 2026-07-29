import type { z } from "zod";
import type {
  PresentationBrief,
  PresentationProject,
  SlideSpec,
  SourceAsset,
  SourceCitation,
  StylePreset,
  WebSearchResult,
} from "./schemas.js";

export interface ImageProviderCapabilities {
  /**
   * 是否能從大綱整頁生成投影片。局部用途的 provider（如 local-inpaint 只做
   * 遮罩去字）宣告 false；一般「生成／重新生成圖片」流程會在 enqueue 時擋下。
   */
  fullSlideGeneration: boolean;
  referenceImages: boolean;
  imageEditing: boolean;
  maskedEditing: boolean;
  multipleReferenceImages: boolean;
  supportedSizes: ReadonlyArray<{ width: number; height: number }>;
  reproducibleParameters: ReadonlyArray<string>;
}

export type ProviderAvailability =
  { status: "available"; warning?: string } | { status: "unavailable"; reason: string };

/** 附加影像的角色。合約依此決定每張圖的說明文字與適用的規則。 */
export type ImageReferenceRole = "style" | "content" | "direct-asset" | "base" | "mask";

export interface ImageGenerationRequest {
  projectId: string;
  slide: SlideSpec;
  style: StylePreset;
  width: number;
  height: number;
  references: ReadonlyArray<{
    path: string;
    mediaType: string;
    /**
     * `base`／`mask` 是編輯任務的內建輸入（被 `edit.baseImageIndex`／`maskImageIndex`
     * 指到的那兩張），必須與補充參考圖分開標記：把底圖標成 `content` 會讓它落入
     * 「參考圖不得把文字帶進輸出」這類**全新生成**專用的禁令，等於叫模型丟掉原圖上
     * 的所有文字（916fa47 的成因）。
     */
    role: ImageReferenceRole;
    name?: string;
  }>;
  model: string;
  parameters: Record<string, unknown>;
  edit?: {
    instruction: string;
    baseImageIndex: number;
    maskImageIndex?: number;
    /** 標記遮罩去字任務：provider 必須改用文字移除合約，而非一般編輯合約。 */
    purpose?: "text-removal";
  };
}

/**
 * 一次模型呼叫回報的用量。
 *
 * 每個欄位都是 optional 的原因與 `reported` 的存在是同一件事：各家 wire 形狀回報的欄位
 * 並不重疊（chat 端點沒有 `imageTokens`、images 端點沒有 `reasoningTokens`、Codex CLI
 * 一個都沒有），把缺的欄位補 0 會讓「這條通道沒回報」與「這次真的沒用到」在聚合後永遠
 * 分不開——而那兩者要採取的行動完全相反（前者是我們的解析壞了，後者是正常結果）。
 * 所以：解析不到任何已知欄位一律 `{ reported: false }`，**絕不填 0**。
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  /** 影像輸出的 token（images 端點的 `output_tokens_details.image_tokens`）。 */
  imageTokens?: number;
  /**
   * provider 有沒有真的回報用量。false ≠ 0——UI 必須分得出「這次沒用 token」與
   * 「這條通道沒回報」。任何解析不到的情況一律 reported:false，絕不填 0。
   */
  reported: boolean;
  /**
   * 實際扣款（目前只有 OpenRouter 回）。金額 UI 尚未實作，但欄位現在就留、解析時順手
   * 存進帳本，之後開 UI 就不必回頭改 provider 與帳本。存原值，不換算幣別。
   */
  cost?: { amount: number; unit: "openrouter-credit" };
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mediaType: string;
  extension: string;
  model: string;
  parameters: Record<string, unknown>;
  /** 這次生成的模型用量。provider 未回報時省略（見 {@link ProviderUsage}）。 */
  usage?: ProviderUsage;
}

export type GenerationPhase = "launching" | "waiting_for_codex" | "validating_output";

export interface ImageGenerationProgress {
  phase: GenerationPhase;
  eventCode?: "turn_started" | "item_completed" | "turn_completed";
}

export type ChildExitClass = "success" | "nonzero" | "timeout" | "aborted" | "server_shutdown";

export type ImageGenerationLifecycleEvent =
  { type: "spawned" } | { type: "exited"; exitClass: Exclude<ChildExitClass, "server_shutdown"> };

export type ProviderPreflightStatus =
  | "ready"
  | "ready_experimental"
  | "disabled"
  | "cli_missing"
  | "incompatible"
  | "auth_required"
  | "timeout"
  | "artifact_unsupported"
  | "unknown";

export interface ProviderPreflightResult {
  status: ProviderPreflightStatus;
}

export interface ImageGenerationContext {
  signal?: AbortSignal;
  onProgress?: (progress: ImageGenerationProgress) => void | Promise<void>;
  onLifecycle?: (event: ImageGenerationLifecycleEvent) => void | Promise<void>;
}

export class SafeProviderError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(code);
    this.name = "SafeProviderError";
  }
}

export interface ImageProvider {
  readonly id: string;
  readonly name: string;
  readonly availability: ProviderAvailability;
  /** Maximum jobs this process may execute concurrently for this provider. */
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
  readonly artifactContract?: "supported" | "unsupported";
  readonly capabilities: ImageProviderCapabilities;
  readonly settingsSchema?: z.ZodType;
  /** A bounded, non-generating readiness check. It must never expose raw process output. */
  preflight?(): Promise<ProviderPreflightResult>;
  generate(
    request: ImageGenerationRequest,
    context?: ImageGenerationContext,
  ): Promise<GeneratedImage>;
}

export interface LLMProvider {
  readonly id: string;
  createBrief(input: string): Promise<PresentationBrief>;
  createOutline(
    brief: PresentationBrief,
    context: ReadonlyArray<SourceCitation>,
  ): Promise<SlideSpec[]>;
}

export interface StructuredTextRequest {
  /** 完整 prompt（含 untrusted 資料前綴約定）。 */
  prompt: string;
  /** 期望輸出的 JSON schema，用於強制結構化輸出。 */
  outputSchema: Record<string, unknown>;
  /** 可選的參考影像（本機檔案路徑，供 vision 模型）。 */
  imagePaths?: ReadonlyArray<string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 一次結構化文字呼叫的結果。
 *
 * 刻意把回傳型別從裸 `unknown` 換成這個信封，而不是加一個 `onUsage` callback：現在的毛病
 * 就是「usage 靜默被丟掉」，callback 可以不接、型別不會提醒任何人，而換型別會讓每一個
 * 呼叫點都被編譯器逼著正視它。
 */
export interface StructuredTextResult {
  value: unknown;
  usage?: ProviderUsage;
}

/**
 * 結構化文字生成（純推理，不瀏覽網路）。網路搜尋一律交由
 * {@link WebSearchProvider} 處理，再把來源餵進 prompt。
 */
export interface StructuredTextProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  preflight?(): Promise<ProviderPreflightResult>;
  runStructured(request: StructuredTextRequest): Promise<StructuredTextResult>;
}

/** 一次網路搜尋呼叫的結果。信封化的理由同 {@link StructuredTextResult}。 */
export interface WebSearchOutcome {
  results: WebSearchResult[];
  usage?: ProviderUsage;
}

/**
 * 網路搜尋後端。從文字推理中解耦——不論文字引擎是否具備瀏覽能力，
 * 搜尋都由此接口的實作負責。
 */
export interface WebSearchProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  preflight?(): Promise<ProviderPreflightResult>;
  search(
    query: string,
    limit: number,
    language: string,
    signal?: AbortSignal,
  ): Promise<WebSearchOutcome>;
}

export interface SourceProvider {
  readonly id: string;
  readonly supportedMediaTypes: ReadonlyArray<string>;
  parse(source: SourceAsset, absolutePath: string): Promise<ReadonlyArray<SourceChunk>>;
}

export interface SourceChunk {
  id: string;
  sourceId: string;
  text: string;
  locator?: string;
}

export interface Retriever {
  readonly id: string;
  index(projectId: string, chunks: ReadonlyArray<SourceChunk>): Promise<void>;
  search(projectId: string, query: string, limit: number): Promise<ReadonlyArray<SourceChunk>>;
}

export interface StyleRepository {
  list(): Promise<StylePreset[]>;
  get(id: string, version?: number): Promise<StylePreset | undefined>;
  save(style: StylePreset): Promise<void>;
}

export interface StorageAdapter {
  listProjects(): Promise<PresentationProject[]>;
  loadProject(id: string): Promise<PresentationProject | undefined>;
  saveProject(project: PresentationProject): Promise<void>;
  saveAsset(projectId: string, relativePath: string, bytes: Uint8Array): Promise<string>;
}

export interface Exporter {
  readonly id: string;
  readonly mediaType: string;
  export(project: PresentationProject): Promise<Uint8Array>;
}

export class ProviderRegistry<T extends { readonly id: string }> {
  readonly #providers = new Map<string, T>();

  register(provider: T): this {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
    return this;
  }

  get(id: string): T {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  list(): T[] {
    return [...this.#providers.values()];
  }
}

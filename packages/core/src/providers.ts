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

/**
 * 把兩次呼叫的用量併成一筆。
 *
 * 存在的理由是「一次邏輯呼叫 ≠ 一個 HTTP 請求」：provider 內部對暫時性失敗自己會重試，
 * 每一輪都是完整的長 prompt、都燒 token，只回報最後一輪等於系統性低估——而低估最多的
 * 正好是重試跑滿的那些最貴的情況。
 *
 * 三條規則：
 *  ① 任一邊 `reported` 則結果 `reported:true`。**不可**改成「兩邊都要 reported」：一輪回報、
 *    一輪沒回報時，回報的那一輪的數字是真的，丟掉它才是錯的。
 *  ② 逐欄相加，**缺的欄位維持不存在**（不是 0）——`reported:false` 與「這次沒用 token」
 *    要分得開，補 0 會讓兩者在聚合後永遠混在一起。
 *  ③ cost 同樣相加；單位只有一種，不換算。
 */
export function mergeUsage(
  left: ProviderUsage | undefined,
  right: ProviderUsage | undefined,
): ProviderUsage {
  if (!left) return right ?? { reported: false };
  if (!right) return left;
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  const inputTokens = add(left.inputTokens, right.inputTokens);
  const outputTokens = add(left.outputTokens, right.outputTokens);
  const reasoningTokens = add(left.reasoningTokens, right.reasoningTokens);
  const cachedTokens = add(left.cachedTokens, right.cachedTokens);
  const totalTokens = add(left.totalTokens, right.totalTokens);
  const imageTokens = add(left.imageTokens, right.imageTokens);
  const costAmount = add(left.cost?.amount, right.cost?.amount);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(imageTokens === undefined ? {} : { imageTokens }),
    ...(costAmount === undefined
      ? {}
      : { cost: { amount: costAmount, unit: "openrouter-credit" as const } }),
    reported: left.reported || right.reported,
  };
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

/** 一次 provider 呼叫的「已經花掉什麼」。失敗路徑要靠它把成本帶回呼叫端。 */
export interface ProviderCallFacts {
  usage?: ProviderUsage;
  /** 這次邏輯呼叫實際送出的 HTTP 請求數（含 provider 內部重試）。 */
  requests?: number;
}

export class SafeProviderError extends Error {
  /**
   * 往返**成功之後**才失敗時所花掉的用量。
   *
   * 這條路的共同形狀是「payload 已經在手上、usage 就在同一個物件裡」：搜尋回了一整包
   * grounding 卻沒有一筆可驗證的網頁、重試三輪都不是合法 JSON、影像回應解不出圖——token
   * 全都燒掉了，只是沒有產出。少了這個欄位，呼叫端的 catch 只能記 `reported:false`，
   * 而那與「這個 gateway 不回報用量」長得一模一樣。
   */
  readonly usage?: ProviderUsage;
  readonly requests?: number;

  constructor(
    readonly code: string,
    readonly safeMessage: string,
    facts?: ProviderCallFacts,
  ) {
    super(code);
    this.name = "SafeProviderError";
    if (facts?.usage !== undefined) this.usage = facts.usage;
    if (facts?.requests !== undefined) this.requests = facts.requests;
  }
}

/**
 * 罩住「往返已經成功、token 已經燒掉」之後的解析區段：區段內丟出的 `SafeProviderError`
 * 會帶著這次的用量冒上去。
 *
 * 刻意只補在 `usage` 還沒被設過的錯誤上，也刻意不碰非 `SafeProviderError` 的例外
 * （取消是 `AbortError`，改寫它等於把取消變成失敗）。
 */
export function withProviderUsage<T>(usage: ProviderUsage | undefined, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw attachProviderCallFacts(error, { ...(usage === undefined ? {} : { usage }) });
  }
}

/**
 * 把「這次已經花掉什麼」黏到一個既有的例外上（回傳的是新的 `SafeProviderError`，原本那個
 * 不動）。非 `SafeProviderError` 一律原樣回傳——取消走的是 `AbortError`，改寫它等於把
 * 使用者按的取消變成一次失敗。
 */
export function attachProviderCallFacts(error: unknown, facts: ProviderCallFacts): unknown {
  if (!(error instanceof SafeProviderError)) return error;
  const usage = error.usage ?? facts.usage;
  const requests = error.requests ?? facts.requests;
  if (usage === undefined && requests === undefined) return error;
  return new SafeProviderError(error.code, error.safeMessage, {
    ...(usage === undefined ? {} : { usage }),
    ...(requests === undefined ? {} : { requests }),
  });
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
  /** 這次邏輯呼叫的**總**用量（含 provider 內部重試的每一輪，見 {@link mergeUsage}）。 */
  usage?: ProviderUsage;
  /**
   * 實際送出的 HTTP 請求數。與 usage 分開的理由：gateway 不回報用量時 usage 全是空的，
   * 但「這次重跑了幾次」仍然是問得出來的——那是 UI 上唯一能解釋成本的東西。
   */
  requests?: number;
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

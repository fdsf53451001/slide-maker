import type {
  EditableTextBox,
  GenerationJob,
  ModelCombination,
  ModelConnection,
  ModelEntry,
  ModelLibrary,
  ModelLibrarySystem,
  PageNumberSettings,
  PresentationBrief,
  PresentationProject,
  SlideSpec,
  SourceAsset,
  StylePreset,
  StyleReferenceImage,
} from "@slide-maker/core";

export interface ProviderSummary {
  id: string;
  name: string;
  availability:
    { status: "available"; warning?: string } | { status: "unavailable"; reason: string };
  capabilities: {
    fullSlideGeneration: boolean;
    imageEditing?: boolean;
    maskedEditing?: boolean;
    referenceImages?: boolean;
    multipleReferenceImages?: boolean;
  };
  timeoutMs?: number;
}

export interface ProviderReadiness {
  providerId: string;
  status:
    | "ready"
    | "ready_experimental"
    | "disabled"
    | "cli_missing"
    | "incompatible"
    | "auth_required"
    | "timeout"
    | "artifact_unsupported"
    | "unknown";
  blocking: boolean;
  requiresAcknowledgement: boolean;
  message: string;
  checkedAt: string;
  expiresAt: string;
}

export interface WebSearchResult {
  url: string;
  title: string;
  summary: string;
}

/** 「貼上網址」單筆失敗：`reason` 是伺服器的錯誤代碼，翻譯留在 UI 層。 */
export interface UrlSourceFailure {
  url: string;
  reason: string;
}

/** 全部網址都失敗時 `addUrlSources` 丟出的錯誤，附帶逐筆原因。 */
export interface UrlSourceError extends Error {
  failures: UrlSourceFailure[];
}

export interface PdfDeckInspection {
  totalPages: number;
  truncated: boolean;
  maxPages: number;
  /** 比例符合第一頁、可匯入的頁碼。 */
  acceptedPages: number[];
  /** 比例不符而略過的頁碼（選檔階段就列出）。 */
  skippedPages: number[];
  /** 連縮圖都 render 不出來的頁碼。 */
  failedPages: number[];
  previews: { pageNumber: number; dataUrl: string }[];
}

export interface PdfDeckImportReport {
  totalPages: number;
  importedPages: number[];
  skippedPages: number[];
  failedPages: number[];
  /**
   * 頁面匯入了，但「可編輯文字」版本沒建起來的頁。掃描頁本來就沒有原生文字，
   * 不算失敗、不列在這裡。
   */
  textLayerFailedPages: number[];
  truncated: boolean;
}

export interface TextProviderSummary {
  id: string;
  name: string;
  availability:
    { status: "available"; warning?: string } | { status: "unavailable"; reason: string };
  isDefault: boolean;
}

/**
 * `GET /api/projects/:id/usage` 的回應形狀。
 *
 * 真相在 `apps/server/src/usage-ledger.ts`（`UsageBucket`／`UsageModelBucket`／`UsageSummary`）；
 * 那些型別住在 server 套件裡、editor 沒有相依，所以這裡只寫**最小必要的線上形狀**。
 * 兩邊有落差時以伺服器那份為準。
 *
 * **前端不得自己重算任何一個聚合數字**：`unreportedCalls` 是伺服器明確算好給前端的（正是
 * 為了不讓前端拿 `calls - reportedCalls - localCalls` 自己減，那份規則必然漂移），未回報的
 * 呼叫也刻意一個 token 都沒有計進去。頂層與**每一個分組桶**都帶著這個欄位，而且是伺服器
 * 同一段聚合程式碼算出來的，所以分組層級照樣直接讀欄位就好。
 */
export interface UsageBucket {
  /** 邏輯呼叫數（一筆紀錄一次）。 */
  calls: number;
  /** 實際送出的 HTTP 請求數（含 provider 內部重試）。 */
  requests: number;
  /** provider 真的回報了用量的筆數。 */
  reportedCalls: number;
  /** 燒了配額、但模型端沒回報用了多少的筆數。**伺服器算好的，前端不得自己減。** */
  unreportedCalls: number;
  /** 本機 provider（mock／local）的筆數：沒碰模型、沒燒配額。 */
  localCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  imageTokens: number;
  totalTokens: number;
}

export interface UsageModelBucket extends UsageBucket {
  modelEntryId: string;
  model: string;
  providerKind: string;
}

export interface UsageSummary {
  totalCalls: number;
  totalRequests: number;
  reportedCalls: number;
  /**
   * 燒了配額、但模型端沒有回報用了多少的呼叫數。**絕不可當成 0 併進總數。**
   * 與 `totals.unreportedCalls` 是同一個數字，也等於各分組桶相加。
   */
  unreportedCalls: number;
  /** 本機 provider 的呼叫數（沒燒配額，與「未回報」是兩件事）。 */
  localCalls: number;
  failedCalls: number;
  totals: UsageBucket;
  byCapability: Record<string, UsageBucket>;
  byOperation: Record<string, UsageBucket>;
  /** 伺服器已依 calls 由多到少排好序。 */
  byModel: UsageModelBucket[];
  /** 金額 UI 尚未實作；這次一個字都不顯示。 */
  cost?: { unit: "openrouter-credit"; amount: number };
  firstAt?: string;
  lastAt?: string;
  malformedLines: number;
  /** 帳本輪替過：這份統計不是專案的全部歷史。 */
  truncated: boolean;
  /** 被輪替砍掉的紀錄數（累計）。 */
  droppedRecords: number;
  /** 帳本存在卻讀不出來：數字是空的，但那不代表沒有呼叫過。 */
  unreadable: boolean;
}

type ApiFailure = {
  error?: string;
  message?: string;
  issues?: { path?: (string | number)[]; message?: string }[];
};

// 伺服器對 zod 驗證失敗只回 `INVALID_REQUEST` 這個代碼，細節在 `issues` 裡；
// 一併攤平成訊息，使用者才知道是哪個欄位不合法（例如 purpose 超過上限）。
// provider／模型庫／PDF 匯入／風格分析的失敗則是 `{ error: code, message }`，
// `message` 就是寫給使用者的那一句；有它就只顯示它，不要在前面掛一串錯誤碼——
// 裸的 `STYLE_ANALYSIS_DISABLED`、`PDF_ASPECT_UNSUPPORTED` 對使用者沒有意義，
// 而 PDF 匯入對話框正是新使用者看到的第一個畫面。沒有 `message` 才退回代碼。
//
// 收 `Response` 而不是收一個 `fallback: string`，是為了保證**回傳值永不為空字串**。
// 舊版的鏈尾是呼叫端傳進來的 `response.statusText`，而 HTTP/2 沒有 reason phrase，
// `statusText` 在上面永遠是 `""`——於是「伺服器只回了狀態碼」這種失敗會產生一個空訊息，
// 而空訊息在前端一律被讀成「沒有東西要顯示」甚至被讀成成功：`{error && <ErrorToast/>}`
// 整條 toast 不會出現，`if (failed) return;` 那類判斷會當成成功往下走並清掉使用者填好的欄位。
// 一句「HTTP 500」資訊很少，但它至少是一句話。第三個參數留給「HTTP 狀態本身不是原因」的
// 呼叫端（`addUrlSources` 在 200 但 payload 缺 project 時也走這裡）。
function failureMessage(
  body: unknown,
  response: Response,
  fallback = response.statusText.trim() || `HTTP ${response.status}`,
): string {
  if (typeof body !== "object" || body === null) return fallback;
  const failure = body as ApiFailure;
  const detail = (failure.issues ?? [])
    .map((issue) => {
      const field = (issue.path ?? []).join(".");
      return [field, issue.message].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join("；");
  return [failure.message || failure.error || fallback, detail].filter(Boolean).join(" — ");
}

/** 失敗回應裡的錯誤代碼（`{ error: "OCR_QUEUE_BUSY" }`）；沒有就是 `undefined`。 */
function failureCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as ApiFailure).error;
  return typeof code === "string" && code ? code : undefined;
}

/**
 * API 失敗。`message` 與以前完全一樣（就是給使用者看的那一句），另外把伺服器的錯誤代碼
 * 與 HTTP 狀態一起帶出來。
 *
 * 代碼是給「要依失敗種類分岔」的呼叫端用的：批次抽字必須分辨「這一頁不行」（`OCR_NO_TEXT`
 * 之類，跳過繼續跑）與「伺服器現在整個不行」（`OCR_QUEUE_BUSY`，再送下一頁只是重複失敗）。
 * **不要**改成比對 `message` 字串——那是寫給人看的繁中句子，改一個字就會讓分岔悄悄失效。
 * 既有的 `reason instanceof Error ? reason.message : …` 顯示路徑不受影響。
 */
export class ApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;
  constructor(message: string, status: number, code: string | undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json()) as T | ApiFailure;
  if (!response.ok)
    throw new ApiError(failureMessage(body, response), response.status, failureCode(body));
  return body as T;
}

export const api = {
  listProjects: () => request<PresentationProject[]>("/api/projects"),
  getProject: (id: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (topic: string, styleId?: string) =>
    request<PresentationProject>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ topic, styleId }),
    }),
  updateBrief: (projectId: string, patch: Partial<PresentationBrief>) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/brief`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  updatePageNumber: (
    projectId: string,
    patch: Partial<Omit<PageNumberSettings, "background">> & {
      background?: Partial<PageNumberSettings["background"]>;
    },
  ) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/page-number`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  updateProjectName: (projectId: string, name: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteProject: (projectId: string) =>
    request<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
  /** 專案的模型用量統計；伺服器端已聚合完成，前端只負責顯示。 */
  projectUsage: (projectId: string) =>
    request<UsageSummary>(`/api/projects/${encodeURIComponent(projectId)}/usage`),
  textProviders: () => request<TextProviderSummary[]>("/api/text-providers"),
  regenerateOutline: (projectId: string, replace = false, textEngine?: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/outline`, {
      method: "POST",
      body: JSON.stringify({ replace, ...(textEngine ? { textEngine } : {}) }),
    }),
  styles: () => request<StylePreset[]>("/api/styles"),
  getStyle: (styleId: string) => request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}`),
  styleVersions: (styleId: string) =>
    request<StylePreset[]>(`/api/styles/${encodeURIComponent(styleId)}/versions`),
  createStyle: (input: Partial<StylePreset> & { name: string }) =>
    request<StylePreset>("/api/styles", { method: "POST", body: JSON.stringify(input) }),
  updateStyle: (styleId: string, input: Partial<StylePreset>) =>
    request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  duplicateStyle: (styleId: string) =>
    request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}/duplicate`, {
      method: "POST",
    }),
  restoreStyle: (styleId: string, version: number) =>
    request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}/versions/${version}/restore`, {
      method: "POST",
    }),
  applyStyle: (projectId: string, styleId: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/style`, {
      method: "POST",
      body: JSON.stringify({ styleId }),
    }),
  providers: () => request<ProviderSummary[]>("/api/providers"),
  readiness: (providerId: string) =>
    request<ProviderReadiness>(`/api/providers/${encodeURIComponent(providerId)}/readiness`),
  updateSlide: (
    projectId: string,
    slideId: string,
    patch: Pick<
      SlideSpec,
      | "purpose"
      | "content"
      | "narrative"
      | "layoutHint"
      | "imagePrompt"
      | "sourceIds"
      | "pinnedSourceIds"
    >,
  ) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    ),
  /**
   * 與 `updateSlide` 同一個 PATCH 端點，但獨立一支：`updateSlide` 的 patch 型別是非 partial
   * 的 `Pick<…>`（大綱欄位一次全送），把 `hidden` 併進去會逼所有既有呼叫端一起改。
   */
  setSlideHidden: (projectId: string, slideId: string, hidden: boolean) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}`,
      { method: "PATCH", body: JSON.stringify({ hidden }) },
    ),
  // providerId 省略時，server 依專案組合（或預設組合）解析影像模型。
  generate: (
    projectId: string,
    slideId: string,
    providerId: string | undefined,
    acceptUnknownReadiness = false,
  ) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/generate`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(providerId ? { providerId } : {}),
          acceptUnknownReadiness,
        }),
      },
    ),
  /**
   * `slideIds` 省略時 server 對**全部**頁面排隊（含隱藏頁）；要只生成一部分（例如跳過
   * 隱藏頁）就把那些 id 傳進來。傳空陣列會被 server 以 `INVALID_SLIDE_SELECTION` 擋掉，
   * 所以呼叫端要自己確保清單非空。
   */
  generateAll: (
    projectId: string,
    providerId: string | undefined,
    acceptUnknownReadiness = false,
    slideIds?: string[],
  ) =>
    request<GenerationJob[]>(`/api/projects/${encodeURIComponent(projectId)}/generate`, {
      method: "POST",
      body: JSON.stringify({
        ...(providerId ? { providerId } : {}),
        acceptUnknownReadiness,
        ...(slideIds ? { slideIds } : {}),
      }),
    }),
  editSlideImage: (
    projectId: string,
    slideId: string,
    providerId: string,
    instruction: string,
    maskDataUrl?: string,
    acceptUnknownReadiness = false,
  ) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/edit-image`,
      {
        method: "POST",
        body: JSON.stringify({
          providerId,
          instruction,
          ...(maskDataUrl ? { maskDataUrl } : {}),
          acceptUnknownReadiness,
        }),
      },
    ),
  ocrStatus: () => request<{ available: boolean; message: string }>("/api/ocr/status"),
  extractText: (
    projectId: string,
    slideId: string,
    providerId: string,
    threshold = 0.75,
    acceptUnknownReadiness = false,
    textRepair: "off" | "outline" = "off",
    traditionalize = true,
  ) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/extract-text`,
      {
        method: "POST",
        body: JSON.stringify({
          providerId,
          threshold,
          acceptUnknownReadiness,
          textRepair,
          traditionalize,
        }),
      },
    ),
  updateTextLayer: (
    projectId: string,
    slideId: string,
    versionId: string,
    boxes: EditableTextBox[],
    threshold?: number,
  ) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/text-layer`,
      {
        method: "PUT",
        body: JSON.stringify({ boxes, ...(threshold === undefined ? {} : { threshold }) }),
      },
    ),
  /**
   * 在一個還沒有文字層的版本上建立手動文字層（背景就是原圖，一個字都不抹）。
   * 伺服器會開一個新版本並切過去，所以回應是整份專案，前端靠它換畫布。
   */
  createManualTextLayer: (
    projectId: string,
    slideId: string,
    versionId: string,
    boxes: EditableTextBox[],
  ) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/manual-text-layer`,
      { method: "POST", body: JSON.stringify({ boxes }) },
    ),
  addSlide: (
    projectId: string,
    input?: Partial<
      Pick<
        SlideSpec,
        "purpose" | "content" | "narrative" | "layoutHint" | "imagePrompt" | "sourceIds"
      >
    > & { afterSlideId?: string },
  ) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/slides`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  regenerateSlideOutline: (projectId: string, slideId: string, textEngine?: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/outline`,
      { method: "POST", body: JSON.stringify(textEngine ? { textEngine } : {}) },
    ),
  duplicateSlide: (projectId: string, slideId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/duplicate`,
      { method: "POST" },
    ),
  deleteSlide: (projectId: string, slideId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}`,
      { method: "DELETE" },
    ),
  reorderSlides: (projectId: string, slideIds: string[]) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/slides/reorder`, {
      method: "POST",
      body: JSON.stringify({ slideIds }),
    }),
  updateSource: (
    projectId: string,
    sourceId: string,
    patch: Partial<Pick<SourceAsset, "name" | "usage" | "allowModelAccess">> & {
      /**
       * 改成「視覺參考」時順便補跑一次 AI 內容描述（會呼叫模型、消耗配額）。
       * 只有在跟使用者確認過之後才送 true——見 `SourcePanel` 的 confirm。
       */
      describeImage?: boolean;
    },
  ) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),
  deleteSource: (projectId: string, sourceId: string, force = false) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}?force=${force}`,
      { method: "DELETE" },
    ),
  /**
   * 上傳一份來源。
   *
   * `allowModelAccess` 一定要在**上傳的當下**就能決定：圖片來源會在伺服器端自動跑一次
   * AI 內容描述，等落地之後才取消勾選，圖片早就送出去了。伺服器只認 "true"／"false"
   * 這兩個字串（其他值一律 400），不要在這裡塞別的寫法。
   */
  uploadSource: async (
    projectId: string,
    file: File,
    allowModelAccess = true,
  ): Promise<PresentationProject> => {
    const query = new URLSearchParams({
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      allowModelAccess: allowModelAccess ? "true" : "false",
    });
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/sources?${query}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    );
    const body = (await response.json()) as PresentationProject | ApiFailure;
    // 用 `failureMessage()` 而不是只取 `error`：伺服器的上限訊息帶著實際數字（「已達 200
    // 份上限（目前 200 份）」），只顯示錯誤碼等於把那份唯一的真相丟掉，前端就得自己再寫
    // 一份數字——而那份必定跟著漂。
    if (!response.ok) throw new Error(failureMessage(body, response));
    return body as PresentationProject;
  },
  searchWebSources: (projectId: string, query: string, limit = 8, textEngine?: string) =>
    request<WebSearchResult[]>(`/api/projects/${encodeURIComponent(projectId)}/web-search`, {
      method: "POST",
      body: JSON.stringify({ query, limit, ...(textEngine ? { textEngine } : {}) }),
    }),
  addWebSources: (projectId: string, sources: WebSearchResult[]) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/web-sources`, {
      method: "POST",
      body: JSON.stringify({ sources }),
    }),
  /**
   * 貼上的網址逐筆擷取正文後加入專案。
   *
   * 部分失敗仍是 2xx（成功的已經進專案了），失敗清單一併回來讓 UI 逐筆顯示；全部失敗
   * 是 4xx，錯誤物件上同樣掛著 `failures`，不能只丟一句「加入失敗」。
   */
  addUrlSources: async (
    projectId: string,
    urls: string[],
  ): Promise<{ project: PresentationProject; failures: UrlSourceFailure[] }> => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/url-sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const payload = (body ?? {}) as {
      project?: PresentationProject;
      failures?: UrlSourceFailure[];
    };
    if (!response.ok || !payload.project) {
      const error = new Error(failureMessage(body, response, "加入網址來源失敗")) as UrlSourceError;
      error.failures = payload.failures ?? [];
      throw error;
    }
    return { project: payload.project, failures: payload.failures ?? [] };
  },
  uploadStyleReference: async (file: File): Promise<StyleReferenceImage> => {
    const mediaType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const query = new URLSearchParams({ name: file.name, mediaType });
    const response = await fetch(`/api/style-assets?${query}`, {
      method: "POST",
      headers: { "Content-Type": mediaType },
      body: file,
    });
    const body = (await response.json()) as StyleReferenceImage | { error?: string };
    if (!response.ok) throw new Error(failureMessage(body, response));
    return body as StyleReferenceImage;
  },
  renderPdfPages: async (
    file: File,
  ): Promise<{ pages: string[]; totalPages: number; truncated: boolean }> => {
    const response = await fetch("/api/pdf-pages", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    const body = (await response.json()) as
      { pages: string[]; totalPages: number; truncated: boolean } | { error?: string };
    if (!response.ok) throw new Error(failureMessage(body, response));
    return body as { pages: string[]; totalPages: number; truncated: boolean };
  },
  // ── 從 PDF 匯入簡報 ──────────────────────────────────────────────────────
  // 與「從 PDF 建立風格」的 renderPdfPages 完全分開（不同解析度、頁數上限與落地方式）。
  inspectPdfDeck: async (file: File): Promise<PdfDeckInspection> => {
    const response = await fetch("/api/pdf-deck/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    const body = (await response.json()) as PdfDeckInspection | ApiFailure;
    if (!response.ok) throw new Error(failureMessage(body, response));
    return body as PdfDeckInspection;
  },
  importPdfDeck: async (
    file: File,
    name: string,
    pages: number[],
  ): Promise<{ project: PresentationProject; report: PdfDeckImportReport }> => {
    const query = new URLSearchParams({ name, pages: pages.join(",") });
    const response = await fetch(`/api/pdf-deck/import?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    const body = (await response.json()) as
      { project: PresentationProject; report: PdfDeckImportReport } | ApiFailure;
    if (!response.ok) throw new Error(failureMessage(body, response));
    return body as { project: PresentationProject; report: PdfDeckImportReport };
  },
  /**
   * 匯入 `.slide-project.zip` 備份檔。端點吃 raw bytes（`express.raw`），
   * 所以直接把 File 當 body 送，不包 FormData。
   */
  importProjectBundle: async (file: File): Promise<PresentationProject> => {
    const response = await fetch("/api/projects/import", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    });
    // 這是唯一一條會上傳任意大檔的端點，所以中間層（Cloud Run／反向代理）的 413、502、
    // 504 特別容易打到它，而那些回應是 HTML 或純文字。直接 `response.json()` 會丟出
    // `SyntaxError: Unexpected token '<'`，那句話會原封不動變成使用者看到的錯誤訊息。
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as PresentationProject | ApiFailure;
    } catch {
      throw new Error(`匯入專案檔失敗（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(failureMessage(body, response));
    return body as PresentationProject;
  },
  updateStyleSnapshot: (
    projectId: string,
    patch: { designSystem?: string; avoid?: string[]; name?: string; referenceIds?: string[] },
  ) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/style-snapshot`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  setWorkflowStage: (projectId: string, workflowStage: "requirements" | "settings" | "editing") =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/workflow-stage`, {
      method: "PATCH",
      body: JSON.stringify({ workflowStage }),
    }),
  versionToStyleReference: (projectId: string, slideId: string, versionId: string) =>
    request<StyleReferenceImage>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/style-reference`,
      { method: "POST" },
    ),
  analyzeStyle: (referenceIds: string[], combinationId?: string) =>
    request<{ designSystem: string; avoid: string[] }>("/api/style-analysis", {
      method: "POST",
      body: JSON.stringify({ referenceIds, ...(combinationId ? { combinationId } : {}) }),
    }),
  /**
   * PDF 匯入分析頁用：建參考圖 → 分析 → 寫回 styleSnapshot 一次做完。
   * 刻意不在前端串三支端點——中途失敗會留下沒有主的參考圖，重試幾次就在
   * `styles/assets` 下堆孤兒檔（伺服器端的交易會在失敗時清掉自己建的那批）。
   */
  analyseProjectStyle: (
    projectId: string,
    slideIds: string[],
    options: { combinationId?: string; name?: string } = {},
  ) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/style-analysis`, {
      method: "POST",
      body: JSON.stringify({
        slideIds,
        ...(options.combinationId ? { combinationId: options.combinationId } : {}),
        ...(options.name ? { name: options.name } : {}),
      }),
    }),
  cancel: (projectId: string, jobId: string) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    ),
  restore: (projectId: string, slideId: string, versionId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: "POST" },
    ),
  activateVersion: (projectId: string, slideId: string, versionId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/activate`,
      { method: "POST" },
    ),
  deleteVersion: (projectId: string, slideId: string, versionId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}`,
      { method: "DELETE" },
    ),
  setProjectCombination: (projectId: string, combinationId: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/combination`, {
      method: "PATCH",
      body: JSON.stringify({ combinationId }),
    }),
  // ── 模型庫 ──────────────────────────────────────────────────────────────
  modelLibrary: () => request<ModelLibrary>("/api/model-library"),
  connectionModels: (connectionId: string) =>
    request<{ models: string[] }>(
      `/api/model-library/connections/${encodeURIComponent(connectionId)}/models`,
    ),
  createConnection: (input: Omit<ModelConnection, "id">) =>
    request<ModelLibrary>("/api/model-library/connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateConnection: (id: string, patch: Partial<Omit<ModelConnection, "id">>) =>
    request<ModelLibrary>(`/api/model-library/connections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteConnection: (id: string) =>
    request<ModelLibrary>(`/api/model-library/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  createModel: (input: Omit<ModelEntry, "id">) =>
    request<ModelLibrary>("/api/model-library/models", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateModel: (id: string, patch: Partial<Omit<ModelEntry, "id">>) =>
    request<ModelLibrary>(`/api/model-library/models/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteModel: (id: string) =>
    request<ModelLibrary>(`/api/model-library/models/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  createCombination: (input: Omit<ModelCombination, "id">) =>
    request<ModelLibrary>("/api/model-library/combinations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateCombination: (id: string, patch: Partial<Omit<ModelCombination, "id">>) =>
    request<ModelLibrary>(`/api/model-library/combinations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteCombination: (id: string) =>
    request<ModelLibrary>(`/api/model-library/combinations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  setDefaultCombination: (combinationId: string) =>
    request<ModelLibrary>("/api/model-library/default-combination", {
      method: "PUT",
      body: JSON.stringify({ combinationId }),
    }),
  updateModelLibrarySystem: (patch: Partial<ModelLibrarySystem>) =>
    request<ModelLibrary>("/api/model-library/system", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

export const styleAssetUrl = (id: string) => `/api/style-assets/${encodeURIComponent(id)}`;

export function projectAssetUrl(projectId: string, assetPath: string): string {
  const path = assetPath.startsWith("assets/") ? assetPath.slice("assets/".length) : assetPath;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const cacheKey = path.split("/").at(-1) ?? path;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/${encodedPath}?v=${encodeURIComponent(cacheKey)}`;
}

export const imageUrl = projectAssetUrl;

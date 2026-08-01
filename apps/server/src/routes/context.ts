import type { ModelLibrary, PresentationProject, StyleReferenceImage } from "@slide-maker/core";
import type { ImageDescriptionQueue } from "../image-description.js";
import type { createImageDescriptionScheduler } from "../image-description-scheduler.js";
import type { JobRunner } from "../jobs.js";
import type { ModelRuntime } from "../model-runtime.js";
import type { OcrAdapter } from "../ocr.js";
import type { OcrQueue } from "../ocr-queue.js";
import type { createProviderResolvers } from "../provider-resolution.js";
import type { ProviderReadinessService } from "../readiness.js";
import type { FileProjectRepository } from "../repository.js";
import type { SqliteFtsRetriever } from "../retriever.js";
import type { FileStyleRepository } from "../styles.js";
import type { UsageLedger } from "../usage-ledger.js";
import type { createUsageRecorder } from "../usage-recording.js";
import type { createWebSourcePipeline } from "../web-source-pipeline.js";
import type { HtmlRenderer } from "../web-render.js";

type ProviderResolvers = ReturnType<typeof createProviderResolvers>;
type UsageRecorder = ReturnType<typeof createUsageRecorder>;
type WebSourcePipeline = ReturnType<typeof createWebSourcePipeline>;
type ImageDescriptionScheduler = ReturnType<typeof createImageDescriptionScheduler>;

/**
 * route 模組拿得到的 createApp 內部世界。
 *
 * 三條規則，違反任何一條都會在執行期變成難查的行為改變：
 *
 * 1. **只放活引用，不放快照。** `runtime` 是本體——模型庫存檔走 `runtime.rebuild()`
 *    原子替換 registry，這裡若改放 `runtime.library`／`runtime.system.modelTimeoutMs`
 *    之類的欄位，熱重建之後 route 讀到的永遠是舊模型庫、舊逾時。
 * 2. **共用的 helper 只有一份。** `materializeWebSources`／`searchFor` 是整份大綱與三條
 *    sources route 共用的唯一實作（見 `web-source-pipeline.ts`），透過這個物件傳同一個
 *    函式值，route 檔不得各自重建。
 * 3. **只列真的跨 route 檔的東西。** 只有單一 route 檔會用到的閉包（`mutateLibrary`、
 *    `projectStyleId`、`analyzeStyleReferences`）跟著那個檔案搬，不進這裡；
 *    `imageDescriptions`／`imageDescriptionMode` 只服務 createApp 自己的 wiring 與
 *    factory，也不進來。
 */
export interface AppContext {
  // ── 長生命週期的單例 ────────────────────────────────────────────────────
  repository: FileProjectRepository;
  styles: FileStyleRepository;
  retriever: SqliteFtsRetriever;
  /** **本體**，不可解構出欄位快照：模型庫熱重建會原子替換它身上的 registry。 */
  runtime: ModelRuntime;
  jobs: JobRunner;
  readiness: ProviderReadinessService;
  ocr: OcrAdapter;
  ocrQueue: OcrQueue;
  usageLedger: UsageLedger;
  /** 只有「貼上網址」那條路會傳給 `captureWebPage`；engine=none 時為 undefined。 */
  htmlRenderer: HtmlRenderer | undefined;

  // ── 模型庫與 provider 解析 ──────────────────────────────────────────────
  /** 存檔模型庫＋重建 registry＋清 readiness 快取（模型庫 CRUD 的唯一寫入路徑）。 */
  applyLibrary: (library: ModelLibrary) => Promise<ModelLibrary>;
  resolveStructuredText: ProviderResolvers["resolveStructuredText"];
  resolveImageProviderId: ProviderResolvers["resolveImageProviderId"];
  /** 生成前同步風格庫最新版並驗 provider 的參考圖能力。 */
  refreshStyleForGeneration: (projectId: string, providerId: string) => Promise<void>;

  // ── 記帳 ────────────────────────────────────────────────────────────────
  usageModelFields: UsageRecorder["usageModelFields"];
  recordStructuredUsage: UsageRecorder["recordStructuredUsage"];

  // ── 網頁來源管線（唯一實作） ────────────────────────────────────────────
  searchFor: WebSourcePipeline["searchFor"];
  gatherWebSources: WebSourcePipeline["gatherWebSources"];
  materializeWebSources: WebSourcePipeline["materializeWebSources"];

  // ── 圖片描述背景管線 ────────────────────────────────────────────────────
  imageDescriptionProvider: ImageDescriptionScheduler["imageDescriptionProvider"];
  scheduleImageDescription: ImageDescriptionScheduler["scheduleImageDescription"];

  // ── 風格快照（風格分析、專案設定、版本三處共用） ────────────────────────
  ownedStyleReferences: (project: PresentationProject) => string[];
  saveVersionStyleReference: (
    project: PresentationProject,
    slideId: string,
    versionId: string,
  ) => Promise<StyleReferenceImage>;
  writeProjectStyleSnapshot: (
    projectId: string,
    patch: {
      designSystem?: string;
      avoid?: string[];
      name?: string;
      referenceImages?: StyleReferenceImage[];
    },
  ) => Promise<PresentationProject>;
}

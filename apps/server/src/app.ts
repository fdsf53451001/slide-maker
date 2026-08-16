import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import {
  stylePresetSchema,
  type ModelLibrary,
  type PresentationProject,
  type StyleReferenceImage,
} from "@slide-maker/core";
import { JobRunner } from "./jobs.js";
import { FileProjectRepository } from "./repository.js";
import { ModelLibraryRepository } from "./model-library-repository.js";
import { buildSeedLibrary, withLocalInpaintEntry } from "./model-library-seed.js";
import { ModelLibraryError, ModelRuntime } from "./model-runtime.js";
import { runtimePaths } from "./runtime-paths.js";
import {
  LOCAL_HOSTNAMES,
  parseModelTimeoutMs,
  parseImageDescriptionMode,
  parseOcrDetSideLen,
  parseOcrModelTier,
  parseOpenAiBaseUrl,
  parseOpenAiImageApi,
  parseOpenAiTimeoutMs,
  parseOptionalString,
  parseTrustedHosts,
  parseWebRenderEngine,
  parseWebRenderTimeoutMs,
} from "./config.js";
import { ProviderReadinessService } from "./readiness.js";
import { FileStyleRepository } from "./styles.js";
import { ImageDescriptionQueue } from "./image-description.js";
import { OcrQueue } from "./ocr-queue.js";
import { combineBackgroundWork } from "./shutdown.js";
import { SqliteFtsRetriever } from "./retriever.js";
import { captureWebPage, type WebSearchResult } from "./web-capture.js";
import { createHtmlRenderer } from "./web-render.js";
import { PaddleOcrAdapter, type OcrAdapter } from "./ocr.js";
import { UsageLedger } from "./usage-ledger.js";
import { errorHandler } from "./error-handler.js";
import { createUsageRecorder } from "./usage-recording.js";
import { createProviderResolvers } from "./provider-resolution.js";
import { createWebSourcePipeline } from "./web-source-pipeline.js";
import {
  createImageDescriptionScheduler,
  createStartupRepairs,
} from "./image-description-scheduler.js";
import { trustedHostMiddleware } from "./trusted-hosts.js";
import type { AppContext } from "./routes/context.js";
import {
  registerDeckGenerationRoutes,
  registerSlideGenerationRoutes,
} from "./routes/generation.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerModelLibraryRoutes } from "./routes/model-library.js";
import { registerDeckOutlineRoute, registerSlideOutlineRoute } from "./routes/outline.js";
import { registerPdfDeckRoutes } from "./routes/pdf-deck.js";
import { registerProjectSettingsRoutes } from "./routes/project-settings.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSlideCollectionRoutes, registerSlidePatchRoute } from "./routes/slides.js";
import { registerSourceEditRoutes, registerSourceIntakeRoutes } from "./routes/sources.js";
import { registerStyleAnalysisRoutes } from "./routes/style-analysis.js";
import { registerStyleRoutes } from "./routes/styles.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTextExtractionRoutes } from "./routes/text-extraction.js";
import { registerVersionRoutes } from "./routes/versions.js";
import { registerWebSourceRoutes } from "./routes/web-sources.js";

// 測試（style-analysis-limit.test.ts）以這個路徑 import，故在此原樣轉出。
export { projectStyleAnalysisInputSchema } from "./routes/style-analysis.js";
/** 關機時 flush 帳本的上限（見 `app.locals.backgroundWork`）。 */
const USAGE_SHUTDOWN_FLUSH_MS = 2_000;

export interface AppDependencies {
  webSearch?: (
    query: string,
    limit: number,
    project: PresentationProject,
  ) => Promise<WebSearchResult[]>;
  captureWebPage?: typeof captureWebPage;
  ocr?: OcrAdapter;
}

export const EDITOR_BUILD_MISSING =
  "Editor build not found. Run `pnpm --filter @slide-maker/editor build`, then restart the server.";

export async function createApp(
  dataRoot = runtimePaths.dataRoot,
  editorDist = runtimePaths.editorDist,
  dependencies: AppDependencies = {},
): Promise<Express> {
  const app = express();
  const repository = new FileProjectRepository(dataRoot);
  await repository.initialize();
  const styles = new FileStyleRepository(join(dataRoot, "styles"));
  await styles.initialize();
  // FTS 索引是純衍生資料——下面這個迴圈啟動時就從 project.sources 全量重建。
  // 因此它不該躺在 DATA_ROOT：雲端的 DATA_ROOT 是 gcsfuse 掛載，而 gcsfuse 沒有
  // POSIX 檔案鎖，SQLite 的 WAL 模式在上面會靜默損毀。部署時用
  // SLIDE_MAKER_SEARCH_INDEX_PATH 指到容器本機磁碟；未設時維持原本的位置。
  const retriever = new SqliteFtsRetriever(
    parseOptionalString(process.env.SLIDE_MAKER_SEARCH_INDEX_PATH) ??
      join(dataRoot, "index", "sources.sqlite"),
  );
  const { clearStalledParsing, sweepOcrInputs } = createStartupRepairs(repository);
  // 掛在既有的啟動走訪裡，不另外多一趟 cold start 的 listProjects()。
  for (const project of await repository.listProjects()) {
    const repaired = await clearStalledParsing(project);
    retriever.index(repaired.id, repaired.sources);
    await sweepOcrInputs(repaired.id);
  }
  // 上傳圖片是否自動跑背景描述（預設 on）。這是唯一由「上傳檔案」觸發的模型呼叫，
  // 配額敏感或離線的部署要能整條關掉，而不是靠使用者逐張取消勾選。
  const imageDescriptionMode = parseImageDescriptionMode(process.env.SLIDE_MAKER_IMAGE_DESCRIPTION);
  // env 提供 seed 素材與 system 未設時的回退預設；模型庫存在後即以 JSON 為準。
  const envDefaults = {
    modelTimeoutMs: parseModelTimeoutMs(process.env.SLIDE_MAKER_MODEL_TIMEOUT_MS),
    ocrModelTier: parseOcrModelTier(process.env.SLIDE_MAKER_OCR_MODEL_TIER),
    ocrDetSideLen: parseOcrDetSideLen(process.env.SLIDE_MAKER_OCR_DET_SIDE_LEN),
  };
  const openAiBaseUrl = parseOpenAiBaseUrl(process.env.SLIDE_MAKER_OPENAI_BASE_URL);
  const openAiApiKey = parseOptionalString(process.env.SLIDE_MAKER_OPENAI_API_KEY);
  // 「貼上網址」通道專用的第三方 render fallback（engine=none 時為 undefined）。
  // 只有 /url-sources 會傳給 captureWebPage；搜尋擷取路徑刻意不碰它。
  const htmlRenderer = createHtmlRenderer(
    parseWebRenderEngine(process.env.SLIDE_MAKER_WEB_RENDER_ENGINE),
    {
      apiKey: parseOptionalString(process.env.SLIDE_MAKER_JINA_API_KEY),
      timeoutMs: parseWebRenderTimeoutMs(process.env.SLIDE_MAKER_WEB_RENDER_TIMEOUT_MS),
    },
  );

  // 模型庫：首次開機由 env seed 一份，之後以 DATA_ROOT/models.json 為單一真實來源。
  const libraryRepository = new ModelLibraryRepository(dataRoot);
  let seededLibrary = await libraryRepository.loadOrSeed(() =>
    buildSeedLibrary({
      now: new Date().toISOString(),
      ...(openAiBaseUrl && openAiApiKey
        ? {
            openai: {
              baseUrl: openAiBaseUrl,
              apiKey: openAiApiKey,
              timeoutMs: parseOpenAiTimeoutMs(process.env.SLIDE_MAKER_OPENAI_TIMEOUT_MS),
              imageApi: parseOpenAiImageApi(process.env.SLIDE_MAKER_OPENAI_IMAGE_API),
              ...(parseOptionalString(process.env.SLIDE_MAKER_OPENAI_IMAGE_MODEL)
                ? { imageModel: parseOptionalString(process.env.SLIDE_MAKER_OPENAI_IMAGE_MODEL)! }
                : {}),
              ...(parseOptionalString(process.env.SLIDE_MAKER_OPENAI_TEXT_MODEL)
                ? { textModel: parseOptionalString(process.env.SLIDE_MAKER_OPENAI_TEXT_MODEL)! }
                : {}),
              ...(parseOptionalString(process.env.SLIDE_MAKER_OPENAI_SEARCH_MODEL)
                ? { searchModel: parseOptionalString(process.env.SLIDE_MAKER_OPENAI_SEARCH_MODEL)! }
                : {}),
            },
          }
        : {}),
      system: envDefaults,
    }),
  );
  // 在 local-inpaint 出現之前 seed 的既有 models.json 補上內建 entry，
  // 否則 extract-text 的新預設 providerId 會解析不到。
  const migratedLibrary = withLocalInpaintEntry(seededLibrary);
  if (migratedLibrary) seededLibrary = await libraryRepository.save(migratedLibrary);

  const runtime = new ModelRuntime(
    {
      localToolsRoot: runtimePaths.workspaceRoot,
      defaults: envDefaults,
    },
    seededLibrary,
  );

  /**
   * 模型用量帳本。**在 JobRunner 之前建立**，因為影像那條也要記帳。
   *
   * 記帳一律 fire-and-forget（`void`）：帳本自己保證永不 reject，而讓一次記帳有本事拖慢
   * 或弄壞生成是完全不成比例的。測試以 `app.locals.usageLedger.idle()` 等它收尾。
   */
  const usageLedger = new UsageLedger(repository);
  const { usageModelFields, recordStructuredUsage } = createUsageRecorder(runtime, usageLedger);

  const jobs = new JobRunner(repository, runtime.imageProviders, styles, {
    ledger: usageLedger,
    modelFields: usageModelFields,
  });
  const readiness = new ProviderReadinessService(runtime.imageProviders);
  // OCR 設定進了模型庫，但重量級子程序模型僅於啟動時建構；改設定需重啟才生效（known limitation）。
  const ocr =
    dependencies.ocr ??
    new PaddleOcrAdapter(runtimePaths.workspaceRoot, {
      modelTier: runtime.system.ocrModelTier,
      detSideLen: runtime.system.ocrDetSideLen,
    });

  // 熱重建：前端存檔模型庫後重建 registry（原子替換）並清 readiness 快取；in-flight job 保留舊實例。
  const applyLibrary = async (library: ModelLibrary): Promise<ModelLibrary> => {
    const saved = await libraryRepository.save(library);
    runtime.rebuild(saved);
    readiness.clearCache();
    return saved;
  };

  const { resolveImageProviderId, resolveStructuredText } = createProviderResolvers(
    repository,
    runtime,
  );

  // 圖片來源的背景描述佇列。上傳端點只負責排隊，絕不等它。
  const imageDescriptions = new ImageDescriptionQueue();
  /**
   * OCR 的併發閘門。抽字端點是同步請求，這裡是**等**它的（見該端點的呼叫點註解）。
   *
   * 沒有這道閘門時，N 個並行請求就是 N 個 4 GB 的 PaddleOCR 子程序——Cloud Run 上是
   * 2 GiB / max_instance=1，第二個就 OOM，連帶把 `jobs.ts` 記憶體裡的 job 追蹤一起帶走。
   */
  const ocrQueue = new OcrQueue();

  const { imageDescriptionProvider, scheduleImageDescription } = createImageDescriptionScheduler({
    repository,
    retriever,
    runtime,
    usageLedger,
    usageModelFields,
    imageDescriptions,
    imageDescriptionMode,
    resolveStructuredText,
  });
  const { gatherWebSources, materializeWebSources, searchFor } = createWebSourcePipeline(
    repository,
    runtime,
    usageLedger,
    usageModelFields,
    dependencies,
  );
  const refreshStyleForGeneration = async (projectId: string, providerId: string) => {
    const provider = runtime.imageProvider(providerId);
    const project = await repository.loadProject(projectId);
    if (!project) throw new Error("Project not found");
    const latest = await styles.get(project.styleSnapshot.id);
    if (latest && latest.version !== project.styleSnapshot.version) {
      await repository.updateProject(projectId, (current) => {
        current.styleSnapshot = structuredClone(latest);
        // 同 `provider-resolution.ts` 的 lazy 綁定：把專案的風格快照追上風格庫是生成前的
        // **系統同步**，使用者沒有改這份專案；而且這裡之後還會因為能力不符而 throw，
        // 那時他拿到的是一則錯誤、零張圖，不該換到主畫面最上面。
      });
    }
    const effective = latest ?? project.styleSnapshot;
    if (effective.referenceImages.length && !provider.capabilities.referenceImages)
      throw new ModelLibraryError(
        "STYLE_REFERENCES_UNSUPPORTED",
        "此組合的影像模型不支援參考圖。請到模型庫把該影像模型的「影像 API」改為 chat、改用支援參考圖的組合，或移除風格的參考圖後再生成。",
      );
    if (effective.referenceImages.length > 1 && !provider.capabilities.multipleReferenceImages)
      throw new ModelLibraryError(
        "MULTIPLE_REFERENCES_UNSUPPORTED",
        "此組合的影像模型不支援多張參考圖。請把風格的參考圖減到 1 張，或改用支援多張參考圖的影像模型。",
      );
  };

  /**
   * route 模組要用的那一份 createApp 內部世界（見 `routes/context.ts` 的三條規則）。
   *
   * 三支風格快照 helper 是 `function` 宣告（會 hoist），在這裡取用是安全的。
   */
  const ctx: AppContext = {
    repository,
    styles,
    retriever,
    runtime,
    jobs,
    readiness,
    ocr,
    ocrQueue,
    usageLedger,
    htmlRenderer,
    applyLibrary,
    resolveStructuredText,
    resolveImageProviderId,
    refreshStyleForGeneration,
    usageModelFields,
    recordStructuredUsage,
    searchFor,
    gatherWebSources,
    materializeWebSources,
    imageDescriptionProvider,
    scheduleImageDescription,
    ownedStyleReferences,
    saveVersionStyleReference,
    writeProjectStyleSnapshot,
  };
  await jobs.recoverInterruptedJobs();
  app.locals.jobRunner = jobs;
  app.locals.providerReadiness = readiness;
  // 關機時要 abort 進行中的描述請求並丟掉排隊中的工作（見 shutdown.ts）。
  app.locals.imageDescriptions = imageDescriptions;
  app.locals.ocrQueue = ocrQueue;
  // 記帳是 fire-and-forget 的，測試要有辦法等它收尾才讀得到檔案。
  app.locals.usageLedger = usageLedger;
  // `index.ts` 只交這一個給 installShutdownHandlers()：關機要收尾的背景工作有哪些，是
  // 這裡（知道自己建了什麼）的事，不是啟動腳本的事。
  {
    const background = combineBackgroundWork(imageDescriptions, ocrQueue);
    app.locals.backgroundWork = {
      // 帳本最後 flush，而且是**在**其他背景工作收尾之後：記帳是 fire-and-forget 的，
      // 沒有這一步就沒有任何東西等它，SIGTERM 時剛跑完那幾筆最貴的呼叫最容易掉。
      // 逾時是必要的——一個觀測用檔案不該有本事拖過關機期限。
      shutdown: async () => {
        await background.shutdown();
        await usageLedger.idle(USAGE_SHUTDOWN_FLUSH_MS);
      },
    };
  }

  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));
  // 未設 SLIDE_MAKER_TRUSTED_HOSTS 時這個集合就只有本機三個名字，與過去等價。
  // 雲端部署必須明確列出自己的主機名，並且自行確保前面有 IAP 之類的驗證層——
  // 放行一個主機名等於把這道防線交出去。
  const allowedHosts = new Set<string>([
    ...LOCAL_HOSTNAMES,
    ...parseTrustedHosts(process.env.SLIDE_MAKER_TRUSTED_HOSTS),
  ]);
  app.use(trustedHostMiddleware(allowedHosts));

  registerSystemRoutes(app, ctx);

  registerModelLibraryRoutes(app, ctx);

  registerStyleRoutes(app, ctx);
  registerPdfDeckRoutes(app, ctx);

  // ── 風格快照的共用 helper（風格分析、專案設定、版本三處共用） ──────────────

  /** 專案本地風格 fork 的 id：只有這個 id 的 snapshot 擁有自己的參考圖。 */
  const projectStyleId = (projectId: string) => `pdf-style-${projectId}`;

  /**
   * 這個專案自己擁有、換掉之後可以安全刪除的參考圖 id。
   *
   * 只有 fork 成 `pdf-style-<projectId>` 的本地 snapshot 才是專案自己建的那一批；
   * 套用風格庫的風格之後 snapshot 是庫裡風格的複本，那些參考圖歸風格庫所有，
   * 刪掉會讓庫裡的風格指到不存在的檔案。
   */
  function ownedStyleReferences(project: PresentationProject): string[] {
    if (project.styleSnapshot.id !== projectStyleId(project.id)) return [];
    return project.styleSnapshot.referenceImages.map((image) => image.id);
  }

  /**
   * 把某個 slide version 的圖另存成一張 style asset。
   * 風格庫列表只掃 `*.vN.json`，這些資產不會污染列表（已確認）。
   */
  async function saveVersionStyleReference(
    project: PresentationProject,
    slideId: string,
    versionId: string,
  ): Promise<StyleReferenceImage> {
    const slideIndex = project.slides.findIndex((slide) => slide.id === slideId);
    const version = project.slides[slideIndex]?.versions.find((item) => item.id === versionId);
    if (!version) throw new Error("Version not found");
    const mediaType = version.imagePath.endsWith(".png")
      ? ("image/png" as const)
      : version.imagePath.match(/\.jpe?g$/)
        ? ("image/jpeg" as const)
        : undefined;
    if (!mediaType) throw new Error("STYLE_REFERENCE_CONTENT_INVALID");
    const bytes = new Uint8Array(
      await readFile(repository.resolveAsset(project.id, version.imagePath)),
    );
    return styles.saveReference(`${project.name} - Slide ${slideIndex + 1}`, mediaType, bytes);
  }

  /**
   * 把風格分析結果寫回專案自己的 styleSnapshot。
   * 一律 fork 成專案本地風格 id：風格庫沒有這個 id，`refreshStyleForGeneration`
   * 就不會在生成前用庫裡的版本把分析結果蓋掉，也不會污染風格庫列表。
   *
   * 帶了 `referenceImages` 就會一起換掉 snapshot 的參考圖，並刪掉被取代的上一批。
   */
  async function writeProjectStyleSnapshot(
    projectId: string,
    patch: {
      designSystem?: string;
      avoid?: string[];
      name?: string;
      referenceImages?: StyleReferenceImage[];
    },
  ): Promise<PresentationProject> {
    const superseded: string[] = [];
    const project = await repository.updateProject(projectId, (current) => {
      if (patch.referenceImages) {
        const keep = new Set(patch.referenceImages.map((image) => image.id));
        superseded.push(...ownedStyleReferences(current).filter((id) => !keep.has(id)));
      }
      current.styleSnapshot = stylePresetSchema.parse({
        ...current.styleSnapshot,
        id: projectStyleId(current.id),
        version: 1,
        system: false,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.designSystem === undefined ? {} : { designSystem: patch.designSystem }),
        ...(patch.avoid ? { avoid: patch.avoid } : {}),
        // 副作用（刻意保留）：寫進 referenceImages 的頁面不只是這一次分析的輸入，
        // 它們會成為這個專案**後續每一次生圖**的 style reference——`jobs.ts` 的
        // `styleReferences` 直接由 `project.styleSnapshot.referenceImages` 展開，
        // 每次生成都會多送這幾張全頁圖給模型。讓新生成的頁與原簡報視覺一致正是
        // 自動跑風格分析的目的，所以這是要的效果；分析頁上會告訴使用者附了幾張。
        ...(patch.referenceImages ? { referenceImages: patch.referenceImages } : {}),
        updatedAt: new Date().toISOString(),
      });
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    // 被這一批取代掉的上一批分析圖：只有這個 snapshot 引用過，可以直接刪。
    // 已經寫完新的 snapshot 才刪，刪失敗最多是留下孤兒，不會弄丟正在用的圖。
    await Promise.allSettled(superseded.map((id) => styles.deleteReference(id)));
    return project;
  }

  registerStyleAnalysisRoutes(app, ctx);
  registerProjectRoutes(app, ctx);

  registerDeckOutlineRoute(app, ctx);

  registerProjectSettingsRoutes(app, ctx);

  registerSlidePatchRoute(app, ctx);

  registerSlideOutlineRoute(app, ctx);

  registerSlideCollectionRoutes(app, ctx);

  registerSlideGenerationRoutes(app, ctx);

  registerTextExtractionRoutes(app, ctx);

  registerDeckGenerationRoutes(app, ctx);

  registerVersionRoutes(app, ctx);

  registerSourceIntakeRoutes(app, ctx);

  registerWebSourceRoutes(app, ctx);

  registerSourceEditRoutes(app, ctx);

  registerExportRoutes(app, ctx);

  app.use("/api", (_request, response) => response.status(404).json({ error: "NOT_FOUND" }));

  const editorIndex = resolve(editorDist, "index.html");
  let editorAvailable = true;
  try {
    await access(editorIndex);
  } catch {
    editorAvailable = false;
  }
  if (editorAvailable) {
    app.use(express.static(editorDist));
    app.get("/", (_request, response) => response.sendFile(editorIndex));
    app.get("/*path", (_request, response) => response.sendFile(editorIndex));
  } else {
    const unavailable = (_request: Request, response: Response) =>
      response.status(503).type("text/plain").send(EDITOR_BUILD_MISSING);
    app.get("/", unavailable);
    app.get("/*path", unavailable);
  }

  // 四個參數的簽名不可省略，否則 Express 不會把這支當成 error handler。
  app.use(errorHandler);
  return app;
}

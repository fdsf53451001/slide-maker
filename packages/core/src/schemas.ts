import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const contentModeSchema = z.enum(["creative", "grounded"]);
export const webSearchModeSchema = z.enum(["cached", "live", "disabled"]);

/** 單筆網路搜尋結果（供 WebSearchProvider 回傳）。 */
export const webSearchResultSchema = z.object({
  url: z.string().url(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(4_000),
});
export const sourceUsageSchema = z.enum([
  "content",
  "visual-reference",
  "style-reference",
  "direct-asset",
  "exclude-from-generation",
]);

export const presentationBriefSchema = z.object({
  topic: z.string().trim().min(1),
  audience: z.string().trim().default("一般觀眾"),
  purpose: z.string().trim().default("清楚傳達主題"),
  language: z.string().trim().default("zh-TW"),
  desiredSlideCount: z.number().int().min(1).max(100).default(5),
  durationMinutes: z.number().positive().optional(),
  tone: z.string().trim().default("清晰、現代"),
  contentMode: contentModeSchema.default("creative"),
  webSearchMode: webSearchModeSchema.default("cached"),
});

export const pageNumberPositionSchema = z.enum(["bottom-left", "bottom-center", "bottom-right"]);
export const pageNumberFormatSchema = z.enum(["number", "number-total", "zh-page"]);

/**
 * 頁碼是專案級設定，且由系統合成而非生圖模型畫上去——影像合約明文禁止模型自己畫頁碼，
 * 這裡的數值才是畫布預覽、簡報模式與三種匯出唯一的真相來源。
 */
export const pageNumberSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  position: pageNumberPositionSchema.default("bottom-right"),
  format: pageNumberFormatSchema.default("number"),
  /** 第一個有頁碼的頁面顯示的數字。 */
  startAt: z.number().int().min(1).max(999).default(1),
  /** 封面（第一頁）不編號也不計數。 */
  skipFirstSlide: z.boolean().default(true),
  /** 畫布座標系的 px（畫布固定 1920×1080），三個渲染端共用同一數值。 */
  fontSize: z.number().min(12).max(120).default(30),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#ffffff"),
  opacity: z.number().min(0.05).max(1).default(0.8),
  /** 墊在頁碼底下的小色塊，複雜背景上用來保可讀性。 */
  background: z
    .object({
      enabled: z.boolean().default(false),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#000000"),
      opacity: z.number().min(0.05).max(1).default(0.35),
    })
    .default({}),
});

export const sourceCitationSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  locator: z.string().optional(),
  url: z.string().url().optional(),
  excerpt: z.string().optional(),
  capturedAt: z.string().datetime(),
});

export const sourceAssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  usage: sourceUsageSchema,
  allowModelAccess: z.boolean(),
  status: z.enum(["pending", "parsing", "indexed", "failed"]),
  assetPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  extractedText: z.string().default(""),
  chunks: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
        locator: z.string().optional(),
      }),
    )
    .default([]),
  metadata: z.record(z.string()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export const styleReferenceImageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.enum(["image/png", "image/jpeg"]),
  assetPath: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const stylePresetSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().default(""),
  system: z.boolean().default(false),
  density: z.enum(["low", "medium", "high"]).default("high"),
  imageDirection: z.string().default(""),
  avoid: z.array(z.string()).default([]),
  promptTemplate: z.string().default(""),
  /**
   * AI 分析參考圖後排版成的設計系統 markdown（色票、字型、網格、元件、頁型規則）。
   * 空字串代表未分析過，生成端行為與加入此欄位前完全一致。
   */
  designSystem: z.string().default(""),
  referenceImages: z.array(styleReferenceImageSchema).max(4).default([]),
  coverImageId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * 生成某張圖時的大綱狀態，用來判定「現在的大綱是否已與畫面上的圖不同步」。
 * 刻意不含 `pinnedSourceIds`：指定與否只影響「下次重生成大綱時誰優先」，
 * 不影響已生成的圖；納入的話，使用者把一份 AI 已選用的來源改成指定（實際使用的來源
 * 一份都沒變）就會被誤判成 outlineDirty，橘框亮起來卻沒有東西需要重生成。
 * 當時生效的指定改存在 `slideVersionSchema.pinnedSourceIds`（快照的同層欄位）。
 */
export const slideOutlineSnapshotSchema = z.object({
  purpose: z.string().default(""),
  content: z.string().default(""),
  narrative: z.string().default(""),
  layoutHint: z.string().default(""),
  imagePrompt: z.string().default(""),
  sourceIds: z.array(z.string()).default([]),
});

export const editableTextBoxSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  fontFamily: z.string().min(1).default("Arial"),
  fontSize: z.number().positive(),
  fontWeight: z.number().int().min(100).max(900).default(400),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#ffffff"),
  opacity: z.number().min(0).max(1).default(1),
  lineHeight: z.number().positive().default(1.2),
  letterSpacing: z.number().default(0),
  align: z.enum(["left", "center", "right"]).default("left"),
  verticalAlign: z.enum(["top", "middle", "bottom"]).default("top"),
  rotation: z.number().min(-180).max(180).default(0),
  confidence: z.number().min(0).max(1),
  role: z.enum(["presentation", "logo", "incidental"]).default("presentation"),
});

export const editableTextLayerSchema = z.object({
  originalVersionId: z.string().min(1),
  backgroundPath: z.string().min(1),
  compositePath: z.string().min(1),
  threshold: z.number().min(0.5).max(0.95).default(0.75),
  renderRevision: z.number().int().nonnegative().default(0),
  boxes: z.array(editableTextBoxSchema).max(500),
  extractedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const slideVersionSchema = z.object({
  id: z.string().min(1),
  imagePath: z.string().min(1),
  prompt: z.string(),
  providerId: z.string().min(1),
  model: z.string().min(1),
  /** 產生此版本時專案綁定的模型組合 id（來源溯源）。 */
  combinationId: z.string().optional(),
  parameters: z.record(z.unknown()),
  styleVersion: z.number().int().positive(),
  sources: z.array(sourceCitationSchema),
  outlineSnapshot: slideOutlineSnapshotSchema.optional(),
  /**
   * 生成這一版時生效的使用者指定來源。放在 outlineSnapshot 外面是刻意的：它不參與
   * `sameOutline` 的比對（否則單純改指定就會誤觸 outlineDirty），只在還原／啟用版本時
   * 一併復原，讓「指定 → 生成 → 還原舊版」不會把使用者的指定無聲丟掉。
   * 維持 optional 而不是 `.default([])`：default 會讓這個欄位在推導出的型別裡變成必填，
   * 逼所有既有的版本 fixture 一起改，卻換不到任何行為差異——讀取端一律 `?? []`，
   * 兩種寫法對「舊版本記錄沒有這個欄位」的處理完全相同。還原舊版本的行為因此與
   * 加入這個欄位前一致。
   */
  pinnedSourceIds: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  label: z.string().optional(),
  textLayer: editableTextLayerSchema.optional(),
});

/**
 * 頁面的欄位定義。要解析完整頁面請用 {@link slideSpecSchema}——它多了強制不變式的
 * transform；這個裸物件只給 `.pick()` / `.partial()`（例如 PATCH 的部分欄位）使用，
 * 因為 transform 過的 schema 沒有那些方法，而部分更新本來也無從檢查跨欄位的關係。
 */
export const slideSpecFieldsSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  purpose: z.string().default(""),
  content: z.string().default(""),
  narrative: z.string().default(""),
  layoutHint: z.string().default(""),
  dataBasis: z.array(z.string()).default([]),
  imagePrompt: z.string().default(""),
  styleOverride: stylePresetSchema.partial().optional(),
  /** 這一頁實際使用的全部來源（使用者指定的 ∪ 模型挑的）。 */
  sourceIds: z.array(z.string()).default([]),
  /**
   * 使用者手動指定要用的來源；`sourceIds` 減去它就是模型自己挑的那些。
   * 恆為 `sourceIds` 的子集（由 {@link slideSpecSchema} 的 transform 保證）——指定即代表
   * 這一頁會用它，取消指定即代表這一頁不要它；兩者分開存才能在 UI 上區分「我指定」與
   * 「AI 選用」，並讓重生成時保護使用者的選擇。
   * 舊專案檔沒有這個欄位，`.default([])` 讓它載入後等同「全交給模型決定」，行為不變。
   */
  pinnedSourceIds: z.array(z.string()).default([]),
  outlineDirty: z.boolean().default(false),
  versions: z.array(slideVersionSchema).default([]),
  currentVersionId: z.string().optional(),
});

/**
 * 頁面 schema，附帶唯一一處強制 `pinnedSourceIds ⊆ sourceIds` 的地方。
 *
 * 不變式擺在解析層而不是散在各個寫入端點：載入、匯入、每次存檔都會經過這裡，所以
 * 手改過的 `project.json` 或未來新增的寫入路徑都不可能繞過它。散在 N 個呼叫點的版本
 * 實測只有 1 個真的有測試蓋到，其餘拿掉都沒人發現——那正是這個不變式最容易破掉的方式。
 *
 * 越界的指定不是良性資料：UI 會把它畫成「沒用到」（點不到、刪不掉），檢索卻仍讓它
 * 吃掉配額，下次重生成還會把它強制併回 `sourceIds`。
 */
export const slideSpecSchema = slideSpecFieldsSchema.transform((slide) => ({
  ...slide,
  pinnedSourceIds: slide.pinnedSourceIds.filter((id) => slide.sourceIds.includes(id)),
}));

export const generationJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  slideId: z.string().min(1),
  providerId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  lifecycleVersion: z.literal(1).optional(),
  phase: z
    .enum([
      "queued",
      "preparing",
      "launching",
      "waiting_for_codex",
      "validating_output",
      "persisting",
      "completed",
      "failed",
      "cancelled",
    ])
    .optional(),
  progress: z
    .object({ step: z.number().int().min(0), total: z.number().int().positive() })
    .optional(),
  providerEventCode: z.enum(["turn_started", "item_completed", "turn_completed"]).optional(),
  childLifecycle: z
    .object({
      spawnedAt: z.string().datetime().optional(),
      lastAllowedEventAt: z.string().datetime().optional(),
      cancelRequestedAt: z.string().datetime().optional(),
      shutdownRequestedAt: z.string().datetime().optional(),
      recoveredAt: z.string().datetime().optional(),
      exitedAt: z.string().datetime().optional(),
      exitClass: z.enum(["success", "nonzero", "timeout", "aborted", "server_shutdown"]).optional(),
    })
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
  attempt: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  phaseUpdatedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  error: z.string().optional(),
  resultVersionId: z.string().optional(),
  operation: z.enum(["generate", "edit", "extract-text"]).default("generate"),
  editInstruction: z.string().optional(),
  baseVersionId: z.string().optional(),
  maskPath: z.string().optional(),
  textExtraction: z
    .object({
      originalVersionId: z.string().min(1),
      replaceVersionId: z.string().min(1).optional(),
      threshold: z.number().min(0.5).max(0.95),
      boxes: z.array(editableTextBoxSchema).max(500),
    })
    .optional(),
});

export const presentationProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  workflowStage: z.enum(["requirements", "settings", "editing"]).default("requirements"),
  outlineRationale: z.string().optional(),
  brief: presentationBriefSchema,
  canvas: z.object({
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
  }),
  styleSnapshot: stylePresetSchema,
  /** 舊專案檔沒有這個欄位，靠 zod default 補齊（預設關閉，行為與加入前一致）。 */
  pageNumber: pageNumberSettingsSchema.default({}),
  /** 綁定的模型組合 id（模型庫）。未設時生成流程回退到庫的 default 組合（lazy 綁定）。 */
  combinationId: z.string().optional(),
  slides: z.array(slideSpecSchema),
  sources: z.array(sourceAssetSchema),
  jobs: z.array(generationJobSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createSourceInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(120),
  usage: sourceUsageSchema.optional(),
  allowModelAccess: z.boolean().default(true),
});

export const stylePresetInputSchema = stylePresetSchema
  .omit({
    schemaVersion: true,
    id: true,
    version: true,
    system: true,
    createdAt: true,
    updatedAt: true,
  })
  .partial({
    description: true,
    density: true,
    imageDirection: true,
    avoid: true,
    promptTemplate: true,
    designSystem: true,
    referenceImages: true,
    coverImageId: true,
  })
  .extend({ name: z.string().trim().min(1).max(120) });

export type PresentationBrief = z.infer<typeof presentationBriefSchema>;
export type StylePreset = z.infer<typeof stylePresetSchema>;
export type StyleReferenceImage = z.infer<typeof styleReferenceImageSchema>;
export type SlideSpec = z.infer<typeof slideSpecSchema>;
export type SlideOutlineSnapshot = z.infer<typeof slideOutlineSnapshotSchema>;
export type SlideVersion = z.infer<typeof slideVersionSchema>;
export type EditableTextBox = z.infer<typeof editableTextBoxSchema>;
export type EditableTextLayer = z.infer<typeof editableTextLayerSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type PageNumberSettings = z.infer<typeof pageNumberSettingsSchema>;
export type PresentationProject = z.infer<typeof presentationProjectSchema>;
export type SourceAsset = z.infer<typeof sourceAssetSchema>;
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

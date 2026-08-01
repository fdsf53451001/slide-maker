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
/**
 * 一個專案最多幾份來源、總位元組上限多少，以及單次「貼上網址」最多幾筆。
 *
 * **住在 core 是因為前後端都要知道**：伺服器用它們擋寫入（`sources.ts` 的
 * `assertSourceCapacity()`），編輯器用它們顯示「175/200」與「最多 10 筆」。上限的真相只能
 * 有一份——前端自己抄一個數字就是第二份真相，而且不會有任何測試發現它過期：使用者實測時
 * 看到的 `SOURCES 175/100` 就是這麼來的（伺服器早就放寬到 200，畫面上還印著 100）。
 *
 * 數字本身的取捨（2 GiB 為何是上傳位元組而不是記憶體、為何非圖片來源另有字數上限）寫在
 * `apps/server/src/sources.ts` 的 `MAX_SOURCE_TEXT_CHARS`：那是伺服器側的實作考量，
 * 這裡只放「合約」。
 */
export const SOURCE_COUNT_LIMIT = 200;
export const SOURCE_TOTAL_BYTES_LIMIT = 2 * 1024 ** 3;
export const URL_SOURCE_BATCH_LIMIT = 10;

/**
 * 一份風格最多帶幾張參考圖，也是風格分析一次最多挑幾頁。
 *
 * 同一個 4 原本散在四個地方（core 的 `stylePresetSchema`、伺服器兩個端點的 `referenceIds`、
 * 編輯器的 `MAX_ANALYSIS_PAGES`），改動時必定漏掉一個。
 */
export const STYLE_REFERENCE_IMAGE_LIMIT = 4;

/**
 * 單一上傳檔案的位元組上限，以及 PDF 匯入簡報的頁數上限。
 *
 * 同樣是「兩邊都要知道」：伺服器用它們擋（`sources.ts` 的 `MAX_SOURCE_BYTES`、
 * `pdf-deck-render.ts` 的 `MAX_DECK_PAGES`），編輯器的匯入視窗要把同一組數字寫給使用者看
 * （「最多 150 頁、100MB」）。分開寫的話，放寬伺服器上限之後畫面仍然勸退使用者。
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_DECK_IMPORT_PAGES = 150;

/**
 * 頁型：封面／段落頁／內頁。
 *
 * **住在 core 是因為三個地方要用同一組字串**：大綱決定每頁是哪一種並寫進
 * `slide.pageType`、風格分析的「依頁型」規則以同一組 kind 命名、影像合約據此挑出該套
 * 哪一段規則。三邊各寫一份 enum 的話，「大綱說 section、設計系統只寫了 cover 與 content」
 * 這種對不上是**靜默**的——模型不會 throw，只會替那一頁自己編一套看起來合理的版面，
 * 而段落頁的規則本來就允許換底色，於是就是使用者回報的「一長串一黑一白」。
 */
export const SLIDE_PAGE_TYPES = ["cover", "section", "content"] as const;
export const slidePageTypeSchema = z.enum(SLIDE_PAGE_TYPES);
export type SlidePageType = (typeof SLIDE_PAGE_TYPES)[number];

export const sourceUsageSchema = z.enum([
  "content",
  "visual-reference",
  "style-reference",
  "direct-asset",
  "exclude-from-generation",
]);

/**
 * 這個用途的來源被選進 `slide.sourceIds` 時，會不會變成送進影像模型的一張附圖。
 *
 * `jobs.ts` 組 references 與大綱決定每頁引用幾份來源，都必須用同一個判準：兩邊各寫一份
 * `usage === "visual-reference"` 之類的條件，就是「大綱以為只附了 3 張、實際附了 12 張」
 * 的來源（2026-07-29 線上 20 頁全數撞上 `GEMINI_IMAGE_REFERENCES_LIMIT`）。
 */
export function sourceAttachesReferenceImage(usage: z.infer<typeof sourceUsageSchema>): boolean {
  return usage === "visual-reference" || usage === "style-reference" || usage === "direct-asset";
}

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
  referenceImages: z.array(styleReferenceImageSchema).max(STYLE_REFERENCE_IMAGE_LIMIT).default([]),
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
  /**
   * 這一版是照哪一種頁型畫的。改頁型會換掉整張圖的版面（封面滿版 vs 內頁格線），所以它
   * **要**進快照——與 `hidden` 相反，那個一個像素都沒動到圖。
   * 維持 optional 而不是 `.default("content")`：舊快照與舊專案都沒有這個欄位，補 default
   * 會讓「大綱沒表態」與「大綱說這是內頁」變成同一件事，於是舊專案的封面頁在下一次生成
   * 時被合約當成內頁重畫。兩邊同為 `undefined` 時比對仍然相等，橘框不會平白亮起來。
   */
  pageType: slidePageTypeSchema.optional(),
});

/**
 * 文字描邊的預設值與上限，住在 `packages/core` 的理由與 `SOURCE_COUNT_LIMIT` 那批相同：
 * 伺服器拿去擋寫入、編輯器拿去當一鍵開啟時寫入的值與滑桿範圍，前端自己抄一份不會有
 * 任何測試發現它過期。
 *
 * `0.04em` 是實測挑出來的一鍵預設：白字壓在明暗不定的背景上時它已經足以救回可讀性
 * （四面都包，不像陰影只護右下那一側），但細到看不出「這段字加了效果」。
 */
export const TEXT_STROKE_DEFAULT_COLOR = "#000000";
export const TEXT_STROKE_DEFAULT_WIDTH_EM = 0.04;
export const TEXT_STROKE_DEFAULT_OPACITY = 0.7;
/** 中文字腔開始被填滿的實測起點是 0.14em；留一點餘裕給「刻意的粗描邊」但不給荒謬值。 */
export const TEXT_STROKE_MAX_WIDTH_EM = 0.2;

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
  /**
   * 文字框的填滿底色；沒有這個欄位就代表「無底色」＝加入這個功能之前的行為。
   * 底色矩形的幾何就是文字框矩形本身（x/y/width/height，旋轉時跟著 rotation 轉），
   * 不加內距也不加圓角——伺服器 SVG、編輯器 DOM、PPTX 三端才逐點一致。
   * `opacity` 只作用於文字，底色的透明度另由 `backgroundOpacity` 決定，兩者獨立。
   * 維持 optional 而不是 `.default()`：default 會讓這兩個欄位在推導出的型別裡變成必填，
   * 逼所有既有的文字框 fixture 與建構點一起改，卻換不到任何行為差異——讀取端一律
   * `backgroundOpacity ?? 1`，而沒有 `backgroundColor` 就不畫底色。
   */
  backgroundColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  /**
   * 文字描邊。沒有 `strokeColor` 就代表「無描邊」＝加入這個功能之前的行為，
   * 與 `backgroundColor` 同一套：色彩欄位是開關，另外兩個是它的參數
   * （讀取端一律 `?? TEXT_STROKE_DEFAULT_*`）。維持 optional 而不是 `.default()`
   * 的理由見上面 `backgroundColor` 那條。
   *
   * `strokeWidth` 的單位是 **em（字級的倍數）而非畫布 px**，與這個 schema 其他長度
   * 欄位相反，是刻意的：描邊寬度對「字看起來粗了多少」的影響完全由它與字級的比例
   * 決定，存絕對 px 會讓同一個值在 100px 標題上細如無物、在 20px 註解上糊成一團，
   * 使用者每改一次字級就得回頭重調。上限 {@link TEXT_STROKE_MAX_WIDTH_EM} 不是防呆
   * 而是實測值：中文筆劃比拉丁字母密，0.14em 起字腔就開始被填滿。
   */
  strokeColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  strokeWidth: z.number().min(0).max(TEXT_STROKE_MAX_WIDTH_EM).optional(),
  strokeOpacity: z.number().min(0).max(1).optional(),
  lineHeight: z.number().positive().default(1.2),
  letterSpacing: z.number().default(0),
  align: z.enum(["left", "center", "right"]).default("left"),
  verticalAlign: z.enum(["top", "middle", "bottom"]).default("top"),
  rotation: z.number().min(-180).max(180).default(0),
  confidence: z.number().min(0).max(1),
  role: z.enum(["presentation", "logo", "incidental"]).default("presentation"),
});

/**
 * 一個文字層最多幾個框。
 *
 * 抽成常數而不是三處各寫一個 `500`：文字層自己、job 的 `textExtraction`（它的框最後就是
 * 要寫成一個新層，上限必須相同），以及 `extract-text` 端點在合併手動框之前的預檢。三者
 * 一漂就會出現「端點放行、寫檔時 ZodError」的死路——而那時 OCR 與可選的樣式精修（會花
 * 模型配額）都已經跑完了，使用者只拿得到一份 zod issue dump。
 */
export const EDITABLE_TEXT_BOX_LIMIT = 500;

export const editableTextLayerSchema = z.object({
  originalVersionId: z.string().min(1),
  backgroundPath: z.string().min(1),
  compositePath: z.string().min(1),
  threshold: z.number().min(0.5).max(0.95).default(0.75),
  renderRevision: z.number().int().nonnegative().default(0),
  boxes: z.array(editableTextBoxSchema).max(EDITABLE_TEXT_BOX_LIMIT),
  /**
   * 這一層的框從哪裡來：`extracted` 是 OCR／PDF 原生文字層抽出來的（背景已抹字），
   * `manual` 是使用者在沒抽離過的原圖上手動加的（背景一個字都沒抹，`backgroundPath`
   * 就別名指向原圖版本的 `imagePath`）。兩者的差別只有兩處讀取端在意：手動層的
   * 「抽離文字」是合併＋開新版本（不可就地取代，否則手打的字整份消失），且刪除確認
   * 文字不同。
   * 維持 optional 而不是 `.default("extracted")`：default 會讓這個欄位在推導出的型別裡
   * 變成必填，逼所有既有的 textLayer fixture 與建構點一起改，卻換不到任何行為差異——
   * 讀取端一律 `?? "extracted"`，舊專案檔載入後行為與加入這個欄位前完全相同
   * （與 `pinnedSourceIds`、`backgroundColor` 同一套理由）。
   */
  origin: z.enum(["extracted", "manual"]).optional(),
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
  /**
   * 這一頁是封面、段落頁還是內頁。**由大綱決定並寫下來，不再讓影像模型自己猜**：合約
   * 過去要模型從 `purpose`／`content` 反推頁型，猜錯就套錯頁型規則，而段落頁的規則往往
   * 允許換底色——那是背景翻轉的其中一個入口。
   * `undefined` 代表大綱沒有表態（舊專案、或非嚴格 gateway 把這個欄位整個丟掉），合約
   * 會退回「你自己判斷」＝加入這個欄位前的行為。
   */
  pageType: slidePageTypeSchema.optional(),
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
  /**
   * 隱藏頁：不放映、不進 `pptx`／`pdf` 成品、不佔頁碼。**仍可正常選取、編輯、生成**，
   * `png.zip` 與 `slide-project` 也照常收錄它——隱藏是「這一頁不上場」，不是刪除，
   * 也不是「不要這張圖」。
   * `.default(false)` 讓舊專案檔載入後行為與加入這個欄位前完全相同。
   */
  hidden: z.boolean().default(false),
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
      // 與 editableTextLayerSchema 同一個上限：這些框最後原封不動變成新版本的文字層。
      boxes: z.array(editableTextBoxSchema).max(EDITABLE_TEXT_BOX_LIMIT),
      /**
       * 視覺樣式精修（字色／字型／weight／對齊／role）到底有沒有套上去。
       *
       * `applied: false` 代表這些框的字色與字型全是 `boxesFromOcr` 的預設值（白字 Arial），
       * 不是從圖上估出來的。這件事**必須**跟著 job 回到前端：使用者看到的是「整頁 31 個框
       * 都是白字」，而那與「這一頁本來就是白字」在畫面上長得一模一樣，沒有這個欄位就只能
       * 靠反推。`reason` 是伺服器的原因代碼（大寫底線），翻譯留在 UI 層。
       *
       * optional：這個欄位加入之前落地的 job 沒有它，舊專案檔要照樣讀得起來。
       */
      styleRefinement: z
        .object({
          applied: z.boolean(),
          reason: z
            .string()
            .regex(/^[A-Z0-9_]+$/)
            .optional(),
          /**
           * 給使用者看的補充說明，目前只有 `TEXT_MODEL_UNAVAILABLE` 會帶：provider 的
           * `availability.reason`。那是**靜態設定字串**（CLI 沒裝、缺 API key、要開哪個環境
           * 變數），不含憑證也不含頁面內容，而它往往正好就是使用者的下一步。
           */
          detail: z.string().max(500).optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * 「AI 自由設計」的風格決議結果（見 `apps/server/src/style-direction.ts`）。
 *
 * 語意與 `generationJobSchema.textExtraction.styleRefinement` 是同一套，只是掛在專案上
 * ——這一步沒有 job 可以掛，而使用者要知道的事情一模一樣：**這份簡報到底有沒有一份共用
 * 的設計系統**。沒有的話每一頁會各自決定視覺語言，而那與「模型今天狀況比較差」在畫面上
 * 長得一樣，沒有這個欄位就只能靠猜。
 *
 * `applied` 是「designSystem 有沒有真的寫進 styleSnapshot」；`applied: true` 仍可能帶
 * `reason`，代表寫進去了但有具名缺口（例如模型沒講明整份走深色還是淺色，明暗仍可能翻）。
 * 兩者的下一步不同，所以刻意不收斂成一個布林。`detail` 只帶 provider 的
 * `availability.reason`——那是靜態設定字串（缺哪個環境變數、缺哪把 key），往往正好是下一步。
 */
export const styleDirectionOutcomeSchema = z.object({
  applied: z.boolean(),
  reason: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  detail: z.string().max(500).optional(),
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
  /**
   * 最近一次「風格決議」的結果。optional＝這個功能之前的專案沒有它，前端一律當成
   * 「沒有跑過」而不是「跑失敗了」。
   */
  styleDirection: styleDirectionOutcomeSchema.optional(),
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
export type StyleDirectionOutcome = z.infer<typeof styleDirectionOutcomeSchema>;
export type SlideVersion = z.infer<typeof slideVersionSchema>;
export type EditableTextBox = z.infer<typeof editableTextBoxSchema>;
export type EditableTextLayer = z.infer<typeof editableTextLayerSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type PageNumberSettings = z.infer<typeof pageNumberSettingsSchema>;
export type PresentationProject = z.infer<typeof presentationProjectSchema>;
export type SourceAsset = z.infer<typeof sourceAssetSchema>;
export type SourceCitation = z.infer<typeof sourceCitationSchema>;
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

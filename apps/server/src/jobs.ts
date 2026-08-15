import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import sharp from "sharp";
import {
  SafeProviderError,
  logError,
  logWarn,
  sourceAttachesReferenceImage,
  type GeneratedImage,
  type GenerationJob,
  type EditableTextBox,
  type ImageGenerationProgress,
  type ImageReferenceRole,
  type ImageProvider,
  type SlideOutlineSnapshot,
  type SlideSpec,
} from "@slide-maker/core";
import type { ImageProviderSource } from "./readiness.js";
import { FileProjectRepository } from "./repository.js";
import { FileStyleRepository } from "./styles.js";
import { renderComposite, unerasedImagePath } from "./text-layers.js";
import type { UsageLedger, UsageRecordInput } from "./usage-ledger.js";
import { adoptVersion, staleVersionAssets, versionAssetPaths } from "./version-assets.js";

/** JobRunner 記帳所需的兩件事：帳本本身，與「provider id → 模型識別欄位」的解析。 */
export interface JobUsageRecording {
  ledger: UsageLedger;
  modelFields(providerId: string): { modelEntryId?: string; model?: string; providerKind?: string };
}

/**
 * 失敗的 provider 呼叫身上的用量欄位。只碰這兩個欄位——例外的 message 與 stack 可能夾帶
 * 正文（非嚴格 gateway 會把整包 request body 回聲回來），一個字都不該靠近帳本。
 */
function failedCallFacts(error: unknown): Pick<UsageRecordInput, "usage" | "requests"> {
  if (!(error instanceof SafeProviderError)) return {};
  return {
    ...(error.usage === undefined ? {} : { usage: error.usage }),
    ...(error.requests === undefined ? {} : { requests: error.requests }),
  };
}

const PHASE_STEP = {
  queued: 1,
  preparing: 2,
  launching: 3,
  // 值刻意保留舊名：既有 project.json 的 job 快照裡存著它，改名要配一條資料 migration。
  // 使用者看到的字串在編輯器端，已改成不提 Codex。
  waiting_for_codex: 4,
  validating_output: 5,
  persisting: 6,
  completed: 6,
  failed: 6,
  cancelled: 6,
} as const;
/**
 * provider 丟出的 `SafeProviderError.code` → 使用者看得懂的中文。
 * 只收「使用者自己有下一步可做」的碼；其餘落到 safeFailure() 的通用分類。
 */
const PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  OPENAI_AUTH_REQUIRED: "端點回報認證失敗，請確認模型庫裡這條連線的 API key。",
  GEMINI_AUTH_REQUIRED: "端點回報認證失敗，請確認模型庫裡這條連線的 API key。",
  OPENAI_USAGE_LIMIT: "模型額度已達上限，請在額度恢復後重試。",
  GEMINI_USAGE_LIMIT: "模型額度已達上限，請在額度恢復後重試。",
};

/** 一張要附給影像模型的圖。`sourceId` 只供截斷 log 使用，不會送進 provider。 */
export interface JobImageReference {
  path: string;
  mediaType: string;
  role: ImageReferenceRole;
  name?: string;
  sourceId?: string;
}

/**
 * 把 references 砍到 provider 宣告得下的張數。
 *
 * 大綱那端的 schema 上限是「請模型配合」而不是保證（非嚴格 gateway 不遵守 json_schema），
 * 而使用者手動指定來源、風格帶三張參考圖時，正常路徑也湊得出超過 8 張。沒有這一層，
 * 超額只會在 transport 的最後一刻整個 job 失敗（2026-07-29 線上 20 頁全掛）。
 *
 * 三條規則：
 *  1. `protectedIndices`（編輯任務的 base／mask）**一張都不能砍**：它們是被 `edit.baseImageIndex`
 *     ／`maskImageIndex` 指到的位置，砍掉會讓索引指向別的角色——那是無聲的失敗（模型收到
 *     「Image 1 是你要編輯的投影片」與「Image 1: role=style」互相打架的兩句話）。
 *  2. 風格參考圖 → 內容參考圖 → 框架範本（`deck-frame`，上一頁）。風格圖優於內容圖的理由
 *     不變：少一張資料圖只是少一份佐證，少了風格圖整頁會長得不像這份簡報。**範本排在最後**
 *     是因為內容圖是使用者透過 `sourceIds`／`pinnedSourceIds` 明確選中的東西——少一張範本是
 *     「鄰頁略不一致」，少一張圖表是「使用者要的佐證沒出現」，不是同一量級。塞得下時三者
 *     行為完全相同（函式在額度夠時提早返回），只有真的超額才分得出來。
 *  3. 同類之間依原順序砍尾，`sourceIds` 的排序因此就是保留的優先序。
 *
 * 回傳保留下來的原始索引，呼叫端據此重算 `edit` 的索引——雖然目前 base／mask 一定在最前
 * 面（砍尾不會位移它們），但那是排列上的巧合，不是這個函式該賴以成立的前提。
 */
export function limitReferences<T extends { role: ImageReferenceRole }>(
  references: readonly T[],
  max: number | undefined,
  protectedIndices: readonly number[] = [],
): { keptIndices: number[]; droppedIndices: number[] } {
  const all = references.map((_reference, index) => index);
  if (max === undefined || references.length <= max)
    return { keptIndices: all, droppedIndices: [] };
  const isProtected = new Set(protectedIndices);
  const budget = Math.max(0, max - isProtected.size);
  const supplemental = all.filter((index) => !isProtected.has(index));
  const priority = (index: number): number => {
    const role = references[index]!.role;
    if (role === "style") return 0;
    return role === "deck-frame" ? 2 : 1;
  };
  const kept = new Set([
    ...isProtected,
    // 穩定排序：同一優先級維持原順序，砍的永遠是尾巴那幾張。
    ...supplemental.sort((left, right) => priority(left) - priority(right)).slice(0, budget),
  ]);
  return {
    keptIndices: all.filter((index) => kept.has(index)),
    droppedIndices: all.filter((index) => !kept.has(index)),
  };
}

function outlineSnapshot(slide: SlideSpec): SlideOutlineSnapshot {
  return {
    purpose: slide.purpose,
    content: slide.content,
    narrative: slide.narrative,
    layoutHint: slide.layoutHint,
    imagePrompt: slide.imagePrompt,
    sourceIds: [...slide.sourceIds],
  };
}

/**
 * 編輯／抹字任務要動刀的底圖。
 *
 * 兩條分支同源：都是「使用者手上那張圖在**文字被畫上去之前**的樣子」。文字層的
 * `imagePath` 是合成圖（背景 ＋ 可編輯文字），拿它當底圖會把那些字烘成再也刪不掉的像素，
 * 而下一次 `renderComposite()` 還會把同一批字**再畫一次**——同一句話於是出現兩份。
 *
 * 分支不同的只有「哪一張算是文字被畫上去之前」：
 * - `edit` 是在背景上動刀，所以任何文字層都取 `backgroundPath`（抽出來的層那張已抹乾淨，
 *   正是編輯該動的那一張）。
 * - `extract-text` 要抹的字必須還在圖上，只有手動層的背景符合（＝`unerasedImagePath`）；
 *   抽出來的層根本不會走到這裡，`extract-text` 端點會先回頭找 `originalVersionId` 那一版。
 *
 * 抽成函式是因為同一個判斷在 `run()` 裡出現兩次（送給 provider 的 reference、與
 * `compositeMaskedEdit` 的底圖），兩處一漂就會變成「模型看到 A、合成用 B」的無聲錯位。
 */
function editBaseImagePath(
  version: Pick<SlideSpec["versions"][number], "imagePath" | "textLayer">,
  operation: GenerationJob["operation"],
): string {
  if (operation === "edit") return version.textLayer?.backgroundPath ?? version.imagePath;
  return unerasedImagePath(version);
}

/**
 * 沒附上框架範本的原因。**每一種都要記得下來**：使用者回報「相鄰兩頁還是不一致」時，
 * 「這一頁根本沒收到範本」與「收到了但模型沒理它」要採取的行動完全相反，而伺服器上唯一
 * 分得出來的東西就是這一行。
 */
type DeckFrameSkipReason =
  | "REFERENCE_IMAGES_UNSUPPORTED"
  | "MULTIPLE_REFERENCES_UNSUPPORTED"
  | "NO_PREVIOUS_GENERATED_SLIDE"
  | "STYLE_VERSION_STALE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "FRAME_ASSET_MISSING"
  | "REFERENCE_BUDGET_EXCEEDED";

/**
 * 副檔名 → mediaType。與 `editBaseImagePath` 那段同源，但這裡**認不出來就不附**而不是一律
 * 回退 png：底圖是編輯任務的必要輸入（猜錯也只能送），範本是可有可無的加分項，而內建 mock
 * provider 落地的是 `.svg`——把它標成 `image/png` 送給真的影像模型換來的是整頁失敗。同一份
 * 專案先用 mock 跑再換真模型是真實路徑（使用者換模型組合）。
 */
function deckFrameMediaType(path: string): string | undefined {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  return undefined;
}

interface DeckFrameChoice {
  readonly reference?: { path: string; mediaType: string };
  /** 兩個欄位都沒有＝這是第一頁，沒有「找不到」可言，不必記 log。 */
  readonly skipReason?: DeckFrameSkipReason;
}

/**
 * 這一頁的「框架範本」：同一份 deck 裡**前一張已經生成好、而且真的用得上**的投影片。
 *
 * 每頁都是單次無狀態生成，附給模型的圖原本只有風格庫參考圖與該頁自己的來源圖——同一份
 * 簡報已生成的其他頁一張都不會附上，跨頁一致性全靠 designSystem 的文字描述重現，實測兩頁
 * 的標頭樣式因此長得不一樣。附上前一頁，模型才看得到自己上一次把這套系統實作成什麼樣子。
 * 它是**範本不是要複製的目標**，那件事由合約的 DECK FRAME REFERENCE 規則承擔，這裡只負責挑圖。
 *
 * **每一道檢查都在迴圈裡，不合格就繼續往前找**，不是選定第一張有 version 物件的頁就 commit：
 * 那樣第 N 頁的一個壞掉的指標／不見的檔案會讓第 N+1 頁永遠碰不到更前面那張完好的圖。
 * 四道檢查：
 *  - **version 物件還在**（`currentVersionId` 指到不存在的 id 是手改過的 project.json、或
 *    未來某個抽掉 version 卻忘了改指標的路徑）。
 *  - **`styleVersion` 與專案現行風格相同**。改了風格只重生第 12 頁時，第 11 頁還是舊風格，
 *    附上去等於把新的 designSystem 往回拉。副作用正好是對的：改完風格重生整份時第一頁沒有
 *    範本，之後每一頁從新生成的頁接續。
 *  - **副檔名認得出來**（見 `deckFrameMediaType`）。
 *  - **檔案真的在磁碟上**。四條真實 transport 都會無條件把每一張參考圖讀進來，少一個檔案
 *    就是整頁 `failed`——而且 ENOENT 訊息帶著 `.png` 會命中 `safeFailure` 的 PNG 分支，使用者
 *    被告知「生成圖片未通過安全或格式驗證」，真正的原因卻是**另一頁**的檔案不見了。
 *    `parseProjectBundle()` 不比對每個 `version.imagePath` 是否真的在 zip 裡，所以這條可達。
 *
 * 另外兩個決定：
 *  - **隱藏頁照樣可以當範本**。`hidden` 的語意是「這一頁不上場」，不是「這一頁不算數」——
 *    它的視覺框架仍然是這份 deck 的。跳過隱藏頁只會讓它後面那一頁莫名其妙地少一張範本。
 *  - 用 version 的 `imagePath`（使用者現在看到的那張，含文字層的合成結果），因為那正是
 *    「這份 deck 現在長什麼樣」。已知取捨：抽字後的合成圖上，文字是用**系統字型**重繪的
 *    （內嵌字型在伺服器與瀏覽器都不存在），所以拿它當範本時「字級與顏色處理」對齊到的是
 *    近似值——不要日後把這條路當成字型一致性的依據。
 *
 * 回報的原因是**最近的那一次拒絕**（不是最遠的）：使用者想知道的是「我前面那一頁怎麼了」。
 */
async function chooseDeckFrame(
  slides: readonly SlideSpec[],
  slide: SlideSpec,
  styleVersion: number,
  resolve: (storedPath: string) => string,
): Promise<DeckFrameChoice> {
  const earlier = slides
    .filter((candidate) => candidate.order < slide.order)
    // 穩定排序：order 沒有唯一性約束，同分時維持 slides 陣列的原順序，同一份專案兩次生成
    // 才會挑到同一張範本。
    .sort((left, right) => right.order - left.order);
  let nearestRejection: DeckFrameSkipReason | undefined;
  for (const candidate of earlier) {
    if (!candidate.currentVersionId) continue;
    const version = candidate.versions.find((entry) => entry.id === candidate.currentVersionId);
    if (!version) continue;
    if (version.styleVersion !== styleVersion) {
      nearestRejection ??= "STYLE_VERSION_STALE";
      continue;
    }
    const mediaType = deckFrameMediaType(version.imagePath);
    if (!mediaType) {
      nearestRejection ??= "UNSUPPORTED_MEDIA_TYPE";
      continue;
    }
    const path = resolve(version.imagePath);
    const readable = await access(path).then(
      () => true,
      () => false,
    );
    if (!readable) {
      nearestRejection ??= "FRAME_ASSET_MISSING";
      continue;
    }
    return { reference: { path, mediaType } };
  }
  if (nearestRejection) return { skipReason: nearestRejection };
  // 第一頁（前面根本沒有頁）不記 log——那不是降級，是這個功能本來就不適用。
  return earlier.length ? { skipReason: "NO_PREVIOUS_GENERATED_SLIDE" } : {};
}

function sameOutline(slide: SlideSpec, snapshot: SlideOutlineSnapshot): boolean {
  return (
    slide.purpose === snapshot.purpose &&
    slide.content === snapshot.content &&
    slide.narrative === snapshot.narrative &&
    slide.layoutHint === snapshot.layoutHint &&
    slide.imagePrompt === snapshot.imagePrompt &&
    JSON.stringify(slide.sourceIds) === JSON.stringify(snapshot.sourceIds)
  );
}

function safeFailure(
  error: unknown,
  aborted: boolean,
  persisting = false,
): { code: string; message: string; phase: "failed" | "cancelled" } {
  if (aborted || (error instanceof DOMException && error.name === "AbortError"))
    return { code: "CANCELLED", message: "生成工作已取消。", phase: "cancelled" };
  if (persisting)
    return {
      code: "PERSIST_FAILED",
      message: "圖片已生成，但結果儲存失敗（資料驗證或寫入錯誤），請重試。",
      phase: "failed",
    };
  if (error instanceof SafeProviderError && Object.hasOwn(PROVIDER_ERROR_MESSAGES, error.code)) {
    return { code: error.code, message: PROVIDER_ERROR_MESSAGES[error.code]!, phase: "failed" };
  }
  const message = error instanceof Error ? error.message : "";
  if (/timed out|timeout/i.test(message))
    return { code: "PROVIDER_TIMEOUT", message: "圖片生成逾時，請稍後重試。", phase: "failed" };
  if (/PNG|output|image size|image format|dimensions|symlink|workspace|regular file/i.test(message))
    return {
      code: "OUTPUT_VALIDATION_FAILED",
      message: "生成圖片未通過安全或格式驗證。",
      phase: "failed",
    };
  return {
    code: "PROVIDER_FAILED",
    message: "圖片生成失敗，請檢查 provider 狀態後重試。",
    phase: "failed",
  };
}

function validatedOutput(
  result: Awaited<ReturnType<ImageProvider["generate"]>>,
  providerId: string,
): {
  bytes: Uint8Array;
  extension: "png" | "jpg" | "svg";
  parameters: Record<string, unknown>;
} {
  if (result.bytes.byteLength === 0 || result.bytes.byteLength > 25 * 1024 * 1024)
    throw new Error("Provider returned an invalid image size");
  let extension: "png" | "jpg" | "svg";
  const bytes = result.bytes;
  if (
    result.mediaType === "image/png" &&
    result.extension === "png" &&
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  ) {
    extension = "png";
  } else if (
    result.mediaType === "image/jpeg" &&
    ["jpg", "jpeg"].includes(result.extension) &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    extension = "jpg";
  } else if (
    providerId === "mock-image" &&
    result.mediaType === "image/svg+xml" &&
    result.extension === "svg"
  ) {
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      !/^<svg\s/i.test(svg.trim()) ||
      /<(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|\/\/)/i.test(
        svg,
      )
    ) {
      throw new Error("Mock provider returned unsafe SVG");
    }
    extension = "svg";
  } else {
    throw new Error("Provider returned an unsupported or mismatched image format");
  }
  let parameters: unknown;
  try {
    const serialized = JSON.stringify(result.parameters);
    if (serialized.length > 65_536) throw new Error("Provider parameters are too large");
    parameters = JSON.parse(serialized);
  } catch {
    throw new Error("Provider parameters must be JSON-safe");
  }
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    throw new Error("Provider parameters must be an object");
  return { bytes, extension, parameters: parameters as Record<string, unknown> };
}

export async function compositeMaskedEdit(
  base: Uint8Array,
  edited: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const normalizedMask = await sharp(mask)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();
  const overlay = await sharp(edited)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .composite([{ input: normalizedMask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return new Uint8Array(
    await sharp(base)
      .resize(width, height, { fit: "fill" })
      .composite([{ input: overlay, blend: "over" }])
      .png()
      .toBuffer(),
  );
}

export class JobRunner {
  readonly #controllers = new Map<string, AbortController>();
  readonly #activeTasks = new Map<string, Promise<void>>();
  readonly #pendingLifecycleWrites = new Set<Promise<void>>();
  readonly #shutdownKeys = new Set<string>();
  readonly #activeByProvider = new Map<string, number>();
  readonly #pendingByProvider = new Map<string, Array<{ projectId: string; jobId: string }>>();
  #accepting = true;
  #shutdownPromise?: Promise<void>;

  constructor(
    private readonly repository: FileProjectRepository,
    private readonly providers: ImageProviderSource,
    private readonly styles?: FileStyleRepository,
    private readonly usage?: JobUsageRecording,
  ) {}

  /**
   * 記一次影像呼叫。**成功與失敗都記**——失敗一樣燒配額，只記成功的會系統性低估。
   *
   * 整段包在 try/catch 裡再套一層 `void`：記帳是觀測，不得有本事影響 job 的結果或時序。
   */
  private recordUsage(
    projectId: string,
    job: GenerationJob,
    providerId: string,
    ok: boolean,
    facts: Pick<UsageRecordInput, "usage" | "requests"> = {},
  ): void {
    if (!this.usage) return;
    try {
      void this.usage.ledger.recordProject(projectId, {
        capability: "image",
        // job 的 operation 就是帳本的 operation（image／edit／extract-text 三種），
        // 不另外分類——那三者消耗的是同一個影像模型，但成本結構完全不同。
        operation: job.operation,
        slideId: job.slideId,
        ok,
        ...this.usage.modelFields(providerId),
        ...facts,
      });
    } catch {
      // modelFields 若因模型庫熱重建而 throw，也不能影響 job。
    }
  }

  private controllerKey(projectId: string, jobId: string): string {
    return `${projectId}:${jobId}`;
  }

  /**
   * 測試用：目前註冊中的 AbortController 數量。`#controllers` 是硬私有欄位，外部
   * 無法直接觀察，這個唯讀存取子用來釘住「job 失敗／早退時 controller 不殘留」的
   * 不變量（見 `run()` 首個 updateProject 的清理）。
   */
  activeControllerCount(): number {
    return this.#controllers.size;
  }

  async enqueue(
    projectId: string,
    slideId: string,
    providerId: string,
    edit?: {
      instruction: string;
      baseVersionId: string;
      maskPath?: string;
      textExtraction?: {
        originalVersionId: string;
        replaceVersionId?: string;
        threshold: number;
        boxes: EditableTextBox[];
        /** 樣式精修有沒有套上（見 `generationJobSchema`）；原樣寫進 job 供前端判讀。 */
        styleRefinement?: { applied: boolean; reason?: string; detail?: string };
      };
    },
  ): Promise<GenerationJob> {
    if (!this.#accepting) throw new Error("SERVER_SHUTTING_DOWN");
    const provider = this.providers.get(providerId);
    if (provider.availability.status !== "available") throw new Error("Provider is unavailable");
    // 局部用途的 provider（如 local-inpaint 只做遮罩去字）不能整頁生成；
    // 兩條 generate route（單頁／批次）都經過這裡，統一在 enqueue 擋。
    if (!edit && !provider.capabilities.fullSlideGeneration)
      throw new Error("FULL_SLIDE_GENERATION_UNSUPPORTED");
    this.providerLimit(provider);
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: randomUUID(),
      projectId,
      slideId,
      providerId,
      status: "queued",
      lifecycleVersion: 1,
      phase: "queued",
      progress: { step: 1, total: 6 },
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      phaseUpdatedAt: now,
      operation: edit?.textExtraction ? "extract-text" : edit ? "edit" : "generate",
      ...(edit
        ? {
            editInstruction: edit.instruction,
            baseVersionId: edit.baseVersionId,
            ...(edit.maskPath ? { maskPath: edit.maskPath } : {}),
            ...(edit.textExtraction ? { textExtraction: edit.textExtraction } : {}),
          }
        : {}),
      ...(provider.timeoutMs ? { timeoutMs: provider.timeoutMs } : {}),
    };
    await this.repository.updateProject(projectId, (project) => {
      if (!this.#accepting) throw new Error("SERVER_SHUTTING_DOWN");
      const target = project.slides.find((slide) => slide.id === slideId);
      if (!target) throw new Error("Slide not found");
      // 編輯／抽字的呼叫端是在鎖外先讀專案挑出 base 版本，再做完 OCR 等長工作才排入
      // 任務——extract-text 那段可以跑好幾分鐘。這期間版本刪除（它只看得到已存在的
      // 任務）擋不住任何東西，所以在鎖內、寫入任務之前再確認一次 base 還在；晚一步
      // 發現的話 job 會照跑，把配額花光才在執行期撞上同一個錯。
      const referencedVersionIds = edit
        ? [
            edit.baseVersionId,
            ...(edit.textExtraction
              ? [
                  edit.textExtraction.originalVersionId,
                  ...(edit.textExtraction.replaceVersionId
                    ? [edit.textExtraction.replaceVersionId]
                    : []),
                ]
              : []),
          ]
        : [];
      if (referencedVersionIds.some((id) => !target.versions.some((version) => version.id === id)))
        throw new Error("EDIT_BASE_VERSION_MISSING");
      if (
        !provider.capabilities.supportedSizes.some(
          (size) => size.width === project.canvas.width && size.height === project.canvas.height,
        )
      ) {
        throw new Error("Provider does not support this canvas size");
      }
      project.jobs.push(job);
      project.updatedAt = now;
    });
    this.logPhase(job);
    setTimeout(() => {
      this.schedule(projectId, job.id, providerId);
    }, 0);
    return job;
  }

  async cancel(projectId: string, jobId: string): Promise<GenerationJob> {
    const result = await this.repository.updateProject(projectId, (project) => {
      const job = project.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error("Job not found");
      if (job.status === "queued" || job.status === "running") {
        const wasRunning = job.status === "running";
        job.status = "cancelled";
        job.phase = "cancelled";
        job.errorCode = "CANCELLED";
        job.error = "生成工作已取消。";
        job.progress = { step: 6, total: 6 };
        job.updatedAt = new Date().toISOString();
        job.phaseUpdatedAt = job.updatedAt;
        job.finishedAt = job.updatedAt;
        if (wasRunning && job.childLifecycle?.spawnedAt && !job.childLifecycle.exitedAt) {
          job.childLifecycle.cancelRequestedAt = job.updatedAt;
        }
        project.updatedAt = job.updatedAt;
      }
      const result = structuredClone(job);
      queueMicrotask(() => this.logPhase(result));
      return result;
    });
    this.#controllers.get(this.controllerKey(projectId, jobId))?.abort();
    return result;
  }

  async cancelProject(projectId: string): Promise<void> {
    const project = await this.repository.loadProject(projectId);
    if (!project) return;
    const active = project.jobs.filter(
      (job) => job.status === "queued" || job.status === "running",
    );
    await Promise.all(active.map((job) => this.cancel(projectId, job.id).catch(() => undefined)));
  }

  async recoverInterruptedJobs(): Promise<void> {
    for (const project of await this.repository.listProjects()) {
      const queued = await this.repository.updateProject(project.id, (current) => {
        const queued: Array<{ jobId: string; providerId: string }> = [];
        for (const job of current.jobs) {
          if (job.status === "running") {
            job.status = "failed";
            job.phase = "failed";
            job.errorCode = "SERVER_RESTARTED";
            job.error = "Server 重新啟動，請重試這一頁。";
            job.progress = { step: 6, total: 6 };
            job.updatedAt = new Date().toISOString();
            job.phaseUpdatedAt = job.updatedAt;
            job.finishedAt = job.updatedAt;
            if (job.childLifecycle?.spawnedAt && !job.childLifecycle.exitedAt) {
              job.childLifecycle.recoveredAt = job.updatedAt;
              delete job.childLifecycle.exitClass;
            }
            current.updatedAt = job.updatedAt;
          } else if (job.status === "queued")
            queued.push({ jobId: job.id, providerId: job.providerId });
        }
        return queued;
      });
      for (const { jobId, providerId } of queued) {
        setTimeout(() => {
          this.schedule(project.id, jobId, providerId);
        }, 0);
      }
    }
  }

  private schedule(projectId: string, jobId: string, providerId: string): void {
    if (!this.#accepting) return;
    let provider: ImageProvider;
    let limit: number;
    try {
      provider = this.providers.get(providerId);
      limit = this.providerLimit(provider);
    } catch {
      void this.failUnsettledJob(
        projectId,
        jobId,
        "Configured provider is unavailable or has invalid concurrency settings",
      );
      return;
    }
    const active = this.#activeByProvider.get(providerId) ?? 0;
    if (active >= limit) {
      this.#pendingByProvider.set(providerId, [
        ...(this.#pendingByProvider.get(providerId) ?? []),
        { projectId, jobId },
      ]);
      return;
    }
    this.#activeByProvider.set(providerId, active + 1);
    const key = this.controllerKey(projectId, jobId);
    const task = this.run(projectId, jobId)
      .then(
        () => undefined,
        async () => {
          await this.failUnsettledJob(
            projectId,
            jobId,
            "Job runner failed before generation could complete",
          );
        },
      )
      .finally(() => {
        this.#activeTasks.delete(key);
        this.releaseProviderSlot(providerId);
      });
    this.#activeTasks.set(key, task);
  }

  private releaseProviderSlot(providerId: string): void {
    const remaining = Math.max(0, (this.#activeByProvider.get(providerId) ?? 1) - 1);
    this.#activeByProvider.set(providerId, remaining);
    const queue = this.#pendingByProvider.get(providerId);
    const next = queue?.shift();
    if (queue?.length === 0) this.#pendingByProvider.delete(providerId);
    if (next && this.#accepting) this.schedule(next.projectId, next.jobId, providerId);
  }

  private providerLimit(provider: ImageProvider): number {
    const limit = provider.maxConcurrency ?? 1;
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new Error("Provider maxConcurrency must be an integer between 1 and 32");
    }
    return limit;
  }

  private async updateProviderProgress(
    projectId: string,
    jobId: string,
    progress: ImageGenerationProgress,
  ): Promise<void> {
    const allowedPhases = ["launching", "waiting_for_codex", "validating_output"] as const;
    if (!allowedPhases.includes(progress.phase as (typeof allowedPhases)[number])) return;
    const phase = progress.phase as (typeof allowedPhases)[number];
    const eventCode = ["turn_started", "item_completed", "turn_completed"].includes(
      String(progress.eventCode),
    )
      ? progress.eventCode
      : undefined;
    await this.repository.updateProject(projectId, (project) => {
      const job = project.jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "running") return;
      if ((job.progress?.step ?? 0) > PHASE_STEP[phase]) return;
      if (job.phase === phase && (!eventCode || job.providerEventCode === eventCode)) return;
      job.phase = phase;
      job.progress = { step: PHASE_STEP[phase], total: 6 };
      if (eventCode) job.providerEventCode = eventCode;
      job.phaseUpdatedAt = new Date().toISOString();
      if (eventCode) {
        job.childLifecycle ??= {};
        job.childLifecycle.lastAllowedEventAt = job.phaseUpdatedAt;
      }
      job.updatedAt = job.phaseUpdatedAt;
      project.updatedAt = job.updatedAt;
      queueMicrotask(() => this.logPhase(structuredClone(job)));
    });
  }

  private async setPhase(projectId: string, jobId: string, phase: "persisting"): Promise<void> {
    await this.repository.updateProject(projectId, (project) => {
      const job = project.jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "running") return;
      job.phase = phase;
      job.progress = { step: PHASE_STEP[phase], total: 6 };
      job.phaseUpdatedAt = new Date().toISOString();
      job.updatedAt = job.phaseUpdatedAt;
      project.updatedAt = job.updatedAt;
      queueMicrotask(() => this.logPhase(structuredClone(job)));
    });
  }

  private async updateChildLifecycle(
    projectId: string,
    jobId: string,
    event:
      | { type: "spawned" }
      | { type: "exited"; exitClass: "success" | "nonzero" | "timeout" | "aborted" },
  ): Promise<void> {
    if (
      event.type === "exited" &&
      !["success", "nonzero", "timeout", "aborted"].includes(event.exitClass)
    )
      return;
    const key = this.controllerKey(projectId, jobId);
    try {
      await this.repository.updateProject(projectId, (project) => {
        const job = project.jobs.find((candidate) => candidate.id === jobId);
        const shutdownExit = event.type === "exited" && this.#shutdownKeys.has(key);
        const cancelExit =
          event.type === "exited" && job?.status === "cancelled" && job.errorCode === "CANCELLED";
        if (!job || (job.status !== "running" && !shutdownExit && !cancelExit)) return;
        const now = new Date().toISOString();
        job.childLifecycle ??= {};
        if (event.type === "spawned") job.childLifecycle.spawnedAt ??= now;
        else {
          job.childLifecycle.exitedAt ??= now;
          // The server-owned shutdown intent has precedence over the provider's
          // local AbortSignal classification, including when close races persistence.
          job.childLifecycle.exitClass = shutdownExit ? "server_shutdown" : event.exitClass;
        }
        job.updatedAt = now;
        project.updatedAt = now;
      });
    } finally {
      // Shutdown keys intentionally live until process exit so an async close observer
      // cannot race the terminal SERVER_SHUTDOWN classification.
    }
  }

  private observeChildLifecycle(
    projectId: string,
    jobId: string,
    event:
      | { type: "spawned" }
      | { type: "exited"; exitClass: "success" | "nonzero" | "timeout" | "aborted" },
  ): Promise<void> {
    const write = this.updateChildLifecycle(projectId, jobId, event);
    this.#pendingLifecycleWrites.add(write);
    void write.finally(() => this.#pendingLifecycleWrites.delete(write)).catch(() => undefined);
    return write;
  }

  shutdown(graceMs = 3_000): Promise<void> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 100 || graceMs > 30_000)
      throw new Error("Shutdown graceMs is out of range");
    this.#accepting = false;
    const requestedAt = new Date().toISOString();
    for (const [key, controller] of this.#controllers) {
      this.#shutdownKeys.add(key);
    }
    this.#shutdownPromise ??= this.performShutdown(graceMs, requestedAt);
    // Persistence is started synchronously before abort callbacks can report a
    // child close; the shutdown key still provides the authoritative class.
    for (const controller of this.#controllers.values()) controller.abort();
    return this.#shutdownPromise;
  }

  private async performShutdown(graceMs: number, now: string): Promise<void> {
    this.#pendingByProvider.clear();
    for (const project of await this.repository.listProjects()) {
      await this.repository.updateProject(project.id, (current) => {
        for (const job of current.jobs) {
          if (job.status !== "queued" && job.status !== "running") continue;
          const wasRunning = job.status === "running";
          job.status = "failed";
          job.phase = "failed";
          job.errorCode = "SERVER_SHUTDOWN";
          job.error = "Server 正在關閉，生成工作已停止。";
          job.progress = { step: 6, total: 6 };
          job.updatedAt = now;
          job.phaseUpdatedAt = now;
          job.finishedAt = now;
          if (wasRunning) {
            job.childLifecycle ??= {};
            job.childLifecycle.shutdownRequestedAt = now;
            this.#shutdownKeys.add(this.controllerKey(project.id, job.id));
          }
          queueMicrotask(() => this.logPhase(structuredClone(job)));
        }
        current.updatedAt = now;
      });
    }
    const deadline = Date.now() + graceMs;
    const waitWithinDeadline = async (promises: readonly Promise<unknown>[]) => {
      if (promises.length === 0) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(promises).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await waitWithinDeadline([...this.#activeTasks.values()]);
    // Lifecycle observers may be deliberately fire-and-forget in providers.
    // Drain every write observed before the same shutdown deadline.
    while (this.#pendingLifecycleWrites.size > 0 && Date.now() < deadline) {
      await waitWithinDeadline([...this.#pendingLifecycleWrites]);
    }
  }

  private logPhase(job: GenerationJob): void {
    const started = Date.parse(job.startedAt ?? job.createdAt);
    console.log(
      JSON.stringify({
        event: "slide_job_phase",
        jobId: job.id,
        projectId: job.projectId,
        slideId: job.slideId,
        providerId: job.providerId,
        phase: job.phase ?? job.status,
        step: job.progress?.step,
        total: job.progress?.total,
        elapsedMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined,
        errorCode: job.errorCode,
      }),
    );
  }

  private async failUnsettledJob(projectId: string, jobId: string, _error: string): Promise<void> {
    try {
      await this.repository.updateProject(projectId, (project) => {
        const job = project.jobs.find((candidate) => candidate.id === jobId);
        if (!job || !["queued", "running"].includes(job.status)) return;
        job.status = "failed";
        job.phase = "failed";
        job.errorCode = "JOB_SCHEDULING_FAILED";
        job.error = "生成工作無法排程，請檢查 provider 設定。";
        job.progress = { step: 6, total: 6 };
        job.updatedAt = new Date().toISOString();
        job.phaseUpdatedAt = job.updatedAt;
        job.finishedAt = job.updatedAt;
        project.updatedAt = job.updatedAt;
        queueMicrotask(() => this.logPhase(structuredClone(job)));
      });
    } catch {
      // The project may have been removed between recovery and scheduling.
    }
  }

  private async run(projectId: string, jobId: string): Promise<void> {
    const controller = new AbortController();
    // controller 必須在 updateProject 之前註冊，取消才能在 queued→running 轉換期間
    // abort 到它（保住既有取消語意）。但這也代表若這個 updateProject 拋出（例如 job
    // 還在排隊時專案被刪），run() 不會進到底部的 finally 清理，controller 會永遠留在
    // map 裡洩漏——所以在拒絕時先把它移除再 rethrow。
    this.#controllers.set(this.controllerKey(projectId, jobId), controller);
    const context = await this.repository
      .updateProject(projectId, (project) => {
        const job = project.jobs.find((candidate) => candidate.id === jobId);
        if (!job || job.status !== "queued") return undefined;
        const slide = project.slides.find((candidate) => candidate.id === job.slideId);
        if (!slide) return undefined;
        job.status = "running";
        job.phase = "preparing";
        job.progress = { step: 2, total: 6 };
        job.attempt += 1;
        job.updatedAt = new Date().toISOString();
        job.phaseUpdatedAt = job.updatedAt;
        job.startedAt ??= job.updatedAt;
        delete job.error;
        delete job.errorCode;
        queueMicrotask(() => this.logPhase(structuredClone(job)));
        return {
          job: structuredClone(job),
          slide: structuredClone(slide),
          project: structuredClone(project),
        };
      })
      .catch((error: unknown) => {
        this.#controllers.delete(this.controllerKey(projectId, jobId));
        throw error;
      });
    if (!context) {
      this.#controllers.delete(this.controllerKey(projectId, jobId));
      return;
    }
    let persisting = false;
    let resultPersisted = false;
    const generatedAssets = new Set<string>();
    try {
      const { project, slide, job } = context;
      const provider = this.providers.get(job.providerId);
      const selectedSources = project.sources
        .filter(
          (source) =>
            slide.sourceIds.includes(source.id) &&
            source.allowModelAccess &&
            source.usage !== "exclude-from-generation",
        )
        // **依 slide.sourceIds 的順序**，不是 project.sources 的（那是上傳順序）。
        // 兩者無關：20 張舊截圖之後才加的 2 張關鍵圖表，即使模型把它們排在 sourceIds 最
        // 前面，這裡仍會照上傳順序把舊圖排前面——超過 provider 上限時被 limitReferences
        // 砍掉的正好是模型真正要的那兩張。`limitReferences` 的「依原順序砍尾」要成立，
        // 前提就是這個陣列已經是優先序。
        .sort(
          (left, right) => slide.sourceIds.indexOf(left.id) - slide.sourceIds.indexOf(right.id),
        );
      const styleReferences = this.styles
        ? project.styleSnapshot.referenceImages.map((reference) => ({
            path: this.styles!.referenceAssetPath(reference.assetPath),
            mediaType: reference.mediaType,
            role: "style" as const,
            name: reference.name,
          }))
        : [];
      const contentReferences = selectedSources
        // 「哪些 usage 會變成一張附圖」只有 `sourceAttachesReferenceImage()` 一份：大綱那端
        // 是用它算每頁的影像額度的。這裡各寫一份字串陣列，下一個人新增 usage（例如
        // `logo-asset`）時只會改到 predicate——大綱以為「這不是圖、不佔額度」，這裡卻照附，
        // 完全就是 2026-07-29 那次事故的形狀，而且靜默。role 的三分支是另一回事（決定合約
        // 怎麼描述這張圖），維持原樣。
        .filter((source) => sourceAttachesReferenceImage(source.usage))
        .map((source) => ({
          path: this.repository.resolveAsset(projectId, source.assetPath),
          mediaType: source.mediaType,
          role: (source.usage === "style-reference"
            ? "style"
            : source.usage === "direct-asset"
              ? "direct-asset"
              : "content") as ImageReferenceRole,
          name: source.name,
          sourceId: source.id,
        }));
      // 框架範本只在全新生成時附：編輯與抹字是在既有像素上動刀，它們的一致性來自底圖
      // 本身，多附一張「別頁長這樣」只會變成重排的理由（916fa47 的形狀）。挑圖的四道檢查
      // 在 `chooseDeckFrame()` 裡，這裡只處理「provider 吃不吃得下」與留下證據。
      //
      // **它是純加分項，絕不可讓原本跑得動的生成變成失敗**，所以要先過 provider 的能力
      // 宣告——下面那兩道檢查（`referenceImages`／`multipleReferenceImages`）是 throw，不是
      // 截斷。實測：宣告 `referenceImages: false` 的 provider 在無條件附上範本之後，第一頁
      // 照常完成、第二頁起每一頁都 `STYLE_REFERENCES_UNSUPPORTED`（jobs-security 那個併發
      // 測試就是這樣變紅的：maxConcurrency=1 讓第二頁排在第一頁完成之後，於是真的拿得到
      // 範本）。`multipleReferenceImages: false` 同理——只有在其餘參考圖是空的時候，範本才
      // 塞得進那唯一的名額。
      //
      // 已知限制（刻意接受）：影像 provider 的 maxConcurrency 是 2，批次生成時最前面**兩**頁
      // 同時開跑，兩頁都還沒有任何已完成的前頁可用，所以都拿不到範本。要讓每一頁都有範本，
      // 只需要序列化**第一個** job（之後照樣兩兩併行），代價是整批多等一頁的時間、而不是
      // 翻倍——實作先不動，等使用者實測效果再決定值不值得。
      const deckFrame: DeckFrameChoice =
        job.operation === "generate"
          ? await chooseDeckFrame(
              project.slides,
              slide,
              project.styleSnapshot.version,
              (storedPath) => this.repository.resolveAsset(projectId, storedPath),
            )
          : {};
      const capabilitySkipReason: DeckFrameSkipReason | undefined = !provider.capabilities
        .referenceImages
        ? "REFERENCE_IMAGES_UNSUPPORTED"
        : !provider.capabilities.multipleReferenceImages &&
            styleReferences.length + contentReferences.length > 0
          ? "MULTIPLE_REFERENCES_UNSUPPORTED"
          : undefined;
      // 找到範本卻附不上去 → 記能力的原因；一張都找不到 → 記挑圖那端的原因（第一頁是
      // undefined，不記）。只記 id 與宣告值，檔名與正文一個字都不進 log。
      const deckFrameSkipReason = deckFrame.reference ? capabilitySkipReason : deckFrame.skipReason;
      if (deckFrameSkipReason)
        logWarn("deck_frame_reference_skipped", {
          projectId,
          jobId,
          slideId: job.slideId,
          providerId: job.providerId,
          reason: deckFrameSkipReason,
        });
      const deckFrameReferences: JobImageReference[] =
        deckFrame.reference && !capabilitySkipReason
          ? [{ ...deckFrame.reference, role: "deck-frame", name: "Previous slide in this deck" }]
          : [];
      const references: JobImageReference[] = [
        ...styleReferences,
        ...deckFrameReferences,
        ...contentReferences,
      ];
      let edit;
      if (job.operation === "edit" || job.operation === "extract-text") {
        const baseVersion = slide.versions.find((version) => version.id === job.baseVersionId);
        if (!baseVersion || !job.editInstruction) throw new Error("EDIT_BASE_VERSION_MISSING");
        const basePath = editBaseImagePath(baseVersion, job.operation);
        const baseMediaType = /\.jpe?g$/i.test(basePath) ? "image/jpeg" : "image/png";
        // 底圖與遮罩是編輯任務的內建輸入，必須標成 base／mask：標成 content 會讓合約
        // 的「參考圖不得把文字帶進輸出」等生成專用禁令誤傷這張要保留的原圖。
        references.unshift({
          path: this.repository.resolveAsset(projectId, basePath),
          mediaType: baseMediaType,
          role: "base",
          name: "Current slide image",
        });
        const baseImageIndex = 0;
        let maskImageIndex: number | undefined;
        if (job.maskPath) {
          references.splice(1, 0, {
            path: this.repository.resolveAsset(projectId, job.maskPath),
            mediaType: "image/png",
            role: "mask",
            name: "Edit mask",
          });
          maskImageIndex = 1;
        }
        edit = {
          instruction: job.editInstruction,
          baseImageIndex,
          ...(maskImageIndex === undefined ? {} : { maskImageIndex }),
          ...(job.operation === "extract-text" ? { purpose: "text-removal" as const } : {}),
        };
      }
      // provider 宣告的張數上限在這裡就砍，不留到 transport 最後一刻整個 job 失敗。
      // 砍完才做下面的能力檢查與 index 一致性檢查：檢查的對象必須是真正會送出去的那一份。
      const limited = limitReferences(
        references,
        provider.capabilities.maxReferenceImages,
        edit
          ? [
              edit.baseImageIndex,
              ...(edit.maskImageIndex === undefined ? [] : [edit.maskImageIndex]),
            ]
          : [],
      );
      // 受保護的張數本身就超過上限（今天不可達：base + mask 最多 2 張，而每個宣告上限的
      // provider 都遠大於 2）。真的發生時 limitReferences 會回超過 max 的張數——那是刻意的
      // （寧可讓 transport 擋，也不能砍掉編輯任務的底圖），但不能無聲無息。
      if (
        provider.capabilities.maxReferenceImages !== undefined &&
        limited.keptIndices.length > provider.capabilities.maxReferenceImages
      )
        logWarn("image_references_protected_over_limit", {
          projectId,
          jobId,
          slideId: job.slideId,
          providerId: job.providerId,
          maxReferenceImages: provider.capabilities.maxReferenceImages,
          keptCount: limited.keptIndices.length,
        });
      if (limited.droppedIndices.length) {
        // 只記 id 與數字：檔名（使用者的檔案名稱常含人名／公司名）、prompt、正文都不進 log。
        logWarn("image_references_truncated", {
          projectId,
          jobId,
          slideId: job.slideId,
          providerId: job.providerId,
          maxReferenceImages: provider.capabilities.maxReferenceImages,
          requestedCount: references.length,
          keptCount: limited.keptIndices.length,
          droppedCount: limited.droppedIndices.length,
          droppedRoles: limited.droppedIndices.map((index) => references[index]!.role),
          droppedSourceIds: limited.droppedIndices.flatMap((index) => {
            const sourceId = references[index]!.sourceId;
            return sourceId ? [sourceId] : [];
          }),
        });
        // 範本被額度砍掉時要記**它自己那一行**，不能只靠上面那條通用截斷：`maxReferenceImages`
        // 被風格圖填滿的通道（宣告 1 張，或風格庫塞滿 4 張而上限是 4）會讓範本每一頁都被丟掉，
        // 整個功能靜默變成 no-op，而使用者只看得到「這個功能沒有效果」。
        if (limited.droppedIndices.some((index) => references[index]!.role === "deck-frame"))
          logWarn("deck_frame_reference_skipped", {
            projectId,
            jobId,
            slideId: job.slideId,
            providerId: job.providerId,
            reason: "REFERENCE_BUDGET_EXCEEDED" satisfies DeckFrameSkipReason,
          });
        const keptPosition = new Map(
          limited.keptIndices.map((index, position) => [index, position]),
        );
        references.splice(
          0,
          references.length,
          ...limited.keptIndices.map((index) => references[index]!),
        );
        if (edit) {
          // base／mask 一定在保留名單裡（limitReferences 不砍受保護的索引），但位置仍要重算：
          // 讓「哪張是底圖」永遠由這份對照表決定，而不是靠 unshift/splice 的排列巧合。
          edit = {
            ...edit,
            baseImageIndex: keptPosition.get(edit.baseImageIndex)!,
            ...(edit.maskImageIndex === undefined
              ? {}
              : { maskImageIndex: keptPosition.get(edit.maskImageIndex)! }),
          };
        }
      }
      // index 與 role 分歧會是無聲的：合約會同時印出「Image 1 是你要編輯的投影片」與
      // 「Image 1: role=style，只取它的配色」，模型收到互相打架的兩句話而我們一無所知。
      if (edit) {
        if (references[edit.baseImageIndex]?.role !== "base")
          throw new Error("EDIT_BASE_REFERENCE_ROLE_MISMATCH");
        if (edit.maskImageIndex !== undefined && references[edit.maskImageIndex]?.role !== "mask")
          throw new Error("EDIT_MASK_REFERENCE_ROLE_MISMATCH");
      }
      // Base/mask images are intrinsic edit inputs, not optional reference-image
      // capability. Only gate supplemental style/content references here.
      const supplementalReferences = edit
        ? references.filter(
            (_reference, index) => index !== edit.baseImageIndex && index !== edit.maskImageIndex,
          )
        : references;
      if (supplementalReferences.length && !provider.capabilities.referenceImages)
        throw new Error("STYLE_REFERENCES_UNSUPPORTED");
      if (supplementalReferences.length > 1 && !provider.capabilities.multipleReferenceImages)
        throw new Error("MULTIPLE_REFERENCES_UNSUPPORTED");
      let result: GeneratedImage;
      try {
        result = await provider.generate(
          {
            projectId,
            slide,
            style: project.styleSnapshot,
            width: project.canvas.width,
            height: project.canvas.height,
            // sourceId 只給截斷 log 用，不外流到 provider 的請求裡。
            references: references.map(({ sourceId: _sourceId, ...reference }) => reference),
            // 合約要求這個欄位，但**沒有任何 provider 讀它**：每家都用自己 entry 上的
            // model 名，落進版本紀錄的也是 provider 回傳的 `GeneratedImage.model`。
            // 舊值寫死 "codex-imagegen"，於是 openai／gemini 生成的圖在請求裡也被標成
            // codex——沒有實際影響，但會誤導任何 log／除錯的人。改帶 provider id。
            model: provider.id,
            parameters: {},
            ...(edit ? { edit } : {}),
          },
          {
            signal: controller.signal,
            onProgress: async (progress) => this.updateProviderProgress(projectId, jobId, progress),
            onLifecycle: async (event) => this.observeChildLifecycle(projectId, jobId, event),
          },
        );
      } catch (error) {
        // 失敗（含取消）也記：請求已經送出去了，配額該燒的照燒。連 usage 都拿不到時落成
        // reported:false，那正是它與「這次沒花 token」要被分開的原因——但「模型回了、只是
        // 解不出圖」那條路的 usage 就在錯誤物件身上（見 `SafeProviderError.usage`），
        // 那是影像通道最貴又零產出的失敗，不可以跟著錯誤一起丟掉。
        this.recordUsage(projectId, job, provider.id, false, failedCallFacts(error));
        throw error;
      }
      // 記在輸出驗證之前：`ok` 的語意是「provider 往返成功、配額已經燒掉」（見
      // `UsageRecordInput.ok`），而驗證不過的那張圖一樣是花錢畫出來的。
      this.recordUsage(projectId, job, provider.id, true, {
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
      if (controller.signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
      let safe = validatedOutput(result, provider.id);
      if (
        (job.operation === "edit" || job.operation === "extract-text") &&
        job.maskPath &&
        job.baseVersionId
      ) {
        const baseVersion = slide.versions.find((version) => version.id === job.baseVersionId)!;
        // 與上面送給 provider 的 base reference 必須是同一張圖（見 editBaseImagePath）：
        // 這裡是遮罩外原樣保留的來源，兩者分歧就等於「改的是 A、貼回 B」。
        const basePath = editBaseImagePath(baseVersion, job.operation);
        const [baseBytes, maskBytes] = await Promise.all([
          readFile(this.repository.resolveAsset(projectId, basePath)),
          readFile(this.repository.resolveAsset(projectId, job.maskPath)),
        ]);
        safe = {
          bytes: await compositeMaskedEdit(
            new Uint8Array(baseBytes),
            safe.bytes,
            new Uint8Array(maskBytes),
            project.canvas.width,
            project.canvas.height,
          ),
          extension: "png",
          parameters: { ...safe.parameters, maskedEdit: true },
        };
      }
      persisting = true;
      await this.setPhase(projectId, jobId, "persisting");
      const versionId = job.textExtraction?.replaceVersionId ?? randomUUID();
      // 在 replaceVersionId 流程中 versionId 不變、檔名重複，會覆蓋同一張背景圖；
      // 加上 randomUUID 後每次生成都是獨立 URL，避免 immutable cache 顯示舊背景。
      const filename = `${slide.id}/${versionId}-${randomUUID()}.${safe.extension}`;
      const backgroundPath = await this.repository.saveAsset(projectId, filename, safe.bytes);
      generatedAssets.add(backgroundPath);
      const baseVersion = slide.versions.find((version) => version.id === job.baseVersionId);
      let imagePath = backgroundPath;
      let textLayer =
        job.operation === "extract-text" && job.textExtraction
          ? {
              originalVersionId: job.textExtraction.originalVersionId,
              backgroundPath,
              compositePath: backgroundPath,
              threshold: job.textExtraction.threshold,
              renderRevision: 0,
              boxes: structuredClone(job.textExtraction.boxes),
              extractedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          : job.operation === "edit" && baseVersion?.textLayer
            ? {
                ...structuredClone(baseVersion.textLayer),
                backgroundPath,
                compositePath: backgroundPath,
                renderRevision: baseVersion.textLayer.renderRevision + 1,
                updatedAt: new Date().toISOString(),
              }
            : undefined;
      if (textLayer) {
        textLayer.compositePath = await renderComposite(this.repository, project, textLayer);
        generatedAssets.add(textLayer.compositePath);
        imagePath = textLayer.compositePath;
      }
      // 編輯／抽字是在既有版本上動刀，大綱沿用被編輯的那一版；重新生成才用當下的大綱。
      const outlineBase = job.operation !== "generate" ? baseVersion : undefined;
      const generatedOutline = structuredClone(
        outlineBase?.outlineSnapshot ?? outlineSnapshot(slide),
      );
      // 指定清單與 outlineSnapshot 同源，兩者要指向同一個時間點。記下來，還原版本時才有辦法
      // 把當時生效的指定一起帶回去，而不是讓它在還原後無聲消失。
      const generatedPins = [
        ...(outlineBase?.outlineSnapshot
          ? (outlineBase.pinnedSourceIds ?? [])
          : slide.pinnedSourceIds),
      ];
      const staleAssets = await this.repository.updateProject(projectId, (current) => {
        const currentJob = current.jobs.find((candidate) => candidate.id === jobId);
        const currentSlide = current.slides.find((candidate) => candidate.id === slide.id);
        if (!currentJob || !currentSlide)
          throw new Error("Project changed while generation was running");
        if (currentJob.status !== "running") return undefined;
        const nextVersion = {
          id: versionId,
          imagePath,
          prompt: job.operation !== "generate" ? job.editInstruction! : currentSlide.imagePrompt,
          providerId: provider.id,
          model: result.model,
          ...(current.combinationId ? { combinationId: current.combinationId } : {}),
          parameters: safe.parameters,
          styleVersion: current.styleSnapshot.version,
          outlineSnapshot: generatedOutline,
          pinnedSourceIds: generatedPins,
          sources: selectedSources.map((source) => ({
            sourceId: source.id,
            title: source.name,
            ...(source.chunks[0]?.locator ? { locator: source.chunks[0].locator } : {}),
            ...(source.chunks[0]?.text ? { excerpt: source.chunks[0].text.slice(0, 500) } : {}),
            ...(source.metadata.url ? { url: source.metadata.url } : {}),
            capturedAt: new Date().toISOString(),
          })),
          createdAt: new Date().toISOString(),
          ...(textLayer ? { textLayer } : {}),
          ...(job.operation === "edit"
            ? { label: `Edited: ${job.editInstruction!.slice(0, 80)}` }
            : {}),
          ...(job.operation === "extract-text" ? { label: "文字抽離" } : {}),
        };
        const replaceIndex =
          job.operation === "extract-text" && job.textExtraction?.replaceVersionId
            ? currentSlide.versions.findIndex(
                (version) => version.id === job.textExtraction!.replaceVersionId,
              )
            : -1;
        const staleCandidates = new Set<string>();
        if (replaceIndex >= 0) {
          const previous = currentSlide.versions[replaceIndex]!;
          for (const assetPath of versionAssetPaths(previous)) staleCandidates.add(assetPath);
          currentSlide.versions[replaceIndex] = {
            ...nextVersion,
            createdAt: previous.createdAt,
          };
          // 取代路徑重用同一個 versionId，這行因此是「維持指向」而不是「切過去」；
          // 新增路徑的同一件事由 `adoptVersion` 一起做掉。
          currentSlide.currentVersionId = versionId;
        } else adoptVersion(currentSlide, nextVersion);
        currentSlide.outlineDirty =
          job.operation !== "generate"
            ? currentSlide.outlineDirty || !sameOutline(currentSlide, generatedOutline)
            : !sameOutline(currentSlide, generatedOutline);
        currentJob.status = "completed";
        currentJob.phase = "completed";
        currentJob.progress = { step: 6, total: 6 };
        currentJob.resultVersionId = versionId;
        currentJob.updatedAt = new Date().toISOString();
        currentJob.phaseUpdatedAt = currentJob.updatedAt;
        currentJob.finishedAt = currentJob.updatedAt;
        current.updatedAt = currentJob.updatedAt;
        queueMicrotask(() => this.logPhase(structuredClone(currentJob)));
        // 取代路徑的三張候選裡，仍被別的版本引用的要留下（背景圖常常是別的版本的
        // imagePath）——只能在上面的取代寫回去**之後**才算得準。
        return staleVersionAssets(current, staleCandidates);
      });
      const completed = staleAssets !== undefined;
      resultPersisted = completed;
      await Promise.allSettled(
        (completed ? staleAssets : [...generatedAssets]).map((assetPath) =>
          this.repository.deleteAsset(projectId, assetPath),
        ),
      );
    } catch (error) {
      logError(
        "slide_job_failed",
        {
          jobId,
          projectId,
          slideId: context.job.slideId,
          providerId: context.job.providerId,
          operation: context.job.operation,
          attempt: context.job.attempt,
        },
        error,
      );
      if (!resultPersisted)
        await Promise.allSettled(
          [...generatedAssets].map((assetPath) =>
            this.repository.deleteAsset(projectId, assetPath),
          ),
        );
      const shutdownRequested = this.#shutdownKeys.has(this.controllerKey(projectId, jobId));
      const failure = shutdownRequested
        ? {
            code: "SERVER_SHUTDOWN",
            message: "Server 正在關閉，生成工作已停止。",
            phase: "failed" as const,
          }
        : safeFailure(error, controller.signal.aborted, persisting);
      await this.repository.updateProject(projectId, (project) => {
        const job = project.jobs.find((candidate) => candidate.id === jobId);
        if (!job || job.status !== "running") return;
        job.status = failure.phase;
        job.phase = failure.phase;
        job.progress = { step: 6, total: 6 };
        job.errorCode = failure.code;
        job.error = failure.message;
        job.updatedAt = new Date().toISOString();
        job.phaseUpdatedAt = job.updatedAt;
        job.finishedAt = job.updatedAt;
        if (shutdownRequested) {
          job.childLifecycle ??= {};
          job.childLifecycle.shutdownRequestedAt ??= job.updatedAt;
        }
        project.updatedAt = job.updatedAt;
        queueMicrotask(() => this.logPhase(structuredClone(job)));
      });
    } finally {
      this.#controllers.delete(this.controllerKey(projectId, jobId));
    }
  }
}

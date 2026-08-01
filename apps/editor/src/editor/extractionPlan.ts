import type { GenerationJob, SlideSpec } from "@slide-maker/core";
import { ApiError } from "../api.js";
import { hiddenSlideCount } from "./slideVisibility.js";

/**
 * 批次抽字一遇到就整批停下的錯誤代碼。
 *
 * 這幾個講的都是「伺服器現在整個不行」而不是某一頁的問題：`OCR_QUEUE_BUSY` 是閘門正滿
 * （繼續送只會讓別人的抽字也排不進去）、`OCR_UNAVAILABLE` 是 OCR 環境沒裝好、
 * `OCR_QUEUE_SHUTDOWN` 是伺服器正在重啟、`PROVIDER_PREFLIGHT_BLOCKED` 是 readiness 閘門
 * 擋下（`app.ts` 的 `assertCanGenerate` → 409）。硬跑下去只是把同一個失敗重複 N 次。
 *
 * {@link OCR_CONFIG_ABORT_CODES} 那幾個也在內：抽字端點在跑 OCR **之前**就擋下樣式精修的
 * 設定錯誤，那是專案／模型庫層級的問題，下一頁不會變好，繼續送只是 N 次空轉。
 */
export const OCR_CONFIG_ABORT_CODES = new Set([
  "COMBINATION_NOT_FOUND",
  "COMBINATION_TEXT_MISSING",
  "NO_DEFAULT_COMBINATION",
  "TEXT_MODEL_NOT_FOUND",
]);
const OCR_BATCH_ABORT_CODES = new Set([
  "OCR_QUEUE_BUSY",
  "OCR_QUEUE_SHUTDOWN",
  "OCR_UNAVAILABLE",
  "PROVIDER_PREFLIGHT_BLOCKED",
  ...OCR_CONFIG_ABORT_CODES,
]);

/**
 * 樣式精修沒套上時的原因代碼 → 使用者看得懂的說明。
 *
 * 這一條的存在理由：`applied === false` 的產物與「這一頁本來就是白字」在畫面上長得一模
 * 一樣（`boxesFromOcr` 的預設就是 `#ffffff` ＋ Arial），不講出來使用者只會以為是抽字抽壞了。
 */
const STYLE_REFINEMENT_REASONS: Record<string, string> = {
  TEXT_MODEL_UNAVAILABLE: "專案綁定組合的文字模型目前不可用",
  STYLE_REFINE_FAILED: "文字模型呼叫或回應解析失敗",
  STYLE_REFINE_EMPTY: "文字模型沒有回傳可用的樣式（回了空清單，或框的編號全對不上）",
};

/** 樣式精修降級的原因代碼與伺服器附的補充說明。 */
export interface StyleRefinementFailure {
  reason: string;
  /** provider 的可用性說明（例如「需設定 SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1」）。 */
  detail?: string;
}

/** 樣式精修降級的說明句（單頁與批次共用同一份措辭）。 */
export function styleRefinementReasonText(failure: StyleRefinementFailure): string {
  const base = STYLE_REFINEMENT_REASONS[failure.reason] ?? `原因代碼 ${failure.reason}`;
  // 伺服器的補充說明往往就是下一步（缺哪個環境變數、缺哪把 key），接在原因後面照原樣顯示。
  return failure.detail ? `${base}（${failure.detail}）` : base;
}

/**
 * 這一次抽字有沒有降級成「沒有風格」？`undefined` 代表樣式精修有套上。
 *
 * 讀 job 而不是重新推論：前端不得鏡射伺服器組態（有沒有文字模型、模型可不可用）來猜這件
 * 事，那必然漂移——答案只有伺服器知道，所以由它跟著 202 一起回來。舊 job 沒有這個欄位
 * （schema 是 optional），當作有套上，行為與加入前一致。
 */
export function styleRefinementFailure(job: GenerationJob): StyleRefinementFailure | undefined {
  const refinement = job.textExtraction?.styleRefinement;
  if (!refinement || refinement.applied) return undefined;
  return {
    reason: refinement.reason ?? "UNKNOWN",
    ...(refinement.detail ? { detail: refinement.detail } : {}),
  };
}

/**
 * 這個失敗是「伺服器現在整個不行」（整批停下），還是「這一頁的狀況」（跳過繼續跑）？
 *
 * 光看錯誤碼不夠。抽字端點的失敗有一大票走不到具名代碼：`MASKED_EDITING_UNSUPPORTED`
 * 之類的裸 `Error` 會落到 `app.ts` 最後那條 500 `INTERNAL_SERVER_ERROR`，反向代理逾時、
 * 憑證過期也一樣——這些下一頁都不會變好，而 150 頁的 PDF 匯入專案等於 150 次註定失敗的
 * 往返（每次都還先排一次 OCR 佇列）。所以除了代碼，`5xx` 與 `401`／`403` 也一律中止。
 *
 * 刻意**不**整個 4xx 都中止：`OCR_NO_TEXT`、`OCR_NO_PRESENTATION_TEXT`、
 * `TEXT_LAYER_BOX_LIMIT`、`EDIT_BASE_VERSION_MISSING` 都是這一頁自己的狀況（整份簡報裡
 * 有幾頁純圖表本來就很正常），跳過就好。
 *
 * 也刻意**不**對 `OCR_QUEUE_BUSY` 加退避重試：撞到就停是這條路的設計（見 `ocr-queue.ts`），
 * 重試只會讓這個批次跟別人的抽字互相搶閘門。
 */
export function isBatchAbortingFailure(reason: unknown): boolean {
  if (!(reason instanceof ApiError)) return false;
  if (reason.code && OCR_BATCH_ABORT_CODES.has(reason.code)) return true;
  return reason.status >= 500 || reason.status === 401 || reason.status === 403;
}

/** 「批次抽離全部文字」的目標頁與跳過的頁（分原因），一次掃完給確認框、按鈕與 tooltip 共用。 */
export interface BatchExtractPlan {
  /** 要處理的頁，依現有順序。 */
  targets: readonly SlideSpec[];
  /** 目標頁裡的隱藏頁張數（確認框要講出來）。 */
  hiddenTargets: number;
  /** 這一版已經有「抽出來的」文字層，再抽一次是重做已經精確的東西。 */
  skippedExtracted: number;
  /** 還沒有圖（沒有 `currentVersionId`，或那個版本不在 `versions` 裡）。 */
  skippedNoImage: number;
}

/**
 * 掃出批次抽字要處理哪幾頁。
 *
 * 合格條件與單頁那顆「抽離文字」鈕**完全同一條**：這一版要有圖，而且不能已經有 `extracted`
 * 的文字層（那份是 OCR ＋ 抹字做出來的，或 PDF 匯入的原生文字層，重抽只是拿較差的結果覆蓋
 * 較好的）。手動層（`origin === "manual"`）合格——它的背景一個字都沒抹，圖上原本的文字還
 * 等著被抽出來，伺服器端會把兩者合併。
 *
 * **隱藏頁一律納入這份清單**：抽字是讓頁面變得可編輯，不是產出成品，隱藏頁一樣要能編輯。
 *
 * 但「納入清單」不等於「不必問」。成本取決於抹字引擎，兩種情況要分開：預設的 OpenCV
 * 在本機跑、不吃任何配額，沒有取捨可問，所以只在確認框裡把張數講出來就夠；選「生圖模型」
 * 時 `app.ts` 的抽字端點會**逐頁**排一個遮罩編輯 job，每一頁都燒一次影像模型配額——那與
 * 「批次生成全部頁面」是同一個成本結構，依 CLAUDE.md 必須用共用的 `BatchGenerateDialog`
 * 讓使用者三選一，不是只告知。挑清單的責任在這裡，問不問由呼叫端依引擎決定。
 */
export function batchExtractPlan(slides: readonly SlideSpec[]): BatchExtractPlan {
  const targets: SlideSpec[] = [];
  let skippedExtracted = 0;
  let skippedNoImage = 0;
  for (const slide of slides) {
    const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
    if (!version) {
      skippedNoImage += 1;
      continue;
    }
    if (version.textLayer && (version.textLayer.origin ?? "extracted") === "extracted") {
      skippedExtracted += 1;
      continue;
    }
    targets.push(slide);
  }
  return {
    targets,
    hiddenTargets: hiddenSlideCount(targets),
    skippedExtracted,
    skippedNoImage,
  };
}

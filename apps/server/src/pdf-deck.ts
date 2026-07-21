import { Worker } from "node:worker_threads";
import {
  DEFAULT_PAGE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_DECK_PAGES,
  assertDeckPdf,
  describeRenderedPages,
  type DeckPreviewResult,
  type DeckRenderLimits,
  type DeckRenderResult,
  type RenderedDeckSource,
} from "./pdf-deck-render.js";
import type { DeckWorkerMessage, DeckWorkerRequest } from "./pdf-deck-worker.js";

/**
 * 「把 PDF 匯入成簡報專案」的對外介面。
 *
 * 光柵化本身在 `pdf-deck-render.ts`；這一層把整批 render 丟到 worker 執行緒去跑，
 * 並在主執行緒上守住兩道時限：
 *
 *  - **單頁時限**：worker 每開始一頁就回報，主執行緒為那一頁上一個計時器。
 *    這道保護只有在主執行緒上才成立——pdf.js 在 Node 上是用 microtask 串接 render
 *    chunk 的，光柵化期間 render 所在執行緒的 `setTimeout` 完全輪不到（實測：
 *    3 秒的重版面頁，在同執行緒設 2 秒單頁時限也不會被中斷）。逾時就砍掉 worker、
 *    把那一頁記進 `failedPages`，再用剩下的頁重啟一個 worker，已完成的頁不用重做。
 *  - **總時限**：跨越 worker 重啟的絕對截止時間，到了就中止整批。
 *
 * 匯入時每頁還要多抽一份可編輯文字層（`pdf-text-layer.ts`）。那一步一樣重
 * （二次光柵化 + 全頁像素比對，實測約 450ms/頁），所以跟著整批 render 一起
 * 跑在 worker 裡，主執行緒在整段匯入期間都還服務得動其他請求。
 *
 * 單頁尺寸檢查（`inspectPdfDeck`）不 render，成本近乎零，留在呼叫端的執行緒上。
 */

export {
  DECK_ASPECT_MAX,
  DECK_ASPECT_MIN,
  DECK_PAGE_HEIGHT,
  DECK_PAGE_WIDTH,
  DEFAULT_PAGE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_DECK_PAGES,
  MAX_DECK_PDF_BYTES,
  deckViewport,
  inspectPdfDeck,
  loadPdfDocument,
  pageTextFragments,
  renderPageToPng,
  stripTextOperators,
} from "./pdf-deck-render.js";
export type {
  DeckInspection,
  DeckPageInfo,
  DeckPreviewResult,
  DeckRenderLimits,
  DeckRenderResult,
  PageTextContent,
  PageTextLayer,
  RenderedDeckPage,
} from "./pdf-deck-render.js";

/**
 * 開工前的緩衝：worker 啟動、載入 pdf.js、把整份 PDF parse 完都算在這一段。
 * 這段時間還沒有任何一頁開始，逾時代表整批卡死，直接中止（不逐頁重試）。
 */
const WORKER_STARTUP_GRACE_MS = 15_000;
/** 單頁看門狗的寬限：涵蓋 worker → 主執行緒 postMessage 的延遲。 */
const PAGE_WATCHDOG_SLACK_MS = 500;

/**
 * worker 的啟動腳本。用 eval 而不是直接指向進入點，是因為從 TypeScript 原始碼
 * 執行時（`tsx watch` 的開發模式、vitest）worker 執行緒沒有 TS loader，
 * 得先自己掛一個再載入進入點。正式建置跑的是 `dist/` 裡的 `.js`，不碰 tsx。
 */
const WORKER_BOOTSTRAP = `
// 只用動態 import()、不用 require 也不用最上層 import：Node 會依情境把 eval 進來的
// worker 程式碼當成 CJS 或 ESM（vitest 底下是 CJS，dist 底下因為 package.json 的
// "type": "module" 是 ESM），只有動態 import() 兩邊都能跑。
(async () => {
  const { workerData, parentPort } = await import("node:worker_threads");
  try {
    if (workerData.entryUrl.endsWith(".ts")) (await import("tsx/esm/api")).register();
    await import(workerData.entryUrl);
  } catch (error) {
    // 這條路走到就是部署問題（進入點不見了、loader 掛不上）：留下可診斷的訊息，
    // 對外仍然是具名錯誤。
    console.error("PDF render worker failed to start", error);
    parentPort.postMessage({ type: "error", error: "PDF_RENDER_WORKER_FAILED" });
  }
})();
`;

function workerEntryUrl(): string {
  const fromSource = new URL(import.meta.url).pathname.endsWith(".ts");
  return new URL(fromSource ? "./pdf-deck-worker.ts" : "./pdf-deck-worker.js", import.meta.url)
    .href;
}

/** 一次 worker 生命週期的結果。 */
interface WorkerAttempt<T> {
  /** 這一輪成功產出的頁（依完成順序）。 */
  produced: T[];
  /** 這一輪 worker 自己判定失敗的頁。 */
  failedPages: number[];
  /** worker 正常跑完整批。 */
  completed: boolean;
  /** 卡在這一頁超過單頁時限，worker 已被 terminate。 */
  stalledPage?: number;
  /** worker 回報的具名錯誤，或崩潰轉成的 `PDF_RENDER_WORKER_FAILED`。 */
  error?: string;
}

async function runWorkerAttempt<T>(
  request: DeckWorkerRequest,
  pageTimeoutMs: number,
): Promise<WorkerAttempt<T>> {
  const worker = new Worker(WORKER_BOOTSTRAP, {
    eval: true,
    workerData: { entryUrl: workerEntryUrl(), request },
  });
  const attempt: WorkerAttempt<T> = { produced: [], failedPages: [], completed: false };
  let watchdog: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        resolve();
      };
      const arm = (budgetMs: number, onExpiry: () => void) => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          onExpiry();
          finish();
        }, budgetMs);
      };
      // 還沒有任何一頁開工就逾時 = 整批卡死，不是某一頁慢。
      arm(pageTimeoutMs + WORKER_STARTUP_GRACE_MS, () => {
        attempt.error = "PDF_IMPORT_TIMEOUT";
      });
      worker.on("message", (message: DeckWorkerMessage) => {
        if (settled) return;
        switch (message.type) {
          case "start":
            return arm(pageTimeoutMs + PAGE_WATCHDOG_SLACK_MS, () => {
              attempt.stalledPage = message.pageNumber;
            });
          case "page":
            return void attempt.produced.push(message.value as T);
          case "failed-page":
            return void attempt.failedPages.push(message.pageNumber);
          case "done":
            attempt.completed = true;
            return finish();
          case "error":
            attempt.error = message.error;
            return finish();
        }
      });
      // 真的崩掉（OOM、native 例外）不會有訊息：轉成具名錯誤，不靜默吞掉。
      worker.on("error", () => {
        if (settled) return;
        attempt.error = "PDF_RENDER_WORKER_FAILED";
        finish();
      });
      worker.on("exit", () => {
        if (settled) return;
        attempt.error = "PDF_RENDER_WORKER_FAILED";
        finish();
      });
    });
    return attempt;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await worker.terminate();
  }
}

/**
 * 跑完一整批頁面：worker 卡住就換一個接著跑剩下的頁，直到沒有頁或撞上總時限。
 */
async function renderInWorkers<T>(
  kind: DeckWorkerRequest["kind"],
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  limits: DeckRenderLimits,
): Promise<{ produced: T[]; failedPages: number[] }> {
  assertDeckPdf(bytes);
  const pageTimeoutMs = limits.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const expiresAt = Date.now() + (limits.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  let remaining = [...pageNumbers].slice(0, MAX_DECK_PAGES);
  const produced: T[] = [];
  const failedPages: number[] = [];
  while (remaining.length) {
    if (Date.now() > expiresAt) throw new Error("PDF_IMPORT_TIMEOUT");
    const attempt = await runWorkerAttempt<T>(
      {
        kind,
        bytes,
        pageNumbers: remaining,
        // worker 自己的總時限跟著絕對截止時間收斂，重啟不會把預算重新算一次。
        limits: { pageTimeoutMs, totalTimeoutMs: expiresAt - Date.now() },
      },
      pageTimeoutMs,
    );
    produced.push(...attempt.produced);
    failedPages.push(...attempt.failedPages);
    if (attempt.completed) break;
    if (attempt.stalledPage !== undefined) {
      failedPages.push(attempt.stalledPage);
      // 卡住的那一頁與它之前的頁都處理過了，從它的下一頁接著跑。
      remaining = remaining.slice(remaining.indexOf(attempt.stalledPage) + 1);
      continue;
    }
    throw new Error(attempt.error ?? "PDF_RENDER_WORKER_FAILED");
  }
  return { produced, failedPages: [...new Set(failedPages)].sort((left, right) => left - right) };
}

/**
 * 選頁網格用的縮圖。render 不出來的頁只記在 `failedPages`，不列進網格。
 */
export async function renderDeckPreviews(
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  limits: DeckRenderLimits = {},
): Promise<DeckPreviewResult> {
  const { produced, failedPages } = await renderInWorkers<{
    pageNumber: number;
    dataUrl: string;
  }>("previews", bytes, pageNumbers, limits);
  return { previews: produced, failedPages };
}

/**
 * 匯入用：把選中的頁 render 成 1920×1080 PNG，同時抽出標題與全頁文字。
 * 單頁失敗（含逾時）只跳過該頁並記錄頁碼，整批照跑完；總時限到則中止整批。
 *
 * `options.textLayer` 會一併抽出每頁的可編輯文字層（匯入流程用）。掃描頁沒有原生
 * 文字，那一頁就只有原圖；其他原因失敗的頁會帶 `textLayerError`。
 */
export async function renderDeckPages(
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  limits: DeckRenderLimits = {},
  options: { textLayer?: boolean } = {},
): Promise<DeckRenderResult> {
  const { produced, failedPages } = await renderInWorkers<RenderedDeckSource>(
    options.textLayer ? "pages-with-text" : "pages",
    bytes,
    pageNumbers,
    limits,
  );
  // 跨頁重複的頁首／頁尾要收齊所有頁才比對得出來，所以標題留到這裡才算。
  return { pages: describeRenderedPages(produced), failedPages };
}

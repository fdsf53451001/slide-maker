import { parentPort, workerData } from "node:worker_threads";
import {
  renderDeckPagesInThread,
  renderDeckPreviewsInThread,
  type DeckRenderLimits,
  type RenderedDeckSource,
} from "./pdf-deck-render.js";
import { extractPdfTextLayer } from "./pdf-text-layer.js";

/**
 * PDF 匯入 render 的 worker 執行緒進入點。
 *
 * 150 頁 1920×1080 的光柵化會連續霸佔 event loop 好幾分鐘，跑在主執行緒上等於
 * 整台 server 在匯入期間沒反應。把整批 render 搬進 worker 之後，主執行緒只剩
 * 等待與看門狗計時器。
 *
 * 每一頁都即時回報（`start` → `page`／`failed-page`），而不是整批做完才回一次。
 * 這是單頁時限能真正生效的前提：pdf.js 在 Node 上是用 microtask 串接 render
 * chunk 的，worker 自己的 `setTimeout` 在光柵化期間根本輪不到，只有主執行緒
 * 看得出「這一頁卡住了」。逐頁回報讓主執行緒可以砍掉 worker 而不丟掉已完成的頁。
 *
 * `pages-with-text` 把可編輯文字層的抽取也放進同一趟：那一步同樣是重的
 * （二次光柵化 + 全頁像素比對），留在主執行緒等於白搬一次家。
 */

export interface DeckWorkerRequest {
  kind: "pages" | "pages-with-text" | "previews";
  bytes: Uint8Array;
  pageNumbers: number[];
  limits: DeckRenderLimits;
}

export type DeckWorkerMessage =
  | { type: "start"; pageNumber: number }
  | { type: "page"; value: RenderedDeckSource | { pageNumber: number; dataUrl: string } }
  | { type: "failed-page"; pageNumber: number }
  | { type: "done" }
  | { type: "error"; error: string };

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("PDF_RENDER_WORKER_FAILED");
  const { request } = workerData as { request: DeckWorkerRequest };
  const post = (message: DeckWorkerMessage) => port.postMessage(message);
  const sink = {
    onPageStart: (pageNumber: number) => post({ type: "start", pageNumber }),
    onPage: (value: RenderedDeckSource | { pageNumber: number; dataUrl: string }) =>
      post({ type: "page", value }),
    onPageFailed: (pageNumber: number) => post({ type: "failed-page", pageNumber }),
  };
  try {
    if (request.kind === "previews")
      await renderDeckPreviewsInThread(request.bytes, request.pageNumbers, request.limits, sink);
    else
      await renderDeckPagesInThread(
        request.bytes,
        request.pageNumbers,
        request.limits,
        sink,
        request.kind === "pages-with-text" ? extractPdfTextLayer : undefined,
      );
    post({ type: "done" });
  } catch (error) {
    // 管線自己的具名錯誤（`PDF_IMPORT_TIMEOUT` 等）原樣送回去，錯誤碼不因為換執行緒走樣。
    post({ type: "error", error: error instanceof Error ? error.message : "PDF_RENDER_FAILED" });
  }
}

await main();

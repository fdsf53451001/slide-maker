import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import sharp from "sharp";
import type { EditableTextBox } from "@slide-maker/core";
import {
  extractTitle,
  mergeFragmentsIntoLines,
  mergeLinesIntoBlocks,
  orderBlocksForReading,
  pageContent,
  repeatedBlockKeys,
  type PdfTextBlock,
  type PdfTextFragment,
} from "./pdf-text.js";

/**
 * 「把 PDF 匯入成簡報專案」的光柵化管線（實際做事的一層）。
 *
 * 這個模組裡的 render 函式會長時間霸佔所在執行緒的 event loop，所以整批 render
 * 由 `pdf-deck.ts` 丟進 worker thread 執行（見 `pdf-deck-worker.ts`）；
 * 這裡只負責「在當前執行緒上把事情做完」，不管跑在哪一條執行緒上。
 *
 * 刻意不共用 `pdf-pages.ts`：那條是為風格參考圖設計的 1024px 縮圖、上限 24 頁、
 * 無狀態回 data URL，三個參數對本功能全都不對。本管線是 1920×1080、上限 150 頁、
 * 由呼叫端落地存檔，且補上 `pdf-pages.ts` 沒有的單頁／總時限。
 */

export const MAX_DECK_PDF_BYTES = 100 * 1024 * 1024;
/** 一次匯入最多幾頁；超過的頁在選檔階段就不列入。 */
export const MAX_DECK_PAGES = 150;
/** 只收 16:9：長寬比落在這個區間（含）才視為簡報頁。 */
export const DECK_ASPECT_MIN = 1.7;
export const DECK_ASPECT_MAX = 1.82;
export const DECK_PAGE_WIDTH = 1920;
export const DECK_PAGE_HEIGHT = 1080;
/** 選頁網格用的縮圖寬度：夠看清版面，150 張加起來仍在單次回應可接受的範圍。 */
const PREVIEW_WIDTH = 420;

export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60_000;

export interface DeckRenderLimits {
  /** 單頁 render 時限；逾時的頁視為失敗並跳過。 */
  pageTimeoutMs?: number;
  /** 整批 render 總時限；逾時直接中止匯入。 */
  totalTimeoutMs?: number;
}

export interface DeckPageInfo {
  pageNumber: number;
  /** PDF 使用者單位下的頁面尺寸（已套用頁面旋轉）。 */
  width: number;
  height: number;
  aspect: number;
  accepted: boolean;
}

export interface DeckInspection {
  totalPages: number;
  /** 只包含前 `MAX_DECK_PAGES` 頁。 */
  pages: DeckPageInfo[];
  acceptedPages: number[];
  /** 比例不符第一頁而被略過的頁碼（在選檔階段就列出）。 */
  skippedPages: number[];
  truncated: boolean;
}

/** 一頁的可編輯文字層原料：抹掉文字的背景 PNG + 對位好的文字框。 */
export interface PageTextLayer {
  /** 畫布尺寸、已濾掉文字的背景 PNG。 */
  background: Uint8Array;
  boxes: EditableTextBox[];
}

/**
 * 抽取單頁文字層的實作，由呼叫端注入（`pdf-text-layer.ts`）。
 *
 * 用注入而不是直接 import，是為了讓這一層只管光柵化：文字層需要的顏色反推、
 * 字型近似、行框幾何都留在 `pdf-text-layer.ts`，兩個模組不互相 import。
 */
export type DeckTextLayerExtractor = (
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: { width: number; height: number },
  originalPng: Uint8Array,
  limits: DeckRenderLimits,
) => Promise<PageTextLayer>;

export interface RenderedDeckPage {
  pageNumber: number;
  png: Uint8Array;
  /** 純幾何抽出的標題；抽不到就是空字串。 */
  title: string;
  /** 全頁文字，依版面閱讀順序。 */
  content: string;
  /** 可編輯文字層；掃描頁（無原生文字）與抽取失敗的頁沒有這一項。 */
  textLayer?: PageTextLayer;
  /**
   * 文字層抽取以非預期的原因失敗時的具名錯誤碼。
   * 掃描頁沒有原生文字是正常結果，不算失敗，這裡會是 undefined。
   */
  textLayerError?: string;
}

export interface DeckRenderResult {
  pages: RenderedDeckPage[];
  /** render 失敗（含單頁逾時）而跳過的頁碼。 */
  failedPages: number[];
}

export interface DeckPreviewResult {
  previews: { pageNumber: number; dataUrl: string }[];
  failedPages: number[];
}

/** 一頁 render 完的原料：PNG 與版面整理過的文字塊。標題／內文由呼叫端算。 */
export interface RenderedDeckSource {
  pageNumber: number;
  png: Uint8Array;
  blocks: PdfTextBlock[];
  textLayer?: PageTextLayer;
  textLayerError?: string;
}

/**
 * 逐頁回報用的掛勾。
 *
 * 跑在 worker 裡時，這些事件會即時送回主執行緒：主執行緒才能在某一頁卡太久時
 * 認出是哪一頁、把 worker 砍掉，同時保住這一頁之前已經完成的成果。
 */
export interface DeckRenderSink<T> {
  onPageStart?: (pageNumber: number) => void;
  /**
   * 給了這個掛勾就等於「呼叫端自己收頁」：本模組不再另外累積一份完成的頁，
   * 回傳值裡的 `pages`／`previews` 會是空陣列。150 頁的 1920×1080 PNG 加上
   * 抹字背景約 80MB，worker 模式下那份副本從頭到尾沒有人讀（`pdf-deck-worker.ts`
   * 丟掉回傳值，主執行緒改用逐頁送回來的原料重算），純浪費記憶體。
   */
  onPage?: (page: T) => void;
  onPageFailed?: (pageNumber: number) => void;
}

const require_ = createRequire(import.meta.url);
const pdfjsRoot = dirname(require_.resolve("pdfjs-dist/package.json"));

interface CanvasAndContext {
  canvas: { toBuffer(mimeType: string): Buffer; width: number; height: number };
  context: unknown;
}
interface NodeCanvasFactory {
  create(width: number, height: number, enableHWA?: boolean): CanvasAndContext;
  destroy(canvasAndContext: CanvasAndContext): void;
}

export function assertDeckPdf(bytes: Uint8Array): void {
  if (!bytes.length || bytes.length > MAX_DECK_PDF_BYTES) throw new Error("PDF_SIZE_INVALID");
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-")))
    throw new Error("PDF_INVALID");
}

/** 開啟 PDF；加密／損壞一律回具名錯誤，不外洩 pdf.js 內部訊息。 */
export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  assertDeckPdf(bytes);
  try {
    return await pdfjs.getDocument({
      // pdf.js 會接管 buffer，複製一份避免呼叫端的 bytes 被 detach。
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      standardFontDataUrl: join(pdfjsRoot, `standard_fonts${sep}`),
      cMapUrl: join(pdfjsRoot, `cmaps${sep}`),
      cMapPacked: true,
    }).promise;
  } catch {
    throw new Error("PDF_RENDER_FAILED");
  }
}

/** 逐頁取尺寸（不 render，成本近乎零），依第一頁比例決定哪些頁可收。 */
export async function inspectPdfDeck(bytes: Uint8Array): Promise<DeckInspection> {
  const document = await loadPdfDocument(bytes);
  try {
    const totalPages = document.numPages;
    if (!totalPages) throw new Error("PDF_EMPTY");
    const limit = Math.min(totalPages, MAX_DECK_PAGES);
    const pages: DeckPageInfo[] = [];
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        aspect: viewport.height > 0 ? viewport.width / viewport.height : 0,
        accepted: false,
      });
      page.cleanup();
    }
    const first = pages[0];
    if (!first) throw new Error("PDF_EMPTY");
    if (first.aspect < DECK_ASPECT_MIN || first.aspect > DECK_ASPECT_MAX)
      throw new Error("PDF_ASPECT_UNSUPPORTED");
    // 混比例 PDF 以第一頁為準：容忍 ±2% 的匯出誤差，其餘略過。
    for (const page of pages)
      page.accepted =
        Math.abs(page.aspect - first.aspect) <= first.aspect * 0.02 &&
        page.aspect >= DECK_ASPECT_MIN &&
        page.aspect <= DECK_ASPECT_MAX;
    return {
      totalPages,
      pages,
      acceptedPages: pages.filter((page) => page.accepted).map((page) => page.pageNumber),
      skippedPages: pages.filter((page) => !page.accepted).map((page) => page.pageNumber),
      truncated: totalPages > limit,
    };
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

export class DeadlineError extends Error {
  constructor() {
    super("PDF_IMPORT_TIMEOUT");
  }
}

function deadlineAt(totalTimeoutMs: number): () => void {
  const expiresAt = Date.now() + totalTimeoutMs;
  return () => {
    if (Date.now() > expiresAt) throw new DeadlineError();
  };
}

/** 跑 render 並套用單頁時限；逾時會 cancel render task，讓 pdf.js 立刻釋放資源。 */
export async function renderPageToPng(
  document: PDFDocumentProxy,
  page: PDFPageProxy,
  target: { width: number; height: number },
  timeoutMs: number,
  stripText = false,
): Promise<Uint8Array> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: target.width / base.width });
  const factory = document.canvasFactory as unknown as NodeCanvasFactory;
  let canvasAndContext: CanvasAndContext | undefined;
  let restoreOperators: (() => boolean) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    // create 必須在 try 之內：`stripTextOperators` 掛不上時會 throw，canvas 仍要回收。
    canvasAndContext = factory.create(
      Math.max(1, Math.round(viewport.width)),
      Math.max(1, Math.round(viewport.height)),
    );
    restoreOperators = stripText ? stripTextOperators(page) : undefined;
    const task = page.render({
      canvas: canvasAndContext.canvas as unknown as HTMLCanvasElement,
      viewport,
      background: "#ffffff",
    });
    await Promise.race([
      task.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          task.cancel();
          reject(new Error("PDF_PAGE_RENDER_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
    // 掛點存在不代表被用到：pdf.js 只在 `!intentState.displayReadyCapability` 時才
    // `_pumpOperatorList`，同一個 page proxy 第二次 display render 會重用快取的
    // operator list，完全繞過過濾器。那種情況下畫出來的「背景」還帶著文字，
    // 靜默降級比失敗更糟，所以這裡明確 throw。
    if (stripText && !restoreOperators!()) throw new Error("PDF_TEXT_LAYER_UNSUPPORTED");
    const raster = canvasAndContext.canvas.toBuffer("image/png");
    // 頁面比例在 1.70–1.82 之間，統一拉滿到畫布尺寸；文字層幾何也套同一組縮放。
    return new Uint8Array(
      await sharp(raster).resize(target.width, target.height, { fit: "fill" }).png().toBuffer(),
    );
  } finally {
    if (timer) clearTimeout(timer);
    // 還原是冪等的：成功路徑上面已經還原過一次，這裡是失敗路徑的保險。
    restoreOperators?.();
    if (canvasAndContext) factory.destroy(canvasAndContext);
  }
}

/**
 * pdf.js 的 evaluator 實務上只會 emit `showText` 與 `showSpacedText`
 * （`'`、`"` 這兩個 PDF 運算子會先被拆成 nextLine + showText 再送出），
 * 但 `nextLineShowText` / `nextLineSetSpacingShowText` 仍列在這裡：
 * 它們是 pdf.js 公開的 OPS 常數，漏掉任何一個都代表背景圖上會殘留文字，
 * 而多列幾個的成本是零。
 */
const TEXT_SHOWING_OPS = new Set<number>([
  pdfjs.OPS.showText,
  pdfjs.OPS.showSpacedText,
  pdfjs.OPS.nextLineShowText,
  pdfjs.OPS.nextLineSetSpacingShowText,
]);

interface OperatorChunk {
  fnArray: number[];
  argsArray: unknown[];
  length: number;
}

/**
 * 「抹字背景」的作法：在 operator list 送進 canvas 繪製器之前濾掉文字繪製指令，
 * 得到真正沒有文字的底圖。全程零模型，不是 inpaint、不燒生圖配額。
 *
 * `_renderPageChunk` 是 pdf.js 的內部掛點（版本已在 package.json 鎖定）。
 * 掛不上時直接 throw，讓呼叫端明確失敗，而不是安靜地回一張還有文字的圖。
 * 回傳還原函式：還原之後回報「過濾器到底有沒有被呼叫到」，呼叫端據此判斷這次
 * render 是不是真的走過過濾（見 `renderPageToPng`）。同一個 page 之後若要讀
 * operator list（取文字顏色），也必須先還原，否則連 `getOperatorList()`
 * 都會拿到被濾掉文字的版本。
 */
export function stripTextOperators(page: PDFPageProxy): () => boolean {
  const internals = page as unknown as {
    _renderPageChunk?: (chunk: OperatorChunk, intentState: unknown) => void;
  };
  const original = internals._renderPageChunk;
  if (typeof original !== "function") throw new Error("PDF_TEXT_LAYER_UNSUPPORTED");
  let invoked = false;
  internals._renderPageChunk = (chunk, intentState) => {
    invoked = true;
    const fnArray: number[] = [];
    const argsArray: unknown[] = [];
    for (let index = 0; index < chunk.length; index += 1) {
      const fn = chunk.fnArray[index];
      if (fn === undefined || TEXT_SHOWING_OPS.has(fn)) continue;
      fnArray.push(fn);
      argsArray.push(chunk.argsArray[index]);
    }
    original.call(page, { ...chunk, fnArray, argsArray, length: fnArray.length }, intentState);
  };
  return () => {
    internals._renderPageChunk = original;
    return invoked;
  };
}

export interface PageTextContent {
  fragments: PdfTextFragment[];
  /** pdf.js 的字型樣式表（key 為 fragment 的 fontName）。 */
  styles: Record<string, { fontFamily?: string }>;
}

/** pdf.js 的 text item 轉成裝置座標片段（y 向下）。 */
export async function pageTextFragments(
  page: PDFPageProxy,
  viewport: PageViewport,
): Promise<PageTextContent> {
  const content = await page.getTextContent();
  const fragments: PdfTextFragment[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    if (!item.str.trim()) continue;
    const transform = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
    const scaleX = Math.hypot(transform[0] ?? 0, transform[1] ?? 0);
    const scaleY = Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
    const fontSize = scaleY || scaleX;
    if (!fontSize) continue;
    fragments.push({
      text: item.str,
      x: transform[4] ?? 0,
      baseline: transform[5] ?? 0,
      // item.width 是 PDF 使用者單位，只需再乘上 viewport 縮放。
      width: item.width * viewport.scale,
      fontSize,
      fontName: item.fontName,
    });
  }
  return { fragments, styles: content.styles as Record<string, { fontFamily?: string }> };
}

/** 一頁的文字塊（依閱讀順序）。 */
async function pageBlocks(page: PDFPageProxy, viewport: PageViewport): Promise<PdfTextBlock[]> {
  const { fragments } = await pageTextFragments(page, viewport);
  const blocks = mergeLinesIntoBlocks(mergeFragmentsIntoLines(fragments));
  return orderBlocksForReading(blocks, viewport.width);
}

/**
 * 選頁網格用的縮圖。與匯入 render 分開：這裡只求看得出版面，解析度刻意壓低。
 * render 不出來的頁只記在 `failedPages`，不列進網格。
 *
 * 給了 `sink.onPage` 時 `previews` 會是空的——見 `DeckRenderSink.onPage`。
 */
export async function renderDeckPreviewsInThread(
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  limits: DeckRenderLimits = {},
  sink: DeckRenderSink<{ pageNumber: number; dataUrl: string }> = {},
): Promise<DeckPreviewResult> {
  const pageTimeoutMs = limits.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const checkDeadline = deadlineAt(limits.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const document = await loadPdfDocument(bytes);
  const previews: { pageNumber: number; dataUrl: string }[] = [];
  const failedPages: number[] = [];
  try {
    for (const pageNumber of pageNumbers.slice(0, MAX_DECK_PAGES)) {
      checkDeadline();
      let page: PDFPageProxy | undefined;
      try {
        sink.onPageStart?.(pageNumber);
        page = await document.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const height = Math.round((PREVIEW_WIDTH * base.height) / base.width);
        const png = await renderPageToPng(
          document,
          page,
          { width: PREVIEW_WIDTH, height },
          pageTimeoutMs,
        );
        const preview = {
          pageNumber,
          dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        };
        if (sink.onPage) sink.onPage(preview);
        else previews.push(preview);
      } catch (error) {
        if (error instanceof DeadlineError) throw error;
        failedPages.push(pageNumber);
        sink.onPageFailed?.(pageNumber);
      } finally {
        page?.cleanup();
      }
    }
    return { previews, failedPages };
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

/**
 * 匯入用：把選中的頁 render 成 1920×1080 PNG，同時抽出標題與全頁文字。
 * 單頁失敗（含逾時）只跳過該頁並記錄頁碼，整批照跑完；總時限到則中止整批。
 *
 * 給了 `extractTextLayer` 就順便抽出每頁的可編輯文字層。文字層在**另一個
 * document handle** 上抽：抹字背景靠攔截 pdf.js 送進 canvas 的 operator list，
 * 而同一個 page proxy 第二次 display render 會重用快取的 operator list、繞過
 * 攔截器（見 `pdf-text-layer.ts`）。多開一次 document 的成本是整批一次的 parse。
 *
 * 給了 `sink.onPage` 時 `pages` 會是空的——見 `DeckRenderSink.onPage`。
 */
export async function renderDeckPagesInThread(
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  limits: DeckRenderLimits = {},
  sink: DeckRenderSink<RenderedDeckSource> = {},
  extractTextLayer?: DeckTextLayerExtractor,
): Promise<DeckRenderResult> {
  const pageTimeoutMs = limits.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const canvas = { width: DECK_PAGE_WIDTH, height: DECK_PAGE_HEIGHT };
  const checkDeadline = deadlineAt(limits.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const document = await loadPdfDocument(bytes);
  const textDocument = extractTextLayer ? await loadPdfDocument(bytes) : undefined;
  const rendered: RenderedDeckSource[] = [];
  const failedPages: number[] = [];
  try {
    for (const pageNumber of pageNumbers.slice(0, MAX_DECK_PAGES)) {
      checkDeadline();
      let page: PDFPageProxy | undefined;
      try {
        sink.onPageStart?.(pageNumber);
        page = await document.getPage(pageNumber);
        const png = await renderPageToPng(document, page, canvas, pageTimeoutMs);
        const blocks = await pageBlocks(page, deckViewport(page));
        const source: RenderedDeckSource = { pageNumber, png, blocks };
        if (extractTextLayer && textDocument) {
          try {
            source.textLayer = await extractTextLayer(textDocument, pageNumber, canvas, png, {
              pageTimeoutMs,
            });
          } catch (error) {
            // 文字層抽不出來只代表這一頁沒有「可編輯文字」版本，原圖版本照建——
            // 為了一個附加版本把整頁丟掉才是壞的取捨。掃描頁沒有原生文字是正常
            // 結果，其餘原因記下錯誤碼讓呼叫端列出來，不靜默吞掉。
            const code = error instanceof Error ? error.message : "PDF_TEXT_LAYER_FAILED";
            if (code !== "PDF_TEXT_LAYER_EMPTY") source.textLayerError = code;
          }
        }
        if (sink.onPage) sink.onPage(source);
        else rendered.push(source);
      } catch (error) {
        if (error instanceof DeadlineError) throw error;
        failedPages.push(pageNumber);
        sink.onPageFailed?.(pageNumber);
      } finally {
        page?.cleanup();
      }
    }
    return { pages: describeRenderedPages(rendered), failedPages };
  } finally {
    await Promise.all([
      document.destroy().catch(() => undefined),
      textDocument?.destroy().catch(() => undefined),
    ]);
  }
}

/**
 * 把 render 出來的原料轉成 slide 用的標題與內文。
 *
 * 跨頁重複的頁首／頁尾要拿整批頁面一起比對才認得出來，所以這一步必須在所有頁都
 * 收齊之後才做——worker 中途被重啟時，主執行緒會拿累積下來的完整清單再算一次。
 */
export function describeRenderedPages(rendered: readonly RenderedDeckSource[]): RenderedDeckPage[] {
  const repeated = repeatedBlockKeys(rendered.map((page) => page.blocks));
  return rendered.map((page) => ({
    pageNumber: page.pageNumber,
    png: page.png,
    title: extractTitle(page.blocks, repeated),
    content: pageContent(page.blocks),
    // `exactOptionalPropertyTypes`：沒有文字層時整個欄位不存在，不是顯式 undefined。
    ...(page.textLayer ? { textLayer: page.textLayer } : {}),
    ...(page.textLayerError ? { textLayerError: page.textLayerError } : {}),
  }));
}

/**
 * 匯入後的畫布座標系：等比縮放到 1920 寬（高度因此落在 1055–1129 之間，
 * 視原始頁面比例而定）。最後那一步「把高度拉滿到 1080」是 `renderPageToPng`
 * 的 `fit: "fill"` 做的，文字層幾何則在 `pdf-text-layer.ts` 用 `scaleY` 補上，
 * 兩邊才對得起來。
 */
export function deckViewport(page: PDFPageProxy): PageViewport {
  const base = page.getViewport({ scale: 1 });
  return page.getViewport({ scale: DECK_PAGE_WIDTH / base.width });
}

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  DECK_PAGE_HEIGHT,
  DECK_PAGE_WIDTH,
  MAX_DECK_PAGES,
  inspectPdfDeck,
  renderDeckPages,
  renderDeckPreviews,
} from "../src/pdf-deck.js";
import { renderDeckPagesInThread } from "../src/pdf-deck-render.js";
import { extractPdfTextLayer } from "../src/pdf-text-layer.js";

interface TestPage {
  size?: [number, number];
  title?: { text: string; size: number };
  body?: string[];
  header?: string;
  /**
   * 額外疊多少層整頁的半透明方塊，用來做出「render 慢到會撞單頁時限」的頁。
   * 每一層都要對整張 1920×1080 畫布做 alpha 混合，所以成本隨層數線性成長，
   * 但寫進 PDF 的內容串流很小（4000 層 ≈ 94KB、建檔約 100ms）。
   */
  heavy?: number;
}

async function makeDeck(pages: readonly TestPage[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const page of pages) {
    const [width, height] = page.size ?? [960, 540];
    const sheet = document.addPage([width, height]);
    sheet.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    if (page.header)
      sheet.drawText(page.header, {
        x: 30,
        y: height - 30,
        size: 10,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    if (page.title)
      sheet.drawText(page.title.text, {
        x: 40,
        y: height - 110,
        size: page.title.size,
        font,
        color: rgb(0.05, 0.1, 0.4),
      });
    for (let index = 0; index < (page.heavy ?? 0); index += 1) {
      sheet.drawRectangle({
        x: -10,
        y: -10,
        width: width + 20,
        height: height + 20,
        color: rgb((index % 255) / 255, ((index * 3) % 255) / 255, ((index * 7) % 255) / 255),
        opacity: 0.5,
      });
    }
    (page.body ?? []).forEach((line, index) => {
      sheet.drawText(line, {
        x: 40,
        y: height - 200 - index * 30,
        size: 16,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    });
  }
  return document.save();
}

describe("inspectPdfDeck", () => {
  it("accepts every 16:9 page without rendering", async () => {
    const inspection = await inspectPdfDeck(await makeDeck([{}, {}, {}]));
    expect(inspection.totalPages).toBe(3);
    expect(inspection.acceptedPages).toEqual([1, 2, 3]);
    expect(inspection.skippedPages).toEqual([]);
    expect(inspection.truncated).toBe(false);
    expect(inspection.pages[0]?.aspect).toBeCloseTo(16 / 9, 2);
  });

  it("keeps the first page as the reference ratio and lists the pages it skips", async () => {
    const inspection = await inspectPdfDeck(
      await makeDeck([{}, { size: [800, 600] }, {}, { size: [595, 842] }]),
    );
    expect(inspection.acceptedPages).toEqual([1, 3]);
    expect(inspection.skippedPages).toEqual([2, 4]);
  });

  it("rejects a deck whose first page is not 16:9", async () => {
    await expect(inspectPdfDeck(await makeDeck([{ size: [800, 600] }, {}]))).rejects.toThrow(
      "PDF_ASPECT_UNSUPPORTED",
    );
  });

  it("caps the page list at MAX_DECK_PAGES and flags truncation", async () => {
    const inspection = await inspectPdfDeck(
      await makeDeck(Array.from({ length: MAX_DECK_PAGES + 2 }, () => ({}))),
    );
    expect(inspection.totalPages).toBe(MAX_DECK_PAGES + 2);
    expect(inspection.pages).toHaveLength(MAX_DECK_PAGES);
    expect(inspection.truncated).toBe(true);
  }, 60_000);

  it("rejects empty, non-PDF and corrupt input", async () => {
    await expect(inspectPdfDeck(new Uint8Array())).rejects.toThrow("PDF_SIZE_INVALID");
    await expect(inspectPdfDeck(new TextEncoder().encode("not a pdf"))).rejects.toThrow(
      "PDF_INVALID",
    );
    await expect(
      inspectPdfDeck(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00])),
    ).rejects.toThrow("PDF_RENDER_FAILED");
  });
});

describe("renderDeckPages", () => {
  it("renders selected pages at the 1920×1080 canvas size", async () => {
    const deck = await makeDeck([
      { title: { text: "Cover", size: 44 }, body: ["intro line"] },
      { title: { text: "Skipped", size: 44 } },
      { title: { text: "Third", size: 44 }, body: ["detail"] },
    ]);
    const result = await renderDeckPages(deck, [1, 3]);
    expect(result.failedPages).toEqual([]);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 3]);
    for (const page of result.pages) {
      const metadata = await sharp(page.png).metadata();
      expect(metadata.width).toBe(DECK_PAGE_WIDTH);
      expect(metadata.height).toBe(DECK_PAGE_HEIGHT);
      expect(metadata.format).toBe("png");
    }
  }, 30_000);

  it("puts the extracted heading in title and the whole page in content", async () => {
    const deck = await makeDeck([
      { title: { text: "Quarterly Review", size: 44 }, body: ["Revenue up 24%", "Costs down 8%"] },
    ]);
    const [page] = (await renderDeckPages(deck, [1])).pages;
    expect(page?.title).toBe("Quarterly Review");
    expect(page?.content).toContain("Quarterly Review");
    expect(page?.content).toContain("Revenue up 24%");
    expect(page?.content).toContain("Costs down 8%");
  }, 30_000);

  it("drops a header repeated across pages from the extracted title", async () => {
    const deck = await makeDeck([
      { header: "ACME CONFIDENTIAL", title: { text: "First", size: 44 }, body: ["a"] },
      { header: "ACME CONFIDENTIAL", title: { text: "Second", size: 44 }, body: ["b"] },
      { header: "ACME CONFIDENTIAL", title: { text: "Third", size: 44 }, body: ["c"] },
    ]);
    const result = await renderDeckPages(deck, [1, 2, 3]);
    expect(result.pages.map((page) => page.title)).toEqual(["First", "Second", "Third"]);
  }, 45_000);

  it("leaves the title empty when the page has no dominant font size", async () => {
    const deck = await makeDeck([{ body: ["bullet one", "bullet two", "bullet three"] }]);
    const [page] = (await renderDeckPages(deck, [1])).pages;
    expect(page?.title).toBe("");
    expect(page?.content).toContain("bullet one");
  }, 30_000);

  it("aborts the whole import when the total time limit is exhausted", async () => {
    const deck = await makeDeck([{}, {}]);
    await expect(renderDeckPages(deck, [1, 2], { totalTimeoutMs: -1 })).rejects.toThrow(
      "PDF_IMPORT_TIMEOUT",
    );
  });

  /**
   * 時限要落在兩頁的 render 成本之間，而且兩邊都留足夠的餘裕，否則測試會在
   * 忙碌的機器上隨機翻紅（400ms 的門檻：慢頁量到 ≈3000ms、快頁 ≈35ms）。
   * 斷言用「包含」而不是精確相等，慢頁真的偶爾擠進門檻時也不會誤判成回歸。
   */
  it("skips a page that exceeds the per-page time limit and keeps going", async () => {
    const deck = await makeDeck([
      { title: { text: "Slow", size: 44 }, heavy: 4_000 },
      { title: { text: "Fast", size: 44 } },
    ]);
    const result = await renderDeckPages(deck, [1, 2], { pageTimeoutMs: 400 });
    expect(result.failedPages).toContain(1);
    expect(result.pages.map((page) => page.pageNumber)).toContain(2);
    // 逾時的頁不建 slide，但整批照跑完。
    expect(result.pages.map((page) => page.pageNumber)).not.toContain(1);
  }, 60_000);
});

describe("main thread responsiveness", () => {
  /**
   * 整批匯入跑在 worker 執行緒上，主執行緒在匯入期間必須照常服務其他請求。
   *
   * 量的是 event loop 延遲：每 10ms 排一次計時器，記錄實際間隔的最大值。
   * render 留在主執行緒時，每一頁的光柵化都是一大塊同步工作，這個最大值會直接
   * 跳到「一頁的 render 時間」等級（實測單頁重版面 ≈3 秒）；搬進 worker 之後
   * 主執行緒只剩等待，延遲維持在數十毫秒。
   *
   * 這裡刻意開 `textLayer`：匯入走的就是這條路，而抽文字層本身又是一次完整的
   * 光柵化加上全頁像素比對（實測約 450ms/頁）。這一步要是留在主執行緒上，
   * 匯入期間整台 server 一樣沒反應，所以量測必須涵蓋它。
   */
  it("keeps the event loop free while a heavy deck renders with its text layers", async () => {
    const deck = await makeDeck(
      Array.from({ length: 6 }, (_, index) => ({
        title: { text: `Page ${index + 1}`, size: 44 },
        body: ["first line", "second line"],
        heavy: 1_500,
      })),
    );
    let ticks = 0;
    let worstLagMs = 0;
    let last = Date.now();
    let polling = true;
    const poll = () => {
      if (!polling) return;
      const now = Date.now();
      worstLagMs = Math.max(worstLagMs, now - last - 10);
      last = now;
      ticks += 1;
      setTimeout(poll, 10);
    };
    setTimeout(poll, 10);
    const started = Date.now();
    const result = await renderDeckPages(deck, [1, 2, 3, 4, 5, 6], {}, { textLayer: true });
    const elapsed = Date.now() - started;
    polling = false;

    expect(result.pages).toHaveLength(6);
    // 文字層階段真的跑過了，否則這個量測涵蓋不到它。
    for (const page of result.pages) expect(page.textLayer?.boxes.length).toBeGreaterThan(0);
    // 這批頁面要真的夠重，否則「主執行緒沒被卡住」證明不了什麼。
    expect(elapsed).toBeGreaterThan(2_000);
    expect(ticks).toBeGreaterThan(50);
    expect(worstLagMs).toBeLessThan(500);
  }, 180_000);
});

describe("renderDeckPages with text layers", () => {
  /**
   * 抹字背景靠攔截 pdf.js 送進 canvas 的 operator list，而同一個 page proxy 的
   * 第二次 display render 會重用快取的 operator list、整個繞過攔截器。匯入流程
   * 一定會先把原圖 render 過一次，所以文字層必須在另一個 document handle 上抽。
   * 這條測試守的就是那個安排：一旦兩邊共用 handle，背景會帶著文字（或直接
   * 拋 `PDF_TEXT_LAYER_UNSUPPORTED`），兩種情況都會在這裡翻紅。
   */
  it("strips text from the background even though the page was already rendered", async () => {
    const deck = await makeDeck([
      { title: { text: "Quarterly Review", size: 44 }, body: ["Revenue up 24%"] },
    ]);
    const [page] = (await renderDeckPages(deck, [1], {}, { textLayer: true })).pages;
    expect(page?.textLayerError).toBeUndefined();
    expect(page?.textLayer?.boxes.map((box) => box.text)).toEqual([
      "Quarterly Review",
      "Revenue up 24%",
    ]);
    const [original, background] = await Promise.all(
      [page!.png, page!.textLayer!.background].map((png) =>
        sharp(png).removeAlpha().raw().toBuffer(),
      ),
    );
    let differing = 0;
    for (let index = 0; index < original!.length; index += 3)
      if (Math.abs((original![index] ?? 0) - (background![index] ?? 0)) > 24) differing += 1;
    expect(differing).toBeGreaterThan(2_000);
  }, 60_000);

  /**
   * 單頁看門狗只認得 `start`：抽文字層是這一頁的第二段重工作（自己的二次光柵化 +
   * 全頁像素比對），不重報一次開工的話，兩段的耗時會一起算進同一個單頁預算，
   * worker 會在還正常做事的時候被主執行緒砍掉。
   */
  it("reports the text-layer step as its own start so the page watchdog is re-armed", async () => {
    const deck = await makeDeck([{ title: { text: "Quarterly Review", size: 44 } }]);
    const runWith = async (extractor?: typeof extractPdfTextLayer) => {
      const started: number[] = [];
      const sink = { onPageStart: (pageNumber: number) => void started.push(pageNumber) };
      const result = await renderDeckPagesInThread(deck, [1], {}, sink, extractor);
      return { started, page: result.pages[0] };
    };
    const withText = await runWith(extractPdfTextLayer);
    // 文字層那一步真的跑過了，否則這條測試量不到它有沒有重報開工。
    expect(withText.page?.textLayer?.boxes.length).toBeGreaterThan(0);
    expect(withText.started).toEqual([1, 1]);
    expect((await runWith()).started).toEqual([1]);
  }, 60_000);

  /** 掃描頁沒有原生文字：頁面照樣匯入，只是沒有文字層，而且不算失敗。 */
  it("returns a scanned page without a text layer and without an error code", async () => {
    const deck = await makeDeck([{}]);
    const [page] = (await renderDeckPages(deck, [1], {}, { textLayer: true })).pages;
    expect(page?.pageNumber).toBe(1);
    expect(page?.textLayer).toBeUndefined();
    expect(page?.textLayerError).toBeUndefined();
  }, 30_000);
});

describe("renderDeckPreviews", () => {
  it("returns one PNG data URL per requested page", async () => {
    const previews = await renderDeckPreviews(await makeDeck([{}, {}]), [1, 2]);
    expect(previews.failedPages).toEqual([]);
    expect(previews.previews.map((preview) => preview.pageNumber)).toEqual([1, 2]);
    for (const preview of previews.previews)
      expect(preview.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  }, 30_000);
});

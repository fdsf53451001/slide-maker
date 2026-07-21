import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  DECK_PAGE_HEIGHT,
  DECK_PAGE_WIDTH,
  DEFAULT_PAGE_TIMEOUT_MS,
  loadPdfDocument,
  renderDeckPages,
  renderPageToPng,
} from "../src/pdf-deck.js";
import {
  extractPdfTextLayer,
  fontFamilyFromName,
  fontWeightFromName,
} from "../src/pdf-text-layer.js";

const CANVAS = { width: DECK_PAGE_WIDTH, height: DECK_PAGE_HEIGHT };

/**
 * `extractPdfTextLayer` 收的是已開啟的 document（匯入時整批共用一個 handle），
 * 而且那個 handle 不能先 display render 過同一頁——否則 pdf.js 會重用快取的
 * operator list，抹字過濾器整個被繞過。測試在這裡各開各的，跟正式流程一樣。
 */
async function extractFromBytes(
  pdf: Uint8Array,
  pageNumber: number,
  originalPng: Uint8Array,
): Promise<Awaited<ReturnType<typeof extractPdfTextLayer>>> {
  const document = await loadPdfDocument(pdf);
  try {
    return await extractPdfTextLayer(document, pageNumber, CANVAS, originalPng);
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

/** 深藍色頁首橫幅上的白色標題 + 白底上的深色內文（兩種文字顏色）。 */
async function makeTwoColorSlide(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([960, 540]);
  page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 0, y: 400, width: 960, height: 140, color: rgb(0.1, 0.2, 0.6) });
  page.drawText("Quarterly Review", { x: 40, y: 445, size: 44, font, color: rgb(1, 1, 1) });
  page.drawText("Revenue up 24%", { x: 40, y: 300, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
  return document.save();
}

async function makeSingleColorSlide(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([960, 540]);
  page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
  page.drawText("Only Heading", { x: 40, y: 400, size: 40, font, color: rgb(0.8, 0.1, 0.1) });
  page.drawText("only body", { x: 40, y: 300, size: 20, font, color: rgb(0.8, 0.1, 0.1) });
  return document.save();
}

/** 粗體標題 + 一般內文 + 等寬 + 襯線：字重與字族都要分得出層次。 */
async function makeMixedFontSlide(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const [bold, regular, mono, serif] = await Promise.all([
    document.embedFont(StandardFonts.HelveticaBold),
    document.embedFont(StandardFonts.Helvetica),
    document.embedFont(StandardFonts.Courier),
    document.embedFont(StandardFonts.TimesRoman),
  ]);
  const page = document.addPage([960, 540]);
  page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
  const ink = rgb(0.1, 0.1, 0.1);
  page.drawText("Bold Heading", { x: 40, y: 440, size: 40, font: bold, color: ink });
  page.drawText("regular body", { x: 40, y: 360, size: 20, font: regular, color: ink });
  page.drawText("mono caption", { x: 40, y: 280, size: 20, font: mono, color: ink });
  page.drawText("serif caption", { x: 40, y: 200, size: 20, font: serif, color: ink });
  return document.save();
}

/**
 * 真實簡報上最常見的兩種「一行多種樣式」，都是使用者實測回報的缺陷來源：
 *
 *  - 講者列：大字粗體姓名 + 小字常規職稱，同一條基線，靠版面右緣。整行併成一段後
 *    小字被放大到姓名的字級，右緣直接衝出畫布。
 *  - 註標：本文中間空著一小塊給上標，上標本身是獨立的一段文字。整行併成一段後
 *    那塊空隙只剩一個空白字元，後半段左移撞上上標。
 */
async function makeMixedSizeLineSlide(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const [bold, regular] = await Promise.all([
    document.embedFont(StandardFonts.HelveticaBold),
    document.embedFont(StandardFonts.Helvetica),
  ]);
  const page = document.addPage([960, 540]);
  page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
  const ink = rgb(0.1, 0.1, 0.1);
  page.drawText("Chen", { x: 420, y: 400, size: 34, font: bold, color: ink });
  page.drawText("Senior Principal Engineer", {
    x: 508,
    y: 400,
    size: 17,
    font: regular,
    color: ink,
  });
  page.drawText("uses NLU", { x: 60, y: 240, size: 20, font: regular, color: ink });
  page.drawText("1", { x: 155, y: 250, size: 10, font: regular, color: ink });
  page.drawText("for intent", { x: 172, y: 240, size: 20, font: regular, color: ink });
  return document.save();
}

/** 掃描頁：只有圖形，沒有任何原生文字。 */
async function makeScannedSlide(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([960, 540]);
  page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(0.9, 0.9, 0.9) });
  page.drawRectangle({ x: 100, y: 100, width: 300, height: 200, color: rgb(0.2, 0.4, 0.8) });
  return document.save();
}

async function renderOriginal(pdf: Uint8Array): Promise<Uint8Array> {
  const [page] = (await renderDeckPages(pdf, [1])).pages;
  if (!page) throw new Error("test fixture failed to render");
  return page.png;
}

/** 單一像素的 RGB。 */
async function pixel(
  png: Uint8Array,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number }> {
  const { data } = await sharp(png)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0 };
}

/** 指定區域內的亮（近白）像素數。 */
async function brightPixels(
  png: Uint8Array,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const { data } = await sharp(png)
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < data.length; index += 3)
    if ((data[index] ?? 0) > 200 && (data[index + 1] ?? 0) > 200 && (data[index + 2] ?? 0) > 200)
      count += 1;
  return count;
}

/** 整張圖有多少像素與另一張不同——用來確認背景真的少了文字。 */
async function differingPixels(left: Uint8Array, right: Uint8Array): Promise<number> {
  const [a, b] = await Promise.all(
    [left, right].map((png) => sharp(png).removeAlpha().raw().toBuffer()),
  );
  let count = 0;
  for (let index = 0; index < a!.length; index += 3)
    if (Math.abs((a![index] ?? 0) - (b![index] ?? 0)) > 24) count += 1;
  return count;
}

describe("extractPdfTextLayer", () => {
  it("returns one box per native text line with matching text", async () => {
    const pdf = await makeTwoColorSlide();
    const layer = await extractFromBytes(pdf, 1, await renderOriginal(pdf));
    expect(layer.boxes.map((box) => box.text)).toEqual(["Quarterly Review", "Revenue up 24%"]);
    const title = layer.boxes[0]!;
    // 44pt 標題在 960→1920 的畫布上約 88px，且位置落在頁首橫幅內。
    expect(title.fontSize).toBeGreaterThan(70);
    expect(title.fontSize).toBeLessThan(100);
    expect(title.x).toBeGreaterThan(60);
    expect(title.x).toBeLessThan(100);
    expect(title.y).toBeGreaterThan(0);
    expect(title.y).toBeLessThan(200);
    expect(title.confidence).toBe(1);
    expect(title.role).toBe("presentation");
  }, 30_000);

  it("gives each style run on a line its own box instead of one over-sized box", async () => {
    const pdf = await makeMixedSizeLineSlide();
    const layer = await extractFromBytes(pdf, 1, await renderOriginal(pdf));
    const name = layer.boxes.find((box) => box.text === "Chen");
    const role = layer.boxes.find((box) => box.text.startsWith("Senior"));
    expect(name).toBeDefined();
    expect(role).toBeDefined();
    // 職稱保留自己的字級與字重，不會被姓名那一段拉大／加粗。
    expect(role!.fontSize).toBeLessThan(name!.fontSize * 0.75);
    expect(role!.fontWeight).toBeLessThan(name!.fontWeight);
    // 併成一段時整行用 34pt 畫會衝出畫布右緣；分開之後每一段都留在版面內。
    for (const box of layer.boxes) expect(box.x + box.width).toBeLessThanOrEqual(DECK_PAGE_WIDTH);
  }, 30_000);

  it("keeps the gap a superscript sits in instead of collapsing it to one space", async () => {
    const pdf = await makeMixedSizeLineSlide();
    const layer = await extractFromBytes(pdf, 1, await renderOriginal(pdf));
    const before = layer.boxes.find((box) => box.text === "uses NLU");
    const marker = layer.boxes.find((box) => box.text === "1" && box.fontSize < 30);
    const after = layer.boxes.find((box) => box.text === "for intent");
    expect(before).toBeDefined();
    expect(marker).toBeDefined();
    expect(after).toBeDefined();
    // 上標自己一框，本文的後半段從上標右邊重新起算——沒有任何一段吃到上標的位置。
    expect(marker!.x).toBeGreaterThanOrEqual(before!.x + before!.width);
    expect(after!.x).toBeGreaterThanOrEqual(marker!.x + marker!.width);
    expect(marker!.fontSize).toBeLessThan(after!.fontSize * 0.75);
  }, 30_000);

  it("renders a background with the text removed and everything else intact", async () => {
    const pdf = await makeTwoColorSlide();
    const original = await renderOriginal(pdf);
    const layer = await extractFromBytes(pdf, 1, original);
    const metadata = await sharp(layer.background).metadata();
    expect(metadata.width).toBe(DECK_PAGE_WIDTH);
    expect(metadata.height).toBe(DECK_PAGE_HEIGHT);
    // 頁首橫幅（非文字）必須留著。
    const banner = await pixel(layer.background, 1800, 60);
    expect(banner.b).toBeGreaterThan(banner.r);
    expect(banner.b).toBeGreaterThan(100);
    // 深藍橫幅裡的白色字墨：原圖有一大片亮像素，抹字背景一個都不該剩。
    const region = { left: 0, top: 0, width: DECK_PAGE_WIDTH, height: 260 };
    expect(await brightPixels(original, region)).toBeGreaterThan(500);
    expect(await brightPixels(layer.background, region)).toBe(0);
    expect(await differingPixels(original, layer.background)).toBeGreaterThan(2_000);
  }, 30_000);

  it("recovers per-line text colour instead of the schema default white", async () => {
    const pdf = await makeTwoColorSlide();
    const layer = await extractFromBytes(pdf, 1, await renderOriginal(pdf));
    const [title, body] = layer.boxes;
    expect(title?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(body?.color).toMatch(/^#[0-9a-f]{6}$/);
    // 深藍橫幅上的白字維持淺色，白底上的深色內文維持深色，且絕不能兩個都變成預設白。
    expect(Number.parseInt(title!.color.slice(1, 3), 16)).toBeGreaterThan(200);
    expect(Number.parseInt(body!.color.slice(1, 3), 16)).toBeLessThan(90);
    expect(body!.color).not.toBe("#ffffff");
  }, 30_000);

  it("takes the fill colour straight from the operator list when the page uses one colour", async () => {
    const pdf = await makeSingleColorSlide();
    const layer = await extractFromBytes(pdf, 1, await renderOriginal(pdf));
    expect(layer.boxes).toHaveLength(2);
    for (const box of layer.boxes) expect(box.color).toBe("#cc1a1a");
  }, 30_000);

  it("fails loudly on a scanned page instead of falling back to OCR", async () => {
    const pdf = await makeScannedSlide();
    await expect(extractFromBytes(pdf, 1, await renderOriginal(pdf))).rejects.toThrow(
      "PDF_TEXT_LAYER_EMPTY",
    );
  }, 30_000);

  // pdf-lib 的標準字型沒有內嵌，pdf.js 的旗標與 `fallbackName` 都填得出來——這一則
  // 守的是「加了名稱推斷之後，原本靠旗標的那條路仍然對」。名稱推斷本身另外直接測。
  it("keeps the weight hierarchy instead of flattening every line to 400", async () => {
    const pdf = await makeMixedFontSlide();
    const layer = await extractFromBytes(pdf, 1, await renderOriginal(pdf));
    const byText = new Map(layer.boxes.map((box) => [box.text, box]));
    expect(byText.get("Bold Heading")?.fontWeight).toBe(700);
    expect(byText.get("regular body")?.fontWeight).toBe(400);
    expect(byText.get("mono caption")?.fontFamily).toBe("Courier New");
    expect(byText.get("serif caption")?.fontFamily).toBe("Times New Roman");
  }, 30_000);

  it("rejects a page number outside the document", async () => {
    const pdf = await makeTwoColorSlide();
    await expect(extractFromBytes(pdf, 7, await renderOriginal(pdf))).rejects.toThrow(
      "PDF_PAGE_NOT_FOUND",
    );
  }, 30_000);
});

/**
 * 真實簡報的 PDF 幾乎都是內嵌 subset 字型，pdf.js 對這種字型的 `bold`／`black` 一律是
 * `undefined`（只有非內嵌字型才走名稱推斷那條路），字重的唯一線索就是 PostScript 名稱。
 * 這些名字沒有辦法用 pdf-lib 的標準字型合成出來，所以直接測名稱判定本身。
 */
describe("font name heuristics", () => {
  it("reads the weight off the subset PostScript name", () => {
    expect(fontWeightFromName("BCDFEE+MicrosoftJhengHeiBold")).toBe(700);
    expect(fontWeightFromName("BCDGEE+MicrosoftJhengHeiBold")).toBe(700);
    expect(fontWeightFromName("ABCDEF+SourceHanSans-Semibold")).toBe(700);
    expect(fontWeightFromName("Calibri-DemiBold")).toBe(700);
    expect(fontWeightFromName("BCDEEE+ArialBlack")).toBe(900);
    expect(fontWeightFromName("Roboto-Heavy")).toBe(900);
  });

  it("never mistakes Regular for bold and refuses to guess", () => {
    // 這一條是回歸重點：真實檔裡 Regular 與 Bold 只差字尾。
    expect(fontWeightFromName("BCDEEE+MicrosoftJhengHeiRegular")).toBeUndefined();
    expect(fontWeightFromName("BCDHEE+MicrosoftJhengHeiRegular")).toBeUndefined();
    expect(fontWeightFromName("Helvetica")).toBeUndefined();
    expect(fontWeightFromName("BCDEEE+NotoSansTC-Light")).toBeUndefined();
    expect(fontWeightFromName(undefined)).toBeUndefined();
  });

  it("only leaves the sans-serif default when the name says serif or monospace", () => {
    expect(fontFamilyFromName("BCDEEE+CourierNewPSMT")).toBe("Courier New");
    expect(fontFamilyFromName("JetBrainsMono-Regular")).toBe("Courier New");
    expect(fontFamilyFromName("ABCDEF+TimesNewRomanPSMT")).toBe("Times New Roman");
    expect(fontFamilyFromName("PTSerif-Bold")).toBe("Times New Roman");
    // 拿不準就維持現狀：映射到伺服器與瀏覽器都沒有的字型只會更糟。
    expect(fontFamilyFromName("BCDEEE+MicrosoftJhengHeiRegular")).toBeUndefined();
    expect(fontFamilyFromName("OpenSans-Regular")).toBeUndefined();
    expect(fontFamilyFromName("SourceSansSerifPro")).toBeUndefined();
    expect(fontFamilyFromName(undefined)).toBeUndefined();
  });
});

/**
 * 抹字背景靠的是 pdf.js 的 `_renderPageChunk` 掛點。pdf.js 只在
 * `!intentState.displayReadyCapability` 時才 `_pumpOperatorList`，所以同一個 page
 * proxy 的第二次 display render 會重用快取的 operator list，**完全不經過掛點**。
 *
 * 這種情況下畫出來的「背景」原封不動帶著文字。靜默降級比失敗更糟：合成出來的頁面
 * 會是「原文字 + 疊上去的文字框」，看起來像重影，而且沒有任何訊號。
 */
describe("strip-text render guard", () => {
  it("throws instead of silently returning a background that still has text", async () => {
    const pdf = await makeTwoColorSlide();
    const document = await loadPdfDocument(pdf);
    try {
      const page = await document.getPage(1);
      const stripped = await renderPageToPng(document, page, CANVAS, DEFAULT_PAGE_TIMEOUT_MS, true);
      expect(stripped.length).toBeGreaterThan(0);
      // 第二次：pdf.js 重用快取的 operator list，過濾器不會被呼叫到。
      await expect(
        renderPageToPng(document, page, CANVAS, DEFAULT_PAGE_TIMEOUT_MS, true),
      ).rejects.toThrow("PDF_TEXT_LAYER_UNSUPPORTED");
      page.cleanup();
    } finally {
      await document.destroy().catch(() => undefined);
    }
  }, 30_000);
});

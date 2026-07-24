// 測試素材產生器：全部程序化合成，不落地任何二進位檔到 repo。
//  - 16:9 帶原生文字層的 PDF（每頁有 drawText → getTextContent 抽得出文字 → version B）
//  - 「掃描頁」PDF（16:9 但只有色塊、零文字 → 只有 version A）
//  - 非 16:9 PDF（第一頁 4:3 → inspectPdfDeck 直接 PDF_ASPECT_UNSUPPORTED）
//  - 超過 150 頁的 16:9 PDF（測 truncate 與匯入拒絕）
//  - PNG 圖片、txt/md 純文字來源
import { pdfLib, sharp } from "./deps.mjs";

const { PDFDocument, StandardFonts, rgb } = pdfLib;

const SIXTEEN_NINE = [960, 540]; // 1.777…，落在 DECK_ASPECT_MIN/MAX（1.70–1.82）
const FOUR_THREE = [800, 600]; // 1.333，被拒

/**
 * 產生一份 16:9 PDF，每頁帶標題與內文（原生文字層）。
 * `pages` 是每頁的 { title, body[] }。
 */
export async function makeTextDeckPdf(pages) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const page of pages) {
    const [width, height] = SIXTEEN_NINE;
    const sheet = document.addPage([width, height]);
    sheet.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    if (page.title)
      sheet.drawText(page.title, {
        x: 40,
        y: height - 110,
        size: 40,
        font,
        color: rgb(0.05, 0.1, 0.4),
      });
    (page.body ?? []).forEach((line, index) => {
      sheet.drawText(line, {
        x: 40,
        y: height - 190 - index * 30,
        size: 18,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    });
  }
  return new Uint8Array(await document.save());
}

/**
 * 混比例 PDF：`specs` 每項 { ratio: "16:9"|"4:3", title?, body? }。
 * 用來測「非 16:9 頁被 skip」——第一頁須為 16:9，後面混入 4:3 頁會被略過。
 */
export async function makeMixedDeckPdf(specs) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const spec of specs) {
    const [width, height] = spec.ratio === "4:3" ? FOUR_THREE : SIXTEEN_NINE;
    const sheet = document.addPage([width, height]);
    sheet.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    if (spec.title)
      sheet.drawText(spec.title, {
        x: 40,
        y: height - 110,
        size: 36,
        font,
        color: rgb(0.05, 0.1, 0.4),
      });
    (spec.body ?? []).forEach((line, index) => {
      sheet.drawText(line, {
        x: 40,
        y: height - 190 - index * 30,
        size: 18,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    });
  }
  return new Uint8Array(await document.save());
}

/** 16:9「掃描頁」PDF：只有色塊、沒有任何文字 operator，故不產生可編輯文字層。 */
export async function makeScannedDeckPdf(pageCount = 2) {
  const document = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    const [width, height] = SIXTEEN_NINE;
    const sheet = document.addPage([width, height]);
    sheet.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.9, 0.92, 0.96) });
    sheet.drawRectangle({
      x: 80,
      y: 80,
      width: width - 160,
      height: height - 160,
      color: rgb(0.2 + i * 0.1, 0.4, 0.7),
    });
  }
  return new Uint8Array(await document.save());
}

/** 第一頁 4:3 → inspectPdfDeck 直接拒絕整份。 */
export async function makeNon169Pdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const [width, height] = FOUR_THREE;
  const sheet = document.addPage([width, height]);
  sheet.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  sheet.drawText("Portrait-ish page", { x: 40, y: height - 80, size: 30, font });
  return new Uint8Array(await document.save());
}

/** N 頁 16:9 PDF（測 >150 頁的 truncate 與匯入拒絕）。內容極簡以壓低建檔成本。 */
export async function makeManyPageDeckPdf(pageCount) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i += 1) {
    const [width, height] = SIXTEEN_NINE;
    const sheet = document.addPage([width, height]);
    sheet.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    sheet.drawText(`Page ${i + 1}`, { x: 40, y: height - 80, size: 24, font });
  }
  return new Uint8Array(await document.save());
}

/** 單色（可指定 rgb 0–255）PNG，預設 1920×1080。 */
export async function makePng(width = 1920, height = 1080, color = { r: 32, g: 64, b: 128 }) {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: color },
    })
      .png()
      .toBuffer(),
  );
}

export function makeText(content) {
  return new TextEncoder().encode(content);
}

/**
 * 局部編輯遮罩 PNG（RGBA）：`region` 內為不透明白（alpha=255，允許編輯），其餘全透明
 * （alpha=0，受保護）。給 L2 masked-edit 用——server 的 compositeMaskedEdit 以
 * `dest-in` 保留遮罩不透明處的編輯結果，透明處一律回退為 base 原像素，故遮罩外像素零差異。
 * 預設 1920×1080（畫布尺寸），region 預設為置中的 400×400 方塊。
 */
export async function makeMaskPng(
  width = 1920,
  height = 1080,
  region = {
    left: Math.round(width / 2 - 200),
    top: Math.round(height / 2 - 200),
    width: 400,
    height: 400,
  },
) {
  const opaque = await sharp({
    create: {
      width: region.width,
      height: region.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: opaque, left: region.left, top: region.top }])
      .png()
      .toBuffer(),
  );
}

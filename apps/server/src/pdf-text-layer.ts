import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { EditableTextBox } from "@slide-maker/core";
import {
  DEFAULT_PAGE_TIMEOUT_MS,
  deckViewport,
  pageTextFragments,
  renderPageToPng,
  type DeckRenderLimits,
  type PageTextLayer,
} from "./pdf-deck-render.js";
import { mergeFragmentsIntoRuns, type PdfTextLine } from "./pdf-text.js";

/**
 * PDF 匯入頁的可編輯文字層，在匯入時與原圖一起產生，全程零模型。
 *
 *  1. 從 PDF 抽該頁原生文字（精度 100%，不是 OCR）
 *  2. 二次渲染取真正無文字的背景（過濾文字繪製指令，不是 inpaint）
 *  3. 文字顏色：operator list 的 fill color 優先，取不到則比對原圖與背景的
 *     字墨像素反推——絕對不能落到 schema 預設的 `#ffffff`，白底簡報上文字會直接消失
 *
 * 掃描頁（沒有原生文字層）會 throw `PDF_TEXT_LAYER_EMPTY`，呼叫端據此讓那一頁
 * 只有原圖版本；不 fallback 到 OCR，也不對使用者提示。
 *
 * 傳進來的 `document` 必須是**還沒 display render 過這一頁**的 handle：
 * pdf.js 只在 `!intentState.displayReadyCapability` 時才 `_pumpOperatorList`，
 * 同一個 page proxy 的第二次 display render 會重用快取的 operator list、
 * 完全繞過抹字過濾器（`renderPageToPng` 偵測得到，會 throw
 * `PDF_TEXT_LAYER_UNSUPPORTED`）。匯入流程因此為文字層另開一個 document handle。
 */

export type PdfTextLayerExtraction = PageTextLayer;

/** 與 `editableTextLayerSchema.boxes` 的 `.max(500)` 對齊。 */
const MAX_TEXT_LAYER_BOXES = 500;

/** `textOverlaySvg` 的行框模型：字級 × lineHeight 的行框內垂直置中。 */
const BOX_LINE_HEIGHT = 1.2;
const FONT_ASCENT = 0.905;
const FONT_DESCENT = 0.212;
/** 由行框頂端到基線的距離（倍率），與 `text-layers.ts` 的合成器一致。 */
const BASELINE_OFFSET = (BOX_LINE_HEIGHT - (FONT_ASCENT + FONT_DESCENT)) / 2 + FONT_ASCENT;

interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

async function rgbImage(bytes: Uint8Array, width: number, height: number): Promise<RgbImage> {
  const raw = await sharp(bytes)
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(raw.data), width: raw.info.width, height: raw.info.height };
}

function hex(r: number, g: number, b: number): string {
  const clamp = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/**
 * 以「原圖 − 無文字背景」的差異定位字墨像素，再取核心字墨（差異最大的一群）的平均色。
 * 反鋸齒邊緣像素是字色與底色的混色，只取核心像素才不會把顏色洗淡。
 */
function inkColor(
  original: RgbImage,
  background: RgbImage,
  rect: { x: number; y: number; width: number; height: number },
): string | undefined {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(original.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(original.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) return undefined;
  const candidates: { difference: number; r: number; g: number; b: number }[] = [];
  let strongest = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * original.width + x) * 3;
      const r = original.data[index] ?? 0;
      const g = original.data[index + 1] ?? 0;
      const b = original.data[index + 2] ?? 0;
      const difference =
        Math.abs(r - (background.data[index] ?? 0)) +
        Math.abs(g - (background.data[index + 1] ?? 0)) +
        Math.abs(b - (background.data[index + 2] ?? 0));
      if (difference <= 24) continue;
      strongest = Math.max(strongest, difference);
      candidates.push({ difference, r, g, b });
    }
  }
  if (!candidates.length) return undefined;
  const core = candidates.filter((pixel) => pixel.difference >= strongest * 0.6);
  const total = core.length || candidates.length;
  const sample = core.length ? core : candidates;
  const sum = sample.reduce(
    (accumulator, pixel) => {
      accumulator.r += pixel.r;
      accumulator.g += pixel.g;
      accumulator.b += pixel.b;
      return accumulator;
    },
    { r: 0, g: 0, b: 0 },
  );
  return hex(sum.r / total, sum.g / total, sum.b / total);
}

/** 完全取不到顏色時的保底：依背景亮度挑深／淺色，永遠不會與底色同色。 */
function contrastColor(
  background: RgbImage,
  rect: { x: number; y: number; width: number; height: number },
): string {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(background.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(background.height, Math.ceil(rect.y + rect.height));
  let luminance = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * background.width + x) * 3;
      luminance +=
        0.2126 * (background.data[index] ?? 0) +
        0.7152 * (background.data[index + 1] ?? 0) +
        0.0722 * (background.data[index + 2] ?? 0);
      count += 1;
    }
  }
  const mean = count ? luminance / count : 255;
  return mean >= 140 ? "#1a1a1a" : "#f2f2f2";
}

const COLOR_STATE_OPS = new Set<number>([
  pdfjs.OPS.setFillRGBColor,
  pdfjs.OPS.setFillColorN,
  pdfjs.OPS.setFillColor,
  pdfjs.OPS.setFillGray,
  pdfjs.OPS.setFillCMYKColor,
  pdfjs.OPS.setFillColorSpace,
]);

/**
 * operator list 上的文字填色。整頁文字只用到單一 fill color 時直接採用（最可靠的來源）；
 * 出現多種顏色或圖樣填色就回 undefined——operator list 的 show-text 與
 * `getTextContent()` 的 item 不是一對一，硬配對會把顏色接錯到別的框上，
 * 此時交給像素反推逐框判斷。
 */
async function operatorListTextColor(page: PDFPageProxy): Promise<string | undefined> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const stack: (string | undefined)[] = [];
  let current: string | undefined;
  const colors = new Set<string>();
  let ambiguous = false;
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    if (fn === pdfjs.OPS.save) {
      stack.push(current);
      continue;
    }
    if (fn === pdfjs.OPS.restore) {
      current = stack.pop();
      continue;
    }
    if (fn !== undefined && COLOR_STATE_OPS.has(fn)) {
      const args = argsArray[index] as unknown[] | undefined;
      const value = args?.[0];
      current = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
      continue;
    }
    if (
      fn === pdfjs.OPS.showText ||
      fn === pdfjs.OPS.showSpacedText ||
      fn === pdfjs.OPS.nextLineShowText ||
      fn === pdfjs.OPS.nextLineSetSpacingShowText
    ) {
      if (!current) ambiguous = true;
      else colors.add(current.toLowerCase());
    }
  }
  if (ambiguous || colors.size !== 1) return undefined;
  return [...colors][0];
}

interface FontDescriptor {
  fontFamily: string;
  fontWeight: number;
}

/** `BCDEEE+MicrosoftJhengHeiBold` → `MicrosoftJhengHeiBold`：去掉內嵌 subset 的六碼前綴。 */
function postScriptBaseName(name: string | undefined): string {
  return name?.replace(/^[A-Z]{6}\+/, "") ?? "";
}

/**
 * PostScript 名稱推字重。
 *
 * 內嵌 subset 字型（PowerPoint／Keynote 匯出的 PDF 幾乎全是）在 pdf.js 裡 `bold` 與
 * `black` 都是 `undefined`——旗標來自 FontDescriptor 的 Flags/StemV，subset 常常沒帶。
 * 只看旗標的話整份簡報會一律回 400，大標、表頭、欄位標籤全部變細，PPTX 匯出也失去
 * 字重層次。名字倒是明講：`...JhengHeiBold` vs `...JhengHeiRegular`。
 *
 * 名字看不出來就回 `undefined`，讓呼叫端退回旗標——不猜。
 *
 * 導出是為了直接測名稱判定：真實案例（內嵌 subset）需要一份帶內嵌中文字型的 PDF
 * 才能重現，用合成 fixture 走不到這條路徑。
 */
export function fontWeightFromName(name: string | undefined): number | undefined {
  const base = postScriptBaseName(name);
  if (/black|heavy/i.test(base)) return 900;
  // `Regular` 不含這些詞；`Semibold`／`DemiBold` 都算 700。
  if (/bold|semi|demi/i.test(base)) return 700;
  return undefined;
}

/**
 * PostScript 名稱推字族——只在名字**明講**襯線或等寬時才偏離預設。
 *
 * `fallbackName` 對內嵌字型幾乎恆為 `"sans-serif"`，所以既有的 serif／monospace 分支
 * 在真實 PDF 上等於沒作用。但映射到伺服器與瀏覽器都沒有的字型只會更糟（合成器會落到
 * 又一層 fallback），所以這裡刻意保守：`Times`、`Georgia`、`Courier` 這種自報家門的
 * 名字才換，其餘一律維持原本的 `fallbackName` 判斷。
 */
export function fontFamilyFromName(name: string | undefined): string | undefined {
  const base = postScriptBaseName(name);
  if (/mono|courier|consolas/i.test(base)) return "Courier New";
  if (/serif|times|georgia|garamond/i.test(base) && !/sans/i.test(base)) return "Times New Roman";
  return undefined;
}

/** pdf.js 的字型物件 → 系統字型近似值。PDF 內嵌字型在瀏覽器與伺服器都不存在，必然 fallback。 */
function fontDescriptor(page: PDFPageProxy, fontName: string, fallback?: string): FontDescriptor {
  const objects = page.commonObjs as unknown as {
    has(name: string): boolean;
    get(
      name: string,
    ): { bold?: boolean; black?: boolean; fallbackName?: string; name?: string } | undefined;
  };
  const font = objects.has(fontName) ? objects.get(fontName) : undefined;
  const family = font?.fallbackName ?? fallback ?? "sans-serif";
  const fontFamily =
    fontFamilyFromName(font?.name) ??
    (family.includes("monospace")
      ? "Courier New"
      : family.includes("serif") && !family.includes("sans")
        ? "Times New Roman"
        : "Arial");
  const fontWeight = fontWeightFromName(font?.name) ?? (font?.black ? 900 : font?.bold ? 700 : 400);
  return { fontFamily, fontWeight };
}

function textBox(
  line: PdfTextLine,
  scaleY: number,
  canvas: { width: number; height: number },
  font: FontDescriptor,
  color: string,
): EditableTextBox {
  const fontSize = Math.max(6, line.fontSize * scaleY);
  const height = fontSize * BOX_LINE_HEIGHT;
  const y = line.baseline * scaleY - fontSize * BASELINE_OFFSET;
  const x = Math.max(0, Math.min(canvas.width - 1, line.x));
  return {
    id: randomUUID(),
    text: line.text,
    x,
    y: Math.max(0, Math.min(canvas.height - 1, y)),
    width: Math.max(8, Math.min(canvas.width - x, line.width)),
    height: Math.max(8, height),
    fontFamily: font.fontFamily,
    fontSize,
    fontWeight: font.fontWeight,
    color,
    opacity: 1,
    lineHeight: BOX_LINE_HEIGHT,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    // 原生文字層不是辨識結果，沒有不確定性。
    confidence: 1,
    role: "presentation",
  };
}

/**
 * 抽出某一頁的可編輯文字層：無文字背景 + 對位好的文字框。
 *
 * `document` 由呼叫端開啟與關閉（整批匯入只開一次），本函式不會 destroy 它。
 */
export async function extractPdfTextLayer(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: { width: number; height: number },
  originalPng: Uint8Array,
  limits: DeckRenderLimits = {},
): Promise<PdfTextLayerExtraction> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages)
    throw new Error("PDF_PAGE_NOT_FOUND");
  const page = await document.getPage(pageNumber);
  try {
    const viewport = deckViewport(page);
    const { fragments, styles } = await pageTextFragments(page, viewport);
    // 每頁的 fontName 只有個位數，但片段有上千個：解析結果快取起來，
    // 讓 run 切分的樣式比較不必反覆查 `commonObjs`。
    const descriptors = new Map<string, FontDescriptor>();
    const descriptorOf = (fontName: string): FontDescriptor => {
      const cached = descriptors.get(fontName);
      if (cached) return cached;
      const resolved = fontDescriptor(page, fontName, styles[fontName]?.fontFamily);
      descriptors.set(fontName, resolved);
      return resolved;
    };
    const lines = mergeFragmentsIntoRuns(fragments, (fontName) => {
      const font = descriptorOf(fontName);
      return `${font.fontFamily} ${font.fontWeight}`;
    });
    // 掃描頁沒有原生文字層：就是純底圖，不 fallback 到 OCR。
    if (!lines.length) throw new Error("PDF_TEXT_LAYER_EMPTY");
    // `editableTextLayerSchema.boxes` 上限就是 500。在這裡先擋，抹字背景那一次
    // 光柵化也就不用白跑；呼叫端拿到具名錯誤而不是 zod 的 parse 失敗。
    if (lines.length > MAX_TEXT_LAYER_BOXES) throw new Error("PDF_TEXT_LAYER_TOO_DENSE");
    const declaredColor = await operatorListTextColor(page);
    const background = await renderPageToPng(
      document,
      page,
      canvas,
      limits.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
      true,
    );
    const [originalImage, backgroundImage] = await Promise.all([
      rgbImage(originalPng, canvas.width, canvas.height),
      rgbImage(background, canvas.width, canvas.height),
    ]);
    // render 是等比放大到 1920 寬，之後才拉滿高度；文字幾何要套同一組垂直縮放才對得上。
    const scaleY = canvas.height / viewport.height;
    const boxes = lines.map((line) => {
      // run 內樣式一致，第一個片段的字型就是整段的字型。
      const font = descriptorOf(line.fontName);
      const rect = {
        x: line.x,
        y: line.baseline * scaleY - line.fontSize * scaleY,
        width: line.width,
        height: line.fontSize * scaleY * 1.3,
      };
      const color =
        declaredColor ??
        inkColor(originalImage, backgroundImage, rect) ??
        contrastColor(backgroundImage, rect);
      return textBox(line, scaleY, canvas, font, color);
    });
    return { background, boxes };
  } finally {
    page.cleanup();
  }
}

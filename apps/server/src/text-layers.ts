import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { resolveTextRuns, textRunLines, textStroke } from "@slide-maker/core";
import type {
  EditableTextBox,
  EditableTextLayer,
  PresentationProject,
  SlideVersion,
} from "@slide-maker/core";
import type { RawOcrResult } from "./ocr.js";
import type { FileProjectRepository } from "./repository.js";

/**
 * 這個版本「畫面上看得到、而且還沒有被抹過字」的那張圖。
 *
 * 抽字（OCR 的輸入、抹字的底圖）一律要以它為基準，不可以直接讀 `version.imagePath`：
 * 手動文字層的 `imagePath` 是「背景 ＋ 使用者手打的字」的合成圖，拿它去抹字會把使用者
 * 打的字一起烘進背景，變成再也刪不掉的像素。
 *
 * 只認 `origin === "manual"` 是刻意的，不是漏寫：手動層的背景從來沒被抹過（一開始別名
 * 指向原圖版本的 `imagePath`，被「編輯當頁圖片」換掉的也是同樣未抹過的新圖），所以它就是
 * 這一版「原本的字還在」的那張；抽出來的層反過來——它的 `backgroundPath` 已經抹乾淨了，
 * 拿它當抽字基準只會抽到一片空白。那正是 extract-text 要回頭找 `originalVersionId` 那一版
 * 的原因（別動那條），也讓這個函式的遞迴深度只有 1。
 */
export function unerasedImagePath(version: Pick<SlideVersion, "imagePath" | "textLayer">): string {
  return version.textLayer?.origin === "manual"
    ? version.textLayer.backgroundPath
    : version.imagePath;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// 編輯器以 CSS line-height 排版（字形內容區在行框內垂直置中，上下各留 half-leading），
// SVG 端必須重現同一模型，否則合成圖的文字會比編輯畫面偏高。
// ascent/descent 取 Arial／Helvetica／Liberation Sans 共通的 hhea metrics 近似值。
const FONT_ASCENT = 0.905;
const FONT_DESCENT = 0.212;

/**
 * 文字框的 `<text>` 元素，不含外層 `<svg>`。
 *
 * 匯出端要在同一張 SVG 裡先畫頁碼色塊 `<rect>` 再畫文字，需要能拿到裸元素；
 * `textOverlaySvg()` 只是包一層 `<svg>` 呼叫它，輸出逐字不變。
 *
 * 有底色的框會在自己的 `<text>` 前面多一個 `<rect>`，且**逐框依序輸出 rect+text**，
 * 不把所有 rect 集中到最前面——集中輸出會讓後面框的底色蓋掉前面框的文字，
 * 疊層順序就與編輯器 DOM（每個框各自是一層）對不上。
 */
export function textElements(boxes: readonly EditableTextBox[]): string {
  return boxes
    .map((box) => {
      const anchor = box.align === "center" ? "middle" : box.align === "right" ? "end" : "start";
      const x =
        box.align === "center"
          ? box.x + box.width / 2
          : box.align === "right"
            ? box.x + box.width
            : box.x;
      const lines = box.text.split("\n");
      const lineBox = box.fontSize * box.lineHeight;
      const totalHeight = lineBox * Math.max(1, lines.length);
      // 與編輯器一致：文字總高超過框高時貼齊框頂，不往上溢出。
      const spareHeight = Math.max(0, box.height - totalHeight);
      const top =
        box.verticalAlign === "middle"
          ? box.y + spareHeight / 2
          : box.verticalAlign === "bottom"
            ? box.y + spareHeight
            : box.y;
      const halfLeading = (lineBox - box.fontSize * (FONT_ASCENT + FONT_DESCENT)) / 2;
      const firstBaseline = top + halfLeading + box.fontSize * FONT_ASCENT;
      /*
       * 換行與換色是兩個維度：每一行是一個 text chunk（帶 `x` 的 tspan 起頭，`text-anchor`
       * 才作用在整行上），行內再依顏色切成數個不帶 `x` 的 tspan 自然接續。
       *
       * 單色框走的仍是原本那一行 map，輸出逐字元不變——這個功能加進來之前的所有合成圖、
       * PPTX 與快照因此完全不受影響。
       */
      const runs = resolveTextRuns(box);
      const tspans =
        runs.length <= 1
          ? lines
              .map(
                (line, index) =>
                  `<tspan x="${x}" dy="${index === 0 ? 0 : lineBox}">${xml(line)}</tspan>`,
              )
              .join("")
          : textRunLines(runs)
              .map((lineRuns, index) => {
                const dy = index === 0 ? 0 : lineBox;
                if (!lineRuns.length) return `<tspan x="${x}" dy="${dy}"></tspan>`;
                return lineRuns
                  .map(
                    (run, runIndex) =>
                      // `xml:space="preserve"` 只出現在分段路徑：SVG 預設會把 tspan 邊緣的
                      // 空白吃掉，而分段的切點常常正好落在空格上（` 的未來`、`Latency `），
                      // 少了它整行會往左縮一格。
                      `<tspan${runIndex === 0 ? ` x="${x}" dy="${dy}"` : ""} fill="${run.color}" xml:space="preserve">${xml(run.text)}</tspan>`,
                  )
                  .join("");
              })
              .join("");
      const transform = box.rotation
        ? ` transform="rotate(${box.rotation} ${box.x + box.width / 2} ${box.y + box.height / 2})"`
        : "";
      // 底色矩形＝文字框矩形本身，無內距無圓角，並套用同一個 rotate transform。
      const background = box.backgroundColor
        ? `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${box.backgroundColor}" fill-opacity="${box.backgroundOpacity ?? 1}"${transform}/>`
        : "";
      /*
       * 描邊。`paint-order="stroke"` **不可省**：SVG 預設是先填色再畫描邊，而描邊是跨在
       * 字形輪廓上的（一半在外一半在內），所以少了它描邊會蓋在字面上——實測 200 個框、
       * 3px 描邊，純白字心像素從 191322 直接歸零，整行字變成黑色實心塊。這由
       * `text-stroke-pixels.test.ts` 逐像素釘住。
       * `stroke-linejoin="round"` 是為了中文：筆劃轉角銳利，預設的 miter 會在轉角噴出尖刺。
       * 寬度換算走 core 的 `textStroke()`，三端不得各自乘一次字級。
       */
      const stroke = textStroke(box);
      const strokeAttrs = stroke
        ? ` stroke="${stroke.color}" stroke-width="${stroke.widthPx}" stroke-opacity="${stroke.opacity}" stroke-linejoin="round" paint-order="stroke"`
        : "";
      return `${background}<text x="${x}" y="${firstBaseline}" text-anchor="${anchor}" font-family="${xml(box.fontFamily)}" font-size="${box.fontSize}" font-weight="${box.fontWeight}" fill="${box.color}" fill-opacity="${box.opacity}" letter-spacing="${box.letterSpacing}"${strokeAttrs}${transform}>${tspans}</text>`;
    })
    .join("");
}

export function textOverlaySvg(
  boxes: readonly EditableTextBox[],
  width: number,
  height: number,
): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${textElements(boxes)}</svg>`,
  );
}

// 與 ocr-refine.ts 的 BOLD_FONT_SIZE 共用同一個換算基準：fontSize ≈ 框高 × 0.78。
// 該檔的註解直接引用這兩個數字，兩處改動時要一起改。
const FONT_HEIGHT_RATIO = 0.78;
const BOLD_HEIGHT_THRESHOLD = 52;

/**
 * 這一框是不是直書（縱向排列的 CJK 文字，例如一個字一行、由上往下的標籤）。
 *
 * 門檻與判準**逐字複製** PaddleOCR 自己 `cal_ocr_word_box.is_vertical_text()` 的邏輯
 * （框高 ÷ 框寬 > 1.5，用同一份 polygon bbox）——不是憑空選的數字，是為了讓這裡的
 * 判斷與 Python 端算逐字框時用的判斷**保證一致**：兩邊只要有一邊判斷不同，逐字框的
 * 座標語意就會被誤讀（Python 沿 Y 軸切出來的框，被 TS 當成沿 X 軸切的框去用）。
 * `words` 存在且 ≥2 個字是必要條件（見 `ocr.ts` 的 schema，單字或無資料時不會有這欄）。
 */
function isVerticalRun(box: RawOcrResult["boxes"][number]): boolean {
  if (!box.words || box.words.length < 2) return false;
  const xs = box.polygon.map((point) => point[0]);
  const ys = box.polygon.map((point) => point[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return width > 0 && height / width > 1.5;
}

/** 一般橫排框：既有邏輯，逐位元不變。 */
function buildHorizontalBox(
  box: RawOcrResult["boxes"][number],
  canvas: { width: number; height: number },
  scaleX: number,
  scaleY: number,
): EditableTextBox {
  const xs = box.polygon.map((point) => point[0] * scaleX);
  const ys = box.polygon.map((point) => point[1] * scaleY);
  const x = Math.max(0, Math.min(...xs));
  const y = Math.max(0, Math.min(...ys));
  const width = Math.max(8, Math.min(canvas.width - x, Math.max(...xs) - x));
  const height = Math.max(8, Math.min(canvas.height - y, Math.max(...ys) - y));
  const fontSize = Math.max(10, Math.min(180, height * FONT_HEIGHT_RATIO));
  return {
    id: randomUUID(),
    text: box.text.trim(),
    x,
    y,
    width,
    height,
    fontFamily: "Arial",
    fontSize,
    fontWeight: height >= BOLD_HEIGHT_THRESHOLD ? 700 : 400,
    color: "#ffffff",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left" as const,
    verticalAlign: "top" as const,
    rotation: 0,
    confidence: box.confidence,
    role: "presentation" as const,
  };
}

/**
 * 直書框：以 PaddleOCR 逐字量到的**真實**位置組框，不透過 `measureInk`／
 * `solveBoxGeometry` 那套只懂橫排的字級反推（這正是 2026-08-22 實機踩到的根因——
 * 那套邏輯把直書的窄高偵測框誤判成「污染的高度證據」，硬塞成一行小字橫排）。
 *
 * 落地成**一個框、字元間用 `\n` 分行**，不是四個獨立框：`textElements()`
 * （`box.text.split("\n")` 逐行縱向排列）與 `refineOcrBoxes` 對含 `\n` 的框會整段
 * 跳過字墨貼合（`ocr-refine.ts:900`，`!box.text.includes("\n")` 那道守衛），
 * 剛好讓這裡算出來的幾何原樣落地，不會被誤套橫排的字墨量測再弄壞一次。
 * 拆成獨立框雖然多一個框就能各自套字墨精修，但會讓使用者要逐字分開選取、上色，
 * 也會讓樣式精修的 prompt 把一個標籤拆成四個不相干的條目，直觀性都更差。
 *
 * 座標與 `words[].box` 全部沿用**原始 OCR 影像座標**，跟 `polygon` 同一套，
 * 這裡才統一乘 `scaleX`／`scaleY`。
 */
function buildVerticalBox(
  box: RawOcrResult["boxes"][number],
  canvas: { width: number; height: number },
  scaleX: number,
  scaleY: number,
): EditableTextBox | undefined {
  const words = box.words;
  if (!words || words.length < 2) return undefined;
  const scaled = words.map((word) => ({
    text: word.text,
    x0: word.box[0] * scaleX,
    y0: word.box[1] * scaleY,
    x1: word.box[2] * scaleX,
    y1: word.box[3] * scaleY,
  }));
  const x = Math.max(0, Math.min(...scaled.map((word) => word.x0)));
  const y = Math.max(0, Math.min(...scaled.map((word) => word.y0)));
  const right = Math.max(...scaled.map((word) => word.x1));
  const bottom = Math.max(...scaled.map((word) => word.y1));
  const width = Math.max(8, Math.min(canvas.width - x, right - x));
  const height = Math.max(8, Math.min(canvas.height - y, bottom - y));
  // 逐字框理應等高（PaddleOCR 把整框高度均分），取平均值抵銷量測抖動；
  // 用它換算字級才對得上「一個字＝一行」的視覺大小，而不是四個字疊起來的總高。
  const avgCharHeight = height / scaled.length;
  const fontSize = Math.max(10, Math.min(180, avgCharHeight * FONT_HEIGHT_RATIO));
  // 反推 lineHeight，讓渲染時「一行的步進高度」（fontSize × lineHeight）精確等於
  // 原圖量到的逐字間距，字元落點才會貼齊被抹掉的原始位置，不會越疊越密或越疊越開。
  const lineHeight = avgCharHeight / fontSize;
  if (!Number.isFinite(fontSize) || !Number.isFinite(lineHeight) || lineHeight <= 0)
    return undefined;
  return {
    id: randomUUID(),
    text: scaled.map((word) => word.text).join("\n"),
    x,
    y,
    width,
    height,
    fontFamily: "Arial",
    fontSize,
    fontWeight: avgCharHeight >= BOLD_HEIGHT_THRESHOLD ? 700 : 400,
    color: "#ffffff",
    opacity: 1,
    lineHeight,
    letterSpacing: 0,
    // 橫排預設靠左，這裡改置中：每一行只有一個字，字寬本來就會因標點、字形略有
    // 出入，置中才會讓整串字沿著同一條中線疊，貼近原圖上直書標籤本來的樣子。
    align: "center" as const,
    verticalAlign: "top" as const,
    rotation: 0,
    confidence: box.confidence,
    role: "presentation" as const,
  };
}

export function boxesFromOcr(
  result: RawOcrResult,
  canvas: { width: number; height: number },
  threshold: number,
): EditableTextBox[] {
  const scaleX = canvas.width / result.width;
  const scaleY = canvas.height / result.height;
  return result.boxes
    .filter((box) => box.confidence >= threshold && box.text.trim())
    .map((box) => {
      if (isVerticalRun(box)) {
        const vertical = buildVerticalBox(box, canvas, scaleX, scaleY);
        if (vertical) return vertical;
      }
      return buildHorizontalBox(box, canvas, scaleX, scaleY);
    });
}

export async function textMask(
  boxes: readonly Pick<EditableTextBox, "x" | "y" | "width" | "height" | "fontSize">[],
  width: number,
  height: number,
): Promise<Uint8Array> {
  const rects = boxes
    .map((box) => {
      // 垂直 padding 要蓋住字緣反鋸齒殘墨（太小會留鬼影），至少 8px 並隨字級放大；
      // 水平 padding 刻意收小——卡片的「｜」分隔線緊貼文字左右，外擴太多會把它抹掉。
      const padY = Math.max(8, Math.min(28, box.fontSize * 0.25));
      const padX = Math.max(5, Math.min(14, box.fontSize * 0.12));
      return `<rect x="${Math.max(0, box.x - padX)}" y="${Math.max(0, box.y - padY)}" width="${Math.min(width - box.x + padX, box.width + padX * 2)}" height="${Math.min(height - box.y + padY, box.height + padY * 2)}" rx="${Math.min(8, padX)}" fill="white"/>`;
    })
    .join("");
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`,
  );
  return new Uint8Array(await sharp(svg).png().toBuffer());
}

export async function renderComposite(
  repository: FileProjectRepository,
  project: PresentationProject,
  layer: EditableTextLayer,
): Promise<string> {
  const background = await readFile(repository.resolveAsset(project.id, layer.backgroundPath));
  const base = await sharp(background)
    .resize(project.canvas.width, project.canvas.height, { fit: "fill" })
    .png()
    .toBuffer();
  const overlay = textOverlaySvg(
    layer.boxes.filter((box) => box.role === "presentation"),
    project.canvas.width,
    project.canvas.height,
  );
  const composite = await sharp(base)
    .composite([{ input: overlay, blend: "over" }])
    .png()
    .toBuffer();
  // 檔名必須每次重渲染都不同：server 對 assets 下送 immutable + max-age=1yr，
  // 且前端 cache key 只用檔名（projectAssetUrl）。重新抽離會把 renderRevision 重設為 0，
  // 若沿用 composite-0.png，瀏覽器會持續顯示舊的合成圖（簡報模式字疊在一起的元凶），
  // 因此在檔名尾巴接 randomUUID 確保每次重渲染 URL 都不一樣。
  const relative = `text-layers/${layer.originalVersionId}/composite-${layer.renderRevision}-${randomUUID()}.png`;
  return repository.saveAsset(project.id, relative, new Uint8Array(composite));
}

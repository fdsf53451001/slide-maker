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
      const xs = box.polygon.map((point) => point[0] * scaleX);
      const ys = box.polygon.map((point) => point[1] * scaleY);
      const x = Math.max(0, Math.min(...xs));
      const y = Math.max(0, Math.min(...ys));
      const width = Math.max(8, Math.min(canvas.width - x, Math.max(...xs) - x));
      const height = Math.max(8, Math.min(canvas.height - y, Math.max(...ys) - y));
      const fontSize = Math.max(10, Math.min(180, height * 0.78));
      return {
        id: randomUUID(),
        text: box.text.trim(),
        x,
        y,
        width,
        height,
        fontFamily: "Arial",
        fontSize,
        fontWeight: height >= 52 ? 700 : 400,
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

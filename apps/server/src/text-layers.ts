import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { EditableTextBox, EditableTextLayer, PresentationProject } from "@slide-maker/core";
import type { RawOcrResult } from "./ocr.js";
import type { FileProjectRepository } from "./repository.js";

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
      const tspans = lines
        .map(
          (line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineBox}">${xml(line)}</tspan>`,
        )
        .join("");
      const transform = box.rotation
        ? ` transform="rotate(${box.rotation} ${box.x + box.width / 2} ${box.y + box.height / 2})"`
        : "";
      return `<text x="${x}" y="${firstBaseline}" text-anchor="${anchor}" font-family="${xml(box.fontFamily)}" font-size="${box.fontSize}" font-weight="${box.fontWeight}" fill="${box.color}" fill-opacity="${box.opacity}" letter-spacing="${box.letterSpacing}"${transform}>${tspans}</text>`;
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
  const background = await readFile(
    repository.assetPath(project.id, layer.backgroundPath.replace(/^assets\//, "")),
  );
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

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { EditableTextBox, EditableTextLayer, PresentationProject } from "@slide-maker/core";
import type { RawOcrResult } from "./ocr.js";
import type { FileProjectRepository } from "./repository.js";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function textOverlaySvg(boxes: readonly EditableTextBox[], width: number, height: number): Buffer {
  const content = boxes.map((box) => {
    const anchor = box.align === "center" ? "middle" : box.align === "right" ? "end" : "start";
    const x = box.align === "center" ? box.x + box.width / 2 : box.align === "right" ? box.x + box.width : box.x;
    const lines = box.text.split("\n");
    const totalHeight = box.fontSize * box.lineHeight * Math.max(1, lines.length);
    const top = box.verticalAlign === "middle" ? box.y + (box.height - totalHeight) / 2 : box.verticalAlign === "bottom" ? box.y + box.height - totalHeight : box.y;
    const tspans = lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : box.fontSize * box.lineHeight}">${xml(line)}</tspan>`).join("");
    const transform = box.rotation ? ` transform="rotate(${box.rotation} ${box.x + box.width / 2} ${box.y + box.height / 2})"` : "";
    return `<text x="${x}" y="${top}" text-anchor="${anchor}" dominant-baseline="text-before-edge" font-family="${xml(box.fontFamily)}" font-size="${box.fontSize}" font-weight="${box.fontWeight}" fill="${box.color}" fill-opacity="${box.opacity}" letter-spacing="${box.letterSpacing}"${transform}>${tspans}</text>`;
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`);
}

export function boxesFromOcr(result: RawOcrResult, canvas: { width: number; height: number }, threshold: number): EditableTextBox[] {
  const scaleX = canvas.width / result.width; const scaleY = canvas.height / result.height;
  return result.boxes.filter((box) => box.confidence >= threshold && box.text.trim()).map((box) => {
    const xs = box.polygon.map((point) => point[0] * scaleX); const ys = box.polygon.map((point) => point[1] * scaleY);
    const x = Math.max(0, Math.min(...xs)); const y = Math.max(0, Math.min(...ys));
    const width = Math.max(8, Math.min(canvas.width - x, Math.max(...xs) - x));
    const height = Math.max(8, Math.min(canvas.height - y, Math.max(...ys) - y));
    const fontSize = Math.max(10, Math.min(180, height * 0.78));
    return {
      id: randomUUID(), text: box.text.trim(), x, y, width, height,
      fontFamily: "Arial", fontSize, fontWeight: height >= 52 ? 700 : 400,
      color: "#ffffff", opacity: 1, lineHeight: 1.2, letterSpacing: 0,
      align: "left" as const, verticalAlign: "top" as const, rotation: 0,
      confidence: box.confidence, role: "presentation" as const,
    };
  });
}

export async function textMask(boxes: readonly EditableTextBox[], width: number, height: number): Promise<Uint8Array> {
  const rects = boxes.map((box) => {
    const pad = Math.max(4, Math.min(18, box.fontSize * 0.12));
    return `<rect x="${Math.max(0, box.x - pad)}" y="${Math.max(0, box.y - pad)}" width="${Math.min(width - box.x + pad, box.width + pad * 2)}" height="${Math.min(height - box.y + pad, box.height + pad * 2)}" rx="${Math.min(8, pad)}" fill="white"/>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`);
  return new Uint8Array(await sharp(svg).png().toBuffer());
}

export async function renderComposite(repository: FileProjectRepository, project: PresentationProject, layer: EditableTextLayer): Promise<string> {
  const background = await readFile(repository.assetPath(project.id, layer.backgroundPath.replace(/^assets\//, "")));
  const base = await sharp(background).resize(project.canvas.width, project.canvas.height, { fit: "fill" }).png().toBuffer();
  const overlay = textOverlaySvg(layer.boxes.filter((box) => box.role === "presentation"), project.canvas.width, project.canvas.height);
  const composite = await sharp(base).composite([{ input: overlay, blend: "over" }]).png().toBuffer();
  const relative = `text-layers/${layer.originalVersionId}/composite-${layer.renderRevision}.png`;
  return repository.saveAsset(project.id, relative, new Uint8Array(composite));
}

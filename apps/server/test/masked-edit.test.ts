import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compositeMaskedEdit } from "../src/jobs.js";
import { boxesFromOcr, textMask, textOverlaySvg } from "../src/text-layers.js";

describe("masked image editing", () => {
  it("uses the edited pixels only inside the painted alpha mask", async () => {
    const base = await sharp({ create: { width: 4, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const edited = await sharp({ create: { width: 4, height: 2, channels: 4, background: "#0000ff" } }).png().toBuffer();
    const mask = await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: { create: { width: 2, height: 2, channels: 4, background: "#ffffff" } }, left: 0, top: 0 }]).png().toBuffer();
    const result = await compositeMaskedEdit(new Uint8Array(base), new Uint8Array(edited), new Uint8Array(mask), 4, 2);
    const { data } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)]).toEqual([0, 0, 255]);
    expect([...data.subarray(12, 15)]).toEqual([255, 0, 0]);
  });
});

describe("OCR text masks", () => {
  it("keeps low-confidence detections in the raster and masks accepted text only", async () => {
    const boxes = boxesFromOcr({ width: 100, height: 50, boxes: [
      { text: "保留", confidence: 0.7, polygon: [[1, 1], [20, 1], [20, 10], [1, 10]] },
      { text: "抽離", confidence: 0.9, polygon: [[40, 20], [80, 20], [80, 35], [40, 35]] },
    ] }, { width: 200, height: 100 }, 0.75);
    expect(boxes.map((box) => box.text)).toEqual(["抽離"]);
    const mask = await textMask(boxes, 200, 100);
    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels)];
    expect(pixel(10, 10)).toEqual([0, 0, 0, 0]);
    expect(pixel(100, 50)).toEqual([255, 255, 255, 255]);
  });

  it("starts the first rendered line at the OCR box origin without adding one font-size offset", () => {
    const box = {
      id: "box", text: "Position", x: 100, y: 80, width: 300, height: 60,
      fontFamily: "Arial", fontSize: 40, fontWeight: 400, color: "#112233", opacity: 1,
      lineHeight: 1.2, letterSpacing: 0, align: "left" as const, verticalAlign: "top" as const,
      rotation: 0, confidence: 1, role: "presentation" as const,
    };
    const svg = textOverlaySvg([box], 1920, 1080).toString("utf8");
    expect(svg).toContain('y="80"');
    expect(svg).toContain('dominant-baseline="text-before-edge"');
    expect(svg).toContain('<tspan x="100" dy="0">Position</tspan>');
    expect(svg).not.toContain('dy="40"');
  });
});

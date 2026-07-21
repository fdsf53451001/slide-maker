import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createProject } from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import { compositeMaskedEdit } from "../src/jobs.js";
import { boxesFromOcr, renderComposite, textMask, textOverlaySvg } from "../src/text-layers.js";
import { FileProjectRepository } from "../src/repository.js";

describe("masked image editing", () => {
  it("uses the edited pixels only inside the painted alpha mask", async () => {
    const base = await sharp({
      create: { width: 4, height: 2, channels: 4, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const edited = await sharp({
      create: { width: 4, height: 2, channels: 4, background: "#0000ff" },
    })
      .png()
      .toBuffer();
    const mask = await sharp({
      create: { width: 4, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: { create: { width: 2, height: 2, channels: 4, background: "#ffffff" } },
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const result = await compositeMaskedEdit(
      new Uint8Array(base),
      new Uint8Array(edited),
      new Uint8Array(mask),
      4,
      2,
    );
    const { data } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)]).toEqual([0, 0, 255]);
    expect([...data.subarray(12, 15)]).toEqual([255, 0, 0]);
  });
});

describe("OCR text masks", () => {
  it("keeps low-confidence detections in the raster and masks accepted text only", async () => {
    const boxes = boxesFromOcr(
      {
        width: 100,
        height: 50,
        boxes: [
          {
            text: "保留",
            confidence: 0.7,
            polygon: [
              [1, 1],
              [20, 1],
              [20, 10],
              [1, 10],
            ],
          },
          {
            text: "抽離",
            confidence: 0.9,
            polygon: [
              [40, 20],
              [80, 20],
              [80, 35],
              [40, 35],
            ],
          },
        ],
      },
      { width: 200, height: 100 },
      0.75,
    );
    expect(boxes.map((box) => box.text)).toEqual(["抽離"]);
    const mask = await textMask(boxes, 200, 100);
    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray(
        (y * info.width + x) * info.channels,
        (y * info.width + x + 1) * info.channels,
      ),
    ];
    expect(pixel(10, 10)).toEqual([0, 0, 0, 0]);
    expect(pixel(100, 50)).toEqual([255, 255, 255, 255]);
  });

  it("places the first baseline to match CSS line-height layout (half-leading + ascent)", () => {
    const box = {
      id: "box",
      text: "Position",
      x: 100,
      y: 80,
      width: 300,
      height: 60,
      fontFamily: "Arial",
      fontSize: 40,
      fontWeight: 400,
      color: "#112233",
      opacity: 1,
      lineHeight: 1.2,
      letterSpacing: 0,
      align: "left" as const,
      verticalAlign: "top" as const,
      rotation: 0,
      confidence: 1,
      role: "presentation" as const,
    };
    const svg = textOverlaySvg([box], 1920, 1080).toString("utf8");
    // 首行 baseline = y + half-leading + ascent，重現編輯器 CSS line-height 的排版：
    // half-leading = (40*1.2 - 40*(0.905+0.212))/2 = 1.66，baseline = 80 + 1.66 + 36.2 = 117.86
    const match = svg.match(/<text x="[\d.-]+" y="([\d.-]+)"/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeCloseTo(117.86, 2);
    // baseline 定位不再依賴 librsvg 支援度不一的 dominant-baseline
    expect(svg).not.toContain("dominant-baseline");
    expect(svg).toContain('<tspan x="100" dy="0">Position</tspan>');
    expect(svg).not.toContain('dy="40"');
  });
});

describe("renderComposite asset paths", () => {
  // assets 由 server 以 immutable + max-age=1yr 提供，前端 cache key 只用檔名。
  // 重新抽離同一版本時 renderRevision 重設為 0；若 composite 檔名沿用
  // composite-0.png，瀏覽器會持續顯示舊合成圖（簡報模式字疊在一起的元凶）。
  // 因此每次渲染都要產生獨一無二的檔名。
  it("renders a unique composite path per call even with the same renderRevision", async () => {
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-composite-cache-")),
    );
    await repository.initialize();
    const project = createProject({ topic: "快取測試", brief: { desiredSlideCount: 1 } });
    const now = new Date().toISOString();
    const background = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#202020" },
    })
      .png()
      .toBuffer();
    const backgroundPath = await repository.saveAsset(
      project.id,
      `slide/background-${now.replace(/[:.]/g, "")}.png`,
      new Uint8Array(background),
    );
    const layer = {
      originalVersionId: "original",
      backgroundPath,
      compositePath: backgroundPath,
      threshold: 0.75,
      renderRevision: 0,
      extractedAt: now,
      updatedAt: now,
      boxes: [
        {
          id: "box",
          text: "重渲染測試",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          fontFamily: "Arial",
          fontSize: 32,
          fontWeight: 700,
          color: "#ffffff",
          opacity: 1,
          lineHeight: 1.2,
          letterSpacing: 0,
          align: "left" as const,
          verticalAlign: "top" as const,
          rotation: 0,
          confidence: 1,
          role: "presentation" as const,
        },
      ],
    };
    const first = await renderComposite(repository, project, layer);
    const second = await renderComposite(repository, project, layer);
    expect(first).toMatch(/composite-0-[0-9a-f-]+\.png$/);
    expect(second).toMatch(/composite-0-[0-9a-f-]+\.png$/);
    expect(first).not.toBe(second);
  });
});

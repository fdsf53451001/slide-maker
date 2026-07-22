import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { createProject, type EditableTextBox } from "@slide-maker/core";
import { exportPresentation } from "../src/exporters.js";
import { refineOcrBoxes } from "../src/ocr-refine.js";
import { FileProjectRepository } from "../src/repository.js";
import { defaultTextMetrics } from "../src/text-metrics.js";
import { FAKE_PAGE } from "./helpers/qa-fake-page.js";
import { inkBBox, renderRaster, renderSlide } from "./helpers/text-roundtrip.js";

const CANVAS = { width: 1920, height: 1080 };

/**
 * 端對端對位：把精修後的框沿著**真實合成路徑**（textOverlaySvg + sharp）重畫一次，
 * 逐行比對字墨落點與原圖。這是「抽離文字之後畫面看起來有沒有跑掉」的最終判準，
 * 不經過任何中間量測邏輯，期望值就是原圖自己。
 */
describe("端對端對位", () => {
  it("整頁重新合成後，每一行的字墨位移 <3px、寬高比 0.95–1.05", async () => {
    const slide = await renderSlide(FAKE_PAGE, { minCanvas: CANVAS });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    // 抽離後的框在合成時用的是原本的文字顏色；這裡統一成與原圖相同的顏色，
    // 才能用同一個字墨門檻比較兩張圖。
    const recomposed = await renderRaster(
      boxes.map((box) => ({ ...box, color: "#111111" })),
      slide.canvas,
    );
    FAKE_PAGE.forEach((spec, index) => {
      const truth = slide.truths[index]!;
      // 裁切範圍取得夠寬鬆，讓「跑掉」的行仍落在裁切區內而不是被切掉。
      const crop = {
        x: Math.max(0, truth.x - truth.fontSize),
        y: Math.max(0, truth.y - truth.fontSize),
        width: truth.width + truth.fontSize * 2,
        height: truth.height + truth.fontSize * 2,
      };
      const before = inkBBox(slide.image, crop);
      const after = inkBBox(recomposed, crop);
      expect(before, `${spec.text} 原圖字墨`).not.toBeNull();
      expect(after, `${spec.text} 重新合成字墨`).not.toBeNull();
      expect(Math.abs(after!.x - before!.x), `${spec.text} x 位移(px)`).toBeLessThan(3);
      expect(Math.abs(after!.y - before!.y), `${spec.text} y 位移(px)`).toBeLessThan(3);
      expect(after!.width / before!.width, `${spec.text} 寬比`).toBeGreaterThan(0.95);
      expect(after!.width / before!.width, `${spec.text} 寬比`).toBeLessThan(1.05);
      expect(after!.height / before!.height, `${spec.text} 高比`).toBeGreaterThan(0.95);
      expect(after!.height / before!.height, `${spec.text} 高比`).toBeLessThan(1.05);
    });
  });
});

/**
 * 三個消費端共用同一份 box 幾何：SVG 合成（text-layers.ts）、PPTX 匯出
 * （exporters.ts）與編輯器 DOM。編輯器端在 vitest 裡沒有字型可量，這裡只驗前兩者。
 *
 * SVG 端的錨點直接從**渲染結果**反推（字墨左緣 − bearing×字級），不是照抄
 * textOverlaySvg 的公式，否則就是拿實作驗實作。
 */
async function svgAnchorOf(box: EditableTextBox): Promise<number> {
  const glyph = await defaultTextMetrics.measure({
    text: box.text,
    fontFamily: box.fontFamily,
    fontWeight: box.fontWeight,
    lineHeight: box.lineHeight,
  });
  const image = await renderRaster([{ ...box, color: "#111111" }], CANVAS);
  const ink = inkBBox(image, { x: 0, y: 0, ...CANVAS });
  if (!ink) throw new Error(`${box.text} 沒有渲染出字墨`);
  const textLeft = ink.x - glyph.bearing * box.fontSize;
  if (box.align === "center") return textLeft + (glyph.advance * box.fontSize) / 2;
  if (box.align === "right") return textLeft + glyph.advance * box.fontSize;
  return textLeft;
}

interface PptxFrame {
  x: number;
  width: number;
}

/** 從 PPTX 的 slide XML 取出每個文字框的位置與寬度，換算回畫布像素。 */
function pptxFrames(xml: string, boxes: readonly EditableTextBox[]): Map<string, PptxFrame> {
  const pxPerEmu = CANVAS.width / (13.333 * 914400);
  const frames = new Map<string, PptxFrame>();
  for (const shape of xml.split("<p:sp>").slice(1)) {
    const box = boxes.find((candidate) => shape.includes(`<a:t>${candidate.text}</a:t>`));
    if (!box) continue;
    const match = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/.exec(shape);
    if (!match) continue;
    frames.set(box.id, {
      x: Number(match[1]) * pxPerEmu,
      width: Number(match[3]) * pxPerEmu,
    });
  }
  return frames;
}

function pptxAnchor(box: EditableTextBox, frame: PptxFrame): number {
  if (box.align === "center") return frame.x + frame.width / 2;
  if (box.align === "right") return frame.x + frame.width;
  return frame.x;
}

async function exportWithBoxes(boxes: readonly EditableTextBox[]): Promise<string> {
  const repository = new FileProjectRepository(
    await mkdtemp(join(tmpdir(), "slide-maker-qa-consumers-")),
  );
  await repository.initialize();
  const project = createProject({ topic: "幾何一致性", brief: { desiredSlideCount: 1 } });
  const slide = project.slides[0]!;
  const background = new Uint8Array(
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}"><rect width="100%" height="100%" fill="#123456"/></svg>`,
    )
      .render()
      .asPng(),
  );
  const backgroundPath = await repository.saveAsset(
    project.id,
    `${slide.id}/background.png`,
    background,
  );
  const now = new Date().toISOString();
  slide.versions.push({
    id: "layered",
    imagePath: backgroundPath,
    prompt: "",
    providerId: "test",
    model: "test",
    parameters: {},
    styleVersion: 1,
    sources: [],
    createdAt: now,
    textLayer: {
      originalVersionId: "original",
      backgroundPath,
      compositePath: backgroundPath,
      threshold: 0.75,
      renderRevision: 0,
      extractedAt: now,
      updatedAt: now,
      boxes: [...boxes],
    },
  });
  slide.currentVersionId = "layered";
  const pptx = await exportPresentation(repository, project, "pptx");
  return Buffer.from(unzipSync(pptx)["ppt/slides/slide1.xml"]!).toString("utf8");
}

describe("SVG 合成與 PPTX 匯出的幾何一致性", () => {
  it("精修產生的真實框在兩個消費端的錨點一致（含 center／right）", async () => {
    const slide = await renderSlide(FAKE_PAGE, { minCanvas: CANVAS });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    // 樣式精修會把對齊方式改成模型看到的樣子；框寬此時已是貼齊字墨的緊框，
    // PPTX 端「加 1em 餘裕再往左補回」的補償必須剛好抵銷，否則錨點會位移。
    const aligned = boxes.map((box, index) => ({
      ...box,
      align: (["left", "center", "right"] as const)[index % 3]!,
    }));
    const xml = await exportWithBoxes(aligned);
    const frames = pptxFrames(xml, aligned);
    expect(frames.size, "每個框都要在 PPTX 裡找得到").toBe(aligned.length);
    for (const box of aligned) {
      const frame = frames.get(box.id)!;
      const svg = await svgAnchorOf(box);
      expect(pptxAnchor(box, frame) - svg, `${box.text}（${box.align}）錨點差(px)`).toBeCloseTo(
        0,
        0,
      );
      // 餘裕本身仍必須存在（PowerPoint 的 advance 略寬於量測值時才不會折行）。
      expect(frame.width, `${box.text} PPTX 框寬`).toBeGreaterThan(box.width);
    }
  });

  // 抓的 bug：exporters.ts 曾以 `Math.max(0, box.x * scaleX - shiftX)` 夾住 x，
  // 框貼近畫布左緣時補償被吃掉，center/right 的錨點整個往右偏（實測 41.4px）。
  //
  // 容差不能寫死成 0.5px：`bearing` 是在 SAMPLE_FONT_SIZE 的樣本上量的，解析度就是
  // 1 樣本像素 ＝ 1/SAMPLE_FONT_SIZE em，換算到字級 F 即 F/100 px（60px 字 ＝ 0.6px）。
  // 比這更嚴的斷言驗的是量測方法的量化誤差，不是消費端的一致性。
  it("靠左緣的 center／right 框，錨點補償不得被畫布邊界截掉", async () => {
    const glyph = await defaultTextMetrics.measure({
      text: "邊緣對齊",
      fontFamily: "Arial",
      fontWeight: 400,
      lineHeight: 1.2,
    });
    const base: EditableTextBox = {
      id: "edge-right",
      text: "邊緣對齊",
      x: 18,
      y: 700,
      width: glyph.advance * 60,
      height: 72,
      fontFamily: "Arial",
      fontSize: 60,
      fontWeight: 400,
      color: "#ffffff",
      opacity: 1,
      lineHeight: 1.2,
      letterSpacing: 0,
      align: "right",
      verticalAlign: "top",
      rotation: 0,
      confidence: 0.9,
      role: "presentation",
    };
    const boxes = [
      base,
      { ...base, id: "edge-center", text: "置中邊緣", align: "center" as const },
    ];
    const xml = await exportWithBoxes(boxes);
    const frames = pptxFrames(xml, boxes);
    // bearing 的量測解析度（見上）；加 0.1px 吸收 XML 的 EMU 取整。
    const resolution = 60 / 100 + 0.1;
    for (const box of boxes) {
      const frame = frames.get(box.id)!;
      expect(
        Math.abs(pptxAnchor(box, frame) - (await svgAnchorOf(box))),
        `${box.text} 錨點差(px)`,
      ).toBeLessThanOrEqual(resolution);
    }
  });
});

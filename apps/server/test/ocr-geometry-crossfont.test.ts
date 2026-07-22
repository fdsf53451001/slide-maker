import { describe, expect, it } from "vitest";
import { defaultTextMetrics } from "../src/text-metrics.js";
import {
  inkBBox,
  renderRaster,
  runRoundTrip,
  type RoundTripSpec,
  type RoundTripOutcome,
  type RenderedSlide,
} from "./helpers/text-roundtrip.js";

/**
 * 跨字型政策：原圖用 A 字型畫，精修時卻宣告 B 字型（樣式精修由模型猜字型，
 * 幾乎不可能猜中原稿字型；實機上的 `MCP / Tool Allow-list` 就是高度估對、
 * 字型不同仍溢出 1.27 倍的案例）。
 *
 * 這裡不寫死任何一組字型的 metrics：先量兩個字型是否真的不同（不同才有測到東西），
 * 再斷言「不論換成哪個字型，文字的水平佔位必須與原圖一致、且不得撐出偵測框」。
 * 字型一律用 fontconfig 一定解析得到的泛用族（sans-serif／serif／monospace），
 * 避免在沒有 Arial／Times 的機器上假性失敗。
 */
const TEXT = "Quality Report Deck";
const FONT_SIZE = 36;

interface CrossFontRun {
  outcome: RoundTripOutcome;
  slide: RenderedSlide;
  sourceInkWidth: number;
  renderedInk: { x: number; y: number; width: number; height: number };
  sourceInk: { x: number; y: number; width: number; height: number };
}

async function crossFont(source: string, declared: string): Promise<CrossFontRun> {
  const spec: RoundTripSpec = { text: TEXT, fontSize: FONT_SIZE, fontFamily: source };
  const { outcomes, slide, result } = await runRoundTrip([spec], { refineFontFamily: declared });
  const crop = { x: 0, y: 0, width: slide.canvas.width, height: slide.canvas.height };
  const sourceInk = inkBBox(slide.image, crop);
  const rendered = await renderRaster(result.boxes, slide.canvas);
  const renderedInk = inkBBox(rendered, crop);
  if (!sourceInk || !renderedInk) throw new Error("跨字型比對取不到字墨");
  return {
    outcome: outcomes[0]!,
    slide,
    sourceInkWidth: sourceInk.width,
    sourceInk,
    renderedInk,
  };
}

/** 兩個字型在這台機器上真的不同（否則整個案例是空轉，要讓人看得出來）。 */
async function assertFontsDiffer(a: string, b: string): Promise<void> {
  const [ga, gb] = await Promise.all(
    [a, b].map((fontFamily) =>
      defaultTextMetrics.measure({ text: TEXT, fontFamily, fontWeight: 400, lineHeight: 1.2 }),
    ),
  );
  expect(
    Math.abs(ga!.advance / gb!.advance - 1),
    `${a} 與 ${b} 在這台機器上解析到同一個字型，跨字型案例失去意義`,
  ).toBeGreaterThan(0.02);
}

const PAIRS: readonly (readonly [string, string])[] = [
  ["serif", "sans-serif"],
  ["sans-serif", "serif"],
  ["monospace", "sans-serif"],
  ["sans-serif", "monospace"],
];

describe("跨字型替代政策", () => {
  for (const [source, declared] of PAIRS) {
    it(`來源 ${source} → 精修宣告 ${declared}：水平佔位不變且不溢出`, async () => {
      await assertFontsDiffer(source, declared);
      const { outcome, sourceInk, renderedInk } = await crossFont(source, declared);
      // 唯一能保證的性質：換字型後文字仍佔用同一段水平空間（字墨寬主錨的直接後果）。
      expect(renderedInk.width / sourceInk.width, "重新渲染後的字墨寬 ÷ 原字墨寬").toBeGreaterThan(
        0.95,
      );
      expect(renderedInk.width / sourceInk.width, "重新渲染後的字墨寬 ÷ 原字墨寬").toBeLessThan(
        1.05,
      );
      expect(Math.abs(renderedInk.x - sourceInk.x), "字墨左緣位移(px)").toBeLessThanOrEqual(3);
      // 不溢出：撐出自己的框或撐出 OCR 偵測到的範圍都算跑版。
      expect(outcome.renderedWidth / outcome.refined.width).toBeLessThanOrEqual(1.05);
      expect(outcome.overflowVsDetection, "渲染寬 ÷ 偵測框寬").toBeLessThanOrEqual(1.05);
      // 字級容差放寬到 ±25%：等寬字與比例字的 em 設計差距本來就有兩成。
      expect(outcome.refined.fontSize / FONT_SIZE).toBeGreaterThan(0.75);
      expect(outcome.refined.fontSize / FONT_SIZE).toBeLessThan(1.25);
    });
  }

  it("換成比例接近的字族時，字級誤差應該在 ±20% 以內", async () => {
    for (const [source, declared] of [
      ["serif", "sans-serif"],
      ["sans-serif", "serif"],
    ] as const) {
      const { outcome } = await crossFont(source, declared);
      expect(
        Math.abs(outcome.refined.fontSize / FONT_SIZE - 1),
        `${source} → ${declared} 字級偏差`,
      ).toBeLessThan(0.2);
    }
  });

  /**
   * 「寧可偏小不偏大」在現行實作下**不成立**（見回報的 [MEDIUM]）：字級只由字墨寬
   * 反推，沒有任何「不得比原字級大」的夾制。替代字型的 x-height／em 設計較小時
   * （sans → serif、sans → monospace），字級會被解成比原稿大，行框跟著長高，
   * 有壓到上下鄰行的風險——而水平方向仍然安全（字墨寬恆等於原字墨寬）。
   *
   * 這裡不去斷言那條做不到的政策（`ocr-geometry-roundtrip.test.ts` 已明文把
   * 「偏小」列為非結構性保證），改成把膨脹幅度釘住當回歸警戒線：今天最極端的
   * 等寬 → 比例字替代是 +20%，任何讓它更糟的改動都會在這裡失敗。
   */
  it("跨字型的行框膨脹必須有界（目前沒有任何高度夾制）", async () => {
    for (const [source, declared] of PAIRS) {
      const { outcome } = await crossFont(source, declared);
      expect(
        outcome.refined.fontSize / FONT_SIZE,
        `${source} → ${declared} 行框膨脹倍率`,
      ).toBeLessThanOrEqual(1.25);
    }
  });

  it("CJK 行換字族後仍不溢出、位置不跑掉", async () => {
    for (const declared of ["sans-serif", "serif"]) {
      const spec: RoundTripSpec = { text: "身分與最小權限", fontSize: 40 };
      const { outcomes } = await runRoundTrip([spec], { refineFontFamily: declared });
      const outcome = outcomes[0]!;
      expect(outcome.overflowVsDetection, `→ ${declared}`).toBeLessThanOrEqual(1.05);
      expect(Math.abs(outcome.dxEm), `→ ${declared} x 誤差`).toBeLessThan(0.1);
      expect(Math.abs(outcome.dyEm), `→ ${declared} y 誤差`).toBeLessThan(0.1);
    }
  });
});

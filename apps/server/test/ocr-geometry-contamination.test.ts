import { describe, expect, it } from "vitest";
import type { EditableTextBox } from "@slide-maker/core";
import {
  applyStyleRefinement,
  measureInk,
  refineOcrBoxes,
  resnapWithFinalFonts,
} from "../src/ocr-refine.js";
import { defaultTextMetrics, type TextMetricsProvider } from "../src/text-metrics.js";
import {
  compareToTruth,
  inkBBox,
  renderSlide,
  runRoundTrip,
  type Decoration,
  type RoundTripSpec,
} from "./helpers/text-roundtrip.js";

/**
 * 字墨量測的污染韌性。
 *
 * 實機上的 `盤點API、Agent、工具與資料流` 就長在一張左側有垂直細線的卡片裡：
 * 偵測框的 unclip 外擴一旦把那條線吃進來，列剖面就會整段都是「有墨」，
 * 字墨帶不是被判定失敗（退回偵測框粗估）就是被拉長（位置整行上移）。
 * 這裡把裝飾元素相對**真實字墨**擺放，所以偵測框鬆緊改變時場景仍然一致。
 */
const SPEC: RoundTripSpec = {
  text: "盤點API、Agent、工具與資料流",
  fontSize: 42,
  x: 200,
  y: 200,
};

/** 先畫一張乾淨的，量出真實字墨矩形，之後所有裝飾都相對它擺放。 */
async function inkRect(spec: RoundTripSpec) {
  const clean = await renderSlide([spec]);
  const rect = inkBBox(clean.image, {
    x: 0,
    y: 0,
    width: clean.canvas.width,
    height: clean.canvas.height,
  });
  if (!rect) throw new Error("乾淨渲染量不到字墨");
  return rect;
}

async function runWithDecorations(
  spec: RoundTripSpec,
  decorations: readonly Decoration[],
  slideOptions: { background?: string } = {},
) {
  const slide = await renderSlide([spec], { ...slideOptions, decorations });
  const { boxes } = await refineOcrBoxes(slide.detections, {
    sourceTexts: [],
    image: slide.image,
  });
  const outcome = (await compareToTruth([spec], slide, boxes))[0]!;
  return { outcome, slide, ink: measureInk(slide.image, slide.detections[0]!) };
}

// 偵測框相對字墨的外擴量，以 em 表示（PaddleOCR 的 unclip 會隨字級等比放大）。
const UNCLIP_RATIOS = [0.15, 0.25, 0.33] as const;

describe("污染韌性：卡片左邊框（垂直細線）", () => {
  for (const ratio of UNCLIP_RATIOS) {
    const unclip = Math.round(SPEC.fontSize * ratio);
    it(`unclip=${ratio}em 時，緊貼文字左緣的垂直細線不得讓文字撐出偵測框`, async () => {
      const spec: RoundTripSpec = { ...SPEC, unclipX: unclip, unclipY: unclip };
      const ink = await inkRect(spec);
      // 卡片邊框：寬 5px 的垂直線，貼在字墨左緣外 3px，上下都比文字高一截。
      const rule: Decoration = {
        x: ink.x - 8,
        y: ink.y - spec.fontSize,
        width: 5,
        height: ink.height + spec.fontSize * 2,
      };
      const { outcome } = await runWithDecorations(spec, [rule]);
      expect(outcome.overflowVsDetection, "渲染寬 ÷ 偵測框寬").toBeLessThanOrEqual(1.05);
      expect(outcome.fontSizeError, "字級誤差").toBeLessThan(0.05);
    });

    it(`unclip=${ratio}em 時，垂直細線不得把文字的垂直位置拉走`, async () => {
      const spec: RoundTripSpec = { ...SPEC, unclipX: unclip, unclipY: unclip };
      const ink = await inkRect(spec);
      const rule: Decoration = {
        x: ink.x - 8,
        y: ink.y - spec.fontSize,
        width: 5,
        height: ink.height + spec.fontSize * 2,
      };
      const { outcome } = await runWithDecorations(spec, [rule]);
      expect(Math.abs(outcome.dyEm), "y 誤差(em)").toBeLessThan(0.15);
      expect(Math.abs(outcome.dxEm), "x 誤差(em)").toBeLessThan(0.15);
    });
  }
});

describe("污染韌性：其他版面元素與低對比", () => {
  it("｜ 分隔線緊貼文字右側（高度與文字相當）時仍能對位", async () => {
    const ink = await inkRect(SPEC);
    const divider: Decoration = {
      x: ink.x + ink.width + 5,
      y: ink.y,
      width: 4,
      height: ink.height,
    };
    const { outcome } = await runWithDecorations(SPEC, [divider]);
    expect(outcome.fontSizeError).toBeLessThan(0.05);
    expect(Math.abs(outcome.dxEm)).toBeLessThan(0.1);
    expect(Math.abs(outcome.dyEm)).toBeLessThan(0.1);
    expect(outcome.overflowVsDetection).toBeLessThanOrEqual(1.05);
  });

  it("底線裝飾（文字下方的水平細線）不得被算進字墨帶", async () => {
    const ink = await inkRect(SPEC);
    const underline: Decoration = {
      x: ink.x,
      y: ink.y + ink.height + 3,
      width: ink.width,
      height: 4,
    };
    const { outcome } = await runWithDecorations(SPEC, [underline]);
    expect(outcome.fontSizeError).toBeLessThan(0.05);
    expect(Math.abs(outcome.dyEm)).toBeLessThan(0.1);
  });

  it("深底白字（反相）：背景由邊框中位數推得，對位結果與白底一致", async () => {
    const spec: RoundTripSpec = { ...SPEC, color: "#ffffff" };
    const slide = await renderSlide([spec], { background: "#101820" });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    const outcome = (await compareToTruth([spec], slide, boxes))[0]!;
    expect(outcome.fontSizeError).toBeLessThan(0.05);
    expect(Math.abs(outcome.dxEm)).toBeLessThan(0.05);
    expect(Math.abs(outcome.dyEm)).toBeLessThan(0.05);
    expect(outcome.overflowVsDetection).toBeLessThanOrEqual(1.05);
  });

  it("低對比（灰底更灰的字）仍在字墨門檻之上時要能對位", async () => {
    const spec: RoundTripSpec = { ...SPEC, color: "#6a6a6a" };
    const slide = await renderSlide([spec], { background: "#3a3a3a" });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    const outcome = (await compareToTruth([spec], slide, boxes))[0]!;
    expect(outcome.fontSizeError).toBeLessThan(0.05);
    expect(Math.abs(outcome.dyEm)).toBeLessThan(0.05);
  });

  it("三行密排（行距僅 1.05em）時每一行都只吃到自己的字墨", async () => {
    const fontSize = 30;
    const specs: RoundTripSpec[] = [0, 1, 2].map((index) => ({
      text: `第${index + 1}行的密排內文範例`,
      fontSize,
      x: 120,
      y: 120 + index * Math.round(fontSize * 1.05),
    }));
    const { outcomes } = await runRoundTrip(specs);
    for (const outcome of outcomes) {
      expect(outcome.fontSizeError, `${outcome.spec.text} 字級誤差`).toBeLessThan(0.05);
      expect(Math.abs(outcome.dyEm), `${outcome.spec.text} y 誤差`).toBeLessThan(0.1);
      expect(outcome.overflowVsDetection, `${outcome.spec.text} 溢出`).toBeLessThanOrEqual(1.05);
    }
  });

  // 實機案例（ithome-cloud-summit p2 的 System／Monitoring）：上行帶下伸部（y）、
  // 行距緊到 y 的尾巴（2–5px 寬的細墨）直抵下一行的字帽，兩行的列剖面被橋接成
  // 同一帶——上行的字墨帶往下滲（字級與寬度被灌水）、下行的 ink.y 被拉到上行的
  // 下伸部區（實機 y 偏了 18px，兩行渲染後直接疊在一起）。
  // 行距 0.95em 看似極端，其實是實機常態：原稿字型的字墨佔 em 比例（實測 1.1）
  // 比渲染端 Arial（0.93）大，同樣的視覺行距換算到 Arial 尺度就是 <1em。
  it("上行的下伸部尾巴不得把緊排的兩行橋接成同一個字墨帶", async () => {
    const fontSize = 40;
    const specs: RoundTripSpec[] = [
      { text: "System", fontSize, x: 1600, y: 300, unclipY: 0.25 },
      {
        text: "Monitoring",
        fontSize,
        x: 1600,
        y: 300 + Math.round(fontSize * 0.95),
        unclipY: 0.25,
      },
    ];
    const { outcomes } = await runRoundTrip(specs);
    const [top, bottom] = outcomes as [(typeof outcomes)[0], (typeof outcomes)[0]];
    // 下行的 y 錨點不得被上行的下伸部拉高（實機偏了 0.5em）。
    expect(Math.abs(bottom.dyEm), "下行 y 誤差").toBeLessThan(0.1);
    expect(Math.abs(top.dyEm), "上行 y 誤差").toBeLessThan(0.1);
    // 兩行的渲染範圍不得交疊到彼此的字身。
    expect(bottom.refined.y - top.refined.y, "兩行間距").toBeGreaterThan(fontSize * 0.8);
    for (const outcome of [top, bottom])
      expect(outcome.fontSizeError, `${outcome.spec.text} 字級誤差`).toBeLessThan(0.06);
  });

  // 反向守門：橋接收斂不得把「合法的下伸部」當成鄰行剔掉——多下伸部的小寫行
  // 若失去尾巴，字墨高會少掉 0.2em，高度證據偏低到讓污染偵測誤判、字級被錯砍。
  it("整行都是下伸部的小寫字串仍要量到完整字墨高", async () => {
    const spec: RoundTripSpec = { text: "grey syrup gravy", fontSize: 36, x: 200, y: 300 };
    const slide = await renderSlide([spec]);
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    const outcome = (await compareToTruth([spec], slide, boxes))[0]!;
    expect(outcome.fontSizeError, "字級誤差").toBeLessThan(0.05);
    expect(Math.abs(outcome.dyEm), "y 誤差").toBeLessThan(0.05);
  });

  it("整框被塗成一塊實心色（字墨量測無效）時，不得放大文字", async () => {
    const ink = await inkRect(SPEC);
    const blob: Decoration = {
      x: ink.x - 20,
      y: ink.y - 20,
      width: ink.width + 40,
      height: ink.height + 40,
      color: "#111111",
    };
    const { outcome } = await runWithDecorations(SPEC, [blob]);
    // 量不到可信字墨時只能退回偵測框粗估，但「寧可偏小不偏大」必須成立。
    expect(outcome.refined.fontSize).toBeLessThanOrEqual(SPEC.fontSize * 1.05);
  });
});

// 字型環境壞掉（缺 CJK fallback）時的降級行為：`refineOcrBoxes` 逐框退回偵測框幾何
// 並記錄原因，不讓整批一起 reject 把抽離文字的 API 打成 500；
// `resnapWithFinalFonts` 則相反——它是「精修的精修」，失敗時由呼叫端決定要不要沿用
// 前一輪的結果，所以維持往上拋。
describe("量測失敗的安全退路", () => {
  const broken: TextMetricsProvider = {
    measure: async () => {
      throw new Error("TEXT_METRICS_NO_INK: 模擬字型環境不可用");
    },
  };

  it("字墨量測失敗時，退回偵測框幾何而不是整批失敗", async () => {
    const slide = await renderSlide([SPEC]);
    const result = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
      metrics: broken,
    });
    const detection = slide.detections[0]!;
    const box = result.boxes[0]!;
    expect(box.text).toBe(SPEC.text);
    expect(box.x).toBeCloseTo(detection.x, 5);
    expect(box.width).toBeCloseTo(detection.width, 5);
  });

  it("字型定案後重解幾何若失敗，維持精修前的框（不可半套用）", async () => {
    const slide = await renderSlide([SPEC, { ...SPEC, y: 400, fontSize: 28 }]);
    const refined = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    const before = refined.boxes.map((box) => ({ ...box }));
    const styled = refined.boxes.map((box) => ({ ...box, fontFamily: "serif", fontWeight: 700 }));
    await expect(
      resnapWithFinalFonts(styled, refined.inkGeometry, { metrics: broken }),
    ).rejects.toThrow(/TEXT_METRICS_NO_INK/);
    // 呼叫端（app.ts）以 try/catch 保留精修前的 boxes：這裡確認 resnap 不會就地改寫。
    expect(refined.boxes).toEqual(before);
  });

  it("重解幾何失敗時，模型判定的 role／color／字型仍須保留並回報原因", async () => {
    // 抓的 bug：extract-text 端點把「樣式精修」與「以最終字型重解幾何」包在同一個
    // catch 裡，且 boxes 只在重解成功後才被賦值。重解失敗（字型環境壞掉）會讓整批
    // role 一起遺失、所有框退回 presentation——抹除遮罩就會把 logo 與插圖裡的
    // 數字徽章一併抹掉，而使用者端沒有任何訊號。
    const slide = await renderSlide([SPEC, { ...SPEC, y: 400, fontSize: 28 }]);
    const refined = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    const styles = new Map<string, Partial<EditableTextBox>>(
      refined.boxes.map((box, index) => [
        box.id,
        { role: index === 0 ? "logo" : "presentation", color: "#ff8800", fontFamily: "serif" },
      ]),
    );
    const failed = await applyStyleRefinement(refined.boxes, styles, refined.inkGeometry, {
      metrics: broken,
    });
    expect(failed.resnapError, "重解失敗必須回報原因，不可靜默").toMatch(/TEXT_METRICS_NO_INK/);
    expect(failed.boxes.map((box) => box.role)).toEqual(["logo", "presentation"]);
    expect(failed.boxes.every((box) => box.color === "#ff8800")).toBe(true);
    // 幾何停在精修後的狀態（樣式落地不會動幾何），而不是整批退回未精修的偵測框。
    failed.boxes.forEach((box, index) => {
      expect(box.fontSize).toBeCloseTo(refined.boxes[index]!.fontSize, 5);
    });

    // 對照組：重解成功時同樣保留樣式，並且不回報錯誤。
    const ok = await applyStyleRefinement(refined.boxes, styles, refined.inkGeometry);
    expect(ok.resnapError).toBeUndefined();
    expect(ok.boxes.map((box) => box.role)).toEqual(["logo", "presentation"]);
  });
});

describe("字型定案後重解幾何", () => {
  const specs: readonly RoundTripSpec[] = [
    { text: "AI-Ready API Security", fontSize: 76, x: 120, y: 90 },
    { text: "身分與最小權限", fontSize: 30, x: 120, y: 300 },
    { text: "只開放必要工具，並以白名單控管呼叫範圍", fontSize: 22, x: 120, y: 400 },
  ];

  async function refineSlide() {
    const slide = await renderSlide(specs);
    const refined = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    return { slide, refined };
  }

  for (const fontFamily of ["serif", "monospace"]) {
    for (const fontWeight of [400, 700]) {
      it(`模型把字型改成 ${fontFamily}/${fontWeight} 後，幾何跟著更新且不溢出`, async () => {
        const { slide, refined } = await refineSlide();
        const styled: EditableTextBox[] = refined.boxes.map((box) => ({
          ...box,
          fontFamily,
          fontWeight,
        }));
        const resnapped = await resnapWithFinalFonts(styled, refined.inkGeometry);
        const outcomes = await compareToTruth(specs, slide, resnapped);
        for (const outcome of outcomes) {
          // 幾何必須與最終字型一致：框寬恰好等於該字型的前進寬。
          expect(
            outcome.renderedWidth / outcome.refined.width,
            `${outcome.spec.text} 渲染寬 ÷ 框寬`,
          ).toBeCloseTo(1, 2);
          expect(
            outcome.overflowVsDetection,
            `${outcome.spec.text} 渲染寬 ÷ 偵測框寬`,
          ).toBeLessThanOrEqual(1.05);
          expect(outcome.refined.fontWeight, "字重不得被字級啟發式覆寫").toBe(fontWeight);
          expect(Math.abs(outcome.dxEm), `${outcome.spec.text} x 誤差`).toBeLessThan(0.15);
          expect(Math.abs(outcome.dyEm), `${outcome.spec.text} y 誤差`).toBeLessThan(0.15);
        }
      });
    }
  }

  it("換到量測結果不同的字族時，字級確實跟著改變（resnap 不是空轉）", async (context) => {
    const probe = { text: "AI-Ready API Security", fontWeight: 400, lineHeight: 1.2 };
    const [arial, serif] = await Promise.all(
      ["Arial", "serif"].map((fontFamily) => defaultTextMetrics.measure({ ...probe, fontFamily })),
    );
    if (Math.abs(arial!.advance / serif!.advance - 1) < 0.02) return context.skip(); // 這台機器上 serif 解析到與 Arial 相同的字型，無從比較。
    const { refined } = await refineSlide();
    const styled = refined.boxes.map((box) => ({ ...box, fontFamily: "serif" }));
    const resnapped = await resnapWithFinalFonts(styled, refined.inkGeometry);
    // 框寬幾乎與字型無關（advance ≈ 字墨寬，而字墨寬是原圖證據）；
    // 真正跟著字型走的是字級——這正是「算一套、渲染另一套」會出事的地方。
    const before = refined.boxes[0]!.fontSize;
    const after = resnapped[0]!.fontSize;
    expect(Math.abs(after / before - 1)).toBeGreaterThan(0.01);
  });
});

/**
 * 抹除遮罩必須蓋住整行的墨。
 *
 * 字墨量測會把行首／行尾的細條剔掉，那是為了讓「原圖量到的」與「樣本量到的」
 * 是同一個量。但抹除遮罩要的是另一件事：把原圖上屬於這行文字的墨清乾淨。
 * 被剔掉的細條若其實是 I／l／1 這類窄字形，它仍在原圖上——遮罩沒蓋到，
 * 抽離後的背景就會在行首／行尾留下一條殘墨（畫面上看得到的鬼影）。
 * 反過來，剔掉的若是卡片分隔線，遮罩就不能擴出去，否則會把設計元素抹掉。
 */
describe("抹除遮罩涵蓋被剔除的窄字形", () => {
  // 「邊緣細條」門檻是 fontSize × 0.12，所以這是小字級才踩得到的現象：
  // 30px 的 I 只有 4px 寬、門檻 3.6px，偵測框的字級初估再偏大一點就會被掃進去；
  // 同樣的字在 42px 下門檻升到 5.04px 就不會觸發。實測掃描過的觸發組合見下。
  const NARROW: RoundTripSpec[] = [
    { text: "重點：I", fontSize: 30, detectionScale: 1.15 },
    { text: "架構 I", fontSize: 30, detectionScale: 1.15 },
    { text: "I 型組織", fontSize: 30, detectionScale: 1.15 },
    { text: "l 型組織", fontSize: 30 },
  ];

  for (const spec of NARROW) {
    it(`「${spec.text}」被剔掉的字形仍在遮罩範圍內`, async () => {
      const slide = await renderSlide([{ ...spec, x: 200, y: 300 }]);
      const detection = slide.detections[0]!;
      const { maskRects, inkGeometry } = await refineOcrBoxes(slide.detections, {
        sourceTexts: [],
        image: slide.image,
      });
      // 先確認這個案例真的踩到剔除，否則斷言是空的。
      const dropped = inkGeometry.get(detection.id)!.dropped;
      expect(dropped.leading + dropped.trailing, "此案例必須真的觸發邊緣剔除").toBeGreaterThan(0);

      // 獨立 oracle：原圖上這一行真正有墨的範圍，不經過任何量測邏輯。
      const truth = slide.truths[0]!;
      const ink = inkBBox(
        slide.image,
        { x: truth.x - 60, y: truth.y - 30, width: truth.width + 120, height: truth.height + 60 },
        slide.background,
      )!;
      const mask = maskRects.get(detection.id)!;
      expect(mask.x, "遮罩左緣").toBeLessThanOrEqual(ink.x);
      expect(mask.x + mask.width, "遮罩右緣").toBeGreaterThanOrEqual(ink.x + ink.width);
    });
  }

  it("剔掉的是卡片分隔線時，遮罩不得擴出去抹掉它", async () => {
    const spec: RoundTripSpec = {
      text: "盤點API、Agent、工具與資料流",
      fontSize: 42,
      x: 200,
      y: 300,
    };
    const slide = await renderSlide([spec]);
    const truth = slide.truths[0]!;
    // 分隔線緊貼行尾，且落在偵測框的 unclip 外擴範圍內。
    const divider: Decoration = {
      x: Math.round(truth.x + truth.width + 12),
      y: Math.round(truth.y),
      width: 3,
      height: Math.round(truth.height),
    };
    const withDivider = await renderSlide([spec], { decorations: [divider] });
    const detection = withDivider.detections[0]!;
    const { maskRects } = await refineOcrBoxes(withDivider.detections, {
      sourceTexts: [],
      image: withDivider.image,
    });
    const mask = maskRects.get(detection.id)!;
    expect(mask.x + mask.width, "遮罩右緣不得吃到分隔線").toBeLessThanOrEqual(divider.x);
  });
});

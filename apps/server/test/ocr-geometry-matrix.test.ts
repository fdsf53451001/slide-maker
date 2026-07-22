import { describe, expect, it } from "vitest";
import type { EditableTextBox } from "@slide-maker/core";
import { refineOcrBoxes, resnapWithFinalFonts } from "../src/ocr-refine.js";
import { defaultTextMetrics, type TextMetricsProvider } from "../src/text-metrics.js";
import { FAKE_PAGE, ALIGNED_PAGE } from "./helpers/qa-fake-page.js";
import {
  assertRoundTrip,
  compareToTruth,
  inkBBox,
  renderRaster,
  renderSlide,
  runRoundTrip,
  type RoundTripSpec,
} from "./helpers/text-roundtrip.js";

/**
 * 字級還原矩陣：把「抽離文字」最容易跑版的字形組合各跑一次 round trip。
 *
 * 期望值一律由渲染推導（真值字級／真值錨點／同一份量測器算出的前進寬），
 * 檔案裡沒有任何寫死的像素或 em 常數：換機器、換字型都不會假性失敗，
 * 但只要字級反推與渲染脫節就會被抓到。
 */
const MATRIX: readonly (RoundTripSpec & { why: string })[] = [
  {
    why: "純小寫：只有 x-height，字墨高遠低於任何以大寫為準的常數",
    text: "some lowercase text",
    fontSize: 40,
  },
  {
    why: "純大寫：沒有下伸部也沒有 x-height 以下的墨，字墨高是另一個極端",
    text: "MCP / TOOL ALLOW",
    fontSize: 48,
  },
  {
    why: "數字與全形標點混排：半形數字與全形冒號的前進寬差一倍",
    text: "2024 年 Q3：營收成長 18%",
    fontSize: 36,
  },
  { why: "極小字級：字墨只有十幾像素，量化誤差佔比最大", text: "Executive summary", fontSize: 18 },
  {
    why: "極大字級：反推若有加性偏移，在這裡會被放大成可見誤差",
    text: "Executive summary",
    fontSize: 140,
  },
  { why: "單一拉丁字元：inkWidth 只有一個字形，bearing 佔比最高", text: "A", fontSize: 60 },
  { why: "單一 CJK 字元：全形字的 advance 與 inkWidth 差距最大", text: "圖", fontSize: 60 },
  {
    why: "很長的一行 CJK（>30 字）：誤差會沿著行長累積成整行溢出",
    text: "本頁彙整了本季度所有跨部門專案的進度、風險、決議事項與後續行動項目及負責人",
    fontSize: 26,
  },
  {
    why: "很長的一行拉丁（>40 字）：kerning 與空白寬度的累積誤差",
    text: "Quarterly review of every cross functional initiative and its accountable owner",
    fontSize: 26,
  },
];

describe("字級還原矩陣", () => {
  for (const testCase of MATRIX) {
    it(`還原「${testCase.text}」@${testCase.fontSize}（${testCase.why}）`, async () => {
      const { outcomes } = await runRoundTrip([testCase]);
      // 字級誤差 <5%、x/y 誤差 <0.05em、渲染寬 ≤ 框寬 ×1.05、且不得撐出偵測框。
      assertRoundTrip(outcomes[0]!);
    });
  }

  it("字級反推是線性的：同一串文字從 18px 到 140px，還原比例的離散度 <2%", async () => {
    const ratios: number[] = [];
    for (const fontSize of [18, 30, 60, 100, 140]) {
      const { outcomes } = await runRoundTrip([{ text: "Executive summary", fontSize }]);
      const outcome = outcomes[0]!;
      assertRoundTrip(outcome);
      ratios.push(outcome.refined.fontSize / fontSize);
    }
    // 有加性偏移（例如把 unclip 常數當成字墨的一部分）時，小字級的比例會明顯偏離大字級。
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.02);
  });

  it("同一字串的 bold 與 regular 各自還原，且字重確實改變前進寬", async () => {
    const text = "Executive summary";
    const [regular, bold] = await Promise.all(
      [400, 700].map((fontWeight) =>
        defaultTextMetrics.measure({ text, fontFamily: "Arial", fontWeight, lineHeight: 1.2 }),
      ),
    );
    // 前提：這台機器上的字重真的有寬度差，否則下面兩個 round trip 是同一個案例。
    expect(bold!.advance).toBeGreaterThan(regular!.advance * 1.01);
    for (const fontWeight of [400, 700]) {
      const { outcomes } = await runRoundTrip([{ text, fontSize: 40, fontWeight }]);
      expect(outcomes[0]!.refined.fontWeight, `字重 ${fontWeight} 應被還原`).toBe(fontWeight);
      assertRoundTrip(outcomes[0]!);
    }
  });

  it("置中／靠右的框：錨點推導正確（框寬遠大於文字時最容易看出錯誤）", async () => {
    for (const spec of ALIGNED_PAGE) {
      const { outcomes } = await runRoundTrip([spec]);
      // slack 讓文字起點離開框左緣 90–210px；錨點推錯的話 x 誤差會是這個量級。
      assertRoundTrip(outcomes[0]!);
    }
  });
});

/**
 * 抓的 bug（回歸）：`measureInk` 會把貼在左右邊緣的細條剔掉（本意是排除卡片的
 * 「｜」分隔線），但量測樣本那一側不剔——兩邊量的不是同一個量，於是以 I／l／1／：
 * 這類窄字形開頭或結尾的行，原圖側少量到一截，字級被壓小 14–22%。
 *
 * 而且它是**刀鋒式**的：剔除門檻是 `偵測框估計字級 × 0.12`，估計偏高一點窄字形就
 * 突然被剔掉。`boxesFromOcr` 的初估（框高 × 0.78）實務上正落在會觸發的那一側，
 * 所以這是常態路徑而不是邊角案例——倍率掃描就是為了鎖住這個刀鋒。
 */
describe("窄字形開頭／結尾的行", () => {
  const NARROW_EDGE = ["架構 I", "I 型組織", "l 型組織", "重點：I", "資料 1"] as const;
  const DETECTION_SCALES = [0.85, 0.95, 1.05, 1.15] as const;

  // 整個矩陣放在同一個 it 裡：每格都要渲染一張假原圖，拆成 20 個 it 只會讓
  // 整個測試套件互相搶 CPU，失敗定位改由每一條斷言的標籤負責。
  it("窄字形在頭尾時，偵測初估倍率掃過門檻也不得改變字級", async () => {
    for (const text of NARROW_EDGE) {
      for (const detectionScale of DETECTION_SCALES) {
        const { outcomes } = await runRoundTrip([{ text, fontSize: 36, detectionScale }]);
        const outcome = outcomes[0]!;
        expect(
          outcome.fontSizeError,
          `「${text}」偵測初估 ${detectionScale}x 的字級誤差`,
        ).toBeLessThan(0.05);
        expect(Math.abs(outcome.dxEm), `「${text}」${detectionScale}x 的 x 誤差`).toBeLessThan(
          0.05,
        );
        expect(
          outcome.overflowVsDetection,
          `「${text}」${detectionScale}x 的渲染寬 ÷ 偵測框寬`,
        ).toBeLessThanOrEqual(1.05);
      }
    }
  });

  it("剔除仍然有效：緊貼右側的分隔線不得被算進字寬", async () => {
    // 另一半的守門：邊緣細條的剔除本來就是為了排除分隔線。修法若只是「不再剔除」，
    // 這一條就會失敗——分隔線會被當成字墨，字級跟著被撐大。
    const spec: RoundTripSpec = { text: "身分與最小權限", fontSize: 36, x: 200, y: 120 };
    const probe = await renderSlide([spec]);
    const ink = inkBBox(probe.image, {
      x: 0,
      y: 0,
      width: probe.canvas.width,
      height: probe.canvas.height,
    })!;
    const slide = await renderSlide([spec], {
      decorations: [{ x: ink.x + ink.width + 5, y: ink.y, width: 3, height: ink.height }],
    });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    assertRoundTrip((await compareToTruth([spec], slide, boxes))[0]!);
  });
});

/**
 * 抓的 bug（回歸）：`snapBoxToInk` 在字重翻轉後只重解一次就回傳，不檢查結果是否自洽。
 * 量測噪音把 400 解出的字級推過粗體門檻 → 翻成 700 → 用 Bold metrics 重解得到更小的
 * 字級 → 回傳「字重 700」配上一個依同一條啟發式應該是 400 的字級，兩邊都不對，
 * 實測在門檻附近（40–42px，簡報副標與卡片標題的高發區）字級低估 6–11%。
 *
 * 這裡釘住的不變式：最終的 (fontSize, fontWeight) 必須滿足
 * `fontSize ≈ 字墨寬 ÷ metrics(text, family, fontWeight).inkWidth`。
 */
describe("粗體門檻附近的字級與字重自洽", () => {
  const SIZES = [36, 38, 40, 41, 42, 44, 48] as const;

  async function solve(spec: RoundTripSpec) {
    const slide = await renderSlide([spec]);
    const { boxes, inkGeometry } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    const refined = boxes[0]!;
    const ink = inkBBox(slide.image, {
      x: 0,
      y: 0,
      width: slide.canvas.width,
      height: slide.canvas.height,
    })!;
    return { slide, refined, ink, inkGeometry, boxes };
  }

  /** 幾何自洽：以最終字重量到的字墨寬，必須正好解回最終字級。 */
  async function selfConsistency(refined: EditableTextBox, inkWidth: number) {
    const glyph = await defaultTextMetrics.measure({
      text: refined.text,
      fontFamily: refined.fontFamily,
      fontWeight: refined.fontWeight,
      lineHeight: refined.lineHeight,
    });
    return Math.abs(refined.fontSize - inkWidth / glyph.inkWidth) / refined.fontSize;
  }

  const TEXTS = ["Item", "重點整理"] as const;

  it("最終的字級與字重必須互相支持（拉丁與 CJK、兩種字重、門檻上下）", async () => {
    for (const text of TEXTS) {
      for (const fontWeight of [400, 700] as const) {
        for (const fontSize of SIZES) {
          const { refined, ink } = await solve({ text, fontSize, fontWeight });
          expect(
            await selfConsistency(refined, ink.width),
            `「${text}」${fontSize}px/${fontWeight}：字級與字重不自洽`,
          ).toBeLessThan(0.01);
        }
      }
    }
  });

  it("常規字重的原稿：門檻附近不得被誤判成粗體而縮小字級", async () => {
    for (const text of TEXTS) {
      for (const fontSize of SIZES) {
        const { refined } = await solve({ text, fontSize, fontWeight: 400 });
        expect(
          Math.abs(refined.fontSize - fontSize) / fontSize,
          `「${text}」${fontSize}px/400 的字級誤差`,
        ).toBeLessThan(0.05);
      }
    }
  });

  it("粗體原稿：樣式精修定案字重後重解，字級誤差 <5% 且仍自洽", async () => {
    // 粗體原稿在**字級低於粗體門檻**時，OCR 這一側沒有任何證據可判字重
    //（字墨高幾乎不隨字重改變），字級因此偏大約一個字重寬度比。管線的設計是
    // 讓樣式精修的模型定案字重，再以最終字重重解一次——這一條驗的就是那條路。
    for (const text of TEXTS) {
      for (const fontSize of SIZES) {
        const spec: RoundTripSpec = { text, fontSize, fontWeight: 700 };
        const { slide, boxes, inkGeometry, ink } = await solve(spec);
        const resnapped = await resnapWithFinalFonts(
          boxes.map((box) => ({ ...box, fontWeight: 700 })),
          inkGeometry,
        );
        const refined = resnapped[0]!;
        const label = `「${text}」${fontSize}px/700`;
        expect(refined.fontWeight, `${label} 字重`).toBe(700);
        expect(await selfConsistency(refined, ink.width), `${label} 自洽`).toBeLessThan(0.01);
        expect(Math.abs(refined.fontSize - fontSize) / fontSize, `${label} 字級誤差`).toBeLessThan(
          0.05,
        );
        expect(
          (await compareToTruth([spec], slide, resnapped))[0]!.overflowVsDetection,
          `${label} 渲染寬 ÷ 偵測框寬`,
        ).toBeLessThanOrEqual(1.05);
      }
    }
  });
});

const LINE_HEIGHT = 1.2;

function customBox(overrides: Partial<EditableTextBox> & { id: string }): EditableTextBox {
  return {
    text: "",
    x: 120,
    y: 120,
    width: 400,
    height: 60,
    fontFamily: "Arial",
    fontSize: 32,
    fontWeight: 400,
    color: "#111111",
    opacity: 1,
    lineHeight: LINE_HEIGHT,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 0.9,
    role: "presentation",
    ...overrides,
  };
}

/**
 * 共用骨架的 `renderSlide` 只造「框高＝一行行框」的框，模不出 verticalAlign 與
 * letterSpacing——前者要有多餘高度才看得出差別，後者不在 spec 裡。這裡直接渲染
 * 一個任意的真值框，用實際字墨反推偵測框（等價於 `boxesFromOcr` 的規則），
 * 再把精修結果重新渲染一次，比對字墨落點：完全不需要任何常數。
 */
async function roundTripCustomBox(
  truth: EditableTextBox,
  canvas: { width: number; height: number },
  unclip = 6,
): Promise<{
  refined: EditableTextBox;
  truthInk: { x: number; y: number; width: number; height: number };
  refinedInk: { x: number; y: number; width: number; height: number };
}> {
  const full = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const image = await renderRaster([truth], canvas);
  const truthInk = inkBBox(image, full);
  if (!truthInk) throw new Error("真值框沒有渲染出任何字墨");
  const height = truthInk.height + unclip * 2;
  const detection = customBox({
    ...truth,
    id: "detection",
    x: truthInk.x - unclip,
    y: truthInk.y - unclip,
    width: truthInk.width + unclip * 2,
    height,
    // 與 boxesFromOcr 相同的粗估：字級與字重都只從框高猜。
    fontSize: Math.max(10, Math.min(180, height * 0.78)),
    fontWeight: height >= 52 ? 700 : 400,
    verticalAlign: "top",
  });
  const { boxes } = await refineOcrBoxes([detection], { sourceTexts: [], image });
  const refined = boxes[0]!;
  const refinedInk = inkBBox(await renderRaster([refined], canvas), full);
  if (!refinedInk) throw new Error("精修後的框沒有渲染出任何字墨");
  return { refined, truthInk, refinedInk };
}

describe("框內垂直對齊與字距", () => {
  for (const verticalAlign of ["top", "middle", "bottom"] as const) {
    it(`verticalAlign=${verticalAlign} 的框：精修後重新渲染，字墨落在原位`, async () => {
      const glyph = await defaultTextMetrics.measure({
        text: "Card body copy",
        fontFamily: "Arial",
        fontWeight: 400,
        lineHeight: LINE_HEIGHT,
      });
      const truth = customBox({
        id: "truth",
        text: "Card body copy",
        fontSize: 32,
        // 框高遠大於一行行框，verticalAlign 才有作用空間。
        height: 200,
        width: glyph.advance * 32,
        verticalAlign,
      });
      const canvas = { width: Math.ceil(truth.x + truth.width + 120), height: 420 };
      const { refined, truthInk, refinedInk } = await roundTripCustomBox(truth, canvas);
      expect(Math.abs(refinedInk.x - truthInk.x), "字墨左緣位移(px)").toBeLessThanOrEqual(2);
      expect(Math.abs(refinedInk.y - truthInk.y), "字墨頂緣位移(px)").toBeLessThanOrEqual(2);
      expect(refinedInk.width / truthInk.width).toBeGreaterThan(0.95);
      expect(refinedInk.width / truthInk.width).toBeLessThan(1.05);
      expect(refined.fontSize / truth.fontSize).toBeGreaterThan(0.95);
      expect(refined.fontSize / truth.fontSize).toBeLessThan(1.05);
    });
  }

  // 已知缺陷（見回報）：ocr-refine 的 solveBoxGeometry／finalizeFontSizes 呼叫
  // metrics.measure 時沒有帶上 box.letterSpacing，量到的 advance／inkWidth 是
  // letterSpacing=0 的值，多出來的字距會被誤算成「字比較大」。目前的管線裡
  // letterSpacing 恆為 0 所以還沒炸開，但 TextMetricsRequest 已經有這個欄位，契約是斷的。
  it("letterSpacing 非零的框：字級與位置仍須還原", async () => {
    const letterSpacing = 6;
    const fontSize = 40;
    const text = "SPACED TITLE";
    // 真值框寬 = 無字距的前進寬 + 每個字元間隙的字距（EditableTextBox.letterSpacing 是 px）。
    // 這裡刻意不透過 metrics 的 letterSpacing 參數推算：那個參數的單位在實作裡是
    // 「樣本 100px 字級下的 px」而非 em，本身就是另一個待釐清的契約問題。
    const glyph = await defaultTextMetrics.measure({
      text,
      fontFamily: "Arial",
      fontWeight: 700,
      lineHeight: LINE_HEIGHT,
    });
    const truth = customBox({
      id: "truth",
      text,
      fontSize,
      fontWeight: 700,
      letterSpacing,
      width: glyph.advance * fontSize + letterSpacing * ([...text].length - 1),
      height: fontSize * LINE_HEIGHT,
    });
    const canvas = { width: Math.ceil(truth.x + truth.width + 120), height: 300 };
    const { refined, truthInk, refinedInk } = await roundTripCustomBox(truth, canvas);
    expect(refined.letterSpacing, "字距不得被精修丟掉").toBe(letterSpacing);
    expect(refined.fontSize / fontSize, "字級不得被高估").toBeLessThan(1.05);
    expect(refined.fontSize / fontSize, "字級不得被低估").toBeGreaterThan(0.95);
    expect(refinedInk.width / truthInk.width, "字墨寬不得撐出原範圍").toBeLessThan(1.05);
  });

  it("TextMetricsRequest.letterSpacing 是 em：字級無關的比例，不是樣本畫布上的 px", async () => {
    // 抓的 bug：`sampleBox` 直接把 request.letterSpacing 當成樣本（fontSize=100）
    // 的 px 用。呼叫端手上的字距是「目標字級下的 px」，兩者差了 fontSize/100 倍，
    // 契約不講清楚就會像先前那樣：字距 6px/40px 的框字級被高估 23%。
    const text = "SPACED TITLE";
    const common = { text, fontFamily: "Arial", fontWeight: 700, lineHeight: LINE_HEIGHT };
    const [plain, spaced] = await Promise.all([
      defaultTextMetrics.measure(common),
      defaultTextMetrics.measure({ ...common, letterSpacing: 0.25 }),
    ]);
    // 每個字元後面加 0.25em；字墨寬只多出字元間隙（末尾那一份不算進字墨）。
    const gaps = [...text].length - 1;
    expect(spaced!.inkWidth - plain!.inkWidth).toBeCloseTo(gaps * 0.25, 1);
  });
});

describe("不溢出不變式", () => {
  it("多框假投影片：每一個輸出框的渲染寬都不超過框寬與偵測框", async () => {
    const slide = await renderSlide(FAKE_PAGE, { minCanvas: { width: 1920, height: 1080 } });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    expect(boxes).toHaveLength(FAKE_PAGE.length);
    const outcomes = await compareToTruth(FAKE_PAGE, slide, boxes);
    for (const outcome of outcomes) {
      // 「跑版」的直接定義：文字撐出自己的框，或撐出 OCR 當初框到的範圍。
      expect(
        outcome.renderedWidth / outcome.refined.width,
        `${outcome.spec.text} 渲染寬 ÷ 框寬`,
      ).toBeLessThanOrEqual(1.05);
      expect(
        outcome.overflowVsDetection,
        `${outcome.spec.text} 渲染寬 ÷ 偵測框寬`,
      ).toBeLessThanOrEqual(1.05);
      expect(outcome.fontSizeError, `${outcome.spec.text} 字級誤差`).toBeLessThan(0.05);
      expect(Math.abs(outcome.dxEm), `${outcome.spec.text} x 誤差`).toBeLessThan(0.05);
      expect(Math.abs(outcome.dyEm), `${outcome.spec.text} y 誤差`).toBeLessThan(0.05);
    }
  });

  it("置中／靠右混排的整頁也不溢出（錨點推導錯誤會同時推高誤差與溢出）", async () => {
    const slide = await renderSlide(ALIGNED_PAGE);
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    for (const outcome of await compareToTruth(ALIGNED_PAGE, slide, boxes))
      assertRoundTrip(outcome);
  });
});

describe("常數退化守門", () => {
  // 這一組斷言的用途：任何人想把字墨高改回固定常數（latinInkHeight=0.74 之類）時，
  // 這裡會先失敗。字墨高是「字串內容」的函數，不是「字種」的函數。
  it("含下伸部與不含下伸部的字串，實測字墨高比例差 >10%", async () => {
    const common = { fontFamily: "Arial", fontWeight: 400, lineHeight: LINE_HEIGHT };
    const withDescender = await defaultTextMetrics.measure({
      ...common,
      text: "AI-Ready API Security",
    });
    const flat = await defaultTextMetrics.measure({ ...common, text: "MCP / TOOL ALLOW" });
    expect(withDescender.inkHeight / flat.inkHeight).toBeGreaterThan(1.1);
  });

  it("x-height、大寫、含下伸部三種拉丁字串的字墨高逐級遞增且相差 >10%", async () => {
    const common = { fontFamily: "Arial", fontWeight: 400, lineHeight: LINE_HEIGHT };
    // 只有 x-height 的字串（沒有上伸部 b/d/f/h/k/l/t、沒有下伸部 g/j/p/q/y，
    // 也沒有 i/j 的點——那個點幾乎頂到上伸部高度）。
    const xHeight = await defaultTextMetrics.measure({
      ...common,
      text: "moon rose across neon seas",
    });
    const upper = await defaultTextMetrics.measure({ ...common, text: "MCP TOOL ALLOW" });
    const descender = await defaultTextMetrics.measure({ ...common, text: "paging query graph" });
    expect(upper.inkHeight / xHeight.inkHeight).toBeGreaterThan(1.1);
    expect(descender.inkHeight / upper.inkHeight).toBeGreaterThan(1.1);
  });

  it("CJK 與拉丁的字墨高也不是同一個常數", async () => {
    const common = { fontFamily: "Arial", fontWeight: 400, lineHeight: LINE_HEIGHT };
    const cjk = await defaultTextMetrics.measure({ ...common, text: "身分與最小權限" });
    const latin = await defaultTextMetrics.measure({ ...common, text: "MCP TOOL ALLOW" });
    expect(cjk.inkHeight / latin.inkHeight).toBeGreaterThan(1.1);
  });

  it("同一字串的字墨高會隨字重改變（連「同字串同常數」都不成立）", async () => {
    const common = { fontFamily: "Arial", lineHeight: LINE_HEIGHT, text: "Executive summary" };
    const regular = await defaultTextMetrics.measure({ ...common, fontWeight: 400 });
    const bold = await defaultTextMetrics.measure({ ...common, fontWeight: 700 });
    expect(bold.inkWidth).toBeGreaterThan(regular.inkWidth * 1.01);
  });
});

describe("量測成本", () => {
  // 每次量測都是一張 sharp 渲染（實測約 10ms／不重複字串），密集版面一頁可有數十框，
  // 而且樣式精修之後還會用最終字型再解一次。這條把「每框的量測次數」釘住，
  // 擋掉未來在迴圈裡反覆量測（例如逐像素二分搜尋字級）這類 O(n²) 的改法。
  it("每個框的字形量測次數有上界（精修與重解各不超過每框 3 次）", async () => {
    const specs: RoundTripSpec[] = Array.from({ length: 24 }, (_, index) => ({
      text: `第 ${index + 1} 條說明文字 item ${index}`,
      fontSize: 20 + (index % 5),
      x: 100 + (index % 4) * 440,
      y: 80 + Math.floor(index / 4) * 90,
    }));
    const slide = await renderSlide(specs);
    let calls = 0;
    const counting: TextMetricsProvider = {
      measure: async (request) => {
        calls += 1;
        return defaultTextMetrics.measure(request);
      },
    };
    const refined = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
      metrics: counting,
    });
    expect(refined.boxes).toHaveLength(specs.length);
    expect(calls, "精修階段的量測次數").toBeLessThanOrEqual(specs.length * 3);
    const before = calls;
    const styled = refined.boxes.map((box) => ({ ...box, fontFamily: "serif", fontWeight: 700 }));
    await resnapWithFinalFonts(styled, refined.inkGeometry, { metrics: counting });
    expect(calls - before, "重解階段的量測次數").toBeLessThanOrEqual(specs.length * 3);
  });
});

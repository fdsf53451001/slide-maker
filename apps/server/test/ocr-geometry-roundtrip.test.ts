import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { createProject } from "@slide-maker/core";
import { exportPresentation } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";
import { measureInk, refineOcrBoxes, resnapWithFinalFonts } from "../src/ocr-refine.js";
import { defaultTextMetrics, RenderedTextMetrics } from "../src/text-metrics.js";
import {
  assertRoundTrip,
  inkBBox,
  renderRaster,
  renderSlide,
  runRoundTrip,
  compareToTruth,
  type RoundTripSpec,
} from "./helpers/text-roundtrip.js";

// 實測 1920×1080 投影片上「字級系統性偏大」的框，以及必須不能回歸的正常框。
// 字級取自該頁的量測值（標題 75.6px、卡片標題 42.55px…）。
const CASES: readonly (RoundTripSpec & { why: string })[] = [
  {
    why: "含下伸部的拉丁標題：字墨高其實 0.95em，舊常數 0.74 讓字級高估 1.27 倍",
    text: "AI-Ready API Security",
    fontSize: 75.6,
  },
  {
    why: "CJK 夾拉丁下伸部：字墨高 1.05em，舊常數 0.94 讓字級高估 1.10 倍",
    text: "盤點API、Agent、工具與資料流",
    fontSize: 42.55,
  },
  {
    why: "無下伸部的拉丁行（舊常數剛好命中）——修好之後不得回歸",
    text: "MCP / Tool Allow-list",
    fontSize: 30,
  },
  {
    why: "純 CJK 行",
    text: "身分與最小權限",
    fontSize: 32,
  },
  {
    why: "CJK＋大寫拉丁混排（既有回歸案例：多數決會誤判成拉丁尺度）",
    text: "Kimi K3 模型研究",
    fontSize: 109,
  },
  {
    // 字墨高的另一個極端：整行只有 x-height（無上伸部、無下伸部、無大寫），
    // 字墨高只有 0.73em。任何「拉丁 = 0.74em」的固定常數在這裡剛好命中，
    // 但只要改成別的常數（例如為了修好含下伸部的標題而調大）就會讓這種行縮水。
    // 高度不可當主錨的反例，必須靠寬度錨定才能同時對得上兩個極端。
    why: "純小寫、只有 x-height 的行：字墨高僅 0.73em，是字墨高比例的下極端",
    text: "some lowercase text",
    fontSize: 30,
  },
  {
    // 半形數字（0.556em）、全形冒號（1em）、CJK（1em）、百分號混在同一行。
    // 舊實作靠「猜字種 → 套固定字寬表」推寬度，這種混排的加權必然失準；
    // 全形冒號還會讓 WIDE_CHAR 判定成立而整行被當成 CJK 尺度。
    why: "數字與全形標點混排：字種混雜，固定字寬表的加權必然失準",
    text: "2024 年 Q3：營收成長 18%",
    fontSize: 36,
  },
  {
    why: "極小字級（附註／來源標示）：字墨只有十來像素，量測誤差佔比最大",
    text: "資料來源：公司年報（2024）",
    fontSize: 18,
  },
  {
    why: "極大字級（封面主標）：字級遠超粗體門檻，且字墨寬達數百像素",
    text: "全球市場展望",
    fontSize: 140,
  },
];

describe("ink → geometry round trip", () => {
  for (const testCase of CASES) {
    it(`還原「${testCase.text}」的字級與位置（${testCase.why}）`, async () => {
      const { outcomes } = await runRoundTrip([testCase]);
      assertRoundTrip(outcomes[0]!);
    });
  }

  it("同一張投影片上的多個層級同時還原，且沒有任何一框溢出", async () => {
    const specs = CASES.map((testCase, index) => ({
      ...testCase,
      x: 120,
      y: 120 + index * 260,
    }));
    const { outcomes } = await runRoundTrip(specs);
    // 字級聚類會刻意把 12% 以內的層級貼成同一字級（這裡 30 與 32 會被併掉），
    // 因此整頁一起跑時字級容差放寬到 10%；「不溢出」則仍是硬不變式。
    for (const outcome of outcomes) assertRoundTrip(outcome, { fontSize: 0.1 });
  });

  it("字級聚類把字級往上拉時仍不得溢出", async () => {
    // 同層級但量測會有抖動的三行：聚類會把它們貼到同一字級。
    const specs: RoundTripSpec[] = [
      { text: "身分與最小權限", fontSize: 32, x: 120, y: 120 },
      { text: "資料最小化與遮蔽", fontSize: 33, x: 120, y: 260 },
      { text: "稽核軌跡與可追溯", fontSize: 34, x: 120, y: 400 },
    ];
    const { outcomes } = await runRoundTrip(specs);
    const sizes = new Set(outcomes.map((outcome) => outcome.refined.fontSize));
    expect(sizes.size).toBeLessThanOrEqual(2);
    for (const outcome of outcomes) {
      // 貼齊會讓字級偏離真值，但「不溢出」是硬不變式。
      expect(outcome.renderedWidth / outcome.refined.width).toBeLessThanOrEqual(1.05);
      expect(outcome.fontSizeError).toBeLessThan(0.1);
    }
  });

  it("以最終字型重解幾何：字重改變後字級與位置仍對得上", async () => {
    // 第一輪用 OCR 預設的 Arial/400 量字級；樣式精修把字重改成 700 之後，
    // 同一串文字的前進寬變寬約 6%，不重解就會沿用「算一套、渲染另一套」的字級。
    const spec: RoundTripSpec = { text: "MCP / Tool Allow-list", fontSize: 30, fontWeight: 700 };
    const slide = await renderSlide([spec]);
    const refined = await refineOcrBoxes(slide.detections, { sourceTexts: [], image: slide.image });
    const beforeResnap = (await compareToTruth([spec], slide, refined.boxes))[0]!;
    // 偵測框推出的字重是 400（框高 < 52px），與原圖的 700 不符 → 字級被低估。
    expect(beforeResnap.refined.fontWeight).toBe(400);
    expect(beforeResnap.fontSizeError).toBeGreaterThan(0.05);

    const styled = refined.boxes.map((box) => ({ ...box, fontWeight: 700 }));
    const resnapped = await resnapWithFinalFonts(styled, refined.inkGeometry);
    const after = (await compareToTruth([spec], slide, resnapped))[0]!;
    expect(after.refined.fontWeight).toBe(700);
    assertRoundTrip(after);
  });

  it("字墨被鄰行污染時退回較小的字級，不放大文字", async () => {
    const spec: RoundTripSpec = { text: "身分與最小權限", fontSize: 32, x: 120, y: 120 };
    const slide = await renderSlide([spec]);
    // 把偵測框往下拉長一整行，讓字墨帶可能吃進下方的雜訊。
    const stretched = slide.detections.map((box) => ({ ...box, height: box.height * 2.2 }));
    const { boxes } = await refineOcrBoxes(stretched, { sourceTexts: [], image: slide.image });
    const outcome = (await compareToTruth([spec], slide, boxes))[0]!;
    expect(outcome.refined.fontSize).toBeLessThanOrEqual(spec.fontSize * 1.05);
    expect(outcome.renderedWidth / outcome.refined.width).toBeLessThanOrEqual(1.05);
  });
});

describe("字級尺度與字重", () => {
  it("極小與極大字級都線性還原（18px 與 140px 用同一串文字）", async () => {
    // 抓的 bug：任何寫死的像素級補償（例如「字墨高固定多算 2px 反鋸齒」）在
    // 18px 上佔 11%、在 140px 上佔 1.4%，兩端一起測才看得出來是不是真的線性。
    const text = "全球市場展望";
    const small = (await runRoundTrip([{ text, fontSize: 18 }])).outcomes[0]!;
    const large = (await runRoundTrip([{ text, fontSize: 140 }])).outcomes[0]!;
    assertRoundTrip(small);
    assertRoundTrip(large);
    // 線性度：同一串文字放大 7.78 倍，還原出來的字級比值也必須是 7.78 倍。
    const ratio = large.refined.fontSize / small.refined.fontSize;
    expect(ratio).toBeGreaterThan((140 / 18) * 0.97);
    expect(ratio).toBeLessThan((140 / 18) * 1.03);
  });

  it("同字串 bold 與 regular 各以自己的字重還原（前進寬差約 6%）", async () => {
    // 抓的 bug：用 regular 的 metrics 去解 bold 原稿（或反之）。Arial Bold 的字墨寬
    // 比 Regular 寬約 6%，錯用字重就會把「字比較粗」誤讀成「字比較大」。
    const text = "Quality Report Deck";
    const fontSize = 34; // 低於粗體門檻，OCR 啟發式對兩者都會猜 400
    const bold = await defaultTextMetrics.measure({
      text,
      fontFamily: "Arial",
      fontWeight: 700,
      lineHeight: 1.2,
    });
    const regular = await defaultTextMetrics.measure({
      text,
      fontFamily: "Arial",
      fontWeight: 400,
      lineHeight: 1.2,
    });
    // 前提檢查：這個案例真的有鑑別力（字重確實改變前進寬），否則下面測不到東西。
    expect(bold.inkWidth / regular.inkWidth).toBeGreaterThan(1.04);

    for (const fontWeight of [400, 700] as const) {
      const spec: RoundTripSpec = { text, fontSize, fontWeight };
      const slide = await renderSlide([spec]);
      const refined = await refineOcrBoxes(slide.detections, {
        sourceTexts: [],
        image: slide.image,
      });
      // 樣式精修定案字重後重解一次；這是管線裡唯一會拿到真實字重的時機。
      const styled = refined.boxes.map((box) => ({ ...box, fontWeight }));
      const resnapped = await resnapWithFinalFonts(styled, refined.inkGeometry);
      assertRoundTrip((await compareToTruth([spec], slide, resnapped))[0]!);
    }

    // 反面：把 bold 原稿當成 regular 解，字級會被高估到 5% 以上——
    // 這正是「字級算一套、渲染另一套」的跑版來源。
    const boldSlide = await renderSlide([{ text, fontSize, fontWeight: 700 }]);
    const mistaken = await refineOcrBoxes(boldSlide.detections, {
      sourceTexts: [],
      image: boldSlide.image,
    });
    const wrong = (await compareToTruth([{ text, fontSize }], boldSlide, mistaken.boxes))[0]!;
    expect(wrong.refined.fontWeight).toBe(400);
    expect(wrong.fontSizeError).toBeGreaterThan(0.05);
  });
});

describe("對齊錨點推導", () => {
  // 框寬留 300px 餘裕，align 才會真的把文字推離框左緣；
  // 精修後的框寬恆等於前進寬（餘裕歸零），所以位置必須跟「文字起點」比而非框的 x。
  const ALIGNED: readonly RoundTripSpec[] = (["left", "center", "right"] as const).map((align) => ({
    text: "Quarterly Review",
    fontSize: 44,
    align,
    slack: 300,
    x: 100,
    y: 120,
  }));

  for (const spec of ALIGNED) {
    it(`align: ${spec.align} 的文字起點被正確還原`, async () => {
      // 抓的 bug：把「框的左上角」當成文字位置。center/right 對齊時文字並不從
      // 框左緣起筆，只有以字墨反推才對得上；用框座標會整行偏左 150–300px。
      const { outcomes } = await runRoundTrip([spec]);
      assertRoundTrip(outcomes[0]!);
    });
  }

  it("三種對齊在原圖上落在不同位置（確認案例有鑑別力）", async () => {
    const slide = await renderSlide(
      ALIGNED.map((spec, index) => ({ ...spec, y: 120 + index * 180 })),
    );
    const xs = slide.origins.map((origin) => Math.round(origin.x));
    expect(new Set(xs).size).toBe(3);
    // 餘裕 300px：center 推 150px、right 推 300px。
    expect(xs[1]! - xs[0]!).toBe(150);
    expect(xs[2]! - xs[0]!).toBe(300);
  });
});

describe("跨字型替代政策", () => {
  // 原稿字型 ≠ 精修宣告字型是實務常態（原圖用設計師的 serif，管線只認得 Arial）。
  // 這時不可能完全對齊，但幾何仍必須「可用」：不溢出、字級在合理範圍內。
  const SUBSTITUTIONS = [
    { source: "Times New Roman", declared: "Arial" },
    { source: "serif", declared: "Arial" },
  ] as const;

  for (const { source, declared } of SUBSTITUTIONS) {
    it(`來源 ${source} 以 ${declared} 精修：字級落在 ±20% 且寧可偏小`, async () => {
      const spec: RoundTripSpec = {
        text: "Annual Growth Summary 2024",
        fontSize: 36,
        fontFamily: source,
      };
      const { outcomes } = await runRoundTrip([spec], { refineFontFamily: declared });
      const outcome = outcomes[0]!;
      expect(outcome.refined.fontFamily).toBe(declared);
      expect(outcome.fontSizeError).toBeLessThan(0.2);
      // 替代字型（Arial）比來源 serif 寬，寬度錨定會解出略小的字級：
      // 對排版而言偏小只是留白變多，偏大則直接壓到相鄰元素。
      expect(outcome.refined.fontSize).toBeLessThanOrEqual(spec.fontSize);
      // 硬不變式：不論字型怎麼替代都不得撐出 OCR 框到的範圍。
      expect(outcome.overflowVsDetection).toBeLessThanOrEqual(1.05);
    });
  }

  it("反向替代（sans → serif）字級會偏大，但寬度錨定仍保證不溢出", async () => {
    // 「寧可偏小」不是結構性保證，而是「替代字型比來源寬」的副產物；
    // 方向反過來就會偏大。真正結構性的保證只有「不溢出」——因為字級是由
    // 字墨寬反推的，渲染寬必然回到原本的字墨寬。這條測試把界線寫清楚，
    // 免得日後有人把「偏小」當成不變式去依賴。
    const spec: RoundTripSpec = {
      text: "Annual Growth Summary 2024",
      fontSize: 36,
      fontFamily: "Arial",
    };
    const { outcomes } = await runRoundTrip([spec], { refineFontFamily: "Times New Roman" });
    const outcome = outcomes[0]!;
    expect(outcome.refined.fontSize).toBeGreaterThan(spec.fontSize);
    expect(outcome.fontSizeError).toBeLessThan(0.2);
    expect(outcome.overflowVsDetection).toBeLessThanOrEqual(1.05);
  });
});

describe("字墨量測的污染韌性", () => {
  it("深底白字：背景由區域邊框推得，反相配色不影響對位", async () => {
    // 抓的 bug：把「暗＝字墨」寫死。投影片有一半是深底淺字，若判準假設背景是白的，
    // 整個字墨帶會反過來量成「背景才是字墨」，字級與位置全錯。
    const spec: RoundTripSpec = {
      text: "深底白字的年度總結",
      fontSize: 48,
      color: "#f8fafc",
      x: 140,
      y: 140,
    };
    const { outcomes } = await runRoundTrip([spec], { slide: { background: "#0b1220" } });
    assertRoundTrip(outcomes[0]!);
  });

  it("卡片左邊框與文字有正常間距時被行剖面剔除", async () => {
    // 卡片左邊框是一條垂直細線。與字墨拉開間距時，`measureInk` 的行剖面會把它切成
    // 獨立的細元件並丟掉，寬度估計不受污染。
    const spec: RoundTripSpec = { text: "身分與最小權限", fontSize: 32, x: 200, y: 120 };
    const probe = await renderSlide([spec]);
    const detection = probe.detections[0]!;
    const inkLeft = Math.round(detection.x + 6);
    const slide = await renderSlide([spec], {
      decorations: [
        // 3px 寬、貫穿整張卡片高度的左邊框，右緣距字墨 12px。
        { x: inkLeft - 15, y: detection.y - 40, width: 3, height: detection.height + 80 },
      ],
    });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    assertRoundTrip((await compareToTruth([spec], slide, boxes))[0]!);
  });

  it("卡片左邊框緊貼文字時仍須以字墨對位，不得整框退回未精修的偵測框", async () => {
    // 實測疑似污染源：卡片左邊框緊貼文字（落在 OCR 偵測框的外擴範圍內）。
    // 這裡用實務比例的 unclip（偵測框高比字墨高多約 24%，與 ocr-refine 註解描述一致）。
    //
    // 期望：邊框被剔除、字級仍由字墨寬決定。
    // 現況：`measureInk` 的列剖面被這條「每一列都有墨」的垂直線佔滿，整條列帶被判為
    // 一個帶且高度超過 box.height×1.2 而回傳 null，整框退回未精修的偵測框幾何——
    // 字級變回 框高×0.78 的舊估計，正是這次要修掉的跑版。
    const spec: RoundTripSpec = {
      text: "身分與最小權限",
      fontSize: 32,
      x: 200,
      y: 120,
      unclipX: 10,
      unclipY: 10,
    };
    const probe = await renderSlide([spec]);
    const detection = probe.detections[0]!;
    const inkLeft = Math.round(detection.x + 10);
    const slide = await renderSlide([spec], {
      decorations: [
        { x: inkLeft - 9, y: detection.y - 40, width: 3, height: detection.height + 80 },
      ],
    });
    const { boxes } = await refineOcrBoxes(slide.detections, {
      sourceTexts: [],
      image: slide.image,
    });
    const outcome = (await compareToTruth([spec], slide, boxes))[0]!;
    // 根因定位：`measureInk` 在這張圖上直接回 null（列剖面每一列都被邊框佔到墨，
    // 整個搜尋區被判成單一字墨帶，高度超過 box.height×1.2 而放棄）。
    // 行剖面的「去邊緣細條」邏輯排在選帶之後，永遠等不到執行。
    expect.soft(measureInk(slide.image, slide.detections[0]!), "字墨量測結果").not.toBeNull();
    // soft：三條都要看到實際數字，才知道退回估計偏離多少。
    // 不放大：污染時寧可估小，也不能把文字撐大。
    expect
      .soft(outcome.refined.fontSize, "字級不得被放大")
      .toBeLessThanOrEqual(spec.fontSize * 1.05);
    // 硬不變式：文字不得撐出 OCR 框到的範圍。
    expect.soft(outcome.overflowVsDetection, "渲染寬 ÷ 偵測框寬").toBeLessThanOrEqual(1.05);
  });
});

describe("端對端整張對位", () => {
  it("多框假投影片：每行重繪後的字墨與原圖位移 <3px、寬高比 0.95–1.05", async () => {
    // 前面的斷言都在比「數字」；這一條直接比「像素」：把精修後的框用同一條合成路徑
    // 重畫一次，逐行掃出字墨外框與原圖對照。字級／位置／框寬任何一項算錯都會在這裡
    // 變成看得見的位移，也是使用者實際感受到的「跑版」定義。
    const specs: readonly RoundTripSpec[] = [
      { text: "AI-Ready API Security", fontSize: 75.6, x: 120, y: 100 },
      { text: "盤點API、Agent、工具與資料流", fontSize: 42.55, x: 120, y: 320 },
      { text: "some lowercase text", fontSize: 30, x: 120, y: 480 },
      { text: "2024 年 Q3：營收成長 18%", fontSize: 36, x: 640, y: 620 },
      { text: "全球市場展望", fontSize: 140, x: 120, y: 760 },
    ];
    const { slide, result } = await runRoundTrip(specs);
    const redrawn = await renderRaster(result.boxes, slide.canvas);
    specs.forEach((spec, index) => {
      const truth = slide.truths[index]!;
      // 各行垂直分開，逐行取一條橫帶比對（帶內只有這一行的字墨）。
      const crop = {
        x: 0,
        y: truth.y - spec.fontSize * 0.4,
        width: slide.canvas.width,
        height: truth.height + spec.fontSize * 0.8,
      };
      const before = inkBBox(slide.image, crop);
      const after = inkBBox(redrawn, crop);
      expect(before, `${spec.text} 原圖字墨`).not.toBeNull();
      expect(after, `${spec.text} 重繪字墨`).not.toBeNull();
      expect(Math.abs(after!.x - before!.x), `${spec.text} 字墨左緣位移`).toBeLessThan(3);
      expect(Math.abs(after!.y - before!.y), `${spec.text} 字墨頂緣位移`).toBeLessThan(3);
      expect(after!.width / before!.width, `${spec.text} 字墨寬比`).toBeGreaterThan(0.95);
      expect(after!.width / before!.width, `${spec.text} 字墨寬比`).toBeLessThan(1.05);
      expect(after!.height / before!.height, `${spec.text} 字墨高比`).toBeGreaterThan(0.95);
      expect(after!.height / before!.height, `${spec.text} 字墨高比`).toBeLessThan(1.05);
    });
  });
});

/**
 * 同一份幾何會被三個地方消費：
 *   ① 伺服器端 SVG 合成（`text-layers.ts` `textOverlaySvg`）
 *   ② PPTX 匯出（`exporters.ts` 的 addText）
 *   ③ 編輯器 DOM（`apps/editor`）
 * ③ 在 vitest（node 環境、無版面引擎）量不到真實字型 metrics，硬測只會得到
 * 假的期望值，故列為已知限制不在此覆蓋；①②的一致性以真實產物比對。
 */
describe("三消費端幾何一致性（SVG 合成 vs PPTX 匯出）", () => {
  const EMU_PER_INCH = 914400;
  const SLIDE_WIDTH_IN = 13.333;
  const SLIDE_HEIGHT_IN = 7.5;

  interface PptxShape {
    x: number;
    y: number;
    width: number;
    align: string;
    fontSizePt: number;
  }

  /** 從 slide1.xml 讀回每個文字框的實際幾何（EMU → px）。 */
  function parseShapes(xml: string, canvas: { width: number; height: number }): PptxShape[] {
    const toPxX = (emu: number) => (emu / EMU_PER_INCH / SLIDE_WIDTH_IN) * canvas.width;
    const toPxY = (emu: number) => (emu / EMU_PER_INCH / SLIDE_HEIGHT_IN) * canvas.height;
    return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((match) => {
      const block = match[0];
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(block);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(block);
      const algn = /algn="([a-z]+)"/.exec(block);
      const sz = /sz="(\d+)"/.exec(block);
      if (!off || !ext || !algn || !sz) throw new Error(`PPTX 文字框缺少幾何屬性：${block}`);
      return {
        x: toPxX(Number(off[1])),
        y: toPxY(Number(off[2])),
        width: toPxX(Number(ext[1])),
        align: algn[1]!,
        fontSizePt: Number(sz[1]) / 100,
      };
    });
  }

  it("同一個框在 SVG 與 PPTX 落在同一個文字起點（left／center／right 皆然）", async () => {
    // 抓的 bug：兩個消費端各自對 align 做補償。PPTX 為了避免 CJK advance 略寬造成
    // 折行而把框加寬 1em，center／right 時必須把這段餘裕往回位移；只要補償寫錯，
    // 匯出的 PPTX 就會比畫布上的合成圖整行偏移半個到一個字。
    const canvas = { width: 1920, height: 1080 };
    // 用精修管線真的解出來的框，而不是手捏的數字——確保測的是實際會匯出的幾何。
    const spec: RoundTripSpec = {
      text: "Quarterly Review 年度回顧",
      fontSize: 48,
      x: 260,
      y: 300,
    };
    const { result } = await runRoundTrip([spec]);
    const solved = result.boxes[0]!;
    const glyph = await defaultTextMetrics.measure({
      text: solved.text,
      fontFamily: solved.fontFamily,
      fontWeight: solved.fontWeight,
      lineHeight: solved.lineHeight,
    });
    const aligns = ["left", "center", "right"] as const;
    const boxes = aligns.map((align, index) => ({
      ...solved,
      id: `consumer-${align}`,
      y: 200 + index * 200,
      align,
    }));

    // ① SVG 合成：直接量重繪出來的字墨左緣。
    const svgInk = await Promise.all(
      boxes.map(async (box) => {
        const image = await renderRaster([box], canvas);
        return inkBBox(image, {
          x: 0,
          y: box.y - 20,
          width: canvas.width,
          height: box.height + 40,
        });
      }),
    );

    // ② PPTX 匯出：從產物 XML 讀回框幾何，依 align 推回文字起筆位置。
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-geometry-consumers-")),
    );
    await repository.initialize();
    const project = createProject({ topic: "幾何一致性", brief: { desiredSlideCount: 1 } });
    const slide = project.slides[0]!;
    const now = new Date().toISOString();
    const background = new Uint8Array(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"><rect width="100%" height="100%" fill="#0b1220"/></svg>`,
      )
        .render()
        .asPng(),
    );
    const backgroundPath = await repository.saveAsset(
      project.id,
      `${slide.id}/background.png`,
      background,
    );
    slide.versions.push({
      id: "geometry-version",
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
        boxes,
      },
    });
    slide.currentVersionId = "geometry-version";
    const pptx = await exportPresentation(repository, project, "pptx");
    const xml = Buffer.from(unzipSync(pptx)["ppt/slides/slide1.xml"]!).toString("utf8");
    const shapes = parseShapes(xml, canvas);
    expect(shapes).toHaveLength(3);

    boxes.forEach((box, index) => {
      const shape = shapes[index]!;
      const ink = svgInk[index];
      expect(ink, `${box.align} 的 SVG 字墨`).not.toBeNull();
      expect(shape.align, `${box.align} 的 PPTX 對齊`).toBe(
        box.align === "center" ? "ctr" : box.align === "right" ? "r" : "l",
      );
      // 字級：PPTX 用點、畫布用像素，換算後必須是同一個字級。
      const pptxFontSizePx = (shape.fontSizePt / 72 / SLIDE_HEIGHT_IN) * canvas.height;
      expect(pptxFontSizePx, `${box.align} 的字級`).toBeCloseTo(box.fontSize, 1);
      // 依 PPTX 框幾何與對齊推回「文字左緣」，再加 bearing 得到字墨左緣。
      const advance = glyph.advance * box.fontSize;
      const textLeft =
        shape.align === "ctr"
          ? shape.x + shape.width / 2 - advance / 2
          : shape.align === "r"
            ? shape.x + shape.width - advance
            : shape.x;
      expect(textLeft + glyph.bearing * box.fontSize, `${box.align} 的字墨左緣`).toBeCloseTo(
        ink!.x,
        0,
      );
      expect(shape.y, `${box.align} 的框頂`).toBeCloseTo(box.y, 1);
    });

    // 三種對齊在兩個消費端都落在同一處：精修後的框寬正好等於前進寬，
    // 所以 align 只是換錨點，不會搬動文字。
    const xs = svgInk.map((ink) => ink!.x);
    expect(Math.max(...xs) - Math.min(...xs), "三種對齊的 SVG 字墨左緣差").toBeLessThanOrEqual(1);
  });
});

// 舊實作（已移除）的字級反推：先猜字種，再套固定字墨常數與固定字寬表。
// 用同一組真實渲染的字墨重跑一次，證明這個測試骨架確實抓得到當初的 bug——
// 舊測試用純色方塊 + 照抄同一組常數當期望值，結構上永遠抓不到。
const LEGACY_RENDER = {
  cjkInkHeight: 0.94,
  latinInkHeight: 0.74,
} as const;
const WIDE_CHAR = /[ᄀ-ᅟ -⁯←-⇿⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

function legacyAdvanceUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    if (WIDE_CHAR.test(char)) units += 0.99;
    else if (/\s/.test(char)) units += 0.26;
    else if (/[0-9]/.test(char)) units += 0.556;
    else if (/[A-Z]/.test(char)) units += 0.72;
    else if (/[a-z]/.test(char)) units += 0.5;
    else units += 0.4;
  }
  return units;
}

function legacyFontSize(text: string, ink: { width: number; height: number }): number {
  const cjk = WIDE_CHAR.test(text);
  const heightBased =
    ink.height / (cjk ? LEGACY_RENDER.cjkInkHeight : LEGACY_RENDER.latinInkHeight);
  const units = legacyAdvanceUnits(text.trim());
  const widthBased = units > 0.5 ? ink.width / units : heightBased;
  const trusted = widthBased >= heightBased * 0.85 && widthBased <= heightBased * 1.15;
  return Math.max(10, trusted ? Math.min(widthBased, heightBased) : heightBased);
}

function legacyHeightBased(text: string, ink: { height: number }): number {
  return (
    ink.height / (WIDE_CHAR.test(text) ? LEGACY_RENDER.cjkInkHeight : LEGACY_RENDER.latinInkHeight)
  );
}

describe("harness sensitivity to the historical constant-based bug", () => {
  it.each([
    { text: "AI-Ready API Security", fontSize: 75.6, overshoot: 1.2 },
    { text: "盤點API、Agent、工具與資料流", fontSize: 42.55, overshoot: 1.09 },
  ])(
    "舊的固定字墨高常數在「$text」上會高估字級 ≥ $overshoot 倍",
    async ({ text, fontSize, overshoot }) => {
      const slide = await renderSlide([{ text, fontSize }]);
      const ink = measureInk(slide.image, slide.detections[0]!);
      expect(ink).not.toBeNull();
      // 根因 1：字墨高取決於該行有沒有下伸部／大寫，固定常數必然在某一側高估。
      expect(legacyHeightBased(text, ink!) / fontSize).toBeGreaterThan(overshoot);
      // 新實作在同一組像素上還原真值。
      const { outcomes } = await runRoundTrip([{ text, fontSize }]);
      expect(outcomes[0]!.fontSizeError).toBeLessThan(0.05);
    },
  );

  it("舊算式整體在含下伸部的標題上高估 1.2 倍以上（高度估計錯 → 寬度證據被否決）", async () => {
    const text = "AI-Ready API Security";
    const slide = await renderSlide([{ text, fontSize: 75.6 }]);
    const ink = measureInk(slide.image, slide.detections[0]!)!;
    expect(legacyFontSize(text, ink) / 75.6).toBeGreaterThan(1.2);
  });

  it("無下伸部的拉丁行舊常數剛好命中——所以只有部分框看起來壞掉", async () => {
    const slide = await renderSlide([{ text: "MCP / Tool Allow-list", fontSize: 30 }]);
    const ink = measureInk(slide.image, slide.detections[0]!)!;
    expect(legacyHeightBased("MCP / Tool Allow-list", ink) / 30).toBeLessThan(1.05);
    expect(legacyFontSize("MCP / Tool Allow-list", ink) / 30).toBeLessThan(1.05);
  });
});

describe("text metrics probe", () => {
  it("量到的字墨高會隨字串的實際字形改變（不是固定常數）", async () => {
    const common = { fontFamily: "Arial", fontWeight: 700, lineHeight: 1.2 };
    const descender = await defaultTextMetrics.measure({
      ...common,
      text: "AI-Ready API Security",
    });
    const flat = await defaultTextMetrics.measure({ ...common, text: "MCP / Tool Allow-list" });
    // 同樣是全大寫起頭的拉丁行，有沒有下伸部就差了兩成以上的字墨高；
    // 任何「拉丁 = 0.74em」的固定假設都會在其中一邊高估字級。
    expect(descender.inkHeight).toBeGreaterThan(flat.inkHeight * 1.15);
  });

  it("前進寬與字墨寬一致（CJK 每字 1em）", async () => {
    const glyph = await defaultTextMetrics.measure({
      text: "身分與最小權限",
      fontFamily: "Arial",
      fontWeight: 400,
      lineHeight: 1.2,
    });
    expect(glyph.advance).toBeCloseTo(7, 1);
    expect(glyph.inkWidth).toBeLessThanOrEqual(glyph.advance);
    expect(glyph.bearing).toBeGreaterThanOrEqual(0);
  });

  it("量不到字墨時丟出明確錯誤，不靜默回傳 0", async () => {
    const metrics = new RenderedTextMetrics();
    await expect(
      metrics.measure({ text: "   ", fontFamily: "Arial", fontWeight: 400, lineHeight: 1.2 }),
    ).rejects.toThrow(/TEXT_METRICS_EMPTY_TEXT/);
  });

  it("快取鍵不會因為 fontFamily 含分隔字元而互撞", async () => {
    // 抓的 bug：快取鍵用 " " 串接各欄位。fontFamily 是模型自由填的字串，
    // 只要內容剛好補滿後面幾個欄位就會撞鍵，回傳另一個字串的 metrics——
    // 症狀是某一框的字級莫名其妙變成隔壁框的。
    const metrics = new RenderedTextMetrics();
    const first = await metrics.measure({
      text: "B 700 1.2 0 C",
      fontFamily: "A",
      fontWeight: 400,
      lineHeight: 1.2,
    });
    const second = await metrics.measure({
      text: "C",
      fontFamily: "A 400 1.2 0 B",
      fontWeight: 700,
      lineHeight: 1.2,
    });
    // 兩者的欄位以空白串起來完全相同；量到的字墨寬必須各是各的。
    expect(second.inkWidth).toBeLessThan(first.inkWidth / 2);
  });

  it("剔除邊緣元件是量測端的一等公民：dropTrailing 會縮短字墨寬但不動前進寬", async () => {
    // 原圖端剔掉邊緣細條之後，量測端必須能剔掉同一個元件，兩邊才是同一個量。
    const common = { text: "架構 I", fontFamily: "Arial", fontWeight: 400, lineHeight: 1.2 };
    const full = await defaultTextMetrics.measure(common);
    const trimmed = await defaultTextMetrics.measure({ ...common, dropTrailing: true });
    expect(trimmed.inkWidth).toBeLessThan(full.inkWidth);
    // 前進寬是整串字的排版寬度，與「量測時剔掉哪個元件」無關。
    expect(trimmed.advance).toBeCloseTo(full.advance, 5);
    // 尾端元件的寬度就是兩者的差（加上元件之間的間隙）。
    expect(full.tailComponent).toBeGreaterThan(0);
    expect(full.inkWidth - trimmed.inkWidth).toBeGreaterThanOrEqual(full.tailComponent);
  });
});

describe("寬度是唯一錨（沒有隱形的上界夾制）", () => {
  it("偵測框緊貼字墨時，字級仍等於「字墨寬 ÷ 該字串字墨寬」而不是被框寬壓小", async () => {
    // 抓的 bug：`solveBoxGeometry` 曾經有一段宣稱「不溢出夾制」的
    // `Math.min(candidate, max(widthBased, detectionWidth / advance))`——上界永遠
    // ≥ 候選值，所有路徑上都是 no-op，讀起來卻像有保護。真要讓它有作用（把上界
    // 改成 detectionWidth/advance）反而會在這個案例裡把正確的字級壓小：
    // 偵測框只框到字墨，而前進寬比字墨寬多了首尾 bearing。
    const spec: RoundTripSpec = { text: "全球市場展望", fontSize: 140, unclipX: 0, unclipY: 0 };
    const { outcomes } = await runRoundTrip([spec]);
    const outcome = outcomes[0]!;
    const naiveCeiling = outcome.detection.width / outcome.glyph.advance;
    // 前提檢查：這個案例真的有鑑別力（框寬換算出的上界確實低於真值）。
    expect(naiveCeiling).toBeLessThan(spec.fontSize * 0.99);
    expect(outcome.refined.fontSize).toBeGreaterThan(naiveCeiling);
    assertRoundTrip(outcome);
  });
});

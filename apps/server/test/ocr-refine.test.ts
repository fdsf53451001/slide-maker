import type { EditableTextBox } from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import {
  measureInk,
  normalizeFontSizes,
  refineOcrBoxes,
  splitMergedBox,
  type RasterImage,
} from "../src/ocr-refine.js";
import { boxesFromOcr } from "../src/text-layers.js";
import { defaultTextMetrics } from "../src/text-metrics.js";

/** 以與合成同一條渲染路徑量到的 metrics 推期望值，避免測試照抄程式裡的常數。 */
const glyphOf = (text: string, fontWeight = 400) =>
  defaultTextMetrics.measure({ text, fontFamily: "Arial", fontWeight, lineHeight: 1.2 });

// 取自足球 deck 第八頁的真實大綱內容（OCR 誤認案例的來源基準）。
const SLIDE_CONTENT = [
  "標題：活動目標：用一場球賽，完成代理式 AI 的實戰閉環",
  "",
  "① 建得出｜完成 4 名場上球員＋1 名守門員的自主代理隊伍",
  "② 部署得動｜將代理部署至 AWS，接入即時比賽環境",
  "③ 協作得好｜設計角色分工、工具使用與多代理配合",
  "④ 改進有據｜依比賽回饋、行動紀錄與延遲表現調整系統",
  "⑤ 說得清楚｜理解提示、結構化輸出、護欄與可觀測性的作用",
  "⑥ 帶得回去｜把建置—競賽—診斷—迭代方法轉用至自身情境",
  "",
  "重點：目標不是只贏一場，而是帶走一套能建置、驗證與改進自主系統的方法。",
].join("\n");

const LAYOUT_HINT = "以細線或箭頭串成「建置→部署→協作→診斷→理解→移轉」閉環。下方放深色橫幅重點句。";

function box(overrides: Partial<EditableTextBox>): EditableTextBox {
  return {
    id: overrides.id ?? "box",
    text: "文字",
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    fontFamily: "Arial",
    fontSize: 30,
    fontWeight: 400,
    color: "#ffffff",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 0.9,
    role: "presentation",
    ...overrides,
  };
}

const refine = async (boxes: EditableTextBox[]) =>
  (await refineOcrBoxes(boxes, { sourceTexts: [SLIDE_CONTENT, LAYOUT_HINT] })).boxes;

/** 建立單色底的合成畫布，並以純色矩形模擬字墨帶。 */
function raster(
  width: number,
  height: number,
  inkRects: readonly { x: number; y: number; w: number; h: number }[],
  palette: { background?: number; ink?: number } = {},
): RasterImage {
  const { background = 255, ink = 20 } = palette;
  const data = new Uint8Array(width * height * 3).fill(background);
  for (const rect of inkRects) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const offset = (y * width + x) * 3;
        data[offset] = ink;
        data[offset + 1] = ink;
        data[offset + 2] = ink;
      }
    }
  }
  return { data, width, height, channels: 3 };
}

describe("source-anchored OCR text correction", () => {
  it("fixes simplified-character misreads and restores designed spacing from the outline", async () => {
    const [corrected] = await refine([box({ text: "将代理部署至AWS，" })]);
    expect(corrected?.text).toBe("將代理部署至 AWS，");
  });

  it("fixes em-dashes misread as 一", async () => {
    const [corrected] = await refine([box({ text: "把建置一競賽一診斷一" })]);
    expect(corrected?.text).toBe("把建置—競賽—診斷—");
  });

  it("matches arrow chains from the layout hint", async () => {
    const [corrected] = await refine([box({ text: "建置→部署 →協作 →診斷 →理解→移轉" })]);
    expect(corrected?.text).toBe("建置→部署→協作→診斷→理解→移轉");
  });

  it("keeps text that has no close match in the sources", async () => {
    const [kept] = await refine([box({ text: "全然無關的浮水印" })]);
    expect(kept?.text).toBe("全然無關的浮水印");
  });

  it("keeps single-character boxes untouched", async () => {
    const [kept] = await refine([box({ text: "5" })]);
    expect(kept?.text).toBe("5");
  });
});

describe("merged heading/body box splitting", () => {
  it("splits a heading merged with body copy and re-estimates the body font size", async () => {
    // 第八頁卡片 4 實測值：標題「改進有據」(48px 粗體) 與內文黏成一框，
    // 內文因此以 50.7px 粗體渲染。
    const merged = box({
      text: "改進有據依比賽回饋、行動紀錄與",
      x: 953,
      y: 496,
      width: 513,
      height: 65,
      fontSize: 50.7,
      fontWeight: 700,
    });
    const result = await refine([merged]);
    expect(result.map((item) => item.text)).toEqual(["改進有據", "依比賽回饋、行動紀錄與"]);
    const [heading, body] = result;
    expect(heading?.fontWeight).toBe(700);
    expect(body?.fontWeight).toBe(400);
    // 反推的內文字級應接近其他卡片內文（25–30px），遠小於標題。
    expect(body?.fontSize).toBeGreaterThan(20);
    expect(body?.fontSize).toBeLessThan(32);
    // 內文從分隔線之後開始，且不超出原框右緣。
    expect(body?.x).toBeGreaterThan(heading!.x + heading!.width);
    expect(body!.x + body!.width).toBeLessThanOrEqual(merged.x + merged.width + 1);
  });

  it("does not split when both sides render at a similar size", () => {
    const inline = box({ text: "上半場｜下半場", width: 420, fontSize: 30, height: 38 });
    expect(splitMergedBox(inline)).toHaveLength(1);
  });

  it("drops a dangling separator instead of splitting", () => {
    const dangling = box({ text: "建得出｜", width: 200, fontSize: 48 });
    const result = splitMergedBox(dangling);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("建得出");
  });
});

describe("number badge glued to body text by OCR", () => {
  it("splits before correcting so the badge digits are not rewritten into a source neighbour", async () => {
    // 封面研究主線實測：OCR 把數字徽章「01」併進後方問句成同一框。整框先去對位來源時，
    // 完全命中的問句會稀釋「01」的誤差，讓校正把它改寫成來源鄰詞「主線」。先拆再校正即可避免。
    const raw = {
      width: 1920,
      height: 1080,
      boxes: [
        {
          text: "01 | 它為何受到關注？",
          confidence: 0.92,
          polygon: [
            [345, 797],
            [662, 797],
            [662, 845],
            [345, 845],
          ] as [number, number][],
        },
      ],
    };
    const source = "研究主線｜它為何受到關注？能力是否經得起獨立評測？實際使用要付出哪些代價？";
    const { boxes } = await refineOcrBoxes(boxesFromOcr(raw, { width: 1920, height: 1080 }, 0.75), {
      sourceTexts: [source],
    });
    const texts = boxes.map((item) => item.text);
    expect(texts).toContain("01");
    expect(texts).toContain("它為何受到關注？");
    expect(texts).not.toContain("主線");
  });
});

describe("trailing punctuation restore", () => {
  it("appends the source's trailing full-width punctuation and widens the box", async () => {
    const footer = box({
      text: "重點：目標不是只贏一場，而是帶走一套能建置、驗證與改進自主系統的方法",
      width: 1562,
      fontSize: 48.4,
    });
    const [corrected] = await refine([footer]);
    expect(corrected?.text).toBe(
      "重點：目標不是只贏一場，而是帶走一套能建置、驗證與改進自主系統的方法。",
    );
    expect(corrected?.width).toBeCloseTo(1562 + 48.4, 1);
  });
});

describe("ink-based geometry snapping", () => {
  // 這一組用純色方塊模擬字墨帶，只驗「幾何反推的算式」；字形是否量得準由
  // ocr-geometry-roundtrip.test.ts 的真實渲染 round trip 負責。
  it("derives font size and position from the measured ink instead of the padded detection box", async () => {
    // 10 個 CJK 字、字墨 296×30px；偵測框帶 unclip 外擴（308×44）。
    const image = raster(400, 120, [{ x: 50, y: 40, w: 296, h: 30 }]);
    const detection = box({
      text: "接入即時比賽環境規劃",
      x: 44,
      y: 32,
      width: 308,
      height: 44,
      fontSize: 34.3,
    });
    const { boxes } = await refineOcrBoxes([detection], { sourceTexts: [], image });
    const snapped = boxes[0]!;
    const glyph = await glyphOf(detection.text, snapped.fontWeight);
    // 字級以字墨寬為主錨，遠小於偵測框換算的 34.3px。
    expect(snapped.fontSize).toBeCloseTo(296 / glyph.inkWidth, 1);
    expect(snapped.fontSize).toBeLessThan(detection.fontSize);
    // x/y 反推自字墨位置，扣掉該字串在同一渲染路徑下的 bearing 與框頂距。
    expect(snapped.x).toBeCloseTo(50 - glyph.bearing * snapped.fontSize, 1);
    expect(snapped.y).toBeCloseTo(40 - glyph.inkTop * snapped.fontSize, 1);
    // 框寬正好是渲染前進寬：不論之後 align 被改成什麼，文字都落在同一位置。
    expect(snapped.width).toBeCloseTo(glyph.advance * snapped.fontSize, 5);
  });

  it("ignores a neighbouring text line bleeding into the search region", async () => {
    const image = raster(400, 140, [
      { x: 50, y: 40, w: 296, h: 30 },
      { x: 50, y: 100, w: 296, h: 20 }, // 下一行的頂部滲進區域
    ]);
    const detection = box({
      text: "接入即時比賽環境規劃",
      x: 44,
      y: 32,
      width: 308,
      height: 64,
      fontSize: 34.3,
    });
    const { boxes } = await refineOcrBoxes([detection], { sourceTexts: [], image });
    expect(boxes[0]!.fontSize).toBeLessThan(33);
    expect(boxes[0]!.y + boxes[0]!.height).toBeLessThan(95);
  });

  it("drops a thin separator bar at the edge from the width estimate", async () => {
    const image = raster(440, 120, [
      { x: 50, y: 40, w: 296, h: 30 },
      { x: 360, y: 42, w: 3, h: 28 }, // 卡片的 ｜ 分隔線被切進偵測框
    ]);
    const detection = box({
      text: "接入即時比賽環境規劃",
      x: 44,
      y: 32,
      width: 330,
      height: 44,
      fontSize: 34.3,
    });
    const { boxes } = await refineOcrBoxes([detection], { sourceTexts: [], image });
    expect(boxes[0]!.fontSize).toBeLessThan(32);
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThan(358);
  });

  it("spans the detection box vertically but hugs the ink horizontally (preserving dividers)", async () => {
    const image = raster(400, 120, [{ x: 50, y: 40, w: 296, h: 30 }]);
    const detection = box({
      id: "det",
      text: "接入即時比賽環境規劃",
      x: 44,
      y: 32,
      width: 308,
      height: 44,
      fontSize: 34.3,
    });
    const { maskRects } = await refineOcrBoxes([detection], { sourceTexts: [], image });
    const mask = maskRects.get("det")!;
    // 垂直涵蓋整個偵測框（上下緣殘墨要清乾淨）。
    expect(mask.y).toBeLessThanOrEqual(32);
    expect(mask.y + mask.height).toBeGreaterThanOrEqual(32 + 44);
    // 水平貼齊字墨：偵測框的 unclip 外擴常吃到旁邊的「｜」分隔線，不能照抄。
    expect(mask.x).toBe(50);
    expect(mask.x + mask.width).toBe(50 + 296);
  });

  it("derives a mixed CJK/Latin line from its own measured advance, not a script guess", async () => {
    // 「Kimi K3 模型研究」拉丁字元多於 CJK。舊實作先猜字種再套固定字墨常數，
    // 多數決會判成拉丁、字級高估近三成（實測封面主標 109→138px）；改用實測
    // metrics 後不再有「字種 → 常數」這一步，字級直接由該字串的字墨寬決定。
    const image = raster(600, 200, [{ x: 50, y: 60, w: 272, h: 30 }]);
    const detection = box({
      text: "Kimi K3 模型研究",
      x: 44,
      y: 52,
      width: 290,
      height: 44,
      fontSize: 34.3,
    });
    const { boxes } = await refineOcrBoxes([detection], { sourceTexts: [], image });
    const snapped = boxes[0]!;
    const glyph = await glyphOf(detection.text, snapped.fontWeight);
    expect(snapped.fontSize).toBeCloseTo(272 / glyph.inkWidth, 1);
    // 不溢出：以最終字級渲染的前進寬不得超過框寬。
    expect(glyph.advance * snapped.fontSize).toBeLessThanOrEqual(snapped.width * 1.05);
  });

  it("falls back to detection geometry when the region has no ink", async () => {
    const image = raster(400, 120, []);
    const detection = box({ text: "找不到字墨", x: 44, y: 32, width: 308, height: 44 });
    const { boxes } = await refineOcrBoxes([detection], { sourceTexts: [], image });
    expect(boxes[0]!.x).toBe(44);
    expect(boxes[0]!.fontSize).toBe(30);
  });

  it("深底白字：背景由區域邊框推得，量到的字墨與白底黑字完全一致", () => {
    // 抓的 bug：把「暗＝字墨」寫死。投影片有一半是深色背景配淺色文字，
    // 若判準假設背景是白的，字墨帶會整個反過來（背景被當字墨），字級與位置全錯。
    const light = raster(400, 120, [{ x: 50, y: 40, w: 296, h: 30 }]);
    const dark = raster(400, 120, [{ x: 50, y: 40, w: 296, h: 30 }], {
      background: 17,
      ink: 248,
    });
    const region = { x: 44, y: 32, width: 308, height: 44, fontSize: 34.3 };
    expect(measureInk(dark, region)).toEqual(measureInk(light, region));
    expect(measureInk(dark, region)).toEqual({ x: 50, y: 40, width: 296, height: 24 * 1.25 });
  });

  it("卡片左邊框緊貼文字時，行剖面必須把它剔除而不是放棄整框", () => {
    // 實測疑似污染源：卡片的左邊框是一條貫穿整張卡片的垂直細線，OCR 的 unclip
    // 外擴會把它含進偵測框。與「｜ 分隔線」不同的是它**縱向跨越整個搜尋區**，
    // 因此列剖面的每一列都有墨，選帶會選出整個區域（高度超過 box.height×1.2）
    // 而回傳 null——負責去細條的行剖面排在選帶之後，永遠等不到執行。
    const image = raster(440, 140, [
      { x: 50, y: 40, w: 296, h: 30 }, // 文字
      { x: 38, y: 10, w: 3, h: 120 }, // 卡片左邊框，貫穿整個搜尋區
    ]);
    const ink = measureInk(image, { x: 44, y: 32, width: 308, height: 44, fontSize: 34.3 });
    expect(ink).not.toBeNull();
    // 邊框不得計入寬度：字墨仍應是文字本身的 296px。
    expect(ink?.x).toBe(50);
    expect(ink?.width).toBe(296);
  });

  it("measureInk trims to the band around the box centre", () => {
    const image = raster(200, 100, [{ x: 20, y: 30, w: 150, h: 24 }]);
    const ink = measureInk(image, { x: 14, y: 22, width: 166, height: 40, fontSize: 25 });
    expect(ink).toEqual({ x: 20, y: 30, width: 150, height: 24 });
  });
});

describe("font size clustering", () => {
  it("snaps same-tier sizes to a shared median and stabilises bold detection", () => {
    // 第八頁實測:六張卡標題 42.1–50.7px、內文 25.0–31.2px，視覺上各為同一層級。
    const headings = [42.1, 46.0, 47.6, 48.4, 50.7].map((fontSize, index) =>
      box({ id: `h${index}`, text: "建得出", fontSize, fontWeight: 700 }),
    );
    const bodies = [25.0, 27.3, 29.6, 31.2].map((fontSize, index) =>
      box({ id: `b${index}`, text: "設計角色分工、工具使用", fontSize }),
    );
    const title = box({ id: "title", text: "活動目標", fontSize: 82.7, fontWeight: 700 });
    const result = normalizeFontSizes([...headings, ...bodies, title]);
    const headingSizes = new Set(result.slice(0, 5).map((item) => item.fontSize));
    const bodySizes = new Set(result.slice(5, 9).map((item) => item.fontSize));
    expect(headingSizes.size).toBe(1);
    expect(bodySizes.size).toBe(1);
    expect([...headingSizes][0]).toBeGreaterThan(40);
    expect(result.slice(0, 5).every((item) => item.fontWeight === 700)).toBe(true);
    expect(result.slice(5, 9).every((item) => item.fontWeight === 400)).toBe(true);
    // 獨立層級（大標題）不受聚類影響。
    expect(result[9]?.fontSize).toBe(82.7);
  });

  it("leaves genuinely distinct tiers apart", () => {
    const result = normalizeFontSizes([
      box({ id: "a", fontSize: 24 }),
      box({ id: "b", fontSize: 48 }),
    ]);
    expect(result.map((item) => item.fontSize)).toEqual([24, 48]);
  });
});

describe("end-to-end refinement of the slide-8 regression", () => {
  it("corrects, splits, and unifies the real page-8 boxes", async () => {
    const boxes = [
      box({
        id: "title",
        text: "活動目標：用一場球賽，完成代理式 AI的實戰閉環",
        width: 1726,
        height: 106,
        fontSize: 82.7,
        fontWeight: 700,
      }),
      box({
        id: "merged",
        text: "改進有據依比賽回饋、行動紀錄與",
        x: 953,
        y: 496,
        width: 513,
        height: 65,
        fontSize: 50.7,
        fontWeight: 700,
      }),
      box({ id: "h2", text: "部署得動", fontSize: 42.1, height: 54, fontWeight: 700 }),
      box({ id: "h3", text: "協作得好", fontSize: 46.0, height: 59, fontWeight: 700 }),
      box({ id: "b1", text: "将代理部署至AWS，", fontSize: 29.6, height: 38 }),
      box({ id: "b2", text: "理解提示、结構化輸出", fontSize: 27.3, height: 35 }),
      box({ id: "b3", text: "接入即時比賽環境", fontSize: 27.3, height: 35 }),
    ];
    const result = await refine(boxes);
    const byText = new Map(result.map((item) => [item.text, item]));
    expect(byText.get("活動目標：用一場球賽，完成代理式 AI 的實戰閉環")).toBeDefined();
    expect(byText.get("將代理部署至 AWS，")).toBeDefined();
    // 原圖在此換行點確實渲染了行尾頓號，標點補回會還原它。
    expect(byText.get("理解提示、結構化輸出、")).toBeDefined();
    // 合併框拆開後，標題群與內文群各自貼齊同一字級。
    const heading = byText.get("改進有據");
    const body = byText.get("依比賽回饋、行動紀錄與");
    expect(heading).toBeDefined();
    expect(body).toBeDefined();
    expect(heading?.fontSize).toBe(byText.get("部署得動")?.fontSize);
    expect(body?.fontSize).toBe(byText.get("接入即時比賽環境")?.fontSize);
    expect(body?.fontWeight).toBe(400);
  });
});

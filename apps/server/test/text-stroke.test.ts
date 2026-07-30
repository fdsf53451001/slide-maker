import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import {
  createProject,
  editableTextBoxSchema,
  textStroke,
  TEXT_STROKE_DEFAULT_OPACITY,
  TEXT_STROKE_DEFAULT_WIDTH_EM,
  TEXT_STROKE_MAX_WIDTH_EM,
  type EditableTextBox,
} from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import { exportPresentation } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";
import { textElements, textOverlaySvg } from "../src/text-layers.js";

function box(overrides: Partial<EditableTextBox> = {}): EditableTextBox {
  return {
    id: "box",
    text: "標題 OOO",
    x: 100,
    y: 200,
    width: 800,
    height: 120,
    fontFamily: "Arial",
    fontSize: 72,
    fontWeight: 700,
    color: "#ffffff",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 0.99,
    role: "presentation",
    ...overrides,
  };
}

describe("描邊的三端共用解析（core 的 textStroke）", () => {
  it("沒有 strokeColor 就沒有描邊：色彩欄位是開關，與 backgroundColor 同一套", () => {
    expect(textStroke(box())).toBeUndefined();
    // 只給寬度、不給顏色也一樣沒有描邊——否則「調過粗細再取消勾選」會留下幽靈描邊。
    expect(textStroke(box({ strokeWidth: 0.1 }))).toBeUndefined();
  });

  it("寬度是 em：換算成畫布 px 時要乘上這一框自己的字級", () => {
    expect(textStroke(box({ strokeColor: "#000000", strokeWidth: 0.05 }))).toEqual({
      color: "#000000",
      widthPx: 72 * 0.05,
      opacity: TEXT_STROKE_DEFAULT_OPACITY,
    });
    // 同樣的 em 值，字級小一半描邊就細一半——這正是不存絕對 px 的原因。
    expect(
      textStroke(box({ fontSize: 24, strokeColor: "#000000", strokeWidth: 0.05 }))?.widthPx,
    ).toBe(24 * 0.05);
  });

  it("省略寬度與不透明度時各自落到共用預設值", () => {
    expect(textStroke(box({ strokeColor: "#ff0000" }))).toEqual({
      color: "#ff0000",
      widthPx: 72 * TEXT_STROKE_DEFAULT_WIDTH_EM,
      opacity: TEXT_STROKE_DEFAULT_OPACITY,
    });
  });

  it('寬度被調到 0 視同沒有描邊，不送出 stroke-width="0" 這種無效果屬性', () => {
    expect(textStroke(box({ strokeColor: "#000000", strokeWidth: 0 }))).toBeUndefined();
  });
});

describe("描邊的 SVG 輸出", () => {
  it("沒有描邊時輸出與加入這個功能之前逐字相同", () => {
    expect(textElements([box()])).not.toContain("stroke");
  });

  it("有描邊時同時輸出四個屬性，缺一都會壞掉", () => {
    const svg = textElements([
      box({ strokeColor: "#123456", strokeWidth: 0.05, strokeOpacity: 0.8 }),
    ]);
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain(`stroke-width="${72 * 0.05}"`);
    expect(svg).toContain('stroke-opacity="0.8"');
    // 中文筆劃轉角銳利，預設的 miter 會噴尖刺。
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('paint-order="stroke"');
  });

  it("描邊屬性掛在 <text> 上，不會沾到底色的 <rect>", () => {
    const svg = textElements([
      box({ backgroundColor: "#000000", strokeColor: "#ffffff", strokeWidth: 0.06 }),
    ]);
    const rect = svg.slice(svg.indexOf("<rect"), svg.indexOf("<text"));
    expect(rect).not.toContain("stroke");
  });
});

/**
 * 這一組是整個描邊功能唯一真正危險的地方，所以用逐像素釘住而不是比對字串。
 *
 * SVG 預設 `paint-order` 是 fill→stroke，而描邊是**跨在字形輪廓上**的（一半在外一半在
 * 內），所以少了 `paint-order="stroke"`，描邊會蓋在字面上。實測 3px 描邊就足以把整行
 * 白字塗成黑色實心塊——純白字心像素直接歸零。這是「畫面上看得出來、但字串斷言看不出來」
 * 的類別：把 `paint-order` 從 `text-layers.ts` 拿掉，上面那組字串測試只會少一條斷言，
 * 這一組才會真的變紅。
 */
describe("paint-order：描邊不可以蓋掉字面", () => {
  const CANVAS = { width: 900, height: 300 };

  async function whitePixels(svg: Buffer): Promise<number> {
    const raw = await sharp({
      create: { ...CANVAS, channels: 3, background: "#3a6ea5" },
    })
      .composite([{ input: svg, blend: "over" }])
      .raw()
      .toBuffer();
    let white = 0;
    for (let i = 0; i < raw.length; i += 3)
      if (raw[i]! > 245 && raw[i + 1]! > 245 && raw[i + 2]! > 245) white++;
    return white;
  }

  it("描邊過的字，字心仍然是填色（沒有被描邊吃掉）", async () => {
    const plain = box({ fontSize: 120, text: "OOOOO", x: 40, y: 40 });
    const stroked = { ...plain, strokeColor: "#000000", strokeWidth: 0.08, strokeOpacity: 1 };

    const bare = await whitePixels(textOverlaySvg([plain], CANVAS.width, CANVAS.height));
    const outlined = await whitePixels(textOverlaySvg([stroked], CANVAS.width, CANVAS.height));

    expect(bare).toBeGreaterThan(0);
    // 描邊會從外緣往內咬掉一點反鋸齒邊，所以不會逐像素相等；但字心必須大致還在。
    // 少了 paint-order 時這個值會掉到 0（實測），因此 0.6 這個門檻遠比實際餘裕嚴格。
    expect(outlined).toBeGreaterThan(bare * 0.6);
  });

  it("描邊確實畫出來了：背景上多出比底色更暗的墨", async () => {
    const stroked = box({
      fontSize: 120,
      text: "OOOOO",
      x: 40,
      y: 40,
      strokeColor: "#000000",
      strokeWidth: 0.08,
      strokeOpacity: 1,
    });
    const raw = await sharp({
      create: { ...CANVAS, channels: 3, background: "#3a6ea5" },
    })
      .composite([{ input: textOverlaySvg([stroked], CANVAS.width, CANVAS.height), blend: "over" }])
      .raw()
      .toBuffer();
    let dark = 0;
    for (let i = 0; i < raw.length; i += 3)
      if (raw[i]! < 0x20 && raw[i + 1]! < 0x40 && raw[i + 2]! < 0x60) dark++;
    expect(dark).toBeGreaterThan(500);
  });
});

/**
 * PPTX 端。描邊走 pptxgenjs 的 `outline`，它是 **run 層**的 `<a:rPr><a:ln>`——也就是
 * PowerPoint 真正的「文字外框」。刻意不走 `shadow`：那一顆被 pptxgenjs 寫進 `p:spPr`，
 * 套的是文字方塊這個圖形而不是字。這組測試就是釘住「`<a:ln>` 必須落在 `<a:rPr>` 裡」。
 */
describe("描邊的 PPTX 匯出", () => {
  async function exportSlideXml(boxes: EditableTextBox[]): Promise<string> {
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-text-stroke-")),
    );
    await repository.initialize();
    const project = createProject({ topic: "文字描邊", brief: { desiredSlideCount: 1 } });
    const slide = project.slides[0]!;
    const now = new Date().toISOString();
    const background = new Uint8Array(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="#123456"/></svg>`,
      )
        .render()
        .asPng(),
    );
    const backgroundPath = await repository.saveAsset(
      project.id,
      `${slide.id}/background.png`,
      background,
    );
    const versionId = "layered-version";
    slide.versions.push({
      id: versionId,
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
    slide.currentVersionId = versionId;
    const pptx = await exportPresentation(repository, project, "pptx");
    return Buffer.from(unzipSync(pptx)["ppt/slides/slide1.xml"]!).toString("utf8");
  }

  it("沒有描邊時 run 層完全不多出 <a:ln>（＝加入這個功能之前的輸出）", async () => {
    const xml = await exportSlideXml([box()]);
    expect(xml).toContain("標題");
    expect(/<a:rPr[^>]*>(?:(?!<\/a:rPr>).)*<a:ln /s.test(xml)).toBe(false);
  });

  it("描邊落在 <a:rPr> 之內（run 層的文字外框），不是圖形層的效果", async () => {
    const xml = await exportSlideXml([
      box({ strokeColor: "#ff8800", strokeWidth: 0.05, strokeOpacity: 1 }),
    ]);
    const runProps = /<a:rPr[^>]*>((?:(?!<\/a:rPr>).)*)<\/a:rPr>/s.exec(xml);
    expect(runProps).not.toBeNull();
    expect(runProps![1]).toContain("<a:ln ");
    expect(runProps![1]).toContain("FF8800");
    // 圖形層的陰影／效果一個都不該出現。
    expect(xml).not.toContain("outerShdw");
  });

  it("線寬換算：em × 字級 × (7.5in/1080px) × 72 = pt，再由 pptxgenjs 轉成 EMU", async () => {
    const xml = await exportSlideXml([
      box({ fontSize: 72, strokeColor: "#000000", strokeWidth: 0.05 }),
    ]);
    // 72px × 0.05 = 3.6 畫布 px；1 畫布 px = 0.5pt，所以 1.8pt = 22860 EMU（1pt = 12700）。
    expect(xml).toContain(`<a:ln w="${Math.round(1.8 * 12700)}">`);
  });
});

describe("描邊寫得進專案檔", () => {
  it("schema 收下三個欄位，超過上限的粗細與沒有 # 的色值被擋下", () => {
    expect(
      editableTextBoxSchema.safeParse(
        box({ strokeColor: "#000000", strokeWidth: TEXT_STROKE_MAX_WIDTH_EM, strokeOpacity: 0.5 }),
      ).success,
    ).toBe(true);
    expect(
      editableTextBoxSchema.safeParse(
        box({ strokeColor: "#000000", strokeWidth: TEXT_STROKE_MAX_WIDTH_EM + 0.01 }),
      ).success,
    ).toBe(false);
    expect(editableTextBoxSchema.safeParse(box({ strokeColor: "000000" })).success).toBe(false);
  });

  /**
   * 三個欄位是 optional 而不是 `.default()`：舊專案檔載入後不會被塞進描邊欄位，
   * 讀取端的 `textStroke()` 也就維持「沒有 strokeColor＝沒有描邊」。用 `.default()`
   * 的話每一份舊專案一存檔就會多出三個欄位，而且推導型別會變成必填。
   */
  it("沒有描邊欄位的框 parse 完仍然沒有那三個 key", () => {
    const parsed = editableTextBoxSchema.parse(box());
    expect(parsed).not.toHaveProperty("strokeColor");
    expect(parsed).not.toHaveProperty("strokeWidth");
    expect(parsed).not.toHaveProperty("strokeOpacity");
    expect(textStroke(parsed)).toBeUndefined();
  });
});

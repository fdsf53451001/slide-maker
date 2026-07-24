import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { createProject, type EditableTextBox } from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import { exportPresentation } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";
import { textElements } from "../src/text-layers.js";

function box(overrides: Partial<EditableTextBox> = {}): EditableTextBox {
  return {
    id: "box",
    text: "標題",
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

describe("文字框底色的 SVG 合成", () => {
  it("沒設定底色時完全不輸出 <rect>（＝加入這個功能之前的輸出）", () => {
    const svg = textElements([box()]);
    expect(svg).not.toContain("<rect");
    expect(svg.startsWith("<text ")).toBe(true);
  });

  it("底色矩形就是文字框矩形本身，且畫在同一框的 <text> 之前", () => {
    const svg = textElements([box({ backgroundColor: "#112233", backgroundOpacity: 0.5 })]);
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<text"));
    expect(svg).toContain('<rect x="100" y="200" width="800" height="120"');
    expect(svg).toContain('fill="#112233" fill-opacity="0.5"');
  });

  it("省略 backgroundOpacity 時視為 1，且與文字自身的 opacity 互不影響", () => {
    const svg = textElements([box({ backgroundColor: "#ff0000", opacity: 0.25 })]);
    expect(svg).toContain('fill="#ff0000" fill-opacity="1"/>');
    expect(svg).toContain('fill="#ffffff" fill-opacity="0.25"');
  });

  it("旋轉的框：底色與文字套用同一個 rotate transform（繞框中心）", () => {
    const svg = textElements([box({ backgroundColor: "#00ff00", rotation: 12 })]);
    const transform = ' transform="rotate(12 500 260)"';
    expect(svg).toContain(
      `<rect x="100" y="200" width="800" height="120" fill="#00ff00" fill-opacity="1"${transform}/>`,
    );
    expect(svg).toContain(`${transform}>`);
  });

  it("逐框依序輸出 rect+text，不把所有底色集中到最前面", () => {
    const svg = textElements([
      box({ id: "a", text: "第一框", backgroundColor: "#111111" }),
      box({ id: "b", text: "第二框", backgroundColor: "#222222" }),
    ]);
    const order = [...svg.matchAll(/<(rect|text)\b/g)].map((match) => match[1]);
    expect(order).toEqual(["rect", "text", "rect", "text"]);
    // 後面那個框的底色必須在前一個框的文字之後，疊層順序才與編輯器 DOM 一致。
    expect(svg.indexOf("#222222")).toBeGreaterThan(svg.indexOf("第一框"));
  });
});

describe("文字框底色的 PPTX 匯出", () => {
  async function exportSlideXml(boxes: EditableTextBox[]): Promise<string> {
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-text-background-")),
    );
    await repository.initialize();
    const project = createProject({ topic: "文字框底色", brief: { desiredSlideCount: 1 } });
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

  /** 投影片上的圖形數（文字框與底色矩形都是 `<p:sp>`；整版背景圖是 `<p:pic>`）。 */
  const shapeCount = (xml: string) => (xml.match(/<p:sp>/g) ?? []).length;

  it("沒設定底色時不會多出任何形狀（只有文字框本身）", async () => {
    const xml = await exportSlideXml([box()]);
    expect(xml).toContain("標題");
    expect(shapeCount(xml)).toBe(1);
  });

  it("有底色時以獨立矩形畫在文字之前，幾何用框的原始尺寸（不含防換行餘裕）", async () => {
    const xml = await exportSlideXml([
      box({ backgroundColor: "#3366cc", backgroundOpacity: 0.4, rotation: 15 }),
    ]);
    expect(shapeCount(xml)).toBe(2);
    expect(xml.indexOf("3366CC")).toBeLessThan(xml.indexOf("標題"));
    expect(xml).toContain('<a:srgbClr val="3366CC"><a:alpha val="40000"/></a:srgbClr>');
    // 13.333in / 1920px × 100px = 0.6944in = 635000 EMU；1080px 對應 7.5in，200px = 1.3889in。
    const emuX = Math.round(100 * (13.333 / 1920) * 914400);
    const emuY = Math.round(200 * (7.5 / 1080) * 914400);
    const emuW = Math.round(800 * (13.333 / 1920) * 914400);
    const emuH = Math.round(120 * (7.5 / 1080) * 914400);
    expect(xml).toContain(`<a:off x="${emuX}" y="${emuY}"/><a:ext cx="${emuW}" cy="${emuH}"/>`);
    // 旋轉跟著框走（OOXML 的 rot 單位是 1/60000 度）。
    expect(xml).toContain('rot="900000"');
  });

  /** 拆出每個 `<p:sp>` 的旋轉角與框中心（EMU），用來比對底色與文字是否繞同一點轉。 */
  function shapes(xml: string) {
    return xml
      .split("<p:sp>")
      .slice(1)
      .map((chunk) => {
        const offset = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(
          chunk,
        );
        if (!offset) throw new Error("形狀缺少 a:off／a:ext");
        const [x, y, cx, cy] = offset.slice(1).map(Number) as [number, number, number, number];
        return {
          isBackground: chunk.includes("3366CC"),
          rot: /rot="(-?\d+)"/.exec(chunk)?.[1] ?? "",
          centerX: x + cx / 2,
          centerY: y + cy / 2,
        };
      });
  }

  // OOXML 的 rot 是繞各自框的中心轉。底色矩形用框的原始幾何，文字框卻為了防 CJK 換行
  // 往單邊加了 extraWidth 餘裕，兩者中心因此只在 center 對齊時重合——旋轉的框在 PPTX 裡
  // 底色與文字會脫開。這幾條測試釘住的是**現況與其確切量值**（見 exporters.ts 的已知限制
  // 註解）：目前 UI 產不出 rotation ≠ 0 的框，而要修就得改動 ocr-geometry-roundtrip／
  // pdf-import-qa 釘住的文字落點模型。哪天真的修好，這裡會紅，記得一起更新。
  const halfSlackEmu = Math.round(((72 / 2) * (13.333 / 1920) - 0) * 914400);
  for (const [align, expectedShift] of [
    ["left", halfSlackEmu],
    ["center", 0],
    ["right", -halfSlackEmu],
  ] as const) {
    it(`旋轉的框：底色與文字的旋轉中心相差 ${expectedShift} EMU（align=${align}，已知限制）`, async () => {
      const xml = await exportSlideXml([
        box({ backgroundColor: "#3366cc", rotation: 30, align, text: "標題" }),
      ]);
      const parsed = shapes(xml);
      const background = parsed.find((shape) => shape.isBackground);
      const text = parsed.find((shape) => !shape.isBackground);
      expect(background).toBeDefined();
      expect(text).toBeDefined();
      // 容許 1 EMU（1/914400 英吋）的整數捨入差：框寬為奇數 EMU 時中心會落在半個 EMU 上。
      expect(text!.centerX - background!.centerX).toBeCloseTo(expectedShift, -0.5);
      expect(Math.abs(text!.centerY - background!.centerY)).toBeLessThanOrEqual(1);
      // 角度本身兩者一律相同，脫開純粹來自中心不同。
      expect(text!.rot).toBe(background!.rot);
      expect(background!.rot).toBe("1800000");
    });
  }
});

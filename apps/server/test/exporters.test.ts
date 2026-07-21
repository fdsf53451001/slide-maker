import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createProject } from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { compressPptxImage, exportPresentation, resolvePptxConstructor } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

describe("PPTX module interop", () => {
  it("accepts direct, wrapped, and double-wrapped constructors", () => {
    class FakePptx {}
    expect(resolvePptxConstructor(FakePptx)).toBe(FakePptx);
    expect(resolvePptxConstructor({ default: FakePptx })).toBe(FakePptx);
    expect(resolvePptxConstructor({ default: { default: FakePptx } })).toBe(FakePptx);
  });

  it("rejects a module without a constructor", () => {
    expect(() => resolvePptxConstructor({ default: {} })).toThrow("PPTX_EXPORTER_UNAVAILABLE");
  });

  it("converts full-slide PNG artwork to a materially smaller high-quality JPEG", async () => {
    const png = new Uint8Array(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="g"><stop stop-color="#001122"/><stop offset="1" stop-color="#44ddff"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#g)"/><text x="100" y="500" fill="white" font-size="120">Compression Test</text></svg>`,
      )
        .render()
        .asPng(),
    );
    const jpeg = await compressPptxImage(png);
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(jpeg.length).toBeLessThan(png.length * 0.6);
  });

  it("exports layered slide text as editable PPTX text objects", async () => {
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-layered-pptx-")),
    );
    await repository.initialize();
    const project = createProject({ topic: "可編輯文字", brief: { desiredSlideCount: 1 } });
    const slide = project.slides[0]!;
    const versionId = "layered-version";
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
        boxes: [
          {
            id: "box",
            text: "可編輯標題",
            x: 100,
            y: 100,
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
            verticalAlign: "middle",
            rotation: 0,
            confidence: 0.99,
            role: "presentation",
          },
        ],
      },
    });
    slide.currentVersionId = versionId;
    const pptx = await exportPresentation(repository, project, "pptx");
    const entries = unzipSync(pptx);
    const xml = Buffer.from(entries["ppt/slides/slide1.xml"]!).toString("utf8");
    expect(xml).toContain("可編輯標題");
    expect(xml).toContain("<a:t>");
    // 文字框幾何來自貼齊字墨的緊框：必須關閉自動換行與 autofit，
    // 否則 PowerPoint 的 CJK 字型 advance 略寬就會折行／縮字造成跑版。
    expect(xml).toContain('wrap="none"');
    expect(xml).not.toContain("normAutofit");
    // 行距鎖定為編輯器的 line-height 模型（exact spacing，非字型預設行距）。
    expect(xml).toContain("<a:spcPts");
  });
});

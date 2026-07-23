import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createProject } from "@slide-maker/core";
import { beforeAll, describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { randomBytes } from "node:crypto";
import {
  compressSlideImage,
  exportPresentation,
  resolvePptxConstructor,
  withPageNumber,
} from "../src/exporters.js";
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
    const jpeg = await compressSlideImage(png);
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(jpeg.length).toBeLessThan(png.length * 0.6);
  });

  it("flattens transparency onto black instead of dropping the alpha channel", async () => {
    // 半透明白（alpha 0.5）疊黑底應該落在中灰；若 sharp 只是丟掉 alpha 通道，
    // 留下的 RGB 會是純白（255）。
    const translucent = new Uint8Array(
      await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer(),
    );
    const { data, info } = await sharp(await compressSlideImage(translucent))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(data[0]).toBeGreaterThan(100);
    expect(data[0]).toBeLessThan(155);
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

describe("PDF export", () => {
  /** 高熵雜訊：PNG 幾乎壓不掉，是「有損編碼才是唯一槓桿」的最誠實對照組。 */
  let noise: Uint8Array;
  beforeAll(async () => {
    noise = new Uint8Array(
      await sharp(randomBytes(960 * 540 * 3), { raw: { width: 960, height: 540, channels: 3 } })
        .png()
        .toBuffer(),
    );
  }, 60_000);

  async function projectWithSlides(slideCount: number, image: Uint8Array) {
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-pdf-export-")),
    );
    await repository.initialize();
    const project = createProject({ topic: "PDF 匯出", brief: { desiredSlideCount: slideCount } });
    const now = new Date().toISOString();
    for (const slide of project.slides) {
      const imagePath = await repository.saveAsset(project.id, `${slide.id}/v1.png`, image);
      slide.versions.push({
        id: `${slide.id}-v1`,
        imagePath,
        prompt: "",
        providerId: "test",
        model: "test",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      });
      slide.currentVersionId = `${slide.id}-v1`;
    }
    return { repository, project };
  }

  /** PDF 裡所有影像 XObject 的原始串流，順序即 pdf-lib 的物件編號順序（＝頁面順序）。 */
  function imageStreams(pdf: PDFDocument): PDFRawStream[] {
    return pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object)
      .filter(
        (object): object is PDFRawStream =>
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
      );
  }

  /** 每個影像 XObject 的 `/Filter`；PNG 內嵌是 FlateDecode，JPEG 內嵌是 DCTDecode。 */
  function imageFilters(pdf: PDFDocument): string[] {
    return imageStreams(pdf).map((stream) => String(stream.dict.get(PDFName.of("Filter"))));
  }

  it("embeds JPEG (DCTDecode) artwork and keeps page count and geometry", async () => {
    const { repository, project } = await projectWithSlides(3, noise);
    const bytes = await exportPresentation(repository, project, "pdf");

    const pdf = await PDFDocument.load(bytes);
    const filters = imageFilters(pdf);
    expect(filters).toHaveLength(project.slides.length);
    expect(filters.every((filter) => filter === "/DCTDecode")).toBe(true);

    expect(pdf.getPageCount()).toBe(project.slides.length);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBe(960);
      expect(page.getHeight()).toBe(540);
    }
    expect(pdf.getTitle()).toBe(project.name);
    expect(pdf.getCreator()).toBe("Slide Maker");
  }, 60_000);

  it("lands far below the PNG-embedded equivalent", async () => {
    const { repository, project } = await projectWithSlides(3, noise);
    const bytes = await exportPresentation(repository, project, "pdf");

    // 對照組：同樣的頁面，但影像照舊以 PNG 內嵌。
    const baseline = await PDFDocument.create();
    for (let index = 0; index < project.slides.length; index += 1) {
      const image = await baseline.embedPng(noise);
      baseline.addPage([960, 540]).drawImage(image, { x: 0, y: 0, width: 960, height: 540 });
    }
    const baselineBytes = await baseline.save({ useObjectStreams: false });

    expect(imageFilters(await PDFDocument.load(baselineBytes))).toEqual(
      Array.from({ length: project.slides.length }, () => "/FlateDecode"),
    );
    expect(bytes.length).toBeLessThan(baselineBytes.length * 0.6);
  }, 60_000);

  it("單趟疊頁碼＋壓縮與舊的兩趟路徑輸出位元等價", async () => {
    // exportPdf 對有頁碼的頁面只跑一條 sharp pipeline（composite → flatten → JPEG），
    // 不再產出一份立刻被丟棄的中間 PNG。這條測試把「舊的兩趟路徑」釘成對照組：
    // 任何一邊的 resize／composite／flatten／JPEG 參數被動到，這裡就會紅。
    const slide = new Uint8Array(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="g"><stop stop-color="#101820"/><stop offset="1" stop-color="#f2aa4c"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#g)"/><text x="120" y="540" fill="#ffffff" font-size="140">等價性</text></svg>`,
      )
        .render()
        .asPng(),
    );
    const { repository, project } = await projectWithSlides(3, slide);
    project.pageNumber = {
      ...project.pageNumber,
      enabled: true,
      skipFirstSlide: false,
      color: "#ffffff",
      opacity: 1,
    };

    const pdf = await PDFDocument.load(await exportPresentation(repository, project, "pdf"));
    // 逐頁取自己的影像 XObject，才不會把「第 N 頁」的比對建立在物件編號順序的巧合上。
    const embedded = pdf.getPages().map((page) => {
      const xObjects = page.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
      const streams = (xObjects?.keys() ?? [])
        .map((key) => xObjects?.lookup(key))
        .filter((object): object is PDFRawStream => object instanceof PDFRawStream);
      expect(streams).toHaveLength(1);
      return Buffer.from(streams[0]!.getContents());
    });
    expect(embedded).toHaveLength(project.slides.length);

    for (const [order, actual] of embedded.entries()) {
      // 舊路徑：withPageNumber 先合成一份 PNG，再交給 compressSlideImage 解碼重編。
      const expected = Buffer.from(
        await compressSlideImage(await withPageNumber(project, order, slide)),
      );
      expect(actual.equals(expected), `第 ${order + 1} 頁`).toBe(true);
    }
  }, 120_000);
});

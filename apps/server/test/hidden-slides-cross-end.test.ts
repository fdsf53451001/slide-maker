import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createProject, pageNumberSlideLabel, type PresentationProject } from "@slide-maker/core";
import { exportPresentation, pageNumberSvg, withPageNumber } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

/**
 * 跨端一致性：同一份專案（5 頁、隱藏第 3 頁）的頁碼在四個渲染端必須是同一組數字。
 *
 * 這一份刻意不重複 `hidden-slides-export.test.ts` 的「哪一端各自算對了」，而是把
 * **四端擺在同一個 expect 裡互相對照**——頁碼是專案級系統合成物，三端各自算對但彼此差 1
 * 的失效模式（例如只有 PPTX 改用 `pageNumberSlideLabel`、SVG 那條忘了跟上）不會被
 * 任何單端的測試抓到。
 */

/** 每頁一個可辨識的灰階，才能證明成品裡的是「哪一頁」而不只是「幾頁」。 */
function shadeSlide(level: number): Uint8Array {
  const hex = level.toString(16).padStart(2, "0");
  return new Uint8Array(
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="#${hex}${hex}${hex}"/></svg>`,
    )
      .render()
      .asPng(),
  );
}

const SHADES = [16, 64, 112, 160, 208];

async function deck(hiddenOrders: number[], slideCount = 5) {
  const repository = new FileProjectRepository(
    await mkdtemp(join(tmpdir(), "slide-maker-hidden-cross-end-")),
  );
  await repository.initialize();
  const project = createProject({
    topic: "跨端頁碼一致",
    brief: { desiredSlideCount: slideCount },
  });
  const now = new Date().toISOString();
  for (const [index, slide] of project.slides.entries()) {
    slide.hidden = hiddenOrders.includes(slide.order);
    const imagePath = await repository.saveAsset(
      project.id,
      `${slide.id}/v1.png`,
      shadeSlide(SHADES[index]!),
    );
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

function enablePageNumber(
  project: PresentationProject,
  overrides: { skipFirstSlide?: boolean } = {},
) {
  project.pageNumber = {
    ...project.pageNumber,
    enabled: true,
    skipFirstSlide: overrides.skipFirstSlide ?? false,
    format: "number-total",
  };
}

/** PPTX 每張投影片上的第一個文字物件；這份專案沒有文字層與 sources，剩下的只會是頁碼。 */
function pptxSlideTexts(bundle: Uint8Array): (string | undefined)[] {
  const entries = unzipSync(bundle);
  return Object.keys(entries)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
    .map((name) => /<a:t>([^<]*)<\/a:t>/.exec(Buffer.from(entries[name]!).toString("utf8"))?.[1]);
}

/**
 * PDF 每一頁內嵌的那張圖（`exportPdf` 走 `embedJpg`，DCTDecode 的 stream 就是 JPEG 原位元組）。
 * 逐頁走 Resources／XObject 而不是全檔掃 `FFD8`，才對得上「第幾頁裝的是哪一張」。
 */
function pdfPageJpegs(pdf: PDFDocument): Uint8Array[] {
  return pdf.getPages().map((page) => {
    const xObjects = page.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
    if (!xObjects) throw new Error("PDF page has no XObject resources");
    const streams = xObjects
      .entries()
      .map(([, reference]) => pdf.context.lookup(reference))
      .filter((value): value is PDFRawStream => value instanceof PDFRawStream);
    if (streams.length !== 1) throw new Error(`Expected 1 image per page, got ${streams.length}`);
    return streams[0]!.contents;
  });
}

/**
 * 左上角 16×16 的平均灰階＝這張圖原本是哪一頁（頁碼落在右下角，碰不到這一塊）。
 * JPEG q88 對純色區域是無損等級的，四捨五入後就是原始 shade。
 */
async function shadeOf(image: Uint8Array): Promise<number> {
  const stats = await sharp(image).extract({ left: 0, top: 0, width: 16, height: 16 }).stats();
  return Math.round(stats.channels[0]!.mean);
}

describe("五頁隱藏第 3 頁：四個渲染端的頁碼是同一組數字", () => {
  it("core／伺服器 SVG／PPTX／png.zip 對每一個 order 算出同一個標籤", async () => {
    const { repository, project } = await deck([2]);
    enablePageNumber(project);

    // 這一組數字就是驗收基準：可見頁 1、2、3、4，分母只算可見頁，隱藏頁沒有頁碼。
    const expected = ["1 / 4", "2 / 4", undefined, "3 / 4", "4 / 4"];

    // ① core 的唯一真相（編輯器畫布與簡報模式的 PageNumberOverlay 直接呼叫它）。
    expect(
      project.slides.map((slide) =>
        pageNumberSlideLabel(project.pageNumber, project.slides, slide.order),
      ),
    ).toEqual(expected);

    // ② 伺服器 SVG 合成（png.zip 與 pdf 共用）。
    const svgLabelOf = (order: number) => {
      const svg = pageNumberSvg(project, order);
      if (!svg) return undefined;
      // 標籤在 `<tspan>` 裡（`textOverlaySvg` 每一行一個 tspan），不是 `<text>` 的直接文字。
      return /<tspan[^>]*>([^<]*)<\/tspan>/.exec(svg.toString("utf8"))?.[1];
    };
    expect(project.slides.map((slide) => svgLabelOf(slide.order))).toEqual(expected);

    // ③ PPTX 文字框：隱藏頁不在成品裡，所以只剩四張投影片的四個標籤。
    expect(pptxSlideTexts(await exportPresentation(repository, project, "pptx"))).toEqual(
      expected.filter((label): label is string => label !== undefined),
    );
  }, 180_000);

  it("png.zip 的第 4 個檔就是「order 3 疊上 3 / 4」那份位元組", async () => {
    const { repository, project } = await deck([2]);
    enablePageNumber(project);
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));

    // 檔名維持 order+1（png.zip 不排除隱藏頁），內容則是可見序的頁碼。
    const expectedFourth = await withPageNumber(project, 3, shadeSlide(SHADES[3]!));
    expect(Buffer.from(entries["004.png"]!).equals(Buffer.from(expectedFourth))).toBe(true);
    // 若這一端誤用 raw order，第 4 個檔會等於「疊上 4 / 5」的那份而不是這一份。
    const rawOrderProject = {
      ...project,
      slides: project.slides.map((s) => ({ ...s, hidden: false })),
    };
    const rawOrderFourth = await withPageNumber(rawOrderProject, 3, shadeSlide(SHADES[3]!));
    expect(Buffer.from(expectedFourth).equals(Buffer.from(rawOrderFourth))).toBe(false);
  }, 180_000);

  it("pdf 的頁數與內容都只有可見頁，且順序不變", async () => {
    const { repository, project } = await deck([2]);
    enablePageNumber(project);
    const pdf = await PDFDocument.load(await exportPresentation(repository, project, "pdf"));

    expect(pdf.getPageCount()).toBe(4);
    const shades = await Promise.all(pdfPageJpegs(pdf).map(shadeOf));
    // 隱藏的 SHADES[2] 不在裡面，其餘四張維持原順序。
    expect(shades).toEqual([SHADES[0], SHADES[1], SHADES[3], SHADES[4]]);
  }, 180_000);

  it("pptx 的投影片數也只有可見頁", async () => {
    const { repository, project } = await deck([1, 2]);
    const entries = unzipSync(await exportPresentation(repository, project, "pptx"));
    expect(
      Object.keys(entries).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
    ).toHaveLength(3);
  }, 180_000);
});

describe("png.zip 對「沒有頁碼的頁」的原圖保真，在有隱藏頁時仍然成立", () => {
  it("整份關閉頁碼時，五個檔（含隱藏頁）都是原封不動的位元組", async () => {
    const { repository, project } = await deck([1, 3]);
    // 刻意不開頁碼：PDF 匯入的原圖保真承諾走的就是這條路。
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    for (const [index, slide] of project.slides.entries())
      expect(
        Buffer.from(entries[`${String(slide.order + 1).padStart(3, "0")}.png`]!).equals(
          Buffer.from(shadeSlide(SHADES[index]!)),
        ),
      ).toBe(true);
  }, 180_000);

  it("skipFirstSlide 配上被隱藏的封面：隱藏頁與接手當封面的那一頁都保持原位元組", async () => {
    const { repository, project } = await deck([0]);
    enablePageNumber(project, { skipFirstSlide: true });
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));

    // order 0 隱藏＝沒有頁碼；order 1 是第一張可見頁、被 skipFirstSlide 跳過＝也沒有頁碼。
    // 兩者都必須完全不進 sharp，位元組與來源相同。
    expect(Buffer.from(entries["001.png"]!).equals(Buffer.from(shadeSlide(SHADES[0]!)))).toBe(true);
    expect(Buffer.from(entries["002.png"]!).equals(Buffer.from(shadeSlide(SHADES[1]!)))).toBe(true);
    // order 2 是可見序的第 1 頁，有頁碼＝被重新編碼過。
    expect(Buffer.from(entries["003.png"]!).equals(Buffer.from(shadeSlide(SHADES[2]!)))).toBe(
      false,
    );
  }, 180_000);

  it("全部頁面都被隱藏時 png.zip 仍是完整五個檔，且都是原位元組", async () => {
    const { repository, project } = await deck([0, 1, 2, 3, 4]);
    enablePageNumber(project);
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    expect(Object.keys(entries)).toHaveLength(5);
    for (const [index, slide] of project.slides.entries())
      expect(
        Buffer.from(entries[`${String(slide.order + 1).padStart(3, "0")}.png`]!).equals(
          Buffer.from(shadeSlide(SHADES[index]!)),
        ),
      ).toBe(true);
  }, 180_000);

  /**
   * 全部隱藏時 `pptx`／`pdf` 必須**拒絕**匯出，而不是產出「合法但退化」的檔案。
   *
   * 這一條原本釘的是相反的東西——當時的現況是 pptx 收到零張投影片、pdf 更糟：
   * `PDFDocument.save()` 對沒有頁面的文件會自己補一張空白 A4 直式頁（595.28×841.89），
   * 使用者拿到的是一張與 16:9 簡報毫無關係的白紙，而 HTTP 是 200。簡報模式對這個狀態
   * 早就有明確防護（不進場並說明原因），匯出這條路現在也有了：`EXPORT_NO_VISIBLE_SLIDES`
   * 經統一 error handler 轉成 400＋繁中說明。
   */
  it("全部隱藏時 pptx／pdf 拒絕匯出，不產出零張投影片或空白 A4", async () => {
    const { repository, project } = await deck([0, 1, 2, 3, 4]);

    await expect(exportPresentation(repository, project, "pdf")).rejects.toThrow(
      "EXPORT_NO_VISIBLE_SLIDES",
    );
    await expect(exportPresentation(repository, project, "pptx")).rejects.toThrow(
      "EXPORT_NO_VISIBLE_SLIDES",
    );
  }, 180_000);

  it("只剩一張可見頁時照樣匯得出來——防線只擋「零張」", async () => {
    const { repository, project } = await deck([0, 1, 2, 3]);
    const pdf = await PDFDocument.load(await exportPresentation(repository, project, "pdf"));
    expect(pdf.getPageCount()).toBe(1);
    // 而且是簡報該有的 960×540 橫式，不是 pdf-lib 補出來的空白 A4。
    const { width, height } = pdf.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([960, 540]);
    expect(pdf.getPage(0).node.Resources()?.get(PDFName.of("XObject"))).toBeDefined();

    const entries = unzipSync(await exportPresentation(repository, project, "pptx"));
    expect(
      Object.keys(entries).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
    ).toHaveLength(1);
  }, 180_000);
});

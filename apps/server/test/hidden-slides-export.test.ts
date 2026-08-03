import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { exportPresentation, pageNumberSvg, parseProjectBundle } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

/** 每頁一個可辨識的灰階，才能證明成品裡少掉／留下的是「哪一頁」而不只是「幾頁」。 */
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

/**
 * 五頁的專案，每頁一張自己的灰階圖，`hiddenOrders` 指定哪幾頁是隱藏的。
 * `withoutImageOrders` 的頁面刻意不給版本——用來釘住「隱藏的空白頁不該讓匯出整份失敗」。
 */
async function deck(hiddenOrders: number[], withoutImageOrders: number[] = []) {
  const repository = new FileProjectRepository(
    await mkdtemp(join(tmpdir(), "slide-maker-hidden-slides-")),
  );
  await repository.initialize();
  const project = createProject({ topic: "隱藏頁匯出", brief: { desiredSlideCount: 5 } });
  const now = new Date().toISOString();
  for (const [index, slide] of project.slides.entries()) {
    slide.hidden = hiddenOrders.includes(slide.order);
    if (withoutImageOrders.includes(slide.order)) continue;
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

function enablePageNumber(project: PresentationProject, skipFirstSlide = false) {
  project.pageNumber = {
    ...project.pageNumber,
    enabled: true,
    skipFirstSlide,
    format: "number-total",
  };
}

/** PPTX 每張投影片上的文字物件；這份專案沒有文字層與 sources，所以剩下的只會是頁碼。 */
function pptxSlideTexts(bundle: Uint8Array): (string | undefined)[] {
  const entries = unzipSync(bundle);
  const names = Object.keys(entries)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  return names.map((name) => {
    const xml = Buffer.from(entries[name]!).toString("utf8");
    return /<a:t>([^<]*)<\/a:t>/.exec(xml)?.[1];
  });
}

describe("隱藏頁不進 pptx／pdf 成品", () => {
  it("pptx 只有可見頁，且頁碼是可見序（5 頁隱藏第 3 頁 → 1、2、3、4）", async () => {
    const { repository, project } = await deck([2]);
    enablePageNumber(project);
    expect(pptxSlideTexts(await exportPresentation(repository, project, "pptx"))).toEqual([
      "1 / 4",
      "2 / 4",
      "3 / 4",
      "4 / 4",
    ]);
  }, 120_000);

  it("pdf 的頁數只算可見頁", async () => {
    const { repository, project } = await deck([1, 3]);
    const pdf = await PDFDocument.load(await exportPresentation(repository, project, "pdf"));
    expect(pdf.getPageCount()).toBe(3);
  }, 120_000);

  it("隱藏頁還沒生成圖片時**帶圖的那四種格式**都匯得出來（它根本沒有位元組可以輸出）", async () => {
    // 濾在查版本之後的話這裡會是 SLIDE_VERSION_MISSING。三種格式修好、`png.zip` 單獨掛掉
    // 是更糟的狀態：匯出連結是裸 `<a href>`，使用者會在瀏覽器分頁看到一段 JSON，
    // 而同一份專案的另外三個下載都正常。
    const { repository, project } = await deck([4], [4]);
    const pdf = await PDFDocument.load(await exportPresentation(repository, project, "pdf"));
    expect(pdf.getPageCount()).toBe(4);
    expect(pptxSlideTexts(await exportPresentation(repository, project, "pptx"))).toHaveLength(4);
    // png.zip 少掉的正是那一頁（沒有圖），其餘四頁照原本的 order+1 編號。
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    expect(Object.keys(entries).sort()).toEqual(["001.png", "002.png", "003.png", "004.png"]);
    await expect(exportPresentation(repository, project, "slide-project")).resolves.toBeInstanceOf(
      Uint8Array,
    );
  }, 120_000);

  it("隱藏頁**有**圖時 png.zip 仍然照常輸出它（略過只針對「沒有東西可輸出」）", async () => {
    const { repository, project } = await deck([1]);
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    expect(Object.keys(entries)).toContain("002.png");
    expect(Buffer.from(entries["002.png"]!).equals(Buffer.from(shadeSlide(SHADES[1]!)))).toBe(true);
  }, 120_000);

  // `outline.md` 不在這一組裡：它一個資產都不讀，缺圖對它不是狀態（見 export-outline-md）。
  it("可見頁沒有圖仍然是錯誤，帶圖的那四種格式一起說同一個故事", async () => {
    const { repository, project } = await deck([], [3]);
    for (const format of ["pdf", "pptx", "png.zip"] as const)
      await expect(exportPresentation(repository, project, format), format).rejects.toThrow(
        "SLIDE_VERSION_MISSING:4",
      );
  }, 120_000);

  it("可見頁沒有圖、同時另有一張隱藏的空白頁：報的仍是那張**可見**頁", async () => {
    // 頁號取自 order+1，不能被前面略過的隱藏頁位移。
    const { repository, project } = await deck([1], [1, 3]);
    await expect(exportPresentation(repository, project, "png.zip")).rejects.toThrow(
      "SLIDE_VERSION_MISSING:4",
    );
  }, 120_000);
});

describe("png.zip 與 slide-project 照常收錄隱藏頁", () => {
  it("png.zip 仍是 5 個檔，編號維持 order+1（中間不會空掉也不會補位）", async () => {
    const { repository, project } = await deck([2]);
    enablePageNumber(project);
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    expect(Object.keys(entries).sort()).toEqual([
      "001.png",
      "002.png",
      "003.png",
      "004.png",
      "005.png",
    ]);
    // 隱藏頁沒有頁碼＝完全不進合成路徑，位元組與原圖相同；可見頁則被重新編碼過。
    expect(Buffer.from(entries["003.png"]!).equals(Buffer.from(shadeSlide(SHADES[2]!)))).toBe(true);
    expect(Buffer.from(entries["004.png"]!).equals(Buffer.from(shadeSlide(SHADES[3]!)))).toBe(
      false,
    );
  }, 120_000);

  it("slide-project 封存全部頁面，hidden 旗標一併寫進 project.json", async () => {
    const { repository, project } = await deck([1, 4]);
    const entries = unzipSync(await exportPresentation(repository, project, "slide-project"));
    const archived = JSON.parse(
      Buffer.from(entries["project.json"]!).toString("utf8"),
    ) as PresentationProject;

    expect(archived.slides).toHaveLength(5);
    expect(archived.slides.map((slide) => slide.hidden)).toEqual([false, true, false, false, true]);
  }, 120_000);

  it("封存再解析回來仍是同一組隱藏頁", async () => {
    const { repository, project } = await deck([0, 3]);
    const bundle = parseProjectBundle(
      await exportPresentation(repository, project, "slide-project"),
    );
    expect(bundle.project.slides.map((slide) => slide.hidden)).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  }, 120_000);
});

describe("伺服器 SVG 合成端的頁碼與其他三端同一份", () => {
  it("隱藏頁沒有頁碼疊圖，可見頁的分子分母都只算可見頁", () => {
    const project = createProject({ topic: "隱藏頁頁碼", brief: { desiredSlideCount: 5 } });
    project.slides[2]!.hidden = true;
    enablePageNumber(project);

    expect(pageNumberSvg(project, 2)).toBeUndefined();
    const svgOf = (order: number) => pageNumberSvg(project, order)!.toString("utf8");
    expect(svgOf(0)).toContain(">1 / 4<");
    expect(svgOf(1)).toContain(">2 / 4<");
    expect(svgOf(3)).toContain(">3 / 4<");
    expect(svgOf(4)).toContain(">4 / 4<");
  });

  it("skipFirstSlide 跳過的是第一張可見頁", () => {
    const project = createProject({ topic: "隱藏封面", brief: { desiredSlideCount: 4 } });
    project.slides[0]!.hidden = true;
    enablePageNumber(project, true);

    expect(pageNumberSvg(project, 0)).toBeUndefined();
    expect(pageNumberSvg(project, 1)).toBeUndefined();
    expect(pageNumberSvg(project, 2)!.toString("utf8")).toContain(">1 / 2<");
  });
});

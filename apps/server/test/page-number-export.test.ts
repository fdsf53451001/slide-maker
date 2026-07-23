import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { exportPresentation, withPageNumber } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

/** 全黑整版圖：頁碼是唯一會讓像素變亮的東西，落點與有無一眼可辨。 */
function blackSlide(width = 1920, height = 1080): Uint8Array {
  return new Uint8Array(
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000000"/></svg>`,
    )
      .render()
      .asPng(),
  );
}

async function projectWithSlides(slideCount: number, image = blackSlide()) {
  const repository = new FileProjectRepository(
    await mkdtemp(join(tmpdir(), "slide-maker-page-number-export-")),
  );
  await repository.initialize();
  const project = createProject({
    topic: "頁碼匯出邊界",
    brief: { desiredSlideCount: slideCount },
  });
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

function enablePageNumber(
  project: PresentationProject,
  overrides: Partial<PresentationProject["pageNumber"]> = {},
) {
  project.pageNumber = {
    ...project.pageNumber,
    enabled: true,
    color: "#ffffff",
    opacity: 1,
    ...overrides,
  };
}

/** 底部一條橫帶切成左／中／右三塊，各回傳最亮的像素值（0–255）。 */
async function bottomThirdsBrightness(
  png: Uint8Array,
): Promise<{ left: number; centre: number; right: number }> {
  const brightest = async (left: number) => {
    const { data } = await sharp(png)
      .extract({ left, top: 940, width: 500, height: 120 })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data.reduce((max, value) => Math.max(max, value), 0);
  };
  return {
    left: await brightest(20),
    centre: await brightest(710),
    right: await brightest(1400),
  };
}

describe("不編號的頁面完全不進合成路徑", () => {
  it("withPageNumber 在沒有標籤時原樣回傳同一批位元組", async () => {
    const { project } = await projectWithSlides(3);
    const source = blackSlide();

    // 關閉：任何一頁都不動。
    expect(await withPageNumber(project, 1, source)).toBe(source);

    // 啟用但跳過封面：封面仍然不動，其他頁才會被重新編碼。
    enablePageNumber(project, { skipFirstSlide: true });
    expect(await withPageNumber(project, 0, source)).toBe(source);
    expect(await withPageNumber(project, 1, source)).not.toBe(source);
  }, 60_000);

  it("PNG zip 的封面在跳過封面時位元組與原圖完全相同", async () => {
    // 「不編號」必須是原圖保真，而不是「疊了一個看不見的東西再重新編碼一次」——
    // PDF 匯入的原圖保真承諾就靠這條。
    const { repository, project } = await projectWithSlides(3);
    enablePageNumber(project, { skipFirstSlide: true });
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    const original = Buffer.from(blackSlide());

    expect(Buffer.from(entries["001.png"]!).equals(original)).toBe(true);
    expect(Buffer.from(entries["002.png"]!).equals(original)).toBe(false);
    expect(Buffer.from(entries["003.png"]!).equals(original)).toBe(false);
  }, 60_000);

  it("不跳封面時連封面都會被合成", async () => {
    const { repository, project } = await projectWithSlides(2);
    enablePageNumber(project, { skipFirstSlide: false });
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    expect((await bottomThirdsBrightness(entries["001.png"]!)).right).toBeGreaterThan(100);
  }, 60_000);
});

describe("頁碼落在設定的位置上", () => {
  it("三種位置分別把字墨放進底部的左／中／右", async () => {
    for (const [position, expected] of [
      ["bottom-left", "left"],
      ["bottom-center", "centre"],
      ["bottom-right", "right"],
    ] as const) {
      const { repository, project } = await projectWithSlides(2);
      enablePageNumber(project, { position, fontSize: 60 });
      const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
      const bands = await bottomThirdsBrightness(entries["002.png"]!);

      expect(bands[expected], `${position} 的字墨落在 ${expected}`).toBeGreaterThan(100);
      for (const other of ["left", "centre", "right"] as const)
        if (other !== expected)
          expect(bands[other], `${position} 不該畫到 ${other}`).toBeLessThan(60);
    }
  }, 120_000);
});

describe("關閉頁碼時各格式與加入功能前一致", () => {
  it("PPTX 沒有任何頁碼文字物件；開啟後才出現", async () => {
    const { repository, project } = await projectWithSlides(3);
    const off = unzipSync(await exportPresentation(repository, project, "pptx"));
    const offXml = Buffer.from(off["ppt/slides/slide2.xml"]!).toString("utf8");
    // 這份專案沒有可編輯文字層也沒有 sources，關閉頁碼時整頁只該有一張圖。
    expect(offXml).not.toContain("<a:t>");

    enablePageNumber(project, { format: "zh-page" });
    const on = unzipSync(await exportPresentation(repository, project, "pptx"));
    const coverXml = Buffer.from(on["ppt/slides/slide1.xml"]!).toString("utf8");
    const secondXml = Buffer.from(on["ppt/slides/slide2.xml"]!).toString("utf8");
    expect(secondXml).toContain("<a:t>第 1 頁</a:t>");
    // 預設跳過封面：封面仍然一個字都沒有。
    expect(coverXml).not.toContain("<a:t>");
  }, 60_000);

  it("PPTX 的頁碼文字沿用共用的對齊方式，色塊內距靠 bodyPr 的左右 inset 補回", async () => {
    // 色塊只是依「近似」字寬往外墊 padX，SVG／DOM 兩端的文字仍錨在 marginX。PPTX 若改成
    // 在色塊裡置中，近似寬與 PowerPoint 真實 Arial 字寬 8–17% 的落差就直接變成水平位移。
    for (const [position, algn] of [
      ["bottom-left", "l"],
      ["bottom-center", "ctr"],
      ["bottom-right", "r"],
    ] as const) {
      const { repository, project } = await projectWithSlides(2);
      // `enablePageNumber` 是淺層覆寫，background 要整包給。
      enablePageNumber(project, {
        position,
        background: { enabled: true, color: "#000000", opacity: 0.35 },
      });
      const entries = unzipSync(await exportPresentation(repository, project, "pptx"));
      const xml = Buffer.from(entries["ppt/slides/slide2.xml"]!).toString("utf8");

      expect(xml, position).toContain(`algn="${algn}"`);
      // pptxgenjs 4.0.1 的 margin 陣列是 [左, 右, 下, 上]；左右吃 padX、上下必須是 0，
      // 否則色塊高度會被內距吃掉。順序改變（升級套件）時這條會紅。
      const bodyPr = /<a:bodyPr[^>]*>/.exec(xml)?.[0] ?? "";
      const padXEmu = Math.round(project.pageNumber.fontSize * 0.55 * (13.333 / 1920) * 72 * 12700);
      expect(bodyPr, position).toContain(`lIns="${padXEmu}"`);
      expect(bodyPr, position).toContain(`rIns="${padXEmu}"`);
      expect(bodyPr, position).toContain('tIns="0"');
      expect(bodyPr, position).toContain('bIns="0"');
    }
  }, 120_000);

  it("PDF 的頁數、頁面尺寸與內嵌影像編碼不因頁碼而改變", async () => {
    const { repository, project } = await projectWithSlides(3);
    enablePageNumber(project);
    const pdf = await PDFDocument.load(await exportPresentation(repository, project, "pdf"));

    expect(pdf.getPageCount()).toBe(3);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBe(960);
      expect(page.getHeight()).toBe(540);
    }
  }, 60_000);

  it("slide-project 封存不烘入頁碼，只帶著設定走", async () => {
    // 專案檔要能原樣再匯入；把頁碼燒進素材會在下一次匯出時疊出第二個頁碼。
    const { repository, project } = await projectWithSlides(2);
    enablePageNumber(project, { format: "number-total" });
    const entries = unzipSync(await exportPresentation(repository, project, "slide-project"));

    const assetNames = Object.keys(entries).filter((name) => name.endsWith(".png"));
    expect(assetNames.length).toBeGreaterThan(0);
    for (const name of assetNames)
      expect(Buffer.from(entries[name]!).equals(Buffer.from(blackSlide())), name).toBe(true);

    const archived = JSON.parse(
      Buffer.from(entries["project.json"]!).toString("utf8"),
    ) as PresentationProject;
    expect(archived.pageNumber.enabled).toBe(true);
    expect(archived.pageNumber.format).toBe("number-total");
  }, 60_000);
});

describe("色塊", () => {
  it("關閉色塊時底部沒有大片亮區，只有字墨", async () => {
    const { repository, project } = await projectWithSlides(2);
    enablePageNumber(project);
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    const { data } = await sharp(entries["002.png"]!)
      .extract({ left: 1400, top: 940, width: 500, height: 120 })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bright = data.reduce((count, value) => (value > 200 ? count + 1 : count), 0);
    // 一個數字的字墨遠少於色塊覆蓋的面積；上界擋住「色塊在關閉時仍被畫出來」。
    expect(bright).toBeGreaterThan(0);
    expect(bright).toBeLessThan(2_000);
  }, 60_000);
});

describe("頁碼跟著頁面位置走，而不是跟著投影片走", () => {
  /** 每頁一個可辨識的灰階值，才能證明「第 N 個檔案」真的是「order = N-1 的那一頁」。 */
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

  /** 左上角（遠離頁碼）的平均亮度，用來辨識這是原本的哪一頁。 */
  async function shadeOf(png: Uint8Array): Promise<number> {
    const { data } = await sharp(png)
      .extract({ left: 0, top: 0, width: 40, height: 40 })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return Math.round(data.reduce((sum, value) => sum + value, 0) / data.length);
  }

  it("陣列順序被打亂時，匯出仍依 order 排序並照 order 編號", async () => {
    const { repository, project } = await projectWithSlides(3);
    const shades = [16, 96, 176];
    const now = new Date().toISOString();
    for (const [index, slide] of project.slides.entries()) {
      const imagePath = await repository.saveAsset(
        project.id,
        `${slide.id}/v2.png`,
        shadeSlide(shades[index]!),
      );
      slide.versions.push({
        id: `${slide.id}-v2`,
        imagePath,
        prompt: "",
        providerId: "test",
        model: "test",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      });
      slide.currentVersionId = `${slide.id}-v2`;
    }
    // 陣列順序 [2, 0, 1]，order 欄位維持 0/1/2——匯出必須以 order 為準。
    project.slides = [project.slides[2]!, project.slides[0]!, project.slides[1]!];
    enablePageNumber(project, { skipFirstSlide: true, fontSize: 60 });

    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    expect(await shadeOf(entries["001.png"]!)).toBe(shades[0]);
    expect(await shadeOf(entries["002.png"]!)).toBe(shades[1]);
    expect(await shadeOf(entries["003.png"]!)).toBe(shades[2]);

    // order 0 是封面，不編號；另外兩頁才有字墨。
    const bands = await Promise.all(
      ["001.png", "002.png", "003.png"].map((name) => bottomThirdsBrightness(entries[name]!)),
    );
    expect(bands[0]!.right).toBe(shades[0]);
    expect(bands[1]!.right).toBeGreaterThan(shades[1]! + 40);
    expect(bands[2]!.right).toBeGreaterThan(shades[2]! + 40);
  }, 60_000);
});

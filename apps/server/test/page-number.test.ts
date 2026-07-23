import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { exportPresentation } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

/** 全黑整版圖：頁碼是唯一會讓像素變亮的東西，合成與否一眼可辨。 */
function blackSlide(): Uint8Array {
  return new Uint8Array(
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="#000000"/></svg>`,
    )
      .render()
      .asPng(),
  );
}

async function projectWithSlides(slideCount: number) {
  const repository = new FileProjectRepository(
    await mkdtemp(join(tmpdir(), "slide-maker-page-number-")),
  );
  await repository.initialize();
  const project = createProject({ topic: "頁碼匯出", brief: { desiredSlideCount: slideCount } });
  const image = blackSlide();
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

/** 右下角區塊裡最亮的像素值（0–255）。 */
async function bottomRightBrightness(png: Uint8Array): Promise<number> {
  const { data } = await sharp(png)
    .extract({ left: 1400, top: 940, width: 500, height: 120 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data.reduce((max, value) => Math.max(max, value), 0);
}

describe("匯出時合成頁碼", () => {
  it("PNG zip 逐頁疊上頁碼，且封面依設定不編號", async () => {
    const { repository, project } = await projectWithSlides(3);
    project.pageNumber = {
      ...project.pageNumber,
      enabled: true,
      skipFirstSlide: true,
      color: "#ffffff",
      opacity: 1,
    };
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));

    expect(await bottomRightBrightness(entries["001.png"]!)).toBe(0);
    expect(await bottomRightBrightness(entries["002.png"]!)).toBeGreaterThan(100);
    expect(await bottomRightBrightness(entries["003.png"]!)).toBeGreaterThan(100);
  }, 60_000);

  it("關閉時匯出結果與加入頁碼前一致（原圖原封不動）", async () => {
    const { repository, project } = await projectWithSlides(2);
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    expect(Buffer.from(entries["002.png"]!).equals(Buffer.from(blackSlide()))).toBe(true);
  }, 60_000);

  it("色塊讓頁碼在複雜背景上仍可讀，範圍比純文字寬", async () => {
    const { repository, project } = await projectWithSlides(2);
    project.pageNumber = {
      ...project.pageNumber,
      enabled: true,
      color: "#ffffff",
      opacity: 1,
      background: { enabled: true, color: "#ffffff", opacity: 1 },
    };
    const entries = unzipSync(await exportPresentation(repository, project, "png.zip"));
    // 白色色塊覆蓋的面積遠大於一個數字的字墨，用「亮像素個數」區分兩者。
    const { data } = await sharp(entries["002.png"]!)
      .extract({ left: 1400, top: 940, width: 500, height: 120 })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bright = data.reduce((count, value) => (value > 200 ? count + 1 : count), 0);
    expect(bright).toBeGreaterThan(2_000);
  }, 60_000);

  it("PDF 也走同一條合成路徑", async () => {
    const { repository, project } = await projectWithSlides(2);
    project.pageNumber = { ...project.pageNumber, enabled: true, format: "zh-page" };
    // PDF 內嵌的是有損 JPEG，無法逐像素比對；改確認整份體積因為多了頁碼而變大。
    const withNumber = await exportPresentation(repository, project, "pdf");
    project.pageNumber = { ...project.pageNumber, enabled: false };
    const without = await exportPresentation(repository, project, "pdf");
    expect(withNumber.length).toBeGreaterThan(without.length);
  }, 60_000);

  it("PPTX 以文字物件輸出頁碼，色塊是同一個圓角框的填色", async () => {
    const { repository, project } = await projectWithSlides(3);
    project.pageNumber = {
      ...project.pageNumber,
      enabled: true,
      format: "number-total",
      background: { enabled: true, color: "#123456", opacity: 1 },
    };
    const entries = unzipSync(await exportPresentation(repository, project, "pptx"));
    const cover = Buffer.from(entries["ppt/slides/slide1.xml"]!).toString("utf8");
    const second = Buffer.from(entries["ppt/slides/slide2.xml"]!).toString("utf8");
    // 三頁、跳封面 → 最後一頁顯示 2，所以 total 是 2 而不是 3。
    expect(second).toContain("1 / 2");
    expect(second).toContain("roundRect");
    expect(second).toContain("123456");
    expect(cover).not.toContain(" / ");
  }, 60_000);
});

describe("頁碼設定端點", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let projectId = "";

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-page-number-api-")),
      ".slide-maker-data",
    );
    const app = await createApp(root);
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        bindUnavailable = true;
        return;
      }
      throw error;
    }
    if (!server) throw new Error("Local test server did not initialize");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "頁碼設定" }),
    });
    projectId = ((await created.json()) as PresentationProject).id;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const patch = async (body: unknown) =>
    fetch(`${baseUrl}/api/projects/${projectId}/page-number`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("部分更新只動送出的欄位，巢狀背景設定不會被預設值洗掉", async () => {
    if (bindUnavailable) return;
    const first = (await (
      await patch({ enabled: true, position: "bottom-left", background: { color: "#123456" } })
    ).json()) as PresentationProject;
    expect(first.pageNumber.enabled).toBe(true);
    expect(first.pageNumber.position).toBe("bottom-left");
    expect(first.pageNumber.background.color).toBe("#123456");

    // 只送 background.enabled：上一次設好的顏色必須留著，而不是回到預設的 #000000。
    const second = (await (
      await patch({ background: { enabled: true } })
    ).json()) as PresentationProject;
    expect(second.pageNumber.background).toEqual({
      enabled: true,
      color: "#123456",
      opacity: first.pageNumber.background.opacity,
    });
    expect(second.pageNumber.position).toBe("bottom-left");
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
  }, 60_000);

  it("拒絕越界數值", async () => {
    if (bindUnavailable) return;
    expect((await patch({ startAt: 0 })).ok).toBe(false);
    expect((await patch({ fontSize: 500 })).ok).toBe(false);
    expect((await patch({ color: "red" })).ok).toBe(false);
    expect((await patch({ position: "top-left" })).ok).toBe(false);
  }, 60_000);

  it("設定寫入後隨專案一起持久化", async () => {
    if (bindUnavailable) return;
    await patch({ format: "zh-page", fontSize: 44 });
    const reloaded = (await (
      await fetch(`${baseUrl}/api/projects/${projectId}`)
    ).json()) as PresentationProject;
    expect(reloaded.pageNumber.format).toBe("zh-page");
    expect(reloaded.pageNumber.fontSize).toBe(44);
  }, 60_000);
});

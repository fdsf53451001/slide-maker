import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type express from "express";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import {
  exportPresentation,
  exportSlideFilename,
  exportSlidePng,
  withPageNumber,
} from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

function solidSlide(color: string, width = 1920, height = 1080): Uint8Array {
  return new Uint8Array(
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`,
    )
      .render()
      .asPng(),
  );
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string } | null> {
  let server: Server | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return null;
    throw error;
  }
  if (!server) throw new Error("Local test server did not initialize");
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("單頁 PNG 匯出", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  let repository: FileProjectRepository;
  let project: PresentationProject;
  /** 沒有目前版本的頁面（第 4 頁）。 */
  let imagelessId = "";

  beforeAll(async () => {
    const root = join(await mkdtemp(join(tmpdir(), "slide-maker-slide-png-")), "data");
    repository = new FileProjectRepository(root);
    await repository.initialize();
    project = createProject({ topic: "單頁匯出", brief: { desiredSlideCount: 4 } });
    // 第 3 頁隱藏、第 4 頁沒有圖：兩條分歧路徑各佔一頁。
    project.slides[2]!.hidden = true;
    project.pageNumber = { ...project.pageNumber, enabled: true, color: "#ffffff", opacity: 1 };
    const colors = ["#102030", "#204060", "#306090", "#40a0c0"];
    const now = new Date().toISOString();
    for (const slide of project.slides) {
      if (slide.order === 3) {
        imagelessId = slide.id;
        continue;
      }
      const imagePath = await repository.saveAsset(
        project.id,
        `${slide.id}/v1.png`,
        solidSlide(colors[slide.order]!),
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
    await repository.saveProject(project);
    const started = await listen(await createApp(root, undefined, {}));
    if (!started) {
      unavailable = true;
      return;
    }
    ({ server, baseUrl } = started);
  }, 60_000);

  afterAll(() => close(server));

  const slidePngUrl = (slideId: string) =>
    `${baseUrl}/api/projects/${project.id}/slides/${slideId}/export/png`;

  it("位元組與 png.zip 裡同一頁的 entry 完全相同（頁碼與編碼只有一份實作）", async () => {
    // 使用者拿一頁與拿整包，得到的不該是兩張不一樣的圖。這條斷言就是「單頁沒有自己
    // 另寫一套頁碼幾何或編碼參數」的守門。
    //
    // png.zip 得拿掉第 4 頁才組得出來：那是**可見**的缺圖頁，四種格式都該一起擋（既有
    // 規則，不是這條路的事）。頁碼是「可見頁中的第幾頁 / 共幾頁」，所以拿掉它會改變
    // 其他頁的頁碼——比對用的 project 因此兩邊都得是同一份。
    const printable: PresentationProject = {
      ...project,
      slides: project.slides.filter((slide) => slide.currentVersionId),
    };
    const zip = unzipSync(await exportPresentation(repository, printable, "png.zip"));
    for (const slide of printable.slides) {
      const single = await exportSlidePng(repository, printable, slide.id);
      expect(digest(single), `第 ${slide.order + 1} 頁`).toBe(
        digest(zip[`${String(slide.order + 1).padStart(3, "0")}.png`]!),
      );
    }
    // 隱藏頁（第 3 頁）在 png.zip 裡照樣有一個 entry，單頁下載也照樣給。
    expect(Object.keys(zip).sort()).toEqual(["001.png", "002.png", "003.png"]);
  });

  it("端點回 PNG、走 chunked、檔名帶三位頁序", async (context) => {
    if (unavailable) return context.skip();
    const slide = project.slides[1]!;
    const response = await fetch(slidePngUrl(slide.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    // Cloud Run 對 non-streamed 回應有 32 MiB 上限；這兩條 header 是「沒有回頭用
    // response.send()」的守門。
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBe("chunked");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment;");
    expect(decodeURIComponent(disposition)).toContain(exportSlideFilename(project, slide.order));
    expect(exportSlideFilename(project, slide.order)).toMatch(/-002\.png$/);

    const received = new Uint8Array(await response.arrayBuffer());
    expect(digest(received)).toBe(digest(await exportSlidePng(repository, project, slide.id)));
  });

  it("隱藏頁照樣下載得到，且因為不編號而原圖位元組保真", async (context) => {
    if (unavailable) return context.skip();
    const hidden = project.slides[2]!;
    expect(hidden.hidden).toBe(true);
    const response = await fetch(slidePngUrl(hidden.id));
    expect(response.status).toBe(200);
    const received = new Uint8Array(await response.arrayBuffer());
    // 隱藏頁不編頁碼 → `withPageNumber` 原樣回傳，一次 sharp 都不走。
    const source = await exportSlidePng(repository, project, hidden.id);
    expect(digest(received)).toBe(digest(source));
    expect(digest(await withPageNumber(project, hidden.order, source))).toBe(digest(source));
  });

  it("檔名序號用的是實際頁序，不扣掉前面的隱藏頁", async () => {
    // 扣掉隱藏頁是**頁碼**（chrome）的規則；檔名要對得上的是專案裡的第幾頁，
    // 否則單獨補抓的那一頁在檔案總管裡會與 png.zip 解出來的檔案對不起來。
    expect(exportSlideFilename(project, project.slides[3]!.order)).toMatch(/-004\.png$/);
  });

  it("沒有目前版本的頁面回 400 EXPORT_SLIDE_IMAGE_MISSING＋繁中說明", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(slidePngUrl(imagelessId));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message?: string };
    expect(body.error).toBe("EXPORT_SLIDE_IMAGE_MISSING");
    // 下載是裸 `<a href>`：沒有 message 的話瀏覽器分頁裡只會出現一個錯誤碼。
    expect(body.message).toContain("還沒有圖片");
  });

  it("不存在的頁面 id 回 400 EXPORT_SLIDE_NOT_FOUND＋繁中說明", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(slidePngUrl("no-such-slide"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message?: string };
    expect(body.error).toBe("EXPORT_SLIDE_NOT_FOUND");
    expect(body.message).toContain("找不到這一頁");
  });
});

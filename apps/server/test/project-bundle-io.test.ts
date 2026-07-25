import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type express from "express";
import { strToU8, unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import type { ExportFormat } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

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

/**
 * `Content-Disposition: attachment; filename*=UTF-8''…` 的檔名部分。
 * 伺服器一律用 RFC 5987 的 `filename*`（名稱含中文），所以這裡只解這一種。
 */
function attachmentFilename(header: string | null): string {
  const match = /filename\*=UTF-8''(.+)$/.exec(header ?? "");
  if (!match?.[1]) throw new Error(`無法從 Content-Disposition 取出檔名：${String(header)}`);
  return decodeURIComponent(match[1]);
}

describe("專案封存的下載檔名與匯入（HTTP 層）", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  let repository: FileProjectRepository;
  let project: PresentationProject;

  beforeAll(async () => {
    const root = join(await mkdtemp(join(tmpdir(), "slide-maker-bundle-io-")), "data");
    repository = new FileProjectRepository(root);
    await repository.initialize();
    // 名稱刻意含中文與空白：`exportFilename()` 會把空白換成 `-`，中文保留，
    // 而 header 走 RFC 5987 百分比編碼——三段合起來才是使用者真正看到的檔名。
    project = createProject({
      topic: "季度 回顧",
      name: "季度 回顧",
      brief: { desiredSlideCount: 1 },
    });
    const flat = new Uint8Array(
      await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#123456" } })
        .png()
        .toBuffer(),
    );
    const now = new Date().toISOString();
    const slide = project.slides[0]!;
    const imagePath = await repository.saveAsset(project.id, `${slide.id}/v1.png`, flat);
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
    await repository.saveProject(project);

    const started = await listen(await createApp(root, undefined, {}));
    if (!started) {
      unavailable = true;
      return;
    }
    ({ server, baseUrl } = started);
  }, 60_000);

  afterAll(async () => {
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
  });

  /**
   * 端對端釘住的是使用者實際存到磁碟上的檔名，不是 `exportFilename()` 的回傳值：
   * 檔名要經過 header 組裝與百分比編碼才會到瀏覽器手上，單元測試看不到那一段。
   * `.slide-project` 沒有關聯程式、點兩下打不開，所以封存必須以 `.zip` 結尾。
   */
  it("slide-project 的 Content-Disposition 檔名以 .slide-project.zip 結尾", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/slide-project`);
    expect(response.status).toBe(200);
    const header = response.headers.get("content-disposition");
    expect(header).toContain("attachment;");
    expect(attachmentFilename(header)).toBe("季度-回顧.slide-project.zip");
    // 內容確實是 zip（PK 魔數），檔名與內容一致。
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 2)).toString()).toBe("PK");
    // 副檔名只影響檔名，URL 的 path segment 仍是 `slide-project`（上面就是這樣打的）。
    expect(header).not.toContain(".slide-project.zip.zip");
  });

  it("其他三種格式的檔名維持原副檔名", async (context) => {
    if (unavailable) return context.skip();
    const expected: Record<Exclude<ExportFormat, "slide-project">, string> = {
      pptx: "季度-回顧.pptx",
      pdf: "季度-回顧.pdf",
      "png.zip": "季度-回顧.png.zip",
    };
    for (const [format, filename] of Object.entries(expected)) {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/${format}`);
      expect(response.status, format).toBe(200);
      expect(attachmentFilename(response.headers.get("content-disposition")), format).toBe(
        filename,
      );
    }
  }, 60_000);

  /**
   * 編輯器的隱藏 file input 寫 `accept=".zip"`（瀏覽器只認最後一段副檔名）。
   * 匯出檔名若不以 `.zip` 結尾，使用者在檔案選取視窗裡根本挑不到自己剛下載的備份。
   */
  it("匯出的檔名符合編輯器 file input 的 accept=.zip", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/slide-project`);
    expect(attachmentFilename(response.headers.get("content-disposition")).endsWith(".zip")).toBe(
      true,
    );
  });

  it("下載回來的封存可以原樣匯入成新專案", async (context) => {
    if (unavailable) return context.skip();
    const bundle = await fetch(`${baseUrl}/api/projects/${project.id}/export/slide-project`).then(
      (response) => response.arrayBuffer(),
    );
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: bundle,
    });
    expect(response.status).toBe(201);
    const imported = (await response.json()) as PresentationProject;
    expect(imported.id).not.toBe(project.id);
    expect(imported.name).toBe(`${project.name}（匯入）`);
    expect(imported.slides).toHaveLength(project.slides.length);
    // 素材真的跟著搬過去：新專案的第一頁圖片抓得到。
    const asset = await fetch(
      `${baseUrl}/api/projects/${imported.id}/${imported.slides[0]!.versions[0]!.imagePath}`,
    );
    expect(asset.status).toBe(200);
  }, 60_000);

  /** 使用者挑錯檔案（隨便一個 .zip 或根本不是 zip）是常見操作，不是伺服器故障。 */
  it("非 zip 位元組回 400 PROJECT_BUNDLE_INVALID，不是 500", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "PROJECT_BUNDLE_INVALID",
    });
  });

  /** 合法的 zip 但不是專案封存（例如使用者拿 `png.zip` 來匯入）。 */
  it("缺少 project.json 的 zip 回 400 PROJECT_BUNDLE_INVALID", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zipSync({ "001.png": strToU8("not really a png") }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "PROJECT_BUNDLE_INVALID",
    });
  });

  /** zip slip：`assets/../../escape` 這種項目不能被寫到專案目錄外。 */
  it("路徑穿越的封存回 400 PROJECT_BUNDLE_UNSAFE_PATH", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zipSync({
        "project.json": strToU8(JSON.stringify(project)),
        "assets/../../escape.png": strToU8("x"),
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "PROJECT_BUNDLE_UNSAFE_PATH",
    });
  });

  /** 空 body（沒挑到檔案／上傳被截斷）同樣是壞輸入。 */
  it("空 body 回 400 而不是 500", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: new Uint8Array(),
    });
    expect(response.status).toBe(400);
  });

  /**
   * `project.json` 通過 zip 解壓但 schema 不合（舊版備份、手動改壞）：
   * 這是使用者的檔案問題，回 4xx 才分得出「壞輸入」與「伺服器壞了」。而且要收斂成
   * PROJECT_BUNDLE_INVALID，不能把 zod 的 issues 攤出去——前端會把欄位路徑整串貼進 toast。
   */
  it("schema 不合的 project.json 回 400 PROJECT_BUNDLE_INVALID 而不是 zod 欄位清單", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zipSync({ "project.json": strToU8(JSON.stringify({ id: "x" })) }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe("PROJECT_BUNDLE_INVALID");
    expect(body.issues).toBeUndefined();
  });

  /**
   * zip 沒壞但 `project.json` 壞掉：`JSON.parse` 的 SyntaxError 與 `parseProject` 的
   * TypeError／ZodError 都必須在 `parseProjectBundle()` 內收斂成 PROJECT_BUNDLE_INVALID。
   * 少了那道 try/catch 會冒出去落到 500 INTERNAL_SERVER_ERROR，把「使用者挑到壞檔案」
   * 記成伺服器故障——log 裡就分不出這兩件事。儀表板的「匯入專案檔」讓這條路徑一鍵可達。
   */
  it("project.json 不是合法 JSON 時回 400 並附上可讀訊息", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zipSync({ "project.json": strToU8("{not json") }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message?: string };
    expect(body.error).toBe("PROJECT_BUNDLE_INVALID");
    // 前端只會把 message 顯示出來；沒有它，toast 就是裸的錯誤碼。
    expect(body.message).toMatch(/專案封存/);
  });

  /** 同一條路徑的另一半：合法 JSON 但不是物件，炸在 `parseProject` 而不是 `JSON.parse`。 */
  it("project.json 是 null 時回 400 PROJECT_BUNDLE_INVALID", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zipSync({ "project.json": strToU8("null") }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("PROJECT_BUNDLE_INVALID");
  });

  /** 匯出→匯入→再匯出：新專案的封存自己也是一份合法的封存（不會單向退化）。 */
  it("匯入後的專案可以再匯出成合法封存", async (context) => {
    if (unavailable) return context.skip();
    const bundle = await fetch(`${baseUrl}/api/projects/${project.id}/export/slide-project`).then(
      (response) => response.arrayBuffer(),
    );
    const imported = (await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: bundle,
    }).then((response) => response.json())) as PresentationProject;
    const again = await fetch(`${baseUrl}/api/projects/${imported.id}/export/slide-project`);
    expect(again.status).toBe(200);
    // 名稱多了「（匯入）」，檔名也跟著變（全形括號不在允許字元集裡，會被收斂成 `-`
    // 並修掉尾端），但副檔名不變——這才是這條測試要守的東西。
    expect(attachmentFilename(again.headers.get("content-disposition"))).toBe(
      "季度-回顧-匯入.slide-project.zip",
    );
    const entries = Object.keys(unzipSync(new Uint8Array(await again.arrayBuffer())));
    expect(entries).toContain("project.json");
  }, 60_000);
});

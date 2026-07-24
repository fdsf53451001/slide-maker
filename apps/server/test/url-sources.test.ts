import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PresentationProject, SourceAsset } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import type { WebSearchResult } from "../src/web-capture.js";

/**
 * 「貼上網址」通道（POST /api/projects/:id/url-sources）。
 *
 * 擷取本身由 `dependencies.captureWebPage` 假造：這一組要驗的是端點的守門與落地行為
 * （必須抓到正文、同 URL 更新而非新增、逐筆失敗回報、全部失敗回 4xx、私有位址被擋、
 * 專案上限），而不是 HTTP 抓取。真的打外網的測試在 CI 只會變成不穩定的紅燈。
 */
describe("貼上網址加入來源", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  /** 每個網址下一次要回傳的正文；沒登記的網址視為抓不到。 */
  const bodyByUrl = new Map<string, string>();
  const captureCalls: string[] = [];

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const createProject = async (): Promise<PresentationProject> => {
    const response = await post("/api/projects", {
      topic: "貼上網址測試",
      brief: { desiredSlideCount: 1 },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as PresentationProject;
  };

  const addUrls = async (projectId: string, urls: string[]) => {
    const response = await post(`/api/projects/${projectId}/url-sources`, { urls });
    return {
      status: response.status,
      body: (await response.json()) as {
        project?: PresentationProject;
        failures?: { url: string; reason: string }[];
        error?: string;
      },
    };
  };

  beforeAll(async () => {
    const root = join(await mkdtemp(join(tmpdir(), "slide-maker-url-src-")), ".slide-maker-data");
    const app = await createApp(root, undefined, {
      captureWebPage: async (
        found: WebSearchResult,
        capturedAt = new Date().toISOString(),
      ): Promise<{ text: string; metadata: Record<string, string> }> => {
        captureCalls.push(found.url);
        const body = bodyByUrl.get(found.url);
        const title = found.title || `自動標題 ${new URL(found.url).pathname}`;
        return body
          ? {
              text: `# ${title}\n\nURL: ${found.url}\n\n## 全文\n\n${body}\n`,
              metadata: {
                url: found.url,
                title,
                summary: found.summary,
                capturedAt,
                contentStatus: "full",
              },
            }
          : {
              text: `# ${title}\n\nURL: ${found.url}\n\n## 未驗證搜尋摘要\n\n${found.summary}\n`,
              metadata: {
                url: found.url,
                title,
                summary: found.summary,
                capturedAt,
                contentStatus: "summary_only",
              },
            };
      },
    });
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
  });

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    bodyByUrl.clear();
    captureCalls.length = 0;
  });

  it("抓得到正文就落地成來源，並用網頁自己的標題命名", async () => {
    if (bindUnavailable) return;
    bodyByUrl.set("https://example.com/report", "第一份報告的正文內容。");
    bodyByUrl.set("https://example.com/note", "第二份筆記的正文內容。");
    const project = await createProject();
    const { status, body } = await addUrls(project.id, [
      "https://example.com/report",
      "https://example.com/note",
    ]);
    expect(status).toBe(201);
    expect(body.failures).toEqual([]);
    const sources = body.project!.sources;
    expect(sources).toHaveLength(2);
    expect(sources.map((source: SourceAsset) => source.metadata.url)).toEqual([
      "https://example.com/report",
      "https://example.com/note",
    ]);
    expect(sources[0]!.name).toBe("自動標題 _report.md");
    expect(sources[0]!.mediaType).toBe("text/markdown");
    expect(sources[0]!.extractedText).toContain("第一份報告的正文內容。");
    expect(sources[0]!.chunks.length).toBeGreaterThan(0);
    // 索引跟著建立，來源搜尋馬上找得到。
    const search = await fetch(`${baseUrl}/api/projects/${project.id}/search?q=第一份報告`);
    expect(((await search.json()) as unknown[]).length).toBeGreaterThan(0);
  });

  it("同一個網址再貼一次是更新既有來源，不會多出一筆", async () => {
    if (bindUnavailable) return;
    bodyByUrl.set("https://example.com/live", "第一次抓到的內容。");
    const project = await createProject();
    const first = await addUrls(project.id, ["https://example.com/live"]);
    expect(first.body.project!.sources).toHaveLength(1);
    const sourceId = first.body.project!.sources[0]!.id;

    bodyByUrl.set("https://example.com/live", "更新後的內容。");
    const second = await addUrls(project.id, ["https://example.com/live"]);
    expect(second.status).toBe(201);
    const sources = second.body.project!.sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe(sourceId);
    // 手動貼上代表「現在去抓這一頁」，不能回一份舊快取。
    expect(sources[0]!.extractedText).toContain("更新後的內容。");
    expect(sources[0]!.extractedText).not.toContain("第一次抓到的內容。");
    // 兩次都真的去抓了：既有來源是 full 就跳過重抓的捷徑（搜尋路徑的行為）在這裡要關掉。
    expect(captureCalls).toEqual(["https://example.com/live", "https://example.com/live"]);
  });

  it("同一次請求裡重複的網址只抓一次", async () => {
    if (bindUnavailable) return;
    bodyByUrl.set("https://example.com/dup", "重複網址的正文。");
    const project = await createProject();
    const { body } = await addUrls(project.id, [
      "https://example.com/dup",
      "https://example.com/dup",
    ]);
    expect(body.project!.sources).toHaveLength(1);
    expect(captureCalls).toEqual(["https://example.com/dup"]);
  });

  it("部分失敗：成功的照樣入庫，失敗的逐筆回報原因", async () => {
    if (bindUnavailable) return;
    bodyByUrl.set("https://example.com/good", "抓得到的正文。");
    const project = await createProject();
    const { status, body } = await addUrls(project.id, [
      "https://example.com/good",
      "https://example.com/spa-shell",
    ]);
    expect(status).toBe(201);
    expect(body.project!.sources).toHaveLength(1);
    expect(body.failures).toEqual([
      { url: "https://example.com/spa-shell", reason: "WEB_SOURCE_CONTENT_UNVERIFIED" },
    ]);
  });

  it("全部失敗回 4xx 並帶失敗原因：不能讓前端以為加進去了", async () => {
    if (bindUnavailable) return;
    const project = await createProject();
    const { status, body } = await addUrls(project.id, ["https://example.com/spa-shell"]);
    expect(status).toBe(400);
    expect(body.error).toBe("URL_SOURCES_UNVERIFIED");
    expect(body.failures).toEqual([
      { url: "https://example.com/spa-shell", reason: "WEB_SOURCE_CONTENT_UNVERIFIED" },
    ]);
    const after = await fetch(`${baseUrl}/api/projects/${project.id}/sources`);
    expect(await after.json()).toEqual([]);
  });

  it("摘要不得充當正文：抓不到內容的網址絕不留下一筆空來源", async () => {
    if (bindUnavailable) return;
    const project = await createProject();
    await addUrls(project.id, ["https://example.com/summary-only"]);
    const sources = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}/sources`)
    ).json()) as SourceAsset[];
    expect(sources).toEqual([]);
  });

  it("私有位址與非 http(s) 網址在抓取之前就被擋下", async () => {
    if (bindUnavailable) return;
    const project = await createProject();
    const { status, body } = await addUrls(project.id, [
      "http://127.0.0.1/admin",
      "http://[::ffff:169.254.169.254]/latest",
      "file:///etc/passwd",
      "不是網址",
    ]);
    expect(status).toBe(400);
    expect(body.failures).toEqual([
      { url: "http://127.0.0.1/admin", reason: "WEB_SOURCE_URL_PRIVATE" },
      { url: "http://[::ffff:169.254.169.254]/latest", reason: "WEB_SOURCE_URL_PRIVATE" },
      { url: "file:///etc/passwd", reason: "WEB_SOURCE_URL_UNSUPPORTED" },
      { url: "不是網址", reason: "WEB_SOURCE_URL_INVALID" },
    ]);
    expect(captureCalls).toEqual([]);
  });

  it("網址數量超出 1..10 由 schema 擋下", async () => {
    if (bindUnavailable) return;
    const project = await createProject();
    expect((await addUrls(project.id, [])).status).toBe(400);
    const tooMany = await addUrls(
      project.id,
      Array.from({ length: 11 }, (_value, index) => `https://example.com/${index}`),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toBe("INVALID_REQUEST");
    expect(captureCalls).toEqual([]);
  });

  it("專案來源數量上限照樣適用", async () => {
    if (bindUnavailable) return;
    const project = await createProject();
    // 上限 100 份；先塞滿再貼網址。
    for (let index = 0; index < 100; index += 1) {
      const query = new URLSearchParams({
        name: `filler-${index}.txt`,
        mediaType: "text/plain",
        allowModelAccess: "true",
      });
      const response = await fetch(
        `${baseUrl}/api/projects/${project.id}/sources?${query.toString()}`,
        { method: "POST", headers: { "content-type": "text/plain" }, body: `填充來源 ${index}` },
      );
      expect(response.status).toBe(201);
    }
    bodyByUrl.set("https://example.com/overflow", "正文抓得到，但專案已經滿了。");
    const response = await post(`/api/projects/${project.id}/url-sources`, {
      urls: ["https://example.com/overflow"],
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toEqual({ error: "SOURCE_PROJECT_LIMIT" });
    const sources = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}/sources`)
    ).json()) as SourceAsset[];
    expect(sources).toHaveLength(100);
  });
});

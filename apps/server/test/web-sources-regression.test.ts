import { mkdtemp, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SOURCE_COUNT_LIMIT, type PresentationProject, type SourceAsset } from "@slide-maker/core";
import { createApp, type AppDependencies } from "../src/app.js";
import type { WebSearchResult } from "../src/web-capture.js";

/**
 * 既有「網路搜尋 → 確認後存成來源」路徑（POST /api/projects/:id/web-sources）的迴歸保護。
 *
 * 這條路的落地邏輯（`materializeWebSources`）在「貼上網址」這次改動中被加了三個參數
 * （`renderer`／`refresh`／`unverifiedUrls`）。使用者的要求是搜尋流程行為**完全不變**，
 * 而原本這個端點只有一個 happy path 測試——不變或改變都看不出來。這一組把不變量釘住：
 * 去重、快取捷徑、部分失敗、全部失敗的錯誤碼與狀態、檔名、metadata、索引。
 */

const bodyByUrl = new Map<string, string>();
const canonicalByUrl = new Map<string, string>();
const captureCalls: { url: string; renderer: string | undefined }[] = [];

const fakeCapture: AppDependencies["captureWebPage"] = async (
  found: WebSearchResult,
  capturedAt = new Date().toISOString(),
  _fetcher?: typeof fetch,
  options?: { renderer?: { name: string } | undefined },
) => {
  captureCalls.push({ url: found.url, renderer: options?.renderer?.name });
  const url = canonicalByUrl.get(found.url) ?? found.url;
  const body = bodyByUrl.get(found.url);
  return body
    ? {
        text: `# ${found.title}\n\nURL: ${url}\n\nCaptured: ${capturedAt}\n\n## 全文\n\n${body}\n`,
        metadata: {
          url,
          title: found.title,
          summary: found.summary,
          capturedAt,
          contentStatus: "full",
        },
      }
    : {
        text: `# ${found.title}\n\nURL: ${url}\n\nCaptured: ${capturedAt}\n\n## 未驗證搜尋摘要\n\n${found.summary}\n`,
        metadata: {
          url,
          title: found.title,
          summary: found.summary,
          capturedAt,
          contentStatus: "summary_only",
        },
      };
};

describe("搜尋來源落地（既有路徑不得改變）", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const createProject = async (): Promise<PresentationProject> =>
    (await (
      await post("/api/projects", { topic: "搜尋來源迴歸", brief: { desiredSlideCount: 1 } })
    ).json()) as PresentationProject;

  const saveSources = async (projectId: string, sources: WebSearchResult[]) => {
    const response = await post(`/api/projects/${projectId}/web-sources`, { sources });
    return {
      status: response.status,
      body: (await response.json()) as PresentationProject & { error?: string },
    };
  };

  beforeAll(async () => {
    dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-websrc-")), ".slide-maker-data");
    const app = await createApp(dataRoot, undefined, { captureWebPage: fakeCapture });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  beforeEach(() => {
    bodyByUrl.clear();
    canonicalByUrl.clear();
    captureCalls.length = 0;
  });

  it("擷取時不帶 renderer：搜尋結果的網址不會被送去第三方 render 服務", async () => {
    bodyByUrl.set("https://example.com/a", "搜尋來源的正文。");
    const project = await createProject();
    const { status } = await saveSources(project.id, [
      { url: "https://example.com/a", title: "A", summary: "摘要 A" },
    ]);
    expect(status).toBe(201);
    expect(captureCalls).toEqual([{ url: "https://example.com/a", renderer: undefined }]);
  });

  it("同一批裡重複的網址只會產生一份來源", async () => {
    bodyByUrl.set("https://example.com/dup", "重複網址的正文。");
    const project = await createProject();
    const { body } = await saveSources(project.id, [
      { url: "https://example.com/dup", title: "D", summary: "摘要" },
      { url: "https://example.com/dup", title: "D", summary: "摘要" },
    ]);
    expect(body.sources).toHaveLength(1);
    // 第二筆命中同一批內剛建立的來源，不會再抓一次。
    expect(captureCalls).toHaveLength(1);
  });

  it("已存在且是 full 的來源不會重抓（搜尋路徑的快取捷徑必須留著）", async () => {
    bodyByUrl.set("https://example.com/cached", "第一次抓到的正文。");
    const project = await createProject();
    const first = await saveSources(project.id, [
      { url: "https://example.com/cached", title: "C", summary: "摘要" },
    ]);
    const before = first.body.sources[0]!;

    captureCalls.length = 0;
    bodyByUrl.set("https://example.com/cached", "如果重抓就會看到這一段。");
    const second = await saveSources(project.id, [
      { url: "https://example.com/cached", title: "C", summary: "摘要" },
    ]);
    expect(second.status).toBe(201);
    expect(captureCalls).toEqual([]);
    expect(second.body.sources).toHaveLength(1);
    expect(second.body.sources[0]!.id).toBe(before.id);
    expect(second.body.sources[0]!.extractedText).toContain("第一次抓到的正文。");
  });

  it("部分抓不到：抓得到的照樣入庫，抓不到的整筆略過（不留摘要來源）", async () => {
    bodyByUrl.set("https://example.com/good", "抓得到的正文。");
    const project = await createProject();
    const { status, body } = await saveSources(project.id, [
      { url: "https://example.com/good", title: "G", summary: "摘要 G" },
      { url: "https://example.com/bad", title: "B", summary: "摘要 B" },
    ]);
    expect(status).toBe(201);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]!.metadata.url).toBe("https://example.com/good");
    // 這個端點沒有逐筆失敗回報，行為與改動前一致（`unverifiedUrls` 只有貼上網址在用）。
    expect((body as unknown as { failures?: unknown }).failures).toBeUndefined();
  });

  it("全部抓不到時回 502 WEB_SEARCH_SOURCES_UNVERIFIED，且專案零來源", async () => {
    const project = await createProject();
    const response = await post(`/api/projects/${project.id}/web-sources`, {
      sources: [{ url: "https://example.com/none", title: "N", summary: "摘要" }],
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "WEB_SEARCH_SOURCES_UNVERIFIED",
      message: "選取的網頁內容皆無法讀取驗證，因此未加入專案。",
    });
    const sources = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}/sources`)
    ).json()) as SourceAsset[];
    expect(sources).toEqual([]);
  });

  it("檔名取自搜尋標題、metadata 逐字沿用擷取結果", async () => {
    bodyByUrl.set("https://example.com/named", "有標題的正文。");
    const project = await createProject();
    const { body } = await saveSources(project.id, [
      { url: "https://example.com/named", title: "搜尋給的標題", summary: "搜尋摘要" },
    ]);
    const source = body.sources[0]!;
    expect(source.name).toBe("搜尋給的標題.md");
    expect(source.mediaType).toBe("text/markdown");
    expect(source.usage).toBe("content");
    expect(source.allowModelAccess).toBe(true);
    expect(source.metadata.url).toBe("https://example.com/named");
    expect(source.metadata.title).toBe("搜尋給的標題");
    expect(source.metadata.summary).toBe("搜尋摘要");
    expect(source.metadata.contentStatus).toBe("full");
    // renderedBy 只屬於走過第三方 render 的來源，搜尋路徑不該出現。
    expect(source.metadata.renderedBy).toBeUndefined();
  });

  it("落地後立刻可被來源搜尋找到（索引沒有漏建）", async () => {
    bodyByUrl.set("https://example.com/indexed", "獨特關鍵詞 電解質材料 的段落。");
    const project = await createProject();
    await saveSources(project.id, [
      { url: "https://example.com/indexed", title: "I", summary: "摘要" },
    ]);
    const hits = (await (
      await fetch(
        `${baseUrl}/api/projects/${project.id}/search?q=${encodeURIComponent("電解質材料")}`,
      )
    ).json()) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
  });

  it("超過 20 筆由 schema 擋下，一筆都不會去抓", async () => {
    const project = await createProject();
    const response = await post(`/api/projects/${project.id}/web-sources`, {
      sources: Array.from({ length: 21 }, (_value, index) => ({
        url: `https://example.com/${index}`,
        title: `T${index}`,
        summary: "摘要",
      })),
    });
    expect(response.status).toBe(400);
    expect(captureCalls).toEqual([]);
  });

  it("撞上專案來源上限時，已落地但排不進去的來源資產目錄被回收（不留孤兒）", async () => {
    const project = await createProject();
    // 先把專案填到上限（份數上限的常數就是伺服器用的那一份），每一份都要抓得到正文。
    for (let batch = 0; batch < SOURCE_COUNT_LIMIT / 20; batch += 1) {
      const sources = Array.from({ length: 20 }, (_value, index) => {
        const n = batch * 20 + index;
        const url = `https://example.com/limit/${n}`;
        bodyByUrl.set(url, `第 ${n} 份來源的正文。`);
        return { url, title: `T${n}`, summary: `摘要 ${n}` };
      });
      const { status } = await saveSources(project.id, sources);
      expect(status).toBe(201);
    }
    const sourcesDir = join(dataRoot, "projects", project.id, "assets", "sources");
    expect(await readdir(sourcesDir)).toHaveLength(SOURCE_COUNT_LIMIT);

    // 再一份：materialize 會先把它寫到磁碟，交易再撞上上限整筆回滾（409 SOURCE_COUNT_LIMIT）。
    const overflowUrl = "https://example.com/limit/overflow";
    bodyByUrl.set(overflowUrl, "這一份放不進去。");
    const response = await post(`/api/projects/${project.id}/web-sources`, {
      sources: [{ url: overflowUrl, title: "Overflow", summary: "摘要" }],
    });
    expect(response.status).toBe(409);
    // 份數與容量分成兩個碼：撞到哪一條決定使用者的下一步（刪幾份 vs 刪大的那幾份）。
    const failure = (await response.json()) as { error?: string; message?: string };
    expect(failure.error).toBe("SOURCE_COUNT_LIMIT");
    // 訊息要帶實際數字，前端不得自己再寫一份（舊版前端硬編的「100 份」就是這樣過期的）。
    expect(failure.message).toContain(String(SOURCE_COUNT_LIMIT));
    // 那份已落地卻永遠進不了專案的資產目錄必須被回收：目錄數維持 100，沒有第 101 個孤兒
    // （每重試一次多一份的話，這裡會是 101、102…）。
    expect(await readdir(sourcesDir)).toHaveLength(SOURCE_COUNT_LIMIT);
  });

  it("擷取後正規化成既有來源的網址：原地更新，不留孤兒資產", async () => {
    // 這條原本釘的是既有缺陷（`sourceByUrl` 只以擷取**前**的網址為鍵，輸入網址對不上時
    // 會重抓、建新資產，再於交易裡被 metadata.url 去重擋掉——內容丟掉、資產留下）。
    // 修 B1／D2 時這段程式是兩條入口共用的，所以搜尋路徑一起變好：擷取後的網址命中既有
    // 來源就走 refresh，覆寫同一個資產路徑。
    bodyByUrl.set("https://example.com/canon", "正規化後的正文。");
    bodyByUrl.set("https://example.com/canon?ref=x", "同一頁的另一種寫法。");
    canonicalByUrl.set("https://example.com/canon?ref=x", "https://example.com/canon");
    const project = await createProject();
    const first = await saveSources(project.id, [
      { url: "https://example.com/canon", title: "Canon", summary: "摘要" },
    ]);
    const { body } = await saveSources(project.id, [
      { url: "https://example.com/canon?ref=x", title: "Canon 2", summary: "摘要" },
    ]);
    expect(body.sources).toHaveLength(1);
    // 同一份來源（id 與檔名不變），內容換成這一次抓到的。
    expect(body.sources[0]!.id).toBe(first.body.sources[0]!.id);
    expect(body.sources[0]!.name).toBe(first.body.sources[0]!.name);
    expect(body.sources[0]!.extractedText).toContain("同一頁的另一種寫法。");
    const dirs = await readdir(join(dataRoot, "projects", project.id, "assets", "sources"));
    expect(dirs).toHaveLength(body.sources.length);
  });
});

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PresentationProject, SourceAsset } from "@slide-maker/core";
import { createApp, type AppDependencies } from "../src/app.js";
import type { WebSearchResult } from "../src/web-capture.js";

/**
 * 「貼上網址」端點的對抗性測試：正規化碰撞、專案上限、併發、重貼、無效輸入。
 *
 * 擷取一律以 `dependencies.captureWebPage` 假造（絕不連外網）。假擷取刻意保留
 * `metadata.url` 可以與輸入網址**不同**的能力——真實世界的重導向與 canonical 化就是
 * 這樣，而端點的去重正是踩在這個假設上。
 */

/** 假擷取的腳本：輸入網址 → 正文（沒登記＝抓不到）。 */
const bodyByUrl = new Map<string, string>();
/** 假擷取的腳本：輸入網址 → 擷取後的正規化網址（沒登記＝原樣）。 */
const canonicalByUrl = new Map<string, string>();
/** 每次擷取收到的引數（第四個是 renderer——搜尋路徑必須是 undefined）。 */
const captureCalls: { url: string; renderer: string | undefined }[] = [];

const fakeCapture: AppDependencies["captureWebPage"] = async (
  found: WebSearchResult,
  capturedAt = new Date().toISOString(),
  _fetcher?: typeof fetch,
  renderer?: { name: string },
) => {
  captureCalls.push({ url: found.url, renderer: renderer?.name });
  const url = canonicalByUrl.get(found.url) ?? found.url;
  const body = bodyByUrl.get(found.url);
  const title = found.title || `標題${new URL(url).pathname}`;
  return body
    ? {
        text: `# ${title}\n\nURL: ${url}\n\nCaptured: ${capturedAt}\n\n## 全文\n\n${body}\n`,
        metadata: { url, title, summary: found.summary, capturedAt, contentStatus: "full" },
      }
    : {
        text: `# ${title}\n\nURL: ${url}\n\nCaptured: ${capturedAt}\n\n## 未驗證搜尋摘要\n\n${found.summary}\n`,
        metadata: { url, title, summary: found.summary, capturedAt, contentStatus: "summary_only" },
      };
};

interface Harness {
  baseUrl: string;
  dataRoot: string;
  close: () => Promise<void>;
}

async function startApp(dependencies: AppDependencies = {}): Promise<Harness> {
  const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-url-adv-")), ".slide-maker-data");
  const app = await createApp(dataRoot, undefined, dependencies);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", (error?: Error) =>
      error ? reject(error) : resolve(listening),
    );
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dataRoot,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.listening ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
      ),
  };
}

describe("貼上網址：對抗性情境", () => {
  let harness: Harness;

  const post = (path: string, body: unknown) =>
    fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const createProject = async (): Promise<PresentationProject> => {
    const response = await post("/api/projects", {
      topic: "貼上網址對抗測試",
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

  const listSources = async (projectId: string): Promise<SourceAsset[]> =>
    (await (
      await fetch(`${harness.baseUrl}/api/projects/${projectId}/sources`)
    ).json()) as SourceAsset[];

  const assetDirs = (projectId: string) =>
    readdir(join(harness.dataRoot, "projects", projectId, "assets", "sources")).catch(() => []);

  beforeAll(async () => {
    harness = await startApp({ captureWebPage: fakeCapture });
  });
  afterAll(async () => harness.close());
  beforeEach(() => {
    bodyByUrl.clear();
    canonicalByUrl.clear();
    captureCalls.length = 0;
  });

  it("含 query string 與 unicode 的網址被正規化後才去重", async () => {
    const normalized = new URL("https://例え.テスト/ページ?q=中文&page=2").toString();
    bodyByUrl.set(normalized, "unicode 頁面的正文。");
    const project = await createProject();
    const { status, body } = await addUrls(project.id, [
      "https://例え.テスト/ページ?q=中文&page=2",
      normalized,
    ]);
    expect(status).toBe(201);
    // 同一個網址的兩種寫法只該抓一次。
    expect(captureCalls.map((call) => call.url)).toEqual([normalized]);
    expect(body.project!.sources).toHaveLength(1);
    expect(body.project!.sources[0]!.metadata.url).toBe(normalized);
    // query string 不可被丟掉：它常常就是「哪一頁／哪一篇」。
    expect(body.project!.sources[0]!.metadata.url).toContain("page=2");
  });

  it("重複貼同一個無效網址會得到重複的失敗條目", async () => {
    const project = await createProject();
    const { status, body } = await addUrls(project.id, ["不是網址", "不是網址"]);
    expect(status).toBe(400);
    // 有效網址走 `seen` 去重，無效的沒有——前端用 url 當 list key，重複會撞在一起。
    expect(body.failures).toEqual([
      { url: "不是網址", reason: "WEB_SOURCE_URL_INVALID" },
      { url: "不是網址", reason: "WEB_SOURCE_URL_INVALID" },
    ]);
  });

  it("陣列裡有一筆空白或超長網址，整批都會被 schema 打回（不是逐筆失敗）", async () => {
    const project = await createProject();
    bodyByUrl.set("https://example.com/ok", "正文。");
    const blank = await addUrls(project.id, ["https://example.com/ok", "   "]);
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe("INVALID_REQUEST");
    const long = await addUrls(project.id, [`https://example.com/${"a".repeat(2_100)}`]);
    expect(long.status).toBe(400);
    expect(long.body.error).toBe("INVALID_REQUEST");
    // 整批打回時一次都不會去抓。
    expect(captureCalls).toEqual([]);
    expect(await listSources(project.id)).toEqual([]);
  });

  it("重貼一個這次抓不到的網址：舊來源原封不動，並回報失敗", async () => {
    bodyByUrl.set("https://example.com/vanish", "第一次抓到的正文。");
    const project = await createProject();
    expect((await addUrls(project.id, ["https://example.com/vanish"])).status).toBe(201);
    const before = await listSources(project.id);

    bodyByUrl.delete("https://example.com/vanish");
    const retry = await addUrls(project.id, ["https://example.com/vanish"]);
    expect(retry.status).toBe(400);
    expect(retry.body.failures).toEqual([
      { url: "https://example.com/vanish", reason: "WEB_SOURCE_CONTENT_UNVERIFIED" },
    ]);
    const after = await listSources(project.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.extractedText).toContain("第一次抓到的正文。");
    expect(after[0]!.updatedAt).toBe(before[0]!.updatedAt);
  });

  it("貼上與搜尋來源同一個網址時原地更新，不會多一份資產目錄", async () => {
    bodyByUrl.set("https://example.com/shared", "搜尋存下來的正文。");
    const project = await createProject();
    const seeded = await post(`/api/projects/${project.id}/web-sources`, {
      sources: [{ url: "https://example.com/shared", title: "搜尋標題", summary: "摘要" }],
    });
    expect(seeded.status).toBe(201);
    const seededSource = ((await seeded.json()) as PresentationProject).sources[0]!;

    bodyByUrl.set("https://example.com/shared", "貼上網址後重新抓到的正文。");
    const pasted = await addUrls(project.id, ["https://example.com/shared"]);
    expect(pasted.status).toBe(201);
    const sources = pasted.body.project!.sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe(seededSource.id);
    // 既有來源沿用原本的檔名，不會被網頁標題改名。
    expect(sources[0]!.name).toBe(seededSource.name);
    expect(sources[0]!.extractedText).toContain("貼上網址後重新抓到的正文。");
    expect(await assetDirs(project.id)).toHaveLength(1);
  });

  it("一批網址是逐筆循序擷取的：整批的最壞等待時間會疊加", async () => {
    // 這決定了端點的最壞延遲：每筆最多 15 秒原生 fetch + 30 秒 render，10 筆循序跑
    // 就是分鐘級的單一 HTTP 請求（見報告的風險段落）。先把「循序」這個事實釘住。
    const project = await createProject();
    const marks: number[] = [];
    for (const path of ["t1", "t2", "t3"]) bodyByUrl.set(`https://example.com/${path}`, "正文。");
    const started = Date.now();
    const original = bodyByUrl.get.bind(bodyByUrl);
    // 讓每一次擷取都慢 60ms：若是併發，總時間會接近 60ms 而不是 180ms。
    bodyByUrl.get = ((key: string) => {
      marks.push(Date.now() - started);
      const value = original(key);
      const until = Date.now() + 60;
      while (Date.now() < until) {
        /* 忙等：假擷取是同步的，這裡只需要可觀察的時間差 */
      }
      return value;
    }) as typeof bodyByUrl.get;
    try {
      const { status } = await addUrls(project.id, [
        "https://example.com/t1",
        "https://example.com/t2",
        "https://example.com/t3",
      ]);
      expect(status).toBe(201);
    } finally {
      bodyByUrl.get = original;
    }
    expect(marks).toHaveLength(3);
    expect(marks[2]! - marks[0]!).toBeGreaterThanOrEqual(100);
  });

  it("併發撞到最後一個名額時，交易內的重驗擋得住（不會兩筆都塞進去）", async () => {
    const project = await createProject();
    for (let index = 0; index < 99; index += 1) {
      const query = new URLSearchParams({
        name: `filler-${index}.txt`,
        mediaType: "text/plain",
        allowModelAccess: "true",
      });
      await fetch(`${harness.baseUrl}/api/projects/${project.id}/sources?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: `填充 ${index}`,
      });
    }
    bodyByUrl.set("https://example.com/race1", "正文 1。");
    bodyByUrl.set("https://example.com/race2", "正文 2。");
    const [first, second] = await Promise.all([
      post(`/api/projects/${project.id}/url-sources`, { urls: ["https://example.com/race1"] }),
      post(`/api/projects/${project.id}/url-sources`, { urls: ["https://example.com/race2"] }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(await listSources(project.id)).toHaveLength(100);
  });

  it("兩個請求併發貼不同網址，兩筆都留得下來", async () => {
    bodyByUrl.set("https://example.com/c1", "併發正文 1。");
    bodyByUrl.set("https://example.com/c2", "併發正文 2。");
    const project = await createProject();
    const [first, second] = await Promise.all([
      post(`/api/projects/${project.id}/url-sources`, { urls: ["https://example.com/c1"] }),
      post(`/api/projects/${project.id}/url-sources`, { urls: ["https://example.com/c2"] }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const urls = (await listSources(project.id)).map((source) => source.metadata.url).sort();
    expect(urls).toEqual(["https://example.com/c1", "https://example.com/c2"]);
  });

  describe("兩個輸入網址擷取後正規化成同一個網址", () => {
    /** 很常見：`?utm_source=` 版本與乾淨版本一起貼、或 http 版被 301 導到 https 版。 */
    const seed = async () => {
      bodyByUrl.set("https://example.com/post?utm_source=news", "第一次抓到的內容。");
      bodyByUrl.set("https://example.com/post", "第二次抓到的內容。");
      canonicalByUrl.set("https://example.com/post?utm_source=news", "https://example.com/post");
      const project = await createProject();
      const result = await addUrls(project.id, [
        "https://example.com/post?utm_source=news",
        "https://example.com/post",
      ]);
      return { project, result };
    };

    it("最後只留一份來源（不會因為輸入寫法不同就重複收錄）", async () => {
      const { result } = await seed();
      expect(result.status).toBe(201);
      expect(result.body.project!.sources).toHaveLength(1);
    });

    /**
     * 【缺陷 D2｜資料完整性】兩個輸入正規化成同一個網址時，專案內的 `extractedText`
     * ／`chunks`（＝模型讀到的、來源搜尋索引到的）留在**第一次**的擷取結果，而磁碟上的
     * 資產檔已經被**第二次**的擷取覆寫。同一份來源，畫面預覽／匯出讀到的內容與模型讀到
     * 的內容不一致。
     *
     * 成因：`materializeWebSources` 的第二圈把第一圈剛建立的來源當成 `existing`，走
     * refresh 分支覆寫了同一個 `assetPath`，但這筆 refresh 的 id 在交易裡還不存在於
     * `current.sources`（`findIndex` = -1），於是更新被默默丟掉，最後推進去的是第一圈
     * 那個帶著舊文字的物件。
     *
     * 現況：這一條是紅的。
     */
    it.fails("【缺陷 D2】專案內的文字與磁碟上的資產必須是同一份內容", async () => {
      const { project, result } = await seed();
      const source = result.body.project!.sources[0]!;
      const onDisk = await readFile(
        join(harness.dataRoot, "projects", project.id, source.assetPath),
        "utf8",
      );
      expect(onDisk.trim()).toBe(source.extractedText.trim());
    });
  });

  describe("專案來源上限", () => {
    /** 先塞到剩下一個名額，再貼兩個抓得到正文的網址。 */
    const fillTo99 = async (projectId: string) => {
      for (let index = 0; index < 99; index += 1) {
        const query = new URLSearchParams({
          name: `filler-${index}.txt`,
          mediaType: "text/plain",
          allowModelAccess: "true",
        });
        const response = await fetch(
          `${harness.baseUrl}/api/projects/${projectId}/sources?${query.toString()}`,
          { method: "POST", headers: { "content-type": "text/plain" }, body: `填充 ${index}` },
        );
        expect(response.status).toBe(201);
      }
    };

    it("超過上限時整批回 409，且沒有任何一筆被寫進專案", async () => {
      const project = await createProject();
      await fillTo99(project.id);
      bodyByUrl.set("https://example.com/f1", "正文 1。");
      bodyByUrl.set("https://example.com/f2", "正文 2。");
      const { status, body } = await addUrls(project.id, [
        "https://example.com/f1",
        "https://example.com/f2",
      ]);
      expect(status).toBe(409);
      expect(body.error).toBe("SOURCE_PROJECT_LIMIT");
      // 使用者拿不到「哪一筆進去了、哪一筆沒有」的資訊，只有一個裸錯誤碼。
      expect(body.failures).toBeUndefined();
      expect(await listSources(project.id)).toHaveLength(99);
    });

    /**
     * 【缺陷 D4】擷取先落地成資產檔、交易才檢查上限，交易 throw 之後那些資產檔沒有人
     * 清掉。上面那個 409 情境會在磁碟留下兩個孤兒目錄（99 個填充來源 + 2 個孤兒）。
     * 專案裡看不到它們，容量統計也算不到，但硬碟被佔著。
     *
     * 現況：這一條是紅的（實得 101 個目錄）。
     */
    it.fails("【缺陷 D4】交易失敗後不該留下孤兒資產", async () => {
      const project = await createProject();
      await fillTo99(project.id);
      bodyByUrl.set("https://example.com/g1", "正文 1。");
      bodyByUrl.set("https://example.com/g2", "正文 2。");
      expect(
        (await addUrls(project.id, ["https://example.com/g1", "https://example.com/g2"])).status,
      ).toBe(409);
      expect(await assetDirs(project.id)).toHaveLength(99);
    });

    /**
     * 【缺陷 D5】只剩一個名額而貼了兩個網址時，塞得下的那一筆也一起被回滾。端點本來
     * 就有「部分成功 + 逐筆失敗回報」的語彙（`failures`），這裡卻退回全有全無，而且錯誤
     * 訊息沒有指出是哪一筆超限。
     *
     * 現況：這一條是紅的（實得 0 筆加入、狀態 409）。
     */
    it.fails("【缺陷 D5】剩一個名額時應該收下一筆並把另一筆列為失敗", async () => {
      const project = await createProject();
      await fillTo99(project.id);
      bodyByUrl.set("https://example.com/h1", "正文 1。");
      bodyByUrl.set("https://example.com/h2", "正文 2。");
      const { status, body } = await addUrls(project.id, [
        "https://example.com/h1",
        "https://example.com/h2",
      ]);
      expect(status).toBe(201);
      expect(body.project!.sources).toHaveLength(100);
      expect(body.failures).toHaveLength(1);
    });
  });
});

describe("render fallback 的接線（哪一條路會把網址送去第三方）", () => {
  let harness: Harness;
  const original = process.env.SLIDE_MAKER_WEB_RENDER_ENGINE;

  beforeAll(async () => {
    delete process.env.SLIDE_MAKER_WEB_RENDER_ENGINE; // 預設值＝jina
    harness = await startApp({
      captureWebPage: fakeCapture,
      webSearch: async () => [{ url: "https://example.com/s", title: "S", summary: "摘要" }],
    });
  });
  afterAll(async () => {
    await harness.close();
    if (original === undefined) delete process.env.SLIDE_MAKER_WEB_RENDER_ENGINE;
    else process.env.SLIDE_MAKER_WEB_RENDER_ENGINE = original;
  });
  beforeEach(() => {
    bodyByUrl.clear();
    canonicalByUrl.clear();
    captureCalls.length = 0;
  });

  const post = (path: string, body: unknown) =>
    fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("貼上網址預設帶著 jina renderer；搜尋擷取一律不帶", async () => {
    bodyByUrl.set("https://example.com/paste", "貼上的正文。");
    bodyByUrl.set("https://example.com/s", "搜尋的正文。");
    const project = (await (
      await post("/api/projects", { topic: "接線", brief: { desiredSlideCount: 1 } })
    ).json()) as PresentationProject;

    expect(
      (
        await post(`/api/projects/${project.id}/url-sources`, {
          urls: ["https://example.com/paste"],
        })
      ).status,
    ).toBe(201);
    expect(captureCalls).toEqual([{ url: "https://example.com/paste", renderer: "jina" }]);

    captureCalls.length = 0;
    expect(
      (
        await post(`/api/projects/${project.id}/web-sources`, {
          sources: [{ url: "https://example.com/s", title: "S", summary: "摘要" }],
        })
      ).status,
    ).toBe(201);
    // 搜尋結果的網址是模型給的，使用者沒有逐筆同意把它們送去第三方。
    expect(captureCalls).toEqual([{ url: "https://example.com/s", renderer: undefined }]);
  });
});

describe("SLIDE_MAKER_WEB_RENDER_ENGINE=none", () => {
  let harness: Harness;
  const original = process.env.SLIDE_MAKER_WEB_RENDER_ENGINE;

  beforeAll(async () => {
    process.env.SLIDE_MAKER_WEB_RENDER_ENGINE = "none";
    harness = await startApp({ captureWebPage: fakeCapture });
  });
  afterAll(async () => {
    await harness.close();
    if (original === undefined) delete process.env.SLIDE_MAKER_WEB_RENDER_ENGINE;
    else process.env.SLIDE_MAKER_WEB_RENDER_ENGINE = original;
  });
  beforeEach(() => {
    bodyByUrl.clear();
    captureCalls.length = 0;
  });

  it("停用第三方後仍然傳一個 renderer 進去（名稱 none），不是 undefined", async () => {
    // 這是刻意的：傳 renderer 同時代表「呼叫端要的是真正的正文」，停用第三方不該順帶
    // 把「空殼也算數」那個較鬆的標準偷渡回貼網址通道。
    bodyByUrl.set("https://example.com/paste", "貼上的正文。");
    const project = (await (
      await fetch(`${harness.baseUrl}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "停用", brief: { desiredSlideCount: 1 } }),
      })
    ).json()) as PresentationProject;
    const response = await fetch(`${harness.baseUrl}/api/projects/${project.id}/url-sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: ["https://example.com/paste"] }),
    });
    expect(response.status).toBe(201);
    expect(captureCalls).toEqual([{ url: "https://example.com/paste", renderer: "none" }]);
  });
});

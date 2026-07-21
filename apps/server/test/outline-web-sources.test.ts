import { mkdtemp } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { SqliteFtsRetriever } from "../src/retriever.js";

const SEARCH_URL = "https://example.com/ev-report";
const EXCLUDED_URL = "https://example.com/excluded-report";
// 只有抓下來的正文才有這兩段字；搜尋摘要沒有。用來分辨 prompt 裡拿到的是正文還是摘要。
const BODY_MARKER = "台灣電動車二〇二五年掛牌數為五萬八千輛";
const BODY_TAIL_MARKER = "附錄：各縣市充電樁佈建密度";
const SUMMARY = "電動車市場摘要一句話";

interface OutlinePayload {
  topic: string;
  sourceCatalog: { id: string; name: string; url?: string; summary: string }[];
  uploadedSources: { id: string; name: string; url?: string; locator?: string; text: string }[];
  searchedSources: Record<string, unknown>[];
}

/** 取出 prompt 中 UNTRUSTED_INPUT 之後的資料段（模型實際看到的來源資料）。 */
function untrustedPayload(prompt: string): OutlinePayload {
  const marker = "\nUNTRUSTED_INPUT\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return JSON.parse(prompt.slice(index + marker.length)) as OutlinePayload;
}

describe("大綱生成的來源資料流", () => {
  let appServer: Server | undefined;
  let fake: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  let bodyText = "";
  // "invalid" 讓大綱在索引之後才失敗，用來檢查半途而廢留下的索引是否外洩。
  // "overflow-once" 第一輪回超長 content 觸發重試迴圈，第二輪才給合法結果。
  let outlineMode: "valid" | "invalid" | "overflow-once" = "valid";
  // 搜尋與抓取都要能逐案切換，才驗得到「0 筆」與「全部抓取失敗」兩條守門路徑。
  let searchResults: { url: string; title: string; summary: string }[] = [];
  let captureStatus: "full" | "summary-only" = "full";
  const searchCalls: string[] = [];
  const prompts: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  // 逐 URL 覆寫抓取到的正文，用來分辨哪一頁的內容進了 prompt；沒覆寫的沿用 bodyText。
  const bodyByUrl = new Map<string, string>();
  let dataRoot = "";

  /** 直接讀 app 用的那份 FTS 索引，不經過端點的過濾，才驗得到索引本身的狀態。 */
  const indexedChunks = (projectId: string) =>
    new SqliteFtsRetriever(join(dataRoot, "index", "sources.sqlite")).search(
      projectId,
      "電動車市場",
      100,
    );

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    // 假的 OpenAI-compatible 端點：只負責記下 prompt 並回一份合法大綱。
    fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (part: Buffer) => chunks.push(part));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").endsWith("/models")) return res.end(JSON.stringify({ data: [] }));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: { role: string; content: unknown }[];
        };
        const user = body.messages?.find((message) => message.role === "user");
        const parts = Array.isArray(user?.content) ? (user.content as { text?: string }[]) : [];
        prompts.push(parts.map((part) => part.text ?? "").join(""));
        const attempt = prompts.length;
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    // 與 slides.length 不符會讓伺服器丟 CODEX_OUTLINE_COUNT_INVALID。
                    actualSlideCount: outlineMode === "invalid" ? 9 : 1,
                    rationale: "以抓下來的正文撰寫",
                    slides: [
                      {
                        purpose: "市場概況",
                        // high 密度的硬上限是 270 個中文字寬，400 字必定超出並觸發重試。
                        content:
                          outlineMode === "overflow-once" && attempt === 1
                            ? "台灣電動車掛牌數持續成長。".repeat(31)
                            : "台灣電動車掛牌數持續成長。",
                        narrative: "先講規模再講基礎建設",
                        layoutHint: "單欄重點",
                        sourceUrls: [SEARCH_URL],
                      },
                    ],
                    sources: [],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", resolve));

    setEnv(
      "SLIDE_MAKER_OPENAI_BASE_URL",
      `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
    );
    setEnv("SLIDE_MAKER_OPENAI_API_KEY", "test-key");
    setEnv("SLIDE_MAKER_OPENAI_TEXT_MODEL", "gpt-5");
    setEnv("SLIDE_MAKER_TEXT_ENGINE", "openai");

    dataRoot = await mkdtemp(join(tmpdir(), "slide-maker-outline-sources-"));
    const app = await createApp(dataRoot, undefined, {
      webSearch: async (query) => {
        searchCalls.push(query);
        return searchResults;
      },
      captureWebPage: async (found, capturedAt = new Date().toISOString()) => ({
        text: bodyByUrl.get(found.url) ?? bodyText,
        metadata: {
          url: found.url,
          title: found.title,
          summary: found.summary,
          capturedAt,
          contentStatus: captureStatus,
        },
      }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        appServer = app.listen(0, "127.0.0.1", (error?: Error) =>
          error ? reject(error) : resolve(),
        );
      });
      baseUrl = `http://127.0.0.1:${(appServer!.address() as AddressInfo).port}`;
    } catch (error) {
      if (["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
        unavailable = true;
      else throw error;
    }
  });

  afterAll(async () => {
    if (appServer?.listening) await new Promise<void>((r) => appServer!.close(() => r()));
    if (fake?.listening) await new Promise<void>((r) => fake!.close(() => r()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    prompts.length = 0;
    searchCalls.length = 0;
    bodyByUrl.clear();
    outlineMode = "valid";
    searchResults = [{ url: SEARCH_URL, title: "電動車年報", summary: SUMMARY }];
    captureStatus = "full";
    // 必須切出遠多於 knownSourceContext 名額（40）的 chunk，否則「保底取前 N 塊」的回退
    // 路徑就能矇混過關，檢索有沒有真的跑起來根本驗不出來。這裡約 57 塊。
    // 中段填充刻意不含查詢詞（topic ＋ audience ＋ purpose），只有頭尾兩塊命中，
    // 於是「撈得到結尾」等價於「檢索確實有跑」。
    bodyText = [
      `# 電動車年報\n\n${BODY_MARKER}`,
      ...Array.from(
        { length: 60 },
        (_, index) => `第 ${index} 節：${"本節記錄實驗流程與量測方法的細節說明。".repeat(60)}`,
      ),
      `台灣電動車市場${BODY_TAIL_MARKER}`,
    ].join("\n\n");
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }

  const createProject = () =>
    json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "台灣電動車市場", brief: { desiredSlideCount: 1 } }),
    });

  const generateOutline = (projectId: string, replace = false) =>
    json<PresentationProject>(`/api/projects/${projectId}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace }),
    });

  it("這一輪抓下來的網頁正文就進得了 prompt，而不是等下一次生成", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    await generateOutline(project.id);

    const payload = untrustedPayload(prompts[0]!);
    const excerpts = payload.uploadedSources.map((source) => source.text).join("\n");
    expect(excerpts).toContain(BODY_MARKER);
    expect(payload.uploadedSources.every((source) => source.url === SEARCH_URL)).toBe(true);
    expect(payload.sourceCatalog.map((source) => source.url)).toContain(SEARCH_URL);
  });

  it("searchedSources 只給 url 與 title：內容一律走 uploadedSources，摘要不得混充來源", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    await generateOutline(project.id);

    const payload = untrustedPayload(prompts[0]!);
    expect(payload.searchedSources).toEqual([{ url: SEARCH_URL, title: "電動車年報" }]);
    for (const item of payload.searchedSources)
      expect(Object.keys(item).sort()).toEqual(["title", "url"]);
  });

  it("sourceUrls 仍對應得到 materialize 出來的來源 id", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    const outlined = await generateOutline(project.id);

    const web = outlined.sources.find((source) => source.metadata.url === SEARCH_URL);
    expect(web).toBeDefined();
    expect(outlined.slides[0]?.sourceIds).toContain(web!.id);
  });

  it("重跑不會把同一個網址重複加成新來源", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    await generateOutline(project.id);
    const second = await generateOutline(project.id, true);

    expect(second.sources.filter((source) => source.metadata.url === SEARCH_URL)).toHaveLength(1);
    expect(
      untrustedPayload(prompts[1]!)
        .uploadedSources.map((source) => source.text)
        .join("\n"),
    ).toContain(BODY_MARKER);
  });

  it("多個 chunk 的長正文不是只送開頭一塊，文件後段也撈得到", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    await generateOutline(project.id);

    const payload = untrustedPayload(prompts[0]!);
    expect(payload.uploadedSources.length).toBeGreaterThan(1);
    const excerpts = payload.uploadedSources.map((source) => source.text).join("\n");
    // 結尾落在第 50 幾塊，遠在保底名額（40）之外：撈得到就代表當次生成確實把剛
    // materialize 出來的來源補進了索引，而不是靠「取前 N 塊」矇到。
    expect(excerpts).toContain(BODY_TAIL_MARKER);
    expect(excerpts).toContain(BODY_MARKER);
  });

  it("搜尋一筆都回不來時整批重試後放棄，不會靜靜地用模型記憶生成", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    searchResults = [];

    // 錯誤碼要能分辨「搜尋後端根本沒回東西」與「有結果但抓不到正文」，
    // 前者要使用者改條件或稍後再試，後者要使用者自己補來源——訊息混在一起就沒得排查。
    await expect(generateOutline(project.id)).rejects.toThrow("WEB_SEARCH_FAILED");
    // 靜默降級成「沒有來源」最危險：大綱看起來照樣生得出來，內容卻全是模型腦補的。
    expect(prompts).toHaveLength(0);
    // 搜尋後端偶發回空是常態，所以重試整整 5 輪才放棄。
    expect(searchCalls).toHaveLength(5);
    // 失敗要讓專案原封不動：既沒有半路加進來的來源，也沒有被清空的既有大綱。
    const after = await json<PresentationProject>(`/api/projects/${project.id}`);
    expect(after.sources).toEqual([]);
    expect(after.slides).toEqual(project.slides);
  });

  it("搜尋有結果但正文全部抓不到時停止生成，未驗證的摘要不得頂替來源", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    captureStatus = "summary-only";

    await expect(generateOutline(project.id)).rejects.toThrow("WEB_SEARCH_SOURCES_UNVERIFIED");
    expect(prompts).toHaveLength(0);
    // 抓取失敗的頁不能被當成來源留在專案裡，否則下一輪會誤以為已有全文而跳過重抓。
    const after = await json<PresentationProject>(`/api/projects/${project.id}`);
    expect(after.sources).toEqual([]);
  });

  it("content 過長觸發重試時不會再搜尋一次，也不會把同一頁重複加成來源", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    outlineMode = "overflow-once";

    const outlined = await generateOutline(project.id);

    expect(prompts).toHaveLength(2);
    // 搜尋與抓取都在重試迴圈之外。若哪天被搬進迴圈，配額會隨重試次數翻倍，
    // 而且每一輪都會再 materialize 一次同樣的網頁。
    expect(searchCalls).toHaveLength(1);
    expect(outlined.sources.filter((source) => source.metadata.url === SEARCH_URL)).toHaveLength(1);
    // 重試的 prompt 必須帶著同一批已抓下來的正文，而不是退回只有摘要的狀態。
    expect(
      untrustedPayload(prompts[1]!)
        .uploadedSources.map((source) => source.text)
        .join("\n"),
    ).toContain(BODY_MARKER);
    expect(prompts[1]).toContain("UNTRUSTED_INPUT");
  });

  it("生成中途失敗時，尚未落地的網頁 chunk 不會從搜尋面板漏出去", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    outlineMode = "invalid";
    await expect(generateOutline(project.id)).rejects.toThrow();

    const after = await json<PresentationProject>(`/api/projects/${project.id}`);
    expect(after.sources).toHaveLength(0);
    const hits = await json<{ sourceId: string }[]>(
      `/api/projects/${project.id}/search?q=${encodeURIComponent("電動車市場")}`,
    );
    expect(hits).toEqual([]);
  });

  it("生成失敗時索引直接回滾，孤兒 chunk 不是靠讀取端過濾掩蓋", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    // 成功時索引裡本來就該有這批 chunk——先確認正向情況，否則下面的「空」證明不了任何事。
    await generateOutline(project.id);
    expect(indexedChunks(project.id).length).toBeGreaterThan(0);

    const failing = await createProject();
    outlineMode = "invalid";
    await expect(generateOutline(failing.id)).rejects.toThrow();

    // 讀取端的過濾只是縱深防禦。孤兒若留在索引裡，SQL 的 LIMIT 會先讓它們占掉名額，
    // 真實結果被擠出去後 /search 靜靜落入粗糙的 fallback、knownSourceContext 退回取前 N 塊。
    expect(indexedChunks(failing.id)).toEqual([]);
    // 回滾只針對這次失敗的專案，不能把別的專案的索引一起清掉。
    expect(indexedChunks(project.id).length).toBeGreaterThan(0);
  });

  it("prompt 對 uploadedSources 的描述前後一致：是節錄，不是全文", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    await generateOutline(project.id);

    const prompt = prompts[0]!;
    const instructions = prompt.slice(0, prompt.indexOf("\nUNTRUSTED_INPUT\n"));
    // knownSourceContext 最多給 40 塊、每塊截在 1600 字，且每份來源還有配額上限。
    // 只要 prompt 宣稱模型手上有全文，它就會停止追問覆蓋範圍，把節錄當成資料的全部。
    expect(instructions).not.toMatch(/full text/i);
    expect(instructions).toContain("uploadedSources is the only source of content");
    expect(instructions).toContain("excerpts");
    // 另一句「uploadedSources carries excerpts only」必須仍在，兩句不得互相打架。
    expect(instructions).toContain("uploadedSources carries excerpts only");
    expect(instructions).toContain("searchedSources is a citation index only");
  });

  it("被標記為不參與生成的網頁，網址不會出現在 searchedSources", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    bodyByUrl.set(EXCLUDED_URL, "台灣電動車市場的機密內部評估與未公開數字。".repeat(20));
    searchResults = [
      { url: SEARCH_URL, title: "電動車年報", summary: SUMMARY },
      { url: EXCLUDED_URL, title: "內部評估", summary: "不該被引用" },
    ];
    // 先讓兩頁都落地成專案來源，再把其中一頁標記為不參與生成。
    await generateOutline(project.id);
    const landed = await json<PresentationProject>(`/api/projects/${project.id}`);
    const excluded = landed.sources.find((source) => source.metadata.url === EXCLUDED_URL)!;
    await json<PresentationProject>(`/api/projects/${project.id}/sources/${excluded.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usage: "exclude-from-generation" }),
    });

    prompts.length = 0;
    await generateOutline(project.id, true);

    const payload = untrustedPayload(prompts[0]!);
    // 內容本來就被 knownSourceContext／sourceCatalog 濾掉了；網址若還留著，模型會引用一份
    // 自己手上沒有內容的來源，等於憑標題編造引用。
    expect(payload.searchedSources).toEqual([{ url: SEARCH_URL, title: "電動車年報" }]);
    expect(payload.sourceCatalog.map((source) => source.url)).not.toContain(EXCLUDED_URL);
    expect(payload.uploadedSources.map((source) => source.url)).not.toContain(EXCLUDED_URL);
    expect(JSON.stringify(payload)).not.toContain("機密內部評估");
  });

  it("既有的本地來源與這次抓下來的網頁一起進 prompt，不是被網頁取代", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    const localText = "台灣電動車市場的內部銷售紀錄：2025 年掛牌五萬八千輛。";
    const uploaded = await json<PresentationProject>(
      `/api/projects/${project.id}/sources?name=${encodeURIComponent("內部紀錄.md")}&mediaType=text/markdown`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new TextEncoder().encode(localText),
      },
    );
    const local = uploaded.sources[0]!;

    await generateOutline(project.id);

    const payload = untrustedPayload(prompts[0]!);
    const ids = payload.uploadedSources.map((source) => source.id);
    // before.sources 與 addedSources 的合併若寫錯，最典型的結果就是本地來源整份消失。
    expect(ids).toContain(local.id);
    expect(payload.uploadedSources.map((source) => source.text).join("\n")).toContain(
      "內部銷售紀錄",
    );
    const web = payload.uploadedSources.filter((source) => source.url === SEARCH_URL);
    expect(web.length).toBeGreaterThan(0);

    const catalogIds = payload.sourceCatalog.map((source) => source.id);
    expect(catalogIds).toContain(local.id);
    expect(payload.sourceCatalog.map((source) => source.url)).toContain(SEARCH_URL);
    // 合併用 id 覆蓋而不是無腦串接，同一份來源不該在目錄裡出現兩次。
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
  });
});

import { mkdtemp, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SOURCE_COUNT_LIMIT,
  SOURCE_TOTAL_BYTES_LIMIT,
  type PresentationProject,
  type StructuredTextProvider,
  type StructuredTextRequest,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import { FileProjectRepository } from "../src/repository.js";

/**
 * 整份大綱那條路的來源上限。
 *
 * 上傳端點擋在 `SOURCE_COUNT_LIMIT`，但大綱把搜尋抓回來的來源 push 進專案時**一個檢查
 * 都沒有**——線上那份專案就是這樣從 100 長到 108 份的。份數上限拉到 200 之後，同一個
 * 缺口只是換個數字繼續存在，所以這一條要釘住「另一條入口也走同一份檢查」。
 */

const SEARCH_HOST = "https://example.com";

describe("來源上限：份數與容量是兩條不同的路", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";
  let bindUnavailable = false;
  const restore: (() => void)[] = [];

  /** 記下每一次模型呼叫：這一組要證明的其中一件事就是「模型根本沒被呼叫」。 */
  const prompts: string[] = [];
  const stubTextProvider = (reply: (attempt: number) => unknown) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        prompts.push(request.prompt);
        return { value: reply(prompts.length) };
      },
    } as StructuredTextProvider);
    restore.push(() => spy.mockRestore());
  };

  const silence = (level: "warn" | "error") => {
    const spy =
      level === "warn"
        ? vi.spyOn(console, "warn").mockImplementation(() => undefined)
        : vi.spyOn(console, "error").mockImplementation(() => undefined);
    restore.push(() => spy.mockRestore());
  };

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "slide-maker-outline-source-limit-"));
    const app = await createApp(dataRoot, undefined, {
      // 每次搜尋都回三個「新」網址，逼大綱那條路去 push 新來源。
      webSearch: async () =>
        Array.from({ length: 3 }, (_, index) => ({
          url: `${SEARCH_HOST}/found-${index}`,
          title: `搜尋結果 ${index}`,
          summary: `摘要 ${index}`,
        })),
      captureWebPage: async (found, capturedAt = new Date().toISOString()) => ({
        text: `${found.title} 的正文：台灣電動車市場的年度回顧與各縣市充電樁佈建密度。`,
        metadata: {
          url: found.url,
          title: found.title,
          summary: found.summary,
          capturedAt,
          contentStatus: "full" as const,
        },
      }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
      baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") bindUnavailable = true;
      else throw error;
    }
  });

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    prompts.length = 0;
  });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  const assetDirs = async (projectId: string): Promise<string[]> => {
    try {
      return await readdir(join(dataRoot, "projects", projectId, "assets", "sources"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  it("容量超過上限時回 SOURCE_SIZE_LIMIT 而不是份數上限，且同樣是 409", async (context) => {
    if (bindUnavailable) return context.skip();
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "容量上限", brief: { webSearchMode: "disabled" } }),
    });
    const project = (await created.json()) as PresentationProject;
    const query = new URLSearchParams({ name: "大檔.md", mediaType: "text/markdown" });
    const first = await fetch(`${baseUrl}/api/projects/${project.id}/sources?${query.toString()}`, {
      method: "POST",
      headers: { "content-type": "text/markdown" },
      body: new TextEncoder().encode("一份普通大小的來源。"),
    });
    expect(first.status).toBe(201);

    // 直接把已用容量改成剛好貼著上限：真的傳 2 GiB 進來只是把測試變慢，驗的東西一模一樣。
    const repository = new FileProjectRepository(dataRoot);
    await repository.updateProject(project.id, (draft) => {
      draft.sources[0]!.sizeBytes = SOURCE_TOTAL_BYTES_LIMIT - 4;
      return structuredClone(draft);
    });

    const overflow = await fetch(
      `${baseUrl}/api/projects/${project.id}/sources?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "text/markdown" },
        body: new TextEncoder().encode("這一份會超過總容量上限。"),
      },
    );

    // **狀態碼也要釘**：兩個新碼都以 `SOURCE_` 開頭，而錯誤中介層後面有一條吃掉所有
    // `SOURCE_` 開頭代碼的 400 分支——漏接就會變成「壞輸入」，而「專案滿了」是衝突。
    expect(overflow.status).toBe(409);
    const body = (await overflow.json()) as { error?: string; message?: string };
    expect(body.error).toBe("SOURCE_SIZE_LIMIT");
    // 份數還很空，不能報成份數上限：兩者的下一步不同（刪幾份 vs 刪大的那幾份）。
    expect(body.error).not.toBe("SOURCE_COUNT_LIMIT");
    expect(body.message).toContain("2 GB");
    expect(body.message).toContain("較大的來源");
  });

  it("專案已滿時跑整份大綱，搜尋來源不得讓份數超過上限，也不留孤兒資產", async (context) => {
    if (bindUnavailable) return context.skip();
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // webSearchMode 保持預設（會搜尋）：這一條要驗的正是搜尋來源那條入口。
      body: JSON.stringify({ topic: "台灣電動車市場", brief: { desiredSlideCount: 1 } }),
    });
    const project = (await created.json()) as PresentationProject;

    for (let index = 0; index < SOURCE_COUNT_LIMIT; index += 1) {
      const query = new URLSearchParams({
        name: `填充來源-${index}.md`,
        mediaType: "text/markdown",
      });
      const response = await fetch(
        `${baseUrl}/api/projects/${project.id}/sources?${query.toString()}`,
        {
          method: "POST",
          headers: { "content-type": "text/markdown" },
          body: new TextEncoder().encode(`第 ${index} 份填充來源的正文。`),
        },
      );
      expect(response.status).toBe(201);
    }
    const before = await assetDirs(project.id);
    expect(before).toHaveLength(SOURCE_COUNT_LIMIT);

    stubTextProvider(() => ({
      actualSlideCount: 1,
      rationale: "測試用",
      slides: [
        {
          purpose: "唯一一頁",
          planRef: "P1",
          content: "第一頁的內容",
          narrative: "講者補充",
          layoutHint: "單欄重點",
          sourceRefs: [],
          imageRefs: [],
          sourceUrls: [],
        },
      ],
    }));
    silence("warn");
    silence("error");

    const outline = await fetch(`${baseUrl}/api/projects/${project.id}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace: true }),
    });

    // 撞上限 → 整筆交易回滾 → 409。放行的話專案會靜靜地變成 203 份，而目錄預算是照
    // SOURCE_COUNT_LIMIT 算的，超出的那幾份等於永遠不會被模型看到。
    expect(outline.status).toBe(409);
    const body = (await outline.json()) as { error?: string; message?: string };
    expect(body.error).toBe("SOURCE_COUNT_LIMIT");
    expect(body.message).toContain(String(SOURCE_COUNT_LIMIT));
    // **一次模型呼叫都不能發生**：容量檢查若排在兩階段之後，已經滿了的專案每按一次
    // 「生成大綱」就白燒兩次配額，而且刪掉來源之前每次都一樣（確定性重現）。
    expect(prompts).toEqual([]);

    const after = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}`)
    ).json()) as PresentationProject;
    expect(after.sources).toHaveLength(SOURCE_COUNT_LIMIT);
    expect(after.sources.some((source) => source.metadata.url?.startsWith(SEARCH_HOST))).toBe(
      false,
    );
    // materialize 已經把三份網頁寫到磁碟了，交易回滾之後那些資產必須一起回收：
    // 留著就是孤兒（專案看不到、容量統計算不到，硬碟卻被佔著，每重試一次多三份）。
    expect(await assetDirs(project.id)).toHaveLength(SOURCE_COUNT_LIMIT);
  });
});

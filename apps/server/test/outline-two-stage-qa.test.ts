import { mkdtemp, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  outlineContentCharBudget,
  type PresentationProject,
  type SlideSpec,
  type StructuredTextProvider,
  type StructuredTextRequest,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import { isStyleDirectionPrompt, STYLE_DIRECTION_REPLY } from "./helpers/style-direction-stub.js";

/**
 * 兩階段大綱的補充情境。
 *
 * `outline-two-stage.test.ts` 驗的是「模型挑的來源有沒有逐頁落地」；這一組補的是它沒有
 * 覆蓋、但錯了同樣是靜默的四件事：
 *  1. 階段 1 成功、階段 2 失敗時，materialize 出來的網頁資產有沒有被回收（舊的回滾測試
 *     用的是 4 頁超出範圍，那在兩階段之後**停在階段 1**，階段 2 那條回滾路徑等於沒被走過）。
 *  2. 階段 2 的長度重試跑多輪時，`purpose`（階段 1 產）與 `content`（階段 2 產）的配對。
 *     兩份陣列分屬兩次呼叫，錯位不會 throw，只會讓每一頁的標題與內文對不上。
 *  3. 來源數的兩個邊界（0 份、1 份）——`outlineSlideChunkBudget` 與 `knownSourceContext`
 *     在這兩點上都有除法與保底輪。
 *  4. 隱藏頁與這條路徑的互動。
 */

/** 預設風格是 high 密度；硬上限由 core 決定，測試不重寫一份數字。 */
const HARD_LIMIT = outlineContentCharBudget("high").hard;
/** 每個中文字算 1 單位，所以字數就是量測值。 */
const units = (count: number) => "台".repeat(count);

const BODY_MARKER = "台灣電動車二〇二五年掛牌數為五萬八千輛";

interface StagePayload {
  topic: string;
  sourceCatalog: { ref: string; name: string; kind: string; summary: string }[];
  uploadedSources?: { ref: string; source?: string; text: string }[];
  slides?: { purpose: string; sourceRefs: string[]; imageRefs: string[]; excerptRefs: string[] }[];
  previousAttempt?: { purpose: string; content: string; overflow: boolean }[];
}

function untrustedPayload(prompt: string): StagePayload {
  const marker = "\nUNTRUSTED_INPUT\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return JSON.parse(prompt.slice(index + marker.length)) as StagePayload;
}

const planReply = (slides: { purpose: string; sourceRefs?: string[]; imageRefs?: string[] }[]) => ({
  actualSlideCount: slides.length,
  rationale: "測試用計畫",
  slides: slides.map((slide) => ({
    purpose: slide.purpose,
    sourceRefs: slide.sourceRefs ?? [],
    imageRefs: slide.imageRefs ?? [],
  })),
});

const draftReply = (
  slides: { content: string; sourceRefs?: string[]; imageRefs?: string[] }[],
) => ({
  slides: slides.map((slide) => ({
    content: slide.content,
    narrative: "講者補充",
    layoutHint: "單欄重點",
    sourceRefs: slide.sourceRefs ?? [],
    imageRefs: slide.imageRefs ?? [],
    sourceUrls: [],
  })),
});

describe("兩階段大綱的補充情境", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  const prompts: string[] = [];
  const restore: (() => void)[] = [];

  /** 每一輪的回覆由 attempt（第幾次呼叫）決定：1 是規劃，之後是寫作。 */
  const stubTextProvider = (reply: (attempt: number, prompt: string) => unknown) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        // 風格決議是大綱之後**另外一次**呼叫，不屬於這一組測試在驗的兩階段。給它一份
        // 合法回覆並且不記進 prompts：那些斷言是靠「第幾次呼叫」與陣列長度成立的。
        if (isStyleDirectionPrompt(request.prompt)) return { value: STYLE_DIRECTION_REPLY };
        prompts.push(request.prompt);
        const result = reply(prompts.length, request.prompt);
        if (result instanceof Error) throw result;
        // provider 合約是信封（`StructuredTextResult`）：模型的輸出在 `value`，用量在 `usage`。
        return { value: result };
      },
    } as StructuredTextProvider);
    restore.push(() => spy.mockRestore());
  };

  const captureLogs = (level: "warn" | "error" = "warn"): (() => Record<string, unknown>[]) => {
    const lines: string[] = [];
    const collect = (line: unknown) => {
      lines.push(String(line));
    };
    const spy =
      level === "warn"
        ? vi.spyOn(console, "warn").mockImplementation(collect)
        : vi.spyOn(console, "error").mockImplementation(collect);
    restore.push(() => spy.mockRestore());
    return () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  };

  beforeAll(async () => {
    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-two-stage-qa-")), "data");
    const app = await createApp(dataRoot);
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
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    prompts.length = 0;
  });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  async function patch<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  /** 搜尋一律關掉：這一組驗的是兩階段本身，不是網路搜尋流程。 */
  const createProject = async (desiredSlideCount: number) => {
    const { body } = await post<PresentationProject>("/api/projects", {
      topic: "台灣電動車市場",
      brief: { desiredSlideCount, webSearchMode: "disabled" },
    });
    return body;
  };

  const addSource = async (
    projectId: string,
    name: string,
    text: string,
    usage = "content",
  ): Promise<PresentationProject> => {
    const query = new URLSearchParams({ name, mediaType: "text/markdown", usage });
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/sources?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new TextEncoder().encode(text),
      },
    );
    return (await response.json()) as PresentationProject;
  };

  const generateDeck = (projectId: string) =>
    post<PresentationProject & { error?: string }>(`/api/projects/${projectId}/outline`, {
      replace: true,
    });

  it("專案一份來源都沒有時兩階段照樣走完，且不把「沒選到」誤報成降級", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(2);
    expect(project.sources).toHaveLength(0);
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "封面" }, { purpose: "結論" }])
        : draftReply([{ content: "第一頁" }, { content: "第二頁" }]),
    );
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(2);
    expect(body.slides.map((slide) => slide.purpose)).toEqual(["封面", "結論"]);
    expect(body.slides.map((slide) => slide.sourceIds)).toEqual([[], []]);
    // 目錄是空的時候「一個都沒挑」是唯一的正確答案，不是模型沒做事——不得記成降級，
    // 否則每一份還沒上傳來源的新專案都會在 log 裡留下假的告警。
    expect(readWarnings().filter((entry) => entry.event === "outline_refs_unmatched")).toEqual([]);
    expect(readWarnings().filter((entry) => entry.event === "outline_refs_partial")).toEqual([]);
    // 階段 1 的目錄與階段 2 的節錄都空著，但 prompt 結構本身仍要成立。
    expect(untrustedPayload(prompts[0]!).sourceCatalog).toEqual([]);
    expect(untrustedPayload(prompts[1]!).uploadedSources).toEqual([]);
  });

  it("專案只有 1 份來源時逐頁預算不會除出 0 塊，該頁仍拿得到正文", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(1);
    const latest = await addSource(project.id, "唯一來源.md", `${BODY_MARKER}。獨有的細節說明。`);
    expect(latest.sources).toHaveLength(1);
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "唯一一頁", sourceRefs: ["S1"] }])
        : draftReply([{ content: "第一頁", sourceRefs: ["S1"] }]),
    );
    captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(body.slides).toHaveLength(1);
    expect(body.slides[0]!.sourceIds).toEqual([latest.sources[0]!.id]);
    const draft = untrustedPayload(prompts[1]!);
    // 逐頁預算是 96/頁數，夾在 5..12；1 頁 1 份來源時它必須仍然大於 0，否則階段 1 挑的
    // 那份來源在階段 2 一個字都拿不到，兩階段等於白跑。
    expect(draft.slides?.[0]!.excerptRefs.length).toBeGreaterThan(0);
    expect(JSON.stringify(draft.uploadedSources)).toContain(BODY_MARKER);
  });

  it("階段 2 跑滿三輪重試後，purpose 與被採用那一輪的 content 仍逐頁對齊", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(3);
    const purposes = ["封面頁", "數據頁", "結論頁"];
    // 三輪都超標 → 走「採用超額總和最小的那一版」的降級路徑。第 2 輪最短，所以最後落地
    // 的 content 必須整組來自第 2 輪，而 purpose 整組來自階段 1——兩份陣列分屬不同次呼叫，
    // 配對錯了不會 throw，只會讓每一頁的標題與內文對不上。
    const round = (tag: string, excess: number[]) =>
      draftReply(
        purposes.map((_purpose, index) => ({ content: `${units(excess[index]!)}${tag}${index}` })),
      );
    stubTextProvider((attempt) => {
      if (attempt === 1) return planReply(purposes.map((purpose) => ({ purpose })));
      if (attempt === 2) return round("R1", [HARD_LIMIT + 100, 10, HARD_LIMIT + 100]);
      if (attempt === 3) return round("R2", [HARD_LIMIT + 20, 11, 12]);
      return round("R3", [HARD_LIMIT + 60, 13, 14]);
    });
    captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    // 1 次規劃 + 3 輪寫作。
    expect(prompts).toHaveLength(4);
    expect(body.slides.map((slide) => slide.order)).toEqual([0, 1, 2]);
    expect(body.slides.map((slide) => slide.purpose)).toEqual(purposes);
    // 被採用的是第 2 輪（超額 20 最小），而且是**整組**第 2 輪，不是各輪混搭。
    expect(body.slides.map((slide) => slide.content)).toEqual([
      `${units(HARD_LIMIT + 20)}R20`,
      `${units(11)}R21`,
      `${units(12)}R22`,
    ]);

    // 餵回去的 previousAttempt 也必須逐頁配對：purpose 來自計畫、content 來自上一輪草稿。
    // 這裡錯位的話，模型會被要求「把第 2 頁改短」卻拿到第 3 頁的文字。
    const fedBack = untrustedPayload(prompts[3]!).previousAttempt!;
    expect(fedBack.map((entry) => entry.purpose)).toEqual(purposes);
    expect(fedBack.map((entry) => entry.content)).toEqual([
      `${units(HARD_LIMIT + 20)}R20`,
      `${units(11)}R21`,
      `${units(12)}R22`,
    ]);
    expect(fedBack.map((entry) => entry.overflow)).toEqual([true, false, false]);
  });

  it("階段 1 把 kind 為 text 的來源放進 imageRefs 時不會爆，也不會被當成沒選", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(1);
    await addSource(project.id, "純文字報告.md", `${BODY_MARKER}。文字來源的細節。`);
    const uploaded = await addSource(project.id, "圖表說明.md", "圖片來源的說明文字");
    // 改用途而不重新上傳：帶 describeImage 才會呼叫模型，這裡刻意不帶，避免多打一次
    // vision 請求（`buildOutlineCatalog` 的 kind 只看 usage）。
    const { body: latest } = await patch<PresentationProject>(
      `/api/projects/${project.id}/sources/${uploaded.sources[1]!.id}`,
      { usage: "visual-reference" },
    );
    const [textSource, imageSource] = latest.sources;
    expect(imageSource!.usage).toBe("visual-reference");
    // 模型把文字來源塞進 imageRefs：prompt 明說「imageRefs 只能放 kind 為 image 的 ref」，
    // 但非嚴格 gateway 不遵守，而伺服器端沒有 kind 檢查。
    const picks = [{ imageRefs: ["S1"], sourceRefs: ["S2"] }];
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "唯一一頁", ...picks[0]! }])
        : draftReply([{ content: "第一頁", ...picks[0]! }]),
    );
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    // 目錄本身要把 kind 標對，模型才有可能遵守（也才驗得出這個情境確實踩到了 text）。
    const catalog = untrustedPayload(prompts[0]!).sourceCatalog;
    expect(catalog.find((entry) => entry.name === "純文字報告.md")?.kind).toBe("text");
    expect(catalog.find((entry) => entry.name === "圖表說明.md")?.kind).toBe("image");
    // 兩個 ref 都對得上目錄，所以兩份來源都算「模型選的」——放錯欄位不該讓這一頁退回
    // 全域 fallback，那會把模型的選擇整個丟掉。
    expect(new Set(body.slides[0]!.sourceIds)).toEqual(new Set([textSource!.id, imageSource!.id]));
    expect(readWarnings().filter((entry) => entry.event === "outline_source_ids_fallback")).toEqual(
      [],
    );
    expect(readWarnings().filter((entry) => entry.event === "outline_refs_unmatched")).toEqual([]);
  });

  it("階段 2 的例外不得把節錄正文帶進 log", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(1);
    await addSource(project.id, "來源.md", `${BODY_MARKER}。細節說明。`);
    // `outline-two-stage.test.ts` 的階段 2 洩漏測試用的是 `content: 12` 造出的 ZodError，
    // 而 `invalid_type` 的 issue 只記型別名（`received: "number"`），**訊息裡根本沒有正文**
    // ——那條斷言因此是空的（不過濾也會通過）。真的會洩漏的是同一個 catch 罩住的另一半：
    // 非嚴格 gateway 把 request body 原樣回聲進 400 的 message，而階段 2 的 body 裝著
    // 逐頁檢索出來的節錄正文。
    stubTextProvider((attempt, prompt) =>
      attempt === 1
        ? planReply([{ purpose: "唯一一頁", sourceRefs: ["S1"] }])
        : new Error(`HTTP 400 from gateway: ${prompt}`),
    );
    const readWarnings = captureLogs();
    captureLogs("error");

    const { status } = await generateDeck(project.id);

    expect(status).not.toBe(200);
    const failed = readWarnings().filter((entry) => entry.event === "outline_stage_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ projectId: project.id, stage: "draft", attempt: 1 });
    // 先確認這個例外真的夾帶了正文，否則下面的 not.toContain 證明不了任何事。
    const leaking = `HTTP 400 from gateway: ${prompts[1]}`;
    expect(leaking).toContain(BODY_MARKER);
    const serialized = JSON.stringify(failed[0]);
    expect(serialized).not.toContain(BODY_MARKER);
    expect(serialized).not.toContain("UNTRUSTED_INPUT");
    expect(serialized).not.toContain("HTTP 400 from gateway");
    expect(failed[0]!.errorName).toBe("Error");
  });

  it("隱藏頁不影響單頁重生，也不會被重生順手清掉", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(2);
    await addSource(project.id, "來源.md", `${BODY_MARKER}。細節說明。`);
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "封面", sourceRefs: ["S1"] }, { purpose: "結論" }])
        : draftReply([{ content: "第一頁", sourceRefs: ["S1"] }, { content: "第二頁" }]),
    );
    captureLogs();
    const { body: outlined } = await generateDeck(project.id);
    expect(outlined.slides).toHaveLength(2);
    for (const undo of restore.splice(0)) undo();

    const target = outlined.slides[1]!;
    const { body: hiddenProject } = await patch<PresentationProject>(
      `/api/projects/${project.id}/slides/${target.id}`,
      { hidden: true },
    );
    expect(hiddenProject.slides[1]!.hidden).toBe(true);
    // 隱藏只決定這一頁上不上場，一個像素都沒動到圖：不得留下 outlineDirty 的橘框。
    expect(hiddenProject.slides[1]!.outlineDirty ?? false).toBe(false);

    // 單頁重生走的是被這次改動重構過的 slideSourceContext；隱藏頁仍可正常重生，
    // 而且 hidden 是頁面層級的旗標，重生內容不得順手把它清掉。
    stubTextProvider(() => ({
      content: "重生後的第二頁",
      narrative: "講者補充",
      layoutHint: "單欄重點",
      sourceIds: [],
    }));
    captureLogs();
    const { status, body } = await post<PresentationProject>(
      `/api/projects/${project.id}/slides/${target.id}/outline`,
      {},
    );

    expect(status).toBe(200);
    const regenerated = body.slides.find((slide) => slide.id === target.id)!;
    expect(regenerated.content).toBe("重生後的第二頁");
    expect(regenerated.hidden).toBe(true);
    expect(body.slides[0]!.hidden ?? false).toBe(false);
  });

  it("整份大綱重生在有隱藏頁的專案上照樣跑完兩階段", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(2);
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "封面" }, { purpose: "結論" }])
        : draftReply([{ content: "第一頁" }, { content: "第二頁" }]),
    );
    captureLogs();
    const { body: outlined } = await generateDeck(project.id);
    for (const undo of restore.splice(0)) undo();
    prompts.length = 0;

    await patch<PresentationProject>(
      `/api/projects/${project.id}/slides/${outlined.slides[0]!.id}`,
      { hidden: true },
    );

    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "新封面" }, { purpose: "新結論" }])
        : draftReply([{ content: "改寫的第一頁" }, { content: "改寫的第二頁" }]),
    );
    captureLogs();
    const { status, body } = await generateDeck(project.id);

    // 整份重生會換掉所有頁面（新的 id），所以這裡驗的是「不會因為專案裡有隱藏頁就失敗」。
    expect(status).toBe(200);
    expect(prompts).toHaveLength(2);
    expect(body.slides.map((slide) => slide.purpose)).toEqual(["新封面", "新結論"]);
    expect(body.slides).toHaveLength(2);
  });
});

/**
 * 階段 2 失敗時的回滾。
 *
 * 需要真的 materialize 出網頁來源才驗得到孤兒目錄，所以這一段自己起一份帶搜尋注入的 app。
 */
describe("階段 2 失敗時已落地的網頁來源被回收", () => {
  const SEARCH_URL = "https://example.com/ev-report";
  const WEB_BODY = `${BODY_MARKER}。台灣電動車市場的年度回顧與各縣市充電樁佈建密度。`;
  let appServer: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";
  let unavailable = false;
  const prompts: string[] = [];
  const restore: (() => void)[] = [];

  const stubTextProvider = (reply: (attempt: number) => unknown) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        // 風格決議是大綱之後**另外一次**呼叫，不屬於這一組測試在驗的兩階段。給它一份
        // 合法回覆並且不記進 prompts：那些斷言是靠「第幾次呼叫」與陣列長度成立的。
        if (isStyleDirectionPrompt(request.prompt)) return { value: STYLE_DIRECTION_REPLY };
        prompts.push(request.prompt);
        const result = reply(prompts.length);
        if (result instanceof Error) throw result;
        return { value: result };
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
    dataRoot = await mkdtemp(join(tmpdir(), "slide-maker-two-stage-rollback-"));
    const app = await createApp(dataRoot, undefined, {
      webSearch: async () => [
        { url: SEARCH_URL, title: "電動車年報", summary: "電動車市場摘要一句話" },
      ],
      captureWebPage: async (found, capturedAt = new Date().toISOString()) => ({
        text: WEB_BODY,
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

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    prompts.length = 0;
  });

  afterAll(async () => {
    if (appServer?.listening) await new Promise<void>((r) => appServer!.close(() => r()));
  });

  const listSourceAssets = async (projectId: string): Promise<string[]> => {
    try {
      return await readdir(join(dataRoot, "projects", projectId, "assets", "sources"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const createProject = async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "台灣電動車市場", brief: { desiredSlideCount: 1 } }),
    });
    return (await response.json()) as PresentationProject;
  };

  const generateDeck = async (projectId: string) => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace: true }),
    });
    return {
      status: response.status,
      body: (await response.json()) as PresentationProject & { error?: string },
    };
  };

  it("階段 1 成功、階段 2 失敗時資產目錄被回收，不留孤兒", async (context) => {
    if (unavailable) return context.skip();
    // 正向對照：成功時抓下來的網頁確實在磁碟上留下一份來源資產目錄，否則下面「失敗後為空」
    // 證明不了任何事（可能根本沒寫過）。
    const ok = await createProject();
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "封面", sourceRefs: ["S1"] }])
        : draftReply([{ content: "第一頁", sourceRefs: ["S1"] }]),
    );
    silence("warn");
    const success = await generateDeck(ok.id);
    expect(success.status).toBe(200);
    expect(await listSourceAssets(ok.id)).toHaveLength(1);
    for (const undo of restore.splice(0)) undo();
    prompts.length = 0;

    // 失敗路徑：階段 1 通過（頁數合法），階段 2 才炸。舊的回滾測試用「回 4 頁」觸發失敗，
    // 那在兩階段之後**停在階段 1**——階段 2 之後才拋錯的那條回滾路徑從沒被走過。
    const failing = await createProject();
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ purpose: "封面", sourceRefs: ["S1"] }])
        : new Error("STAGE_TWO_GATEWAY_DOWN"),
    );
    silence("warn");
    silence("error");
    const failure = await generateDeck(failing.id);

    expect(failure.status).not.toBe(200);
    // 階段 1 真的跑完了，失敗確實發生在階段 2（不是在階段 1 就擋下來）。
    expect(prompts).toHaveLength(2);
    expect(await listSourceAssets(failing.id)).toEqual([]);
    // 回收只針對這次失敗的專案。
    expect(await listSourceAssets(ok.id)).toHaveLength(1);

    const after = await fetch(`${baseUrl}/api/projects/${failing.id}`);
    const project = (await after.json()) as PresentationProject;
    expect(project.sources).toEqual([]);
    expect(project.slides.every((slide: SlideSpec) => slide.content !== "第一頁")).toBe(true);
  });
});

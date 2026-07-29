import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  outlineContentCharBudget,
  type PresentationProject,
  type StructuredTextProvider,
  type StructuredTextRequest,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";

/** 預設風格是 high 密度；硬上限由 core 決定，測試不重寫一份數字。 */
const HARD_LIMIT = outlineContentCharBudget("high").hard;
/** 每個中文字算 1 單位，所以字數就是量測值。 */
const units = (count: number) => "台".repeat(count);

interface UntrustedPayload {
  currentSlide?: { content: string };
  previousAttempt?: unknown;
}

/** 取出 prompt 中 UNTRUSTED_INPUT 之後的資料段（模型實際看到的那一份）。 */
function untrustedPayload(prompt: string): UntrustedPayload {
  const marker = "\nUNTRUSTED_INPUT\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return JSON.parse(prompt.slice(index + marker.length)) as UntrustedPayload;
}

describe("大綱 content 超標的重試收斂與降級", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  const prompts: string[] = [];
  const restore: (() => void)[] = [];

  /** 每一輪的回覆由 attempt（第幾次呼叫）決定，用來模擬「模型一直寫太長」。 */
  const stubTextProvider = (reply: (attempt: number, prompt: string) => unknown) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        prompts.push(request.prompt);
        return reply(prompts.length, request.prompt);
      },
    } as StructuredTextProvider);
    restore.push(() => spy.mockRestore());
  };

  /** 攔下 logWarn 的輸出（同時讓測試輸出保持乾淨）；回傳的函式在請求結束後才解析。 */
  const captureWarnings = (): (() => Record<string, unknown>[]) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    restore.push(() => {
      spy.mockRestore();
    });
    return () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  beforeAll(async () => {
    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-outline-overflow-")), "data");
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

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`);
    return (await response.json()) as T;
  }

  /** 搜尋一律關掉：這裡驗的是長度收斂，不是來源流程。 */
  const createProject = async (desiredSlideCount = 2) => {
    const { body } = await post<PresentationProject>("/api/projects", {
      topic: "台灣電動車市場",
      brief: { desiredSlideCount, webSearchMode: "disabled" },
    });
    return body;
  };

  const regenerateSlide = (projectId: string, slideId: string) =>
    post<PresentationProject & { error?: string; message?: string }>(
      `/api/projects/${projectId}/slides/${slideId}/outline`,
      {},
    );

  const slideReply = (content: string) => ({
    content,
    narrative: "講者補充",
    layoutHint: "單欄重點",
    sourceIds: [],
  });

  /**
   * 同一份回覆同時滿足兩個階段：階段 1 只讀 purpose 與頁數，階段 2 只讀 content 與 refs。
   * 兩階段的 schema 都會忽略自己不認得的欄位，所以測試不必為兩次呼叫各準備一份。
   */
  const deckReply = (contents: string[]) => ({
    actualSlideCount: contents.length,
    rationale: "測試用",
    slides: contents.map((content, index) => ({
      purpose: `第 ${index + 1} 頁`,
      content,
      narrative: "講者補充",
      layoutHint: "單欄重點",
      sourceRefs: [],
      imageRefs: [],
      sourceUrls: [],
    })),
    sources: [],
  });

  /**
   * 整份大綱是兩次獨立的模型呼叫：第一次規劃（決定頁數與每頁的 purpose），之後才是寫作
   * 與長度重試。`round(1)` 同時當規劃那一輪的回覆，頁數才與第一輪草稿一致。
   */
  const stubDeck = (round: (attempt: number) => string[]) =>
    stubTextProvider((attempt) => deckReply(round(Math.max(1, attempt - 1))));

  /** 階段 2 第 n 輪的 prompt 在 prompts 裡的位置（0 是階段 1 的規劃）。 */
  const draftPrompt = (prompts: string[], round: number) => prompts[round]!;

  it("單頁重生三輪都超標時採用最短的那一版，而不是整個請求失敗", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    // 三輪都超過硬上限，中間那一輪最短。
    const lengths = [HARD_LIMIT + 120, HARD_LIMIT + 30, HARD_LIMIT + 70];
    stubTextProvider((attempt) => slideReply(units(lengths[attempt - 1] ?? HARD_LIMIT + 200)));
    const readWarnings = captureWarnings();

    const { status, body } = await regenerateSlide(project.id, slide.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(3);
    // 超標只代表版面較擠，不是資料錯誤：採用最短的那一版，別讓三次配額歸零。
    expect(body.slides.find((item) => item.id === slide.id)?.content).toBe(units(HARD_LIMIT + 30));

    const warnings = readWarnings();
    const overflow = warnings.filter((entry) => entry.event === "outline_content_overflow");
    expect(overflow).toHaveLength(3);
    expect(overflow[0]).toMatchObject({
      severity: "WARNING",
      projectId: project.id,
      slideId: slide.id,
      attempt: 1,
      measuredUnits: HARD_LIMIT + 120,
      hardLimit: HARD_LIMIT,
      density: "high",
    });
    const accepted = warnings.filter(
      (entry) => entry.event === "outline_content_overflow_accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ measuredUnits: HARD_LIMIT + 30, slideId: slide.id });
    // 只記 id 與數字：正文一個字都不能進 log。
    expect(JSON.stringify(warnings)).not.toContain("台台台");
  });

  it("重試的 prompt 帶著上一輪那份草稿，第一輪則完全沒有這個欄位", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    const firstDraft = `${units(HARD_LIMIT + 60)}第一輪草稿`;
    stubTextProvider((attempt) => slideReply(attempt === 1 ? firstDraft : units(10)));
    captureWarnings();

    const { status } = await regenerateSlide(project.id, slide.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(2);
    // 沒觸發重試的請求，prompt 要與加入這條路之前逐字元相同。
    expect(untrustedPayload(prompts[0]!).previousAttempt).toBeUndefined();
    expect(prompts[0]).not.toContain("previousAttempt");
    // 「至少砍掉 N 單位」必須有受詞：上一輪那份稿子本身要在 prompt 裡。
    // 指令說「keep its structure」，記錄結構的 narrative／layoutHint 也要跟著回去。
    expect(untrustedPayload(prompts[1]!).previousAttempt).toEqual({
      content: firstDraft,
      narrative: "講者補充",
      layoutHint: "單欄重點",
      measuredUnits: HARD_LIMIT + 60 + 5,
    });
    expect(prompts[1]).toContain("Revise that draft instead of starting over");
  });

  it("單頁重試餵回目前最短的那一份，而不是最近一輪", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    // 第二輪比第一輪更長：第三輪若拿最近一輪去砍，等於從更糟的版本起步。
    const drafts = [
      `${units(HARD_LIMIT + 30)}短`,
      `${units(HARD_LIMIT + 200)}長`,
      `${units(HARD_LIMIT + 300)}更長`,
    ];
    stubTextProvider((attempt) => slideReply(drafts[attempt - 1]!));
    captureWarnings();

    const { status, body } = await regenerateSlide(project.id, slide.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(3);
    expect(untrustedPayload(prompts[2]!).previousAttempt).toMatchObject({
      content: drafts[0],
      measuredUnits: HARD_LIMIT + 31,
    });
    // 降級採用的與餵回去的必須是同一份，否則最後一輪是在砍一份不會被採用的稿子。
    expect(body.slides.find((item) => item.id === slide.id)?.content).toBe(drafts[0]);
  });

  it("整份大綱重試時把整份草稿依原順序餵回去，逐頁標記是否超標", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const overflowPage = `${units(HARD_LIMIT + 40)}超標頁`;
    const shortPage = "沒有超標的第一頁";
    stubDeck((round) => (round === 1 ? [shortPage, overflowPage] : [shortPage, "改短後的第二頁"]));
    captureWarnings();

    const { status } = await post<PresentationProject>(`/api/projects/${project.id}/outline`, {
      replace: true,
    });

    expect(status).toBe(200);
    // 1 次規劃 + 2 次寫作。
    expect(prompts).toHaveLength(3);
    expect(untrustedPayload(draftPrompt(prompts, 1)).previousAttempt).toBeUndefined();
    // 指令行也不得洩漏這個欄位：第一輪的 prompt 要與加入這條路之前逐字元相同。
    expect(draftPrompt(prompts, 1)).not.toContain("previousAttempt");
    // 規劃那一輪與長度重試無關，一個字都不該提到它。
    expect(prompts[0]).not.toContain("previousAttempt");
    // 單次無狀態呼叫看不到「上次那份」：沒超標的頁也必須在 prompt 裡，「其餘頁原樣回傳」
    // 才有受詞。順序由陣列承載，不再用 order 指認頁面。
    expect(untrustedPayload(draftPrompt(prompts, 2)).previousAttempt).toEqual([
      {
        // purpose 由階段 1 定下，階段 2 不回傳它——但重試指令說「保留這一頁的結構」，
        // 沒有它那句話就沒有受詞。
        planRef: "P1",
        purpose: "第 1 頁",
        content: shortPage,
        narrative: "講者補充",
        layoutHint: "單欄重點",
        sourceRefs: [],
        imageRefs: [],
        sourceUrls: [],
        overflow: false,
      },
      {
        planRef: "P2",
        purpose: "第 2 頁",
        content: overflowPage,
        narrative: "講者補充",
        layoutHint: "單欄重點",
        sourceRefs: [],
        imageRefs: [],
        sourceUrls: [],
        overflow: true,
        measuredUnits: HARD_LIMIT + 43,
        cutUnits: 43,
      },
    ]);
    expect(draftPrompt(prompts, 2)).toContain(
      'Reproduce every entry marked "overflow": false exactly as',
    );
    expect(JSON.stringify(untrustedPayload(draftPrompt(prompts, 2)).previousAttempt)).not.toContain(
      '"order"',
    );
  });

  it("整份大綱多頁同時超標時，每一頁拿到的是自己的砍字數", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    // +5 的頁被要求砍 100 正是 outlineDataFidelityInstruction 要防的過度刪減。
    const barelyOver = units(HARD_LIMIT + 5);
    const wayOver = units(HARD_LIMIT + 100);
    stubDeck((round) => (round === 1 ? [barelyOver, wayOver] : [units(10), units(11)]));
    captureWarnings();

    const { status } = await post<PresentationProject>(`/api/projects/${project.id}/outline`, {
      replace: true,
    });

    expect(status).toBe(200);
    const fedBack = untrustedPayload(draftPrompt(prompts, 2)).previousAttempt as {
      measuredUnits?: number;
      cutUnits?: number;
    }[];
    expect(fedBack.map((entry) => entry.cutUnits)).toEqual([5, 100]);
    expect(fedBack.map((entry) => entry.measuredUnits)).toEqual([HARD_LIMIT + 5, HARD_LIMIT + 100]);
    // 單一數字若編進指令句子，兩頁就會共用最長那頁的超額。
    expect(draftPrompt(prompts, 2)).not.toContain("Cut at least 100 units");
  });

  it("整份大綱挑最短時比的是所有超標頁的超額總和，不是單一最長頁", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(3);
    // 第一輪：一頁超 +100，總超額 100。第二輪：三頁各超 +95，最長頁較短但整體更糟。
    stubDeck((round) =>
      round === 1
        ? [units(HARD_LIMIT + 100), units(10), units(11)]
        : [units(HARD_LIMIT + 95), units(HARD_LIMIT + 95), units(HARD_LIMIT + 95)],
    );
    const readWarnings = captureWarnings();

    const { status, body } = await post<PresentationProject>(
      `/api/projects/${project.id}/outline`,
      { replace: true },
    );

    expect(status).toBe(200);
    expect(body.slides.map((item) => item.content)).toEqual([
      units(HARD_LIMIT + 100),
      units(10),
      units(11),
    ]);
    const accepted = readWarnings().filter(
      (entry) => entry.event === "outline_content_overflow_accepted",
    );
    expect(accepted[0]).toMatchObject({
      longestMeasuredUnits: HARD_LIMIT + 100,
      totalExcessUnits: 100,
    });
  });

  it("最短的那一版剛好落在 hard 的兩倍以內時照樣採用", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    const atCeiling = units(HARD_LIMIT * 2);
    stubTextProvider(() => slideReply(atCeiling));
    const readWarnings = captureWarnings();

    const { status, body } = await regenerateSlide(project.id, slide.id);

    expect(status).toBe(200);
    expect(body.slides.find((item) => item.id === slide.id)?.content).toBe(atCeiling);
    const warnings = readWarnings();
    expect(
      warnings.filter((entry) => entry.event === "outline_content_overflow_accepted"),
    ).toHaveLength(1);
    expect(
      warnings.filter((entry) => entry.event === "outline_content_overflow_rejected"),
    ).toHaveLength(0);
  });

  it("最短的那一版超過 hard 的兩倍時單頁重生失敗，不落地讀不了的長度", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    const original = slide.content;
    stubTextProvider(() => slideReply(units(HARD_LIMIT * 2 + 1)));
    const readWarnings = captureWarnings();

    const { status, body } = await regenerateSlide(project.id, slide.id);

    expect(status).toBe(400);
    expect(body.error).toBe("CODEX_OUTLINE_CONTENT_UNREADABLE");
    // 這是使用者唯一還會看到的長度失敗：裸碼在編輯器裡等於叫人再按一次，而再按一次
    // 通常是同樣結果。訊息必須翻譯過並指出可行的下一步（降密度／拆頁）。
    expect(body.message).toMatch(/密度|拆成兩頁/);
    expect(prompts).toHaveLength(3);
    expect(
      readWarnings().filter((entry) => entry.event === "outline_content_overflow_rejected"),
    ).toHaveLength(1);
    // 失敗的重生不得留下任何痕跡：那一頁維持原本的內容。
    const after = await get<PresentationProject>(`/api/projects/${project.id}`);
    expect(after.slides.find((item) => item.id === slide.id)?.content).toBe(original);
  });

  it("整份大綱最短的那一版超過 hard 的兩倍時整批失敗", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    stubDeck(() => [units(HARD_LIMIT * 2 + 1), units(10)]);
    const readWarnings = captureWarnings();

    const { status, body } = await post<PresentationProject & { error?: string }>(
      `/api/projects/${project.id}/outline`,
      { replace: true },
    );

    expect(status).toBe(400);
    expect(body.error).toBe("CODEX_OUTLINE_CONTENT_UNREADABLE");
    // 1 次規劃 + 3 輪寫作。
    expect(prompts).toHaveLength(4);
    const rejected = readWarnings().filter(
      (entry) => entry.event === "outline_content_overflow_rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      longestMeasuredUnits: HARD_LIMIT * 2 + 1,
      acceptCeiling: HARD_LIMIT * 2,
    });
  });
});

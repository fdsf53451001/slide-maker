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

/**
 * outline-overflow.test.ts 的補充：那一份釘住了「單頁三輪都超標」「重試帶草稿」「整份只帶
 * 超標頁」三條。這裡補的是同一段程式碼裡沒被覆蓋、而且錯了會靜默的情境：
 *
 * - 整份大綱三輪都超標的降級路徑（單頁那條有測，整份那條完全沒有）
 * - 多頁同時超標時逐頁的砍字數
 * - 重試之間頁數改變時 previousAttempt 是否依當輪重算（不是沿用上上輪那份大綱）
 * - 第一輪就通過時完全不碰新程式碼路徑
 * - 某一輪 schema parse 拋錯時，不得默默採用上一輪的超標草稿
 */
const HARD_LIMIT = outlineContentCharBudget("high").hard;
/** 每個中文字算 1 單位，所以字數就是量測值。 */
const units = (count: number) => "台".repeat(count);

interface UntrustedPayload {
  previousAttempt?: unknown;
}

function untrustedPayload(prompt: string): UntrustedPayload {
  const marker = "\nUNTRUSTED_INPUT\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return JSON.parse(prompt.slice(index + marker.length)) as UntrustedPayload;
}

describe("大綱超標收斂的補充情境", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  const prompts: string[] = [];
  const restore: (() => void)[] = [];

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

  const captureWarnings = (): (() => Record<string, unknown>[]) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    restore.push(() => {
      spy.mockRestore();
    });
    return () =>
      lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { raw: line } as Record<string, unknown>;
          }
        })
        .filter((entry) => !("raw" in entry));
  };

  beforeAll(async () => {
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-outline-overflow-qa-")),
      "data",
    );
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

  const createProject = async (desiredSlideCount = 2) => {
    const { body } = await post<PresentationProject>("/api/projects", {
      topic: "台灣電動車市場",
      brief: { desiredSlideCount, webSearchMode: "disabled" },
    });
    return body;
  };

  const regenerateSlide = (projectId: string, slideId: string) =>
    post<PresentationProject & { error?: string }>(
      `/api/projects/${projectId}/slides/${slideId}/outline`,
      {},
    );

  const generateDeck = (projectId: string) =>
    post<PresentationProject & { error?: string }>(`/api/projects/${projectId}/outline`, {
      replace: true,
    });

  const slideReply = (content: string) => ({
    content,
    narrative: "講者補充",
    layoutHint: "單欄重點",
    sourceIds: [],
  });

  const deckReply = (contents: string[]) => ({
    actualSlideCount: contents.length,
    rationale: "測試用",
    slides: contents.map((content, index) => ({
      purpose: `第 ${index + 1} 頁`,
      content,
      narrative: "講者補充",
      layoutHint: "單欄重點",
      sourceUrls: [],
    })),
    sources: [],
  });

  /** 重試指令與 previousAttempt 欄位的字面痕跡；第一輪的 prompt 一個都不該有。 */
  const RETRY_MARKERS = ["previousAttempt", "A previous attempt ran too long"];

  it("單頁第一輪就通過時只呼叫一次，prompt 完全沒有新路徑的痕跡", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    stubTextProvider(() => slideReply(units(HARD_LIMIT - 50)));
    const readWarnings = captureWarnings();

    const { status, body } = await regenerateSlide(project.id, slide.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(1);
    for (const marker of RETRY_MARKERS) expect(prompts[0]).not.toContain(marker);
    expect(body.slides.find((item) => item.id === slide.id)?.content).toBe(units(HARD_LIMIT - 50));
    // 沒有超標就不該有任何超標 log。
    expect(
      readWarnings().filter((entry) => String(entry.event).startsWith("outline_content_overflow")),
    ).toHaveLength(0);
  });

  it("整份大綱第一輪就通過時只呼叫一次，prompt 完全沒有新路徑的痕跡", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    stubTextProvider(() => deckReply([units(80), units(90)]));
    const readWarnings = captureWarnings();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(1);
    for (const marker of RETRY_MARKERS) expect(prompts[0]).not.toContain(marker);
    expect(body.slides.map((item) => item.content)).toEqual([units(80), units(90)]);
    expect(
      readWarnings().filter((entry) => String(entry.event).startsWith("outline_content_overflow")),
    ).toHaveLength(0);
  });

  it("整份大綱三輪都超標時採用最短的那一版，而不是整批失敗", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    // 每一輪的「最長頁」分別是 +150 / +40 / +90；第二輪最短，應該被採用。
    const rounds = [
      [units(HARD_LIMIT + 150), units(20)],
      [units(HARD_LIMIT + 40), units(30)],
      [units(HARD_LIMIT + 90), units(40)],
    ];
    stubTextProvider((attempt) => deckReply(rounds[attempt - 1] ?? rounds[2]!));
    const readWarnings = captureWarnings();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(3);
    expect(body.slides.map((item) => item.content)).toEqual([units(HARD_LIMIT + 40), units(30)]);

    const warnings = readWarnings();
    expect(warnings.filter((entry) => entry.event === "outline_content_overflow")).toHaveLength(3);
    const accepted = warnings.filter(
      (entry) => entry.event === "outline_content_overflow_accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      projectId: project.id,
      attempts: 3,
      // 整份大綱的欄位是「最長的那一頁」，與單頁路徑的 measuredUnits 刻意不同名。
      longestMeasuredUnits: HARD_LIMIT + 40,
      hardLimit: HARD_LIMIT,
      density: "high",
    });
    expect(accepted[0]!.measuredUnits).toBeUndefined();
    // 整份大綱是專案級的，log 不該冒出 slideId，更不該冒出正文或 purpose。
    expect(accepted[0]!.slideId).toBeUndefined();
    const dumped = JSON.stringify(warnings);
    expect(dumped).not.toContain("台台台");
    expect(dumped).not.toContain("第 1 頁");
  });

  it("整份大綱多頁同時超標時全部餵回，log 逐頁記下 order", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const first = `${units(HARD_LIMIT + 20)}甲`;
    const third = `${units(HARD_LIMIT + 70)}乙`;
    stubTextProvider((attempt) =>
      attempt === 1
        ? deckReply([first, units(10), third])
        : deckReply([units(11), units(12), units(13)]),
    );
    const readWarnings = captureWarnings();

    const { status } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(2);
    // 整份都餵回去（含沒超標的第 2 頁），超標與否逐頁標記，數字逐頁各自帶。
    expect(untrustedPayload(prompts[1]!).previousAttempt).toEqual([
      {
        purpose: "第 1 頁",
        content: first,
        narrative: "講者補充",
        layoutHint: "單欄重點",
        sourceUrls: [],
        overflow: true,
        measuredUnits: HARD_LIMIT + 21,
        cutUnits: 21,
      },
      {
        purpose: "第 2 頁",
        content: units(10),
        narrative: "講者補充",
        layoutHint: "單欄重點",
        sourceUrls: [],
        overflow: false,
      },
      {
        purpose: "第 3 頁",
        content: third,
        narrative: "講者補充",
        layoutHint: "單欄重點",
        sourceUrls: [],
        overflow: true,
        measuredUnits: HARD_LIMIT + 71,
        cutUnits: 71,
      },
    ]);
    // 最長那頁的超額不得被編進指令句子：那會讓只超 21 的頁也被要求砍 71。
    expect(prompts[1]).not.toContain(`measured ${HARD_LIMIT + 71} full-width units`);
    expect(prompts[1]).not.toContain(`Cut at least 71 units`);

    const overflow = readWarnings().filter((entry) => entry.event === "outline_content_overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({
      attempt: 1,
      longestMeasuredUnits: HARD_LIMIT + 71,
      totalExcessUnits: 92,
      overflowSlideOrders: [0, 2],
      slideCount: 3,
    });
  });

  it("重試之間頁數改變時 previousAttempt 依當輪重算，不會沿用上一輪那份大綱", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const firstRoundOverflow = `${units(HARD_LIMIT + 25)}甲`;
    const secondRoundOverflow = `${units(HARD_LIMIT + 15)}乙`;
    stubTextProvider((attempt) => {
      // 頁數在 min..max 之間可以改變（desired=2 → 1..4），第二輪回 3 頁且換成第 0 頁超標。
      if (attempt === 1) return deckReply([units(10), firstRoundOverflow]);
      if (attempt === 2) return deckReply([secondRoundOverflow, units(11), units(12)]);
      return deckReply([units(13), units(14)]);
    });
    captureWarnings();

    const { status } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(3);
    const entry = (
      purpose: string,
      content: string,
      overflow?: { measuredUnits: number; cutUnits: number },
    ) => ({
      purpose,
      content,
      narrative: "講者補充",
      layoutHint: "單欄重點",
      sourceUrls: [],
      overflow: !!overflow,
      ...(overflow ?? {}),
    });
    expect(untrustedPayload(prompts[1]!).previousAttempt).toEqual([
      entry("第 1 頁", units(10)),
      entry("第 2 頁", firstRoundOverflow, { measuredUnits: HARD_LIMIT + 26, cutUnits: 26 }),
    ]);
    // 第三輪帶的是第二輪那份三頁大綱：累積或沿用上一輪的陣列都會讓模型改錯頁。
    expect(untrustedPayload(prompts[2]!).previousAttempt).toEqual([
      entry("第 1 頁", secondRoundOverflow, { measuredUnits: HARD_LIMIT + 16, cutUnits: 16 }),
      entry("第 2 頁", units(11)),
      entry("第 3 頁", units(12)),
    ]);
  });

  it("單頁重生的某一輪回覆不合 schema 時整個請求失敗，不會默默落地上一輪的超標草稿", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    const before = project.slides.find((item) => item.id === slide.id)!.content;
    stubTextProvider((attempt) =>
      attempt === 1 ? slideReply(units(HARD_LIMIT + 60)) : { narrative: "缺了 content" },
    );
    captureWarnings();

    const { status, body } = await regenerateSlide(project.id, slide.id);

    expect(status).not.toBe(200);
    expect(body.error).toBe("INVALID_REQUEST");
    expect(prompts).toHaveLength(2);
    const after = await get<PresentationProject>(`/api/projects/${project.id}`);
    expect(after.slides.find((item) => item.id === slide.id)?.content).toBe(before);
  });

  it("整份大綱的某一輪回覆不合 schema 時整批失敗，不會落地上一輪的超標草稿", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const before = project.slides.map((item) => item.content);
    stubTextProvider((attempt) =>
      attempt === 1 ? deckReply([units(HARD_LIMIT + 60), units(10)]) : { rationale: "缺了 slides" },
    );
    captureWarnings();

    const { status } = await generateDeck(project.id);

    expect(status).not.toBe(200);
    expect(prompts).toHaveLength(2);
    const after = await get<PresentationProject>(`/api/projects/${project.id}`);
    expect(after.slides.map((item) => item.content)).toEqual(before);
  });
});

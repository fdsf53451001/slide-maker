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

  /** 搜尋一律關掉：這裡驗的是長度收斂，不是來源流程。 */
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
    expect(untrustedPayload(prompts[1]!).previousAttempt).toEqual({
      content: firstDraft,
      measuredUnits: HARD_LIMIT + 60 + 5,
    });
    expect(prompts[1]).toContain("Revise that draft instead of starting over");
  });

  it("整份大綱重試時只把超標的那一頁餵回去", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const overflowPage = `${units(HARD_LIMIT + 40)}超標頁`;
    const shortPage = "沒有超標的第一頁";
    stubTextProvider((attempt) =>
      deckReply(attempt === 1 ? [shortPage, overflowPage] : [shortPage, "改短後的第二頁"]),
    );
    captureWarnings();

    const { status } = await post<PresentationProject>(`/api/projects/${project.id}/outline`, {
      replace: true,
    });

    expect(status).toBe(200);
    expect(prompts).toHaveLength(2);
    expect(untrustedPayload(prompts[0]!).previousAttempt).toBeUndefined();
    // 整份草稿塞回去會讓 prompt 爆量；沒超標的頁本來就沒有要改。
    expect(untrustedPayload(prompts[1]!).previousAttempt).toEqual([
      {
        order: 1,
        purpose: "第 2 頁",
        content: overflowPage,
        measuredUnits: HARD_LIMIT + 40 + 3,
      },
    ]);
    expect(prompts[1]).toContain("previousAttempt lists only the slides that ran too long");
  });
});

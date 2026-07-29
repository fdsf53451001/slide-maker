import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  outlineContentCharBudget,
  type PresentationProject,
  type ProviderUsage,
  type StructuredTextProvider,
  type StructuredTextRequest,
} from "@slide-maker/core";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import type { UsageLedger, UsageSummary } from "../src/usage-ledger.js";

const HARD_LIMIT = outlineContentCharBudget("high").hard;
const units = (count: number) => "台".repeat(count);

/**
 * 端對端釘住兩件事：
 *  ① 重試迴圈**每一輪各記一筆**（帶遞增的 attempt）。這是整個功能最有價值的部分——
 *    使用者現在完全看不見大綱到底重跑了幾次，只記最後一輪會把成本低估到三分之一。
 *  ② `GET /api/projects/:id/usage` 在伺服器端聚合完成才回，且未回報的呼叫不當 0 加總。
 */
describe("模型用量帳本與 API", () => {
  let app: Express | undefined;
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  const prompts: string[] = [];
  const restore: (() => void)[] = [];

  /** 每一輪的回覆與用量都由 attempt 決定。 */
  const stubTextProvider = (
    reply: (attempt: number) => { value: unknown; usage?: ProviderUsage },
  ) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        prompts.push(request.prompt);
        return reply(prompts.length);
      },
    } as StructuredTextProvider);
    restore.push(() => spy.mockRestore());
  };

  beforeAll(async () => {
    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-usage-api-")), "data");
    app = await createApp(dataRoot);
    try {
      await new Promise<void>((resolve, reject) => {
        server = app!.listen(0, "127.0.0.1", (error?: Error) =>
          error ? reject(error) : resolve(),
        );
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

  const ledger = () => app!.locals.usageLedger as UsageLedger;

  async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  const createProject = async () => {
    const { body } = await post<PresentationProject>("/api/projects", {
      topic: "台灣電動車市場",
      brief: { desiredSlideCount: 2, webSearchMode: "disabled" },
    });
    return body;
  };

  const slideReply = (content: string) => ({
    content,
    narrative: "講者補充",
    layoutHint: "單欄重點",
    sourceIds: [],
  });

  /** 讀回專案帳本的原始行（順序即寫入順序）。 */
  const ledgerLines = async (projectId: string): Promise<Record<string, unknown>[]> => {
    await ledger().idle();
    const content = await readFile(ledger().projectLedgerPath(projectId), "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const usageSummary = async (projectId: string): Promise<UsageSummary> => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/usage`);
    expect(response.status).toBe(200);
    return (await response.json()) as UsageSummary;
  };

  it("單頁重生三輪都超標時，帳本有三筆且 attempt 遞增", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    // 三輪都超過硬上限 → 迴圈跑滿；每輪回報不同的用量，才驗得出「不是同一筆被記三次」。
    stubTextProvider((attempt) => ({
      value: slideReply(units(HARD_LIMIT + 100 - attempt)),
      usage: { inputTokens: 1_000 * attempt, outputTokens: 10 * attempt, reported: true },
    }));

    const { status } = await post(`/api/projects/${project.id}/slides/${slide.id}/outline`, {});
    expect(status).toBe(200);
    expect(prompts).toHaveLength(3);

    const regenerated = (await ledgerLines(project.id)).filter(
      (line) => line.operation === "outline-regenerate",
    );
    expect(regenerated).toHaveLength(3);
    expect(regenerated.map((line) => line.attempt)).toEqual([1, 2, 3]);
    expect(regenerated.every((line) => line.ok === true)).toBe(true);
    expect(regenerated.every((line) => line.slideId === slide.id)).toBe(true);
    expect(regenerated.map((line) => (line.usage as ProviderUsage).inputTokens)).toEqual([
      1_000, 2_000, 3_000,
    ]);

    // 聚合起來就是三輪的總和——而使用者原本以為自己只花了一次。
    const summary = await usageSummary(project.id);
    expect(summary.byOperation["outline-regenerate"]).toMatchObject({
      calls: 3,
      reportedCalls: 3,
      inputTokens: 6_000,
      outputTokens: 60,
    });
  }, 60_000);

  it("失敗的那一輪也記（ok:false）——失敗一樣燒配額", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    stubTextProvider(() => {
      throw new Error("HTTP 503 from gateway");
    });

    await post(`/api/projects/${project.id}/slides/${slide.id}/outline`, {});

    const failed = (await ledgerLines(project.id)).filter((line) => line.ok === false);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]).toMatchObject({ operation: "outline-regenerate", attempt: 1 });
    // 拿不到 usage 就落成 reported:false，而不是 0。
    expect(failed[0]!.usage).toEqual({ reported: false });
    const summary = await usageSummary(project.id);
    expect(summary.failedCalls).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("provider 沒回報用量時：計入 calls，但一個 token 都不加，且未回報數看得見", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    // 第一輪就過關，且回應完全沒有 usage 欄位（Codex CLI 與不回報的 gateway 就是這樣）。
    stubTextProvider(() => ({ value: slideReply(units(10)) }));

    const { status } = await post(`/api/projects/${project.id}/slides/${slide.id}/outline`, {});
    expect(status).toBe(200);

    const summary = await usageSummary(project.id);
    expect(summary.totalCalls).toBe(1);
    expect(summary.reportedCalls).toBe(0);
    expect(summary.unreportedCalls).toBe(1);
    expect(summary.totals.inputTokens).toBe(0);
    expect(summary.totals.outputTokens).toBe(0);
    expect(summary.byOperation["outline-regenerate"]).toMatchObject({
      calls: 1,
      reportedCalls: 0,
      inputTokens: 0,
    });
  }, 60_000);

  it("帳本一個字正文都沒有：prompt 與投影片內容都不得出現在檔案裡", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    const SECRET = "第三季營收成長四十二個百分點，僅限內部";
    stubTextProvider(() => ({
      value: slideReply(SECRET),
      usage: { inputTokens: 5, outputTokens: 6, reported: true },
    }));

    await post(`/api/projects/${project.id}/slides/${slide.id}/outline`, {});
    await ledger().idle();
    const serialized = await readFile(ledger().projectLedgerPath(project.id), "utf8");

    expect(serialized).not.toContain(SECRET);
    // prompt 的骨架也不得洩漏（那份 payload 帶著整包來源節錄）。
    expect(serialized).not.toContain("UNTRUSTED_INPUT");
    expect(serialized).not.toContain("台灣電動車市場");
    // 該留的還在：操作、模型 id、數字。
    expect(serialized).toContain("outline-regenerate");
    expect(serialized).toContain("stub-text");
  }, 60_000);

  /**
   * 影像那條走 `JobRunner`，與文字四條完全不同的接線。mock provider 不呼叫任何模型、
   * 自然不回報用量——所以這裡驗的是「呼叫次數有被記下來」與「未回報不被當成 0」，
   * 那正是「這條通道到底跑了幾次」在 UI 上唯一問得出來的東西。
   */
  it("影像 job 記在 capability:image／operation:generate，未回報用量落成 reported:false", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const { status, body: queued } = await post<{ id: string }[]>(
      `/api/projects/${project.id}/generate`,
      { providerId: "mock-image" },
    );
    expect(status).toBe(202);
    expect(queued.length).toBeGreaterThan(0);
    const deadline = Date.now() + 10_000;
    let done = false;
    do {
      const current = (await (
        await fetch(`${baseUrl}/api/projects/${project.id}`)
      ).json()) as PresentationProject;
      done = current.jobs
        .filter((job) => queued.some((item) => item.id === job.id))
        .every((job) => job.status === "completed" || job.status === "failed");
      if (!done) await new Promise((resolve) => setTimeout(resolve, 20));
    } while (!done && Date.now() < deadline);
    expect(done).toBe(true);

    const images = (await ledgerLines(project.id)).filter((line) => line.capability === "image");
    expect(images).toHaveLength(queued.length);
    expect(images.every((line) => line.operation === "generate")).toBe(true);
    expect(images.every((line) => typeof line.slideId === "string")).toBe(true);
    expect(images.every((line) => line.modelEntryId === "mock-image")).toBe(true);
    expect(images[0]!.usage).toEqual({ reported: false });

    const summary = await usageSummary(project.id);
    expect(summary.byCapability.image).toMatchObject({
      calls: queued.length,
      reportedCalls: 0,
      inputTokens: 0,
    });
    expect(summary.unreportedCalls).toBeGreaterThanOrEqual(queued.length);
  }, 60_000);

  it("GET /usage 對不存在的專案回 404，對沒有帳本的專案回全零", async (context) => {
    if (bindUnavailable) return context.skip();
    expect((await fetch(`${baseUrl}/api/projects/does-not-exist/usage`)).status).toBe(404);
    const project = await createProject();
    const summary = await usageSummary(project.id);
    expect(summary).toMatchObject({
      totalCalls: 0,
      reportedCalls: 0,
      unreportedCalls: 0,
      byModel: [],
    });
  }, 60_000);
});

import { mkdtemp, readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import type { UsageLedger, UsageSummary } from "../src/usage-ledger.js";

/**
 * `GET /api/projects/:id/usage` 的**線上形狀**，以及未回報數的加總不變量。
 *
 * 為什麼要有這一份（而不是靠既有的 usage-api 系列）：
 *
 * ① **前端的形狀檢查會誤判的話，代價是使用者直接看到的迴歸。** `UsagePanel.tsx` 的
 *    `isUsageSummary()` 認不得回應時整個 USAGE 區塊變成一行錯誤字。`apps/editor` 不相依
 *    `apps/server`（也不該相依），所以兩邊只能靠「線上形狀」對齊——這一份就是那條縫的
 *    伺服器側守衛：把前端**實際要求的那些 key 與型別**逐條列出來斷言。少一格、改成 null、
 *    或漏掉某個分組桶的欄位，這裡就會紅，而不是等使用者看到錯誤字。
 *    對應的前端測試（`UsagePanel.test.tsx` 的「伺服器實際回應的形狀」）餵的是同一份 payload。
 *
 * ② **端到端一整條**：假 gateway（零配額，本地 http server）→ 真的
 *    `OpenAiStructuredTextProvider` 解析 usage → 帳本落地 → `GET /usage` 聚合。
 *    既有測試多半在 `resolveTextProvider` 打樁，那條路驗不到 wire 上的 `usage` 欄位。
 *
 * ③ **加總不變量用真實混合資料驗**：有回報、未回報、本機（mock 影像）、失敗四種都真的
 *    跑過端點產生出來，而不是手寫 record 陣列——`unreportedCalls` 這一格是最後一個 commit
 *    才加到分組桶上的，「頂層＝各分組相加」是它唯一可驗證的性質。
 */
describe("用量統計的線上形狀與加總不變量", () => {
  let appServer: Server | undefined;
  let gateway: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  /** 假 gateway 這一輪要怎麼回：帶用量／完全不回報用量／整個失敗。 */
  let mode: "reported" | "silent" | "fail" = "reported";

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    gateway = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if ((request.url ?? "").endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          return response.end(JSON.stringify({ data: [] }));
        }
        if (mode === "fail") {
          response.writeHead(500, { "content-type": "application/json" });
          return response.end(JSON.stringify({ error: "gateway exploded" }));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    content: "重寫過的短內容",
                    narrative: "講者補充",
                    layoutHint: "單欄重點",
                    sourceIds: [],
                  }),
                },
              },
            ],
            // `silent` 是「gateway 一個數字都不回報」——Codex CLI 與部分 translator 的實況。
            ...(mode === "reported"
              ? {
                  usage: {
                    prompt_tokens: 1_234,
                    completion_tokens: 56,
                    total_tokens: 1_290,
                    prompt_tokens_details: { cached_tokens: 7 },
                    completion_tokens_details: { reasoning_tokens: 9 },
                  },
                }
              : {}),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
    setEnv(
      "SLIDE_MAKER_OPENAI_BASE_URL",
      `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`,
    );
    setEnv("SLIDE_MAKER_OPENAI_API_KEY", "test-key");
    setEnv("SLIDE_MAKER_OPENAI_TEXT_MODEL", "gpt-5-fake");
    setEnv("SLIDE_MAKER_TEXT_ENGINE", "openai");

    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-usage-wire-")), "data");
    app = await createApp(dataRoot);
    try {
      await new Promise<void>((resolve, reject) => {
        appServer = app!.listen(0, "127.0.0.1", (error?: Error) =>
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
    if (appServer?.listening)
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    if (gateway?.listening) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

  const createProject = async (): Promise<PresentationProject> =>
    (
      await post<PresentationProject>("/api/projects", {
        topic: "用量線上形狀",
        brief: { desiredSlideCount: 2, webSearchMode: "disabled" },
      })
    ).body;

  const rawUsage = async (projectId: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/usage`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  const ledgerLines = async (projectId: string): Promise<Record<string, unknown>[]> => {
    await ledger().idle();
    const content = await readFile(ledger().projectLedgerPath(projectId), "utf8").catch(() => "");
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  /** 等所有排入的影像 job 收工（mock provider 很快，但仍是非同步）。 */
  const waitForJobs = async (projectId: string, ids: string[]): Promise<void> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = (await (
        await fetch(`${baseUrl}/api/projects/${projectId}`)
      ).json()) as PresentationProject;
      const watched = current.jobs.filter((job) => ids.includes(job.id));
      if (
        watched.length === ids.length &&
        watched.every((job) => ["completed", "failed", "cancelled"].includes(job.status))
      )
        return;
      if (Date.now() > deadline) throw new Error("影像 job 沒有在時限內收工");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // ── 前端 `isUsageSummary()` 逐字要求的東西（`apps/editor/src/UsagePanel.tsx`）──────
  // **改動這三份清單前先改前端那一份**，反之亦然：這是唯一把兩邊綁在一起的東西。
  const EDITOR_SUMMARY_COUNT_KEYS = [
    "totalCalls",
    "totalRequests",
    "reportedCalls",
    "unreportedCalls",
    "localCalls",
    "failedCalls",
    "malformedLines",
    "droppedRecords",
  ] as const;
  const EDITOR_SUMMARY_BOOLEAN_KEYS = ["truncated", "unreadable"] as const;
  const EDITOR_BUCKET_KEYS = [
    "calls",
    "requests",
    "reportedCalls",
    "unreportedCalls",
    "localCalls",
    "failedCalls",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cachedTokens",
    "imageTokens",
    "totalTokens",
  ] as const;

  /** 前端會拿去顯示的每一格都必須是**有限的數字**（`Infinity`／`NaN` 會被 JSON 變成 null）。 */
  function expectBucketShape(bucket: unknown, where: string): void {
    expect(typeof bucket, where).toBe("object");
    expect(bucket, where).not.toBeNull();
    const record = bucket as Record<string, unknown>;
    for (const key of EDITOR_BUCKET_KEYS) {
      expect(typeof record[key], `${where}.${key}`).toBe("number");
      expect(Number.isFinite(record[key] as number), `${where}.${key} 必須是有限數字`).toBe(true);
    }
  }

  it("假 gateway 的一次真呼叫：帳本落地、GET /usage 的每一格都是前端認得的形狀", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    const slide = project.slides[0]!;
    mode = "reported";

    const { status } = await post(`/api/projects/${project.id}/slides/${slide.id}/outline`, {});
    expect(status).toBe(200);
    await ledger().idle();

    // 帳本真的落地了，而且 wire 上的用量一路被解析進來（1234/56/1290 是 gateway 給的）。
    const lines = await ledgerLines(project.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ capability: "text", operation: "outline-regenerate" });
    expect(lines[0]!.usage).toMatchObject({
      reported: true,
      inputTokens: 1_234,
      outputTokens: 56,
      totalTokens: 1_290,
    });

    const wire = await rawUsage(project.id);
    for (const key of EDITOR_SUMMARY_COUNT_KEYS) {
      expect(typeof wire[key], key).toBe("number");
      expect(Number.isFinite(wire[key] as number), `${key} 必須是有限數字`).toBe(true);
    }
    for (const key of EDITOR_SUMMARY_BOOLEAN_KEYS) expect(typeof wire[key], key).toBe("boolean");
    expectBucketShape(wire.totals, "totals");
    for (const [key, bucket] of Object.entries(wire.byCapability as Record<string, unknown>))
      expectBucketShape(bucket, `byCapability.${key}`);
    for (const [key, bucket] of Object.entries(wire.byOperation as Record<string, unknown>))
      expectBucketShape(bucket, `byOperation.${key}`);
    expect(Array.isArray(wire.byModel)).toBe(true);
    for (const [index, bucket] of (wire.byModel as unknown[]).entries()) {
      expectBucketShape(bucket, `byModel[${index}]`);
      const model = bucket as Record<string, unknown>;
      // 前端的 `modelName()` 對這三格做 `||` 判斷，null 會讓它顯示 "null"。
      for (const key of ["modelEntryId", "model", "providerKind"])
        expect(typeof model[key], `byModel[${index}].${key}`).toBe("string");
    }
    // optional 欄位（cost／firstAt／lastAt）**必須是「缺席」而不是 null**：前端只檢查必填
    // 欄位，null 會安靜地流到顯示層（`formatMoment(null)` 會變成 "Invalid Date" 那一類）。
    expect(JSON.stringify(wire)).not.toContain("null");
    expect(typeof wire.firstAt).toBe("string");
    expect(typeof wire.lastAt).toBe("string");
    expect("cost" in wire).toBe(false);

    // 這一格是回報路徑的產物，順手釘住它真的被算進去了（不然上面全是 0 也會通過）。
    expect(wire.totalCalls).toBe(1);
    expect((wire.totals as Record<string, number>).totalTokens).toBe(1_290);
    expect((wire.totals as Record<string, number>).cachedTokens).toBe(7);
    expect((wire.totals as Record<string, number>).reasoningTokens).toBe(9);
  }, 60_000);

  /**
   * 空帳本（新專案，一次都還沒呼叫）也要是前端認得的形狀。
   *
   * 這是最容易被形狀檢查誤判的一份回應：所有數字都是 0、`byModel` 是空陣列、三個 optional
   * 欄位全部缺席。誤判的話，剛建好專案的人第一次點開「專案」分頁看到的就是一行錯誤字。
   */
  it("空帳本的回應照樣有全部欄位（全 0、byModel 空陣列、optional 欄位缺席）", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    const wire = await rawUsage(project.id);

    for (const key of EDITOR_SUMMARY_COUNT_KEYS) expect(wire[key], key).toBe(0);
    expect(wire.truncated).toBe(false);
    expect(wire.unreadable).toBe(false);
    expectBucketShape(wire.totals, "totals");
    expect(wire.byModel).toEqual([]);
    expect(wire.byCapability).toEqual({});
    expect(wire.byOperation).toEqual({});
    expect("cost" in wire).toBe(false);
    expect("firstAt" in wire).toBe(false);
    expect("lastAt" in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toContain("null");
  }, 60_000);

  /**
   * 真實混合資料（有回報＋未回報＋本機＋失敗）下，`unreportedCalls` 頂層恆等於各分組相加。
   *
   * 四種來源都是真的跑過端點產生的，不是手寫的 record：
   *  ① 假 gateway 回帶用量的回應 → reported
   *  ② 假 gateway 回不帶 usage 欄位的回應 → 未回報（燒了配額但不知道燒多少）
   *  ③ 假 gateway 回 500 → ok:false（失敗也記，失敗一樣燒配額）
   *  ④ mock 影像 provider → 本機（沒碰模型、沒燒配額，不可混進未回報）
   */
  it("混合資料：頂層 unreportedCalls 等於 byCapability／byOperation／byModel 各自相加", async (context) => {
    if (unavailable) return context.skip();
    const project = await createProject();
    const [first, second] = project.slides;
    expect(first && second).toBeTruthy();

    mode = "reported";
    expect((await post(`/api/projects/${project.id}/slides/${first!.id}/outline`, {})).status).toBe(
      200,
    );
    mode = "silent";
    expect(
      (await post(`/api/projects/${project.id}/slides/${second!.id}/outline`, {})).status,
    ).toBe(200);
    mode = "fail";
    // 失敗的那一輪照樣要記；端點自己回幾百不重要，重要的是帳本有這一筆。
    await post(`/api/projects/${project.id}/slides/${first!.id}/outline`, {});
    mode = "reported";
    const { body: queued } = await post<{ id: string }[]>(`/api/projects/${project.id}/generate`, {
      providerId: "mock-image",
    });
    expect(queued.length).toBeGreaterThan(0);
    await waitForJobs(
      project.id,
      queued.map((job) => job.id),
    );
    await ledger().idle();

    // 先用**帳本原始行**獨立算一份期望值（不重用聚合程式碼），四種來源都真的在裡面。
    const lines = await ledgerLines(project.id);
    const isLocal = (line: Record<string, unknown>) =>
      line.providerKind === "mock" || line.providerKind === "local";
    const reportedOf = (line: Record<string, unknown>) =>
      (line.usage as { reported?: boolean } | undefined)?.reported === true;
    const expected = {
      calls: lines.length,
      reported: lines.filter(reportedOf).length,
      local: lines.filter((line) => !reportedOf(line) && isLocal(line)).length,
      unreported: lines.filter((line) => !reportedOf(line) && !isLocal(line)).length,
      failed: lines.filter((line) => line.ok === false).length,
    };
    expect(expected.reported).toBeGreaterThan(0);
    expect(expected.local).toBeGreaterThan(0);
    expect(expected.unreported).toBeGreaterThan(0);
    expect(expected.failed).toBeGreaterThan(0);

    const summary = (await rawUsage(project.id)) as unknown as UsageSummary;
    expect(summary.totalCalls).toBe(expected.calls);
    expect(summary.reportedCalls).toBe(expected.reported);
    expect(summary.localCalls).toBe(expected.local);
    expect(summary.unreportedCalls).toBe(expected.unreported);
    expect(summary.failedCalls).toBe(expected.failed);
    // 頂層與 totals 桶是同一個數字（前端兩處都讀得到，不可分岔）。
    expect(summary.totals.unreportedCalls).toBe(summary.unreportedCalls);

    const sum = (buckets: { unreportedCalls: number }[]) =>
      buckets.reduce((total, bucket) => total + bucket.unreportedCalls, 0);
    expect(sum(Object.values(summary.byCapability))).toBe(summary.unreportedCalls);
    expect(sum(Object.values(summary.byOperation))).toBe(summary.unreportedCalls);
    expect(sum(summary.byModel)).toBe(summary.unreportedCalls);

    // 其餘可加的格子一起驗：分組只是同一批紀錄的另一種切法，加起來必須回到頂層。
    const groups = [
      ["byCapability", Object.values(summary.byCapability)],
      ["byOperation", Object.values(summary.byOperation)],
      ["byModel", summary.byModel],
    ] as const;
    for (const [name, buckets] of groups) {
      for (const key of EDITOR_BUCKET_KEYS) {
        const total = buckets.reduce((carry, bucket) => carry + bucket[key], 0);
        expect(total, `${name} 的 ${key} 相加`).toBe(summary.totals[key]);
      }
      // 每一個桶自己也要對得起來：三種歸類必須剛好切完 calls。
      for (const bucket of buckets)
        expect(bucket.reportedCalls + bucket.unreportedCalls + bucket.localCalls).toBe(
          bucket.calls,
        );
    }

    // 本機那一組**不可以**被算成未回報：兩者的語意剛好相反（沒燒配額 vs 燒了但不知多少）。
    expect(summary.byCapability.image?.localCalls).toBe(expected.local);
    expect(summary.byCapability.image?.unreportedCalls).toBe(0);
    // 未回報的呼叫一個 token 都不加：文字那一組的 token 全部來自「有回報」的那一筆。
    expect(summary.byCapability.text?.totalTokens).toBe(1_290);
  }, 90_000);
});

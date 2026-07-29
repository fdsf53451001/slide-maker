import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  outlineContentCharBudget,
  SafeProviderError,
  type PresentationProject,
  type SourceAsset,
  type StructuredTextProvider,
  type StructuredTextRequest,
  type WebSearchProvider,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import type { UsageLedger, UsageSummary } from "../src/usage-ledger.js";

/**
 * 帳本接線在**端點層**的耐用度。
 *
 * `usage-api.test.ts` 驗的是文字與影像兩條路記得對不對；這一份補的是另外三件事，每一件
 * 都是「功能看起來還在、數字卻是錯的」那種失敗：
 *  ① 帳本壞掉／寫不進去時，**生成本身不能受影響**，統計端點也不該整個 500。
 *  ② 搜尋與圖片描述兩條路（各自有自己的接線）到底有沒有被記。
 *  ③ 例外訊息夾帶正文時，帳本仍然一個字都不留——CLAUDE.md 明講這條要用**真的會洩漏的
 *     形狀**去測，拿一句乾淨的 "HTTP 503" 去測等於沒測。
 */
describe("用量帳本的端點耐用度", () => {
  let appServer: Server | undefined;
  let fake: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const restore: (() => void)[] = [];
  /** 假模型端點這一輪要不要失敗。 */
  let mode: "ok" | "fail" = "ok";

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    // 圖片描述那條走的是真的 `OpenAiStructuredTextProvider`，所以用假端點驅動：這樣驗到的
    // 是「wire 上的 usage → 解析器 → 帳本」整條，而不是只有帳本自己。
    fake = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (part: Buffer) => chunks.push(part));
      request.on("end", () => {
        if ((request.url ?? "").endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          return response.end(JSON.stringify({ data: [] }));
        }
        if (mode === "fail") {
          response.writeHead(500, { "content-type": "application/json" });
          return response.end(JSON.stringify({ error: "boom" }));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "2025 電池成本圖",
                    summary: "長條圖，比較兩種電池的每度成本。",
                    fullText: "Y 軸：每度成本（美元）。磷酸鐵鋰 56，三元 71。",
                  }),
                },
              },
            ],
            // CLI2Proxy `/chat/completions` 的實測形狀。
            usage: {
              prompt_tokens: 303,
              completion_tokens: 13,
              total_tokens: 316,
              prompt_tokens_details: { cached_tokens: 0, cached_creation_tokens: 0 },
              completion_tokens_details: { reasoning_tokens: 0 },
            },
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
    setEnv("SLIDE_MAKER_OPENAI_TEXT_MODEL", "gpt-5-vision");
    setEnv("SLIDE_MAKER_TEXT_ENGINE", "openai");

    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-usage-robust-")), "data");
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

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    mode = "ok";
  });

  afterAll(async () => {
    if (appServer?.listening)
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    if (fake?.listening) await new Promise<void>((resolve) => fake!.close(() => resolve()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const ledger = () => app!.locals.usageLedger as UsageLedger;

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    return (await response.json()) as T;
  }

  const createProject = async (topic = "台灣電動車市場"): Promise<PresentationProject> =>
    json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, brief: { desiredSlideCount: 2, webSearchMode: "disabled" } }),
    });

  const ledgerLines = async (projectId: string): Promise<Record<string, unknown>[]> => {
    await ledger().idle();
    const content = await readFile(ledger().projectLedgerPath(projectId), "utf8").catch(() => "");
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const stubText = (
    run: (request: StructuredTextRequest) => Promise<{ value: unknown; usage?: unknown }>,
  ) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: run,
    } as StructuredTextProvider);
    restore.push(() => spy.mockRestore());
  };

  const slideReply = (content: string) => ({
    content,
    narrative: "講者補充",
    layoutHint: "單欄重點",
    sourceIds: [],
  });

  describe("帳本壞掉時的行為", () => {
    /**
     * 記帳是觀測。帳本寫不進去（權限、磁碟滿、路徑被佔住）時，**已經燒掉配額的那次生成
     * 必須照常完成並落地**——把成果丟掉去換一行統計是完全不成比例的交換。
     * 這裡把該專案的帳本檔案換成目錄，讓 `appendFile` 真的丟 EISDIR，而不是靠 mock。
     */
    it("帳本寫不進去時，大綱重生成照樣回 200 且內容真的寫進專案", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject();
      const slide = project.slides[0]!;
      await mkdir(ledger().projectLedgerPath(project.id), { recursive: true });
      const warnings: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
        warnings.push(String(line));
      });
      restore.push(() => warn.mockRestore());
      stubText(async () => ({ value: slideReply("帳本壞了也要寫進去的新內容") }));

      const response = await fetch(
        `${baseUrl}/api/projects/${project.id}/slides/${slide.id}/outline`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      expect(response.status).toBe(200);
      await ledger().idle();

      const after = await json<PresentationProject>(`/api/projects/${project.id}`);
      expect(after.slides[0]!.content).toBe("帳本壞了也要寫進去的新內容");
      // 失敗留下可判讀的證據，但不含路徑與例外訊息。
      const logged = warnings.join("\n");
      expect(logged).toContain("usage_ledger_write_failed");
      expect(logged).toContain("EISDIR");
      expect(logged).not.toContain(ledger().projectLedgerPath(project.id));
    }, 60_000);

    /**
     * 一行壞資料不得讓整個端點 500：帳本是 append-only 的檔案，程序被砍在寫到一半是
     * 完全正常的情況，而使用者看到的應該是「其中 N 行讀不出來」，不是一頁伺服器錯誤。
     */
    it("帳本裡混著壞行時 GET /usage 仍回 200，好的那些照樣算得出來", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject();
      const slide = project.slides[0]!;
      stubText(async () => ({
        value: slideReply("短"),
        usage: { inputTokens: 100, outputTokens: 20, reported: true },
      }));
      await fetch(`${baseUrl}/api/projects/${project.id}/slides/${slide.id}/outline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await ledger().idle();
      // 一行寫到一半（程序被砍）＋一行形狀不對（舊版／手動編輯）。
      await appendFile(
        ledger().projectLedgerPath(project.id),
        `{"at":"2026-07-29T00:00:00.000Z","capab\n${JSON.stringify({ hello: "world" })}\n`,
        "utf8",
      );

      const response = await fetch(`${baseUrl}/api/projects/${project.id}/usage`);
      expect(response.status).toBe(200);
      const summary = (await response.json()) as UsageSummary;
      expect(summary.malformedLines).toBe(2);
      expect(summary.totalCalls).toBe(1);
      expect(summary.totals.inputTokens).toBe(100);
    }, 60_000);
  });

  describe("三種能力各自的接線", () => {
    /**
     * 搜尋是三種能力裡唯一沒有被 `usage-api.test.ts` 碰到的一條，而它的接線與文字那條
     * **不同**（`WebSearchOutcome` 而非 `StructuredTextResult`）。接錯的症狀是搜尋的
     * 配額完全不出現在統計裡，而搜尋在上游還有一圈最多五次的重試迴圈。
     */
    it("搜尋成功與失敗都記在 capability:search，且用量跟著回來", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject();
      let call = 0;
      const spy = vi.spyOn(ModelRuntime.prototype, "resolveSearchProvider").mockReturnValue({
        id: "stub-search",
        availability: { status: "available" },
        search: async () => {
          call += 1;
          if (call === 1)
            return {
              results: [{ url: "https://example.com/a", title: "A", summary: "s" }],
              usage: { inputTokens: 40, outputTokens: 60, totalTokens: 100, reported: true },
            };
          throw new Error("gateway down");
        },
      } as unknown as WebSearchProvider);
      restore.push(() => spy.mockRestore());

      const body = JSON.stringify({ query: "電動車", limit: 3 });
      const headers = { "content-type": "application/json" };
      await fetch(`${baseUrl}/api/projects/${project.id}/web-search`, {
        method: "POST",
        headers,
        body,
      });
      await fetch(`${baseUrl}/api/projects/${project.id}/web-search`, {
        method: "POST",
        headers,
        body,
      });

      const searches = (await ledgerLines(project.id)).filter(
        (line) => line.capability === "search",
      );
      expect(searches).toHaveLength(2);
      expect(searches[0]).toMatchObject({ operation: "search", ok: true });
      expect(searches[0]!.usage).toEqual({
        inputTokens: 40,
        outputTokens: 60,
        totalTokens: 100,
        reported: true,
      });
      // 失敗一樣燒配額：請求已經送到 gateway 了。
      expect(searches[1]).toMatchObject({ ok: false, usage: { reported: false } });

      const summary = await json<UsageSummary>(`/api/projects/${project.id}/usage`);
      expect(summary.byCapability.search).toMatchObject({
        calls: 2,
        reportedCalls: 1,
        failedCalls: 1,
        inputTokens: 40,
      });
    }, 60_000);

    /**
     * 圖片描述是背景工作，成本在前端完全看不見——CLAUDE.md 明講這條路必須留下證據。
     * 這一條同時是整條鏈唯一的端對端驗證：假 gateway 回真實形狀的 `usage` →
     * `parseChatCompletionsUsage` → `StructuredTextResult` → 帳本。
     */
    it("圖片描述記在 operation:image-description，wire 上的 usage 一路寫進帳本", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject("電池成本");
      const query = new URLSearchParams({
        name: "cost.png",
        mediaType: "image/png",
        usage: "visual-reference",
        allowModelAccess: "true",
      });
      const bytes = await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 12, g: 34, b: 56 } },
      })
        .png()
        .toBuffer();
      const created = await json<PresentationProject>(
        `/api/projects/${project.id}/sources?${query.toString()}`,
        { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(bytes) },
      );
      const source = created.sources.find((item) => item.name === "cost.png")!;
      // 等背景描述收尾（來源離開 parsing）。
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const sources = await json<SourceAsset[]>(`/api/projects/${project.id}/sources`);
        if (sources.find((item) => item.id === source.id)?.status !== "parsing") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const described = (await ledgerLines(project.id)).filter(
        (line) => line.operation === "image-description",
      );
      expect(described).toHaveLength(1);
      expect(described[0]).toMatchObject({
        capability: "text",
        sourceId: source.id,
        ok: true,
      });
      expect(described[0]!.usage).toEqual({
        inputTokens: 303,
        outputTokens: 13,
        totalTokens: 316,
        cachedTokens: 0,
        reasoningTokens: 0,
        reported: true,
      });
      // 圖裡抽出來的正文一個字都不進帳本。
      const serialized = await readFile(ledger().projectLedgerPath(project.id), "utf8");
      expect(serialized).not.toContain("磷酸鐵鋰");
      expect(serialized).not.toContain("每度成本");
    }, 60_000);
  });

  describe("往返成功之後才失敗的呼叫", () => {
    /**
     * `*_WEB_SEARCH_EMPTY` 是整個功能裡最值得記的一種失敗：整段帶 grounding 的長回應
     * （常是專案裡最大的單筆）燒完卻零產出，而使用者的直覺反應是再按一次。usage 就在
     * 錯誤物件身上（`SafeProviderError.usage`），不接起來的話，帳本上只會留下一筆
     * `reported:false`——與「這個 gateway 不回報用量」長得一模一樣。
     */
    it("搜尋丟出帶用量的 SafeProviderError 時，帳本記下 ok:false＋真實用量", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject();
      const spy = vi.spyOn(ModelRuntime.prototype, "resolveSearchProvider").mockReturnValue({
        id: "stub-search",
        availability: { status: "available" },
        search: async () => {
          throw new SafeProviderError("OPENAI_WEB_SEARCH_EMPTY", "沒有可驗證的候選。", {
            usage: { inputTokens: 4_000, outputTokens: 900, totalTokens: 4_900, reported: true },
            requests: 1,
          });
        },
      } as unknown as WebSearchProvider);
      restore.push(() => spy.mockRestore());

      await fetch(`${baseUrl}/api/projects/${project.id}/web-search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "電動車", limit: 3 }),
      });

      const searches = (await ledgerLines(project.id)).filter(
        (line) => line.capability === "search",
      );
      expect(searches).toHaveLength(1);
      expect(searches[0]).toMatchObject({ ok: false, requests: 1 });
      expect(searches[0]!.usage).toEqual({
        inputTokens: 4_000,
        outputTokens: 900,
        totalTokens: 4_900,
        reported: true,
      });
      const summary = await json<UsageSummary>(`/api/projects/${project.id}/usage`);
      // 失敗但**有回報**：這筆的 token 要進總數，否則「最貴又零產出」的呼叫等於不存在。
      expect(summary.byCapability.search).toMatchObject({
        calls: 1,
        failedCalls: 1,
        reportedCalls: 1,
        inputTokens: 4_000,
      });
    }, 60_000);

    /**
     * 圖片描述那條的 schema parse **必須排在記帳之後**：模型回了東西＝配額已經燒掉，
     * 格式對不對是下一個問題。Gemini 系模型多包一層圍欄時十張圖會一起 parse 失敗，
     * 記成「未回報」的話與「這個 gateway 不回報用量」分不出來。
     */
    it("圖片描述的輸出格式不對時，仍記 ok:true 並保住 usage", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject("格式不對");
      stubText(async () => ({
        // 缺 fullText：過不了 imageDescriptionSchema。
        value: { title: "圖", summary: "摘要" },
        usage: { inputTokens: 777, outputTokens: 88, reported: true },
      }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      restore.push(() => warn.mockRestore());
      const query = new URLSearchParams({
        name: "broken.png",
        mediaType: "image/png",
        usage: "visual-reference",
        allowModelAccess: "true",
      });
      const bytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer();
      const created = await json<PresentationProject>(
        `/api/projects/${project.id}/sources?${query.toString()}`,
        { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(bytes) },
      );
      const source = created.sources.find((item) => item.name === "broken.png")!;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const sources = await json<SourceAsset[]>(`/api/projects/${project.id}/sources`);
        if (sources.find((item) => item.id === source.id)?.status !== "parsing") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const described = (await ledgerLines(project.id)).filter(
        (line) => line.operation === "image-description",
      );
      expect(described).toHaveLength(1);
      // 往返成功＝ok:true（見 `UsageRecordInput.ok`），而 usage 一個 token 都沒掉。
      expect(described[0]).toMatchObject({ ok: true });
      expect(described[0]!.usage).toEqual({ inputTokens: 777, outputTokens: 88, reported: true });
    }, 60_000);
  });

  describe("整份大綱那條路的逐輪記帳", () => {
    /**
     * `usage-api.test.ts` 釘的是**單頁**重生成那條迴圈；整份大綱是另一個呼叫點、另一組
     * 欄位（`outline-generate`、沒有 slideId），而它才是最貴的那一條——一次三輪、每一輪都
     * 帶著整包來源節錄。兩條共用 `recordStructuredUsage`，但「有沒有真的接上去」是各自的事。
     */
    it("整份大綱重試三輪各記一筆，attempt 遞增且不帶 slideId", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject();
      const hard = outlineContentCharBudget("high").hard;
      let attempt = 0;
      stubText(async () => {
        attempt += 1;
        // 三輪都超標（但不到 hard 的兩倍，才不會整批失敗），迴圈因此跑滿。
        const overflow = "台".repeat(hard + 100 - attempt);
        return {
          value: {
            actualSlideCount: 2,
            rationale: "測試用",
            slides: [
              {
                purpose: "第 1 頁",
                content: overflow,
                narrative: "講者補充",
                layoutHint: "單欄重點",
                sourceUrls: [],
              },
              {
                purpose: "第 2 頁",
                content: "短",
                narrative: "講者補充",
                layoutHint: "單欄重點",
                sourceUrls: [],
              },
            ],
            sources: [],
          },
          usage: { inputTokens: 1_000 * attempt, outputTokens: 10, reported: true },
        };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      restore.push(() => warn.mockRestore());

      await fetch(`${baseUrl}/api/projects/${project.id}/outline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replace: true }),
      });

      const rows = (await ledgerLines(project.id)).filter(
        (line) => line.operation === "outline-generate",
      );
      expect(rows).toHaveLength(3);
      expect(rows.map((line) => line.attempt)).toEqual([1, 2, 3]);
      expect(rows.every((line) => line.slideId === undefined)).toBe(true);
      expect(rows.every((line) => line.capability === "text")).toBe(true);
      // 三輪的用量各記各的：只記最後一輪會把這次生成的成本低估到三分之一。
      expect(rows.map((line) => (line.usage as { inputTokens?: number }).inputTokens)).toEqual([
        1_000, 2_000, 3_000,
      ]);
      const summary = await json<UsageSummary>(`/api/projects/${project.id}/usage`);
      expect(summary.byOperation["outline-generate"]).toMatchObject({
        calls: 3,
        reportedCalls: 3,
        inputTokens: 6_000,
      });
    }, 60_000);
  });

  describe("正文外洩", () => {
    /**
     * CLAUDE.md：非嚴格 gateway 會把整份 request body（含 prompt 與來源正文）原樣回聲進
     * 400 的 message。所以這條測試**故意讓例外訊息夾帶整份 prompt**——拿
     * `new Error("HTTP 503")` 去測的話，把 error 整包丟進帳本的實作也會通過。
     */
    it("例外訊息夾帶整份 prompt 時，帳本裡一個字都找不到", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject("台積電二奈米製程");
      const slide = project.slides[0]!;
      const SECRET = "內部財報：第三季營收 42 億";
      await fetch(`${baseUrl}/api/projects/${project.id}/slides/${slide.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: SECRET }),
      });
      stubText(async (request: StructuredTextRequest) => {
        // gateway 把整包 body 回聲回來的實測形狀。
        throw new Error(`HTTP 400 from gateway: ${request.prompt}`);
      });

      await fetch(`${baseUrl}/api/projects/${project.id}/slides/${slide.id}/outline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await ledger().idle();

      const serialized = await readFile(ledger().projectLedgerPath(project.id), "utf8");
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("台積電二奈米製程");
      expect(serialized).not.toContain("UNTRUSTED_INPUT");
      expect(serialized).not.toContain("HTTP 400");
      // 該留的還在：失敗這件事本身。
      const failed = (await ledgerLines(project.id)).filter((line) => line.ok === false);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ operation: "outline-regenerate", attempt: 1 });
    }, 60_000);
  });

  describe("刪除專案", () => {
    /**
     * 帳本住在專案目錄之外，所以 `rm -rf projectRoot` 帶不走它——刪除專案必須自己刪。
     * 留著的話，同一個 DATA_ROOT 會慢慢累積一堆對不到專案的帳本檔案。
     */
    it("刪掉專案時帳本一起刪掉", async (context) => {
      if (unavailable) return context.skip();
      const project = await createProject();
      const slide = project.slides[0]!;
      stubText(async () => ({
        value: slideReply("短"),
        usage: { inputTokens: 3, reported: true },
      }));
      await fetch(`${baseUrl}/api/projects/${project.id}/slides/${slide.id}/outline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await ledger().idle();
      expect(await ledgerLines(project.id)).toHaveLength(1);

      const response = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
      expect(response.status).toBe(200);
      await expect(readFile(ledger().projectLedgerPath(project.id), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }, 60_000);
  });

  describe("關機時的收尾", () => {
    /**
     * 記帳是 fire-and-forget 的：沒有人等它。SIGTERM 時剛跑完的那幾筆（正好是最貴的
     * 那幾筆）因此最容易掉。關機流程必須 flush 帳本，而且要排在其他背景工作**之後**
     * ——它們收尾時可能還會再記幾筆（in-flight 的圖片描述剛回來）。
     */
    it("backgroundWork.shutdown() 會 flush 帳本（配逾時）", async (context) => {
      if (unavailable) return context.skip();
      const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-usage-shutdown-")), "data");
      const fresh = await createApp(dataRoot);
      const freshLedger = fresh.locals.usageLedger as UsageLedger;
      const flushed = vi.spyOn(freshLedger, "idle");
      await (fresh.locals.backgroundWork as { shutdown: () => Promise<void> }).shutdown();
      expect(flushed).toHaveBeenCalled();
      // 逾時是必要的：一個觀測用檔案不該有本事拖過關機期限。
      expect(flushed.mock.calls.at(-1)?.[0]).toBeGreaterThan(0);
      flushed.mockRestore();
    }, 60_000);
  });

  describe("專案之間互不汙染", () => {
    it("兩個專案各記各的，統計不會互相加到對方頭上", async (context) => {
      if (unavailable) return context.skip();
      const first = await createProject("專案甲");
      const second = await createProject("專案乙");
      stubText(async () => ({
        value: slideReply("短"),
        usage: { inputTokens: 7, reported: true },
      }));
      for (const project of [first, first, second])
        await fetch(
          `${baseUrl}/api/projects/${project.id}/slides/${project.slides[0]!.id}/outline`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        );
      await ledger().idle();

      expect((await json<UsageSummary>(`/api/projects/${first.id}/usage`)).totals).toMatchObject({
        calls: 2,
        inputTokens: 14,
      });
      expect((await json<UsageSummary>(`/api/projects/${second.id}/usage`)).totals).toMatchObject({
        calls: 1,
        inputTokens: 7,
      });
    }, 60_000);
  });
});

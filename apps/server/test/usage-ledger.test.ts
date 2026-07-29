import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileProjectRepository } from "../src/repository.js";
import {
  summarizeUsage,
  UsageLedger,
  USAGE_LEDGER_MAX_LINES,
  type UsageRecord,
  type UsageRecordInput,
} from "../src/usage-ledger.js";

const PROJECT_ID = "project-1";

async function ledger(): Promise<{ ledger: UsageLedger; root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-usage-"));
  const repository = new FileProjectRepository(root);
  await repository.initialize();
  const instance = new UsageLedger(repository);
  return { ledger: instance, root, path: instance.projectLedgerPath(PROJECT_ID) };
}

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function input(patch: Partial<UsageRecordInput> = {}): UsageRecordInput {
  return {
    capability: "text",
    operation: "outline-generate",
    model: "gpt-5.6-luna",
    modelEntryId: "entry-1",
    providerKind: "openai",
    ok: true,
    usage: { inputTokens: 303, outputTokens: 13, reported: true },
    ...patch,
  };
}

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

describe("UsageLedger 落地", () => {
  it("一行一次呼叫，欄位齊全且 at 由帳本自己蓋", async () => {
    const { ledger: instance, path } = await ledger();
    await instance.recordProject(PROJECT_ID, input({ slideId: "slide-9", attempt: 2 }));
    const [line] = await readLines(path);
    expect(line).toMatchObject({
      capability: "text",
      operation: "outline-generate",
      model: "gpt-5.6-luna",
      modelEntryId: "entry-1",
      providerKind: "openai",
      slideId: "slide-9",
      attempt: 2,
      ok: true,
      usage: { inputTokens: 303, outputTokens: 13, reported: true },
    });
    expect(typeof line!.at).toBe("string");
    expect(Number.isNaN(Date.parse(String(line!.at)))).toBe(false);
  });

  it("provider 沒回報用量時落成 reported:false，而不是一堆 0", async () => {
    const { ledger: instance, path } = await ledger();
    // `exactOptionalPropertyTypes`：「沒有 usage」是把鍵**拿掉**，不是填 undefined。
    const { usage: _omitted, ...withoutUsage } = input();
    await instance.recordProject(PROJECT_ID, withoutUsage);
    const [line] = await readLines(path);
    expect(line!.usage).toEqual({ reported: false });
  });

  it("路徑走 repository 那份 assertSafeSegment，不合法 id 不會寫出檔案也不會 throw", async () => {
    const { ledger: instance, root } = await ledger();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    restore.push(() => warn.mockRestore());
    await expect(instance.recordProject("../escape", input())).resolves.toBeUndefined();
    await expect(stat(join(root, "usage", "..", "escape.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, "escape.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  /**
   * 帳本**不在專案目錄底下**（見 usage-ledger.ts 的 ④）：`exporters.ts` 的 `collectFiles()`
   * 無條件遞迴整個專案目錄，放在裡面就會被打包進使用者分享出去的 `.slide-project`；而刪除
   * 專案時被取消的 job 仍會走到記帳，競態下會把剛刪掉的專案目錄「復活」成一個只含帳本的
   * 空殼。
   */
  it("帳本寫在 DATA_ROOT/usage 底下，專案目錄一個位元組都不多", async () => {
    const { ledger: instance, root, path } = await ledger();
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    expect(path).toBe(join(root, "usage", `${PROJECT_ID}.jsonl`));
    await expect(stat(join(root, "projects", PROJECT_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("刪除專案會一併刪掉帳本，且刪不掉也不會 throw", async () => {
    const { ledger: instance, path } = await ledger();
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    await expect(stat(path)).resolves.toBeDefined();
    await instance.deleteProject(PROJECT_ID);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    // 沒有帳本的專案（或不合法的 id）刪起來一樣安靜。
    await expect(instance.deleteProject(PROJECT_ID)).resolves.toBeUndefined();
    await expect(instance.deleteProject("../escape")).resolves.toBeUndefined();
  });

  it("無專案脈絡的呼叫寫進 DATA_ROOT/usage/global.jsonl", async () => {
    const { ledger: instance, root } = await ledger();
    await instance.recordGlobal(input({ operation: "style-analysis" }));
    const [line] = await readLines(join(root, "usage", "global.jsonl"));
    expect(line).toMatchObject({ operation: "style-analysis" });
  });
});

describe("併發", () => {
  /**
   * 五十筆併發 append 不得互相切斷。O_APPEND 本身即原子，加上帳本自己的逐檔序列化，
   * 每一行都必須是完整的 JSON——半行是聚合端最難診斷的失敗。
   */
  it("五十筆併發寫入不交錯，每行都解得開", async () => {
    const { ledger: instance, path } = await ledger();
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        instance.recordProject(PROJECT_ID, input({ attempt: index + 1 })),
      ),
    );
    await instance.idle();
    const lines = await readLines(path);
    expect(lines).toHaveLength(50);
    expect(new Set(lines.map((line) => line.attempt)).size).toBe(50);
  });
});

describe("大小上限", () => {
  it("超過行數上限時砍掉最舊的一半，留下的是最新那一半", async () => {
    const { ledger: instance, path } = await ledger();
    // 先塞到只差一行就滿；逐筆 await 才能保證順序（attempt 就是序號）。
    const seeded: string[] = [];
    for (let index = 1; index <= USAGE_LEDGER_MAX_LINES; index += 1) {
      seeded.push(
        JSON.stringify({
          at: new Date(index).toISOString(),
          capability: "text",
          operation: "outline-generate",
          attempt: index,
          ok: true,
          usage: { reported: false },
        }),
      );
    }
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${seeded.join("\n")}\n`, "utf8");
    await instance.recordProject(PROJECT_ID, input({ attempt: USAGE_LEDGER_MAX_LINES + 1 }));
    await instance.idle();
    const lines = await readLines(path);
    expect(lines.length).toBeLessThanOrEqual(USAGE_LEDGER_MAX_LINES);
    expect(lines.length).toBeGreaterThan(USAGE_LEDGER_MAX_LINES / 2 - 2);
    // 留下的是最新那一半：最後一筆還在，最舊那一筆不在。
    expect(lines.at(-1)?.attempt).toBe(USAGE_LEDGER_MAX_LINES + 1);
    // 第一行是截斷紀錄，第二行才是最舊的**留下來的**那一筆。
    expect(lines[0]).toMatchObject({ truncated: true });
    expect(lines[1]?.attempt).toBeGreaterThan(1);
  });

  /**
   * 輪替會**永久**丟掉最舊的一半，而 UI 上的「本專案總計」正是使用者最可能拿去當頭條的
   * 數字。沒有這個訊號的話，長壽專案的統計會是錯的、而且無從察覺——一個沒有標註的錯誤
   * 數字比一個標著「已截斷」的數字糟得多。
   */
  it("輪替後統計帶著 truncated 與被丟掉的筆數，且第二次輪替會累加而不是歸零", async () => {
    const { ledger: instance, path } = await ledger();
    const seed = async (): Promise<void> => {
      const seeded = Array.from({ length: USAGE_LEDGER_MAX_LINES + 1 }, (_, index) =>
        JSON.stringify({
          at: new Date(index + 1).toISOString(),
          capability: "text",
          operation: "outline-generate",
          ok: true,
          usage: { reported: false },
        }),
      );
      const existing = await readFile(path, "utf8").catch(() => "");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${existing}${seeded.join("\n")}\n`, "utf8");
    };
    await seed();
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    const first = await instance.summarizeProject(PROJECT_ID);
    expect(first.truncated).toBe(true);
    expect(first.droppedRecords).toBeGreaterThan(USAGE_LEDGER_MAX_LINES / 2 - 2);
    // 截斷紀錄本身不是一筆呼叫，不得混進統計。
    expect(first.totalCalls).toBe((await readLines(path)).length - 1);
    expect(first.malformedLines).toBe(0);

    await seed();
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    const second = await instance.summarizeProject(PROJECT_ID);
    expect(second.truncated).toBe(true);
    expect(second.droppedRecords).toBeGreaterThan(first.droppedRecords);
    // 檔案裡永遠只有一筆截斷紀錄（新的那筆繼承了舊的數字）。
    expect((await readLines(path)).filter((line) => line.truncated === true)).toHaveLength(1);
  });

  it("輪替後不留 .tmp 殘檔", async () => {
    const { ledger: instance, path, root } = await ledger();
    const seeded = Array.from({ length: USAGE_LEDGER_MAX_LINES + 5 }, (_, index) =>
      JSON.stringify({
        at: new Date(index + 1).toISOString(),
        capability: "text",
        operation: "outline-generate",
        ok: true,
        usage: { reported: false },
      }),
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${seeded.join("\n")}\n`, "utf8");
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(root, "usage"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("寫入失敗", () => {
  /**
   * 記帳是觀測，不是產品功能。寫不進去只能留一行 log，絕不可讓例外冒到呼叫端——那條路
   * 上正好掛著一次剛跑完、已經燒掉配額的生成。
   */
  it("目錄不可寫時 record 仍 resolve，只留一行 logWarn", async () => {
    const { ledger: instance, root } = await ledger();
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    restore.push(() => warn.mockRestore());
    const ledgerDirectory = join(root, "usage");
    await mkdir(ledgerDirectory, { recursive: true });
    await chmod(ledgerDirectory, 0o500);
    try {
      await expect(instance.recordProject(PROJECT_ID, input())).resolves.toBeUndefined();
    } finally {
      await chmod(ledgerDirectory, 0o700);
      await rm(root, { recursive: true, force: true });
    }
    expect(warnings.join("\n")).toContain("usage_ledger_write_failed");
  });

  /**
   * CLAUDE.md 第 23 條：`logWarn` 的第三個參數會把 `error.message` 與 `stack` 整份序列化
   * 進 log，而 fs 例外的訊息就是完整的伺服器絕對路徑。這條測試把一段**可辨識的字串**放進
   * 路徑裡（mkdtemp 的前綴），再斷言 log 裡找不到它——`#warn` 一旦被改成
   * `logWarn(event, fields, error)`，這裡就會紅。
   */
  it("寫入失敗的 log 不含路徑、例外訊息與 stack", async () => {
    const CANARY = "leak-canary-9f3";
    const root = await mkdtemp(join(tmpdir(), `slide-maker-${CANARY}-`));
    const instance = new UsageLedger(new FileProjectRepository(root));
    const path = instance.projectLedgerPath(PROJECT_ID);
    // 帳本檔案位置變成目錄 → appendFile 丟 EISDIR，而 EISDIR 的 message 帶著完整路徑。
    await mkdir(path, { recursive: true });
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    restore.push(() => warn.mockRestore());

    await expect(instance.recordProject(PROJECT_ID, input())).resolves.toBeUndefined();
    await instance.idle();

    const logged = warnings.join("\n");
    // 判讀得出來：哪個專案、哪一種呼叫、什麼錯。
    expect(logged).toContain("usage_ledger_write_failed");
    expect(logged).toContain(PROJECT_ID);
    expect(logged).toContain("EISDIR");
    // 但路徑（含那段 canary）、例外訊息與 stack 一個字都不留。
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain(path);
    expect(logged).not.toContain("illegal operation");
    expect(logged).not.toContain("stack");
  });

  /**
   * **讀取端要有與寫入端同一份紀律。** 往上拋會讓 `GET /usage` 落到通用 handler 回 500，
   * 而那個 handler 會把 `error.message`（EACCES 的訊息就是完整伺服器絕對路徑）整份序列化
   * 進 log。一個觀測用檔案的權限問題不該讓統計頁掛掉，也不該換來一行路徑外洩。
   */
  it("帳本讀不出來時回空結果＋unreadable，不 throw、不洩漏路徑", async () => {
    const CANARY = "read-canary-2b7";
    const root = await mkdtemp(join(tmpdir(), `slide-maker-${CANARY}-`));
    const instance = new UsageLedger(new FileProjectRepository(root));
    const path = instance.projectLedgerPath(PROJECT_ID);
    await mkdir(path, { recursive: true }); // 讀檔案讀到目錄 → EISDIR
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    restore.push(() => warn.mockRestore());

    const summary = await instance.summarizeProject(PROJECT_ID);
    expect(summary.unreadable).toBe(true);
    expect(summary.totalCalls).toBe(0);
    // 沒有帳本的專案是 `unreadable:false`＋全零：那與「讀不出來」是兩件事，UI 要分得開。
    expect((await instance.summarizeProject("project-without-ledger")).unreadable).toBe(false);

    const logged = warnings.join("\n");
    expect(logged).toContain("usage_ledger_read_failed");
    expect(logged).toContain("EISDIR");
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain(path);
    expect(logged).not.toContain("illegal operation");
  });

  it("一行壞掉的 JSON 不會讓整份統計消失", async () => {
    const { ledger: instance, path } = await ledger();
    await instance.recordProject(PROJECT_ID, input());
    await writeFile(path, `${await readFile(path, "utf8")}{"broken":\n`, "utf8");
    await instance.recordProject(PROJECT_ID, input({ operation: "outline-regenerate" }));
    await instance.idle();
    const summary = await instance.summarizeProject(PROJECT_ID);
    expect(summary.totalCalls).toBe(2);
    expect(summary.malformedLines).toBe(1);
  });
});

describe("帳本不含正文", () => {
  /**
   * 比照 `outline-overflow.test.ts` 的做法：直接斷言序列化後的檔案不含正文字串。
   *
   * 這裡的保證主要來自型別（`operation` 是封閉聯集、`toRecord` 逐欄組裝而非展開），
   * 但型別擋不住「有人把整個 request 物件 as any 塞進來」；這條測試擋得住。
   */
  it("即使呼叫端夾帶額外欄位，落地的那一行也不含 prompt／content／憑證", async () => {
    const { ledger: instance, path } = await ledger();
    const SECRET = "第三季營收成長 42%，資料來源為內部財報";
    const PROMPT = 'UNTRUSTED_INPUT\n{"topic":"機密專案"}';
    const API_KEY = "sk-live-abcdef0123456789";
    await instance.recordProject(PROJECT_ID, {
      ...input(),
      // 呼叫端手滑（或未來有人擴充介面）時，多餘的欄位不得跟著落地。
      ...({ prompt: PROMPT, content: SECRET, apiKey: API_KEY } as Partial<UsageRecordInput>),
    });
    await instance.idle();
    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PROMPT);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("UNTRUSTED_INPUT");
    // 該留的還是留著：id、模型名、數字。
    expect(serialized).toContain("gpt-5.6-luna");
    expect(serialized).toContain("entry-1");
  });
});

describe("聚合", () => {
  const record = (patch: Partial<UsageRecord> = {}): UsageRecord => ({
    at: "2026-07-29T00:00:00.000Z",
    capability: "text",
    operation: "outline-generate",
    model: "gpt-5.6-luna",
    modelEntryId: "entry-1",
    providerKind: "openai",
    ok: true,
    usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, reported: true },
    ...patch,
  });

  /**
   * 未回報的呼叫**只計入 calls，一個 token 都不加**。把 reported:false 當成 0 加總會讓
   * 使用者看到一個看似精確、實際上系統性低估的數字——那比誠實地說「其中 N 次未回報」糟。
   */
  it("未回報的呼叫計入 calls 但不計入 token 總和，且未回報數算得出來", () => {
    const summary = summarizeUsage([
      record(),
      record({ usage: { reported: false } }),
      record({ usage: { reported: false } }),
    ]);
    expect(summary.totalCalls).toBe(3);
    expect(summary.reportedCalls).toBe(1);
    expect(summary.unreportedCalls).toBe(2);
    expect(summary.totals.inputTokens).toBe(100);
    expect(summary.totals.outputTokens).toBe(20);
    expect(summary.totals.reasoningTokens).toBe(5);
  });

  it("依 capability／operation／model 分組，各組都有 calls 與三種 token", () => {
    const summary = summarizeUsage([
      record(),
      record({ capability: "search", operation: "search", modelEntryId: "entry-2", model: "s" }),
      record({ capability: "image", operation: "generate", modelEntryId: "entry-3", model: "i" }),
      record(),
    ]);
    expect(summary.byCapability.text).toMatchObject({ calls: 2, inputTokens: 200 });
    expect(summary.byCapability.search).toMatchObject({ calls: 1 });
    expect(summary.byCapability.image).toMatchObject({ calls: 1 });
    expect(summary.byOperation["outline-generate"]).toMatchObject({ calls: 2, outputTokens: 40 });
    expect(summary.byOperation.search).toMatchObject({ calls: 1 });
    // byModel 依 calls 由多到少。
    expect(summary.byModel[0]).toMatchObject({ modelEntryId: "entry-1", calls: 2 });
    expect(summary.byModel.map((bucket) => bucket.calls)).toEqual([2, 1, 1]);
  });

  it("失敗的呼叫照樣計入 calls，並單獨算得出來", () => {
    const summary = summarizeUsage([record(), record({ ok: false, usage: { reported: false } })]);
    expect(summary.totalCalls).toBe(2);
    expect(summary.failedCalls).toBe(1);
    expect(summary.totals.inputTokens).toBe(100);
  });

  it("cost 先加總備用（金額 UI 尚未實作），沒有任何 cost 時是 undefined", () => {
    expect(summarizeUsage([record()]).cost).toBeUndefined();
    const withCost = summarizeUsage([
      record({
        usage: { reported: true, cost: { amount: 0.04, unit: "openrouter-credit" } },
      }),
      record({
        usage: { reported: true, cost: { amount: 0.01, unit: "openrouter-credit" } },
      }),
    ]);
    expect(withCost.cost?.unit).toBe("openrouter-credit");
    expect(withCost.cost?.amount).toBeCloseTo(0.05, 10);
  });

  /**
   * 回了 in/out 卻沒回 total 的 gateway（CLIProxyAPI 各家 translator 行為不一致）不可以讓
   * `totalTokens` 少一截：那正是 UI 最可能拿去當頭條的數字，而它會錯得很安靜。
   */
  it("gateway 沒回 total 時退回 input+output，不重複加 reasoning", () => {
    const summary = summarizeUsage([
      record({
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 15, reported: true },
      }),
    ]);
    // 100 + 20；reasoning 已含在 OpenAI 的 completion_tokens 裡，再加一次會反過來高估。
    expect(summary.totals.totalTokens).toBe(120);
    // 端點自己回了 total 就以它為準（它含 thoughts，不可拿 in+out 反推）。
    expect(
      summarizeUsage([
        record({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 99, reported: true } }),
      ]).totals.totalTokens,
    ).toBe(99);
    // 未回報的那筆一個 token 都不加，退回值也不例外。
    expect(summarizeUsage([record({ usage: { reported: false } })]).totals.totalTokens).toBe(0);
  });

  /**
   * `local-inpaint`／`mock-image` 沒碰任何模型、沒燒任何配額。混進「未回報」會讓那個數字
   * （語意是「燒了配額但不知道燒多少」）被批次抽字灌到看不出真正的問題在哪。
   */
  it("本機 provider 歸到 localCalls，不算未回報", () => {
    const summary = summarizeUsage([
      record({ providerKind: "local", modelEntryId: "local-inpaint", usage: { reported: false } }),
      record({ providerKind: "mock", modelEntryId: "mock-image", usage: { reported: false } }),
      // 真的沒回報的 gateway：這才是 unreportedCalls 要指出來的東西。
      record({ providerKind: "openai", usage: { reported: false } }),
      record(),
    ]);
    expect(summary.localCalls).toBe(2);
    expect(summary.unreportedCalls).toBe(1);
    expect(summary.reportedCalls).toBe(1);
    expect(summary.totalCalls).toBe(4);
    // 分組桶裡也看得到，UI 才有辦法在「這一組全是本機」時不顯示未回報警告。
    expect(summary.byModel.find((bucket) => bucket.modelEntryId === "local-inpaint")).toMatchObject(
      { localCalls: 1, reportedCalls: 0 },
    );
  });

  /**
   * `requests` 是「實際打了幾次 HTTP」（provider 內部重試會 > 1）。少了它，`calls` 只是
   * 邏輯呼叫數，UI 上「到底重跑了幾次」問不出來。舊紀錄沒有這個欄位，一律當 1。
   */
  it("requests 一起聚合，缺席的舊紀錄當 1", () => {
    const summary = summarizeUsage([record({ requests: 3 }), record(), record({ requests: 2 })]);
    expect(summary.totalCalls).toBe(3);
    expect(summary.totalRequests).toBe(6);
    expect(summary.byOperation["outline-generate"]?.requests).toBe(6);
  });

  /**
   * 模型庫改過名字之後，整組統計不該一直掛著舊名——使用者在模型庫裡已經找不到那個名字了。
   */
  it("byModel 的模型名取最近一筆，不是第一筆", () => {
    const summary = summarizeUsage([
      record({ at: "2026-07-01T00:00:00.000Z", model: "舊名", providerKind: "codex" }),
      record({ at: "2026-07-20T00:00:00.000Z", model: "新名", providerKind: "openai" }),
    ]);
    expect(summary.byModel[0]).toMatchObject({
      modelEntryId: "entry-1",
      model: "新名",
      providerKind: "openai",
      calls: 2,
    });
  });

  /**
   * cost 與 token 走同一個閘門：`reported:false` 卻帶著 cost 的紀錄（目前產生不出來，但
   * schema 允許）不可以偷偷被算進金額，否則同一份摘要裡會有兩套納入規則。
   */
  it("未回報的紀錄即使帶著 cost 也不算進金額", () => {
    const summary = summarizeUsage([
      record({ usage: { reported: false, cost: { amount: 9.99, unit: "openrouter-credit" } } }),
      record({ usage: { reported: true, cost: { amount: 0.02, unit: "openrouter-credit" } } }),
    ]);
    expect(summary.cost?.amount).toBeCloseTo(0.02, 10);
  });

  it("空帳本回全零而不是 undefined", () => {
    const summary = summarizeUsage([]);
    expect(summary.totalCalls).toBe(0);
    expect(summary.unreportedCalls).toBe(0);
    expect(summary.byModel).toEqual([]);
    expect(summary.firstAt).toBeUndefined();
  });
});

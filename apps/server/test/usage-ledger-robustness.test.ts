import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileProjectRepository } from "../src/repository.js";
import { UsageLedger, USAGE_LEDGER_MAX_BYTES, type UsageRecordInput } from "../src/usage-ledger.js";

/**
 * 帳本的耐用度：輪替、併發、寫入失敗與**壞行**。
 *
 * 與 `usage-ledger.test.ts` 分開的理由是它們釘的東西不同：那一份釘的是「一次呼叫落成
 * 什麼形狀」與聚合規則，這一份釘的是「檔案在被弄壞、被塞爆、被同時寫的情況下，統計還
 * 讀不讀得出來」——帳本是唯一一份成本證據，讀不出來與沒有記等價。
 */

const PROJECT_ID = "project-robust";
const OTHER_PROJECT_ID = "project-other";

async function ledger(): Promise<{ ledger: UsageLedger; root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-usage-robust-"));
  const repository = new FileProjectRepository(root);
  await repository.initialize();
  const instance = new UsageLedger(repository);
  return { ledger: instance, root, path: instance.projectLedgerPath(PROJECT_ID) };
}

function input(patch: Partial<UsageRecordInput> = {}): UsageRecordInput {
  return {
    capability: "text",
    operation: "outline-draft",
    model: "gpt-5.6-luna",
    modelEntryId: "entry-1",
    providerKind: "openai",
    ok: true,
    usage: { inputTokens: 10, outputTokens: 2, reported: true },
    ...patch,
  };
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
}

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

describe("位元組上限的輪替", () => {
  /**
   * 行數上限那條路已有測試；這裡走的是**另一條分支**（`size > MAX_BYTES` 時連行都不數就
   * 直接輪替）。兩條分支的差別不是風格問題：位元組那條會在行數遠低於 5000 時觸發，若它
   * 寫壞了，症狀是「用量分頁突然變成 500 或整份歸零」，而不是慢慢變慢。
   */
  it("超過位元組上限時輪替：檔案縮小、每一行仍解得開、統計照樣算得出來", async () => {
    const { ledger: instance, path, root } = await ledger();
    // 每行約 900 bytes（把長度灌在 model 欄位），2600 行就超過 2 MiB 而行數遠低於 5000。
    const padding = "m".repeat(800);
    const seeded = Array.from({ length: 2_600 }, (_, index) =>
      JSON.stringify({
        at: new Date(index + 1).toISOString(),
        capability: "text",
        operation: "outline-draft",
        model: `${padding}-${index + 1}`,
        modelEntryId: "entry-1",
        ok: true,
        usage: { inputTokens: 1, reported: true },
      }),
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${seeded.join("\n")}\n`, "utf8");
    expect((await stat(path)).size).toBeGreaterThan(USAGE_LEDGER_MAX_BYTES);

    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();

    expect((await stat(path)).size).toBeLessThan(USAGE_LEDGER_MAX_BYTES);
    const remaining = await lines(path);
    // 每一行都必須是完整的 JSON——輪替寫壞一行就等於整份統計從那裡開始不可信。
    for (const line of remaining) expect(() => JSON.parse(line)).not.toThrow();
    expect(remaining.length).toBeCloseTo(seeded.length / 2, -2);
    // 第一行是截斷紀錄（帳本必須說得出自己丟過東西），第二行才是最舊的留下來的那一筆。
    expect(JSON.parse(remaining[0]!)).toMatchObject({ truncated: true });
    expect(remaining[1]).toContain(`${padding}-13`);
    expect(remaining.at(-1)).toContain("gpt-5.6-luna");
    expect(await readdir(join(root, "usage"))).not.toContain(expect.stringContaining(".tmp"));

    // 輪替之後統計仍讀得出來，且筆數與檔案裡的行數（扣掉截斷紀錄）一致。
    const summary = await instance.summarizeProject(PROJECT_ID);
    expect(summary.totalCalls).toBe(remaining.length - 1);
    expect(summary.truncated).toBe(true);
    expect(summary.droppedRecords).toBeGreaterThan(1_000);
    expect(summary.malformedLines).toBe(0);
  }, 30_000);

  it("輪替後還能繼續 append，新舊行混在一起也全部解得開", async () => {
    const { ledger: instance, path } = await ledger();
    const padding = "m".repeat(800);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `${Array.from({ length: 2_600 }, (_, index) =>
        JSON.stringify({
          at: new Date(index + 1).toISOString(),
          capability: "text",
          operation: "outline-draft",
          model: `${padding}-${index + 1}`,
          ok: true,
          usage: { reported: false },
        }),
      ).join("\n")}\n`,
      "utf8",
    );
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    // 扣掉檔頭那一筆截斷紀錄：它不是一次呼叫。
    const afterRotate = (await lines(path)).length - 1;
    for (const attempt of [1, 2, 3])
      await instance.recordProject(
        PROJECT_ID,
        input({ attempt, model: "after-rotate", modelEntryId: "entry-after-rotate" }),
      );
    await instance.idle();
    const summary = await instance.summarizeProject(PROJECT_ID);
    expect(summary.malformedLines).toBe(0);
    expect(summary.totalCalls).toBe(afterRotate + 3);
    expect(
      summary.byModel.find((bucket) => bucket.modelEntryId === "entry-after-rotate"),
    ).toMatchObject({ model: "after-rotate", calls: 3 });
  }, 30_000);
});

describe("壞行的耐受度", () => {
  /**
   * `usage-ledger.test.ts` 只餵了一行語法就壞掉的 JSON。**語法沒壞但形狀不對**是更常見的
   * 情況（改版後的舊紀錄、手動編輯、未來新增的 operation），而它走的是另一條分支
   * （`safeParse` 失敗而非 `JSON.parse` throw）。兩條都必須只丟掉那一行。
   */
  it("語法正確但 schema 不合的行只丟掉自己，其餘統計照常", async () => {
    const { ledger: instance, path } = await ledger();
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    const good = await readFile(path, "utf8");
    await writeFile(
      path,
      [
        good.trim(),
        // 未來版本才有的 operation（封閉聯集擋下）
        JSON.stringify({
          at: "2026-07-29T00:00:00.000Z",
          capability: "text",
          operation: "future-operation",
          ok: true,
          usage: { reported: false },
        }),
        // 多了一個欄位（`.strict()` 擋下——那正是「正文不得混進來」的最後一道）
        JSON.stringify({
          at: "2026-07-29T00:00:00.000Z",
          capability: "text",
          operation: "outline-draft",
          prompt: "UNTRUSTED_INPUT 機密",
          ok: true,
          usage: { reported: false },
        }),
        // usage 缺 reported
        JSON.stringify({
          at: "2026-07-29T00:00:00.000Z",
          capability: "text",
          operation: "outline-draft",
          ok: true,
          usage: {},
        }),
        // 語法就壞掉的一行
        '{"at":"2026-07-29',
        // JSON 合法但根本不是物件
        "null",
        "12345",
        good.trim(),
        "",
      ].join("\n"),
      "utf8",
    );
    const { records, malformedLines } = await instance.readProject(PROJECT_ID);
    expect(records).toHaveLength(2);
    expect(malformedLines).toBe(6);
    const summary = await instance.summarizeProject(PROJECT_ID);
    expect(summary.totalCalls).toBe(2);
    expect(summary.totals.inputTokens).toBe(20);
    expect(summary.malformedLines).toBe(6);
  });

  /**
   * `1e999` 這種數值在 JSON 裡完全合法，`JSON.parse` 給的是 `Infinity`——而 zod 的
   * `z.number()` 拒 `NaN` 卻收 `Infinity`，`nonnegative()` 也擋不住它。收下的代價**不是**
   * 少算一筆，而是整份統計消失：聚合結果變成 `Infinity`，`JSON.stringify` 把它寫成 `null`，
   * 前端的形狀檢查於是拒收整份回應，畫面顯示「格式無法解析」。所以這一行必須跟其他壞行
   * 走同一條路：算進 `malformedLines`，其餘照常。
   */
  it("Infinity 的 token 數當壞行處理，不讓整份統計變成 null", async () => {
    const { ledger: instance, path } = await ledger();
    await instance.recordProject(PROJECT_ID, input());
    await instance.idle();
    const good = (await readFile(path, "utf8")).trim();
    await writeFile(
      path,
      [
        good,
        // 1e999 解析出來就是 Infinity（不是字串、也不是語法錯誤）。
        '{"at":"2026-07-29T00:00:00.000Z","capability":"text","operation":"outline-draft","ok":true,"usage":{"inputTokens":1e999,"reported":true}}',
        // cost 也走同一道閘門。
        '{"at":"2026-07-29T00:00:00.000Z","capability":"text","operation":"outline-draft","ok":true,"usage":{"reported":true,"cost":{"amount":1e999,"unit":"openrouter-credit"}}}',
        "",
      ].join("\n"),
      "utf8",
    );
    const summary = await instance.summarizeProject(PROJECT_ID);
    expect(summary.malformedLines).toBe(2);
    expect(summary.totalCalls).toBe(1);
    expect(Number.isFinite(summary.totals.inputTokens)).toBe(true);
    expect(summary.totals.inputTokens).toBe(10);
    // 整份摘要仍然序列化得出來：這正是收下 Infinity 會壞掉的那一步。
    expect(JSON.parse(JSON.stringify(summary))).toMatchObject({ totalCalls: 1 });
  });

  /**
   * 模型名來自模型庫，是**使用者輸入**。它若能帶著換行進帳本，一行紀錄就能偽造出第二行
   * ——統計會憑空多出一次呼叫，而 JSONL 的每一行是一次「已經花掉的配額」的證據。
   * `JSON.stringify` 會把 `\n` 轉義，這條測試就是釘住「不可改成自己拼字串」。
   */
  it("模型名裡的換行不會偽造出第二筆紀錄", async () => {
    const { ledger: instance, path } = await ledger();
    const forged = JSON.stringify({
      at: "2026-07-29T00:00:00.000Z",
      capability: "text",
      operation: "outline-draft",
      ok: true,
      usage: { inputTokens: 999_999, reported: true },
    });
    await instance.recordProject(
      PROJECT_ID,
      input({ model: `evil\n${forged}`, usage: { inputTokens: 1, reported: true } }),
    );
    await instance.idle();
    expect(await lines(path)).toHaveLength(1);
    const summary = await instance.summarizeProject(PROJECT_ID);
    expect(summary.totalCalls).toBe(1);
    expect(summary.totals.inputTokens).toBe(1);
  });
});

describe("多檔併發", () => {
  /**
   * 逐檔序列化的鏈是以路徑為鍵的。三個檔案同時被寫時，每一份都必須完整——鏈若共用或漏建，
   * 症狀是某一個專案的帳本偶爾少幾行，而那是最難從 UI 察覺的失真。
   */
  it("兩個專案與全域帳本交錯寫入，三份檔案各自完整", async () => {
    const { ledger: instance, root } = await ledger();
    await Promise.all(
      Array.from({ length: 30 }, (_, index) => {
        if (index % 3 === 0)
          return instance.recordProject(PROJECT_ID, input({ attempt: index + 1 }));
        if (index % 3 === 1)
          return instance.recordProject(OTHER_PROJECT_ID, input({ attempt: index + 1 }));
        return instance.recordGlobal(input({ operation: "style-analysis", attempt: index + 1 }));
      }),
    );
    await instance.idle();
    const project = await lines(instance.projectLedgerPath(PROJECT_ID));
    const other = await lines(instance.projectLedgerPath(OTHER_PROJECT_ID));
    const global = await lines(join(root, "usage", "global.jsonl"));
    expect([project.length, other.length, global.length]).toEqual([10, 10, 10]);
    for (const line of [...project, ...other, ...global])
      expect(() => JSON.parse(line)).not.toThrow();
    // 專案之間不得互相汙染：A 的統計只看得到 A 的那 10 筆。
    expect((await instance.summarizeProject(PROJECT_ID)).totalCalls).toBe(10);
    expect((await instance.summarizeProject(OTHER_PROJECT_ID)).totalCalls).toBe(10);
    // 全域那一份不會被算進任何專案。
    expect(global.every((line) => line.includes("style-analysis"))).toBe(true);
  });
});

describe("idle() 的等待範圍", () => {
  /**
   * `idle()` 等的必須是**一次快照**，不是「等到全域清空」。舊版的 `while (outstanding.size)`
   * 會讓專案 A 的統計查詢被專案 B 正在跑的批次記帳無限期擋住——而那是使用者按下「用量」
   * 分頁時唯一會發生的事。
   */
  it("等待期間新排進來的寫入不會把 idle() 一直往後拖", async () => {
    const { ledger: instance } = await ledger();
    // 邊等邊排：舊的條件式迴圈會一路追著新工作跑，快照版只等當下那一批。
    let scheduling = true;
    const flood = (async () => {
      while (scheduling) {
        void instance.recordProject(OTHER_PROJECT_ID, input());
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    await instance.recordProject(PROJECT_ID, input());
    const started = Date.now();
    await instance.idle();
    const waited = Date.now() - started;
    scheduling = false;
    await flood;
    await instance.idle();
    expect(waited).toBeLessThan(1_000);
  });

  /** 查詢路徑要有期限：帳本再慢也不該讓統計頁轉不完。 */
  it("idle(timeoutMs) 在期限內回來，而且不留下 timer 卡住程序", async () => {
    const { ledger: instance } = await ledger();
    void instance.recordProject(PROJECT_ID, input());
    const started = Date.now();
    await instance.idle(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    await instance.idle();
    expect(await lines(instance.projectLedgerPath(PROJECT_ID))).toHaveLength(1);
  });
});

describe("寫入失敗留下的證據", () => {
  /**
   * CLAUDE.md：失敗要留下**可判讀的原因**，但正文與憑證一個字都不進 log。fs 例外的
   * `message` 帶著完整伺服器路徑，`stack` 更多；`#warn` 因此只留錯誤碼與型別名。
   * 這條測試用的是**真的會洩漏的形狀**（EISDIR 的 message 裡就是絕對路徑），拿一個
   * 自己造的乾淨 Error 去測，改壞成 `logWarn(event, fields, error)` 的版本也會通過。
   */
  it("寫不進去時只記事件與錯誤碼，不記路徑、不記例外訊息與 stack", async () => {
    const { ledger: instance, path } = await ledger();
    await mkdir(path, { recursive: true }); // 帳本檔案位置變成目錄 → appendFile 丟 EISDIR
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    restore.push(() => warn.mockRestore());

    await expect(instance.recordProject(PROJECT_ID, input())).resolves.toBeUndefined();
    await instance.idle();

    const logged = warnings.join("\n");
    expect(logged).toContain("usage_ledger_write_failed");
    // 判讀得出來：哪個專案、哪一種呼叫、什麼錯。
    expect(logged).toContain(PROJECT_ID);
    expect(logged).toContain("outline-draft");
    expect(logged).toContain("EISDIR");
    // 但不含路徑、例外訊息與 stack。
    expect(logged).not.toContain(path);
    expect(logged).not.toContain("illegal operation");
    expect(logged).not.toContain("stack");
  });

  it("寫不進去之後，同一個帳本的後續寫入不會被前一次的失敗卡住", async () => {
    const { ledger: instance, path } = await ledger();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    restore.push(() => warn.mockRestore());
    const otherPath = instance.projectLedgerPath(OTHER_PROJECT_ID);
    await mkdir(path, { recursive: true });
    await instance.recordProject(PROJECT_ID, input());
    // 同一個實例、另一個檔案照常寫得進去（鏈是逐檔的，失敗不會傳染）。
    await instance.recordProject(OTHER_PROJECT_ID, input());
    await instance.recordProject(OTHER_PROJECT_ID, input({ attempt: 2 }));
    await instance.idle();
    expect(await lines(otherPath)).toHaveLength(2);
  });
});

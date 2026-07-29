import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileProjectRepository } from "../src/repository.js";
import { UsageLedger, type UsageRecordInput } from "../src/usage-ledger.js";

/**
 * 帳本的 **IO 次數**，獨立成一個檔案是因為它要 mock `node:fs/promises`（vi.mock 是整檔
 * 生效的）。
 *
 * 釘的是一條效能不變量：記帳掛在生成路徑上，而舊版每次 append 都把整個檔案讀回來
 * `split("\n")` 數行——那是 O(n²)，一份接近 5000 行上限的帳本會讓**每一次**記帳都讀
 * 2 MiB。行數改由 `UsageLedger` 自己維護後，整趟只該在開檔時讀一次。
 *
 * 這種東西沒有測試就會被「順手簡化」回去：`countLines(path)` 只有一行，看起來完全人畜無害。
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      reads.push(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

const reads: string[] = [];

afterEach(() => {
  reads.length = 0;
});

function input(patch: Partial<UsageRecordInput> = {}): UsageRecordInput {
  return {
    capability: "text",
    operation: "outline-generate",
    model: "gpt-5.6-luna",
    modelEntryId: "entry-1",
    providerKind: "openai",
    ok: true,
    usage: { inputTokens: 10, outputTokens: 2, reported: true },
    ...patch,
  };
}

describe("append 的讀取次數", () => {
  it("連續 20 次記帳，整個帳本只被讀回來一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-usage-io-"));
    const ledger = new UsageLedger(new FileProjectRepository(root));
    const path = ledger.projectLedgerPath("project-io");
    // 先放一份有份量的既有帳本：O(n²) 的版本會把它重讀 20 次。
    const seeded = Array.from({ length: 500 }, () =>
      JSON.stringify({
        at: new Date().toISOString(),
        capability: "text",
        operation: "outline-generate",
        ok: true,
        usage: { reported: false },
      }),
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${seeded.join("\n")}\n`, "utf8");
    reads.length = 0;

    for (let index = 0; index < 20; index += 1)
      await ledger.recordProject("project-io", input({ attempt: index + 1 }));
    await ledger.idle();

    expect(reads.filter((target) => target === path)).toHaveLength(1);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(520);
  });

  /**
   * 快取只有在「檔案大小正好等於上次大小＋這次寫進去的位元組」時才續用。別的程序（或
   * 測試、或手動編輯）寫大了檔案就重新數——少了這道，被外部灌大的帳本會永遠達不到行數
   * 上限而不輪替，一路長到位元組上限才被發現。
   */
  it("檔案被自己以外的人動過時重新數行", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-usage-io-"));
    const ledger = new UsageLedger(new FileProjectRepository(root));
    const path = ledger.projectLedgerPath("project-io");
    await ledger.recordProject("project-io", input());
    await ledger.idle();
    reads.length = 0;

    // 外部塞進 10 行（帳本並不知情）。
    const extra = Array.from({ length: 10 }, () =>
      JSON.stringify({
        at: new Date().toISOString(),
        capability: "text",
        operation: "search",
        ok: true,
        usage: { reported: false },
      }),
    ).join("\n");
    await writeFile(path, `${await readFile(path, "utf8")}${extra}\n`, "utf8");
    reads.length = 0;

    await ledger.recordProject("project-io", input({ attempt: 2 }));
    await ledger.idle();
    // 對不上就重讀一次把行數校正回來。
    expect(reads.filter((target) => target === path)).toHaveLength(1);
    expect((await ledger.summarizeProject("project-io")).totalCalls).toBe(12);
  });
});

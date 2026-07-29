import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { logWarn, type ProviderUsage } from "@slide-maker/core";

/**
 * 模型用量帳本：append-only JSONL，一行一次模型呼叫。
 *
 * 三條不可退讓的性質：
 *
 * ① **正文一個字都不進帳本**（比照 CLAUDE.md 的 log 規範）。這裡靠**型別**擔保而不是靠
 *    自律：`operation` 是封閉的字面量聯集、其餘欄位只有 id、模型名、數字與時間，寫入時
 *    也是逐欄組裝而非展開呼叫端給的物件——所以沒有任何一條路徑能把 prompt、content、
 *    來源內文或憑證帶進來。`usage-ledger-redaction.test.ts` 直接斷言序列化後不含正文。
 *
 * ② **寫帳本失敗絕不可影響主流程**。所有 IO 都包在自己的 try/catch 裡，失敗只留一行
 *    `logWarn`。記帳是觀測，不是產品功能；讓它有本事弄壞一次生成是完全不成比例的。
 *
 * ③ **不走 `FileProjectRepository.withProjectLock`**。那把鎖是給 `updateProject` 的整份
 *    讀改寫用的，帳本掛上去等於每寫一行就跟專案存檔互相等待——而寫帳本絕不該有本事拖慢
 *    生成。這裡改用**帳本自己的**逐檔序列化：它與 `updateProject` 沒有任何交集，成本是
 *    一次 `appendFile`，而序列化是輪替（見下）唯一需要的東西。
 *
 * 路徑一律經由呼叫端提供的 `projectRoot()`（＝`FileProjectRepository` 那一份，帶
 * `assertSafeSegment` 保護），不在這裡自己拼字串。
 */

/** 帳本檔名（專案目錄下）。 */
const LEDGER_FILENAME = "usage.jsonl";

/**
 * 單一帳本的大小與行數上限，超過就砍掉最舊的一半。
 *
 * 150 頁的 PDF 專案反覆重新生成會讓它無限長，而帳本是**可再生的觀測資料**：留最近的一半
 * 遠比讓一個永遠不收斂的檔案吃掉磁碟合理。兩個上限都要有——只看位元組的話，五千行短紀錄
 * 撐不到 2 MiB 卻已經讓聚合變慢；只看行數的話，異常長的一行仍可能把檔案撐大。
 */
export const USAGE_LEDGER_MAX_BYTES = 2 * 1024 * 1024;
export const USAGE_LEDGER_MAX_LINES = 5_000;

export const USAGE_CAPABILITIES = ["text", "search", "image"] as const;
export type UsageCapability = (typeof USAGE_CAPABILITIES)[number];

/**
 * 可記帳的操作。**刻意是封閉的字面量聯集而不是 `string`**：這是「正文不進帳本」的第一道
 * 型別閘門，新增一種呼叫點必須在這裡具名登記，順手也讓 `byOperation` 的分組鍵不會因為
 * 呼叫端手滑而分裂成兩個。
 */
export const USAGE_OPERATIONS = [
  // 影像三種直接沿用 `generationJobSchema` 的 `operation` 值，不另外改名成 "image"：
  // 帳本要能與 job 逐筆對照，換個名字只會多一層心算。`capability: "image"` 已足以
  // 把 `generate` 與 `outline-generate` 分開。
  "generate",
  "edit",
  "extract-text",
  "search",
  "style-analysis",
  "outline-generate",
  "outline-regenerate",
  "ocr-style-refine",
  "image-description",
] as const;
export type UsageOperation = (typeof USAGE_OPERATIONS)[number];

/** 呼叫端提供的一筆記帳。`at` 由帳本自己蓋，呼叫端不得指定。 */
export interface UsageRecordInput {
  capability: UsageCapability;
  operation: UsageOperation;
  /** 模型庫 entry 的 `providerKind`（codex／openai／gemini／mock／local）。 */
  providerKind?: string;
  /** 模型庫 entry 的模型名（如 `gpt-5.6-luna`）。 */
  model?: string;
  /** 模型庫 entry id。 */
  modelEntryId?: string;
  slideId?: string;
  sourceId?: string;
  /** 重試迴圈的輪次，從 1 起。逐輪各記一筆才看得出大綱到底重跑了幾次。 */
  attempt?: number;
  /** 失敗的呼叫**也要記**：失敗一樣燒配額。 */
  ok: boolean;
  /** provider 回報的用量；未回報時省略，落地時正規化成 `{ reported: false }`。 */
  usage?: ProviderUsage;
}

const providerUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
    cachedTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    imageTokens: z.number().nonnegative().optional(),
    reported: z.boolean(),
    cost: z.object({ amount: z.number(), unit: z.literal("openrouter-credit") }).optional(),
  })
  .strict();

const usageRecordSchema = z
  .object({
    at: z.string(),
    capability: z.enum(USAGE_CAPABILITIES),
    operation: z.enum(USAGE_OPERATIONS),
    providerKind: z.string().optional(),
    model: z.string().optional(),
    modelEntryId: z.string().optional(),
    slideId: z.string().optional(),
    sourceId: z.string().optional(),
    attempt: z.number().int().positive().optional(),
    ok: z.boolean(),
    usage: providerUsageSchema,
  })
  .strict();

export type UsageRecord = z.infer<typeof usageRecordSchema>;

/**
 * 逐欄組裝落地紀錄。**不可**改寫成 `{ ...input, at }`：展開等於把呼叫端物件上的任何多餘
 * 欄位（未來某人不小心塞進來的 prompt 片段）一起寫進檔案，而那正是這個模組要防的事。
 */
function toRecord(input: UsageRecordInput, at: string): UsageRecord {
  return {
    at,
    capability: input.capability,
    operation: input.operation,
    ...(input.providerKind === undefined ? {} : { providerKind: input.providerKind }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.modelEntryId === undefined ? {} : { modelEntryId: input.modelEntryId }),
    ...(input.slideId === undefined ? {} : { slideId: input.slideId }),
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ok: input.ok,
    // usage 缺席一律落成 `{ reported: false }`，**不是** 0：Codex CLI 這條通道天生沒有
    // 數字，補 0 會讓它看起來像「這次沒花 token」，而它正是最耗配額的那一條。
    usage: input.usage ?? { reported: false },
  };
}

/** 帳本需要的儲存位置來源（`FileProjectRepository` 結構上即滿足）。 */
export interface UsageLedgerPaths {
  readonly root: string;
  projectRoot(projectId: string): string;
}

export class UsageLedger {
  readonly #paths: UsageLedgerPaths;
  /** 逐檔的序列化鏈（見類別註解 ③：這不是 project lock）。 */
  readonly #chains = new Map<string, Promise<void>>();
  /** 尚未收尾的寫入，供測試以 `idle()` 等待。 */
  readonly #outstanding = new Set<Promise<void>>();

  constructor(paths: UsageLedgerPaths) {
    this.#paths = paths;
  }

  /** 專案帳本路徑。`projectRoot()` 帶著 `assertSafeSegment`，不自己拼字串。 */
  projectLedgerPath(projectId: string): string {
    return join(this.#paths.projectRoot(projectId), LEDGER_FILENAME);
  }

  /**
   * 無專案脈絡的呼叫（目前只有風格分析）寫這裡。第一版只寫不顯示——沒有專案可以掛，
   * 但把它丟掉會讓「模型庫的文字模型到底被叫了幾次」永遠對不上。
   */
  globalLedgerPath(): string {
    return join(this.#paths.root, "usage", "global.jsonl");
  }

  /** 記一筆專案內的呼叫。永不 reject。 */
  recordProject(projectId: string, input: UsageRecordInput): Promise<void> {
    return this.#record(() => this.projectLedgerPath(projectId), input, { projectId });
  }

  /** 記一筆無專案脈絡的呼叫。永不 reject。 */
  recordGlobal(input: UsageRecordInput): Promise<void> {
    return this.#record(() => this.globalLedgerPath(), input, {});
  }

  /** 等目前所有已排入的寫入結束（測試與關機用）。 */
  async idle(): Promise<void> {
    while (this.#outstanding.size) await Promise.all([...this.#outstanding]);
  }

  /** 讀回專案帳本的所有紀錄。壞掉的行略過並回報數量，不讓一行壞資料炸掉整份統計。 */
  async readProject(
    projectId: string,
  ): Promise<{ records: UsageRecord[]; malformedLines: number }> {
    return readLedger(this.projectLedgerPath(projectId));
  }

  /** 專案用量摘要（伺服器端聚合完成，前端不得自己算）。 */
  async summarizeProject(projectId: string): Promise<UsageSummary> {
    const { records, malformedLines } = await this.readProject(projectId);
    return summarizeUsage(records, malformedLines);
  }

  #record(
    resolvePath: () => string,
    input: UsageRecordInput,
    context: { projectId?: string },
  ): Promise<void> {
    const at = new Date().toISOString();
    let path: string;
    try {
      // `projectRoot()` 對不合法的 id 會 throw；那是設定／呼叫錯誤，不該讓它冒到生成路徑。
      path = resolvePath();
    } catch (error) {
      this.#warn(input, context, error);
      return Promise.resolve();
    }
    const record = toRecord(input, at);
    const previous = this.#chains.get(path) ?? Promise.resolve();
    const next = previous.then(
      () => this.#appendAndRotate(path, record, input, context),
      () => this.#appendAndRotate(path, record, input, context),
    );
    this.#chains.set(path, next);
    this.#outstanding.add(next);
    void next.finally(() => {
      this.#outstanding.delete(next);
      if (this.#chains.get(path) === next) this.#chains.delete(path);
    });
    return next;
  }

  async #appendAndRotate(
    path: string,
    record: UsageRecord,
    input: UsageRecordInput,
    context: { projectId?: string },
  ): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      // 單行遠小於 PIPE_BUF，`O_APPEND` 本身即原子——併發寫入不會互相切斷。
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
      await rotateIfOversized(path);
    } catch (error) {
      this.#warn(input, context, error);
    }
  }

  /**
   * 失敗只留證據。**不把 error 物件整份交給 `logWarn`**：它會序列化 `message` 與 `stack`，
   * 而 fs 錯誤的訊息帶著完整伺服器路徑。只留錯誤碼與型別名就夠指認問題了。
   */
  #warn(input: UsageRecordInput, context: { projectId?: string }, error: unknown): void {
    logWarn("usage_ledger_write_failed", {
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      capability: input.capability,
      operation: input.operation,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode:
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined,
    });
  }
}

/**
 * 超過上限就砍掉最舊的一半。
 *
 * 用「讀進來 → 留新的一半 → 寫暫存 → rename」而不是原地截斷：截斷會讓正在讀的聚合看到
 * 半行。已知取捨：輪替期間若有另一個程序在 append，那幾行會落在被換掉的舊 inode 上而遺失。
 * 帳本是可再生的觀測資料，而輪替本身很罕見，這比讓帳本無限成長好。同程序內的併發由
 * `UsageLedger` 的逐檔序列化擋掉。
 */
async function rotateIfOversized(path: string): Promise<void> {
  const size = (await stat(path)).size;
  const lines = size > USAGE_LEDGER_MAX_BYTES ? undefined : await countLines(path);
  if (size <= USAGE_LEDGER_MAX_BYTES && (lines ?? 0) <= USAGE_LEDGER_MAX_LINES) return;
  const content = await readFile(path, "utf8");
  const all = content.split("\n").filter((line) => line.trim() !== "");
  const kept = all.slice(Math.ceil(all.length / 2));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 只為了行數上限而數行；位元組上限先擋在前面，所以這條路的檔案本來就不大。 */
async function countLines(path: string): Promise<number> {
  const content = await readFile(path, "utf8");
  let count = 0;
  for (const line of content.split("\n")) if (line.trim() !== "") count += 1;
  return count;
}

async function readLedger(
  path: string,
): Promise<{ records: UsageRecord[]; malformedLines: number }> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { records: [], malformedLines: 0 };
    throw error;
  }
  const records: UsageRecord[] = [];
  let malformedLines = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 崩在寫到一半的那一行（或手動編輯過的檔案）不該讓整份統計消失。
      malformedLines += 1;
      continue;
    }
    const candidate = usageRecordSchema.safeParse(parsed);
    if (candidate.success) records.push(candidate.data);
    else malformedLines += 1;
  }
  return { records, malformedLines };
}

// ── 聚合 ──────────────────────────────────────────────────────────────────────

export interface UsageBucket {
  calls: number;
  /** provider 真的回報了用量的筆數。`calls - reportedCalls` 就是未回報數。 */
  reportedCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  imageTokens: number;
  totalTokens: number;
}

export interface UsageModelBucket extends UsageBucket {
  modelEntryId: string;
  model: string;
  providerKind: string;
}

export interface UsageSummary {
  totalCalls: number;
  reportedCalls: number;
  /** 明確算出來給前端，而不是要它自己減——前端不得鏡射伺服器的計算。 */
  unreportedCalls: number;
  failedCalls: number;
  totals: UsageBucket;
  byCapability: Record<string, UsageBucket>;
  byOperation: Record<string, UsageBucket>;
  /** 依 calls 由多到少排序（同數時以 modelEntryId 穩定排序）。 */
  byModel: UsageModelBucket[];
  /** 金額 UI 尚未實作；欄位先留，解析到的原值直接加總。 */
  cost: { unit: "openrouter-credit"; amount: number } | undefined;
  firstAt: string | undefined;
  lastAt: string | undefined;
  malformedLines: number;
}

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    reportedCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    imageTokens: 0,
    totalTokens: 0,
  };
}

/**
 * 把一筆紀錄併進一個桶。
 *
 * **未回報的呼叫只計入 `calls`，一個 token 都不加。** 把 `reported:false` 當成 0 加總會讓
 * 「這條通道沒回報」被平均進總數裡，而使用者看到的會是一個看似精確、實際上系統性低估的
 * 數字——那比誠實地說「其中 N 次未回報」糟得多。
 */
function accumulate(bucket: UsageBucket, record: UsageRecord): void {
  bucket.calls += 1;
  if (!record.ok) bucket.failedCalls += 1;
  if (!record.usage.reported) return;
  bucket.reportedCalls += 1;
  bucket.inputTokens += record.usage.inputTokens ?? 0;
  bucket.outputTokens += record.usage.outputTokens ?? 0;
  bucket.reasoningTokens += record.usage.reasoningTokens ?? 0;
  bucket.cachedTokens += record.usage.cachedTokens ?? 0;
  bucket.imageTokens += record.usage.imageTokens ?? 0;
  bucket.totalTokens += record.usage.totalTokens ?? 0;
}

function bucketOf(map: Record<string, UsageBucket>, key: string): UsageBucket {
  const existing = map[key];
  if (existing) return existing;
  const created = emptyBucket();
  map[key] = created;
  return created;
}

export function summarizeUsage(records: readonly UsageRecord[], malformedLines = 0): UsageSummary {
  const totals = emptyBucket();
  const byCapability: Record<string, UsageBucket> = {};
  const byOperation: Record<string, UsageBucket> = {};
  const byModel = new Map<string, UsageModelBucket>();
  let costAmount = 0;
  let costSeen = false;
  let firstAt: string | undefined;
  let lastAt: string | undefined;

  for (const record of records) {
    accumulate(totals, record);
    accumulate(bucketOf(byCapability, record.capability), record);
    accumulate(bucketOf(byOperation, record.operation), record);
    // 三個識別欄位都可能缺（Codex 沒有 entry、舊紀錄沒有 model）：分組鍵用 entry id，
    // 缺了就退到模型名，兩者都缺才落到 "unknown"——不可直接丟掉這些筆數。
    const key = record.modelEntryId ?? record.model ?? "unknown";
    const model = byModel.get(key) ?? {
      ...emptyBucket(),
      modelEntryId: record.modelEntryId ?? "",
      model: record.model ?? "",
      providerKind: record.providerKind ?? "",
    };
    accumulate(model, record);
    byModel.set(key, model);
    if (record.usage.cost) {
      costAmount += record.usage.cost.amount;
      costSeen = true;
    }
    if (firstAt === undefined || record.at < firstAt) firstAt = record.at;
    if (lastAt === undefined || record.at > lastAt) lastAt = record.at;
  }

  return {
    totalCalls: totals.calls,
    reportedCalls: totals.reportedCalls,
    unreportedCalls: totals.calls - totals.reportedCalls,
    failedCalls: totals.failedCalls,
    totals,
    byCapability,
    byOperation,
    byModel: [...byModel.entries()]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          right.calls - left.calls || leftKey.localeCompare(rightKey),
      )
      .map(([, bucket]) => bucket),
    cost: costSeen ? { unit: "openrouter-credit", amount: costAmount } : undefined,
    firstAt,
    lastAt,
    malformedLines,
  };
}

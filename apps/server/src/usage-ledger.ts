import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { logWarn, type ProviderUsage } from "@slide-maker/core";
import { assertSafeSegment } from "./repository.js";

/**
 * 模型用量帳本：append-only JSONL，一行一次模型呼叫。
 *
 * 四條不可退讓的性質：
 *
 * ① **正文一個字都不進帳本**（比照 CLAUDE.md 的 log 規範）。這裡靠**型別**擔保而不是靠
 *    自律：`operation` 是封閉的字面量聯集、其餘欄位只有 id、模型名、數字與時間，寫入時
 *    也是逐欄組裝而非展開呼叫端給的物件——所以沒有任何一條路徑能把 prompt、content、
 *    來源內文或憑證帶進來。`usage-ledger.test.ts` 直接斷言序列化後不含正文。
 *
 * ② **寫帳本失敗絕不可影響主流程**。所有 IO 都包在自己的 try/catch 裡，失敗只留一行
 *    `logWarn`。記帳是觀測，不是產品功能；讓它有本事弄壞一次生成是完全不成比例的。
 *    **讀**也一樣：一個觀測用檔案的權限問題不該讓統計頁變成 500（見 `readLedger`）。
 *
 * ③ **不走 `FileProjectRepository.withProjectLock`**。那把鎖是給 `updateProject` 的整份
 *    讀改寫用的，帳本掛上去等於每寫一行就跟專案存檔互相等待——而寫帳本絕不該有本事拖慢
 *    生成。這裡改用**帳本自己的**逐檔序列化：它與 `updateProject` 沒有任何交集，成本是
 *    一次 `appendFile`，而序列化是輪替（見下）唯一需要的東西。
 *
 * ④ **帳本存在專案目錄之外**（`<DATA_ROOT>/usage/<projectId>.jsonl`）。兩個理由都是實測
 *    出來的：`exporters.ts` 的 `collectFiles()` 無條件遞迴整個專案目錄，帳本放在裡面就會
 *    被打包進使用者分享出去的 `.slide-project`（匯入端只讀 `assets/` 前綴，所以它在 zip
 *    裡是 100% 死重，還吃掉 CLAUDE.md 那條 32 MiB 匯出預算）；而刪除專案時被取消的 job
 *    仍會走到 `recordProject` → `mkdir(recursive)`，競態下會把剛刪掉的專案目錄「復活」成
 *    一個只含 `usage.jsonl` 的空殼。專案 id 仍要過 `assertSafeSegment`（與 repository
 *    同一份），不可自己拼字串。
 *    專案 id 一律是 `randomUUID()`（新建與匯入都是），所以與同層的 `global.jsonl` 撞名
 *    不可能發生。
 */

/** 帳本目錄（DATA_ROOT 底下）。 */
const LEDGER_DIRECTORY = "usage";

/**
 * 單一帳本的大小與行數上限，超過就砍掉最舊的一半。
 *
 * 150 頁的 PDF 專案反覆重新生成會讓它無限長，而帳本是**可再生的觀測資料**：留最近的一半
 * 遠比讓一個永遠不收斂的檔案吃掉磁碟合理。兩個上限都要有——只看位元組的話，五千行短紀錄
 * 撐不到 2 MiB 卻已經讓聚合變慢；只看行數的話，異常長的一行仍可能把檔案撐大。
 *
 * 砍掉的那一半**必須留下痕跡**（見 `truncationMarkerSchema`）：UI 上的「本專案總計」在
 * 長壽專案裡會是錯的，而使用者無從察覺——一個沒有標註的錯誤數字比一個標著「已截斷」的
 * 數字糟得多。
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
  // 把 `generate` 與大綱那幾種分開。
  "generate",
  "edit",
  "extract-text",
  "search",
  "style-analysis",
  // 整份大綱是**兩階段兩個值**，不是一個 `outline-generate` 再靠 `attempt` 區分：規劃只看
  // 目錄裡的一句摘要、寫稿扛著整批正文片段，兩者的 prompt 規模差一個數量級，混進同一格
  // `byOperation` 就答不出「哪一階段在燒配額」。寫稿那格的 `calls` 同時就是重試輪數。
  "outline-plan",
  "outline-draft",
  "outline-regenerate",
  "ocr-style-refine",
  "image-description",
] as const;
export type UsageOperation = (typeof USAGE_OPERATIONS)[number];

/**
 * 沒有碰到任何模型的 provider 種類（見 `packages/core/src/model-library.ts` 的
 * `providerKindSchema`）。這些呼叫**沒有燒掉任何配額**，所以不可以混進「未回報」——
 * 那個數字的語意是「燒了配額但不知道燒多少」。批次抽字會叫幾十次 local-inpaint，
 * 混在一起會讓未回報數膨脹得很難看，也讓它失去指出「哪個 gateway 不回報用量」的能力。
 */
const LOCAL_PROVIDER_KINDS = new Set(["mock", "local"]);

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
  /**
   * 這一筆實際送出的 HTTP 請求數（provider 內部對暫時性失敗自己重試時 > 1）。
   *
   * 與 `attempt` 不同：`attempt` 是**應用層**重試迴圈的輪次（一輪一筆紀錄），`requests`
   * 是**這一輪之內**打了幾次。少了它，`calls` 只是「邏輯呼叫數」，而 UI 上「到底重跑了
   * 幾次」問不出來。缺席一律當 1。
   */
  requests?: number;
  /**
   * **provider 往返成功＝`true`（配額已經燒掉）**，往返本身失敗（逾時、連不上、gateway
   * 4xx/5xx、取消）＝`false`。
   *
   * 這個定義刻意**不包含**「回來的東西合不合用」：模型回了但 schema 對不上、回了但一筆
   * 可驗證的搜尋結果都沒有——那些呼叫的 token 一樣燒光了，帳本要回答的是「燒了多少」，
   * 記成 `false` 會讓它回答不了。整輪是否成功由呼叫端自己的錯誤路徑負責回報，不是帳本
   * 的欄位。**失敗的往返也要記**：連不上之前的那次請求可能已經送出去了，而重試迴圈跑滿
   * 的那些最貴的情況正好都在這條路上。
   */
  ok: boolean;
  /** provider 回報的用量；未回報時省略，落地時正規化成 `{ reported: false }`。 */
  usage?: ProviderUsage;
}

/**
 * 每一個數字欄位都要 `.finite()`。zod 的 `z.number()` 拒 `NaN` 但**收下 `Infinity`**，而
 * 帳本是一行一行的 JSON：`"inputTokens": 1e999` 解出來就是 `Infinity`、過得了
 * `nonnegative()`、一路加進聚合，最後 `JSON.stringify` 把它輸出成 `null`——前端的形狀檢查
 * （12 個數字鍵）於是整份拒收，畫面顯示「格式無法解析」，其餘幾百筆正常紀錄跟著消失。
 * 擋在這裡的話它只是又一行壞資料：算進 `malformedLines`，其餘照常顯示。
 */
const finiteNonNegative = () => z.number().finite().nonnegative();

const providerUsageSchema = z
  .object({
    inputTokens: finiteNonNegative().optional(),
    outputTokens: finiteNonNegative().optional(),
    reasoningTokens: finiteNonNegative().optional(),
    cachedTokens: finiteNonNegative().optional(),
    totalTokens: finiteNonNegative().optional(),
    imageTokens: finiteNonNegative().optional(),
    reported: z.boolean(),
    cost: z
      .object({ amount: z.number().finite(), unit: z.literal("openrouter-credit") })
      .optional(),
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
    requests: z.number().int().positive().optional(),
    ok: z.boolean(),
    usage: providerUsageSchema,
  })
  .strict();

export type UsageRecord = z.infer<typeof usageRecordSchema>;

/**
 * 輪替留下的痕跡：**這份帳本已經丟掉過 N 筆**。
 *
 * 刻意寫在帳本自己的第一行而不是另開一個 marker 檔：它跟著檔案一起被刪、一起被複製，
 * 也不會出現「帳本沒了 marker 還在」這種對不起來的狀態。每次輪替都會把先前 marker 的
 * 數字併進新的一筆（見 `rotate`），所以一旦截斷過就永遠標著截斷。
 */
const truncationMarkerSchema = z
  .object({
    at: z.string(),
    truncated: z.literal(true),
    droppedRecords: z.number().int().nonnegative(),
  })
  .strict();

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
    ...(input.requests === undefined ? {} : { requests: input.requests }),
    ok: input.ok,
    // usage 缺席一律落成 `{ reported: false }`，**不是** 0：Codex CLI 這條通道天生沒有
    // 數字，補 0 會讓它看起來像「這次沒花 token」，而它正是最耗配額的那一條。
    usage: input.usage ?? { reported: false },
  };
}

/** 帳本需要的儲存位置來源（`FileProjectRepository` 結構上即滿足）。 */
export interface UsageLedgerPaths {
  readonly root: string;
}

/** 一次讀取的結果。`unreadable` 是「這份統計不可信」的訊號，不是錯誤。 */
export interface UsageLedgerContents {
  records: UsageRecord[];
  malformedLines: number;
  /** 輪替砍掉過紀錄：`totals` 不是全部的歷史。 */
  truncated: boolean;
  /** 被輪替砍掉的紀錄數（累計）。 */
  droppedRecords: number;
  /** 檔案存在但讀不出來（權限、IO 錯誤）。空結果＋這個旗標，不 throw。 */
  unreadable: boolean;
}

export class UsageLedger {
  readonly #paths: UsageLedgerPaths;
  /** 逐檔的序列化鏈（見類別註解 ③：這不是 project lock）。 */
  readonly #chains = new Map<string, Promise<void>>();
  /** 尚未收尾的寫入，供 `idle()` 等待。 */
  readonly #outstanding = new Set<Promise<void>>();
  /**
   * 逐檔的行數與「我們最後看到的檔案大小」。
   *
   * **不可**改回「每次 append 都讀整個檔再 `split("\n")` 數行」：那是 O(n²)，一份接近上限
   * 的帳本會讓每一次記帳都讀 2 MiB，而記帳掛在生成路徑上。開檔時數一次、之後 +1、輪替後
   * 重設；寫入失敗就把它刪掉（狀態不明，下次重新數）。
   *
   * 大小一起記是為了**察覺自己以外的寫入**（別的程序、測試、手動編輯）：append 之後的
   * 實際大小與「上次大小＋這次寫進去的位元組」對不上，就代表這份快取已經不可信，重新數
   * 一次。少了這道，被外部寫大的檔案會永遠達不到行數上限而不輪替。
   */
  readonly #lines = new Map<string, { lines: number; size: number }>();

  constructor(paths: UsageLedgerPaths) {
    this.#paths = paths;
  }

  /** 專案帳本路徑。id 過 `assertSafeSegment`（與 repository 同一份），不自己另立規則。 */
  projectLedgerPath(projectId: string): string {
    assertSafeSegment(projectId);
    return join(this.#paths.root, LEDGER_DIRECTORY, `${projectId}.jsonl`);
  }

  /**
   * 無專案脈絡的呼叫（目前只有風格分析）寫這裡。第一版只寫不顯示——沒有專案可以掛，
   * 但把它丟掉會讓「模型庫的文字模型到底被叫了幾次」永遠對不上。
   */
  globalLedgerPath(): string {
    return join(this.#paths.root, LEDGER_DIRECTORY, "global.jsonl");
  }

  /** 記一筆專案內的呼叫。永不 reject。 */
  recordProject(projectId: string, input: UsageRecordInput): Promise<void> {
    return this.#record(() => this.projectLedgerPath(projectId), input, { projectId });
  }

  /** 記一筆無專案脈絡的呼叫。永不 reject。 */
  recordGlobal(input: UsageRecordInput): Promise<void> {
    return this.#record(() => this.globalLedgerPath(), input, {});
  }

  /**
   * 刪掉一個專案的帳本（專案被刪除時）。永不 reject——刪不掉一個觀測用檔案不該讓
   * 「刪除專案」失敗。
   */
  async deleteProject(projectId: string): Promise<void> {
    let path: string;
    try {
      path = this.projectLedgerPath(projectId);
    } catch {
      return;
    }
    // 排在既有寫入之後，免得刪完又被一筆 in-flight 的記帳重新建出來。
    const previous = this.#chains.get(path) ?? Promise.resolve();
    const next = previous.then(
      () => this.#remove(path, projectId),
      () => this.#remove(path, projectId),
    );
    this.#chains.set(path, next);
    this.#track(path, next);
    return next;
  }

  /**
   * 等目前所有**已排入**的寫入結束。
   *
   * 刻意是「等一次快照」而不是 `while (outstanding.size)`：後者等的是**全域**的清空，
   * 專案 A 的統計查詢會被專案 B 正在跑的批次記帳無限期擋住。`timeoutMs` 給查詢路徑用——
   * 聚合允許少算最後一筆，但不允許讓使用者盯著一個轉不完的圈。
   */
  async idle(timeoutMs?: number): Promise<void> {
    const pending = [...this.#outstanding];
    if (!pending.length) return;
    const settled = Promise.allSettled(pending).then(() => undefined);
    if (timeoutMs === undefined) return settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 讀回專案帳本的所有紀錄。壞掉的行略過並回報數量，不讓一行壞資料炸掉整份統計。 */
  async readProject(projectId: string): Promise<UsageLedgerContents> {
    let path: string;
    try {
      path = this.projectLedgerPath(projectId);
    } catch {
      return {
        records: [],
        malformedLines: 0,
        truncated: false,
        droppedRecords: 0,
        unreadable: false,
      };
    }
    return readLedger(path, { projectId });
  }

  /** 專案用量摘要（伺服器端聚合完成，前端不得自己算）。 */
  async summarizeProject(projectId: string): Promise<UsageSummary> {
    return summarizeUsage(await this.readProject(projectId));
  }

  #record(
    resolvePath: () => string,
    input: UsageRecordInput,
    context: { projectId?: string },
  ): Promise<void> {
    const at = new Date().toISOString();
    let path: string;
    try {
      // 不合法的 id 會 throw；那是設定／呼叫錯誤，不該讓它冒到生成路徑。
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
    this.#track(path, next);
    return next;
  }

  /** 把一次排入的工作掛進 `#outstanding`，並在收尾時清掉自己那一條鏈。 */
  #track(path: string, work: Promise<void>): void {
    this.#outstanding.add(work);
    void work.finally(() => {
      this.#outstanding.delete(work);
      if (this.#chains.get(path) === work) this.#chains.delete(path);
    });
  }

  async #remove(path: string, projectId: string): Promise<void> {
    try {
      await rm(path, { force: true });
      this.#lines.delete(path);
    } catch (error) {
      logWarn("usage_ledger_delete_failed", {
        projectId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: errorCodeOf(error),
      });
    }
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
      // mode 與 repository 的 `writeProject` 對齊：帳本雖無正文，仍是使用者的用量紀錄。
      const line = `${JSON.stringify(record)}\n`;
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      const size = (await stat(path)).size;
      const known = this.#lines.get(path);
      const lines =
        known && known.size + Buffer.byteLength(line, "utf8") === size
          ? known.lines + 1
          : await countLines(path);
      this.#lines.set(path, { lines, size });
      if (lines > USAGE_LEDGER_MAX_LINES || size > USAGE_LEDGER_MAX_BYTES) {
        const rotated = await rotate(path);
        this.#lines.set(path, { lines: rotated, size: (await stat(path)).size });
      }
    } catch (error) {
      // 這一行到底寫進去了沒有、輪替寫到哪裡，都不確定；行數快取一併作廢。
      this.#lines.delete(path);
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
      errorCode: errorCodeOf(error),
    });
  }
}

/** 例外的 `code`（fs 錯誤有，其餘沒有）。**只取這個**，訊息與 stack 一律不取。 */
function errorCodeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * 超過上限就砍掉最舊的一半，並在檔頭留下一筆截斷紀錄。回傳輪替後的行數。
 *
 * 用「讀進來 → 留新的一半 → 寫暫存 → rename」而不是原地截斷：截斷會讓正在讀的聚合看到
 * 半行。已知取捨：輪替期間若有另一個程序在 append，那幾行會落在被換掉的舊 inode 上而遺失。
 * 帳本是可再生的觀測資料，而輪替本身很罕見，這比讓帳本無限成長好。同程序內的併發由
 * `UsageLedger` 的逐檔序列化擋掉。
 */
async function rotate(path: string): Promise<number> {
  const content = await readFile(path, "utf8");
  const all = content.split("\n").filter((line) => line.trim() !== "");
  // 先前輪替留下的 marker 不算紀錄，但它記的數字要繼承下去——否則第二次輪替會把
  // 「已經丟過多少」歸零，統計就會宣稱自己是完整的。
  let inherited = 0;
  const body: string[] = [];
  for (const line of all) {
    const dropped = markerDroppedRecords(line);
    if (dropped === undefined) body.push(line);
    else inherited += dropped;
  }
  const kept = body.slice(Math.ceil(body.length / 2));
  const marker = JSON.stringify({
    at: new Date().toISOString(),
    truncated: true,
    droppedRecords: inherited + (body.length - kept.length),
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${[marker, ...kept].join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return kept.length + 1;
}

/** 這一行是不是截斷紀錄；是的話回它記的筆數。 */
function markerDroppedRecords(line: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const marker = truncationMarkerSchema.safeParse(parsed);
  return marker.success ? marker.data.droppedRecords : undefined;
}

/** 首次開檔時數一次行數；之後由 `UsageLedger#lines` 逐次遞增（見該欄位註解）。 */
async function countLines(path: string): Promise<number> {
  const content = await readFile(path, "utf8");
  let count = 0;
  for (const line of content.split("\n")) if (line.trim() !== "") count += 1;
  return count;
}

async function readLedger(
  path: string,
  context: { projectId?: string },
): Promise<UsageLedgerContents> {
  const empty: UsageLedgerContents = {
    records: [],
    malformedLines: 0,
    truncated: false,
    droppedRecords: 0,
    unreadable: false,
  };
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    // 讀取端要有與寫入端同一份紀律：**吞掉所有錯誤**、只留錯誤碼。
    // 往上拋等於讓 `GET /usage` 落到通用 handler 回 500，而那個 handler 會把
    // `error.message`（EACCES 的訊息就是完整伺服器絕對路徑）整份序列化進 log。
    // 一個觀測用檔案的權限問題不該讓統計頁掛掉，也不該換來一行路徑外洩。
    logWarn("usage_ledger_read_failed", {
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: errorCodeOf(error),
    });
    return { ...empty, unreadable: true };
  }
  const records: UsageRecord[] = [];
  let malformedLines = 0;
  let truncated = false;
  let droppedRecords = 0;
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
    if (candidate.success) {
      records.push(candidate.data);
      continue;
    }
    const marker = truncationMarkerSchema.safeParse(parsed);
    if (marker.success) {
      truncated = true;
      droppedRecords += marker.data.droppedRecords;
      continue;
    }
    malformedLines += 1;
  }
  return { records, malformedLines, truncated, droppedRecords, unreadable: false };
}

// ── 聚合 ──────────────────────────────────────────────────────────────────────

export interface UsageBucket {
  /** 邏輯呼叫數（一筆紀錄一次）。 */
  calls: number;
  /** 實際送出的 HTTP 請求數（含 provider 內部重試）。舊紀錄沒有這個欄位，一律當 1。 */
  requests: number;
  /** provider 真的回報了用量的筆數。 */
  reportedCalls: number;
  /**
   * 燒了配額、但模型端沒回報用了多少的筆數（`calls - reportedCalls - localCalls`）。
   *
   * **由伺服器算好給前端，而不是讓它自己減**（見 `UsageSummary.unreportedCalls`）：頂層與
   * 分組走的是 `accumulate()` 裡**同一段**程式碼，所以頂層的未回報數必然等於各分組相加，
   * 「拿分組拆解頂層數字」才驗得起來。前端補算等於維護第二份會漂移的定義。
   */
  unreportedCalls: number;
  /** 本機 provider（mock／local）的筆數：沒碰模型、沒燒配額，不算未回報。 */
  localCalls: number;
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
  totalRequests: number;
  reportedCalls: number;
  /**
   * 明確算出來給前端，而不是要它自己減——前端不得鏡射伺服器的計算。
   * 與 `totals.unreportedCalls` 是同一個數字（分組桶也有這一格，見 `UsageBucket`）。
   */
  unreportedCalls: number;
  /** 本機 provider 的呼叫數（沒燒配額，與「未回報」是兩件事）。 */
  localCalls: number;
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
  /** 帳本輪替過：這份統計**不是**專案的全部歷史，UI 必須說出來。 */
  truncated: boolean;
  /** 被輪替砍掉的紀錄數（累計）。 */
  droppedRecords: number;
  /** 帳本存在卻讀不出來：數字是空的，但那不代表沒有呼叫過。 */
  unreadable: boolean;
}

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    requests: 0,
    reportedCalls: 0,
    unreportedCalls: 0,
    localCalls: 0,
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
  bucket.requests += record.requests ?? 1;
  if (!record.ok) bucket.failedCalls += 1;
  if (!record.usage.reported) {
    // 本機 provider 與「回報不了的 gateway」要分開數，否則批次抽字會讓未回報數膨脹到
    // 看不出真正的問題在哪（見 LOCAL_PROVIDER_KINDS）。
    // 未回報數在**這裡**算，頂層與每一個分組桶因此共用同一段程式碼——`UsageSummary`
    // 的頂層欄位直接取自 `totals`，不另立第二條規則。
    if (record.providerKind !== undefined && LOCAL_PROVIDER_KINDS.has(record.providerKind))
      bucket.localCalls += 1;
    else bucket.unreportedCalls += 1;
    return;
  }
  bucket.reportedCalls += 1;
  const inputTokens = record.usage.inputTokens ?? 0;
  const outputTokens = record.usage.outputTokens ?? 0;
  bucket.inputTokens += inputTokens;
  bucket.outputTokens += outputTokens;
  bucket.reasoningTokens += record.usage.reasoningTokens ?? 0;
  bucket.cachedTokens += record.usage.cachedTokens ?? 0;
  bucket.imageTokens += record.usage.imageTokens ?? 0;
  // 回了 in/out 卻沒回 total 的 gateway（CLIProxyAPI 各家 translator 行為不一致）不可以
  // 讓 totalTokens 少一截：那正是 UI 最可能拿去當頭條的數字，而它會錯得很安靜。
  // 退回 in+out 就好，**不要**再把 reasoning 加上去——OpenAI 的 completion_tokens 已含
  // reasoning，重複加會反過來高估；Gemini 一定回 totalTokenCount，走不到這條。
  bucket.totalTokens += record.usage.totalTokens ?? inputTokens + outputTokens;
}

function bucketOf(map: Record<string, UsageBucket>, key: string): UsageBucket {
  const existing = map[key];
  if (existing) return existing;
  const created = emptyBucket();
  map[key] = created;
  return created;
}

/**
 * 聚合成前端要顯示的摘要。
 *
 * 收 `UsageLedgerContents`（帶著 `truncated`／`unreadable` 這些「這份數字可不可信」的訊號）；
 * 只給一個 records 陣列時視同「一份完整讀得出來的帳本」，那是測試在用的形式。
 */
export function summarizeUsage(input: readonly UsageRecord[] | UsageLedgerContents): UsageSummary {
  const contents: UsageLedgerContents = Array.isArray(input)
    ? {
        records: input,
        malformedLines: 0,
        truncated: false,
        droppedRecords: 0,
        unreadable: false,
      }
    : (input as UsageLedgerContents);
  const totals = emptyBucket();
  const byCapability: Record<string, UsageBucket> = {};
  const byOperation: Record<string, UsageBucket> = {};
  const byModel = new Map<string, { bucket: UsageModelBucket; identifiedAt: string }>();
  let costAmount = 0;
  let costSeen = false;
  let firstAt: string | undefined;
  let lastAt: string | undefined;

  for (const record of contents.records) {
    accumulate(totals, record);
    accumulate(bucketOf(byCapability, record.capability), record);
    accumulate(bucketOf(byOperation, record.operation), record);
    // 三個識別欄位都可能缺（Codex 沒有 entry、舊紀錄沒有 model）：分組鍵用 entry id，
    // 缺了就退到模型名，兩者都缺才落到 "unknown"——不可直接丟掉這些筆數。
    const key = record.modelEntryId ?? record.model ?? "unknown";
    const existing = byModel.get(key);
    const entry = existing ?? {
      bucket: {
        ...emptyBucket(),
        modelEntryId: record.modelEntryId ?? "",
        model: record.model ?? "",
        providerKind: record.providerKind ?? "",
      },
      identifiedAt: record.at,
    };
    // 顯示名取**最近**一筆而不是第一筆：模型庫改過名字（或換了 providerKind）之後，
    // 整組統計會一直掛著舊名，而使用者在模型庫裡已經找不到那個名字了。
    if (existing && record.at >= existing.identifiedAt) {
      entry.identifiedAt = record.at;
      entry.bucket.modelEntryId = record.modelEntryId ?? "";
      entry.bucket.model = record.model ?? "";
      entry.bucket.providerKind = record.providerKind ?? "";
    }
    accumulate(entry.bucket, record);
    byModel.set(key, entry);
    // cost 與 token 走**同一個閘門**：`reported:false` 卻帶著 cost 的紀錄（目前產生不出來，
    // 但 schema 允許）不可以偷偷被算進金額，否則同一份摘要裡會有兩套納入規則。
    if (record.usage.reported && record.usage.cost) {
      costAmount += record.usage.cost.amount;
      costSeen = true;
    }
    if (firstAt === undefined || record.at < firstAt) firstAt = record.at;
    if (lastAt === undefined || record.at > lastAt) lastAt = record.at;
  }

  return {
    totalCalls: totals.calls,
    totalRequests: totals.requests,
    reportedCalls: totals.reportedCalls,
    // 頂層就是 `totals` 桶的那一格：與 `byCapability`／`byOperation`／`byModel` 走同一段
    // `accumulate()`，頂層才拆得回分組（先前這裡自己減一次，等於同一個定義有兩份實作）。
    unreportedCalls: totals.unreportedCalls,
    localCalls: totals.localCalls,
    failedCalls: totals.failedCalls,
    totals,
    byCapability,
    byOperation,
    byModel: [...byModel.entries()]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          right.bucket.calls - left.bucket.calls || leftKey.localeCompare(rightKey),
      )
      .map(([, entry]) => entry.bucket),
    cost: costSeen ? { unit: "openrouter-credit", amount: costAmount } : undefined,
    firstAt,
    lastAt,
    malformedLines: contents.malformedLines,
    truncated: contents.truncated,
    droppedRecords: contents.droppedRecords,
    unreadable: contents.unreadable,
  };
}

import {
  attachProviderCallFacts,
  mergeUsage,
  type ProviderUsage,
  SafeProviderError,
  type StructuredTextResult,
} from "./providers.js";

export interface StructuredRetryOptions {
  /**
   * 送出一輪請求並回傳已解析的 payload。每呼叫一次＝一個真實 HTTP 往返；端點、認證、
   * signal 的掛法（openai 條件展開 vs gemini 位置參數）與逾時全部封在呼叫端的 closure
   * 裡——helper 不碰 `config.timeoutMs`，也不讀 `StructuredTextRequest.timeoutMs`
   * （那個欄位目前沒有任何 provider 會讀，靠它等於沒有上限）。
   */
  request: () => Promise<unknown>;
  /**
   * wire 形狀專屬的用量解析器。**必須是參數而不能內建**：四個解析器對應四種互不重疊的
   * wire 形狀，「非該形狀一律 `reported:false`」由 `usage-cross-shape.test.ts` 的交叉矩陣
   * 釘死，任何「順便統一形狀判別」都是行為改變。
   */
  parseUsage: (payload: unknown) => ProviderUsage;
  /**
   * payload → 結果值。丟出的 `SafeProviderError` 必須帶呼叫端自己前綴的錯誤碼
   * （`OPENAI_`／`GEMINI_`）——helper 本身不得產生任何帶前綴的碼，否則 gemini 路徑會
   * 漏出 `OPENAI_` 前綴。
   */
  parseValue: (payload: unknown) => unknown;
  /** 值得重試的錯誤碼集合。不在集合內（含非 `SafeProviderError`）一律當輪就丟。 */
  transientCodes: ReadonlySet<string>;
  /** 最多幾輪，須 >= 1。預設 3；兩個 provider 都不傳，參數是為了讓迴圈上界可被測試。 */
  maxAttempts?: number;
}

/**
 * 結構化文字生成的共用重試迴圈：對「解析失敗」這類暫時性錯誤重試數次。
 *
 * 抽出來的理由是兩個 HTTP `StructuredTextProvider`（OpenAI-compatible 的
 * `/chat/completions` 與 Gemini 原生 `:generateContent`）的迴圈逐行同構，差異全部落在
 * 參數上。helper 刻意不決定錯誤種類、不碰 log、不碰逾時：錯誤碼前綴是跨套件的黏著點
 * （`rethrowAsGeminiError` 靠字串前綴換牌），helper 產生任何帶前綴的碼都會漏牌。
 *
 * 重試存在的理由：瀏覽／推理模型（尤其 Gemini）偶發回非 JSON／空內容——例如整個
 * candidate 只剩 thought part。
 *
 * **每一輪（含失敗輪）的用量都要併進來，而且要在丟棄 payload 之前併。**
 *
 * 這個迴圈的每一輪都是一個真的請求、一份完整的長 prompt：模型回了東西、只是不是合法
 * JSON，輸出 token 照算（推理模型尤其嚴重，`thoughtsTokenCount` 常常是整包輸出的大宗，
 * 而「整個 candidate 只剩 thought part」正是這個迴圈要重試的那種失敗）。只回傳最後一輪
 * 等於把成本低估到三分之一，而且正好在重試跑滿的那些最貴的情況低估最多。應用層的
 * `OUTLINE_MAX_ATTEMPTS` 也是三輪，兩層相乘後一次「生成大綱」最壞是 9 個真實請求——
 * 帳本必須看得到全部。
 *
 * usage 與內容出自**同一份**已解析的 payload，所以併進 accumulator 的動作必須排在
 * `parseValue` **之前**——內容抽取與寬鬆 JSON 解析正是這條路上會 throw 的那兩步，排在
 * 它們之後就等於「失敗輪的用量照樣遺失」。
 *
 * `requests` 三種語意各不相同，不可寫成同一個數字：成功回**當輪** attempt；中途非暫時性
 * 失敗回**當輪** attempt（連不上時是 1，且錯誤上不得有 usage——一個 byte 都沒送到模型）；
 * 迴圈耗盡回 `maxAttempts`。
 *
 * 取消（`AbortError`）不是 `SafeProviderError`，會在第一輪就落進「非暫時性」分支直接穿透，
 * 既不重試也不被 `attachProviderCallFacts` 改寫——把使用者按的取消變成一次失敗是另一回事。
 */
export async function runStructuredWithRetry(
  options: StructuredRetryOptions,
): Promise<StructuredTextResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  let accumulated: ProviderUsage | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await options.request();
      accumulated = mergeUsage(accumulated, options.parseUsage(payload));
      return {
        value: options.parseValue(payload),
        usage: accumulated,
        requests: attempt,
      };
    } catch (error) {
      lastError = error;
      const code = error instanceof SafeProviderError ? error.code : undefined;
      if (attempt === maxAttempts || !code || !options.transientCodes.has(code))
        throw attachProviderCallFacts(error, {
          ...(accumulated === undefined ? {} : { usage: accumulated }),
          requests: attempt,
        });
    }
  }
  throw attachProviderCallFacts(lastError, {
    ...(accumulated === undefined ? {} : { usage: accumulated }),
    requests: maxAttempts,
  });
}

/**
 * 兩個 provider 逐字元相同的 JSON-only system 訊息。
 *
 * 存在的理由在兩邊略有不同、但指向同一件事：OpenAI-compatible 那邊是許多 gateway／模型
 * 不嚴格遵守 `json_schema`；Gemini 那邊是原生端點只吃 OpenAPI subset、不能送
 * `responseSchema`。兩邊都改由 system instruction 內嵌 schema 承擔約束。
 */
export function jsonOnlySystemPrompt(outputSchema: Record<string, unknown>): string {
  return [
    "You are a strict JSON generator. Output ONLY one JSON value that validates against this JSON Schema.",
    "No markdown code fences, no comments, no prose, no keys outside the schema.",
    "JSON_SCHEMA",
    JSON.stringify(outputSchema),
  ].join("\n");
}

import type { ProviderUsage } from "@slide-maker/core";

/**
 * 模型用量解析器。**界線落在 wire 形狀上，不是落在「同屬 provider-openai」**。
 *
 * 這個檔案裡的三個函式看起來很像，但它們對應的是三種**欄位名互不相同**的實測回應，
 * 不可為了 DRY 合併：
 *
 *  (a) `/chat/completions`（`structured.ts`／`web-search.ts`／`image-chat.ts` 三條共用，
 *      因為它們送的真的是同一個端點）：`prompt_tokens` / `completion_tokens`。
 *  (b) `/images/generations`＋`/images/edits`（`image-api.ts`）：`input_tokens` /
 *      `output_tokens`，而且影像 token 藏在 `output_tokens_details.image_tokens`。
 *  (c) OpenRouter（`image-openrouter.ts`）：欄位名同 (a)，但多一個 `cost`。
 *
 * 若把 (b) 併進 (a) 去抓 `prompt_tokens`，整條影像通道會靜默落成 `reported:false`——
 * 症狀與「gateway 真的沒回報」一模一樣，幾乎無法從 UI 察覺。這是本模組最容易做錯的地方，
 * 所以三者各自獨立，並各自有一份**真實回應** fixture 的測試釘住。
 */

/** 已知欄位一個都對不上時的結果。0 是「這次沒用 token」，這裡是「沒人回報」。 */
const UNREPORTED: ProviderUsage = { reported: false };

type UsageNumbers = Partial<
  Record<
    | "inputTokens"
    | "outputTokens"
    | "reasoningTokens"
    | "cachedTokens"
    | "totalTokens"
    | "imageTokens",
    number | undefined
  >
>;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 取出回應的 `usage` 物件；缺了或不是物件都回 undefined。 */
export function usageObject(payload: unknown): Record<string, unknown> | undefined {
  const usage = (payload as { usage?: unknown } | null | undefined)?.usage;
  return typeof usage === "object" && usage !== null
    ? (usage as Record<string, unknown>)
    : undefined;
}

/** `usage[group][field]`，任一層不是物件／不是數字都回 undefined。 */
function detail(usage: Record<string, unknown>, group: string, field: string): number | undefined {
  const nested = usage[group];
  if (typeof nested !== "object" || nested === null) return undefined;
  return finiteNumber((nested as Record<string, unknown>)[field]);
}

/**
 * 只把「真的解析到」的欄位放進結果，缺的欄位保持不存在（不是 0）。
 * 一個欄位都沒對上就回 `{ reported: false }`。
 */
export function assembleUsage(numbers: UsageNumbers, cost?: ProviderUsage["cost"]): ProviderUsage {
  // 逐欄條件展開而非動態賦值：`exactOptionalPropertyTypes` 下「缺的欄位」與「顯式
  // undefined」是不同的型別，這種寫法讓編譯器看得見兩者的差別。
  return {
    ...(numbers.inputTokens === undefined ? {} : { inputTokens: numbers.inputTokens }),
    ...(numbers.outputTokens === undefined ? {} : { outputTokens: numbers.outputTokens }),
    ...(numbers.reasoningTokens === undefined ? {} : { reasoningTokens: numbers.reasoningTokens }),
    ...(numbers.cachedTokens === undefined ? {} : { cachedTokens: numbers.cachedTokens }),
    ...(numbers.totalTokens === undefined ? {} : { totalTokens: numbers.totalTokens }),
    ...(numbers.imageTokens === undefined ? {} : { imageTokens: numbers.imageTokens }),
    ...(cost === undefined ? {} : { cost }),
    reported: Object.values(numbers).some((value) => value !== undefined) || cost !== undefined,
  };
}

/**
 * (a) CLI2Proxy／OpenAI 相容 `/chat/completions`。實測形狀：
 * ```json
 * {"prompt_tokens":303,"completion_tokens":13,"total_tokens":316,
 *  "prompt_tokens_details":{"cached_tokens":0,"cached_creation_tokens":0},
 *  "completion_tokens_details":{"reasoning_tokens":0}}
 * ```
 */
export function parseChatCompletionsUsage(payload: unknown): ProviderUsage {
  const usage = usageObject(payload);
  if (!usage) return UNREPORTED;
  return assembleUsage({
    inputTokens: finiteNumber(usage.prompt_tokens),
    outputTokens: finiteNumber(usage.completion_tokens),
    totalTokens: finiteNumber(usage.total_tokens),
    cachedTokens: detail(usage, "prompt_tokens_details", "cached_tokens"),
    reasoningTokens: detail(usage, "completion_tokens_details", "reasoning_tokens"),
  });
}

/**
 * (b) CLI2Proxy／OpenAI 相容 `/images/generations`＋`/images/edits`。實測形狀：
 * ```json
 * {"input_tokens":12,"input_tokens_details":{"image_tokens":0,"text_tokens":12},
 *  "output_tokens":229,"output_tokens_details":{"image_tokens":229,"text_tokens":0},
 *  "total_tokens":241}
 * ```
 * `imageTokens` 取**輸出**那一側：輸入側的 image_tokens 是參考圖的成本，已經含在
 * `input_tokens` 裡，兩邊相加會重複計算。
 */
export function parseImagesApiUsage(payload: unknown): ProviderUsage {
  const usage = usageObject(payload);
  if (!usage) return UNREPORTED;
  return assembleUsage({
    inputTokens: finiteNumber(usage.input_tokens),
    outputTokens: finiteNumber(usage.output_tokens),
    totalTokens: finiteNumber(usage.total_tokens),
    imageTokens: detail(usage, "output_tokens_details", "image_tokens"),
  });
}

/**
 * (c) OpenRouter `/images` 與 `/chat/completions`。實測形狀：
 * ```json
 * {"prompt_tokens":0,"completion_tokens":4175,"total_tokens":4175,"cost":0.04}
 * ```
 * chat 版另帶 `completion_tokens_details.reasoning_tokens`、
 * `prompt_tokens_details.cached_tokens` 與 `cost_details.upstream_inference_cost`。
 *
 * `cost` 存原值、不換算幣別（單位標成 `openrouter-credit`）。
 * `cost_details.upstream_inference_cost` **刻意不加總**：它是 `cost` 的組成項而非額外扣款，
 * 相加會讓帳本的金額憑空多一份。
 */
export function parseOpenRouterUsage(payload: unknown): ProviderUsage {
  const usage = usageObject(payload);
  if (!usage) return UNREPORTED;
  const amount = finiteNumber(usage.cost);
  return assembleUsage(
    {
      inputTokens: finiteNumber(usage.prompt_tokens),
      outputTokens: finiteNumber(usage.completion_tokens),
      totalTokens: finiteNumber(usage.total_tokens),
      cachedTokens: detail(usage, "prompt_tokens_details", "cached_tokens"),
      reasoningTokens: detail(usage, "completion_tokens_details", "reasoning_tokens"),
    },
    amount === undefined ? undefined : { amount, unit: "openrouter-credit" },
  );
}

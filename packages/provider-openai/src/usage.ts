import type { ProviderUsage } from "@slide-maker/core";

/**
 * 模型用量解析器。**界線落在 wire 形狀上，不是落在「同屬 provider-openai」**。
 *
 * 這個檔案裡的三個函式看起來很像，但它們對應的是三種**欄位名互不相同**的實測回應，
 * 不可為了 DRY 合併：
 *
 *  (a) `/chat/completions`（`structured.ts`／`web-search.ts`／`image-chat.ts` 三條共用，
 *      因為它們送的真的是同一個端點）：`prompt_tokens` / `completion_tokens`，OpenRouter
 *      這類 gateway 另帶 `cost`。
 *  (b) `/images/generations`＋`/images/edits`（`image-api.ts`）：`input_tokens` /
 *      `output_tokens`，而且影像 token 藏在 `output_tokens_details.image_tokens`。
 *
 * 若把 (b) 併進 (a) 去抓 `prompt_tokens`，整條影像通道會靜默落成 `reported:false`——
 * 症狀與「gateway 真的沒回報」一模一樣，幾乎無法從 UI 察覺。這是本模組最容易做錯的地方，
 * 所以兩者各自獨立，並各自有一份**真實回應** fixture 的測試釘住。
 *
 * **每個解析器都先做形狀判別，判別不過一律 `{ reported: false }`。** 少了這一步，把 (b) 餵給
 * (a) 會撿到唯一同名的 `total_tokens`，得到 `{ totalTokens: 241, reported: true }`——那比整筆
 * 解不出來更難察覺，因為它看起來像「gateway 只回了部分欄位」而不是「我們接錯了」。所以
 * **判別不過時不可退而求其次去撿 `total_tokens`**。
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
 * OpenRouter 走的是同一個端點、同一組欄位名，只多一個 `cost`（實測
 * `{"prompt_tokens":0,"completion_tokens":4175,"total_tokens":4175,"cost":0.04}`）。
 * **`cost` 一定要在這裡讀**：OpenRouter 只是另一個 base URL，被設成文字／搜尋模型時走的
 * 就是這個解析器，只在影像那條讀 cost 會讓文字那一大塊的金額無聲消失。非 OpenRouter 的
 * gateway 根本沒有這個欄位，讀不到就是 undefined，不違反「形狀不可合併」。
 *
 * `cost_details.upstream_inference_cost` **刻意不加總**：它是 `cost` 的組成項而非額外扣款，
 * 相加會讓帳本的金額憑空多一份。金額存原值、不換算幣別（單位標成 `openrouter-credit`）。
 */
export function parseChatCompletionsUsage(payload: unknown): ProviderUsage {
  const usage = usageObject(payload);
  if (!usage) return UNREPORTED;
  const inputTokens = finiteNumber(usage.prompt_tokens);
  const outputTokens = finiteNumber(usage.completion_tokens);
  const amount = finiteNumber(usage.cost);
  // 形狀判別：這三個欄位在 images 形狀上一個都不存在。判別不過就整筆不採信——
  // 尤其不可去撿 `total_tokens`，那是兩個形狀唯一同名的欄位。
  if (inputTokens === undefined && outputTokens === undefined && amount === undefined)
    return UNREPORTED;
  return assembleUsage(
    {
      inputTokens,
      outputTokens,
      totalTokens: finiteNumber(usage.total_tokens),
      cachedTokens: detail(usage, "prompt_tokens_details", "cached_tokens"),
      reasoningTokens: detail(usage, "completion_tokens_details", "reasoning_tokens"),
    },
    amount === undefined ? undefined : { amount, unit: "openrouter-credit" },
  );
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
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  // 形狀判別，理由同 (a)：這兩個欄位在 chat 形狀上不存在，對不上就整筆不採信。
  if (inputTokens === undefined && outputTokens === undefined) return UNREPORTED;
  return assembleUsage({
    inputTokens,
    outputTokens,
    totalTokens: finiteNumber(usage.total_tokens),
    imageTokens: detail(usage, "output_tokens_details", "image_tokens"),
  });
}

/**
 * OpenRouter 的用量解析器。
 *
 * **與 (a) 是同一個函式，不是「像」而已**：OpenRouter 就是另一個 base URL 的
 * `/chat/completions`，欄位名完全相同，`cost` 只是它多回的一個 optional 欄位（而 (a) 現在
 * 也讀它——文字／搜尋模型指到 OpenRouter 時走的正是 (a)）。保留這個名字只為了讓
 * `image-openrouter.ts` 的呼叫點看得出自己在對誰說話；行為刻意完全相同，**不得再分岔**，
 * 分岔就會回到「同一個 wire 形狀有兩套規則」的老問題。
 */
export const parseOpenRouterUsage = parseChatCompletionsUsage;

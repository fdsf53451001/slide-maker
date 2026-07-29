import { describe, expect, it } from "vitest";
import {
  parseChatCompletionsUsage,
  parseImagesApiUsage,
  parseOpenRouterUsage,
} from "../src/usage.js";

/**
 * 四種 wire 形狀各有**自己的** fixture，取自實測回應。
 *
 * 刻意不共用一份假資料：共用的話，「三條都抓 prompt_tokens」的錯誤實作也會全綠——那正是
 * 這個模組最可能出的錯（images 端點的欄位名完全不同，套錯解析器會靜默落成 reported:false，
 * 症狀與 gateway 真的沒回報一模一樣）。所以每個形狀除了驗自己解得對，還要驗**別的解析器
 * 對它解不出東西**，界線才真的被釘住。
 */

/** (a) CLI2Proxy `/chat/completions` 實測回應的 usage 區塊。 */
const CHAT_COMPLETIONS_USAGE = {
  prompt_tokens: 303,
  completion_tokens: 13,
  total_tokens: 316,
  prompt_tokens_details: { cached_tokens: 0, cached_creation_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
};

/** (b) CLI2Proxy `/images/generations` 實測回應的 usage 區塊。 */
const IMAGES_API_USAGE = {
  input_tokens: 12,
  input_tokens_details: { image_tokens: 0, text_tokens: 12 },
  output_tokens: 229,
  output_tokens_details: { image_tokens: 229, text_tokens: 0 },
  total_tokens: 241,
};

/** (c) OpenRouter `/images` 實測回應的 usage 區塊。 */
const OPENROUTER_IMAGE_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 4175,
  total_tokens: 4175,
  cost: 0.04,
};

/** (c) OpenRouter `/chat/completions`：多了 details 與 cost_details。 */
const OPENROUTER_CHAT_USAGE = {
  prompt_tokens: 1_024,
  completion_tokens: 512,
  total_tokens: 1_536,
  prompt_tokens_details: { cached_tokens: 256 },
  completion_tokens_details: { reasoning_tokens: 300 },
  cost: 0.0123,
  cost_details: { upstream_inference_cost: 0.0099 },
};

describe("parseChatCompletionsUsage（形狀 a）", () => {
  it("讀出 prompt/completion/total 與兩組 details", () => {
    expect(parseChatCompletionsUsage({ usage: CHAT_COMPLETIONS_USAGE })).toEqual({
      inputTokens: 303,
      outputTokens: 13,
      totalTokens: 316,
      cachedTokens: 0,
      reasoningTokens: 0,
      reported: true,
    });
  });

  it("回報的 0 要保留成 0，而不是被當成「沒回報」丟掉", () => {
    const usage = parseChatCompletionsUsage({ usage: CHAT_COMPLETIONS_USAGE });
    expect(usage.cachedTokens).toBe(0);
    expect(usage.reasoningTokens).toBe(0);
    expect(usage.reported).toBe(true);
  });

  /**
   * 套錯解析器時**整筆不採信**。少了形狀判別的話，兩個形狀唯一同名的 `total_tokens` 會被
   * 撿到，回一個 `reported:true` 但缺了 input/output 的殘缺結果——那看起來像「這個 gateway
   * 只回了部分欄位」，比整筆解不出來更難察覺。所以判別不過時**不可**退而求其次去撿 total。
   */
  it("套到 images 端點的形狀上一律 reported:false，連同名的 total 都不撿", () => {
    const usage = parseChatCompletionsUsage({ usage: IMAGES_API_USAGE });
    expect(usage).toEqual({ reported: false });
    expect(usage.totalTokens).toBeUndefined();
  });

  /**
   * OpenRouter 只是另一個 base URL：設成文字／搜尋模型時走的就是這個解析器。`cost` 只在
   * 影像那條讀的話，金額 UI 一開，文字那一大塊的錢會完全不見。
   */
  it("讀得到 OpenRouter 的 cost（同一個 /chat/completions 形狀，只是多一個欄位）", () => {
    expect(parseChatCompletionsUsage({ usage: OPENROUTER_CHAT_USAGE }).cost).toEqual({
      amount: 0.0123,
      unit: "openrouter-credit",
    });
  });
});

describe("parseImagesApiUsage（形狀 b）", () => {
  it("讀出 input/output/total 與輸出側的 image_tokens", () => {
    expect(parseImagesApiUsage({ usage: IMAGES_API_USAGE })).toEqual({
      inputTokens: 12,
      outputTokens: 229,
      totalTokens: 241,
      imageTokens: 229,
      reported: true,
    });
  });

  it("不把輸入側的 image_tokens 也算進來（那份成本已含在 input_tokens 裡）", () => {
    const usage = parseImagesApiUsage({
      usage: { ...IMAGES_API_USAGE, input_tokens_details: { image_tokens: 999, text_tokens: 12 } },
    });
    expect(usage.imageTokens).toBe(229);
    expect(usage.inputTokens).toBe(12);
  });

  it("反過來套到 chat 形狀上也一樣整筆不採信（理由同上）", () => {
    expect(parseImagesApiUsage({ usage: CHAT_COMPLETIONS_USAGE })).toEqual({ reported: false });
    expect(parseImagesApiUsage({ usage: OPENROUTER_IMAGE_USAGE })).toEqual({ reported: false });
  });
});

/**
 * `parseOpenRouterUsage` 是 `parseChatCompletionsUsage` 的別名：OpenRouter 就是另一個
 * base URL 的 `/chat/completions`，`cost` 只是它多回的一個 optional 欄位。這一組測試因此
 * 也順便釘住「兩者不得再分岔」。
 */
describe("parseOpenRouterUsage（chat 形狀＋cost）", () => {
  it("與 chat 解析器是同一個函式", () => {
    expect(parseOpenRouterUsage).toBe(parseChatCompletionsUsage);
  });

  it("images 端點：token 之外還帶回 cost，且存原值不換算", () => {
    expect(parseOpenRouterUsage({ usage: OPENROUTER_IMAGE_USAGE })).toEqual({
      inputTokens: 0,
      outputTokens: 4175,
      totalTokens: 4175,
      reported: true,
      cost: { amount: 0.04, unit: "openrouter-credit" },
    });
  });

  it("chat 端點：一併讀出 reasoning 與 cached", () => {
    expect(parseOpenRouterUsage({ usage: OPENROUTER_CHAT_USAGE })).toEqual({
      inputTokens: 1_024,
      outputTokens: 512,
      totalTokens: 1_536,
      cachedTokens: 256,
      reasoningTokens: 300,
      reported: true,
      cost: { amount: 0.0123, unit: "openrouter-credit" },
    });
  });

  it("不把 cost_details.upstream_inference_cost 加進 cost（那是組成項，不是額外扣款）", () => {
    expect(parseOpenRouterUsage({ usage: OPENROUTER_CHAT_USAGE }).cost?.amount).toBe(0.0123);
  });

  it("只有 cost 沒有 token 時仍算 reported", () => {
    expect(parseOpenRouterUsage({ usage: { cost: 0.5 } })).toEqual({
      reported: true,
      cost: { amount: 0.5, unit: "openrouter-credit" },
    });
  });
});

describe("沒有 usage 欄位", () => {
  /**
   * 三個解析器對「完全沒有 usage」一律回 `{ reported: false }`，而**不是**一堆 0。
   * 這是整個 ProviderUsage 介面存在的理由：`reported:false` 與「這次沒花 token」在聚合後
   * 要採取的行動完全相反。
   */
  it.each([
    ["chat", parseChatCompletionsUsage],
    ["images", parseImagesApiUsage],
    ["openrouter", parseOpenRouterUsage],
  ])("%s：回 reported:false 且不含任何 0", (_name, parse) => {
    for (const payload of [
      { choices: [{ message: { content: "{}" } }] },
      { usage: null },
      { usage: "nope" },
      {},
      null,
      undefined,
    ]) {
      const usage = parse(payload);
      expect(usage).toEqual({ reported: false });
      expect(usage.inputTokens).toBeUndefined();
      expect(usage.outputTokens).toBeUndefined();
      expect(usage.totalTokens).toBeUndefined();
    }
  });

  it("欄位存在但型別不對（字串、負數、NaN）一律不採信", () => {
    expect(
      parseChatCompletionsUsage({
        usage: { prompt_tokens: "303", completion_tokens: -1, total_tokens: Number.NaN },
      }),
    ).toEqual({ reported: false });
  });
});

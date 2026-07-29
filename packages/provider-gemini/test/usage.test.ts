import { describe, expect, it } from "vitest";
import { parseGeminiUsage } from "../src/usage.js";

/**
 * (d) Gemini 原生 `:generateContent` 的實測 usageMetadata。
 *
 * 與 provider-openai 那三個形狀完全不同（`usageMetadata` 而非 `usage`、`*TokenCount` 而非
 * `*_tokens`），所以有自己的 fixture 與自己的解析器。
 */
const GEMINI_USAGE_METADATA = {
  promptTokenCount: 1_234,
  candidatesTokenCount: 567,
  thoughtsTokenCount: 890,
  totalTokenCount: 2_691,
};

describe("parseGeminiUsage（形狀 d）", () => {
  it("讀出 prompt/candidates/total 與 thoughts", () => {
    expect(parseGeminiUsage({ usageMetadata: GEMINI_USAGE_METADATA })).toEqual({
      inputTokens: 1_234,
      outputTokens: 567,
      reasoningTokens: 890,
      totalTokens: 2_691,
      reported: true,
    });
  });

  /**
   * `thoughtsTokenCount` 漏掉會系統性低估：推理模型把大部分輸出花在思考 token 上，而
   * `candidatesTokenCount` 不含它。這一條就是釘住「有沒有真的去讀那個欄位」。
   */
  it("thoughts 不得漏掉——它不含在 candidatesTokenCount 裡", () => {
    const usage = parseGeminiUsage({ usageMetadata: GEMINI_USAGE_METADATA });
    expect(usage.reasoningTokens).toBe(890);
    expect(usage.outputTokens).toBe(567);
    // total 是端點自己算的，含 thoughts；不可拿 output+input 反推。
    expect(usage.totalTokens).toBe(2_691);
  });

  it("讀得出快取內容 token", () => {
    expect(
      parseGeminiUsage({
        usageMetadata: { ...GEMINI_USAGE_METADATA, cachedContentTokenCount: 400 },
      }).cachedTokens,
    ).toBe(400);
  });

  it("沒有 thoughts 的模型不補 0，該欄位直接不存在", () => {
    const usage = parseGeminiUsage({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reported: true,
    });
    expect("reasoningTokens" in usage).toBe(false);
  });

  it("完全沒有 usageMetadata → reported:false，且不含任何 0", () => {
    for (const payload of [
      { candidates: [{ content: { parts: [{ text: "{}" }] } }] },
      { usageMetadata: null },
      {},
      null,
      undefined,
    ]) {
      const usage = parseGeminiUsage(payload);
      expect(usage).toEqual({ reported: false });
      expect(usage.inputTokens).toBeUndefined();
    }
  });

  it("OpenAI 形狀的 usage 在這裡解不出東西（界線落在 wire 形狀上）", () => {
    expect(parseGeminiUsage({ usage: { prompt_tokens: 303, completion_tokens: 13 } })).toEqual({
      reported: false,
    });
  });
});

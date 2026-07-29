import type { ProviderUsage } from "@slide-maker/core";

/**
 * (d) Gemini 原生 `:generateContent` 的用量解析。
 *
 * 形狀與 OpenAI 相容端點完全不同（`usageMetadata` 而非 `usage`，欄位名是
 * `*TokenCount`），所以自成一份，不與 `provider-openai/src/usage.ts` 共用——三條影像／
 * 文字／搜尋通道在這個套件裡都走 `:generateContent`，故套件內共用這一個函式是對的。
 *
 * `thoughtsTokenCount` 一定要讀：推理模型把大部分輸出花在思考 token 上，
 * `candidatesTokenCount` 不含它，漏掉會系統性低估。
 */

const UNREPORTED: ProviderUsage = { reported: false };

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseGeminiUsage(payload: unknown): ProviderUsage {
  const metadata = (payload as { usageMetadata?: unknown } | null | undefined)?.usageMetadata;
  if (typeof metadata !== "object" || metadata === null) return UNREPORTED;
  const fields = metadata as Record<string, unknown>;
  const inputTokens = finiteNumber(fields.promptTokenCount);
  const outputTokens = finiteNumber(fields.candidatesTokenCount);
  const reasoningTokens = finiteNumber(fields.thoughtsTokenCount);
  const cachedTokens = finiteNumber(fields.cachedContentTokenCount);
  const totalTokens = finiteNumber(fields.totalTokenCount);
  // 逐欄條件展開：`exactOptionalPropertyTypes` 下「缺的欄位」不可寫成顯式 undefined，
  // 而「補 0」正是這個介面存在的理由所要避免的事。
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    reported: [inputTokens, outputTokens, reasoningTokens, cachedTokens, totalTokens].some(
      (value) => value !== undefined,
    ),
  };
}

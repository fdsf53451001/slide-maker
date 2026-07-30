import { describe, expect, it } from "vitest";
import {
  attachProviderCallFacts,
  mergeUsage,
  SafeProviderError,
  withProviderUsage,
  type ProviderUsage,
} from "../src/providers.js";

/**
 * `mergeUsage` 是「一次邏輯呼叫 ≠ 一個 HTTP 請求」的唯一一份規則：provider 內部對暫時性
 * 失敗自己會重試，每一輪都燒掉整份長 prompt。這裡釘住的三件事，錯一件就是系統性的錯誤
 * 數字：**缺的欄位不得補 0**、**任一邊回報就算回報**、**cost 一起相加**。
 */
describe("mergeUsage", () => {
  it("逐欄相加，兩邊都有的欄位才相加", () => {
    expect(
      mergeUsage(
        { inputTokens: 100, outputTokens: 10, totalTokens: 110, reported: true },
        { inputTokens: 200, outputTokens: 20, totalTokens: 220, reported: true },
      ),
    ).toEqual({ inputTokens: 300, outputTokens: 30, totalTokens: 330, reported: true });
  });

  /**
   * 只有一邊有的欄位要原樣保留，**兩邊都沒有的欄位必須維持不存在**——補 0 會讓
   * 「這條通道沒回報這個欄位」與「這次真的是 0」在聚合後永遠分不開。
   */
  it("缺的欄位維持不存在，不補 0", () => {
    const merged = mergeUsage(
      { inputTokens: 5, reported: true },
      { outputTokens: 7, reasoningTokens: 3, reported: true },
    );
    expect(merged).toEqual({ inputTokens: 5, outputTokens: 7, reasoningTokens: 3, reported: true });
    expect("totalTokens" in merged).toBe(false);
    expect("imageTokens" in merged).toBe(false);
    expect("cachedTokens" in merged).toBe(false);
  });

  /**
   * 一輪回報、一輪沒回報時，回報的那一輪的數字是**真的**。要求「兩邊都 reported」會把它
   * 丟掉，那是比不合併更糟的錯。
   */
  it("任一邊 reported 就算 reported", () => {
    expect(mergeUsage({ reported: false }, { inputTokens: 9, reported: true })).toEqual({
      inputTokens: 9,
      reported: true,
    });
    expect(mergeUsage({ inputTokens: 9, reported: true }, { reported: false })).toEqual({
      inputTokens: 9,
      reported: true,
    });
    expect(mergeUsage({ reported: false }, { reported: false })).toEqual({ reported: false });
  });

  it("cost 相加；只有一邊有時原樣保留", () => {
    const both = mergeUsage(
      { reported: true, cost: { amount: 0.04, unit: "openrouter-credit" } },
      { reported: true, cost: { amount: 0.01, unit: "openrouter-credit" } },
    );
    expect(both.cost?.amount).toBeCloseTo(0.05, 10);
    expect(both.cost?.unit).toBe("openrouter-credit");
    expect(
      mergeUsage(
        { reported: true },
        { reported: true, cost: { amount: 0.5, unit: "openrouter-credit" } },
      ).cost,
    ).toEqual({ amount: 0.5, unit: "openrouter-credit" });
    expect("cost" in mergeUsage({ reported: true }, { reported: true })).toBe(false);
  });

  it("undefined 的一邊視同沒有這一輪", () => {
    const usage: ProviderUsage = { inputTokens: 1, reported: true };
    expect(mergeUsage(undefined, usage)).toEqual(usage);
    expect(mergeUsage(usage, undefined)).toEqual(usage);
    expect(mergeUsage(undefined, undefined)).toEqual({ reported: false });
  });

  it("累加三輪的結果與逐輪相加一致（重試迴圈就是這樣用的）", () => {
    const rounds: ProviderUsage[] = [
      { inputTokens: 100, outputTokens: 10, reported: true },
      { inputTokens: 200, outputTokens: 20, reported: true },
      { inputTokens: 300, outputTokens: 30, reported: true },
    ];
    let accumulated: ProviderUsage | undefined;
    for (const round of rounds) accumulated = mergeUsage(accumulated, round);
    expect(accumulated).toEqual({ inputTokens: 600, outputTokens: 60, reported: true });
  });
});

describe("SafeProviderError 帶用量", () => {
  it("沒帶 facts 時兩個欄位都是 undefined（相容既有呼叫點）", () => {
    const error = new SafeProviderError("X_CODE", "訊息");
    expect(error.code).toBe("X_CODE");
    expect(error.safeMessage).toBe("訊息");
    expect(error.usage).toBeUndefined();
    expect(error.requests).toBeUndefined();
  });

  it("withProviderUsage 把用量補到區段內丟出來的 SafeProviderError 上", () => {
    const usage: ProviderUsage = { inputTokens: 12, reported: true };
    const thrown = (() => {
      try {
        withProviderUsage(usage, () => {
          throw new SafeProviderError("IMAGE_MISSING", "解不出圖。");
        });
      } catch (error) {
        return error as SafeProviderError;
      }
      return undefined;
    })();
    expect(thrown?.code).toBe("IMAGE_MISSING");
    expect(thrown?.usage).toEqual(usage);
  });

  /**
   * 取消走的是 `AbortError`（不是 `SafeProviderError`）。把它改寫成別的東西等於把使用者
   * 按下的取消變成一次失敗，所以非 `SafeProviderError` 一律原樣往上丟。
   */
  it("非 SafeProviderError 原樣往上丟（AbortError 不得被改寫）", () => {
    const abort = new DOMException("cancelled", "AbortError");
    expect(() =>
      withProviderUsage({ reported: true }, () => {
        throw abort;
      }),
    ).toThrow(abort);
    expect(attachProviderCallFacts(abort, { requests: 3 })).toBe(abort);
  });

  it("已經帶著用量的錯誤不會被外層覆蓋掉", () => {
    const inner = new SafeProviderError("CODE", "訊息", {
      usage: { inputTokens: 1, reported: true },
    });
    const outer = attachProviderCallFacts(inner, {
      usage: { inputTokens: 999, reported: true },
      requests: 2,
    }) as SafeProviderError;
    expect(outer.usage).toEqual({ inputTokens: 1, reported: true });
    expect(outer.requests).toBe(2);
  });
});

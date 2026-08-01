import { describe, expect, it } from "vitest";
import { jsonOnlySystemPrompt, runStructuredWithRetry } from "../src/provider-retry.js";
import { type ProviderUsage, SafeProviderError } from "../src/providers.js";

const TRANSIENT = new Set(["FAKE_RESPONSE_INVALID", "FAKE_TEXT_EMPTY"]);

/** 每輪回一份帶用量的 payload，內容由 `contents` 逐輪供應。 */
function fakeRounds(contents: ReadonlyArray<string>): {
  request: () => Promise<unknown>;
  calls: () => number;
} {
  let call = 0;
  return {
    request: async () => {
      call += 1;
      return { content: contents[call - 1] ?? "", tokens: 100 * call };
    },
    calls: () => call,
  };
}

const parseUsage = (payload: unknown): ProviderUsage => {
  const tokens = (payload as { tokens?: unknown }).tokens;
  return typeof tokens === "number" ? { inputTokens: tokens, reported: true } : { reported: false };
};

const parseValue = (payload: unknown): unknown => {
  const content = (payload as { content?: unknown }).content;
  if (content === "") throw new SafeProviderError("FAKE_TEXT_EMPTY", "空回應。");
  try {
    return JSON.parse(String(content));
  } catch {
    throw new SafeProviderError("FAKE_RESPONSE_INVALID", "不是合法 JSON。");
  }
};

describe("runStructuredWithRetry", () => {
  /**
   * 前兩輪回非 JSON、第三輪成功：三輪都是真的請求、都燒掉整份長 prompt 的 token，所以
   * 用量必須是三輪的和（100+200+300），而不是最後一輪的 300。`requests` 回真實請求數。
   */
  it("重試到成功時累加每一輪的用量，requests 回報真實請求數", async () => {
    const rounds = fakeRounds(["not json", "still not json", '{"ok":true}']);
    const result = await runStructuredWithRetry({
      request: rounds.request,
      parseUsage,
      parseValue,
      transientCodes: TRANSIENT,
    });

    expect(result.value).toEqual({ ok: true });
    expect(rounds.calls()).toBe(3);
    expect(result.usage).toEqual({ inputTokens: 600, reported: true });
    expect(result.requests).toBe(3);
  });

  /**
   * 非暫時性錯誤當輪就丟，`requests` 帶的是**當輪數**而不是總輪數——連不上時就是 1。
   * 這條與下一條合起來才分得開「打了一次」與「跑滿三輪」。
   */
  it("非暫時性錯誤第一輪就丟出，requests 是當輪數", async () => {
    let calls = 0;
    const error = await runStructuredWithRetry({
      request: async () => {
        calls += 1;
        throw new SafeProviderError("FAKE_USAGE_LIMIT", "撞到限流。");
      },
      parseUsage,
      parseValue,
      transientCodes: TRANSIENT,
    }).catch((thrown: unknown) => thrown);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(SafeProviderError);
    expect((error as SafeProviderError).code).toBe("FAKE_USAGE_LIMIT");
    expect((error as SafeProviderError).requests).toBe(1);
  });

  /** 三輪都失敗＝最貴的情況：丟的是最後一輪的錯誤，用量是三輪的和，requests 為上界。 */
  it("重試耗盡時丟出最後一次的錯誤，並掛上累加用量與 requests", async () => {
    const rounds = fakeRounds(["not json", "not json", "not json"]);
    const error = await runStructuredWithRetry({
      request: rounds.request,
      parseUsage,
      parseValue,
      transientCodes: TRANSIENT,
    }).catch((thrown: unknown) => thrown);

    expect(rounds.calls()).toBe(3);
    expect(error).toBeInstanceOf(SafeProviderError);
    expect((error as SafeProviderError).code).toBe("FAKE_RESPONSE_INVALID");
    expect((error as SafeProviderError).usage).toEqual({ inputTokens: 600, reported: true });
    expect((error as SafeProviderError).requests).toBe(3);
  });

  /**
   * 取消走的是 `AbortError`：不是 `SafeProviderError`，所以第一輪就穿透、不燒重試預算，
   * 而且**原樣**丟出——`attachProviderCallFacts` 改寫它等於把使用者按的取消變成一次失敗。
   */
  it("AbortError 第一輪就穿透，不重試也不被改寫", async () => {
    let calls = 0;
    const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const error = await runStructuredWithRetry({
      request: async () => {
        calls += 1;
        throw abort;
      },
      parseUsage,
      parseValue,
      transientCodes: TRANSIENT,
    }).catch((thrown: unknown) => thrown);

    expect(calls).toBe(1);
    expect(error).toBe(abort);
    expect(error).not.toBeInstanceOf(SafeProviderError);
  });

  /**
   * 往返本身就失敗時一個 byte 都沒送到模型：`parseUsage` 一次都不該被呼叫，錯誤上也不得
   * 有 usage。少了這條，把 usage 補成 `{reported:false}` 常數也會通過上面那幾條——而那與
   * 「這個 gateway 不回報用量」在帳本上長得一模一樣。
   */
  it("往返就失敗時不解析也不編造用量", async () => {
    let parsedUsage = 0;
    const error = (await runStructuredWithRetry({
      request: async () => {
        throw new SafeProviderError("FAKE_REQUEST_FAILED", "連不上。");
      },
      parseUsage: (payload) => {
        parsedUsage += 1;
        return parseUsage(payload);
      },
      parseValue,
      transientCodes: TRANSIENT,
    }).catch((thrown: unknown) => thrown)) as SafeProviderError;

    expect(parsedUsage).toBe(0);
    expect(error.usage).toBeUndefined();
    expect(error.requests).toBe(1);
  });

  it("maxAttempts 決定迴圈上界與耗盡時回報的 requests", async () => {
    const rounds = fakeRounds(["not json", "not json"]);
    const error = await runStructuredWithRetry({
      request: rounds.request,
      parseUsage,
      parseValue,
      transientCodes: TRANSIENT,
      maxAttempts: 2,
    }).catch((thrown: unknown) => thrown);

    expect(rounds.calls()).toBe(2);
    expect((error as SafeProviderError).requests).toBe(2);
  });
});

describe("jsonOnlySystemPrompt", () => {
  it("內嵌 schema 並保持四行結構", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const lines = jsonOnlySystemPrompt(schema).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("strict JSON generator");
    expect(lines[1]).toContain("No markdown code fences");
    expect(lines[2]).toBe("JSON_SCHEMA");
    expect(lines[3]).toBe(JSON.stringify(schema));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeProviderError } from "@slide-maker/core";
import { requestJson, type OpenAiClientConfig } from "../src/http.js";

const originalFetch = globalThis.fetch;
const config: OpenAiClientConfig = {
  baseUrl: "https://openai-gateway.example/v1",
  apiKey: "test-key",
  timeoutMs: 5_000,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenAI HTTP response safety", () => {
  it("rejects an oversized chunked body without draining the response", async () => {
    const state = { pulls: 0, cancelled: false };
    const chunk = new Uint8Array(1024 * 1024);
    const totalChunks = 48; // 48 MiB：夠超過 32 MiB 上限，舊 arrayBuffer 實作也不會爆記憶體。
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            state.pulls += 1;
            if (state.pulls > totalChunks) return controller.close();
            controller.enqueue(chunk);
          },
          cancel() {
            state.cancelled = true;
          },
        }),
      )) as typeof fetch;

    const error = (await requestJson(config, { method: "GET", path: "/models" }).catch(
      (reason: unknown) => reason,
    )) as SafeProviderError;
    expect(error).toBeInstanceOf(SafeProviderError);
    expect(error.code).toBe("OPENAI_RESPONSE_TOO_LARGE");
    // 第 33 塊剛過線就要停；舊 arrayBuffer 會把 48 塊全部拉完才發現超限。
    expect(state.pulls).toBeLessThan(totalChunks);
    expect(state.cancelled).toBe(true);
  });

  it("never reads or logs a non-2xx body that echoes prompts and credentials", async () => {
    const apiKey = "sk-provider-log-secret";
    const baseUrlSecret = "base-url-userinfo-secret";
    const promptMarker = "PROMPT_MARKER_MUST_NOT_REACH_LOGS";
    const upstreamBody = JSON.stringify({
      error: "UPSTREAM_BODY_SHOULD_NEVER_BE_LOGGED",
      prompt: promptMarker,
      credential: apiKey,
    });
    const response = new Response(upstreamBody, { status: 401 });
    const readBody = vi.spyOn(response, "text");
    const cancelBody = vi.spyOn(response.body!, "cancel");
    globalThis.fetch = vi.fn(async () => response) as typeof fetch;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      requestJson(
        {
          ...config,
          apiKey,
          baseUrl: `https://${baseUrlSecret}@openai-gateway.example/private/v1`,
        },
        {
          method: "GET",
          path: `/models?trace=${encodeURIComponent(promptMarker)}&key=${apiKey}`,
        },
      ),
    ).rejects.toMatchObject({ code: "OPENAI_AUTH_REQUIRED" });

    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    const serializedLog = warning.mock.calls.flat().join("\n");
    expect(serializedLog).toContain('"status":401');
    expect(serializedLog).toContain('"path":"/models"');
    expect(serializedLog).not.toContain(promptMarker);
    expect(serializedLog).not.toContain(apiKey);
    expect(serializedLog).not.toContain(baseUrlSecret);
    expect(serializedLog).not.toContain("openai-gateway.example");
    expect(serializedLog).not.toContain("UPSTREAM_BODY_SHOULD_NEVER_BE_LOGGED");
    expect(serializedLog).not.toContain(upstreamBody);
  });
});

import { describe, expect, it, vi } from "vitest";
import { readBoundedResponseBytes } from "../src/http-response.js";

describe("readBoundedResponseBytes", () => {
  it("merges a response stream within the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    const response = new Response(stream);

    expect(await readBoundedResponseBytes(response, 3, () => new Error("TOO_LARGE"))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(stream.locked).toBe(false);
    // 不只看 `locked` 布林值：真的能重新取得 reader 才證明 lock 已釋放。
    const reader = stream.getReader();
    reader.releaseLock();
  });

  it("uses content-length as an early preflight and preserves the caller error", async () => {
    const error = new Error("CALLER_TOO_LARGE");
    const response = new Response("small", {
      headers: { "content-length": "100" },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");

    await expect(readBoundedResponseBytes(response, 10, () => error)).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("preserves the caller error when content-length fast-path cancellation rejects", async () => {
    const callerError = new Error("DECLARED_TOO_LARGE");
    const cancelError = new Error("transport refused cancellation");
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(cancelError);
      },
    });
    const response = new Response(stream, { headers: { "content-length": "100" } });

    // 若實作直接 `await body.cancel()` 而沒有過濾，這裡會錯誤地收到 cancelError。
    await expect(readBoundedResponseBytes(response, 10, () => callerError)).rejects.toBe(
      callerError,
    );
    expect(stream.locked).toBe(false);
  });

  it("cancels a chunked response immediately after its actual bytes cross the limit", async () => {
    const state = { pulls: 0, cancelled: false };
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls += 1;
          if (state.pulls > 100) return controller.close();
          controller.enqueue(new Uint8Array(4));
        },
        cancel() {
          state.cancelled = true;
        },
      }),
    );

    await expect(
      readBoundedResponseBytes(response, 8, () => new RangeError("STREAM_TOO_LARGE")),
    ).rejects.toThrow("STREAM_TOO_LARGE");
    expect(state.pulls).toBeLessThan(10);
    expect(state.cancelled).toBe(true);
  });

  it("preserves the caller error and releases the reader when streamed cancellation rejects", async () => {
    const callerError = new RangeError("STREAM_TOO_LARGE");
    const cancelError = new Error("underlying cancel failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel() {
        return Promise.reject(cancelError);
      },
    });

    // 這個 fixture 會讓未過濾的 `await reader.cancel()` 丟 cancelError，真正的上限錯誤會被蓋掉。
    await expect(readBoundedResponseBytes(new Response(stream), 8, () => callerError)).rejects.toBe(
      callerError,
    );
    expect(stream.locked).toBe(false);
    const reader = stream.getReader();
    reader.releaseLock();
  });

  it("supports a null-body fallback within the limit", async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array([4, 5, 6]).buffer);
    const response: Pick<Response, "arrayBuffer" | "body" | "headers"> = {
      arrayBuffer,
      body: null,
      headers: new Headers(),
    };

    await expect(
      readBoundedResponseBytes(response, 3, () => new Error("TOO_LARGE")),
    ).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it("applies the caller error to a null-body fallback over the limit", async () => {
    const callerError = new Error("BODYLESS_TOO_LARGE");
    const response: Pick<Response, "arrayBuffer" | "body" | "headers"> = {
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      body: null,
      headers: new Headers(),
    };

    await expect(readBoundedResponseBytes(response, 3, () => callerError)).rejects.toBe(
      callerError,
    );
  });
});

/**
 * 以硬上限讀取 Fetch `Response` 的位元組。
 *
 * `content-length` 只用來提早拒絕誠實宣告的超大回應；chunked 回應沒有這個 header，端點也
 * 可能謊報，所以實際串流仍逐塊累計。超限或讀取失敗時會立刻取消未讀完的 stream，避免
 * 底層連線繼續把整份 body drain 進記憶體。
 *
 * helper 不決定錯誤種類：server 可丟既有 `Error("WEB_…")`，provider 也可保留自己的
 * `SafeProviderError`。因此共用的是 transport 行為，不會把任一呼叫端的錯誤契約帶進 core。
 */
export async function readBoundedResponseBytes(
  response: Pick<Response, "arrayBuffer" | "body" | "headers">,
  maxBytes: number,
  createTooLargeError: () => Error,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw createTooLargeError();
  }

  const stream = response.body;
  if (!stream) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw createTooLargeError();
    return bytes;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw createTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 部分 stream 實作會在取消／關閉時先釋放 reader；不得讓清理錯誤蓋掉真正原因。
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

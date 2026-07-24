// HTTP 客戶端：綁定測試 server 的 baseUrl，帶對的 Host header（loopback 主機名一律在
// app.ts 的 allowedHosts 內），且**永不送 Origin**——送了任意 Origin 會觸發同一段
// 主機名檢查而被 403。所有方法回傳 { status, headers, body }，body 依 content-type 解析。
//
// 二進位上傳（PDF 匯入、來源上傳）走 express.raw（server 端 `type: () => true`），
// 因此 content-type 不能是 application/json，這裡用 application/octet-stream + 原始 bytes。

function decodeBody(contentType, buffer) {
  if (!buffer.length) return undefined;
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      return new TextDecoder().decode(buffer);
    }
  }
  if (contentType.startsWith("text/")) return new TextDecoder().decode(buffer);
  return new Uint8Array(buffer);
}

export function createClient(baseUrl) {
  const host = new URL(baseUrl).host;

  async function request(method, path, options = {}) {
    const headers = { host, ...(options.headers ?? {}) };
    let body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.bytes !== undefined) {
      // express.raw 讀原始位元組；宣告 octet-stream 以免被 json body parser 攔截。
      headers["content-type"] = options.contentType ?? "application/octet-stream";
      body = Buffer.from(options.bytes);
    }
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      contentType,
      body: decodeBody(contentType, Buffer.from(arrayBuffer)),
      bytes: new Uint8Array(arrayBuffer),
    };
  }

  /** 便捷包裝：非 2xx 直接丟出，帶診斷。用於「預期成功」的呼叫。 */
  async function expectOk(method, path, options = {}) {
    const result = await request(method, path, options);
    if (result.status < 200 || result.status >= 300) {
      const detail =
        typeof result.body === "object" && !(result.body instanceof Uint8Array)
          ? JSON.stringify(result.body)
          : `${result.bytes.length} bytes`;
      throw new Error(`HTTP ${result.status} ${method} ${path}: ${String(detail).slice(0, 500)}`);
    }
    return result;
  }

  return {
    request,
    host,
    baseUrl,
    get: (path, options) => expectOk("GET", path, options),
    post: (path, options) => expectOk("POST", path, options),
    put: (path, options) => expectOk("PUT", path, options),
    patch: (path, options) => expectOk("PATCH", path, options),
    delete: (path, options) => expectOk("DELETE", path, options),
    // raw* 變體不丟出（供斷言拒絕路徑，需要拿到 status/body）。
    rawGet: (path, options) => request("GET", path, options),
    rawPost: (path, options) => request("POST", path, options),
    rawPut: (path, options) => request("PUT", path, options),
    rawPatch: (path, options) => request("PATCH", path, options),
    rawDelete: (path, options) => request("DELETE", path, options),
  };
}

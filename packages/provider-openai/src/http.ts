import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import {
  logError,
  logWarn,
  type ProviderPreflightStatus,
  SafeProviderError,
} from "@slide-maker/core";

export interface OpenAiClientConfig {
  /** 端點根位址，如 `http://localhost:8317/v1` 或 `https://api.openai.com/v1`。 */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_INPUT_BYTES = 16 * 1024 * 1024;

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return suffix ? `${base}/${suffix}` : base;
}

interface RequestInitLike {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

/** 把 fetch/timeout/abort 分類成不洩漏原文的 SafeProviderError。 */
function classifyFetchError(error: unknown, cancelSignal: AbortSignal | undefined): never {
  if (cancelSignal?.aborted) throw new DOMException("OpenAI request cancelled", "AbortError");
  const name =
    typeof error === "object" && error && "name" in error
      ? (error as { name?: string }).name
      : undefined;
  if (name === "TimeoutError")
    throw new SafeProviderError("OPENAI_TIMEOUT", "OpenAI 端點回應逾時。");
  throw new SafeProviderError("OPENAI_REQUEST_FAILED", "無法連線 OpenAI 端點。");
}

/** 對 OpenAI-compatible 端點發出請求並回傳解析後的 JSON（失敗一律丟 SafeProviderError）。 */
export async function requestJson(
  config: OpenAiClientConfig,
  init: RequestInitLike,
): Promise<unknown> {
  const url = joinUrl(config.baseUrl, init.path);
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;
  const isFormData = init.body instanceof FormData;
  const requestInit: RequestInit = {
    method: init.method,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      ...(init.body !== undefined && !isFormData ? { "content-type": "application/json" } : {}),
    },
    signal,
    redirect: "error",
  };
  if (init.body !== undefined)
    requestInit.body = isFormData ? (init.body as FormData) : JSON.stringify(init.body);
  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    classifyFetchError(error, init.signal);
  }
  if (!response!.ok) {
    const status = response!.status;
    const bodyText = await response!.text().catch(() => "");
    const logFields = {
      status,
      url: joinUrl(config.baseUrl, init.path).split("?")[0],
      // 空 key 是合法設定（keyless 本機 gateway）；replaceAll("") 會把替換字插進
      // 每個字元之間，故僅在 key 非空時遮蔽。
      bodyPreview: (config.apiKey
        ? bodyText.replaceAll(config.apiKey, "[REDACTED]")
        : bodyText
      ).slice(0, 2000),
    };
    // 401/403/429 是已分類、預期內的失敗（未登入、readiness probe 常態性打到），
    // 用 WARNING 避免每次 readiness 重新檢查就固定噴 ERROR，稀釋真正異常的告警訊號。
    if (status === 401 || status === 403 || status === 429)
      logWarn("provider_http_error", logFields);
    else logError("provider_http_error", logFields);
    if (status === 401 || status === 403)
      throw new SafeProviderError(
        "OPENAI_AUTH_REQUIRED",
        "OpenAI 端點驗證失敗（請檢查 API key）。",
      );
    if (status === 429)
      throw new SafeProviderError("OPENAI_USAGE_LIMIT", "OpenAI 端點達到配額或速率限制。");
    throw new SafeProviderError("OPENAI_REQUEST_FAILED", `OpenAI 端點回應 HTTP ${status}。`);
  }
  const declared = Number(response!.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES)
    throw new SafeProviderError("OPENAI_RESPONSE_TOO_LARGE", "OpenAI 回應過大。");
  const bytes = new Uint8Array(await response!.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES)
    throw new SafeProviderError("OPENAI_RESPONSE_TOO_LARGE", "OpenAI 回應過大。");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) as unknown;
  } catch {
    throw new SafeProviderError("OPENAI_RESPONSE_INVALID", "OpenAI 回應不是合法 JSON。");
  }
}

/**
 * 寬鬆解析模型回傳的 JSON 內容。許多 OpenAI-compatible gateway（尤其 Gemini 系）
 * 不嚴格遵守 json_schema，會把 JSON 包在 ```json``` 圍欄或前後夾雜說明文字。
 */
export function parseLooseJson(content: string): unknown {
  let text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) text = fenced[1].trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.search(/[{[]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        // fall through to the shared error below
      }
    }
    throw new SafeProviderError("OPENAI_RESPONSE_INVALID", "OpenAI 回應不是合法 JSON。");
  }
}

/** 列出端點可用模型 id（GET /models）。回傳去重、排序後的 id 清單。 */
export async function listModelIds(config: OpenAiClientConfig): Promise<string[]> {
  const raw = await requestJson(config, { method: "GET", path: "/models" });
  const data =
    typeof raw === "object" && raw && "data" in raw ? (raw as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((item) =>
      typeof item === "object" && item && "id" in item ? (item as { id?: unknown }).id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** 有界 readiness 探測：GET /models 並分類狀態，不洩漏原文。 */
export async function probeReady(config: OpenAiClientConfig): Promise<ProviderPreflightStatus> {
  try {
    await requestJson(config, { method: "GET", path: "/models" });
    return "ready";
  } catch (error) {
    if (error instanceof SafeProviderError) {
      if (error.code === "OPENAI_AUTH_REQUIRED") return "auth_required";
      if (error.code === "OPENAI_TIMEOUT") return "timeout";
    }
    return "unknown";
  }
}

/** 安全讀取本機影像檔（拒絕 symlink、驗證 magic bytes、限制大小），回傳 data URL。 */
export async function readImageAsDataUrl(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_INPUT_BYTES)
      throw new SafeProviderError("OPENAI_IMAGE_INPUT_INVALID", "參考影像不合法或過大。");
    const bytes = await handle.readFile();
    const mediaType =
      bytes[0] === 0x89 && bytes[1] === 0x50
        ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8
          ? "image/jpeg"
          : bytes[0] === 0x52 && bytes[1] === 0x49
            ? "image/webp"
            : undefined;
    if (!mediaType)
      throw new SafeProviderError("OPENAI_IMAGE_INPUT_INVALID", "不支援的參考影像格式。");
    return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  } finally {
    await handle.close();
  }
}

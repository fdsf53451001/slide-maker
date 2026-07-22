import { type ProviderPreflightStatus, SafeProviderError } from "@slide-maker/core";

export interface GeminiClientConfig {
  /** AI Studio 端點根位址，如 `https://generativelanguage.googleapis.com/v1beta`。 */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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
  if (cancelSignal?.aborted) throw new DOMException("Gemini request cancelled", "AbortError");
  const name =
    typeof error === "object" && error && "name" in error
      ? (error as { name?: string }).name
      : undefined;
  if (name === "TimeoutError")
    throw new SafeProviderError("GEMINI_TIMEOUT", "Gemini 端點回應逾時。");
  throw new SafeProviderError("GEMINI_REQUEST_FAILED", "無法連線 Gemini 端點。");
}

/**
 * 對 AI Studio 原生端點發出請求並回傳解析後的 JSON。
 *
 * 認證走 `x-goog-api-key` header：AI Studio 不接受 Bearer，而 query string 形式會把
 * 金鑰寫進代理與存取紀錄。錯誤一律轉成 SafeProviderError，端點回應原文（含 key 片段
 * 與 quota 細節）永遠不進 message。
 */
export async function requestJson(
  config: GeminiClientConfig,
  init: RequestInitLike,
): Promise<unknown> {
  const url = joinUrl(config.baseUrl, init.path);
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;
  const requestInit: RequestInit = {
    method: init.method,
    headers: {
      "x-goog-api-key": config.apiKey,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    signal,
    redirect: "error",
  };
  if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);
  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    classifyFetchError(error, init.signal);
  }
  if (!response!.ok) {
    const status = response!.status;
    if (status === 401 || status === 403)
      throw new SafeProviderError(
        "GEMINI_AUTH_REQUIRED",
        "Gemini 端點驗證失敗（請檢查 API key）。",
      );
    if (status === 429)
      throw new SafeProviderError("GEMINI_USAGE_LIMIT", "Gemini 端點達到配額或速率限制。");
    throw new SafeProviderError("GEMINI_REQUEST_FAILED", `Gemini 端點回應 HTTP ${status}。`);
  }
  const declared = Number(response!.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES)
    throw new SafeProviderError("GEMINI_RESPONSE_TOO_LARGE", "Gemini 回應過大。");
  const bytes = new Uint8Array(await response!.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES)
    throw new SafeProviderError("GEMINI_RESPONSE_TOO_LARGE", "Gemini 回應過大。");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) as unknown;
  } catch {
    throw new SafeProviderError("GEMINI_RESPONSE_INVALID", "Gemini 回應不是合法 JSON。");
  }
}

/** 一段回應內容（part）。實測回應會夾帶 `thoughtSignature` 等額外鍵，故只認得出的鍵。 */
export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

/**
 * 取出第一個 candidate 的 parts。
 *
 * 回應的 part 不保證只有一個鍵——實測 `{"text":…,"thoughtSignature":…}` 與
 * `{"inlineData":…,"thoughtSignature":…}` 都會出現，所以判斷一律看「有沒有 text /
 * inlineData 鍵」，不可用「這個 part 是什麼型別」的方式分派。
 */
export function candidateParts(payload: unknown): GeminiPart[] {
  const candidates = (payload as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates)) return [];
  const content = (candidates[0] as { content?: { parts?: unknown } })?.content;
  if (!Array.isArray(content?.parts)) return [];
  // 非物件的 part（實測沒見過，但 JSON 沒有型別保證）要在這裡濾掉：呼叫端一律直接讀
  // `part.text` / `part.inlineData`，碰到 null 會丟 TypeError，那不是 SafeProviderError，
  // 一路冒到 express 就是 500。
  return content.parts.filter(
    (part): part is GeminiPart => typeof part === "object" && part !== null,
  );
}

/** POST `{base}/models/{model}:generateContent`。model 允許帶或不帶 `models/` 前綴。 */
export async function generateContent(
  config: GeminiClientConfig,
  model: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const name = model.trim().replace(/^models\//, "");
  if (!name) throw new SafeProviderError("GEMINI_MODEL_MISSING", "未指定 Gemini 模型名稱。");
  return requestJson(config, {
    method: "POST",
    path: `models/${encodeURIComponent(name)}:generateContent`,
    body,
    ...(signal ? { signal } : {}),
  });
}

/**
 * 列出端點可用模型 id（ListModels）。
 *
 * 只留支援 `generateContent` 的模型：Imagen 系只有 `predict`、Veo 只有
 * `predictLongRunning`、Live 系只有 `bidiGenerateContent`，這些選了也跑不起來。
 * 未回報 supportedGenerationMethods 的條目一律保留，寧可多列也不要漏掉新模型。
 */
export async function listGeminiModelIds(config: GeminiClientConfig): Promise<string[]> {
  const raw = await requestJson(config, { method: "GET", path: "models?pageSize=200" });
  const models = (raw as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const item of models) {
    const entry = item as { name?: unknown; supportedGenerationMethods?: unknown };
    if (typeof entry.name !== "string") continue;
    const methods = entry.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
    const id = entry.name.replace(/^models\//, "").trim();
    if (id) ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** 有界 readiness 探測：ListModels 並分類狀態，不洩漏原文。 */
export async function probeReady(config: GeminiClientConfig): Promise<ProviderPreflightStatus> {
  try {
    await requestJson(config, { method: "GET", path: "models?pageSize=1" });
    return "ready";
  } catch (error) {
    if (error instanceof SafeProviderError) {
      if (error.code === "GEMINI_AUTH_REQUIRED") return "auth_required";
      if (error.code === "GEMINI_TIMEOUT") return "timeout";
    }
    return "unknown";
  }
}

/** `rethrowAsGeminiError` 的收尾代碼：非 SafeProviderError 一律換成這個安全形狀。 */
export interface GeminiErrorFallback {
  code: string;
  message: string;
}

export const GEMINI_IMAGE_OUTPUT_FALLBACK: GeminiErrorFallback = {
  code: "GEMINI_IMAGE_INVALID",
  message: "Gemini 回應的影像資料無法處理。",
};
export const GEMINI_IMAGE_INPUT_FALLBACK: GeminiErrorFallback = {
  code: "GEMINI_IMAGE_INPUT_INVALID",
  message: "參考影像無法讀取或格式不支援。",
};

/**
 * 把 provider-openai 共用工具丟出的錯誤轉成 Gemini 自己的安全錯誤。
 *
 * 兩件事：`OPENAI_*` 錯誤碼改掛 `GEMINI_` 前綴（那些工具的 safeMessage 本身不提端點，
 * 只有錯誤碼帶著另一個 provider 的名字，使用者看到 `OPENAI_IMAGE_INVALID` 會誤以為是
 * 別條通道壞了）；以及**非 SafeProviderError 也要收掉**——那些工具有兩條路徑會丟裸
 * `Error`：PNG 結構驗證的訊息寫著 "Codex"，而 `open(…, O_NOFOLLOW)` 失敗丟的原生 fs
 * 錯誤 message 帶著完整檔案路徑，直接冒到 API 回應等於洩漏伺服器路徑。
 *
 * 取消訊號（AbortError／TimeoutError）不屬於此類，必須原樣往上丟，否則上游分不出
 * 「使用者取消」與「內容壞掉」。
 */
export function rethrowAsGeminiError(
  error: unknown,
  fallback: GeminiErrorFallback = GEMINI_IMAGE_OUTPUT_FALLBACK,
): never {
  if (error instanceof SafeProviderError) {
    if (!error.code.startsWith("OPENAI_")) throw error;
    throw new SafeProviderError(`GEMINI_${error.code.slice("OPENAI_".length)}`, error.safeMessage);
  }
  const name =
    typeof error === "object" && error && "name" in error
      ? (error as { name?: string }).name
      : undefined;
  if (name === "AbortError" || name === "TimeoutError") throw error;
  throw new SafeProviderError(fallback.code, fallback.message);
}

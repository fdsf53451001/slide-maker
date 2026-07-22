import {
  CODEX_DEFAULT_TIMEOUT_MS,
  CODEX_MAX_TIMEOUT_MS,
  CODEX_MIN_TIMEOUT_MS,
} from "@slide-maker/provider-codex";

export const DEFAULT_CODEX_TIMEOUT_MS = CODEX_DEFAULT_TIMEOUT_MS;
export const MIN_CODEX_TIMEOUT_MS = CODEX_MIN_TIMEOUT_MS;
export const MAX_CODEX_TIMEOUT_MS = CODEX_MAX_TIMEOUT_MS;
export const DEFAULT_CODEX_MAX_CONCURRENCY = 3;
export const MAX_CODEX_MAX_CONCURRENCY = 4;

export function parseCodexTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_CODEX_TIMEOUT_MS;
  if (!/^\d+$/.test(value))
    throw new Error("SLIDE_MAKER_CODEX_TIMEOUT_MS must be an integer in milliseconds");
  const timeout = Number(value);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_CODEX_TIMEOUT_MS ||
    timeout > MAX_CODEX_TIMEOUT_MS
  ) {
    throw new Error(
      `SLIDE_MAKER_CODEX_TIMEOUT_MS must be between ${MIN_CODEX_TIMEOUT_MS} and ${MAX_CODEX_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

export const OCR_MODEL_TIERS = ["mobile", "hybrid", "server"] as const;
export type OcrModelTier = (typeof OCR_MODEL_TIERS)[number];
export const DEFAULT_OCR_MODEL_TIER: OcrModelTier = "hybrid";
export const DEFAULT_OCR_DET_SIDE_LEN = 1920;
export const MIN_OCR_DET_SIDE_LEN = 512;
export const MAX_OCR_DET_SIDE_LEN = 4096;

export function parseOcrModelTier(value: string | undefined): OcrModelTier {
  if (value === undefined || value.trim() === "") return DEFAULT_OCR_MODEL_TIER;
  if (!(OCR_MODEL_TIERS as readonly string[]).includes(value))
    throw new Error(`SLIDE_MAKER_OCR_MODEL_TIER must be one of: ${OCR_MODEL_TIERS.join(", ")}`);
  return value as OcrModelTier;
}

export function parseOcrDetSideLen(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_OCR_DET_SIDE_LEN;
  if (!/^\d+$/.test(value)) throw new Error("SLIDE_MAKER_OCR_DET_SIDE_LEN must be an integer");
  const sideLen = Number(value);
  if (
    !Number.isSafeInteger(sideLen) ||
    sideLen < MIN_OCR_DET_SIDE_LEN ||
    sideLen > MAX_OCR_DET_SIDE_LEN
  ) {
    throw new Error(
      `SLIDE_MAKER_OCR_DET_SIDE_LEN must be between ${MIN_OCR_DET_SIDE_LEN} and ${MAX_OCR_DET_SIDE_LEN}`,
    );
  }
  return sideLen;
}

export function parseCodexModel(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

export const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export function parseCodexReasoningEffort(
  value: string | undefined,
): CodexReasoningEffort | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(
      `SLIDE_MAKER_CODEX_REASONING_EFFORT must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}`,
    );
  }
  return value as CodexReasoningEffort;
}

/** 永遠放行的主機名。這三個以外一律要靠 SLIDE_MAKER_TRUSTED_HOSTS 明確列出。 */
export const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "::1"] as const;

/**
 * 額外放行的主機名（逗號分隔），用於雲端部署。未設時回空陣列，行為與過去完全
 * 相同——本機開發的防護不因這個選項而改變。
 *
 * 刻意不接受萬用字元：這份白名單是 API 對外的唯一防線，放行範圍必須逐一寫死。
 */
export function parseTrustedHosts(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  if (hosts.length === 0)
    throw new Error("SLIDE_MAKER_TRUSTED_HOSTS must list at least one hostname when set");
  for (const host of hosts) {
    if (host.includes("*"))
      throw new Error(
        "SLIDE_MAKER_TRUSTED_HOSTS must not contain wildcards; list hostnames one by one",
      );
    if (!/^[a-z0-9._:-]+$/.test(host))
      throw new Error(`SLIDE_MAKER_TRUSTED_HOSTS contains an invalid hostname: ${host}`);
  }
  return hosts;
}

export const DEFAULT_OPENAI_TIMEOUT_MS = 120_000;
export const MIN_OPENAI_TIMEOUT_MS = 5_000;
export const MAX_OPENAI_TIMEOUT_MS = 30 * 60_000;

export const AI_ENGINES = ["codex", "openai"] as const;
export type AiEngine = (typeof AI_ENGINES)[number];

export const OPENAI_IMAGE_APIS = ["images", "chat", "openrouter-image"] as const;
export type OpenAiImageApi = (typeof OPENAI_IMAGE_APIS)[number];

/**
 * 影像端點型態：`images`（CLI2Proxy `/images/generations`＋`/images/edits`，gpt-image 系，預設）、
 * `chat`（CLI2Proxy `/chat/completions`，GPT tool / Gemini native）、`openrouter-image`
 * （OpenRouter 專用 `/images` 端點，`input_references` 帶參考圖）。
 */
export function parseOpenAiImageApi(value: string | undefined): OpenAiImageApi {
  if (value === undefined || value.trim() === "") return "images";
  if (!(OPENAI_IMAGE_APIS as readonly string[]).includes(value))
    throw new Error(`SLIDE_MAKER_OPENAI_IMAGE_API must be one of: ${OPENAI_IMAGE_APIS.join(", ")}`);
  return value as OpenAiImageApi;
}

/** OpenAI-compatible 端點根位址（http/https），未設回 undefined，非法值 throw。 */
export function parseOpenAiBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("SLIDE_MAKER_OPENAI_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("SLIDE_MAKER_OPENAI_BASE_URL must be an http(s) URL");
  return trimmed;
}

/** 非空字串（API key / 模型名），未設回 undefined。 */
export function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

export function parseOpenAiTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_OPENAI_TIMEOUT_MS;
  if (!/^\d+$/.test(value))
    throw new Error("SLIDE_MAKER_OPENAI_TIMEOUT_MS must be an integer in milliseconds");
  const timeout = Number(value);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_OPENAI_TIMEOUT_MS ||
    timeout > MAX_OPENAI_TIMEOUT_MS
  ) {
    throw new Error(
      `SLIDE_MAKER_OPENAI_TIMEOUT_MS must be between ${MIN_OPENAI_TIMEOUT_MS} and ${MAX_OPENAI_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

/** 引擎選擇（codex 預設 | openai），非法值 throw。 */
export function parseAiEngine(name: string, value: string | undefined): AiEngine {
  if (value === undefined || value.trim() === "") return "codex";
  if (!(AI_ENGINES as readonly string[]).includes(value))
    throw new Error(`${name} must be one of: ${AI_ENGINES.join(", ")}`);
  return value as AiEngine;
}

export function parseCodexMaxConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_CODEX_MAX_CONCURRENCY;
  if (!/^\d+$/.test(value)) throw new Error("SLIDE_MAKER_CODEX_MAX_CONCURRENCY must be an integer");
  const concurrency = Number(value);
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CODEX_MAX_CONCURRENCY
  ) {
    throw new Error(
      `SLIDE_MAKER_CODEX_MAX_CONCURRENCY must be between 1 and ${MAX_CODEX_MAX_CONCURRENCY}`,
    );
  }
  return concurrency;
}

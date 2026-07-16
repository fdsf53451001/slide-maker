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

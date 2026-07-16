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

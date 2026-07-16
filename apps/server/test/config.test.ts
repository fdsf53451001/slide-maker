import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MAX_CONCURRENCY,
  DEFAULT_CODEX_TIMEOUT_MS,
  MAX_CODEX_TIMEOUT_MS,
  MIN_CODEX_TIMEOUT_MS,
  parseCodexMaxConcurrency,
  parseCodexTimeoutMs,
} from "../src/config.js";

describe("Codex timeout configuration", () => {
  it("defaults to ten minutes", () =>
    expect(parseCodexTimeoutMs(undefined)).toBe(DEFAULT_CODEX_TIMEOUT_MS));
  it("accepts inclusive bounds", () => {
    expect(parseCodexTimeoutMs(String(MIN_CODEX_TIMEOUT_MS))).toBe(MIN_CODEX_TIMEOUT_MS);
    expect(parseCodexTimeoutMs(String(MAX_CODEX_TIMEOUT_MS))).toBe(MAX_CODEX_TIMEOUT_MS);
  });
  it.each(["nope", "29999", "1800001", "1.5", "-30000"])("rejects invalid value %s", (value) => {
    expect(() => parseCodexTimeoutMs(value)).toThrow(/SLIDE_MAKER_CODEX_TIMEOUT_MS/);
  });
});

describe("Codex concurrency configuration", () => {
  it("defaults to bounded parallel generation", () =>
    expect(parseCodexMaxConcurrency(undefined)).toBe(DEFAULT_CODEX_MAX_CONCURRENCY));
  it.each(["1", "2", "3", "4"])("accepts %s", (value) =>
    expect(parseCodexMaxConcurrency(value)).toBe(Number(value)),
  );
  it.each(["0", "5", "1.5", "-1", "nope"])("rejects %s", (value) =>
    expect(() => parseCodexMaxConcurrency(value)).toThrow(/SLIDE_MAKER_CODEX_MAX_CONCURRENCY/),
  );
});

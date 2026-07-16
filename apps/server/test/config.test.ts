import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MAX_CONCURRENCY,
  DEFAULT_CODEX_TIMEOUT_MS,
  DEFAULT_OCR_DET_SIDE_LEN,
  DEFAULT_OCR_MODEL_TIER,
  MAX_CODEX_TIMEOUT_MS,
  MAX_OCR_DET_SIDE_LEN,
  MIN_CODEX_TIMEOUT_MS,
  MIN_OCR_DET_SIDE_LEN,
  parseCodexMaxConcurrency,
  parseCodexTimeoutMs,
  parseOcrDetSideLen,
  parseOcrModelTier,
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

describe("OCR model tier configuration", () => {
  it("defaults to hybrid", () => expect(parseOcrModelTier(undefined)).toBe(DEFAULT_OCR_MODEL_TIER));
  it.each(["mobile", "hybrid", "server"])("accepts %s", (value) =>
    expect(parseOcrModelTier(value)).toBe(value),
  );
  it.each(["Mobile", "light", "SERVER", "fast"])("rejects %s", (value) =>
    expect(() => parseOcrModelTier(value)).toThrow(/SLIDE_MAKER_OCR_MODEL_TIER/),
  );
});

describe("OCR detection side length configuration", () => {
  it("defaults to full-resolution slides", () =>
    expect(parseOcrDetSideLen(undefined)).toBe(DEFAULT_OCR_DET_SIDE_LEN));
  it("accepts inclusive bounds", () => {
    expect(parseOcrDetSideLen(String(MIN_OCR_DET_SIDE_LEN))).toBe(MIN_OCR_DET_SIDE_LEN);
    expect(parseOcrDetSideLen(String(MAX_OCR_DET_SIDE_LEN))).toBe(MAX_OCR_DET_SIDE_LEN);
  });
  it.each(["1920px", "2k", "511", "4097", "-1920", "1.5"])("rejects %s", (value) =>
    expect(() => parseOcrDetSideLen(value)).toThrow(/SLIDE_MAKER_OCR_DET_SIDE_LEN/),
  );
});

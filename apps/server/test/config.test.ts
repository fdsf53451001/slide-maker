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
  parseCodexModel,
  parseCodexReasoningEffort,
  parseCodexTimeoutMs,
  parseOcrDetSideLen,
  parseOcrModelTier,
  DEFAULT_OPENAI_TIMEOUT_MS,
  MAX_OPENAI_TIMEOUT_MS,
  MIN_OPENAI_TIMEOUT_MS,
  parseAiEngine,
  parseOpenAiBaseUrl,
  parseOpenAiImageApi,
  parseOpenAiTimeoutMs,
  parseOptionalString,
  parseTrustedHosts,
  LOCAL_HOSTNAMES,
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

describe("Codex model override configuration", () => {
  it("defaults to no override", () => {
    expect(parseCodexModel(undefined)).toBeUndefined();
    expect(parseCodexModel("")).toBeUndefined();
    expect(parseCodexModel("  ")).toBeUndefined();
  });
  it("trims and passes through any non-empty value", () =>
    expect(parseCodexModel("  gpt-5.6-terra  ")).toBe("gpt-5.6-terra"));
});

describe("Codex reasoning effort configuration", () => {
  it("defaults to no override", () => {
    expect(parseCodexReasoningEffort(undefined)).toBeUndefined();
    expect(parseCodexReasoningEffort("")).toBeUndefined();
  });
  it.each(["minimal", "low", "medium", "high"])("accepts %s", (value) =>
    expect(parseCodexReasoningEffort(value)).toBe(value),
  );
  it.each(["High", "extreme", "nope"])("rejects %s", (value) =>
    expect(() => parseCodexReasoningEffort(value)).toThrow(/SLIDE_MAKER_CODEX_REASONING_EFFORT/),
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

describe("OpenAI-compatible endpoint configuration", () => {
  it("treats blank base URL as unset", () => {
    expect(parseOpenAiBaseUrl(undefined)).toBeUndefined();
    expect(parseOpenAiBaseUrl("  ")).toBeUndefined();
  });
  it("accepts http(s) URLs and trims", () =>
    expect(parseOpenAiBaseUrl(" http://localhost:8317/v1 ")).toBe("http://localhost:8317/v1"));
  it.each(["ftp://x", "not a url", "ws://host"])("rejects %s", (value) =>
    expect(() => parseOpenAiBaseUrl(value)).toThrow(/SLIDE_MAKER_OPENAI_BASE_URL/),
  );

  it("optional strings collapse blanks to undefined", () => {
    expect(parseOptionalString(undefined)).toBeUndefined();
    expect(parseOptionalString("  ")).toBeUndefined();
    expect(parseOptionalString(" gpt-image-1 ")).toBe("gpt-image-1");
  });

  it("selects and validates the image transport", () => {
    expect(parseOpenAiImageApi(undefined)).toBe("images");
    expect(parseOpenAiImageApi("images")).toBe("images");
    expect(parseOpenAiImageApi("chat")).toBe("chat");
    expect(() => parseOpenAiImageApi("responses")).toThrow(/SLIDE_MAKER_OPENAI_IMAGE_API/);
  });

  it("timeout defaults and bounds", () => {
    expect(parseOpenAiTimeoutMs(undefined)).toBe(DEFAULT_OPENAI_TIMEOUT_MS);
    expect(parseOpenAiTimeoutMs(String(MIN_OPENAI_TIMEOUT_MS))).toBe(MIN_OPENAI_TIMEOUT_MS);
    expect(parseOpenAiTimeoutMs(String(MAX_OPENAI_TIMEOUT_MS))).toBe(MAX_OPENAI_TIMEOUT_MS);
  });
  it.each(["nope", "4999", "1800001", "1.5"])("rejects timeout %s", (value) =>
    expect(() => parseOpenAiTimeoutMs(value)).toThrow(/SLIDE_MAKER_OPENAI_TIMEOUT_MS/),
  );

  it("engine defaults to codex and validates the enum", () => {
    expect(parseAiEngine("SLIDE_MAKER_TEXT_ENGINE", undefined)).toBe("codex");
    expect(parseAiEngine("SLIDE_MAKER_TEXT_ENGINE", "openai")).toBe("openai");
    expect(() => parseAiEngine("SLIDE_MAKER_TEXT_ENGINE", "grok")).toThrow(
      /SLIDE_MAKER_TEXT_ENGINE/,
    );
  });
});

describe("trusted host configuration", () => {
  it("defaults to no extra hosts, so the guard stays local-only", () => {
    expect(parseTrustedHosts(undefined)).toEqual([]);
    expect(parseTrustedHosts("")).toEqual([]);
    expect(parseTrustedHosts("   ")).toEqual([]);
  });

  it("splits, trims and lowercases a comma-separated list", () =>
    expect(parseTrustedHosts(" App.Example.COM , slide-maker-abc-de.a.run.app ")).toEqual([
      "app.example.com",
      "slide-maker-abc-de.a.run.app",
    ]));

  it("drops empty entries but keeps the remaining hosts", () =>
    expect(parseTrustedHosts("a.example.com,,b.example.com,")).toEqual([
      "a.example.com",
      "b.example.com",
    ]));

  it("rejects wildcards so the allowlist can never widen implicitly", () => {
    expect(() => parseTrustedHosts("*")).toThrow(/wildcards/);
    expect(() => parseTrustedHosts("*.example.com")).toThrow(/wildcards/);
  });

  it.each(["exa mple.com", "https://example.com", "example.com/path", "exam,ple.com;drop"])(
    "rejects malformed hostname %s",
    (value) => expect(() => parseTrustedHosts(value)).toThrow(/SLIDE_MAKER_TRUSTED_HOSTS/),
  );

  it("keeps the local names available for the guard to merge in", () =>
    expect(LOCAL_HOSTNAMES).toEqual(["localhost", "127.0.0.1", "::1"]));
});

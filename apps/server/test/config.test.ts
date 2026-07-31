import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_OCR_DET_SIDE_LEN,
  DEFAULT_OCR_MODEL_TIER,
  MAX_MODEL_TIMEOUT_MS,
  MAX_OCR_DET_SIDE_LEN,
  MIN_MODEL_TIMEOUT_MS,
  MIN_OCR_DET_SIDE_LEN,
  parseModelTimeoutMs,
  parseImageDescriptionMode,
  parseOcrDetSideLen,
  parseOcrModelTier,
  DEFAULT_OPENAI_TIMEOUT_MS,
  MAX_OPENAI_TIMEOUT_MS,
  MIN_OPENAI_TIMEOUT_MS,
  parseOpenAiBaseUrl,
  parseOpenAiImageApi,
  parseOpenAiTimeoutMs,
  parseOptionalString,
  parseTrustedHosts,
  parseWebRenderEngine,
  parseWebRenderTimeoutMs,
  DEFAULT_WEB_RENDER_ENGINE,
  DEFAULT_WEB_RENDER_TIMEOUT_MS,
  MAX_WEB_RENDER_TIMEOUT_MS,
  MIN_WEB_RENDER_TIMEOUT_MS,
  LOCAL_HOSTNAMES,
} from "../src/config.js";

describe("model timeout configuration", () => {
  it("defaults to ten minutes", () =>
    expect(parseModelTimeoutMs(undefined)).toBe(DEFAULT_MODEL_TIMEOUT_MS));
  it("accepts inclusive bounds", () => {
    expect(parseModelTimeoutMs(String(MIN_MODEL_TIMEOUT_MS))).toBe(MIN_MODEL_TIMEOUT_MS);
    expect(parseModelTimeoutMs(String(MAX_MODEL_TIMEOUT_MS))).toBe(MAX_MODEL_TIMEOUT_MS);
  });
  it.each(["nope", "29999", "1800001", "1.5", "-30000"])("rejects invalid value %s", (value) => {
    expect(() => parseModelTimeoutMs(value)).toThrow(/SLIDE_MAKER_MODEL_TIMEOUT_MS/);
  });
});

describe("OCR model tier configuration", () => {
  it("defaults to medium", () => expect(parseOcrModelTier(undefined)).toBe(DEFAULT_OCR_MODEL_TIER));
  it.each(["tiny", "small", "medium"])("accepts %s", (value) =>
    expect(parseOcrModelTier(value)).toBe(value),
  );
  // v5 時代的層級名映射到對應 v6 層級：已設定舊值的環境升級後要照常啟動。
  it.each([
    ["mobile", "small"],
    ["hybrid", "medium"],
    ["server", "medium"],
  ])("maps legacy %s to %s", (legacy, mapped) => expect(parseOcrModelTier(legacy)).toBe(mapped));
  it.each(["Mobile", "light", "MEDIUM", "fast"])("rejects %s", (value) =>
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

describe("web render configuration", () => {
  it("預設走 jina：動態網頁抓不到正文是貼網址通道最常見的失敗", () => {
    expect(parseWebRenderEngine(undefined)).toBe(DEFAULT_WEB_RENDER_ENGINE);
    expect(parseWebRenderEngine("")).toBe("jina");
  });

  it("none 可完全停用第三方 render", () => expect(parseWebRenderEngine("none")).toBe("none"));

  it.each(["jina ", "JINA", "browserless", "off"])("rejects invalid engine %s", (value) =>
    expect(() => parseWebRenderEngine(value)).toThrow(/SLIDE_MAKER_WEB_RENDER_ENGINE/),
  );

  it("timeout 預設 30 秒並接受邊界值", () => {
    expect(parseWebRenderTimeoutMs(undefined)).toBe(DEFAULT_WEB_RENDER_TIMEOUT_MS);
    expect(parseWebRenderTimeoutMs(String(MIN_WEB_RENDER_TIMEOUT_MS))).toBe(
      MIN_WEB_RENDER_TIMEOUT_MS,
    );
    expect(parseWebRenderTimeoutMs(String(MAX_WEB_RENDER_TIMEOUT_MS))).toBe(
      MAX_WEB_RENDER_TIMEOUT_MS,
    );
  });

  it.each(["0", "-1", "1.5", "30s", String(MAX_WEB_RENDER_TIMEOUT_MS + 1)])(
    "rejects invalid timeout %s",
    (value) =>
      expect(() => parseWebRenderTimeoutMs(value)).toThrow(/SLIDE_MAKER_WEB_RENDER_TIMEOUT_MS/),
  );
});

describe("parseImageDescriptionMode", () => {
  it("預設開啟：未設定與空字串都是 on", () => {
    expect(parseImageDescriptionMode(undefined)).toBe("on");
    expect(parseImageDescriptionMode("")).toBe("on");
    expect(parseImageDescriptionMode("   ")).toBe("on");
  });

  it("可整條關掉，大小寫與前後空白都收", () => {
    expect(parseImageDescriptionMode("off")).toBe("off");
    expect(parseImageDescriptionMode("OFF")).toBe("off");
    expect(parseImageDescriptionMode(" off ")).toBe("off");
  });

  // 「打錯字就默默沿用預設」在這個開關上特別危險：它管的是「要不要把使用者上傳的圖片
  // 送給第三方模型」，設成 `0`／`false` 的人以為關掉了，實際上照樣送。
  it.each(["0", "false", "no", "disabled", "1"])("rejects %s", (value) =>
    expect(() => parseImageDescriptionMode(value)).toThrow(/SLIDE_MAKER_IMAGE_DESCRIPTION/),
  );
});

import { describe, expect, it } from "vitest";
import type { SourceAsset } from "@slide-maker/core";
import { highlightSegments, matchSource, searchTerms } from "./sourceSearch.js";

const now = "2026-07-20T00:00:00.000Z";

function source(overrides: Partial<SourceAsset> = {}): SourceAsset {
  return {
    id: "source-1",
    name: "研究摘要.md",
    mediaType: "text/markdown",
    usage: "content",
    allowModelAccess: true,
    status: "indexed",
    assetPath: "assets/sources/source-1/研究摘要.md",
    sizeBytes: 1024,
    extractedText: "2024 年毛利率成長明顯，Gross Margin 來到新高。",
    chunks: [],
    metadata: {},
    createdAt: now,
    ...overrides,
  };
}

describe("searchTerms", () => {
  it("splits on whitespace and lowercases, keeping CJK phrases intact", () => {
    expect(searchTerms("  毛利率成長   Gross Margin ")).toEqual(["毛利率成長", "gross", "margin"]);
  });

  it("returns no terms for a blank query", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("matchSource", () => {
  it("requires every term to match, not just one", () => {
    expect(matchSource(source(), searchTerms("毛利率 2024"))).toBe("text");
    expect(matchSource(source(), searchTerms("毛利率 2025"))).toBeNull();
  });

  it("matches the full text case-insensitively", () => {
    expect(matchSource(source(), searchTerms("gross margin"))).toBe("text");
  });

  it("falls back to the file name when the full text misses", () => {
    expect(matchSource(source(), searchTerms("研究摘要"))).toBe("meta");
  });

  it("falls back to the source url for web sources", () => {
    const web = source({ metadata: { url: "https://techcrunch.com/2024/margins" } });
    expect(matchSource(web, searchTerms("techcrunch"))).toBe("meta");
  });

  it("combines terms across the full text and metadata", () => {
    const web = source({ metadata: { url: "https://techcrunch.com/2024/margins" } });
    expect(matchSource(web, searchTerms("毛利率成長 techcrunch"))).toBe("meta");
  });

  it("matches image sources by name only, since they carry no extracted text", () => {
    const image = source({ name: "流程圖.png", mediaType: "image/png", extractedText: "" });
    expect(matchSource(image, searchTerms("流程圖"))).toBe("meta");
    expect(matchSource(image, searchTerms("毛利率"))).toBeNull();
  });

  it("matches nothing without terms", () => {
    expect(matchSource(source(), [])).toBeNull();
  });
});

describe("highlightSegments", () => {
  it("splits the text around every hit", () => {
    expect(highlightSegments("毛利率成長，毛利率下滑", ["毛利率"])).toEqual([
      { text: "毛利率", hit: true },
      { text: "成長，", hit: false },
      { text: "毛利率", hit: true },
      { text: "下滑", hit: false },
    ]);
  });

  it("preserves the original casing of a case-insensitive hit", () => {
    expect(highlightSegments("Gross Margin", ["gross"])).toEqual([
      { text: "Gross", hit: true },
      { text: " Margin", hit: false },
    ]);
  });

  it("merges overlapping hits from different terms instead of nesting them", () => {
    expect(highlightSegments("abcde", ["abc", "cde"])).toEqual([{ text: "abcde", hit: true }]);
  });

  it("merges adjacent hits into one segment", () => {
    expect(highlightSegments("abcd", ["ab", "cd"])).toEqual([{ text: "abcd", hit: true }]);
  });

  it("keeps hits at the very start and end", () => {
    expect(highlightSegments("ab", ["a", "b"])).toEqual([{ text: "ab", hit: true }]);
    expect(highlightSegments("xay", ["a"])).toEqual([
      { text: "x", hit: false },
      { text: "a", hit: true },
      { text: "y", hit: false },
    ]);
  });

  it("returns the whole text unhighlighted when nothing matches", () => {
    expect(highlightSegments("毛利率", ["營收"])).toEqual([{ text: "毛利率", hit: false }]);
    expect(highlightSegments("毛利率", [])).toEqual([{ text: "毛利率", hit: false }]);
  });

  it("returns no segments for empty text", () => {
    expect(highlightSegments("", ["毛利率"])).toEqual([]);
  });
});

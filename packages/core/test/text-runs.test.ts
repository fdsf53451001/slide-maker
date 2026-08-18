import { describe, expect, it } from "vitest";
import {
  compressTextRuns,
  dominantRunColor,
  hasMultipleColors,
  remapTextRuns,
  resolveTextRuns,
  textRunLines,
} from "../src/text-runs.js";

const box = (text: string, color: string, runs?: { length: number; color: string }[]) =>
  ({ text, color, ...(runs ? { runs } : {}) }) as const;

describe("resolveTextRuns", () => {
  it("沒有 runs 的框回單一段，用框的顏色", () => {
    expect(resolveTextRuns(box("打造未來", "#111111"))).toEqual([
      { text: "打造未來", color: "#111111" },
    ]);
  });

  it("依長度序列切出各段", () => {
    expect(
      resolveTextRuns(
        box("打造 AI Agent 的未來", "#111111", [
          { length: 3, color: "#111111" },
          { length: 8, color: "#ff6b35" },
          { length: 4, color: "#111111" },
        ]),
      ),
    ).toEqual([
      { text: "打造 ", color: "#111111" },
      { text: "AI Agent", color: "#ff6b35" },
      { text: " 的未來", color: "#111111" },
    ]);
  });

  it("分段蓋不滿時，剩下的字回到框的預設色而不是拋錯", () => {
    // 使用者改長了文字但 runs 沒跟上——這在 project.json 裡一定會發生，
    // 讀取端寬容是刻意的設計（見 schema 註解）。
    expect(
      resolveTextRuns(box("穩定與快速", "#111111", [{ length: 2, color: "#1d4ed8" }])),
    ).toEqual([
      { text: "穩定", color: "#1d4ed8" },
      { text: "與快速", color: "#111111" },
    ]);
  });

  it("分段超出文字長度時截斷，不產生空段", () => {
    expect(
      resolveTextRuns(
        box("短", "#111111", [
          { length: 5, color: "#1d4ed8" },
          { length: 5, color: "#ff0000" },
        ]),
      ),
    ).toEqual([{ text: "短", color: "#1d4ed8" }]);
  });

  it("空文字回空陣列", () => {
    expect(resolveTextRuns(box("", "#111111"))).toEqual([]);
  });
});

describe("hasMultipleColors", () => {
  it("每段同色時為 false", () => {
    expect(
      hasMultipleColors(
        box("ab", "#111111", [
          { length: 1, color: "#111111" },
          { length: 1, color: "#111111" },
        ]),
      ),
    ).toBe(false);
  });

  it("段色不同時為 true", () => {
    expect(
      hasMultipleColors(
        box("ab", "#111111", [
          { length: 1, color: "#111111" },
          { length: 1, color: "#ff0000" },
        ]),
      ),
    ).toBe(true);
  });
});

describe("compressTextRuns", () => {
  it("整段同色時回 undefined（＝不寫這個欄位，與加功能前逐位元相同）", () => {
    expect(
      compressTextRuns([
        { text: "abc", color: "#111111" },
        { text: "def", color: "#111111" },
      ]),
    ).toBeUndefined();
  });

  it("相鄰同色段會被併起來", () => {
    expect(
      compressTextRuns([
        { text: "ab", color: "#111111" },
        { text: "cd", color: "#111111" },
        { text: "ef", color: "#ff0000" },
      ]),
    ).toEqual([
      { length: 4, color: "#111111" },
      { length: 2, color: "#ff0000" },
    ]);
  });

  it("空片段不佔一段", () => {
    expect(
      compressTextRuns([
        { text: "", color: "#ff0000" },
        { text: "ab", color: "#111111" },
        { text: "cd", color: "#ff0000" },
      ]),
    ).toEqual([
      { length: 2, color: "#111111" },
      { length: 2, color: "#ff0000" },
    ]);
  });
});

describe("dominantRunColor", () => {
  it("取字數最多的顏色當框的主色", () => {
    expect(
      dominantRunColor(
        [
          { text: "一二三四五", color: "#111111" },
          { text: "紅", color: "#ff0000" },
        ],
        "#000000",
      ),
    ).toBe("#111111");
  });

  it("沒有分段時回 fallback", () => {
    expect(dominantRunColor([], "#123456")).toBe("#123456");
  });
});

describe("remapTextRuns", () => {
  const runs = [
    { length: 3, color: "#111111" },
    { length: 8, color: "#ff6b35" },
    { length: 4, color: "#111111" },
  ];

  it("在段內插入字時，該段跟著變長", () => {
    // "打造 AI Agent 的未來" → "打造 AI Agentic 的未來"
    expect(remapTextRuns("打造 AI Agent 的未來", "打造 AI Agentic 的未來", runs)).toEqual([
      { length: 3, color: "#111111" },
      { length: 10, color: "#ff6b35" },
      { length: 4, color: "#111111" },
    ]);
  });

  it("在段內刪字時，該段跟著變短", () => {
    expect(remapTextRuns("打造 AI Agent 的未來", "打造 AI Age 的未來", runs)).toEqual([
      { length: 3, color: "#111111" },
      { length: 6, color: "#ff6b35" },
      { length: 4, color: "#111111" },
    ]);
  });

  it("整段被刪光時那一段消失", () => {
    expect(remapTextRuns("打造 AI Agent 的未來", "打造  的未來", runs)).toEqual([
      { length: 3, color: "#111111" },
      { length: 4, color: "#111111" },
    ]);
  });

  it("文字沒變時原樣回傳", () => {
    expect(remapTextRuns("abc", "abc", runs)).toEqual(runs);
  });

  it("全部刪光時回 undefined（退回單色）", () => {
    expect(remapTextRuns("打造 AI Agent 的未來", "", runs)).toBeUndefined();
  });

  it("重新對映後的總長度一定等於新文字的長度", () => {
    for (const next of ["打", "打造 AI Agent 的未來!!", "完全換掉的一整句話", "打造 A"]) {
      const mapped = remapTextRuns("打造 AI Agent 的未來", next, runs);
      const total = (mapped ?? []).reduce((sum, run) => sum + run.length, 0);
      if (mapped) expect(total).toBe(next.length);
    }
  });
});

describe("textRunLines", () => {
  it("換行與換色是兩個維度，逐行切出各自的分段", () => {
    expect(
      textRunLines([
        { text: "第一行\n第二", color: "#111111" },
        { text: "行末", color: "#ff0000" },
      ]),
    ).toEqual([
      [{ text: "第一行", color: "#111111" }],
      [
        { text: "第二", color: "#111111" },
        { text: "行末", color: "#ff0000" },
      ],
    ]);
  });

  it("空行仍佔一行", () => {
    expect(textRunLines([{ text: "a\n\nb", color: "#111111" }])).toEqual([
      [{ text: "a", color: "#111111" }],
      [],
      [{ text: "b", color: "#111111" }],
    ]);
  });
});

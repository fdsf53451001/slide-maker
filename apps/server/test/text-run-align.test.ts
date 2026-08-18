import { describe, expect, it } from "vitest";
import { alignRunsToText } from "../src/text-run-align.js";

describe("alignRunsToText", () => {
  it("逐字相符時原樣採用", () => {
    expect(
      alignRunsToText("打造 AI Agent 的未來", [
        { text: "打造 ", color: "#111111" },
        { text: "AI Agent", color: "#ff6b35" },
        { text: " 的未來", color: "#111111" },
      ]),
    ).toEqual([
      { text: "打造 ", color: "#111111" },
      { text: "AI Agent", color: "#ff6b35" },
      { text: " 的未來", color: "#111111" },
    ]);
  });

  it("模型補回 OCR 吃掉的字時仍對得上（實測 gpt-5.6-luna 三次全發生）", () => {
    // OCR 讀到「三個重點：穩定快速成本」，模型輸出時把頓號補了回去。
    expect(
      alignRunsToText("三個重點：穩定快速成本", [
        { text: "三個重點：", color: "#333333" },
        { text: "穩定", color: "#1d4ed8" },
        { text: "、", color: "#333333" },
        { text: "快速", color: "#1d4ed8" },
        { text: "、成本", color: "#333333" },
      ]),
    ).toEqual([
      { text: "三個重點：", color: "#333333" },
      { text: "穩定", color: "#1d4ed8" },
      { text: "快速", color: "#1d4ed8" },
      { text: "成本", color: "#333333" },
    ]);
  });

  it("模型修正 OCR 錯字時仍對得上（Oms → 0ms）", () => {
    expect(
      alignRunsToText("Latency Oms · Tokens 0.0K", [
        { text: "Latency ", color: "#111111" },
        { text: "0ms", color: "#dc2626" },
        { text: " · Tokens ", color: "#111111" },
        { text: "0.0K", color: "#dc2626" },
      ]),
    ).toEqual([
      { text: "Latency ", color: "#111111" },
      { text: "Oms", color: "#dc2626" },
      { text: " · Tokens ", color: "#111111" },
      { text: "0.0K", color: "#dc2626" },
    ]);
  });

  it("模型整段改寫時不會讓文字重複或消失", () => {
    const runs = alignRunsToText("原本的一行字", [
      { text: "完全不同", color: "#111111" },
      { text: "的東西", color: "#ff0000" },
    ]);
    expect(runs.map((run) => run.text).join("")).toBe("原本的一行字");
  });

  it("模型只回一段時整框一色", () => {
    expect(alignRunsToText("整行同色", [{ text: "整行同色", color: "#111111" }])).toEqual([
      { text: "整行同色", color: "#111111" },
    ]);
  });

  it("空片段不佔位置", () => {
    expect(
      alignRunsToText("abc", [
        { text: "", color: "#ff0000" },
        { text: "abc", color: "#111111" },
      ]),
    ).toEqual([{ text: "abc", color: "#111111" }]);
  });

  it("任何輸入下，輸出串起來都等於原文", () => {
    const cases: [string, { text: string; color: string }[]][] = [
      [
        "短",
        [
          { text: "很長很長的一段", color: "#111111" },
          { text: "第二段", color: "#ff0000" },
        ],
      ],
      ["一二三四五六", [{ text: "一", color: "#111111" }]],
      [
        "ABC",
        [
          { text: "A", color: "#111111" },
          { text: "B", color: "#ff0000" },
          { text: "C", color: "#00ff00" },
        ],
      ],
      [
        "中英mix 123",
        [
          { text: "中英", color: "#111111" },
          { text: "mix 123!!", color: "#ff0000" },
        ],
      ],
    ];
    for (const [text, segments] of cases)
      expect(
        alignRunsToText(text, segments)
          .map((run) => run.text)
          .join(""),
      ).toBe(text);
  });
});

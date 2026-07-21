import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceAsset } from "@slide-maker/core";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteFtsRetriever, ftsTerms } from "../src/retriever.js";
import { knownSourceContext } from "../src/source-context.js";

function source(name: string, texts: readonly string[]): SourceAsset {
  const id = randomUUID();
  return {
    id,
    name,
    mediaType: "text/markdown",
    usage: "content",
    allowModelAccess: true,
    status: "indexed",
    assetPath: `assets/${id}.md`,
    sizeBytes: 1,
    extractedText: texts.join("\n"),
    chunks: texts.map((text, index) => ({
      id: `${id}-${index}`,
      text,
      locator: `chunk:${index + 1}`,
    })),
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function retrieverFor(projectId: string, sources: readonly SourceAsset[]): SqliteFtsRetriever {
  const retriever = new SqliteFtsRetriever(
    join(mkdtempSync(join(tmpdir(), "slide-maker-fts-")), "sources.sqlite"),
  );
  retriever.index(projectId, sources);
  return retriever;
}

describe("FTS 查詢詞拆解", () => {
  it("中文按 3-gram 展開：trigram 索引查不到短於 3 字元的詞", () => {
    expect(ftsTerms("電動車市場")).toEqual(["電動車", "動車市", "車市場"]);
  });

  it("英數維持整詞", () => {
    expect(ftsTerms("GLM5.2 analysis")).toEqual(["GLM5.2", "analysis"]);
  });

  it("短於 3 字元的詞略過而不是白白放進查詢", () => {
    expect(ftsTerms("AI 的 x")).toEqual([]);
  });
});

describe("中文全文檢索", () => {
  const projectId = "project-1";

  it("中文查詢命中：舊版把整串當 phrase 並以 AND 串接，實測命中 0 列", () => {
    const sources = [
      source("電動車年報", ["2025 年台灣電動車市場銷量分析"]),
      source("電池報告", ["磷酸鐵鋰電池每度成本趨勢"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const hits = retriever.search(projectId, "台灣電動車市場分析", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.sourceName).toBe("電動車年報");
  });

  it("OR 語意讓跨來源的查詢兩邊都撈得到，而不是一無所獲", () => {
    const sources = [
      source("電動車年報", ["台灣電動車市場銷量"]),
      source("電池報告", ["磷酸鐵鋰電池成本"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const names = new Set(
      retriever.search(projectId, "電動車 磷酸鐵鋰", 10).map((chunk) => chunk.sourceName),
    );
    expect(names).toEqual(new Set(["電動車年報", "電池報告"]));
  });
});

describe("來源上下文配額", () => {
  const projectId = "project-2";

  it("大來源不會吃光名額：每份來源都拿得到保底", () => {
    const big = source(
      "大檔案",
      Array.from({ length: 60 }, (_, index) => `2025 台灣電動車市場銷量分析第 ${index} 段`),
    );
    const sources = [
      big,
      source("充電樁調查", ["全台充電樁佈建數量與分布"]),
      source("電池成本報告", ["磷酸鐵鋰電池每度成本趨勢"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "台灣電動車市場分析", 12);
    const represented = new Set(context.map((chunk) => chunk.id));
    expect(represented).toEqual(new Set(sources.map((item) => item.id)));
    expect(context.length).toBeLessThanOrEqual(12);
  });

  it("一塊都沒命中的來源仍會帶進 prompt，而不是整份消失", () => {
    const sources = [
      source("電動車年報", ["台灣電動車市場銷量分析"]),
      source("無關文件", ["完全不相干的內容"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10);
    expect(new Set(context.map((chunk) => chunk.id))).toEqual(
      new Set(sources.map((item) => item.id)),
    );
  });

  it("排除不可存取與標記為不參與生成的來源", () => {
    const usable = source("可用", ["台灣電動車市場銷量分析"]);
    const blocked = { ...source("不可存取", ["台灣電動車市場另一份"]), allowModelAccess: false };
    const excluded = {
      ...source("排除生成", ["台灣電動車市場第三份"]),
      usage: "exclude-from-generation" as const,
    };
    const sources = [usable, blocked, excluded];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10);
    expect(new Set(context.map((chunk) => chunk.id))).toEqual(new Set([usable.id]));
  });
});

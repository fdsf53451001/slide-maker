import { describe, expect, it } from "vitest";
import type { SourceContextChunk } from "../src/source-context.js";
import {
  allocateOutlineExcerpts,
  OUTLINE_DECK_CHUNK_BUDGET,
  outlineSlideChunkBudget,
} from "../src/outline-sources.js";

/**
 * 階段 2 正文池的總量控制。
 *
 * 這件事錯了不會 throw，也不會有任何一個現有測試變紅——它只會在某個「夠大」的專案上變成
 * 413／context overflow，而且是在階段 1 已經燒掉一次配額之後才發生。逐頁預算兼任不了總量
 * 控制：它的下限是 5，所以頁數一多，總量就線性成長。
 */

const chunk = (sourceId: string, index: number): SourceContextChunk => ({
  id: sourceId,
  name: `${sourceId}.md`,
  url: undefined,
  locator: `chunk:${index}`,
  text: `${sourceId} 的第 ${index} 塊正文`,
});

describe("逐頁塊數預算", () => {
  it("頁數越多每頁越少，但夾在 5..12 之間", () => {
    expect(outlineSlideChunkBudget(1)).toBe(12);
    expect(outlineSlideChunkBudget(8)).toBe(12);
    expect(outlineSlideChunkBudget(12)).toBe(8);
    expect(outlineSlideChunkBudget(20)).toBe(5);
    // 下限 5 是為了讓階段 1 挑的來源至少各拿到一塊；代價是頁數再多也不會低於 5，
    // 總量因此**必須**由 allocateOutlineExcerpts 的全域帳來擋。
    expect(outlineSlideChunkBudget(60)).toBe(5);
    expect(outlineSlideChunkBudget(100)).toBe(5);
  });
});

describe("allocateOutlineExcerpts", () => {
  it("跨頁去重：同一塊只進 prompt 一次，各頁都指得到它", () => {
    const shared = chunk("s1", 1);
    const result = allocateOutlineExcerpts([[shared], [shared], [shared]], () => "S1");
    expect(result.excerpts).toHaveLength(1);
    expect(result.pageRefs).toEqual([["C1"], ["C1"], ["C1"]]);
    expect(result.droppedChunks).toBe(0);
  });

  it("超過全域預算時停止新增，且被丟掉的塊數記得出來", () => {
    // 30 頁 × 10 塊全部相異 = 300 塊；逐頁預算擋不住這種形狀（30 頁的逐頁預算是 5，
    // 但只要每頁指定的來源夠多就會被撐回 12）。
    const pages = Array.from({ length: 30 }, (_, page) =>
      Array.from({ length: 10 }, (_, index) => chunk(`s${page}`, index)),
    );
    const result = allocateOutlineExcerpts(pages, () => undefined);

    expect(result.excerpts).toHaveLength(OUTLINE_DECK_CHUNK_BUDGET);
    expect(result.droppedChunks).toBe(300 - OUTLINE_DECK_CHUNK_BUDGET);
    // ref 連號且不重複——模型是靠這個字串指回正文的。
    expect(result.excerpts.map((excerpt) => excerpt.ref)).toEqual(
      Array.from({ length: OUTLINE_DECK_CHUNK_BUDGET }, (_, index) => `C${index + 1}`),
    );
  });

  it("配額用 round-robin 發，不讓前幾頁把整份預算吃光", () => {
    const pages = Array.from({ length: 30 }, (_, page) =>
      Array.from({ length: 10 }, (_, index) => chunk(`s${page}`, index)),
    );
    const result = allocateOutlineExcerpts(pages, () => undefined);

    // 照頁序一頁一頁發的話，前 10 頁會拿走全部 96 塊，後面 20 頁一塊正文都沒有——
    // 那些頁只能靠 purpose 硬掰，正是這次改動要消滅的失敗形狀。
    expect(result.pageRefs.filter((refs) => !refs.length)).toHaveLength(0);
    const counts = result.pageRefs.map((refs) => refs.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("預算用完後仍可引用已經在 prompt 裡的塊（那不會再多一個字）", () => {
    // 預算改小一點，才驗得到「用完之後」那一格；正式路徑用的是 OUTLINE_DECK_CHUNK_BUDGET。
    const first = chunk("a", 1);
    const second = chunk("b", 1);
    const third = chunk("c", 1);
    // 第 1 輪就把 2 塊的預算用光（a、c）；第 2 輪 A 頁的 b 是新的所以被丟掉，
    // 而 B 頁指的是已經收錄的 a——那不會讓 prompt 多一個字，沒有理由丟掉它。
    const result = allocateOutlineExcerpts(
      [
        [first, second],
        [third, first],
      ],
      () => undefined,
      2,
    );

    expect(result.excerpts.map((excerpt) => excerpt.ref)).toEqual(["C1", "C2"]);
    expect(result.pageRefs).toEqual([["C1"], ["C2", "C1"]]);
    expect(result.droppedChunks).toBe(1);
  });

  it("目錄放不下的來源不編一個對不上的 ref，而是整個欄位省略", () => {
    const result = allocateOutlineExcerpts(
      [[chunk("known", 1), chunk("unknown", 1)]],
      (sourceId) => (sourceId === "known" ? "S1" : undefined),
    );
    expect(result.excerpts[0]!.source).toBe("S1");
    expect(result.excerpts[1]!.source).toBeUndefined();
    expect("source" in result.excerpts[1]!).toBe(false);
  });
});

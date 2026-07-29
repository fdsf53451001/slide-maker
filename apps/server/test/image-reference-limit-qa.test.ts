import { describe, expect, it } from "vitest";
import type { ImageReferenceRole } from "@slide-maker/core";
import { limitReferences } from "../src/jobs.js";

/**
 * `limitReferences` 的邊界補充。
 *
 * `image-reference-limit.test.ts` 已經釘住主線（風格優先、base／mask 不砍、受保護的張數
 * 本身就超限）。這裡補的是它沒走到、但函式自己在註解裡明講「不可賴以成立」的那些前提：
 * 受保護索引不在最前面、剛好等於上限、以及沒有 style 可保時的砍尾順序。
 */
describe("limitReferences 的邊界", () => {
  const ref = (role: ImageReferenceRole) => ({ role });

  it("剛好等於上限時一張都不砍", () => {
    // `references.length <= max` 走的是提早返回那條路；差一個等號就會白跑一次排序。
    const references = [ref("style"), ref("content"), ref("content")];
    expect(limitReferences(references, 3)).toEqual({ keptIndices: [0, 1, 2], droppedIndices: [] });
  });

  it("受保護的索引不在最前面時，保留名單仍依原順序而不是把它們搬到前面", () => {
    // 函式的註解明說「base／mask 目前一定在最前面是排列上的巧合，不是這個函式該賴以成立
    // 的前提」——那個承諾必須有測試，否則哪天 jobs.ts 改成把底圖 push 到尾端，
    // `edit.baseImageIndex` 會靜默指到別的角色。
    const references = [ref("style"), ref("content"), ref("content"), ref("base"), ref("mask")];
    const limited = limitReferences(references, 3, [3, 4]);
    expect(limited.keptIndices).toEqual([0, 3, 4]);
    expect(limited.droppedIndices).toEqual([1, 2]);
    // 呼叫端就是靠這張對照表重算 edit 的索引：base 從 3 變 1、mask 從 4 變 2。
    const keptPosition = new Map(limited.keptIndices.map((index, position) => [index, position]));
    expect(keptPosition.get(3)).toBe(1);
    expect(keptPosition.get(4)).toBe(2);
    // 重算後那兩格確實還是 base／mask。
    const kept = limited.keptIndices.map((index) => references[index]!.role);
    expect(kept[keptPosition.get(3)!]).toBe("base");
    expect(kept[keptPosition.get(4)!]).toBe("mask");
  });

  it("全是同一種角色時依原順序砍尾，前面的優先保留", () => {
    // sourceIds 的排序就是保留的優先序：砍中間或砍頭都會讓「模型最先挑的那張」掉出去。
    const references = [ref("content"), ref("content"), ref("content"), ref("content")];
    const limited = limitReferences(references, 2);
    expect(limited.keptIndices).toEqual([0, 1]);
    expect(limited.droppedIndices).toEqual([2, 3]);
  });

  it("風格圖本身就超過上限時，砍的是尾端的風格圖而不是內容圖優先留下", () => {
    const references = [ref("content"), ref("style"), ref("style"), ref("style")];
    const limited = limitReferences(references, 2);
    // 風格優先級較高，所以留下的是前兩張風格圖；內容圖與尾端那張風格圖被砍。
    expect(limited.keptIndices).toEqual([1, 2]);
    expect(limited.droppedIndices).toEqual([0, 3]);
  });

  it("上限為 0 時全砍，且不會回傳負數預算算出來的怪結果", () => {
    const references = [ref("style"), ref("content")];
    expect(limitReferences(references, 0)).toEqual({ keptIndices: [], droppedIndices: [0, 1] });
  });
});

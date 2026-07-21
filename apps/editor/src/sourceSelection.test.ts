import { describe, expect, it } from "vitest";
import { countSourceSelection, sourceSelectionState, toggleSourcePin } from "./sourceSelection.js";

describe("單頁來源的三態判定", () => {
  const selection = { sourceIds: ["a", "b"], pinnedSourceIds: ["a"] };

  it("使用中且被指定＝我指定", () => {
    expect(sourceSelectionState(selection, "a")).toBe("pinned");
  });

  it("使用中但沒被指定＝AI 選用", () => {
    expect(sourceSelectionState(selection, "b")).toBe("ai");
  });

  it("沒在使用＝沒用到", () => {
    expect(sourceSelectionState(selection, "c")).toBe("unused");
  });

  it("被指定卻不在使用清單裡時顯示成沒用到，而不是謊稱這一頁用了它", () => {
    // 預覽歷史版本時畫面上的 sourceIds 來自舊快照，可能不含目前的指定。
    expect(sourceSelectionState({ sourceIds: [], pinnedSourceIds: ["a"] }, "a")).toBe("unused");
  });
});

describe("點擊切換指定狀態", () => {
  it("沒用到 → 我指定：同時進入使用清單，下次生成才保證用得到", () => {
    const next = toggleSourcePin({ sourceIds: ["b"], pinnedSourceIds: [] }, "a");
    expect(next.sourceIds).toEqual(["b", "a"]);
    expect(next.pinnedSourceIds).toEqual(["a"]);
  });

  it("AI 選用 → 我指定：使用清單不變，只是多了指定", () => {
    const next = toggleSourcePin({ sourceIds: ["a", "b"], pinnedSourceIds: [] }, "a");
    expect(next.sourceIds).toEqual(["a", "b"]);
    expect(next.pinnedSourceIds).toEqual(["a"]);
  });

  it("我指定 → 沒用到：兩份清單都移除，因為使用者的意思是「我不要這個」", () => {
    const next = toggleSourcePin({ sourceIds: ["a", "b"], pinnedSourceIds: ["a"] }, "a");
    expect(next.sourceIds).toEqual(["b"]);
    expect(next.pinnedSourceIds).toEqual([]);
  });

  it("連點三次走完 AI 選用 → 我指定 → 沒用到 → 我指定，且不留重複 id", () => {
    // 起點是「AI 選用」而不是「沒用到」，所以連點兩次不會回到原狀：第二下取消指定時
    // 會一併移出使用清單。這是刻意的——取消指定代表「我不要這個」，不是「還給 AI」。
    const start = { sourceIds: ["a", "b"], pinnedSourceIds: [] as string[] };
    const pinned = toggleSourcePin(start, "b");
    expect(pinned.sourceIds).toEqual(["a", "b"]);
    expect(pinned.pinnedSourceIds).toEqual(["b"]);
    const dropped = toggleSourcePin(pinned, "b");
    expect(dropped.sourceIds).toEqual(["a"]);
    expect(dropped.pinnedSourceIds).toEqual([]);
    const again = toggleSourcePin(dropped, "b");
    expect(again.sourceIds).toEqual(["a", "b"]);
    expect(again.pinnedSourceIds).toEqual(["b"]);
  });

  it("不改動原本的物件，React 狀態才不會被就地竄改", () => {
    const start = { sourceIds: ["a"], pinnedSourceIds: ["a"] };
    toggleSourcePin(start, "a");
    expect(start).toEqual({ sourceIds: ["a"], pinnedSourceIds: ["a"] });
  });

  it("保留其他欄位：整個 slide draft 直接丟進來也不會掉資料", () => {
    const draft = { id: "slide-1", content: "內容", sourceIds: [], pinnedSourceIds: [] };
    expect(toggleSourcePin(draft, "a")).toEqual({
      id: "slide-1",
      content: "內容",
      sourceIds: ["a"],
      pinnedSourceIds: ["a"],
    });
  });
});

describe("狀態計數", () => {
  it("分開數我指定與 AI 選用", () => {
    const counts = countSourceSelection(
      { sourceIds: ["a", "b", "c"], pinnedSourceIds: ["a", "b"] },
      ["a", "b", "c", "d"],
    );
    expect(counts).toEqual({ pinned: 2, ai: 1 });
  });

  it("只數專案裡還存在的來源，殘留的 id 不會讓計數對不上晶片數", () => {
    const counts = countSourceSelection(
      { sourceIds: ["a", "已刪除"], pinnedSourceIds: ["已刪除"] },
      ["a"],
    );
    expect(counts).toEqual({ pinned: 0, ai: 1 });
  });
});

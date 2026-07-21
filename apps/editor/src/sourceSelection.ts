/**
 * 單頁來源的三態選取。
 *
 * `pinned`（我指定）是使用者手動指定必用的來源，`ai`（AI 選用）是模型自己挑進來的，
 * `unused`（沒用到）則是這一頁沒有引用。使用者的點擊只在「我指定」與「非我指定」之間
 * 切換；取消一個 AI 也選用的來源時要一併移出使用清單，因為使用者的意圖就是「我不要這個」。
 */
export type SourceSelectionState = "pinned" | "ai" | "unused";

export interface SlideSourceSelection {
  sourceIds: string[];
  pinnedSourceIds: string[];
}

export const SOURCE_SELECTION_LABEL: Record<SourceSelectionState, string> = {
  pinned: "我指定",
  ai: "AI 選用",
  unused: "沒用到",
};

/** 圖示與框線是不依賴顏色的狀態訊號；沒用到的狀態刻意留白，只以中性邊框與無圖示呈現。 */
export const SOURCE_SELECTION_ICON: Record<SourceSelectionState, string> = {
  pinned: "✓",
  ai: "✦",
  unused: "",
};

/**
 * 點下去會發生什麼事。第一次點「AI 選用」是升級成指定而不是取消，與一般 checkbox 的
 * 心智模型不同，所以要明講——只寫狀態的話，使用者無從預期點擊的結果。
 */
export const SOURCE_SELECTION_ACTION: Record<SourceSelectionState, string> = {
  pinned: "點一下取消指定，並把它移出這一頁",
  ai: "點一下改為我指定",
  unused: "點一下改為我指定",
};

/**
 * `pinnedSourceIds` 理論上恆為 `sourceIds` 的子集（伺服器端會夾），但預覽歷史版本時
 * 畫面上的 sourceIds 來自舊快照，可能不含目前指定的來源；以「有在用」為前提判定，
 * 才不會顯示一個這一頁其實沒引用的「我指定」。
 */
export function sourceSelectionState(
  selection: SlideSourceSelection,
  sourceId: string,
): SourceSelectionState {
  if (!selection.sourceIds.includes(sourceId)) return "unused";
  return selection.pinnedSourceIds.includes(sourceId) ? "pinned" : "ai";
}

/**
 * 切換一份來源的指定狀態：
 * 沒用到 → 我指定（同時進入使用清單）；AI 選用 → 我指定；我指定 → 沒用到（兩份清單都移除）。
 *
 * 取消只影響「這一頁現在的用法」，不是永久封鎖：下次重新生成大綱時，模型仍可能憑自己的
 * 判斷再選上它，屆時它會以「AI 選用」回來。這是刻意接受的取捨——真要永久排除，得另外存
 * 一份排除清單並定義它何時失效，而不是把一次點擊解讀成永久的否決。
 */
export function toggleSourcePin<T extends SlideSourceSelection>(selection: T, sourceId: string): T {
  if (sourceSelectionState(selection, sourceId) === "pinned")
    return {
      ...selection,
      sourceIds: selection.sourceIds.filter((id) => id !== sourceId),
      pinnedSourceIds: selection.pinnedSourceIds.filter((id) => id !== sourceId),
    };
  return {
    ...selection,
    sourceIds: [...new Set([...selection.sourceIds, sourceId])],
    pinnedSourceIds: [...new Set([...selection.pinnedSourceIds, sourceId])],
  };
}

/** 統計列用：只算專案裡還存在的來源，刪掉的來源不該讓計數對不上晶片數。 */
export function countSourceSelection(
  selection: SlideSourceSelection,
  sourceIds: readonly string[],
): { pinned: number; ai: number } {
  let pinned = 0;
  let ai = 0;
  for (const id of sourceIds) {
    const state = sourceSelectionState(selection, id);
    if (state === "pinned") pinned += 1;
    else if (state === "ai") ai += 1;
  }
  return { pinned, ai };
}

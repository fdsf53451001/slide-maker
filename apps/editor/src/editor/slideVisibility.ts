/**
 * 從 `from`（不含）往 `direction` 找下一張可見頁，沒有就回 `undefined`。
 *
 * 簡報模式有四條換頁路徑（鍵盤、滾輪、點擊舞台、控制列按鈕），邊界邏輯只能有這一份：
 * 各寫一份 `Math.min(lastIndex, …)` 正是「某一條路會停在隱藏頁」的來源。回 `undefined`
 * 而不是「夾回原地」是刻意的——呼叫端要區分的正是「還有下一頁」與「已經到底」
 * （控制列的 `disabled`、鍵盤的不迴圈），夾回原地會把這兩件事混成同一個值。
 *
 * `from` 允許落在陣列外：`-1` 配 `+1` 得到第一張可見頁（Home、進場），
 * `slides.length` 配 `-1` 得到最後一張（End）。
 */
export function nextVisibleIndex(
  slides: readonly { hidden?: boolean }[],
  from: number,
  direction: 1 | -1,
): number | undefined {
  for (let index = from + direction; index >= 0 && index < slides.length; index += direction)
    if (!slides[index]?.hidden) return index;
  return undefined;
}

/**
 * 進場用的起始頁：選取的那頁若被隱藏就落到最近的可見頁（先往後、再往前）。
 * 全部頁面都被隱藏時回 `undefined`，呼叫端據此拒絕進入簡報模式。
 */
export function firstPresentableIndex(
  slides: readonly { hidden?: boolean }[],
  preferred: number,
): number | undefined {
  const current = slides[preferred];
  if (current && !current.hidden) return preferred;
  return nextVisibleIndex(slides, preferred, 1) ?? nextVisibleIndex(slides, preferred, -1);
}

/** 可見頁的 id，依現有順序；`api.generateAll` 的 `slideIds` 就吃這個。 */
export function visibleSlideIds(slides: readonly { id: string; hidden?: boolean }[]): string[] {
  return slides.filter((slide) => !slide.hidden).map((slide) => slide.id);
}

/** 隱藏頁的張數；0 代表批次生成完全不必多問一次。 */
export function hiddenSlideCount(slides: readonly { hidden?: boolean }[]): number {
  return slides.reduce((count, slide) => (slide.hidden ? count + 1 : count), 0);
}

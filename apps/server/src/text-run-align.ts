import type { ResolvedTextRun } from "@slide-maker/core";

/**
 * 把模型回的顏色分段對齊回 OCR 讀到的原文。
 *
 * 為什麼需要容錯而不是要求逐字相符：模型會**順手修正 OCR 的錯字**。實測（2026-08-18）
 * `gpt-5.6-luna` 在 fixture 上三次全部發生——補回被 OCR 吃掉的頓號（`穩定快速` →
 * `穩定、快速`）、把 `Oms` 改回 `0ms`；`gemini-3-flash-agent` 在真實頁上也把 `自我錬成`
 * 寫成 `自我鍊成`。這些分段本身是對的，只是文字被動過，直接丟掉整框太浪費。
 *
 * 另一條路（要模型回 `{start, end}` 字元區間）實測更糟：同一批頁面上 `gemini` 每張都有
 * 3–5 個框越界或蓋不滿，而區間錯掉時**沒有任何資訊**可以救——你不知道它指的是哪幾個字。
 * 片段文字至少還有字串可以比對，所以格式選它，代價就是這個對齊層。
 */

/** 超過這個長度就不做 LCS（O(n·m) 的 DP），改用字數比例分配。 */
const MAX_ALIGN_CHARS = 400;

/**
 * 以編輯距離（含**替換**）把 `from` 的每個位置對映到 `to` 的位置。
 * 回傳長度為 `from.length + 1` 的陣列：`map[i]` 是 `from` 的前 i 個字對應到 `to` 的前幾個字。
 *
 * 用編輯距離而不是最長共同子序列，是因為模型最常見的改動是**替換一個字**
 * （`Oms` → `0ms`、`錬` → `鍊`）。LCS 沒有「替換」這個概念，只能表達成「刪一個＋插一個」，
 * 回溯時那個字會被算進前一段，於是 `0ms` 這一段的紅色只蓋到 `ms`，`O` 留在黑色那段——
 * 實測就是這樣錯的。替換讓兩邊的游標同步前進，邊界才落在對的位置。
 */
function alignPositions(from: string, to: string): number[] {
  const n = from.length;
  const m = to.length;
  const table: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const row = table[i];
      const previous = table[i - 1];
      if (!row || !previous) continue;
      const substitute = (previous[j - 1] ?? 0) + (from[i - 1] === to[j - 1] ? 0 : 1);
      row[j] = Math.min(substitute, (previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1);
    }
  const map = new Array<number>(n + 1).fill(0);
  map[n] = m;
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const row = table[i];
    const previous = table[i - 1];
    if (!row || !previous) break;
    const current = row[j] ?? 0;
    const substitute = (previous[j - 1] ?? 0) + (from[i - 1] === to[j - 1] ? 0 : 1);
    if (current === substitute) {
      i -= 1;
      j -= 1;
      map[i] = j;
    } else if (current === (previous[j] ?? 0) + 1) {
      // 模型多打了一個字（原文沒有）：原文游標不動。
      i -= 1;
      map[i] = j;
    } else j -= 1;
  }
  while (i > 0) {
    i -= 1;
    map[i] = 0;
  }
  return map;
}

/**
 * 把模型的分段對齊到 `text`，回傳恰好覆蓋 `text` 的分段。
 *
 * 模型的分段串起來與 `text` 逐字相同時（實測最常見）直接採用，一個 DP 都不跑。
 */
export function alignRunsToText(
  text: string,
  segments: readonly { text: string; color: string }[],
): ResolvedTextRun[] {
  const usable = segments.filter((segment) => segment.text.length > 0);
  if (!text) return [];
  if (!usable.length) return [];
  const joined = usable.map((segment) => segment.text).join("");
  if (joined === text)
    return usable.map((segment) => ({ text: segment.text, color: segment.color }));

  // 邊界在模型字串中的位置 → 對映到原文的位置。
  const boundaries: number[] = [];
  let cursor = 0;
  for (const segment of usable.slice(0, -1)) {
    cursor += segment.text.length;
    boundaries.push(cursor);
  }
  const mapped: number[] = [];
  if (joined.length <= MAX_ALIGN_CHARS && text.length <= MAX_ALIGN_CHARS) {
    const map = alignPositions(joined, text);
    for (const boundary of boundaries) mapped.push(map[boundary] ?? 0);
  } else {
    // 太長就按字數比例攤——這條路只有在模型回了異常長的字串時才會走到。
    for (const boundary of boundaries)
      mapped.push(Math.round((boundary / joined.length) * text.length));
  }

  const runs: ResolvedTextRun[] = [];
  let start = 0;
  usable.forEach((segment, index) => {
    const rawEnd = index === usable.length - 1 ? text.length : (mapped[index] ?? start);
    // 單調且不越界：對齊失準時寧可讓某一段變空（下面會丟掉），也不能讓文字重複或消失。
    const end = Math.max(start, Math.min(text.length, rawEnd));
    const slice = text.slice(start, end);
    if (slice) runs.push({ text: slice, color: segment.color });
    start = end;
  });
  if (start < text.length) {
    const last = runs[runs.length - 1];
    const tail = text.slice(start);
    if (last) last.text += tail;
    else runs.push({ text: tail, color: usable[usable.length - 1]?.color ?? "#ffffff" });
  }
  return runs;
}

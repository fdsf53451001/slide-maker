import type { EditableTextBox, TextRun } from "./schemas.js";

/** 一段實際要畫的文字：`resolveTextRuns()` 的輸出，三個渲染端都吃這個。 */
export interface ResolvedTextRun {
  text: string;
  color: string;
}

/**
 * 一個文字框實際要畫的顏色分段；沒有分段的框回單一段（整框 `color`）。
 *
 * 這是框內多色的**唯一真相**，三個渲染端（伺服器 SVG、編輯器 DOM、PPTX）都必須呼叫它，
 * 不得各自讀 `box.runs` 再自己切一次字串——切法只要有一處不同，症狀就是「編輯畫面、
 * 合成圖、PPTX 三者的換色位置不一樣」，那正是 `text-stroke.ts` 與 `page-number.ts`
 * 兩個前例要防的同一類坑。
 *
 * 對不合法的 `runs` **寬容**（截斷、補尾），不是防呆而是必要：`runs` 存在
 * `project.json` 裡，而 `text` 會被使用者編輯。若讀取端要求兩者永遠一致，任何一次
 * 沒有同步更新 `runs` 的文字編輯都會讓整個專案打不開——那個代價遠大於「有一段字
 * 顏色回到框的預設值」。同理，schema 也刻意不對兩者做 superRefine。
 */
export function resolveTextRuns(
  box: Pick<EditableTextBox, "text" | "color" | "runs">,
): ResolvedTextRun[] {
  if (!box.text) return [];
  const runs = box.runs;
  if (!runs?.length) return [{ text: box.text, color: box.color }];
  const out: ResolvedTextRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (cursor >= box.text.length) break;
    const text = box.text.slice(cursor, cursor + run.length);
    if (text) out.push({ text, color: run.color });
    cursor += run.length;
  }
  // 分段沒蓋滿（文字被編輯過、或資料本來就殘缺）：剩下的字用框的預設色，
  // 與「完全沒有 runs 就整框一色」保持同一個語意。
  if (cursor < box.text.length) out.push({ text: box.text.slice(cursor), color: box.color });
  return out;
}

/** 這個框的字是不是不只一種顏色（`runs` 存在但每段同色時為 false）。 */
export function hasMultipleColors(box: Pick<EditableTextBox, "text" | "color" | "runs">): boolean {
  const runs = resolveTextRuns(box);
  return runs.some((run) => run.color !== runs[0]?.color);
}

/**
 * 把分段壓成 `runs` 欄位；整段同色時回 `undefined`（＝不寫這個欄位）。
 *
 * 「同色就不寫」不是省位元組：沒有 `runs` 的框與加入這個功能之前逐位元相同，所以
 * 單色簡報的 `project.json`、匯出與快照全部不變，回歸測試才對得上。
 */
export function compressTextRuns(segments: readonly ResolvedTextRun[]): TextRun[] | undefined {
  const merged: TextRun[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.color === segment.color) last.length += segment.text.length;
    else merged.push({ length: segment.text.length, color: segment.color });
  }
  return merged.length > 1 ? merged : undefined;
}

/** `runs` 之中佔字數最多的顏色——落地時拿它當框的 `color`（框的主色）。 */
export function dominantRunColor(segments: readonly ResolvedTextRun[], fallback: string): string {
  const weight = new Map<string, number>();
  for (const segment of segments)
    weight.set(segment.color, (weight.get(segment.color) ?? 0) + segment.text.length);
  let best = fallback;
  let bestWeight = 0;
  for (const [color, length] of weight)
    if (length > bestWeight) {
      best = color;
      bestWeight = length;
    }
  return best;
}

/**
 * 文字被編輯之後，把 `runs` 跟著搬過去。
 *
 * 用「共同前綴 ＋ 共同後綴」定位改動範圍，而不是重新對齊整個字串：使用者的編輯幾乎都是
 * 在某一點插入或刪除，這個作法對那個情境是精確的，而且不需要任何模糊比對。改動落在哪一段
 * 就改那一段的長度；跨多段的刪除則把中間整段吃掉。全部刪光時回 `undefined`（＝退回單色）。
 *
 * 不做這件事的代價是「改一個錯字，整行的強調色全沒了」——那會讓使用者不敢碰抽出來的字。
 */
export function remapTextRuns(
  oldText: string,
  newText: string,
  runs: readonly TextRun[] | undefined,
): TextRun[] | undefined {
  if (!runs?.length || oldText === newText) return runs?.length ? [...runs] : undefined;
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  )
    suffix += 1;
  const removed = oldText.length - prefix - suffix;
  const inserted = newText.length - prefix - suffix;
  const out: TextRun[] = [];
  let cursor = 0;
  // 插入點落在兩段交界時歸給**前一段**（游標在強調詞尾端繼續打字，字會延續強調色）。
  let insertionPlaced = false;
  for (const run of runs) {
    const start = cursor;
    const end = cursor + run.length;
    cursor = end;
    // 這一段與被刪掉的區間 [prefix, prefix+removed) 的交集
    const overlap = Math.max(0, Math.min(end, prefix + removed) - Math.max(start, prefix));
    let length = run.length - overlap;
    if (!insertionPlaced && inserted > 0 && prefix <= end) {
      length += inserted;
      insertionPlaced = true;
    }
    if (length > 0) out.push({ length, color: run.color });
  }
  if (!insertionPlaced && inserted > 0 && out.length) {
    const last = out[out.length - 1];
    if (last) last.length += inserted;
  }
  const total = out.reduce((sum, run) => sum + run.length, 0);
  if (!total || out.length < 2) return undefined;
  // 收尾對齊：上面的加減是逐段做的，浮動的那一個字（例如整段被刪光）補在最後一段。
  const last = out[out.length - 1];
  if (last && total !== newText.length)
    last.length = Math.max(1, last.length + newText.length - total);
  return out;
}

/**
 * 把分段依 `\n` 切成「每一行的分段」，供 SVG／DOM 逐行排版使用。
 *
 * 換行與換色是兩個獨立的維度，渲染端要同時處理二維切分；集中在這裡切一次，
 * 三端才不會各自寫一份 off-by-one。
 */
export function textRunLines(segments: readonly ResolvedTextRun[]): ResolvedTextRun[][] {
  const lines: ResolvedTextRun[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1]?.push({ text: part, color: segment.color });
    });
  }
  return lines;
}

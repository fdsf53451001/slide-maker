import type { SourceAsset } from "@slide-maker/core";

/** 命中位置：`text` 表示全文命中，`meta` 表示只靠檔名或 URL 湊齊關鍵字。 */
export type SourceMatch = "text" | "meta";

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/** 空白分詞並轉小寫；中文不分詞，整段當成單一 term 做子字串比對。 */
export function searchTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 所有 term 都要命中（AND），但可以分散在全文、檔名與來源 URL。全文獨力湊齊時回
 * `text`，否則靠 metadata 補齊回 `meta`——後者在預覽對話框裡看不到 highlight，
 * 需要另外說明原因。
 */
export function matchSource(source: SourceAsset, terms: readonly string[]): SourceMatch | null {
  if (!terms.length) return null;
  const text = source.extractedText.toLocaleLowerCase();
  if (terms.every((term) => text.includes(term))) return "text";
  const metadata = `${source.name} ${source.metadata.url ?? ""}`.toLocaleLowerCase();
  if (terms.every((term) => text.includes(term) || metadata.includes(term))) return "meta";
  return null;
}

/**
 * 把全文切成交錯的命中／非命中片段供渲染 `<mark>`。重疊的命中會先合併，避免同一段
 * 文字被切成巢狀片段。
 */
export function highlightSegments(
  text: string,
  terms: readonly string[],
): readonly HighlightSegment[] {
  if (!text) return [];
  const lower = text.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms)
    for (let from = lower.indexOf(term); from >= 0; from = lower.indexOf(term, from + 1))
      ranges.push([from, from + term.length]);
  if (!ranges.length) return [{ text, hit: false }];
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

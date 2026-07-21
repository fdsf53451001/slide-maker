import type { SourceAsset } from "@slide-maker/core";
import type { RetrievedChunk, SqliteFtsRetriever } from "./retriever.js";

export interface SourceContextChunk {
  id: string;
  name: string;
  url: string | undefined;
  locator: string | undefined;
  text: string;
}

/**
 * 挑出要餵給大綱模型的來源片段。
 *
 * 兩階段：先給每份來源保底配額，再用剩餘名額按相關度填。
 *
 * 舊版取全域前 N 名，一份被切成上百塊的大檔案會靠幾個共通詞吃光所有名額，其餘來源
 * 一塊都進不了 prompt；而排序穩定又讓它永遠只拿該檔案的前幾塊，文件中後段的數據
 * （表格、附錄）從來沒被看過。更糟的是大綱的 sourceIds 是從「進了 prompt 的來源」
 * 推導的，落榜的來源連引用都掛不上，UI 上就顯示成「沒有引用全部來源」。
 */
export function knownSourceContext(
  retriever: Pick<SqliteFtsRetriever, "search">,
  projectId: string,
  sources: readonly SourceAsset[],
  query: string,
  limit = 40,
): SourceContextChunk[] {
  const allowed = sources.filter(
    (source) => source.allowModelAccess && source.usage !== "exclude-from-generation",
  );
  if (!allowed.length) return [];
  const allowedById = new Map(allowed.map((source) => [source.id, source]));
  // 多撈幾倍當候選池，讓每份來源都有機會挑到自己最相關的片段而不是被別人排擠掉。
  const ranked = retriever
    .search(projectId, query, limit * 4)
    .filter((chunk) => allowedById.has(chunk.sourceId));

  // 來源數多於名額時只能截斷；讓相關度高的來源先拿到保底名額。
  const bestScore = new Map<string, number>();
  for (const chunk of ranked)
    if (!bestScore.has(chunk.sourceId)) bestScore.set(chunk.sourceId, chunk.score);
  const ordered = [...allowed].sort(
    (left, right) =>
      (bestScore.get(right.id) ?? Number.NEGATIVE_INFINITY) -
      (bestScore.get(left.id) ?? Number.NEGATIVE_INFINITY),
  );

  const quota = Math.max(1, Math.floor(limit / allowed.length));
  const picked: RetrievedChunk[] = [];
  const taken = new Set<string>();
  for (const source of ordered) {
    const own = ranked.filter((chunk) => chunk.sourceId === source.id).slice(0, quota);
    // 一塊都沒命中的來源仍給開頭幾塊：有片段總比在 prompt 裡整份消失好。
    const fill = own.length
      ? own
      : source.chunks.slice(0, quota).map((chunk) => ({
          sourceId: source.id,
          sourceName: source.name,
          id: chunk.id,
          text: chunk.text,
          ...(chunk.locator ? { locator: chunk.locator } : {}),
          score: 0,
        }));
    for (const chunk of fill) {
      picked.push(chunk);
      taken.add(chunk.id);
    }
  }
  // 保底發完後，剩下的名額按相關度補，讓重點來源可以多給幾塊。
  for (const chunk of ranked) {
    if (picked.length >= limit) break;
    if (taken.has(chunk.id)) continue;
    picked.push(chunk);
    taken.add(chunk.id);
  }
  return picked.slice(0, limit).map((chunk) => {
    const source = allowedById.get(chunk.sourceId);
    return {
      id: chunk.sourceId,
      name: chunk.sourceName,
      url: source?.metadata.url,
      locator: chunk.locator,
      text: chunk.text.slice(0, 1_600),
    };
  });
}

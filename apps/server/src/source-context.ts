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
 * 使用者指定的來源在配額計算裡的權重（未指定的一律 1）。
 *
 * 七三分的精神套在「每份來源的配額」上，而不是「指定那一側的總量」：7/3 ≈ 2.3。
 * 兩側份數相同時結果一樣是七比三，份數懸殊時卻差很多——舊版把七成整包給指定的那側，
 * 只指定 1 份、另有 30 份未指定時，那 1 份會獨吞 28 個名額，剩 12 個名額分不完 30 份來源，
 * 有 18 份連一塊都進不了 prompt。那正是 `eeddf9d` 修掉的症狀，不能靠這個功能倒退回去。
 */
const PINNED_WEIGHT = 2.3;

/**
 * 挑出要餵給大綱模型的來源片段。
 *
 * 三輪分配：
 *  1. 保底——每份來源各 1 塊。舊版取全域前 N 名，一份被切成上百塊的大檔案會靠幾個共通詞
 *     吃光所有名額，其餘來源一塊都進不了 prompt；而大綱的 sourceIds 是從「進了 prompt 的
 *     來源」推導的，落榜的來源連引用都掛不上，UI 上就顯示成「沒有引用全部來源」。
 *  2. 加權配額——指定的來源每份拿到約 {@link PINNED_WEIGHT} 倍的份額。
 *  3. 剩餘名額按相關度補，指定來源的片段先補完，讓重點來源可以多給幾塊。
 *
 * `pinnedSourceIds` 是使用者在該頁手動指定的來源。指定是「優先」而非「限定」：沒指定的
 * 來源同樣保證有位子，模型才有機會發現更適合的資料，而不是被勾選鎖死在一個可能不完整的
 * 集合裡。全部沒指定時每份權重相同，行為與加入這個參數前完全一致。
 */
export function knownSourceContext(
  retriever: Pick<SqliteFtsRetriever, "search">,
  projectId: string,
  sources: readonly SourceAsset[],
  query: string,
  limit = 40,
  pinnedSourceIds: readonly string[] = [],
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

  // 已被刪掉或改成不可存取的指定來源要先濾掉，否則會白白占用加權後的名額。
  const pinned = new Set(pinnedSourceIds.filter((id) => allowedById.has(id)));

  const bestScore = new Map<string, number>();
  for (const chunk of ranked)
    if (!bestScore.has(chunk.sourceId)) bestScore.set(chunk.sourceId, chunk.score);
  const byRelevance = (left: SourceAsset, right: SourceAsset): number =>
    (bestScore.get(right.id) ?? Number.NEGATIVE_INFINITY) -
    (bestScore.get(left.id) ?? Number.NEGATIVE_INFINITY);
  // 來源數多於名額時一定有人落榜；指定的整批排在前面，被截掉的才會是沒指定的那些。
  const ordered = [
    ...allowed.filter((source) => pinned.has(source.id)).sort(byRelevance),
    ...allowed.filter((source) => !pinned.has(source.id)).sort(byRelevance),
  ];

  const weightOf = (source: SourceAsset): number => (pinned.has(source.id) ? PINNED_WEIGHT : 1);
  const totalWeight = allowed.reduce((sum, source) => sum + weightOf(source), 0);
  // 刻意不設下限 1：加權後不足一塊的來源由第一輪保底負責，這裡再夾一次只是重複。
  // 四捨五入還會讓配額總和略高於 limit（1 份指定 + 9 份未指定、limit 10 時是 11），
  // 所以保底那一輪必須先跑，否則最後一份來源會被前面的人吃光名額而整份消失。
  const quotaOf = (source: SourceAsset): number =>
    Math.round((limit * weightOf(source)) / totalWeight);

  // 一塊都沒命中的來源退回自己開頭幾塊：有片段總比在 prompt 裡整份消失好。
  const candidates = new Map<string, readonly RetrievedChunk[]>();
  for (const source of allowed) {
    const hits = ranked.filter((chunk) => chunk.sourceId === source.id);
    candidates.set(
      source.id,
      hits.length
        ? hits
        : source.chunks.map((chunk) => ({
            sourceId: source.id,
            sourceName: source.name,
            id: chunk.id,
            text: chunk.text,
            ...(chunk.locator ? { locator: chunk.locator } : {}),
            score: 0,
          })),
    );
  }

  const picked: RetrievedChunk[] = [];
  const taken = new Set<string>();
  const owned = new Map<string, number>();
  const grant = (source: SourceAsset, upTo: number): void => {
    let count = owned.get(source.id) ?? 0;
    for (const chunk of candidates.get(source.id) ?? []) {
      if (count >= upTo || picked.length >= limit) break;
      if (taken.has(chunk.id)) continue;
      picked.push(chunk);
      taken.add(chunk.id);
      count += 1;
    }
    owned.set(source.id, count);
  };

  for (const source of ordered) grant(source, 1);
  for (const source of ordered) grant(source, quotaOf(source));
  for (const chunk of [
    ...ranked.filter((chunk) => pinned.has(chunk.sourceId)),
    ...ranked.filter((chunk) => !pinned.has(chunk.sourceId)),
  ]) {
    if (picked.length >= limit) break;
    if (taken.has(chunk.id)) continue;
    picked.push(chunk);
    taken.add(chunk.id);
  }

  return picked.map((chunk) => {
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

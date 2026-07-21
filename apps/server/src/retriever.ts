import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceAsset } from "@slide-maker/core";

export interface RetrievedChunk {
  sourceId: string;
  sourceName: string;
  id: string;
  text: string;
  locator?: string;
  score: number;
}

/**
 * 把查詢字串拆成 FTS5 詞彙。
 *
 * trigram tokenizer 只索引 3 字元片段，因此：
 *  - 短於 3 字元的詞永遠不會命中（實測 2 字詞回傳 0 列），直接略過而非白白放進查詢。
 *  - 中文沒有空白分詞，整串當 phrase 等於要求文件含有完全相同的連續子字串——
 *    「台灣電動車市場分析」對上「台灣電動車市場銷量分析」就是 0 命中。故按 3-gram 展開，
 *    讓 bm25 以片段的重疊程度排序。
 *  - 英數詞本來就以空白分隔，維持整詞。
 */
export function ftsTerms(query: string): string[] {
  const terms: string[] = [];
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    if (token.length < 3) continue;
    if (/^[\x00-\x7f]+$/.test(token)) {
      terms.push(token);
      continue;
    }
    for (let start = 0; start + 3 <= token.length; start += 1)
      terms.push(token.slice(start, start + 3));
  }
  return [...new Set(terms)];
}

export class SqliteFtsRetriever {
  readonly #database: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    // Each project is reindexed by createApp at startup. Do not drop the shared
    // table here: tsx can briefly overlap old and new processes during a hot
    // reload, and one process dropping it would break the other's startup.
    // Trigram supports CJK substring search as well as Latin queries.
    this.#database.exec(
      "PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks USING fts5(project_id UNINDEXED, source_id UNINDEXED, source_name, chunk_id UNINDEXED, locator UNINDEXED, text, tokenize='trigram');",
    );
  }
  index(projectId: string, sources: readonly SourceAsset[]): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM source_chunks WHERE project_id = ?").run(projectId);
      const insert = this.#database.prepare(
        "INSERT INTO source_chunks(project_id, source_id, source_name, chunk_id, locator, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const source of sources)
        for (const chunk of source.chunks)
          insert.run(projectId, source.id, source.name, chunk.id, chunk.locator ?? "", chunk.text);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  search(projectId: string, query: string, limit: number): RetrievedChunk[] {
    const terms = ftsTerms(query);
    if (!terms.length) return [];
    // OR 而非 AND：檢索的工作是「排序」而不是「過濾」。用 AND 時只要有一個詞沒出現在
    // 某個 chunk，整份來源就一列都不回；跨主題的查詢（topic + audience + purpose）幾乎
    // 不可能全中，於是命中數為 0，呼叫端只好退回「每份來源取前幾塊」的粗糙回退路徑。
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.#database
      .prepare(
        "SELECT source_id, source_name, chunk_id, locator, text, bm25(source_chunks) AS rank FROM source_chunks WHERE source_chunks MATCH ? AND project_id = ? ORDER BY rank LIMIT ?",
      )
      .all(expression, projectId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sourceId: String(row.source_id),
      sourceName: String(row.source_name),
      id: String(row.chunk_id),
      text: String(row.text),
      ...(row.locator ? { locator: String(row.locator) } : {}),
      score: -Number(row.rank),
    }));
  }
}

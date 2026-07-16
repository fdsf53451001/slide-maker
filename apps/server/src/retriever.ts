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
    const expression = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" AND ");
    if (!expression) return [];
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

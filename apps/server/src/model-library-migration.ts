import type { ModelLibrary } from "@slide-maker/core";

/**
 * 把移除 codex 之前寫下的 `models.json` 清洗成新 schema 收得下的形狀。
 *
 * **必須在 `modelLibrarySchema.parse()` 之前對原始 JSON 執行**，不能寫成 parse 之後的
 * 修補：`providerKindSchema` 已經拿掉 `"codex"`，舊檔案進 parse 就整份丟 ZodError，
 * 呼叫端只會看到「模型庫壞了」而退回 seed——使用者自訂的連線、模型與組合會一起消失，
 * 而那正是我們要保住的東西。
 *
 * 做四件事，全部就地丟棄而非改寫成別的 provider：
 *  ① 移除 `providerKind === "codex"` 的 model entry
 *  ② 把指向那些 entry 的組合 ref 拿掉（留著會變成懸空 ref，`resolveTextProvider` 那條
 *     路會在生成時丟 `TEXT_MODEL_NOT_FOUND`；寧可現在就變成「沒設定」，UI 看得見）
 *  ③ `system.codexTimeoutMs` → `modelTimeoutMs`（同語意換名，值保留），
 *     `system.codexMaxConcurrency` 丟棄（唯一使用者是已移除的 codex 影像 provider）
 *  ④ model entry 的 `reasoningEffort` 丟棄（codex 專屬旋鈕）
 *
 * 刻意**不**把 codex entry 自動改指到 openai／gemini：那需要猜使用者想用哪個端點，
 * 猜錯會安靜地把生成導到一個他沒選過的模型上（並燒它的配額）。留成空的 ref，讓模型庫
 * UI 顯示「未設定」比較誠實。
 *
 * 對已經是新格式的文件是 no-op（回 `changed: false`），呼叫端據此決定要不要回寫檔案。
 */
export interface ModelLibraryMigrationResult {
  document: unknown;
  changed: boolean;
  /** 被移除的 model entry id，供呼叫端寫進 log（只有 id，不含 apiKey 等內容）。 */
  removedModelIds: string[];
  /** 因為指向被移除 entry 而被清空的組合 id。 */
  clearedCombinationIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migrateModelLibraryDocument(input: unknown): ModelLibraryMigrationResult {
  const empty: ModelLibraryMigrationResult = {
    document: input,
    changed: false,
    removedModelIds: [],
    clearedCombinationIds: [],
  };
  if (!isRecord(input)) return empty;

  const document: Record<string, unknown> = { ...input };
  let changed = false;

  // ① + ④ model entries
  const removedModelIds: string[] = [];
  if (Array.isArray(document.models)) {
    const kept: unknown[] = [];
    for (const entry of document.models) {
      if (!isRecord(entry)) {
        kept.push(entry);
        continue;
      }
      if (entry.providerKind === "codex") {
        if (typeof entry.id === "string") removedModelIds.push(entry.id);
        changed = true;
        continue;
      }
      if ("reasoningEffort" in entry) {
        const { reasoningEffort: _dropped, ...rest } = entry;
        kept.push(rest);
        changed = true;
        continue;
      }
      kept.push(entry);
    }
    if (changed) document.models = kept;
  }

  // ② combinations：只清掉指向被移除 entry 的那幾個 ref，其餘原樣保留。
  const clearedCombinationIds: string[] = [];
  if (removedModelIds.length > 0 && Array.isArray(document.combinations)) {
    const removed = new Set(removedModelIds);
    document.combinations = document.combinations.map((combination) => {
      if (!isRecord(combination)) return combination;
      const next = { ...combination };
      let touched = false;
      for (const key of ["imageModelRef", "textModelRef", "searchModelRef"] as const) {
        if (typeof next[key] === "string" && removed.has(next[key] as string)) {
          delete next[key];
          touched = true;
        }
      }
      if (touched) {
        changed = true;
        if (typeof next.id === "string") clearedCombinationIds.push(next.id);
      }
      return touched ? next : combination;
    });
  }

  // ③ system 旋鈕
  if (isRecord(document.system)) {
    const system: Record<string, unknown> = { ...document.system };
    if ("codexTimeoutMs" in system) {
      // 已經有新欄位時以新欄位為準（重複存在只可能來自手改檔案）。
      if (system.modelTimeoutMs === undefined) system.modelTimeoutMs = system.codexTimeoutMs;
      delete system.codexTimeoutMs;
      changed = true;
    }
    if ("codexMaxConcurrency" in system) {
      delete system.codexMaxConcurrency;
      changed = true;
    }
    if (changed) document.system = system;
  }

  if (!changed) return empty;
  return { document, changed: true, removedModelIds, clearedCombinationIds };
}

/** 型別便利包裝：清洗後仍是未驗證的原始文件，呼叫端負責 parse。 */
export type MigratedModelLibrary = ModelLibrary;

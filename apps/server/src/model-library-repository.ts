import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { logWarn, modelLibrarySchema, type ModelLibrary } from "@slide-maker/core";
import { migrateModelLibraryDocument } from "./model-library-migration.js";

/**
 * 模型庫持久化：單一 `models.json`（存於 DATA_ROOT）。原子寫入 + 串行 lock，
 * 與 {@link FileProjectRepository} 同慣例。key 以明文存於 server 端，redact 屬 API 職責。
 */
export class ModelLibraryRepository {
  readonly #path: string;
  #lock: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.#path = join(resolve(dataRoot), "models.json");
  }

  /**
   * 讀取；檔案不存在回 undefined（由呼叫端決定 seed）。
   *
   * 清洗**排在 parse 之前**：schema 已經拿掉 `providerKind: "codex"` 等舊值，帶著它們的
   * 檔案進 parse 會整份丟 ZodError，使用者自訂的連線與組合就一起沒了。遷移過的內容會
   * 立刻回寫，避免每次開機都重跑一遍、也讓管理 UI 看到的與磁碟上的一致。
   */
  async load(): Promise<ModelLibrary | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const migration = migrateModelLibraryDocument(raw);
    const library = modelLibrarySchema.parse(migration.document);
    if (!migration.changed) return library;
    logWarn("model_library_migrated", {
      removedModelIds: migration.removedModelIds,
      clearedCombinationIds: migration.clearedCombinationIds,
    });
    return this.save(library);
  }

  /** 讀取；不存在則以 seed 產生並寫入後回傳。 */
  async loadOrSeed(seed: () => ModelLibrary): Promise<ModelLibrary> {
    const existing = await this.load();
    if (existing) return existing;
    const seeded = seed();
    await this.save(seeded);
    return seeded;
  }

  async save(library: ModelLibrary): Promise<ModelLibrary> {
    return this.#withLock(async () => {
      const validated = modelLibrarySchema.parse(library);
      await mkdir(dirname(this.#path), { recursive: true });
      const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#path);
      return validated;
    });
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lock;
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.#lock = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

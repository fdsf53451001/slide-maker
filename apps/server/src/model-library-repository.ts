import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { modelLibrarySchema, type ModelLibrary } from "@slide-maker/core";

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

  /** 讀取；檔案不存在回 undefined（由呼叫端決定 seed）。 */
  async load(): Promise<ModelLibrary | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      return modelLibrarySchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
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

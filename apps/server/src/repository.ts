import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  parseProject,
  sortProjectsByUpdatedAt,
  type PresentationProject,
  type StorageAdapter,
} from "@slide-maker/core";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * 路徑片段（專案 id 等）的唯一守門員。
 *
 * 匯出是為了讓**不在專案目錄底下**的儲存體（`usage-ledger.ts` 的帳本）也用同一份規則，
 * 而不是各自寫一條正規表示式——兩份規則遲早會分岔，而分岔的那一天是路徑穿越。
 */
export function assertSafeSegment(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Unsafe path segment: ${value}`);
}

export class FileProjectRepository implements StorageAdapter {
  readonly root: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "projects"), { recursive: true });
  }

  projectRoot(projectId: string): string {
    assertSafeSegment(projectId);
    return join(this.root, "projects", projectId);
  }

  assetPath(projectId: string, relativePath: string): string {
    const projectRoot = this.projectRoot(projectId);
    const path = resolve(projectRoot, "assets", relativePath);
    if (!path.startsWith(`${resolve(projectRoot, "assets")}${sep}`)) {
      throw new Error("Asset path escaped project directory");
    }
    return path;
  }

  /**
   * 專案檔裡存的路徑（`saveAsset` 回傳的那種，帶 `assets/` 前綴）→ 磁碟上的絕對路徑。
   *
   * 存在的理由是 `saveAsset` 與 `assetPath` 的不對稱：前者回傳帶前綴的儲存形式，後者收的
   * 是不帶前綴的相對路徑。呼叫端於是到處自己寫 `.replace(/^assets\//, "")`——同一條規則散
   * 落十幾份，改動時漏掉一份不會有任何測試變紅，只會在執行期指到 `assets/assets/…`。
   *
   * 只剝**開頭的** `assets/`，與 `deleteAsset` 同一條正規表示式：路徑裡別處出現的
   * `assets/` 一律保留，也不做 `join`／`normalize`（越界檢查仍由 `assetPath` 負責）。
   */
  resolveAsset(projectId: string, storedPath: string): string {
    return this.assetPath(projectId, storedPath.replace(/^assets\//, ""));
  }

  async listProjects(): Promise<PresentationProject[]> {
    await this.initialize();
    const entries = await readdir(join(this.root, "projects"), { withFileTypes: true });
    const projects = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.loadProject(entry.name)),
    );
    return sortProjectsByUpdatedAt(
      projects.filter((project): project is PresentationProject => project !== undefined),
    );
  }

  async loadProject(id: string): Promise<PresentationProject | undefined> {
    assertSafeSegment(id);
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.projectRoot(id), "project.json"), "utf8"),
      );
      return parseProject(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async saveProject(project: PresentationProject): Promise<void> {
    await this.withProjectLock(project.id, async () => this.writeProject(project));
  }

  async deleteProject(id: string): Promise<void> {
    assertSafeSegment(id);
    await this.withProjectLock(id, async () => {
      await rm(this.projectRoot(id), { recursive: true, force: true });
    });
  }

  async updateProject<T>(
    id: string,
    update: (project: PresentationProject) => T | Promise<T>,
  ): Promise<T> {
    return this.withProjectLock(id, async () => {
      const project = await this.loadProject(id);
      if (!project) throw new Error("Project not found");
      const result = await update(project);
      await this.writeProject(project);
      return result;
    });
  }

  private async writeProject(project: PresentationProject): Promise<void> {
    const validated = parseProject(project);
    const path = join(this.projectRoot(project.id), "project.json");
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  }

  private async withProjectLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.#locks.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    }
  }

  async saveAsset(projectId: string, relativePath: string, bytes: Uint8Array): Promise<string> {
    const path = this.assetPath(projectId, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    return `assets/${relativePath.replaceAll("\\", "/")}`;
  }

  async deleteAsset(projectId: string, relativePath: string): Promise<void> {
    await rm(this.resolveAsset(projectId, relativePath), { force: true });
  }

  /**
   * 刪掉整個資產目錄。
   *
   * 與 `deleteAsset` 分開是因為 `rm` 不加 `recursive` 對目錄會 throw，而「一個來源一個
   * `sources/<id>/` 目錄」的配置下，只刪檔案會留下空目錄——列目錄的呼叫端（含測試）仍
   * 看得到它，孤兒就沒有真的被清掉。路徑一樣過 `assetPath` 的越界檢查。
   */
  async deleteAssetDirectory(projectId: string, relativePath: string): Promise<void> {
    await rm(this.resolveAsset(projectId, relativePath), { force: true, recursive: true });
  }
}

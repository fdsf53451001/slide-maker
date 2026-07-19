import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseProject, type PresentationProject, type StorageAdapter } from "@slide-maker/core";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function assertSafeSegment(value: string): void {
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

  async listProjects(): Promise<PresentationProject[]> {
    await this.initialize();
    const entries = await readdir(join(this.root, "projects"), { withFileTypes: true });
    const projects = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.loadProject(entry.name)),
    );
    return projects
      .filter((project): project is PresentationProject => project !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
    await rm(this.assetPath(projectId, relativePath.replace(/^assets\//, "")), { force: true });
  }
}

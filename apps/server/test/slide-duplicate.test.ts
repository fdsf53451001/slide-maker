import { access, mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { FileProjectRepository } from "../src/repository.js";

describe("duplicate a slide", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let repository: FileProjectRepository;
  let bindUnavailable = false;

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-slide-duplicate-")),
      ".slide-maker-data",
    );
    const app = await createApp(root);
    // textLayer 配對無法從 API 自然造出來，改由同一個資料根目錄的第二個 repository 落地
    // fixture；測試是循序的，不會與 app 搶鎖。
    repository = new FileProjectRepository(root);
    await repository.initialize();
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        bindUnavailable = true;
        return;
      }
      throw error;
    }
    if (!server) throw new Error("Local test server did not initialize");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function json<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ response: Response; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T;
    return { response, body };
  }

  async function createProject(topic: string): Promise<{ projectId: string; slideId: string }> {
    const created = await json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic }),
    });
    expect(created.response.status).toBe(201);
    return { projectId: created.body.id, slideId: created.body.slides[0]!.id };
  }

  async function generateVersion(projectId: string, slideId: string): Promise<PresentationProject> {
    const queued = await json<{ id: string }>(
      `/api/projects/${projectId}/slides/${slideId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "mock-image" }),
      },
    );
    expect(queued.response.status).toBe(202);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const loaded = await json<PresentationProject>(`/api/projects/${projectId}`);
      const job = loaded.body.jobs.find((candidate) => candidate.id === queued.body.id);
      if (job?.status === "completed") return loaded.body;
      if (job?.status === "failed") throw new Error(`Generation failed: ${job.error}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Generation did not complete in time");
  }

  const duplicateSlide = (projectId: string, slideId: string) =>
    json<PresentationProject>(`/api/projects/${projectId}/slides/${slideId}/duplicate`, {
      method: "POST",
    });

  const exists = async (path: string): Promise<boolean> =>
    access(path).then(
      () => true,
      () => false,
    );

  it("copies the image history and keeps the same version active", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("複製頁面帶圖");
    await generateVersion(projectId, slideId);
    const generated = await generateVersion(projectId, slideId);
    const source = generated.slides[0]!;
    expect(source.versions).toHaveLength(2);

    const duplicated = await duplicateSlide(projectId, slideId);
    expect(duplicated.response.status).toBe(201);
    const copy = duplicated.body.slides[1]!;
    expect(copy.id).not.toBe(source.id);
    // 沒有圖片歷史的複製頁在編輯器裡就是一張空白頁——這正是這個端點要避免的結果。
    expect(copy.versions.map((version) => version.imagePath)).toEqual(
      source.versions.map((version) => version.imagePath),
    );
    // 版本 id 一定要換新：`VERSION_HAS_ACTIVE_JOB` 與 textLayer 引用檢查都不看 slideId。
    expect(copy.versions.map((version) => version.id)).not.toEqual(
      source.versions.map((version) => version.id),
    );
    const sourceIndex = source.versions.findIndex(
      (version) => version.id === source.currentVersionId,
    );
    expect(copy.currentVersionId).toBe(copy.versions[sourceIndex]!.id);
  });

  it("remaps the text layer pairing onto the copied versions", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("複製頁面帶文字圖層");
    const generated = await generateVersion(projectId, slideId);
    const original = generated.slides[0]!.versions[0]!;
    const withTwo = await generateVersion(projectId, slideId);
    const layered = withTwo.slides[0]!.versions[1]!;
    // 第三版是為了讓原頁稍後能把 layered 刪掉（刪版本要求它不是使用中的那一版），
    // 好把「原頁自己的引用」清乾淨——剩下的引用若還擋著刪除，就只可能來自複製頁。
    const withThree = await generateVersion(projectId, slideId);
    expect(withThree.slides[0]!.versions).toHaveLength(3);
    await repository.updateProject(projectId, (current) => {
      const target = current.slides[0]!.versions.find((version) => version.id === layered.id)!;
      const now = new Date().toISOString();
      target.textLayer = {
        originalVersionId: original.id,
        backgroundPath: "assets/generated/background.png",
        compositePath: target.imagePath,
        threshold: 0.75,
        renderRevision: 0,
        boxes: [],
        extractedAt: now,
        updatedAt: now,
      };
    });

    const duplicated = await duplicateSlide(projectId, slideId);
    expect(duplicated.response.status).toBe(201);
    const copy = duplicated.body.slides[1]!;
    // 配對必須指向複製出來的那份原圖，否則複製頁會鎖住原頁的版本刪不掉。
    expect(copy.versions[1]!.textLayer?.originalVersionId).toBe(copy.versions[0]!.id);

    // 原頁刪掉自己那一版帶文字圖層的版本後，就沒有東西再指向 original 了；
    // 若 remap 沒做，複製頁的那一版還指著它，這裡會收到 VERSION_REFERENCED_BY_TEXT_LAYER。
    const droppedLayer = await json<PresentationProject & { error?: string }>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${layered.id}`,
      { method: "DELETE" },
    );
    expect(droppedLayer.response.status).toBe(200);
    const deleted = await json<PresentationProject & { error?: string }>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${original.id}`,
      { method: "DELETE" },
    );
    expect(deleted.body.error).toBeUndefined();
    expect(deleted.response.status).toBe(200);
  });

  it("keeps shared image files alive when the copy's version is deleted", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("複製頁面共用圖檔");
    await generateVersion(projectId, slideId);
    const generated = await generateVersion(projectId, slideId);
    const stale = generated.slides[0]!.versions[0]!;
    const sharedFile = repository.assetPath(projectId, stale.imagePath.replace(/^assets\//, ""));

    const duplicated = await duplicateSlide(projectId, slideId);
    const copy = duplicated.body.slides[1]!;
    const deleted = await json<PresentationProject>(
      `/api/projects/${projectId}/slides/${copy.id}/versions/${copy.versions[0]!.id}`,
      { method: "DELETE" },
    );
    expect(deleted.response.status).toBe(200);
    // 圖檔是共用的（不複製檔案），原頁的同一版還指著它。
    expect(await exists(sharedFile)).toBe(true);
    expect(deleted.body.slides[0]!.versions.map((version) => version.id)).toContain(stale.id);
  });
});

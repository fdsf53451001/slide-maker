import { access, mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject, SlideVersion } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { FileProjectRepository } from "../src/repository.js";

describe("delete a slide version", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let repository: FileProjectRepository;
  let bindUnavailable = false;

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-version-delete-")),
      ".slide-maker-data",
    );
    const app = await createApp(root);
    // 守門條件（進行中的任務、textLayer 配對）在 API 上很難自然造出來，改由同一個
    // 資料根目錄的第二個 repository 直接落地 fixture；測試是循序的，不會與 app 搶鎖。
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

  const exists = async (path: string): Promise<boolean> =>
    access(path).then(
      () => true,
      () => false,
    );

  const deleteVersion = (projectId: string, slideId: string, versionId: string) =>
    json<PresentationProject & { error?: string }>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${versionId}`,
      { method: "DELETE" },
    );

  it("removes an unused version and reclaims its asset", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("刪除版本");
    await generateVersion(projectId, slideId);
    const twoVersions = await generateVersion(projectId, slideId);
    const [first, second] = twoVersions.slides[0]!.versions;
    expect(second?.id).toBe(twoVersions.slides[0]!.currentVersionId);
    const orphanedFile = repository.assetPath(projectId, first!.imagePath.replace(/^assets\//, ""));
    expect(await exists(orphanedFile)).toBe(true);

    const deleted = await deleteVersion(projectId, slideId, first!.id);
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.slides[0]!.versions.map((version) => version.id)).toEqual([second!.id]);
    expect(deleted.body.slides[0]!.currentVersionId).toBe(second!.id);
    expect(await exists(orphanedFile)).toBe(false);

    const reloaded = await json<PresentationProject>(`/api/projects/${projectId}`);
    expect(reloaded.body.slides[0]!.versions).toHaveLength(1);
  });

  it("refuses to delete the version the slide is currently using", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("刪除使用中版本");
    const generated = await generateVersion(projectId, slideId);
    const current = generated.slides[0]!.currentVersionId!;

    const deleted = await deleteVersion(projectId, slideId, current);
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toBe("VERSION_IN_USE");
    const reloaded = await json<PresentationProject>(`/api/projects/${projectId}`);
    expect(reloaded.body.slides[0]!.versions).toHaveLength(1);
  });

  it("refuses to delete an original version an editable text layer points at", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("刪除文字圖層原圖");
    const generated = await generateVersion(projectId, slideId);
    const original = generated.slides[0]!.versions[0]!;
    await repository.updateProject(projectId, (current) => {
      const slide = current.slides[0]!;
      const now = new Date().toISOString();
      const textVersion: SlideVersion = {
        ...structuredClone(original),
        id: "text-layer-version",
        label: "可編輯文字",
        createdAt: now,
        textLayer: {
          originalVersionId: original.id,
          backgroundPath: "assets/generated/background.png",
          compositePath: original.imagePath,
          threshold: 0.75,
          renderRevision: 0,
          boxes: [],
          extractedAt: now,
          updatedAt: now,
        },
      };
      slide.versions.push(textVersion);
      slide.currentVersionId = textVersion.id;
    });

    const deleted = await deleteVersion(projectId, slideId, original.id);
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toBe("VERSION_REFERENCED_BY_TEXT_LAYER");
    const reloaded = await json<PresentationProject>(`/api/projects/${projectId}`);
    expect(reloaded.body.slides[0]!.versions).toHaveLength(2);
  });

  it("refuses to delete a version a running job still points at", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("刪除任務基準版本");
    await generateVersion(projectId, slideId);
    const generated = await generateVersion(projectId, slideId);
    const base = generated.slides[0]!.versions[0]!;
    await repository.updateProject(projectId, (current) => {
      const now = new Date().toISOString();
      current.jobs.push({
        id: "running-edit-job",
        projectId,
        slideId,
        providerId: "mock-image",
        status: "running",
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        operation: "edit",
        editInstruction: "換掉背景",
        baseVersionId: base.id,
      });
    });

    const deleted = await deleteVersion(projectId, slideId, base.id);
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toBe("VERSION_HAS_ACTIVE_JOB");
  });

  it("keeps an image file that a restored twin version still references", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("還原後共用圖檔");
    const generated = await generateVersion(projectId, slideId);
    const original = generated.slides[0]!.versions[0]!;
    // restore 是 structuredClone：還原出來的版本與來源版本指向同一個 imagePath。
    const restored = await json<PresentationProject>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${original.id}/restore`,
      { method: "POST" },
    );
    expect(restored.response.status).toBe(200);
    const twin = restored.body.slides[0]!.versions[1]!;
    expect(twin.imagePath).toBe(original.imagePath);
    expect(restored.body.slides[0]!.currentVersionId).toBe(twin.id);
    const sharedFile = repository.assetPath(projectId, original.imagePath.replace(/^assets\//, ""));

    const deleted = await deleteVersion(projectId, slideId, original.id);
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.slides[0]!.versions.map((version) => version.id)).toEqual([twin.id]);
    expect(await exists(sharedFile)).toBe(true);
  });

  /**
   * 把某一版就地換成「可編輯文字」版本：背景與合成圖都真的落地，讓資產回收有東西可算。
   * `textLayer.compositePath` 與版本的 `imagePath` 相同，這是 text-layer 寫入端的實況
   * （app.ts 的 PUT text-layer 會把兩者一起指到新的合成圖）。
   */
  async function attachTextLayer(
    projectId: string,
    versionId: string,
    originalVersionId: string,
  ): Promise<{ backgroundFile: string; compositeFile: string }> {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const backgroundPath = await repository.saveAsset(
      projectId,
      `text-layers/${originalVersionId}/background-${versionId}.png`,
      bytes,
    );
    const compositePath = await repository.saveAsset(
      projectId,
      `text-layers/${originalVersionId}/composite-0-${versionId}.png`,
      bytes,
    );
    await repository.updateProject(projectId, (current) => {
      const target = current.slides[0]!.versions.find((version) => version.id === versionId)!;
      const now = new Date().toISOString();
      target.imagePath = compositePath;
      target.label = "可編輯文字";
      target.textLayer = {
        originalVersionId,
        backgroundPath,
        compositePath,
        threshold: 0.75,
        renderRevision: 0,
        boxes: [],
        extractedAt: now,
        updatedAt: now,
      };
    });
    return {
      backgroundFile: repository.assetPath(projectId, backgroundPath.replace(/^assets\//, "")),
      compositeFile: repository.assetPath(projectId, compositePath.replace(/^assets\//, "")),
    };
  }

  it("reclaims the background and composite of a deleted text layer version", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("刪除文字圖層版本");
    const generated = await generateVersion(projectId, slideId);
    const original = generated.slides[0]!.versions[0]!;
    const withTwo = await generateVersion(projectId, slideId);
    const layered = withTwo.slides[0]!.versions[1]!;
    // 讓第二版變成指向第一版的可編輯文字版本，再切回第一版好讓它可以被刪。
    const { backgroundFile, compositeFile } = await attachTextLayer(
      projectId,
      layered.id,
      original.id,
    );
    const activated = await json<PresentationProject>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${original.id}/activate`,
      { method: "POST" },
    );
    expect(activated.response.status).toBe(200);
    const originalFile = repository.assetPath(
      projectId,
      original.imagePath.replace(/^assets\//, ""),
    );

    const deleted = await deleteVersion(projectId, slideId, layered.id);
    expect(deleted.response.status).toBe(200);
    // 背景與合成圖只屬於這一版，兩個都要回收；原圖版本的圖不能被牽連。
    expect(await exists(backgroundFile)).toBe(false);
    expect(await exists(compositeFile)).toBe(false);
    expect(await exists(originalFile)).toBe(true);
  });

  it("keeps text layer assets that a restored twin still references", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("還原後共用文字圖層資產");
    const generated = await generateVersion(projectId, slideId);
    const original = generated.slides[0]!.versions[0]!;
    const withTwo = await generateVersion(projectId, slideId);
    const layered = withTwo.slides[0]!.versions[1]!;
    const { backgroundFile, compositeFile } = await attachTextLayer(
      projectId,
      layered.id,
      original.id,
    );
    // restore 連 textLayer 一起 structuredClone：孿生版本共用同一組背景與合成圖。
    const restored = await json<PresentationProject>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${layered.id}/restore`,
      { method: "POST" },
    );
    expect(restored.response.status).toBe(200);
    const twin = restored.body.slides[0]!.versions[2]!;
    expect(twin.textLayer?.backgroundPath).toBe(
      restored.body.slides[0]!.versions[1]!.textLayer?.backgroundPath,
    );

    const deleted = await deleteVersion(projectId, slideId, layered.id);
    expect(deleted.response.status).toBe(200);
    // 孿生版本還指著這兩個檔，刪掉的話它的畫面會直接破圖。
    expect(await exists(backgroundFile)).toBe(true);
    expect(await exists(compositeFile)).toBe(true);
  });

  it("returns 404 for a version that does not exist", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("刪除不存在的版本");
    const deleted = await deleteVersion(projectId, slideId, "missing-version");
    expect(deleted.response.status).toBe(404);
    expect(deleted.body.error).toBe("NOT_FOUND");
  });
});

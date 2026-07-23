import { access, mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { FileProjectRepository } from "../src/repository.js";

/**
 * QA 補測：`DELETE /api/projects/:projectId/slides/:slideId/versions/:versionId`。
 *
 * `version-delete.test.ts` 已覆蓋四個守門各自的 happy path。這裡補的是它沒碰到的邊界：
 * 「一路刪到只剩使用中的那一版」、守門是否**過窄**（queued job、extract-text 的兩個
 * 版本引用）與是否**過寬**（已結束的 job 不該擋）、刪完之後系統整體仍然可用（圖片走
 * 讀取路徑、匯出跑得完、`currentVersionId` 不懸空）、PDF 匯入的雙版本配對，以及併發。
 */

/** 在隨機埠開一個 server；沙箱不給綁埠時回報 `bindUnavailable`，與既有測試同一套處理。 */
async function listen(app: Awaited<ReturnType<typeof createApp>>): Promise<{
  server?: Server;
  baseUrl: string;
  bindUnavailable: boolean;
}> {
  let server: Server | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return { baseUrl: "", bindUnavailable: true };
    throw error;
  }
  if (!server) throw new Error("Local test server did not initialize");
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, bindUnavailable: false };
}

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** `assets/generated/x.png` → 可以直接掛在 URL 後面的那一段。 */
const assetSegment = (imagePath: string): string =>
  imagePath
    .replace(/^assets\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");

// ── 守門邊界、刪除後的系統狀態、併發 ─────────────────────────────────────────
describe("version deletion boundaries and post-delete state", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let repository: FileProjectRepository;
  let bindUnavailable = false;

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-version-delete-qa-")),
      ".slide-maker-data",
    );
    const app = await createApp(root);
    // 進行中的任務在 API 上造不出來（mock provider 一瞬間就跑完），改用同一個資料根目錄的
    // 第二個 repository 直接落地 job fixture；測試循序執行，不會與 app 搶鎖。
    repository = new FileProjectRepository(root);
    await repository.initialize();
    const started = await listen(app);
    bindUnavailable = started.bindUnavailable;
    server = started.server;
    baseUrl = started.baseUrl;
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
      // 匯出會要求每一頁都有使用中的版本，固定成一頁才不用替不相干的頁生圖。
      body: JSON.stringify({ topic, brief: { desiredSlideCount: 1 } }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.slides).toHaveLength(1);
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

  /** 生兩版，回傳「不是使用中的那一版」與整份專案。 */
  async function twoVersions(topic: string): Promise<{
    projectId: string;
    slideId: string;
    spare: PresentationProject["slides"][number]["versions"][number];
    current: string;
  }> {
    const { projectId, slideId } = await createProject(topic);
    await generateVersion(projectId, slideId);
    const project = await generateVersion(projectId, slideId);
    const slide = project.slides[0]!;
    expect(slide.versions).toHaveLength(2);
    expect(slide.currentVersionId).toBe(slide.versions[1]!.id);
    return { projectId, slideId, spare: slide.versions[0]!, current: slide.versions[1]!.id };
  }

  const deleteVersion = (projectId: string, slideId: string, versionId: string) =>
    json<PresentationProject & { error?: string }>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${versionId}`,
      { method: "DELETE" },
    );

  it("deletes every spare version and then refuses to remove the last one", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("刪到只剩一版");
    await generateVersion(projectId, slideId);
    await generateVersion(projectId, slideId);
    const project = await generateVersion(projectId, slideId);
    const [first, second, third] = project.slides[0]!.versions;
    expect(project.slides[0]!.currentVersionId).toBe(third!.id);

    expect((await deleteVersion(projectId, slideId, first!.id)).response.status).toBe(200);
    const second_ = await deleteVersion(projectId, slideId, second!.id);
    expect(second_.response.status).toBe(200);
    expect(second_.body.slides[0]!.versions.map((version) => version.id)).toEqual([third!.id]);

    // 最後一版必然是使用中的那一版，所以刪不掉——這一頁不會被刪成「沒有圖」。
    const last = await deleteVersion(projectId, slideId, third!.id);
    expect(last.response.status).toBe(409);
    expect(last.body.error).toBe("VERSION_IN_USE");

    // currentVersionId 不得懸空：重新載入後仍要指得到一個真的存在的版本。
    const reloaded = await json<PresentationProject>(`/api/projects/${projectId}`);
    const slide = reloaded.body.slides[0]!;
    expect(slide.versions).toHaveLength(1);
    expect(slide.versions.some((version) => version.id === slide.currentVersionId)).toBe(true);
  });

  it("refuses to delete a version a queued job still points at", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare } = await twoVersions("刪除排隊中任務的基準版本");
    await repository.updateProject(projectId, (current) => {
      const now = new Date().toISOString();
      current.jobs.push({
        id: "queued-edit-job",
        projectId,
        slideId,
        providerId: "mock-image",
        // queued 與 running 同樣要擋：任務還沒開始跑，基準版本一樣得留著。
        status: "queued",
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        operation: "edit",
        editInstruction: "換掉背景",
        baseVersionId: spare.id,
      });
    });

    const deleted = await deleteVersion(projectId, slideId, spare.id);
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toBe("VERSION_HAS_ACTIVE_JOB");
  });

  it("refuses to delete the version an active extract-text job reads from", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare } = await twoVersions("刪除抽字任務的來源版本");
    await repository.updateProject(projectId, (current) => {
      const now = new Date().toISOString();
      current.jobs.push({
        id: "extract-source-job",
        projectId,
        slideId,
        providerId: "mock-image",
        status: "running",
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        operation: "extract-text",
        // 抽字任務完成時要回頭讀原圖版本；先刪掉它，任務只會拿到一個對不上的 id。
        textExtraction: { originalVersionId: spare.id, threshold: 0.75, boxes: [] },
      });
    });

    const deleted = await deleteVersion(projectId, slideId, spare.id);
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toBe("VERSION_HAS_ACTIVE_JOB");
  });

  it("refuses to delete the version an active extract-text job will overwrite", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare, current } = await twoVersions("刪除抽字任務的替換目標");
    await repository.updateProject(projectId, (draft) => {
      const now = new Date().toISOString();
      draft.jobs.push({
        id: "extract-replace-job",
        projectId,
        slideId,
        providerId: "mock-image",
        status: "queued",
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        operation: "extract-text",
        // 重新抽字是「就地換掉舊的可編輯文字版本」，替換目標同樣不能中途消失。
        textExtraction: {
          originalVersionId: current,
          replaceVersionId: spare.id,
          threshold: 0.75,
          boxes: [],
        },
      });
    });

    const deleted = await deleteVersion(projectId, slideId, spare.id);
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toBe("VERSION_HAS_ACTIVE_JOB");
  });

  it("allows deletion once the jobs that referenced the version have finished", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare } = await twoVersions("已結束的任務不擋刪除");
    await repository.updateProject(projectId, (current) => {
      const now = new Date().toISOString();
      // 守門不能過寬：completed／failed 的任務不會再回寫任何東西，留著它們的引用
      // 就等於「這個版本永遠刪不掉」。
      for (const status of ["completed", "failed"] as const)
        current.jobs.push({
          id: `${status}-edit-job`,
          projectId,
          slideId,
          providerId: "mock-image",
          status,
          attempt: 0,
          createdAt: now,
          updatedAt: now,
          operation: "edit",
          editInstruction: "換掉背景",
          baseVersionId: spare.id,
          ...(status === "failed" ? { error: "boom" } : {}),
        });
    });

    const deleted = await deleteVersion(projectId, slideId, spare.id);
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.slides[0]!.versions).toHaveLength(1);
  });

  it("still serves a shared image over the asset API after the twin version is deleted", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId } = await createProject("還原後共用圖檔仍讀得到");
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
    const assetUrl = `${baseUrl}/api/projects/${projectId}/assets/${assetSegment(original.imagePath)}`;
    expect((await fetch(assetUrl)).status).toBe(200);

    const deleted = await deleteVersion(projectId, slideId, original.id);
    expect(deleted.response.status).toBe(200);

    // 只確認檔案還在磁碟上是不夠的：畫布拿到的是 API 回應，要走一次真正的讀取路徑。
    const served = await fetch(assetUrl);
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it("keeps the PNG export working after a version is deleted", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare } = await twoVersions("刪除後仍可匯出");
    expect((await deleteVersion(projectId, slideId, spare.id)).response.status).toBe(200);

    const exported = await fetch(`${baseUrl}/api/projects/${projectId}/export/png.zip`);
    expect(exported.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await exported.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(["001.png"]);
    // 真的是 PNG，不是被回收掉的空檔案。
    expect([...entries["001.png"]!.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
  });

  it("serialises two concurrent deletes of the same version", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare } = await twoVersions("併發刪同一版");
    const url = `${baseUrl}/api/projects/${projectId}/slides/${slideId}/versions/${spare.id}`;
    const [left, right] = await Promise.all([
      fetch(url, { method: "DELETE" }),
      fetch(url, { method: "DELETE" }),
    ]);

    // 一個刪掉、一個撲空；兩個都 200 代表刪了兩次，資產回收會多算一輪。
    expect([left.status, right.status].sort()).toEqual([200, 404]);
    // 專案檔仍解析得動：GET 走 parseProject，寫壞了會是 500 而不是 200。
    const reloaded = await json<PresentationProject>(`/api/projects/${projectId}`);
    expect(reloaded.response.status).toBe(200);
    const slide = reloaded.body.slides[0]!;
    expect(slide.versions).toHaveLength(1);
    expect(slide.versions.some((version) => version.id === slide.currentVersionId)).toBe(true);
  });

  it("keeps the project consistent when a delete races an activate", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare } = await twoVersions("併發刪除與切換");
    const versionUrl = `${baseUrl}/api/projects/${projectId}/slides/${slideId}/versions/${spare.id}`;
    const [deleted, activated] = await Promise.all([
      fetch(versionUrl, { method: "DELETE" }),
      fetch(`${versionUrl}/activate`, { method: "POST" }),
    ]);

    // 兩種都合法：activate 先跑 → 刪除撞 VERSION_IN_USE；刪除先跑 → activate 找不到版本。
    expect(["200/404", "409/200"]).toContain(`${deleted.status}/${activated.status}`);
    const reloaded = await json<PresentationProject>(`/api/projects/${projectId}`);
    expect(reloaded.response.status).toBe(200);
    const slide = reloaded.body.slides[0]!;
    // 不論誰先，使用中的版本一定還在陣列裡——這是畫布與匯出唯一依賴的不變式。
    expect(slide.versions.some((version) => version.id === slide.currentVersionId)).toBe(true);
    expect(slide.versions).toHaveLength(deleted.status === 200 ? 1 : 2);
  });

  it("answers 404 for an unknown slide and an unknown project", async (context) => {
    if (bindUnavailable) return context.skip();
    const { projectId, slideId, spare } = await twoVersions("刪除不存在的目標");
    const unknownSlide = await deleteVersion(projectId, "no-such-slide", spare.id);
    expect(unknownSlide.response.status).toBe(404);
    expect(unknownSlide.body.error).toBe("NOT_FOUND");

    const unknownProject = await deleteVersion("no-such-project", slideId, spare.id);
    expect(unknownProject.response.status).toBe(404);
    expect(unknownProject.body.error).toBe("NOT_FOUND");

    // 撲空的請求不能有副作用。
    const reloaded = await json<PresentationProject>(`/api/projects/${projectId}`);
    expect(reloaded.body.slides[0]!.versions).toHaveLength(2);
  });
});

// ── PDF 匯入的雙版本配對 ─────────────────────────────────────────────────────
/** 兩頁帶原生文字的 16:9 PDF，匯入後每頁都會有原圖 A 與可編輯文字 B。 */
async function makeTextDeck(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([960, 540]);
  page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
  page.drawText("Cover Page", { x: 40, y: 430, size: 40, font, color: rgb(0.05, 0.1, 0.4) });
  page.drawText("opening line", { x: 40, y: 300, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  return document.save();
}

describe("deleting one half of a PDF import version pair", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";
  let bindUnavailable = false;
  let textDeck: Uint8Array;

  beforeAll(async () => {
    textDeck = await makeTextDeck();
    dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-version-delete-pdf-")),
      ".slide-maker-data",
    );
    const started = await listen(await createApp(dataRoot));
    bindUnavailable = started.bindUnavailable;
    server = started.server;
    baseUrl = started.baseUrl;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  /** 匯入一頁，回傳專案與那一頁的原圖 A、可編輯文字 B。 */
  async function importOnePage(name: string) {
    const response = await fetch(
      `${baseUrl}/api/pdf-deck/import?name=${encodeURIComponent(name)}&pages=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(textDeck),
      },
    );
    expect(response.status).toBe(201);
    const { project } = (await response.json()) as { project: PresentationProject };
    const slide = project.slides[0]!;
    const [original, editable] = slide.versions;
    // 匯入的形狀（A 是 current、B 的 textLayer 指向 A）由 pdf-import-qa 保證，這裡只是
    // 確認前提成立，免得守門其實是在測一個空的配對。
    expect(slide.versions).toHaveLength(2);
    expect(slide.currentVersionId).toBe(original!.id);
    expect(original!.textLayer).toBeUndefined();
    expect(editable!.textLayer!.originalVersionId).toBe(original!.id);
    return { project, slideId: slide.id, original: original!, editable: editable! };
  }

  const assetFile = (projectId: string, imagePath: string): string =>
    join(dataRoot, "projects", projectId, imagePath);

  const deleteVersion = async (projectId: string, slideId: string, versionId: string) => {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/slides/${slideId}/versions/${versionId}`,
      { method: "DELETE" },
    );
    return { response, body: (await response.json()) as PresentationProject & { error?: string } };
  };

  it("reclaims only the editable version's own assets and leaves the original page image intact", async (context) => {
    if (bindUnavailable) return context.skip();
    const { project, slideId, original, editable } = await importOnePage("刪除可編輯文字版本");
    const backgroundFile = assetFile(project.id, editable.textLayer!.backgroundPath);
    const compositeFile = assetFile(project.id, editable.textLayer!.compositePath);
    const originalFile = assetFile(project.id, original.imagePath);
    // B 的 imagePath 就是它的 composite；A 的原圖是另一個檔案。
    expect(editable.imagePath).toBe(editable.textLayer!.compositePath);
    expect(original.imagePath).not.toBe(editable.imagePath);
    expect(await exists(backgroundFile)).toBe(true);
    expect(await exists(compositeFile)).toBe(true);

    const deleted = await deleteVersion(project.id, slideId, editable.id);
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.slides[0]!.versions.map((version) => version.id)).toEqual([original.id]);
    expect(deleted.body.slides[0]!.currentVersionId).toBe(original.id);

    // 抹字背景與 composite 都是 B 專屬的，回收；A 的原圖一個 byte 都不能動。
    expect(await exists(backgroundFile)).toBe(false);
    expect(await exists(compositeFile)).toBe(false);
    expect(await exists(originalFile)).toBe(true);
    const served = await fetch(
      `${baseUrl}/api/projects/${project.id}/assets/${assetSegment(original.imagePath)}`,
    );
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(100);

    // 停在 A 的匯出仍然跑得完，而且拿到的是原圖那一張。
    const exported = await fetch(`${baseUrl}/api/projects/${project.id}/export/png.zip`);
    expect(exported.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await exported.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(["001.png"]);
    expect([...entries["001.png"]!.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
  }, 60_000);

  it("refuses to delete the original version, whichever of the pair the slide is sitting on", async (context) => {
    if (bindUnavailable) return context.skip();
    const { project, slideId, original, editable } = await importOnePage("刪除原圖版本");

    // 停在 A：使用中的版本先被擋下。
    const whileCurrent = await deleteVersion(project.id, slideId, original.id);
    expect(whileCurrent.response.status).toBe(409);
    expect(whileCurrent.body.error).toBe("VERSION_IN_USE");

    // 切到 B 之後 A 不再是使用中的，但 B 的 textLayer 仍以它為原圖。
    const activated = await fetch(
      `${baseUrl}/api/projects/${project.id}/slides/${slideId}/versions/${editable.id}/activate`,
      { method: "POST" },
    );
    expect(activated.status).toBe(200);
    const whileReferenced = await deleteVersion(project.id, slideId, original.id);
    expect(whileReferenced.response.status).toBe(409);
    expect(whileReferenced.body.error).toBe("VERSION_REFERENCED_BY_TEXT_LAYER");

    // 兩次都被擋，配對必須原封不動。
    const reloaded = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}`)
    ).json()) as PresentationProject;
    expect(reloaded.slides[0]!.versions).toHaveLength(2);
    expect(await exists(assetFile(project.id, original.imagePath))).toBe(true);
    expect(await exists(assetFile(project.id, editable.textLayer!.backgroundPath))).toBe(true);
  }, 60_000);
});

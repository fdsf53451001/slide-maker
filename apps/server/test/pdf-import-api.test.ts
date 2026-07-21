import { mkdtemp, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PresentationProject, StructuredTextProvider } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import { FileProjectRepository } from "../src/repository.js";

/** 兩頁 16:9 + 一頁 4:3 的測試 PDF。 */
async function makeDeck(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const slide = (title: string, body: string) => {
    const page = document.addPage([960, 540]);
    page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
    page.drawText(title, { x: 40, y: 430, size: 40, font, color: rgb(0.05, 0.1, 0.4) });
    page.drawText(body, { x: 40, y: 300, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  };
  slide("Cover Page", "opening line");
  slide("Second Page", "supporting line");
  const odd = document.addPage([800, 600]);
  odd.drawRectangle({ x: 0, y: 0, width: 800, height: 600, color: rgb(0.9, 0.9, 0.9) });
  return document.save();
}

describe("PDF deck import API", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let deck: Uint8Array;
  let dataRoot = "";

  beforeAll(async () => {
    deck = await makeDeck();
    dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-pdf-import-")), ".slide-maker-data");
    const app = await createApp(dataRoot);
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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const importDeck = async (pages: string, name = "My Deck") => {
    const response = await fetch(
      `${baseUrl}/api/pdf-deck/import?name=${encodeURIComponent(name)}&pages=${pages}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(deck),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        project: PresentationProject;
        report: { skippedPages: number[]; failedPages: number[]; importedPages: number[] };
        error?: string;
      },
    };
  };

  it("inspects a deck and lists the pages that do not match the first page ratio", async () => {
    if (bindUnavailable) return;
    const response = await fetch(`${baseUrl}/api/pdf-deck/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array(deck),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totalPages: number;
      acceptedPages: number[];
      skippedPages: number[];
      previews: { pageNumber: number; dataUrl: string }[];
    };
    expect(body.totalPages).toBe(3);
    expect(body.acceptedPages).toEqual([1, 2]);
    expect(body.skippedPages).toEqual([3]);
    expect(body.previews.map((preview) => preview.pageNumber)).toEqual([1, 2]);
    expect(body.previews[0]?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  }, 60_000);

  it("creates a landed project whose slides carry the rendered page and extracted text", async () => {
    if (bindUnavailable) return;
    const { status, body } = await importDeck("1,2,3");
    expect(status).toBe(201);
    const project = body.project;
    expect(project.name).toBe("My Deck");
    expect(project.brief.topic).toBe("My Deck");
    expect(project.brief.desiredSlideCount).toBe(2);
    expect(project.canvas).toEqual({ width: 1920, height: 1080 });
    // 分析頁是專案的一個狀態，不是前端暫存。
    expect(project.workflowStage).toBe("settings");
    // 比例不符的第 3 頁不建 slide。
    expect(body.report.skippedPages).toEqual([3]);
    expect(body.report.importedPages).toEqual([1, 2]);
    expect(project.slides).toHaveLength(2);
    const [first] = project.slides;
    expect(first?.purpose).toBe("Cover Page");
    expect(first?.content).toContain("opening line");
    expect(first?.narrative).toBe("");
    expect(first?.layoutHint).toBe("");
    expect(first?.dataBasis).toEqual([]);
    // 匯入當下就建好兩個版本：原圖（預設顯示）與可編輯文字。
    const version = first?.versions[0];
    expect(first?.versions).toHaveLength(2);
    expect(version?.id).toBe(first?.currentVersionId);
    expect(version?.providerId).toBe("pdf-import");
    expect(version?.model).toBe("pdf-import");
    expect(version?.textLayer).toBeUndefined();
    expect(version?.label).toBe("原始頁面");
    expect(version?.parameters).toMatchObject({ pdfImport: true, pdfPage: 1 });
    // PDF 原檔一併保留，日後要重抽這一頁的文字層還回得去。
    const source = await fetch(
      `${baseUrl}/api/projects/${project.id}/assets/pdf-import/source.pdf`,
    );
    expect(source.status).toBe(200);
    const image = await fetch(
      `${baseUrl}/api/projects/${project.id}/assets/${version!.imagePath.replace("assets/", "")}`,
    );
    expect(image.status).toBe(200);
  }, 60_000);

  it("rejects a selection that contains no importable page", async () => {
    if (bindUnavailable) return;
    const { status, body } = await importDeck("3");
    expect(status).toBe(400);
    expect(body.error).toBe("PDF_PAGE_SELECTION_INVALID");
  }, 60_000);

  it("writes the analysis result into the project style snapshot without touching the library", async () => {
    if (bindUnavailable) return;
    const { body } = await importDeck("1");
    const response = await fetch(`${baseUrl}/api/projects/${body.project.id}/style-snapshot`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ designSystem: "## Palette\n- ink #101010", avoid: ["clutter"] }),
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as PresentationProject;
    expect(updated.styleSnapshot.designSystem).toContain("ink #101010");
    expect(updated.styleSnapshot.avoid).toEqual(["clutter"]);
    expect(updated.styleSnapshot.id).toBe(`pdf-style-${body.project.id}`);
    expect(updated.styleSnapshot.system).toBe(false);
    const styles = (await (await fetch(`${baseUrl}/api/styles`)).json()) as { id: string }[];
    expect(styles.some((style) => style.id.startsWith("pdf-style-"))).toBe(false);
  }, 60_000);

  /**
   * 分析用的頁面圖存在 `styles/assets/` 下，不在專案目錄裡。沒有人持有這些 id 的話
   * 每按一次「重新分析」就多 4 張永久孤兒檔，刪專案也帶不走。
   */
  it("gives the analysis reference images an owner and sweeps the superseded batch", async () => {
    if (bindUnavailable) return;
    const { body } = await importDeck("1", "Reference Owner");
    const project = body.project;
    const slide = project.slides[0]!;
    const makeReference = async () =>
      (
        (await (
          await fetch(
            `${baseUrl}/api/projects/${project.id}/slides/${slide.id}/versions/${slide.currentVersionId}/style-reference`,
            { method: "POST" },
          )
        ).json()) as { id: string }
      ).id;
    const patchSnapshot = async (referenceIds: string[]) =>
      (await (
        await fetch(`${baseUrl}/api/projects/${project.id}/style-snapshot`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ designSystem: "## Palette", referenceIds }),
        })
      ).json()) as PresentationProject;

    const first = await makeReference();
    expect((await patchSnapshot([first])).styleSnapshot.referenceImages.map((i) => i.id)).toEqual([
      first,
    ]);

    const second = await makeReference();
    const replaced = await patchSnapshot([second]);
    expect(replaced.styleSnapshot.referenceImages.map((image) => image.id)).toEqual([second]);
    // 上一批已經沒有任何引用：資產與 metadata 都要清掉，只留現在這一批。
    const assets = await readdir(join(dataRoot, "styles", "assets"));
    expect(assets.some((name) => name.startsWith(first))).toBe(false);
    expect(assets.some((name) => name.startsWith(second))).toBe(true);
    // 風格庫清單仍然乾淨。
    const styles = (await (await fetch(`${baseUrl}/api/styles`)).json()) as { id: string }[];
    expect(styles.some((style) => style.id.startsWith("pdf-style-"))).toBe(false);
  }, 60_000);

  /**
   * 原檔與每頁 PNG 都寫在 `saveProject` 之前。中途失敗而沒有 rollback 的話，
   * `project.json` 不存在 → 專案不在 `listProjects()` 裡，但目錄下已經躺著
   * 一份 PDF 原檔與一堆 PNG，UI 看不到也刪不掉。
   */
  it("leaves no orphan assets behind when the import fails midway", async () => {
    if (bindUnavailable) return;
    const before = await readdir(join(dataRoot, "projects")).catch(() => []);
    const saveProject = vi
      .spyOn(FileProjectRepository.prototype, "saveProject")
      .mockRejectedValueOnce(new Error("disk exploded"));
    try {
      const { status } = await importDeck("1,2", "Doomed Import");
      expect(status).toBe(500);
    } finally {
      saveProject.mockRestore();
    }
    const after = await readdir(join(dataRoot, "projects")).catch(() => []);
    expect(after.sort()).toEqual(before.sort());
  }, 60_000);

  /**
   * 分析失敗是規格明文要求「明確顯示錯誤、可重試」的正常路徑。三支端點由前端串的話，
   * 失敗時剛寫進 `styles/assets` 的頁面圖沒有任何 snapshot 引用：風格庫列表看不到、
   * 也不在專案目錄底下（刪專案帶不走），按幾次重試就堆幾批孤兒檔。
   */
  describe("project style analysis transaction", () => {
    const analysis = {
      designRationale: "深藍底配單一強調色",
      palette: [{ hex: "#0B1F3A", usage: "封面滿版底" }],
      typography: "無襯線，標題 700",
      layoutSystem: "12 欄網格",
      components: "圓角 4px",
      archetypes: [],
      avoid: ["漸層"],
    };
    const stubTextProvider = (
      run: () => Promise<unknown>,
      status: "available" | "unavailable" = "available",
    ) =>
      vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
        id: "stub-text",
        availability:
          status === "available"
            ? { status: "available" }
            : { status: "unavailable", reason: "stubbed off" },
        runStructured: run,
      } as StructuredTextProvider);

    const styleAssets = () => readdir(join(dataRoot, "styles", "assets"));

    const analyse = async (project: PresentationProject) =>
      fetch(`${baseUrl}/api/projects/${project.id}/style-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slideIds: project.slides.map((slide) => slide.id) }),
      });

    it("writes the snapshot and keeps exactly one batch of reference images", async () => {
      if (bindUnavailable) return;
      const { body } = await importDeck("1,2", "Analysis Deck");
      const stub = stubTextProvider(async () => analysis);
      try {
        const before = await styleAssets();
        const first = (await (await analyse(body.project)).json()) as PresentationProject;
        expect(first.styleSnapshot.designSystem).toContain("#0B1F3A");
        expect(first.styleSnapshot.avoid).toEqual(["漸層"]);
        expect(first.styleSnapshot.id).toBe(`pdf-style-${body.project.id}`);
        expect(first.styleSnapshot.referenceImages).toHaveLength(2);
        // 重新分析：上一批沒有引用了，必須被掃掉，資產數量不隨重試累積。
        const second = (await (await analyse(body.project)).json()) as PresentationProject;
        expect(second.styleSnapshot.referenceImages).toHaveLength(2);
        const ids = new Set(second.styleSnapshot.referenceImages.map((image) => image.id));
        for (const image of first.styleSnapshot.referenceImages)
          expect(ids.has(image.id)).toBe(false);
        expect((await styleAssets()).length).toBe(before.length + 4);
      } finally {
        stub.mockRestore();
      }
    }, 60_000);

    it("leaves no orphan reference images when the analysis fails and is retried", async () => {
      if (bindUnavailable) return;
      const { body } = await importDeck("1,2", "Failing Analysis");
      const disabled = stubTextProvider(async () => analysis, "unavailable");
      try {
        const before = await styleAssets();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await analyse(body.project);
          expect(response.status).toBe(400);
          const failure = (await response.json()) as { error: string; message?: string };
          expect(failure.error).toBe("CODEX_STYLE_ANALYSIS_DISABLED");
          // 使用者看得懂的原因，不是裸錯誤碼。
          expect(failure.message).toMatch(/模型/);
        }
        expect(await styleAssets()).toEqual(before);
      } finally {
        disabled.mockRestore();
      }
      // 模型交出空殼（缺色票）同樣是可重試路徑，一樣不能留下孤兒。
      const hollow = stubTextProvider(async () => ({ ...analysis, palette: [] }));
      try {
        const before = await styleAssets();
        const response = await analyse(body.project);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe(
          "CODEX_STYLE_ANALYSIS_INCOMPLETE",
        );
        expect(await styleAssets()).toEqual(before);
      } finally {
        hollow.mockRestore();
      }
    }, 60_000);

    /**
     * 預設文字引擎（codex）逾時：`provider-codex` 只丟得出裸的碼字串，不是
     * `StyleAnalysisError`，所以訊息只能由 `app.ts` 的錯誤碼表補。少了那一條，
     * 分析頁上顯示的就是 `CODEX_STRUCTURED_TIMEOUT` 本人。
     */
    it("explains a codex analysis timeout in words instead of leaking the error code", async () => {
      if (bindUnavailable) return;
      const { body } = await importDeck("1,2", "Timing Out Analysis");
      const timeout = stubTextProvider(async () => {
        throw new Error("CODEX_STRUCTURED_TIMEOUT");
      });
      try {
        const before = await styleAssets();
        const response = await analyse(body.project);
        expect(response.status).toBe(400);
        const failure = (await response.json()) as { error: string; message?: string };
        expect(failure.error).toBe("CODEX_STRUCTURED_TIMEOUT");
        expect(failure.message).toBeDefined();
        expect(failure.message).not.toContain("CODEX_STRUCTURED_TIMEOUT");
        // 逾時是可重試的：訊息要講得出「重試」與「少挑幾頁」這兩條路。
        expect(failure.message).toMatch(/重試/);
        expect(failure.message).toMatch(/少挑幾頁/);
        expect(await styleAssets()).toEqual(before);
      } finally {
        timeout.mockRestore();
      }
    }, 60_000);

    /** 換成風格庫的風格＝整包換掉 snapshot，本地那批分析圖從此沒有主。 */
    it("sweeps the project's own reference images when a library style replaces them", async () => {
      if (bindUnavailable) return;
      const { body } = await importDeck("1", "Library Switch");
      const stub = stubTextProvider(async () => analysis);
      let analysed: PresentationProject;
      try {
        analysed = (await (await analyse(body.project)).json()) as PresentationProject;
      } finally {
        stub.mockRestore();
      }
      expect(analysed.styleSnapshot.referenceImages).toHaveLength(1);
      const applied = await fetch(`${baseUrl}/api/projects/${body.project.id}/style`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleId: "ai-free-design" }),
      });
      expect(applied.status).toBe(200);
      const assets = await styleAssets();
      for (const image of analysed.styleSnapshot.referenceImages)
        expect(assets.some((name) => name.startsWith(image.id))).toBe(false);
    }, 60_000);
  });

  it("moves the project into the editor when the analysis page is left", async () => {
    if (bindUnavailable) return;
    const { body } = await importDeck("1");
    const response = await fetch(`${baseUrl}/api/projects/${body.project.id}/workflow-stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowStage: "editing" }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as PresentationProject).workflowStage).toBe("editing");
  }, 60_000);

  /**
   * 使用者拍板：兩個版本在匯入時就一起建好，靠既有的版本切換 UI 存取，
   * 不再有「按一顆按鈕才即時抽字」的延後路徑。
   */
  it("lands an editable text layer version alongside the original at import time", async () => {
    if (bindUnavailable) return;
    const { body } = await importDeck("1");
    const project = body.project;
    const slide = project.slides[0]!;
    expect(slide.versions).toHaveLength(2);
    const [original, editable] = slide.versions;
    // 預設停在原圖版本：畫布與三種匯出格式都保真。
    expect(slide.currentVersionId).toBe(original!.id);
    expect(original!.textLayer).toBeUndefined();
    expect(editable!.label).toBe("可編輯文字");
    expect(editable!.textLayer?.originalVersionId).toBe(original!.id);
    expect(editable!.textLayer?.boxes.map((box) => box.text)).toEqual([
      "Cover Page",
      "opening line",
    ]);
    for (const box of editable!.textLayer!.boxes) expect(box.color).not.toBe("#ffffff");
    expect(editable!.imagePath).toBe(editable!.textLayer!.compositePath);
    for (const path of [
      editable!.imagePath,
      editable!.textLayer!.backgroundPath,
      original!.imagePath,
    ]) {
      const asset = await fetch(
        `${baseUrl}/api/projects/${project.id}/assets/${path.replace("assets/", "")}`,
      );
      expect(asset.status).toBe(200);
    }
    // 延後路徑已經拆掉：那條 HTTP 端點不該還在。
    const removed = await fetch(
      `${baseUrl}/api/projects/${project.id}/slides/${slide.id}/pdf-text-layer`,
      { method: "POST" },
    );
    expect(removed.status).toBe(404);
  }, 60_000);
});

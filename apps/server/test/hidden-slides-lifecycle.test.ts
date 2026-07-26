import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { FileProjectRepository } from "../src/repository.js";

/**
 * `hidden` 的**生命週期**：封存往返、版本還原／啟用、複製頁面、以及舊專案檔（`project.json`
 * 裡根本沒有這個欄位）。這幾條都不是「隱藏當下對不對」，而是「隱藏能不能活過一次搬遷」——
 * 匯出→匯入還原成全部可見、restore 順手把它清掉，都是使用者看得到卻沒有任何單元測試
 * 會亮紅燈的失效模式。
 */

const SHADE = new Uint8Array(
  new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="#5a5a5a"/></svg>',
  )
    .render()
    .asPng(),
);

describe("hidden 的生命週期", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let root = "";
  let repository: FileProjectRepository;

  beforeAll(async () => {
    root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-hidden-lifecycle-")),
      ".slide-maker-data",
    );
    repository = new FileProjectRepository(root);
    await repository.initialize();
    const app = await createApp(root);
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
  }, 120_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  /** 五頁、每頁一個版本、`hiddenOrders` 指定隱藏頁；直接落地到 app 用的同一個 data root。 */
  async function seed(topic: string, hiddenOrders: number[], enablePageNumber = true) {
    const project = createProject({ topic, brief: { desiredSlideCount: 5 } });
    if (enablePageNumber)
      project.pageNumber = {
        ...project.pageNumber,
        enabled: true,
        skipFirstSlide: false,
        format: "number-total",
      };
    const now = new Date().toISOString();
    for (const slide of project.slides) {
      slide.hidden = hiddenOrders.includes(slide.order);
      const imagePath = await repository.saveAsset(project.id, `${slide.id}/v1.png`, SHADE);
      slide.versions.push({
        id: `${slide.id}-v1`,
        imagePath,
        prompt: "",
        providerId: "test",
        model: "test",
        parameters: {},
        styleVersion: 1,
        sources: [],
        // `outlineSnapshot` 不可省：restore／activate 只有在版本帶著快照時才會走
        // `Object.assign(slide, snapshot, {...})` 那條路，而那正是唯一可能順手蓋掉
        // `hidden` 的地方。沒有快照的版本走的是 `slide.outlineDirty = true` 分支，
        // 用它當 fixture 等於整條路都沒測到（實測：把 `hidden: false` 塞進那個
        // Object.assign，沒有快照的 fixture 一條都不會紅）。
        outlineSnapshot: {
          purpose: slide.purpose,
          content: slide.content,
          narrative: slide.narrative,
          layoutHint: slide.layoutHint,
          imagePrompt: slide.imagePrompt,
          sourceIds: [],
        },
        createdAt: now,
      });
      slide.currentVersionId = `${slide.id}-v1`;
    }
    await repository.saveProject(project);
    return project;
  }

  const bytesOf = async (path: string) =>
    new Uint8Array(await (await fetch(`${baseUrl}${path}`)).arrayBuffer());

  const pptxSlideTexts = (bundle: Uint8Array) => {
    const entries = unzipSync(bundle);
    return Object.keys(entries)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
      .map((name) => /<a:t>([^<]*)<\/a:t>/.exec(Buffer.from(entries[name]!).toString("utf8"))?.[1]);
  };

  it("slide-project 匯出 → 匯入 → 再匯出 pptx：隱藏頁一路都還在（而且還是同一批）", async () => {
    if (bindUnavailable) return;
    const source = await seed("封存往返", [1, 3]);

    const bundle = await bytesOf(`/api/projects/${source.id}/export/slide-project`);
    const importResponse = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: bundle,
    });
    expect(importResponse.status).toBe(201);
    const imported = (await importResponse.json()) as PresentationProject;

    // ① 匯入後的專案本體：五頁都在，隱藏的還是原來那兩頁（不是「全部可見」也不是位移一格）。
    expect(imported.slides).toHaveLength(5);
    expect(imported.slides.map((slide) => slide.hidden)).toEqual([false, true, false, true, false]);
    // 匯入是新專案 id，不是就地改寫來源。
    expect(imported.id).not.toBe(source.id);

    // ② 再匯出一次 pptx：只有三張可見頁，頁碼是可見序。
    expect(pptxSlideTexts(await bytesOf(`/api/projects/${imported.id}/export/pptx`))).toEqual([
      "1 / 3",
      "2 / 3",
      "3 / 3",
    ]);

    // ③ 再匯出一次 png.zip：五個檔都在（隱藏頁不排除），檔名維持 order+1。
    const pngEntries = unzipSync(await bytesOf(`/api/projects/${imported.id}/export/png.zip`));
    expect(Object.keys(pngEntries).sort()).toEqual([
      "001.png",
      "002.png",
      "003.png",
      "004.png",
      "005.png",
    ]);

    // ④ 再匯出一次 pdf：三頁。
    const pdf = await PDFDocument.load(await bytesOf(`/api/projects/${imported.id}/export/pdf`));
    expect(pdf.getPageCount()).toBe(3);
  }, 300_000);

  /**
   * 全部隱藏時的匯出防線在 **HTTP 邊界**上的樣子。`exporters.ts` 的單元測試釘的是丟出
   * `EXPORT_NO_VISIBLE_SLIDES`，這一條釘的是使用者實際看到什麼：匯出連結是裸 `<a href>`，
   * 回應內容會直接顯示在瀏覽器分頁裡，所以 400 之外還必須有一句能讀的繁中說明。
   */
  it("全部隱藏時 pptx／pdf 回 400＋繁中說明，png.zip／slide-project 仍是完整檔", async () => {
    if (bindUnavailable) return;
    const project = await seed("全部隱藏", [0, 1, 2, 3, 4], false);

    for (const format of ["pptx", "pdf"]) {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/${format}`);
      expect(response.status, format).toBe(400);
      const body = (await response.json()) as { error: string; message?: string };
      expect(body.error, format).toBe("EXPORT_NO_VISIBLE_SLIDES");
      // 裸錯誤碼在瀏覽器分頁裡對使用者沒有任何意義。
      expect(body.message, format).toMatch(/所有頁面都已隱藏/);
    }

    // 另外兩種格式收錄全部頁面，全部隱藏對它們不是異常狀態。
    const pngEntries = unzipSync(await bytesOf(`/api/projects/${project.id}/export/png.zip`));
    expect(Object.keys(pngEntries)).toHaveLength(5);
    expect(
      unzipSync(await bytesOf(`/api/projects/${project.id}/export/slide-project`))["project.json"],
    ).toBeDefined();
  }, 300_000);

  it("hidden 是頁面層級的：restore 舊版本不會順手把它清掉", async () => {
    if (bindUnavailable) return;
    const project = await seed("版本還原", [2], false);
    const slide = project.slides[2]!;
    const versionId = slide.currentVersionId!;

    const restored = (await (
      await fetch(
        `${baseUrl}/api/projects/${project.id}/slides/${slide.id}/versions/${versionId}/restore`,
        { method: "POST" },
      )
    ).json()) as PresentationProject;

    // 影像版本換了一份，但「這一頁不上場」與影像版本無關，必須留著。
    expect(restored.slides[2]!.currentVersionId).not.toBe(versionId);
    expect(restored.slides[2]!.hidden).toBe(true);
    expect(restored.slides.map((s) => s.hidden)).toEqual([false, false, true, false, false]);
  }, 120_000);

  it("hidden 是頁面層級的：activate 別的版本也不會清掉它", async () => {
    if (bindUnavailable) return;
    const project = await seed("版本啟用", [0], false);
    const slide = project.slides[0]!;
    const versionId = slide.currentVersionId!;

    const activated = (await (
      await fetch(
        `${baseUrl}/api/projects/${project.id}/slides/${slide.id}/versions/${versionId}/activate`,
        { method: "POST" },
      )
    ).json()) as PresentationProject;

    expect(activated.slides[0]!.hidden).toBe(true);
  }, 120_000);

  it("複製隱藏頁：複本也是隱藏的（隱藏是這一頁的屬性，跟著頁面走）", async () => {
    if (bindUnavailable) return;
    const project = await seed("複製隱藏頁", [1], false);
    const duplicated = (await (
      await fetch(
        `${baseUrl}/api/projects/${project.id}/slides/${project.slides[1]!.id}/duplicate`,
        { method: "POST" },
      )
    ).json()) as PresentationProject;

    expect(duplicated.slides).toHaveLength(6);
    expect(duplicated.slides.map((slide) => slide.hidden)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
    // order 重排過，可見序仍連續。
    expect(duplicated.slides.map((slide) => slide.order)).toEqual([0, 1, 2, 3, 4, 5]);
  }, 120_000);

  it("重排頁面不會弄丟 hidden，可見序跟著新順序走", async () => {
    if (bindUnavailable) return;
    const project = await seed("重排", [0], false);
    const reversed = [...project.slides].reverse().map((slide) => slide.id);
    const reordered = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}/slides/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slideIds: reversed }),
      })
    ).json()) as PresentationProject;

    // 原本的第一頁（隱藏）現在排在最後。
    expect(reordered.slides.map((slide) => slide.hidden)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  }, 120_000);

  it("舊專案檔（project.json 完全沒有 hidden 欄位）載入後每一頁都是可見的", async () => {
    if (bindUnavailable) return;
    const project = await seed("舊專案檔", [], false);
    const path = join(repository.projectRoot(project.id), "project.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      slides: Record<string, unknown>[];
    };
    for (const slide of raw.slides) delete slide.hidden;
    expect(raw.slides.every((slide) => !("hidden" in slide))).toBe(true);
    await writeFile(path, JSON.stringify(raw, null, 2));

    // 透過 API 讀回來：`.default(false)` 讓行為與加入這個欄位之前完全相同。
    const loaded = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}`)
    ).json()) as PresentationProject;
    expect(loaded.slides.map((slide) => slide.hidden)).toEqual([false, false, false, false, false]);

    // 而且匯出這一端也照舊：五頁全進 pptx／pdf。
    expect(pptxSlideTexts(await bytesOf(`/api/projects/${project.id}/export/pptx`))).toHaveLength(
      5,
    );
    const pdf = await PDFDocument.load(await bytesOf(`/api/projects/${project.id}/export/pdf`));
    expect(pdf.getPageCount()).toBe(5);
  }, 300_000);

  it("隱藏再取消隱藏後，這一頁與動手前逐欄位相同（不留 outlineDirty，也沒有其他殘留）", async () => {
    if (bindUnavailable) return;
    const project = await seed("來回切換", [], false);
    const slideId = project.slides[2]!.id;
    const patch = (body: unknown) =>
      fetch(`${baseUrl}/api/projects/${project.id}/slides/${slideId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const before = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}`)
    ).json()) as PresentationProject;
    await patch({ hidden: true });
    const after = (await (await patch({ hidden: false })).json()) as PresentationProject;

    expect(after.slides[2]).toEqual(before.slides[2]);
    expect(after.slides[2]!.outlineDirty).toBe(false);
  }, 120_000);

  it("本來就是 outlineDirty 的頁面，切換 hidden 不會把它清成乾淨", async () => {
    if (bindUnavailable) return;
    const project = await seed("保留 dirty", [], false);
    const slideId = project.slides[3]!.id;
    const patch = (body: unknown) =>
      fetch(`${baseUrl}/api/projects/${project.id}/slides/${slideId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await patch({ purpose: "改過了" });
    expect(
      ((await (await fetch(`${baseUrl}/api/projects/${project.id}`)).json()) as PresentationProject)
        .slides[3]!.outlineDirty,
    ).toBe(true);

    await patch({ hidden: true });
    await patch({ hidden: false });
    expect(
      ((await (await fetch(`${baseUrl}/api/projects/${project.id}`)).json()) as PresentationProject)
        .slides[3]!.outlineDirty,
    ).toBe(true);
  }, 120_000);
});

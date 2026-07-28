import { mkdtemp, readdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { EditableTextBox, GenerationJob, PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { exportPresentation } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";
import type { RawOcrResult } from "../src/ocr.js";

/**
 * 手動文字層的第二層驗證：**匯出產物、跨版本／跨頁旅行、併發、磁碟資產**。
 *
 * `manual-text-layer.test.ts` 釘的是端點本身的狀態與那三條回收路徑；這一份補的是它沒碰的
 * 四件事——
 * 1. 匯出實體：PPTX 的手動字必須是**原生文字框**、背景必須是原圖（不是合成圖，否則同一句話
 *    會以像素與文字物件各出現一次）；PNG／PDF 反過來必須是合成圖；頁碼在任一格式都只有一個。
 * 2. 手動層會被複製、還原、封存再匯入：`origin` 與「backgroundPath 別名指向同頁原圖版本」
 *    這兩件事必須一起旅行，`originalVersionId` 要跟著重映射，否則畫布會指向不存在的版本。
 * 3. 併發：兩個分頁同時建立、以及「建立還在飛時原圖版本被刪掉」。
 * 4. 磁碟：一連串操作之後不得留下孤兒 composite，也不得有指向不存在檔案的引用。
 */

/** OCR stub：固定回一個高信賴度的標題框（與 manual-text-layer.test.ts 同一份）。 */
const fakeOcr = {
  status: async () => ({ available: true, message: "ok" }),
  recognize: async (): Promise<RawOcrResult> => ({
    width: 1920,
    height: 1080,
    boxes: [
      {
        text: "測試標題",
        confidence: 0.92,
        polygon: [
          [120, 120],
          [520, 120],
          [520, 190],
          [120, 190],
        ],
      },
    ],
  }),
};

/**
 * 手動框刻意放在 mock 圖的空白帶（y 820–940）：mock 圖的字在 y≤742 與 y≈980，
 * 「合成圖有字、原圖沒字」的像素比較才不會被背景自己的字污染。
 */
function manualBox(overrides: Partial<EditableTextBox> = {}): EditableTextBox {
  return {
    id: crypto.randomUUID(),
    text: "手動加的字",
    x: 200,
    y: 820,
    width: 600,
    height: 120,
    fontFamily: "Arial",
    fontSize: 44,
    fontWeight: 400,
    color: "#ffffff",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 1,
    role: "presentation",
    ...overrides,
  };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

/** 假的 local-inpaint 引擎（/bin/sh 腳本，輸出一張純色圖），供 extract-text 用。 */
async function fakeInpaintEngine(): Promise<{ restore: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "manual-text-qa-engine-"));
  const png = join(dir, "result.png");
  await writeFile(
    png,
    await sharp({ create: { width: 1920, height: 1080, channels: 4, background: "#101820" } })
      .png()
      .toBuffer(),
  );
  const script = join(dir, "fake-inpaint.sh");
  await writeFile(script, `#!/bin/sh\ncp "${png}" "$3"\n`, "utf8");
  await chmod(script, 0o755);
  const previousPython = process.env.SLIDE_MAKER_INPAINT_PYTHON;
  const previousScript = process.env.SLIDE_MAKER_INPAINT_SCRIPT;
  process.env.SLIDE_MAKER_INPAINT_PYTHON = "/bin/sh";
  process.env.SLIDE_MAKER_INPAINT_SCRIPT = script;
  return {
    restore: async () => {
      if (previousPython === undefined) delete process.env.SLIDE_MAKER_INPAINT_PYTHON;
      else process.env.SLIDE_MAKER_INPAINT_PYTHON = previousPython;
      if (previousScript === undefined) delete process.env.SLIDE_MAKER_INPAINT_SCRIPT;
      else process.env.SLIDE_MAKER_INPAINT_SCRIPT = previousScript;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 遞迴列出 assets 底下的相對路徑（與專案裡記的 `assets/...` 同形）。 */
async function listAssets(root: string, prefix = "assets"): Promise<string[]> {
  const entries = await readdir(join(root, prefix.replace(/^assets/, "assets")), {
    withFileTypes: true,
  }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const next = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listAssets(root, next)));
    else files.push(next);
  }
  return files;
}

/** 專案裡所有被引用的資產路徑（與三條回收路徑算的是同一個集合）。 */
function referencedAssets(project: PresentationProject): Set<string> {
  return new Set(
    project.slides.flatMap((slide) =>
      slide.versions.flatMap((version) => [
        version.imagePath,
        ...(version.textLayer
          ? [version.textLayer.backgroundPath, version.textLayer.compositePath]
          : []),
      ]),
    ),
  );
}

describe("manual text layer: 匯出、旅行、併發、磁碟", () => {
  let server: Server | undefined;
  let cleanupEngine: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (cleanupEngine) await cleanupEngine();
    cleanupEngine = undefined;
  });

  /** 起 server、建專案、生 `versions` 版 mock 圖，回傳操作這個專案需要的一切。 */
  const setup = async (versions = 1) => {
    const engine = await fakeInpaintEngine();
    cleanupEngine = engine.restore;
    const dataRoot = join(await mkdtemp(join(tmpdir(), "manual-text-qa-")), ".slide-maker-data");
    const app = await createApp(dataRoot, join(tmpdir(), "manual-text-qa-no-editor"), {
      ocr: fakeOcr,
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
    });
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const call = async (
      path: string,
      init?: RequestInit,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const { status, body } = await call(path, init);
      if (status >= 400) throw new Error(`${path} -> ${status} ${JSON.stringify(body)}`);
      return body as T;
    };
    let project = await json<PresentationProject>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ topic: "手動文字層 QA", brief: { desiredSlideCount: 1 } }),
    });
    const projectId = project.id;
    await json<PresentationProject>(`/api/projects/${projectId}/outline`, {
      method: "POST",
      body: JSON.stringify({ replace: true }),
    });
    const slideId = (await json<PresentationProject>(`/api/projects/${projectId}`)).slides[0]!.id;
    for (let index = 0; index < versions; index += 1) {
      await json<GenerationJob>(`/api/projects/${projectId}/slides/${slideId}/generate`, {
        method: "POST",
        body: JSON.stringify({ providerId: "mock-image" }),
      });
      const expected = index + 1;
      await waitFor(async () => {
        project = await json<PresentationProject>(`/api/projects/${projectId}`);
        return (
          project.slides[0]!.versions.length === expected &&
          !project.jobs.some((job) => ["queued", "running"].includes(job.status))
        );
      });
    }
    const projectRoot = join(dataRoot, "projects", projectId);
    return {
      projectId,
      slideId,
      dataRoot,
      projectRoot,
      call,
      json,
      reload: async () => json<PresentationProject>(`/api/projects/${projectId}`),
      assetFile: (assetPath: string) => join(projectRoot, assetPath),
      exists: async (assetPath: string) =>
        stat(join(projectRoot, assetPath)).then(
          () => true,
          () => false,
        ),
      versions: project.slides[0]!.versions,
      createManual: async (boxes: EditableTextBox[], versionId: string) =>
        call(
          `/api/projects/${projectId}/slides/${slideId}/versions/${versionId}/manual-text-layer`,
          { method: "POST", body: JSON.stringify({ boxes }) },
        ),
      /** 匯出走真正的 exporter，資料來自磁碟上的專案（與 HTTP 匯出端點同一條路）。 */
      exportAs: async (format: "png.zip" | "pptx" | "pdf" | "slide-project") => {
        const repository = new FileProjectRepository(dataRoot);
        const loaded = await repository.loadProject(projectId);
        return exportPresentation(repository, loaded!, format);
      },
      enablePageNumber: async () =>
        json<PresentationProject>(`/api/projects/${projectId}/page-number`, {
          method: "PATCH",
          body: JSON.stringify({
            enabled: true,
            skipFirstSlide: false,
            format: "number-total",
            color: "#ffffff",
            opacity: 1,
          }),
        }),
    };
  };

  /** 某個區域的平均逐通道差（0–255）。JPEG 雜訊約個位數，多疊一層白字則遠大於此。 */
  async function regionDiff(
    a: Uint8Array | Buffer,
    b: Uint8Array | Buffer,
    region: { left: number; top: number; width: number; height: number },
  ): Promise<number> {
    const raw = async (bytes: Uint8Array | Buffer) =>
      sharp(bytes)
        .resize(1920, 1080, { fit: "fill" })
        .extract(region)
        .removeAlpha()
        .raw()
        .toBuffer();
    const [left, right] = await Promise.all([raw(a), raw(b)]);
    let total = 0;
    for (let index = 0; index < left.length; index += 1)
      total += Math.abs(left[index]! - right[index]!);
    return total / left.length;
  }

  it("PPTX：手動字是原生文字框、背景是原圖（同一句話不會同時以像素和文字出現）", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    const box = manualBox();
    expect((await context.createManual([box], original.id)).status).toBe(201);
    const project = await context.reload();
    const manual = project.slides[0]!.versions.find(
      (version) => version.id === project.slides[0]!.currentVersionId,
    )!;

    const entries = unzipSync(await context.exportAs("pptx"));
    const xml = Buffer.from(entries["ppt/slides/slide1.xml"]!).toString("utf8");
    // 原生文字框，而且只有一個（背景若換成合成圖，字就會同時以像素存在＝視覺上兩份）。
    expect(xml.match(/<a:t>手動加的字<\/a:t>/g)).toHaveLength(1);
    // 幾何：EMU = 英吋 × 914400，13.333in 對應 1920px。left 對齊時 x 不位移。
    const emuX = Math.round(((box.x * 13.333) / 1920) * 914400);
    const emuY = Math.round(((box.y * 7.5) / 1080) * 914400);
    const offset = /<a:off x="(\d+)" y="(\d+)"\/><\/a:xfrm>|<a:off x="(\d+)" y="(\d+)"\/>/g;
    const offsets = [...xml.matchAll(/<a:off x="(-?\d+)" y="(\d+)"\/>/g)].map(([, x, y]) => ({
      x: Number(x),
      y: Number(y),
    }));
    expect(offset).toBeDefined();
    expect(
      offsets.some((point) => Math.abs(point.x - emuX) <= 2 && Math.abs(point.y - emuY) <= 2),
      `文字框落點 ${JSON.stringify(offsets)} 應含 (${emuX}, ${emuY})`,
    ).toBe(true);
    // 字級與顏色跟著框走（22pt = 44px × 7.5in/1080px × 72）。
    expect(xml).toContain('sz="2200"');
    expect(xml).toContain('<a:srgbClr val="FFFFFF"/>');

    // 背景那張圖必須是**原圖**：手動框那塊區域要貼近原圖、遠離合成圖。
    const media = Object.entries(entries).find(
      ([name, bytes]) => name.startsWith("ppt/media/") && bytes.length > 0,
    )![1];
    const originalBytes = await readFile(context.assetFile(original.imagePath));
    const compositeBytes = await readFile(context.assetFile(manual.textLayer!.compositePath));
    const region = { left: box.x, top: box.y, width: box.width, height: box.height };
    const toOriginal = await regionDiff(media, originalBytes, region);
    const toComposite = await regionDiff(media, compositeBytes, region);
    expect(toComposite, "合成圖與 PPTX 背景必須明顯不同（字是文字框畫的）").toBeGreaterThan(2);
    expect(toOriginal, "PPTX 背景應該就是原圖").toBeLessThan(toComposite / 3);
  }, 60_000);

  it("PNG zip 與 PDF 都是合成圖；開啟頁碼後每頁只多一個頁碼", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    const box = manualBox();
    expect((await context.createManual([box], original.id)).status).toBe(201);
    const project = await context.reload();
    const manual = project.slides[0]!.versions.find(
      (version) => version.id === project.slides[0]!.currentVersionId,
    )!;
    const compositeBytes = await readFile(context.assetFile(manual.textLayer!.compositePath));
    const region = { left: box.x, top: box.y, width: box.width, height: box.height };

    // 關閉頁碼時 png.zip 就是那張合成圖本身，一個位元都不多（png.zip 的保真承諾）。
    const zipOff = unzipSync(await context.exportAs("png.zip"));
    expect(Buffer.from(zipOff["001.png"]!).equals(compositeBytes)).toBe(true);

    // PDF 內嵌的是合成圖（含手動字），不是抹過的背景。
    const pdf = await PDFDocument.load(await context.exportAs("pdf"));
    expect(pdf.getPageCount()).toBe(1);
    const images = pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object)
      .filter(
        (object): object is PDFRawStream =>
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
      );
    expect(images).toHaveLength(1);
    expect(await regionDiff(images[0]!.getContents(), compositeBytes, region)).toBeLessThan(6);

    // 開啟頁碼：png.zip 變成「合成圖 + 一個頁碼」——手動字那塊必須逐像素不變，
    // 而右下角要亮起來。頁碼被烘進合成圖的話這條會在「不變」那半失敗。
    await context.enablePageNumber();
    const zipOn = unzipSync(await context.exportAs("png.zip"));
    expect(Buffer.from(zipOn["001.png"]!).equals(compositeBytes)).toBe(false);
    expect(await regionDiff(zipOn["001.png"]!, compositeBytes, region)).toBe(0);
    const corner = { left: 1400, top: 940, width: 500, height: 120 };
    expect(await regionDiff(zipOn["001.png"]!, compositeBytes, corner)).toBeGreaterThan(0);

    // PPTX 的頁碼是獨立文字框，只有一個；手動字也還是只有一個。
    const pptx = unzipSync(await context.exportAs("pptx"));
    const xml = Buffer.from(pptx["ppt/slides/slide1.xml"]!).toString("utf8");
    expect(xml.match(/<a:t>1 \/ 1<\/a:t>/g)).toHaveLength(1);
    expect(xml.match(/<a:t>手動加的字<\/a:t>/g)).toHaveLength(1);
  }, 60_000);

  it("在手動層上編輯圖片：origin 與手動框都留著，原圖與舊 composite 都沒被誤刪", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    const box = manualBox();
    expect((await context.createManual([box], original.id)).status).toBe(201);
    let project = await context.reload();
    const manual = project.slides[0]!.versions.find(
      (version) => version.id === project.slides[0]!.currentVersionId,
    )!;

    const job = await context.json<GenerationJob>(
      `/api/projects/${context.projectId}/slides/${context.slideId}/edit-image`,
      {
        method: "POST",
        body: JSON.stringify({ instruction: "make it greener", providerId: "mock-image" }),
      },
    );
    await waitFor(async () => {
      project = await context.reload();
      return project.jobs.find((item) => item.id === job.id)?.status === "completed";
    });
    const slide = project.slides[0]!;
    const edited = slide.versions.find((version) => version.id === slide.currentVersionId)!;
    expect(edited.id).not.toBe(manual.id);
    // 編輯是在「沒有字的背景」上動刀，手動層的背景就是原圖，所以手打的字必須原樣留著。
    expect(edited.textLayer?.boxes.map((item) => item.id)).toEqual([box.id]);
    // origin 跟著旅行：新背景同樣沒有被抹字，「抽離文字」仍該是合併語意。
    expect(edited.textLayer?.origin).toBe("manual");
    // 背景換成這次生成的新資產，不再是別名。
    expect(edited.textLayer?.backgroundPath).not.toBe(original.imagePath);
    expect(await context.exists(edited.textLayer!.backgroundPath)).toBe(true);
    // 三份資產都還在：原圖（仍被原版本與手動層引用）、手動層的 composite、新的合成圖。
    expect(await context.exists(original.imagePath)).toBe(true);
    expect(await context.exists(manual.textLayer!.compositePath)).toBe(true);
    expect(await context.exists(edited.imagePath)).toBe(true);
  }, 60_000);

  it("複製投影片：手動層跟著走、別名重新指向複製出來的原圖版本，且來源頁刪光也不會刪到它", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    expect((await context.createManual([manualBox()], original.id)).status).toBe(201);
    const duplicated = (await context.call(
      `/api/projects/${context.projectId}/slides/${context.slideId}/duplicate`,
      { method: "POST" },
    )) as { status: number; body: unknown };
    expect(duplicated.status).toBe(201);
    let project = await context.reload();
    expect(project.slides).toHaveLength(2);
    const copy = project.slides[1]!;
    const copyOriginal = copy.versions[0]!;
    const copyManual = copy.versions[1]!;
    // id 全部重新配發，但兩者的配對關係必須留在複製出來的那一頁裡。
    expect(copy.versions.map((version) => version.id)).not.toContain(original.id);
    expect(copyManual.textLayer?.origin).toBe("manual");
    expect(copyManual.textLayer?.originalVersionId).toBe(copyOriginal.id);
    // 別名的意義就是「等於同頁原圖版本的 imagePath」；資產共用，字串因此相同。
    expect(copyManual.textLayer?.backgroundPath).toBe(copyOriginal.imagePath);
    expect(copy.currentVersionId).toBe(copyManual.id);

    // 把來源頁的兩個版本都刪掉：資產仍被複製頁引用，一個檔都不該消失。
    const source = project.slides[0]!;
    const sourceManualId = source.currentVersionId!;
    await context.json(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${original.id}/activate`,
      { method: "POST" },
    );
    expect(
      (
        await context.call(
          `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${sourceManualId}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    project = await context.reload();
    expect(await context.exists(copyManual.textLayer!.compositePath)).toBe(true);
    expect(await context.exists(copyManual.textLayer!.backgroundPath)).toBe(true);
    // 複製頁的文字層仍然渲染得出來（背景檔在、composite 在、指向的版本在）。
    const stillThere = project.slides[1]!.versions.find((version) => version.id === copyManual.id)!;
    expect(stillThere.textLayer?.backgroundPath).toBe(copyManual.textLayer?.backgroundPath);
    expect(
      project.slides[1]!.versions.some(
        (version) => version.id === stillThere.textLayer!.originalVersionId,
      ),
    ).toBe(true);
  }, 60_000);

  it("還原手動層版本：兩個版本共用 composite，其中一個自動儲存或被刪都不會刪掉另一個在用的檔", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    const box = manualBox();
    expect((await context.createManual([box], original.id)).status).toBe(201);
    let project = await context.reload();
    const manual = project.slides[0]!.versions.find(
      (version) => version.id === project.slides[0]!.currentVersionId,
    )!;
    const shared = manual.textLayer!.compositePath;

    await context.json(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${manual.id}/restore`,
      { method: "POST" },
    );
    project = await context.reload();
    const restored = project.slides[0]!.versions.find(
      (version) => version.id === project.slides[0]!.currentVersionId,
    )!;
    expect(restored.id).not.toBe(manual.id);
    expect(restored.textLayer?.origin).toBe("manual");
    expect(restored.textLayer?.compositePath).toBe(shared);
    expect(restored.textLayer?.backgroundPath).toBe(original.imagePath);

    // 在還原出來的那一版上自動儲存：換新 composite，但舊的仍被前一版引用，不得刪除。
    expect(
      (
        await context.call(
          `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${restored.id}/text-layer`,
          { method: "PUT", body: JSON.stringify({ boxes: [{ ...box, text: "改過" }] }) },
        )
      ).status,
    ).toBe(200);
    expect(await context.exists(shared)).toBe(true);
    project = await context.reload();
    const saved = project.slides[0]!.versions.find((version) => version.id === restored.id)!;
    expect(saved.textLayer!.compositePath).not.toBe(shared);
    expect(await context.exists(saved.textLayer!.compositePath)).toBe(true);
    // 刪掉還原版本後，共用的舊 composite 仍屬於前一版，還是不能刪。
    await context.json(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${original.id}/activate`,
      { method: "POST" },
    );
    expect(
      (
        await context.call(
          `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${restored.id}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    expect(await context.exists(shared)).toBe(true);
    expect(await context.exists(original.imagePath)).toBe(true);
  }, 60_000);

  it("slide-project 封存再匯入：origin、別名與配對關係完好，檔案都在", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    expect((await context.createManual([manualBox()], original.id)).status).toBe(201);
    // 走真正的匯出端點（分塊回應）再原樣匯入，與使用者按下「備份完整專案」是同一條路。
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const bundle = await fetch(
      `${baseUrl}/api/projects/${context.projectId}/export/slide-project`,
    ).then((response) => response.arrayBuffer());

    const imported = await (async () => {
      const response = await fetch(`${baseUrl}/api/projects/import`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: bundle,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as PresentationProject;
    })();
    expect(imported.id).not.toBe(context.projectId);
    const slide = imported.slides[0]!;
    const manual = slide.versions.find((version) => version.id === slide.currentVersionId)!;
    expect(manual.textLayer?.origin).toBe("manual");
    // 配對關係必須指向匯入後仍存在的版本，別名也必須仍等於那一版的 imagePath。
    const referenced = slide.versions.find(
      (version) => version.id === manual.textLayer!.originalVersionId,
    );
    expect(referenced).toBeDefined();
    expect(manual.textLayer?.backgroundPath).toBe(referenced!.imagePath);
    // 資產真的跟著封存走：新專案目錄下兩個檔都在。
    const importedRoot = join(context.dataRoot, "projects", imported.id);
    for (const assetPath of [
      manual.textLayer!.backgroundPath,
      manual.textLayer!.compositePath,
      manual.imagePath,
    ])
      expect(
        await stat(join(importedRoot, assetPath)).then(
          () => true,
          () => false,
        ),
        assetPath,
      ).toBe(true);
  }, 60_000);

  /**
   * 兩個分頁同時建立手動層：**兩筆都會成功，而且這是允許的**。
   *
   * 端點鎖內曾經有一條 `if (target.textLayer)` 想擋這個情形，那是死碼——文字層掛在**新開的
   * 版本**上，被指定的那一版永遠不會長出 `textLayer`。使用者定案是允許多個（版本結構本來
   * 就支援，「同一張圖做兩套文字方案」也是合理需求），所以這條測試改成明確斷言兩筆都成功，
   * 並釘住多層並存時的每一個不變量：各自獨立的版本與 composite、都別名同一張原圖、原圖仍被
   * 刪除守門鎖住、磁碟沒有孤兒。兩個分頁的畫面各自只看到自己建的那一版，靠既有的專案輪詢
   * 收斂——那是這個 app 其他併發編輯路徑一樣的取捨。
   */
  it("兩個分頁同時建立手動層：兩個版本各自成立，別名同一張原圖，沒有孤兒", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    const results = await Promise.all([
      context.createManual([manualBox()], original.id),
      context.createManual([manualBox()], original.id),
    ]);
    for (const result of results) expect(result.status).toBe(201);

    const project = await context.reload();
    const slide = project.slides[0]!;
    // 原圖 ＋ 兩個手動層，且 currentVersionId 指到其中一個手動層（誰先寫入不保證）。
    expect(slide.versions).toHaveLength(3);
    const manuals = slide.versions.filter((version) => version.textLayer?.origin === "manual");
    expect(manuals).toHaveLength(2);
    expect(manuals.map((version) => version.id)).toContain(slide.currentVersionId);
    // 兩個版本、兩份 composite 各自獨立；背景則是同一張原圖的別名（不複製檔案）。
    expect(new Set(manuals.map((version) => version.id)).size).toBe(2);
    expect(new Set(manuals.map((version) => version.textLayer!.compositePath)).size).toBe(2);
    for (const version of manuals) {
      expect(version.textLayer!.originalVersionId).toBe(original.id);
      expect(version.textLayer!.backgroundPath).toBe(original.imagePath);
      expect(await context.exists(version.textLayer!.compositePath)).toBe(true);
      expect(await context.exists(version.imagePath)).toBe(true);
    }
    expect(await context.exists(original.imagePath)).toBe(true);
    // 被兩個文字層引用的原圖仍然刪不掉（守門看的是「有沒有人引用」，不是「幾個人」）。
    const denied = await context.call(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${original.id}`,
      { method: "DELETE" },
    );
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("VERSION_REFERENCED_BY_TEXT_LAYER");
    // 刪掉其中一個手動層之後，另一個的檔案與別名都不受影響。
    const [kept, removed] = manuals as [(typeof manuals)[number], (typeof manuals)[number]];
    const victim = slide.currentVersionId === removed.id ? kept : removed;
    const survivor = victim.id === kept.id ? removed : kept;
    expect(
      (
        await context.call(
          `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${victim.id}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    expect(await context.exists(survivor.textLayer!.compositePath)).toBe(true);
    expect(await context.exists(original.imagePath)).toBe(true);
    expect(await context.exists(victim.textLayer!.compositePath)).toBe(false);

    // 每一份還在磁碟上的 composite 都要有版本引用它（沒有孤兒）。
    const after = await context.reload();
    const referenced = referencedAssets(after);
    for (const version of after.slides[0]!.versions) {
      if (!version.textLayer) continue;
      expect(
        after.slides[0]!.versions.some((item) => item.id === version.textLayer!.originalVersionId),
      ).toBe(true);
    }
    for (const assetPath of (await listAssets(context.projectRoot)).filter((path) =>
      path.startsWith("assets/text-layers/"),
    ))
      expect(referenced.has(assetPath), `${assetPath} 是孤兒 composite`).toBe(true);
  }, 60_000);

  it("建立請求還在飛時原圖版本被刪掉：不留孤兒 composite，也不留指不到版本的文字層", async () => {
    // 兩個版本才刪得動原圖版本（使用中的版本刪不掉），並讓手動層建在**非目前**的那一版上。
    const context = await setup(2);
    const original = context.versions[0]!;
    const [created, deleted] = await Promise.all([
      context.createManual([manualBox()], original.id),
      // 讓 renderComposite 先跑起來，刪除才有機會插進「讀專案」與「取鎖寫入」之間。
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve) =>
        setTimeout(
          () =>
            void context
              .call(
                `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${original.id}`,
                { method: "DELETE" },
              )
              .then(resolve),
          10,
        ),
      ),
    ]);
    const project = await context.reload();
    // 兩種順序都可以，但必須互斥：建立成功＝原圖被守門鎖住；刪除成功＝建立必須失敗。
    if (created.status === 201) {
      expect(deleted.status).toBe(409);
      expect(deleted.body.error).toBe("VERSION_REFERENCED_BY_TEXT_LAYER");
      expect(await context.exists(original.imagePath)).toBe(true);
    } else {
      expect(deleted.status).toBe(200);
      expect(created.status).toBeGreaterThanOrEqual(400);
    }
    // 不論誰贏：每個文字層都指得到版本與檔案，且沒有孤兒 composite。
    const referenced = referencedAssets(project);
    for (const slide of project.slides)
      for (const version of slide.versions) {
        if (!version.textLayer) continue;
        expect(
          slide.versions.some((item) => item.id === version.textLayer!.originalVersionId),
        ).toBe(true);
        expect(await context.exists(version.textLayer.backgroundPath)).toBe(true);
        expect(await context.exists(version.textLayer.compositePath)).toBe(true);
      }
    for (const assetPath of (await listAssets(context.projectRoot)).filter((path) =>
      path.startsWith("assets/text-layers/"),
    ))
      expect(referenced.has(assetPath), `${assetPath} 沒有任何版本引用它`).toBe(true);
  }, 60_000);

  it("建立→自動儲存→抽字合併→刪版本 全跑一遍後，磁碟與專案完全對得上", async () => {
    const context = await setup();
    const original = context.versions[0]!;
    const box = manualBox();
    expect((await context.createManual([box], original.id)).status).toBe(201);
    let project = await context.reload();
    const manualId = project.slides[0]!.currentVersionId!;
    // 自動儲存兩次（每次都換一份 composite）。
    for (const text of ["第一次", "第二次"])
      expect(
        (
          await context.call(
            `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${manualId}/text-layer`,
            { method: "PUT", body: JSON.stringify({ boxes: [{ ...box, text }] }) },
          )
        ).status,
      ).toBe(200);
    // 抽離文字：合併＋開新版本。
    const job = await context.json<GenerationJob>(
      `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
      { method: "POST", body: "{}" },
    );
    await waitFor(async () => {
      project = await context.reload();
      return project.jobs.find((item) => item.id === job.id)?.status === "completed";
    });
    // 刪掉手動版本（此時 current 已經是合併出來的那一版）。
    expect(
      (
        await context.call(
          `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${manualId}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    project = await context.reload();

    const referenced = referencedAssets(project);
    const onDisk = await listAssets(context.projectRoot);
    // 每一筆引用都指得到檔案。
    for (const assetPath of referenced)
      expect(onDisk.includes(assetPath), `${assetPath} 被引用但磁碟上不存在`).toBe(true);
    // text-layers/ 底下沒有孤兒（edit-masks/ 是 job 引用的工作用產物，不進這個引用集合，
    // 不在這條的範圍內）。
    for (const assetPath of onDisk.filter((path) => path.startsWith("assets/text-layers/")))
      expect(referenced.has(assetPath), `${assetPath} 是孤兒 composite`).toBe(true);
    // ocr-input/ 曾經也算「不檢查的中間產物」，現在不是了：抽字端點在 handler 收尾時就會
    // 刪掉那張正規化圖，所以跑完整條路之後那個前綴底下必須一個檔案都不剩（沒刪的話，
    // 每按一次抽字就漏一張 1–3 MB 的 PNG，而且永遠沒有人回收）。
    expect(onDisk.filter((path) => path.startsWith("assets/ocr-input/"))).toEqual([]);
    // 原圖仍在（合併出來的層以它為 originalVersionId，抽字也是跑在它上面）。
    expect(await context.exists(original.imagePath)).toBe(true);
  }, 90_000);
});

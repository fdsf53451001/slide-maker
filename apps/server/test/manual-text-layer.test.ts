import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITABLE_TEXT_BOX_LIMIT } from "@slide-maker/core";
import type { EditableTextBox, GenerationJob, PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import type { RawOcrResult } from "../src/ocr.js";

/**
 * 「在沒有跑過文字抽離的圖片上手動新增可編輯文字」這條路的不變量。
 *
 * 最要緊的一條是**別名安全**：手動層的 `backgroundPath` 直接指向原圖版本的 `imagePath`
 * （不複製檔案），所以每一條會刪資產的路徑都必須先重算全專案引用才決定刪什麼。原圖檔
 * 一旦被誤刪，畫布、匯出與「再抽一次文字」全部一起壞掉，而且無從復原。
 */

/**
 * 每一次 `ocr.recognize()` 收到的輸入圖路徑（依序）。
 *
 * 「抽字到底是拿哪一張圖去 OCR」只有這裡看得出來：端點把正規化後的圖存成 `ocr-input/*.png`
 * 再把路徑交給 adapter，回應與專案狀態都不會提到它。
 */
const ocrInputs: string[] = [];

/** OCR stub：固定回一個高信賴度的標題框，讓 extract-text 走得完整條路。 */
const fakeOcr = {
  status: async () => ({ available: true, message: "ok" }),
  recognize: async (imagePath: string): Promise<RawOcrResult> => {
    ocrInputs.push(imagePath);
    return {
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
    };
  },
};

/**
 * 某個矩形區域的平均逐通道差（0–255）。
 *
 * 無損 PNG 之間「同一張圖」是 0；多疊一層 44px 白字則遠大於個位數。兩張都先 resize 到
 * canvas 尺寸，因為抽字途中的中間產物都會被正規化成 1920×1080。
 */
async function regionDiff(
  left: string,
  right: string,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const raw = async (path: string) =>
    sharp(path).resize(1920, 1080, { fit: "fill" }).extract(region).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([raw(left), raw(right)]);
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index]! - b[index]!);
  return total / a.length;
}

/** 遮罩 data URL：只有指定矩形是**不透明**白色，其餘透明（`compositeMaskedEdit` 讀 alpha）。 */
async function maskDataUrl(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<string> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="white"/></svg>`,
  );
  return `data:image/png;base64,${(await sharp(svg).png().toBuffer()).toString("base64")}`;
}

function manualBox(overrides: Partial<EditableTextBox> = {}): EditableTextBox {
  return {
    id: crypto.randomUUID(),
    text: "手動加的字",
    x: 1200,
    y: 800,
    width: 420,
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

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

/** 假的 local-inpaint 引擎（/bin/sh 腳本，把輸入原樣複製到輸出），供 extract-text 用。 */
async function fakeInpaintEngine(): Promise<{ restore: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "slide-maker-manual-text-engine-"));
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

describe("manual text layer", () => {
  let server: Server | undefined;
  let cleanupEngine: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (cleanupEngine) await cleanupEngine();
    cleanupEngine = undefined;
    ocrInputs.length = 0;
    vi.restoreAllMocks();
  });

  /** 起一個 server、建專案、生一版 mock 圖，回傳操作這個專案需要的一切。 */
  const setup = async () => {
    const engine = await fakeInpaintEngine();
    cleanupEngine = engine.restore;
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-manual-text-")),
      ".slide-maker-data",
    );
    const app = await createApp(dataRoot, join(tmpdir(), "slide-maker-no-editor-dist"), {
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
      if (status >= 400) throw new Error(String(body.error ?? status));
      return body as T;
    };
    let project = await json<PresentationProject>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ topic: "手動文字層", brief: { desiredSlideCount: 1 } }),
    });
    await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
      method: "POST",
      body: JSON.stringify({ replace: true }),
    });
    const slideId = (await json<PresentationProject>(`/api/projects/${project.id}`)).slides[0]!.id;
    await json<GenerationJob>(`/api/projects/${project.id}/slides/${slideId}/generate`, {
      method: "POST",
      body: JSON.stringify({ providerId: "mock-image" }),
    });
    await waitFor(async () => {
      project = await json<PresentationProject>(`/api/projects/${project.id}`);
      return project.slides[0]!.versions.length === 1;
    });
    const projectId = project.id;
    const reload = async () => json<PresentationProject>(`/api/projects/${projectId}`);
    // 專案裡記的路徑本來就以 `assets/` 開頭，直接接在專案目錄後面（同 repository.assetPath）。
    const assetFile = (assetPath: string) => join(dataRoot, "projects", projectId, assetPath);
    const exists = async (assetPath: string) =>
      stat(assetFile(assetPath)).then(
        () => true,
        () => false,
      );
    return {
      projectId,
      slideId,
      dataRoot,
      call,
      json,
      reload,
      assetFile,
      exists,
      originalVersion: project.slides[0]!.versions[0]!,
      createManual: async (boxes: EditableTextBox[], versionId: string) =>
        call(
          `/api/projects/${projectId}/slides/${slideId}/versions/${versionId}/manual-text-layer`,
          { method: "POST", body: JSON.stringify({ boxes }) },
        ),
    };
  };

  it("建立新版本、切過去，並把 backgroundPath 別名指向原圖", async () => {
    const context = await setup();
    const box = manualBox();
    const created = await context.createManual([box], context.originalVersion.id);
    expect(created.status).toBe(201);
    const slide = (created.body as unknown as PresentationProject).slides[0]!;
    expect(slide.versions).toHaveLength(2);
    const manual = slide.versions.find((version) => version.id === slide.currentVersionId)!;
    expect(manual.id).not.toBe(context.originalVersion.id);
    expect(manual.label).toBe("文字編輯");
    expect(manual.textLayer?.origin).toBe("manual");
    expect(manual.textLayer?.originalVersionId).toBe(context.originalVersion.id);
    // 別名：不複製檔案，直接指向原圖版本的 imagePath。
    expect(manual.textLayer?.backgroundPath).toBe(context.originalVersion.imagePath);
    expect(manual.textLayer?.boxes.map((item) => item.id)).toEqual([box.id]);
    // 合成圖是真的檔案（前端拿它當畫布縮圖與匯出來源）。
    expect(manual.imagePath).toBe(manual.textLayer?.compositePath);
    expect(await context.exists(manual.imagePath)).toBe(true);
    expect(manual.imagePath).not.toBe(context.originalVersion.imagePath);
    // 「檔案存在」擋不住「renderComposite 收到空的框陣列」——那同樣會產出一張圖，而使用者
    // 會看到一張沒有字的新版本。框的範圍內必須真的有像素與原圖不同。
    const region = { left: box.x, top: box.y, width: box.width, height: box.height };
    const [before, after] = await Promise.all(
      [context.originalVersion.imagePath, manual.imagePath].map((assetPath) =>
        sharp(context.assetFile(assetPath)).extract(region).ensureAlpha().raw().toBuffer(),
      ),
    );
    expect(after!.length).toBe(before!.length);
    expect(before!.equals(after!)).toBe(false);
    // 溯源沿用原版本。
    expect(manual.providerId).toBe(context.originalVersion.providerId);
    expect(manual.model).toBe(context.originalVersion.model);
  }, 30_000);

  it("刪掉手動文字版本之後，原圖檔案還在磁碟上", async () => {
    const context = await setup();
    const created = await context.createManual([manualBox()], context.originalVersion.id);
    expect(created.status).toBe(201);
    let project = await context.reload();
    const manualVersionId = project.slides[0]!.currentVersionId!;
    // 使用中的版本刪不掉：先切回原圖。
    await context.json<PresentationProject>(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${context.originalVersion.id}/activate`,
      { method: "POST" },
    );
    const deleted = await context.call(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${manualVersionId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    project = await context.reload();
    expect(project.slides[0]!.versions.map((version) => version.id)).toEqual([
      context.originalVersion.id,
    ]);
    // 這一條是整個功能最關鍵的不變量：backgroundPath 是別名，刪除路徑重算引用後不得
    // 把原圖當成孤兒刪掉。
    expect(await context.exists(context.originalVersion.imagePath)).toBe(true);
  }, 30_000);

  it("原圖版本被手動層引用時刪不掉", async () => {
    const context = await setup();
    expect((await context.createManual([manualBox()], context.originalVersion.id)).status).toBe(
      201,
    );
    const denied = await context.call(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${context.originalVersion.id}`,
      { method: "DELETE" },
    );
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("VERSION_REFERENCED_BY_TEXT_LAYER");
  }, 30_000);

  it("在手動層上自動儲存會換掉 composite，但不動原圖檔", async () => {
    const context = await setup();
    const box = manualBox();
    expect((await context.createManual([box], context.originalVersion.id)).status).toBe(201);
    let project = await context.reload();
    const manualVersion = project.slides[0]!.versions.find(
      (version) => version.id === project.slides[0]!.currentVersionId,
    )!;
    const staleComposite = manualVersion.textLayer!.compositePath;
    const saved = await context.call(
      `/api/projects/${context.projectId}/slides/${context.slideId}/versions/${manualVersion.id}/text-layer`,
      {
        method: "PUT",
        body: JSON.stringify({ boxes: [{ ...box, text: "改過的字" }] }),
      },
    );
    expect(saved.status).toBe(200);
    project = await context.reload();
    const updated = project.slides[0]!.versions.find((version) => version.id === manualVersion.id)!;
    expect(updated.textLayer!.compositePath).not.toBe(staleComposite);
    expect(updated.textLayer!.renderRevision).toBe(1);
    // 背景仍是別名，且原圖檔案必須留著——重繪那條回收路徑的引用集合含 version.imagePath。
    expect(updated.textLayer!.backgroundPath).toBe(context.originalVersion.imagePath);
    expect(await context.exists(context.originalVersion.imagePath)).toBe(true);
    expect(await context.exists(staleComposite)).toBe(false);
  }, 30_000);

  it("對已有文字層的版本再打一次會回 409 TEXT_LAYER_EXISTS", async () => {
    const context = await setup();
    expect((await context.createManual([manualBox()], context.originalVersion.id)).status).toBe(
      201,
    );
    const project = await context.reload();
    const manualVersionId = project.slides[0]!.currentVersionId!;
    const denied = await context.createManual([manualBox()], manualVersionId);
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("TEXT_LAYER_EXISTS");
  }, 30_000);

  /**
   * 只有 presentation 框會被渲染（`renderComposite` 濾掉 logo／incidental），所以整批都是
   * 那兩種的話，產出的新版本會與原圖**逐像素相同**＝使用者眼中「按了沒反應」，而且還多留一份
   * 一模一樣的 composite 在磁碟上。比照 extract-text 的 OCR_NO_PRESENTATION_TEXT，寧可不做。
   */
  it("整批都是 logo／裝飾文字時回 422，且不留下版本與資產", async () => {
    const context = await setup();
    const before = await context.reload();
    const denied = await context.createManual(
      [manualBox({ role: "logo" }), manualBox({ role: "incidental" })],
      context.originalVersion.id,
    );
    expect(denied.status).toBe(422);
    expect(denied.body.error).toBe("MANUAL_TEXT_NO_PRESENTATION_BOX");
    // 訊息要說得出「為什麼看起來沒反應」與下一步。
    expect(String(denied.body.message)).toContain("一般文字框");
    const after = await context.reload();
    expect(after.slides[0]!.versions).toHaveLength(before.slides[0]!.versions.length);
    expect(after.slides[0]!.currentVersionId).toBe(before.slides[0]!.currentVersionId);
    // 連 composite 都還沒渲染（擋在 renderComposite 之前），不會留下孤兒檔。
    expect(
      await readdir(join(context.dataRoot, "projects", context.projectId, "assets")).then(
        (entries) => entries.includes("text-layers"),
        () => false,
      ),
    ).toBe(false);
    // 混一個一般文字框進去就過（上面那條不是靠「端點整個壞掉」通過的）。
    expect(
      (
        await context.createManual(
          [manualBox({ role: "logo" }), manualBox()],
          context.originalVersion.id,
        )
      ).status,
    ).toBe(201);
  }, 30_000);

  /**
   * 合併後超過框數上限的預檢。
   *
   * 少了它，超標的那一份只會在最後寫檔時撞上 schema 的 `.max()`，而那時 OCR、可選的樣式
   * 精修（一次文字模型呼叫＝真配額）與遮罩都已經跑完，使用者付了錢只換到一份 zod issue
   * dump。所以這條除了「回 409」之外，還要釘住「一個 job 都沒排進去」——那是「還沒開始
   * 花錢」在專案狀態上唯一看得見的證據。
   */
  it("合併後超過框數上限：在排 job 之前回 409，訊息帶實測值，log 不含正文", async () => {
    const context = await setup();
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    // 手動層塞到上限，再加上 OCR stub 的那一個框就剛好超標。
    const canary = "框內正文不可進LOG的canary";
    const boxes = Array.from({ length: EDITABLE_TEXT_BOX_LIMIT }, () =>
      manualBox({ text: canary }),
    );
    expect((await context.createManual(boxes, context.originalVersion.id)).status).toBe(201);

    const denied = await context.call(
      `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
      { method: "POST", body: "{}" },
    );
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("TEXT_LAYER_BOX_LIMIT");
    // 訊息要說得出「哪邊幾個、上限多少」，否則使用者不知道該刪框還是該調門檻。
    const message = String(denied.body.message);
    expect(message).toContain(String(EDITABLE_TEXT_BOX_LIMIT));
    expect(message).toContain(String(EDITABLE_TEXT_BOX_LIMIT + 1));
    expect(message).toContain("門檻");
    // 沒有排進 extract-text job＝抹字引擎與生圖／文字模型都還沒被碰到。
    // （專案裡本來就有 setup 產生第一版圖的那個 generate job，不能拿 jobs 總數當條件。）
    expect(
      (await context.reload()).jobs.filter((job) => job.operation === "extract-text"),
    ).toHaveLength(0);

    const limitLog = warnings.find((line) => line.includes("text_extraction_box_limit_exceeded"));
    expect(limitLog).toBeDefined();
    const logged = JSON.parse(limitLog!) as Record<string, unknown>;
    expect(logged.manualBoxCount).toBe(EDITABLE_TEXT_BOX_LIMIT);
    expect(logged.mergedBoxCount).toBe(EDITABLE_TEXT_BOX_LIMIT + 1);
    expect(logged.limit).toBe(EDITABLE_TEXT_BOX_LIMIT);
    expect(logged.ocrBoxCount).toBe(1);
    // 只記數字：框裡的正文一字都不准出現在任何一行 log 裡。
    expect(warnings.some((line) => line.includes(canary))).toBe(false);
  }, 60_000);

  it("手動層上的 extract-text 是合併＋開新版本，且手動框不進遮罩", async () => {
    const context = await setup();
    const box = manualBox();
    expect((await context.createManual([box], context.originalVersion.id)).status).toBe(201);
    const before = await context.reload();
    const manualVersionId = before.slides[0]!.currentVersionId!;
    const job = await context.json<GenerationJob>(
      `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
      { method: "POST", body: "{}" },
    );
    expect(job.operation).toBe("extract-text");
    // 就地取代會把使用者手打的字整份丟掉，手動層一定要開新版本。
    expect(job.textExtraction?.replaceVersionId).toBeUndefined();
    // OCR 跑在原圖上（手動層的 originalVersionId 指的就是它）。
    expect(job.textExtraction?.originalVersionId).toBe(context.originalVersion.id);
    const ids = job.textExtraction!.boxes.map((item) => item.id);
    expect(ids).toContain(box.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    // 手動框接在 OCR 框後面。
    expect(ids.at(-1)).toBe(box.id);

    // 遮罩只能涵蓋 OCR 框：手動框那塊區域必須整片是黑的（＝不修改）。
    const mask = await sharp(context.assetFile(job.maskPath!))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, channels } = mask.info;
    let whiteInManualBox = 0;
    let whiteTotal = 0;
    for (let index = 0; index < mask.data.length; index += channels) {
      if (mask.data[index]! < 128) continue;
      whiteTotal += 1;
      const pixel = index / channels;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)
        whiteInManualBox += 1;
    }
    expect(whiteInManualBox).toBe(0);
    // OCR 框確實有被塗白，否則上面那條會因為「遮罩整片黑」而假通過。
    expect(whiteTotal).toBeGreaterThan(0);

    await waitFor(async () => {
      const project = await context.reload();
      return project.jobs.find((item) => item.id === job.id)?.status === "completed";
    });
    const after = await context.reload();
    const slide = after.slides[0]!;
    // 手動版本留著，合併結果是第三個版本。
    expect(slide.versions.map((version) => version.id)).toContain(manualVersionId);
    expect(slide.versions).toHaveLength(3);
    const merged = slide.versions.find((version) => version.id === slide.currentVersionId)!;
    expect(merged.id).not.toBe(manualVersionId);
    expect(merged.textLayer?.boxes.map((item) => item.id)).toContain(box.id);
    // 合併出來的層是抽出來的：再抽一次就回到現行的就地取代語意。
    expect(merged.textLayer?.origin).toBeUndefined();
  }, 60_000);

  it("舊專案檔（textLayer 沒有 origin）的 extract-text 仍然就地取代", async () => {
    const context = await setup();
    expect((await context.createManual([manualBox()], context.originalVersion.id)).status).toBe(
      201,
    );
    const before = await context.reload();
    const manualVersionId = before.slides[0]!.currentVersionId!;
    // 把 origin 從磁碟上的專案檔拿掉，模擬加入這個欄位之前存下來的專案。
    const projectFile = join(context.dataRoot, "projects", context.projectId, "project.json");
    const raw = JSON.parse(await readFile(projectFile, "utf8")) as PresentationProject;
    const target = raw.slides[0]!.versions.find((version) => version.id === manualVersionId)!;
    delete (target.textLayer as { origin?: string }).origin;
    await writeFile(projectFile, JSON.stringify(raw, null, 2), "utf8");

    const job = await context.json<GenerationJob>(
      `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
      { method: "POST", body: "{}" },
    );
    expect(job.textExtraction?.replaceVersionId).toBe(manualVersionId);
  }, 30_000);

  /**
   * 抽字的基準圖＝基準版本「可見、且還沒被抹過字」的那張圖（`unerasedImagePath`）。
   *
   * 手動加字之後用「編輯當頁圖片」改過圖，這條鏈上有兩個各自會出錯的地方：
   * ① `app.ts` 若照舊回頭抓 `originalVersionId` 那一版，OCR 與抹字都會跑在**編輯前**的舊圖上，
   *    使用者那次花掉配額的編輯在合併出來的新版本裡默默消失；
   * ② `jobs.ts` 的抹字底圖若照舊用 `baseVersion.imagePath`，那是**含使用者手動文字的合成圖**，
   *    抹完之後手打的字會被烘死在背景裡，再由 renderComposite 疊第二份上去——比 ① 更糟。
   * 兩者都只在「合併結果的像素」上看得出來，所以這一組全部用像素釘。
   */
  describe("抽字基準圖＝未被抹過的可見圖", () => {
    /** 編輯遮罩蓋住 mock 圖右上角那個圓（cx=1580 cy=280 r=190），像素差一定看得出來。 */
    const editRect = { x: 1300, y: 100, width: 500, height: 380 };
    const editRegion = {
      left: editRect.x,
      top: editRect.y,
      width: editRect.width,
      height: editRect.height,
    };

    /** 建立手動層 → 用 local-inpaint 的假引擎做一次遮罩編輯 → 回傳編輯後的那一版。 */
    const setupEditedManualLayer = async () => {
      const context = await setup();
      const box = manualBox();
      const manualRegion = {
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      };
      expect((await context.createManual([box], context.originalVersion.id)).status).toBe(201);
      const beforeEdit = await context.reload();
      const manualVersion = beforeEdit.slides[0]!.versions.find(
        (version) => version.id === beforeEdit.slides[0]!.currentVersionId,
      )!;
      // 前置條件：合成圖在手動框那塊真的看得到字，否則下面「沒被烘進背景」的比較會假通過。
      expect(
        await regionDiff(
          context.assetFile(manualVersion.imagePath),
          context.assetFile(manualVersion.textLayer!.backgroundPath),
          manualRegion,
        ),
      ).toBeGreaterThan(3);

      const editJob = await context.json<GenerationJob>(
        `/api/projects/${context.projectId}/slides/${context.slideId}/edit-image`,
        {
          method: "POST",
          body: JSON.stringify({
            providerId: "local-inpaint",
            instruction: "把右上角換成純色",
            maskDataUrl: await maskDataUrl(editRect),
          }),
        },
      );
      await waitFor(async () => {
        const polled = await context.reload();
        return polled.jobs.find((item) => item.id === editJob.id)?.status === "completed";
      });
      const afterEdit = await context.reload();
      const editedVersion = afterEdit.slides[0]!.versions.find(
        (version) => version.id === afterEdit.slides[0]!.currentVersionId,
      )!;
      // 編輯是在「文字被畫上去之前」的背景上動刀，所以手動框與 origin 都留著。
      expect(editedVersion.textLayer?.origin).toBe("manual");
      expect(editedVersion.textLayer?.boxes.map((item) => item.id)).toEqual([box.id]);
      // 編輯真的改了像素（不然整組測試都在比兩張一樣的圖）。
      expect(
        await regionDiff(
          context.assetFile(editedVersion.textLayer!.backgroundPath),
          context.assetFile(context.originalVersion.imagePath),
          editRegion,
        ),
      ).toBeGreaterThan(10);
      return { context, box, manualRegion, manualVersion, editedVersion };
    };

    it("編輯過的手動層：OCR 與抹字都跑在編輯後的背景上，手動文字沒被烘進去", async () => {
      const { context, box, manualRegion, editedVersion } = await setupEditedManualLayer();
      const editedBackground = context.assetFile(editedVersion.textLayer!.backgroundPath);
      const editedComposite = context.assetFile(editedVersion.imagePath);
      const originalImage = context.assetFile(context.originalVersion.imagePath);

      ocrInputs.length = 0;
      const job = await context.json<GenerationJob>(
        `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
        { method: "POST", body: "{}" },
      );
      // 基準版本改成手動層自己（編輯的產物只存在於它的 backgroundPath）。
      expect(job.textExtraction?.originalVersionId).toBe(editedVersion.id);
      expect(job.baseVersionId).toBe(editedVersion.id);
      expect(job.textExtraction?.replaceVersionId).toBeUndefined();

      // OCR 收到的是編輯後的背景：編輯區域與它一致、與編輯前的原圖明顯不同。
      expect(ocrInputs).toHaveLength(1);
      expect(await regionDiff(ocrInputs[0]!, editedBackground, editRegion)).toBeLessThan(1);
      expect(await regionDiff(ocrInputs[0]!, originalImage, editRegion)).toBeGreaterThan(10);
      // 而且不是合成圖：手動框那塊沒有字（否則 OCR 會把使用者自己打的字再抽一次）。
      expect(await regionDiff(ocrInputs[0]!, editedBackground, manualRegion)).toBeLessThan(1);

      await waitFor(async () => {
        const polled = await context.reload();
        return polled.jobs.find((item) => item.id === job.id)?.status === "completed";
      });
      const merged = await context.reload().then((polled) => {
        const slide = polled.slides[0]!;
        return slide.versions.find((version) => version.id === slide.currentVersionId)!;
      });
      expect(merged.id).not.toBe(editedVersion.id);
      expect(merged.textLayer?.originalVersionId).toBe(editedVersion.id);
      expect(merged.textLayer?.boxes.map((item) => item.id)).toContain(box.id);
      const mergedBackground = context.assetFile(merged.textLayer!.backgroundPath);

      // ★ 核心像素斷言：抹字底圖是編輯後的**背景**，不是含手動文字的合成圖。
      // 手動框在 OCR 遮罩之外，所以那塊在抹字前後必須逐像素不變——
      // 底圖若誤用合成圖，這塊就會帶著那行白字（與合成圖一致、與背景不同）。
      expect(await regionDiff(mergedBackground, editedBackground, manualRegion)).toBeLessThan(1);
      expect(await regionDiff(mergedBackground, editedComposite, manualRegion)).toBeGreaterThan(3);
      // 編輯的產物也跟著進了新背景（沒有退回最初的原圖）。
      expect(await regionDiff(mergedBackground, editedBackground, editRegion)).toBeLessThan(1);
      expect(await regionDiff(mergedBackground, originalImage, editRegion)).toBeGreaterThan(10);
      // 手動文字是被**重新畫上去**的（合成圖有、背景沒有），不是烘進背景的像素。
      expect(
        await regionDiff(context.assetFile(merged.imagePath), mergedBackground, manualRegion),
      ).toBeGreaterThan(3);
    }, 90_000);

    it("合併出來的版本再抽一次：基準圖仍是編輯後那張，不會退回最初的原圖", async () => {
      const { context, editedVersion } = await setupEditedManualLayer();
      const editedBackground = context.assetFile(editedVersion.textLayer!.backgroundPath);
      const first = await context.json<GenerationJob>(
        `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
        { method: "POST", body: "{}" },
      );
      await waitFor(async () => {
        const polled = await context.reload();
        return polled.jobs.find((item) => item.id === first.id)?.status === "completed";
      });
      const mergedId = (await context.reload()).slides[0]!.currentVersionId!;

      ocrInputs.length = 0;
      const second = await context.json<GenerationJob>(
        `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
        { method: "POST", body: "{}" },
      );
      // 合併出來的層是 extracted：它自己的背景已經抹乾淨，所以要回頭找 originalVersionId
      // 那一版——而那一版就是編輯過的手動層，`unerasedImagePath` 於是取它的背景。
      expect(second.textExtraction?.originalVersionId).toBe(editedVersion.id);
      expect(second.baseVersionId).toBe(editedVersion.id);
      // 抽過的層再抽一次維持就地取代語意。
      expect(second.textExtraction?.replaceVersionId).toBe(mergedId);
      expect(ocrInputs).toHaveLength(1);
      expect(await regionDiff(ocrInputs[0]!, editedBackground, editRegion)).toBeLessThan(1);
      expect(
        await regionDiff(
          ocrInputs[0]!,
          context.assetFile(context.originalVersion.imagePath),
          editRegion,
        ),
      ).toBeGreaterThan(10);
    }, 90_000);

    it("沒有編輯過的手動層：版本鏈與資產路徑與這次改動前完全一致", async () => {
      const context = await setup();
      const box = manualBox();
      expect((await context.createManual([box], context.originalVersion.id)).status).toBe(201);
      const manualVersion = await context.reload().then((polled) => {
        const slide = polled.slides[0]!;
        return slide.versions.find((version) => version.id === slide.currentVersionId)!;
      });
      // 前置條件：沒編輯過的手動層背景就是別名（這正是走「回頭找原圖版本」那條的判斷依據）。
      expect(manualVersion.textLayer?.backgroundPath).toBe(context.originalVersion.imagePath);

      ocrInputs.length = 0;
      const job = await context.json<GenerationJob>(
        `/api/projects/${context.projectId}/slides/${context.slideId}/extract-text`,
        { method: "POST", body: "{}" },
      );
      // 基準版本仍是原圖版本，不是手動層自己。
      expect(job.textExtraction?.originalVersionId).toBe(context.originalVersion.id);
      expect(job.baseVersionId).toBe(context.originalVersion.id);
      expect(ocrInputs).toHaveLength(1);
      expect(
        await regionDiff(ocrInputs[0]!, context.assetFile(context.originalVersion.imagePath), {
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
        }),
      ).toBeLessThan(1);

      await waitFor(async () => {
        const polled = await context.reload();
        return polled.jobs.find((item) => item.id === job.id)?.status === "completed";
      });
      const merged = await context.reload().then((polled) => {
        const slide = polled.slides[0]!;
        return slide.versions.find((version) => version.id === slide.currentVersionId)!;
      });
      // 版本鏈：合併出來的層仍以原圖版本為 originalVersionId，資產也還放在它的目錄下。
      expect(merged.textLayer?.originalVersionId).toBe(context.originalVersion.id);
      expect(merged.textLayer?.compositePath).toContain(
        `text-layers/${context.originalVersion.id}/`,
      );
      expect(await context.exists(context.originalVersion.imagePath)).toBe(true);
    }, 90_000);
  });
});

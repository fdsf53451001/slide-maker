import { readFile, readdir, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import {
  DECK_ASPECT_MAX,
  DECK_ASPECT_MIN,
  MAX_DECK_PAGES,
  MAX_DECK_PDF_BYTES,
  inspectPdfDeck,
} from "../src/pdf-deck.js";

/**
 * QA 補測：受理條件的邊界值、零模型路徑的靜態保證、匯入後的落地資料形狀、
 * 停在原圖版本時的匯出保真，以及掃描頁在 API 層的行為。
 */

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 指定尺寸的空白頁 PDF。 */
async function deckWithSizes(sizes: readonly [number, number][]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (const [width, height] of sizes) {
    const page = document.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  }
  return document.save();
}

// ── 受理條件：比例邊界 ───────────────────────────────────────────────────────
describe("deck aspect acceptance boundaries", () => {
  const cases: { label: string; size: [number, number]; accepted: boolean }[] = [
    { label: "exactly the 1.70 lower bound", size: [1700, 1000], accepted: true },
    { label: "exactly the 1.82 upper bound", size: [1820, 1000], accepted: true },
    { label: "1.69, just under the lower bound", size: [1690, 1000], accepted: false },
    { label: "1.83, just over the upper bound", size: [1830, 1000], accepted: false },
  ];

  for (const { label, size, accepted } of cases) {
    it(`${accepted ? "accepts" : "rejects"} a first page at ${label}`, async () => {
      const deck = await deckWithSizes([size]);
      if (!accepted) {
        await expect(inspectPdfDeck(deck)).rejects.toThrow("PDF_ASPECT_UNSUPPORTED");
        return;
      }
      const inspection = await inspectPdfDeck(deck);
      expect(inspection.acceptedPages).toEqual([1]);
      expect(inspection.pages[0]!.aspect).toBeGreaterThanOrEqual(DECK_ASPECT_MIN);
      expect(inspection.pages[0]!.aspect).toBeLessThanOrEqual(DECK_ASPECT_MAX);
    });
  }

  it("measures the boundaries the constants declare, not a rounded approximation", () => {
    expect(DECK_ASPECT_MIN).toBe(1.7);
    expect(DECK_ASPECT_MAX).toBe(1.82);
  });

  /**
   * 規格：混比例以第一頁為準。實作在「第一頁 ±2%」之外還要求落在 1.70–1.82，
   * 所以第一頁 1.70、後頁 1.82 這種「兩頁都在區間內但彼此差很多」的組合會被略過。
   */
  it("skips a page that is inside 1.70–1.82 but far from the first page ratio", async () => {
    const inspection = await inspectPdfDeck(
      await deckWithSizes([
        [1700, 1000],
        [1820, 1000],
        [1710, 1000],
      ]),
    );
    expect(inspection.acceptedPages).toEqual([1, 3]);
    expect(inspection.skippedPages).toEqual([2]);
  });
});

// ── 受理條件：頁數與檔案大小上限 ───────────────────────────────────────────
describe("deck page and size limits", () => {
  it("takes a deck of exactly MAX_DECK_PAGES without flagging truncation", async () => {
    const inspection = await inspectPdfDeck(
      await deckWithSizes(Array.from({ length: MAX_DECK_PAGES }, () => [960, 540])),
    );
    expect(inspection.totalPages).toBe(MAX_DECK_PAGES);
    expect(inspection.pages).toHaveLength(MAX_DECK_PAGES);
    expect(inspection.acceptedPages).toHaveLength(MAX_DECK_PAGES);
    expect(inspection.truncated).toBe(false);
  }, 60_000);

  it("truncates a deck of MAX_DECK_PAGES + 1 to the cap and flags it", async () => {
    const inspection = await inspectPdfDeck(
      await deckWithSizes(Array.from({ length: MAX_DECK_PAGES + 1 }, () => [960, 540])),
    );
    expect(inspection.totalPages).toBe(MAX_DECK_PAGES + 1);
    expect(inspection.pages).toHaveLength(MAX_DECK_PAGES);
    expect(inspection.acceptedPages.at(-1)).toBe(MAX_DECK_PAGES);
    expect(inspection.truncated).toBe(true);
  }, 60_000);

  it("rejects a payload one byte over the 100MB file cap before parsing it", async () => {
    const oversize = new Uint8Array(MAX_DECK_PDF_BYTES + 1);
    oversize.set(new TextEncoder().encode("%PDF-"), 0);
    await expect(inspectPdfDeck(oversize)).rejects.toThrow("PDF_SIZE_INVALID");
    expect(MAX_DECK_PDF_BYTES).toBe(100 * 1024 * 1024);
  }, 60_000);
});

// ── 零模型路徑 ─────────────────────────────────────────────────────────────
/** 從一個入口檔出發，收集靜態 import 圖裡的本地檔案與外部套件名。 */
async function importGraph(entries: readonly string[]): Promise<{
  localFiles: Set<string>;
  packages: Set<string>;
}> {
  const localFiles = new Set<string>();
  const packages = new Set<string>();
  const queue = entries.map((entry) => resolve(SERVER_SRC, entry));
  while (queue.length) {
    const file = queue.pop()!;
    if (localFiles.has(file)) continue;
    localFiles.add(file);
    const source = await readFile(file, "utf8");
    // `from "x"`、`import "x"`（純副作用）、`import("x")`、`require("x")` 都要算進來。
    const pattern = /\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"|\b(?:import|require_?)\("([^"]+)"\)/g;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      if (!specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return { localFiles, packages };
}

describe("zero-model guarantee", () => {
  it("never reaches a provider, the job runner, OCR or style analysis from the import pipeline", async () => {
    const { localFiles, packages } = await importGraph(["pdf-deck.ts", "pdf-text-layer.ts"]);
    const forbiddenPackages = [...packages].filter((name) =>
      /provider-(codex|openai|mock)|openai|anthropic/.test(name),
    );
    expect(forbiddenPackages).toEqual([]);
    const forbiddenFiles = [...localFiles]
      .map((file) => file.slice(SERVER_SRC.length + 1))
      .filter((file) =>
        /^(jobs|ocr|ocr-refine|model-runtime|style-analysis|providers)\b/.test(file),
      )
      .sort();
    expect(forbiddenFiles).toEqual([]);
  });

  it("imports nothing beyond node builtins, pdfjs, sharp and core types", async () => {
    const { packages } = await importGraph(["pdf-deck.ts", "pdf-text-layer.ts"]);
    const external = [...packages].filter((name) => !name.startsWith("node:")).sort();
    expect(external).toEqual([
      "@slide-maker/core",
      "pdfjs-dist",
      "pdfjs-dist/legacy/build/pdf.mjs",
      "sharp",
      // render worker 的啟動腳本：只有從 TypeScript 原始碼跑（dev／測試）時才會
      // 載入這個 TS loader，dist 建置走的是 `.js` 進入點，碰都不會碰到。
      "tsx/esm/api",
    ]);
  });

  it("pulls the render worker and the text layer into the same guarantee", async () => {
    const { localFiles } = await importGraph(["pdf-deck.ts"]);
    const files = [...localFiles].map((file) => file.slice(SERVER_SRC.length + 1));
    // worker 進入點與實作都要在被檢查的圖裡，否則上面兩條保證會從 worker 那側被繞過。
    expect(files).toContain("pdf-deck-worker.ts");
    expect(files).toContain("pdf-deck-render.ts");
    // 文字層現在跟著匯入一起跑在 worker 裡，同一份保證要蓋到它。
    expect(files).toContain("pdf-text-layer.ts");
  });
});

// ── API 層：落地資料、匯出保真、掃描頁 ─────────────────────────────────────
async function makeTextDeck(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [title, body] of [
    ["Cover Page", "opening line"],
    ["Second Page", "supporting line"],
  ]) {
    const page = document.addPage([960, 540]);
    page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
    page.drawText(title!, { x: 40, y: 430, size: 40, font, color: rgb(0.05, 0.1, 0.4) });
    page.drawText(body!, { x: 40, y: 300, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return document.save();
}

/** 掃描頁：整份 PDF 都沒有原生文字。 */
async function makeScannedDeck(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([960, 540]);
  page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(0.94, 0.94, 0.94) });
  page.drawRectangle({ x: 80, y: 120, width: 400, height: 260, color: rgb(0.2, 0.4, 0.8) });
  return document.save();
}

/** 遞迴列出一個目錄下的所有檔案（相對路徑，`/` 分隔）。 */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(join(root, entry.name), path)));
    else files.push(path);
  }
  return files.sort();
}

describe("PDF import landing, export fidelity and scanned pages", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let dataRoot = "";
  let textDeck: Uint8Array;
  let scannedDeck: Uint8Array;

  beforeAll(async () => {
    [textDeck, scannedDeck] = await Promise.all([makeTextDeck(), makeScannedDeck()]);
    dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-pdf-qa-")), ".slide-maker-data");
    const app = await createApp(dataRoot);
    try {
      await new Promise<void>((resolve_, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) =>
          error ? reject(error) : resolve_(),
        );
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        bindUnavailable = true;
        return;
      }
      throw error;
    }
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve_, reject) =>
      server!.close((error) => (error ? reject(error) : resolve_())),
    );
  });

  const importDeck = async (deck: Uint8Array, pages: string, name: string) => {
    const response = await fetch(
      `${baseUrl}/api/pdf-deck/import?name=${encodeURIComponent(name)}&pages=${pages}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(deck),
      },
    );
    const body = (await response.json()) as { project: PresentationProject; error?: string };
    return { status: response.status, ...body };
  };

  it("lands the source PDF plus an original and an editable version for every page", async () => {
    if (bindUnavailable) return;
    const { status, project } = await importDeck(textDeck, "1,2", "Landing Shape");
    expect(status).toBe(201);
    const files = await listFiles(join(dataRoot, "projects", project!.id, "assets"));
    // PDF 原檔留著：文字層雖然已經預先產生，日後重抽仍要回到原始頁面。
    expect(files).toContain("pdf-import/source.pdf");
    // 每頁三張 PNG：原圖、抹字背景、composite。
    expect(files.filter((file) => file.includes("background"))).toHaveLength(2);
    expect(files.filter((file) => file.includes("composite"))).toHaveLength(2);
    expect(files.filter((file) => file.endsWith(".png"))).toHaveLength(6);
    for (const slide of project!.slides) {
      expect(slide.versions).toHaveLength(2);
      const [original, editable] = slide.versions;
      // currentVersionId 指向沒有 textLayer 的原圖版本。
      expect(slide.currentVersionId).toBe(original!.id);
      expect(original!.textLayer).toBeUndefined();
      expect(editable!.textLayer?.originalVersionId).toBe(original!.id);
      expect(editable!.textLayer!.boxes.length).toBeGreaterThan(0);
      expect(files).toContain(editable!.textLayer!.backgroundPath.replace("assets/", ""));
      expect(files).toContain(editable!.textLayer!.compositePath.replace("assets/", ""));
    }
  }, 60_000);

  it("exports the untouched original bytes as PNG while sitting on the original version", async () => {
    if (bindUnavailable) return;
    const { project } = await importDeck(textDeck, "1,2", "Export Fidelity");
    const stored = await Promise.all(
      project!.slides.map((slide) =>
        readFile(
          join(
            dataRoot,
            "projects",
            project!.id,
            "assets",
            slide.versions[0]!.imagePath.replace(/^assets\//, ""),
          ),
        ),
      ),
    );
    const response = await fetch(`${baseUrl}/api/projects/${project!.id}/export/png.zip`);
    expect(response.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual(["001.png", "002.png"]);
    // 停在原圖版本的 PNG 匯出必須是原圖，一個位元都不能變。
    expect(Buffer.from(zip["001.png"]!).equals(stored[0]!)).toBe(true);
    expect(Buffer.from(zip["002.png"]!).equals(stored[1]!)).toBe(true);
  }, 60_000);

  it("exports a PDF and a PPTX with no editable text frames while sitting on the original version", async () => {
    if (bindUnavailable) return;
    const { project } = await importDeck(textDeck, "1,2", "Export Formats");
    const pdfResponse = await fetch(`${baseUrl}/api/projects/${project!.id}/export/pdf`);
    expect(pdfResponse.status).toBe(200);
    const exported = await PDFDocument.load(new Uint8Array(await pdfResponse.arrayBuffer()));
    expect(exported.getPageCount()).toBe(2);

    const pptxResponse = await fetch(`${baseUrl}/api/projects/${project!.id}/export/pptx`);
    expect(pptxResponse.status).toBe(200);
    const pptx = unzipSync(new Uint8Array(await pptxResponse.arrayBuffer()));
    const slideXml = Object.keys(pptx)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort();
    expect(slideXml).toHaveLength(2);
    for (const name of slideXml) {
      const xml = new TextDecoder().decode(pptx[name]!);
      // 原圖版本沒有 textLayer：整頁只有一張圖，不得出現任何文字執行段。
      expect(xml).toContain("<p:pic>");
      expect(xml).not.toContain("Cover Page");
      expect(xml).not.toContain("<a:t>");
    }
  }, 60_000);

  /**
   * 規格「顯示與匯出」的另一半：切到 version B 後，PPTX 必須是**可編輯的 PowerPoint
   * 文字框**，不是一張死圖。整個 PDF 匯入功能最有價值的副產品就是這條（PDF → 可編輯
   * PPTX），而 `exporters.ts` 那段座標換算原本只被 OCR 文字層的測試覆蓋過。
   *
   * 同一份匯出裡混合 A/B 兩種版本，順便當對照組：停在 A 的頁一個 `<a:t>` 都不能有。
   */
  it("exports version B as real PowerPoint text frames while version A stays a flat picture", async () => {
    if (bindUnavailable) return;
    const { project } = await importDeck(textDeck, "1,2", "Editable Text Export");
    const [first, second] = project!.slides;
    const editable = first!.versions.find((version) => version.textLayer);
    expect(editable).toBeDefined();
    const activated = await fetch(
      `${baseUrl}/api/projects/${project!.id}/slides/${first!.id}/versions/${editable!.id}/activate`,
      { method: "POST" },
    );
    expect(activated.status).toBe(200);
    // 第二頁刻意不切，維持在原圖版本當對照組。
    expect(
      ((await activated.json()) as PresentationProject).slides.find(
        (slide) => slide.id === second!.id,
      )!.currentVersionId,
    ).toBe(second!.versions[0]!.id);

    const pptx = unzipSync(
      new Uint8Array(
        await (await fetch(`${baseUrl}/api/projects/${project!.id}/export/pptx`)).arrayBuffer(),
      ),
    );
    const xmlFor = (index: number) =>
      new TextDecoder().decode(pptx[`ppt/slides/slide${index}.xml`]!);

    // ── 對照組：停在 version A 的第二頁只有圖 ──
    expect(xmlFor(2)).toContain("<p:pic>");
    expect(xmlFor(2)).not.toContain("<a:t>");

    // ── version B：抹字背景圖 + 每個文字框一個可編輯 shape ──
    const xml = xmlFor(1);
    const boxes = editable!.textLayer!.boxes.filter((box) => box.role === "presentation");
    expect(boxes.length).toBeGreaterThan(0);
    // 背景仍是圖片（textLayer.backgroundPath），文字則是獨立的 shape。
    expect(xml).toContain("<p:pic>");
    const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];
    expect(shapes).toHaveLength(boxes.length);
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => match[1]!);
    expect(runs).toHaveLength(boxes.length);
    // 抽出的原生文字原封不動進了文字框，不是被燒進背景圖。
    expect(runs).toContain("Cover Page");
    for (const box of boxes) expect(runs).toContain(box.text);

    // ── 幾何：canvas px → 英吋 → EMU 的換算對得回原框 ──
    const EMU_PER_INCH = 914_400;
    const titleIndex = boxes.findIndex((box) => box.text === "Cover Page");
    const title = boxes[titleIndex]!;
    const shape = shapes[titleIndex]!;
    const offset = shape.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const extent = shape.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    expect(offset).not.toBeNull();
    expect(extent).not.toBeNull();
    const toPxX = (emu: string) => (Number(emu) / EMU_PER_INCH) * (project!.canvas.width / 13.333);
    const toPxY = (emu: string) => (Number(emu) / EMU_PER_INCH) * (project!.canvas.height / 7.5);
    expect(toPxX(offset![1]!)).toBeCloseTo(title.x, 0);
    expect(toPxY(offset![2]!)).toBeCloseTo(title.y, 0);
    // 框寬多留 1em 餘裕（見 exporters.ts 的註解），且關閉換行，文字才不會跑版。
    expect(toPxX(extent![1]!)).toBeCloseTo(title.width + title.fontSize, 0);
    expect(shape).toContain('wrap="none"');
    // 餘裕不能把框推出畫布：左對齊的框加上 1em 後仍要留在版面內。
    for (const box of boxes)
      expect(box.x + box.width + box.fontSize).toBeLessThanOrEqual(project!.canvas.width);

    // ── 字級、顏色、行距 ──
    const fontSizePt = title.fontSize * (7.5 / project!.canvas.height) * 72;
    expect(Number(shape.match(/sz="(\d+)"/)![1]!) / 100).toBeCloseTo(fontSizePt, 1);
    expect(shape.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/)![1]!.toLowerCase()).toBe(
      title.color.slice(1).toLowerCase(),
    );
    // 行距鎖成編輯器的 CSS line-height，不用字型自身行距。
    expect(Number(shape.match(/<a:spcPts val="(\d+)"\/>/)![1]!) / 100).toBeCloseTo(
      fontSizePt * title.lineHeight,
      1,
    );
    // 白色是 schema 預設值：真的落到它，白底簡報上文字會直接消失。
    for (const box of boxes) expect(box.color.toLowerCase()).not.toBe("#ffffff");
  }, 60_000);

  /** 掃描頁沒有原生文字：只有原圖版本，不報錯、不提示、不 fallback 到 OCR。 */
  it("gives a scanned page the original version only, without failing the import", async () => {
    if (bindUnavailable) return;
    const { status, project } = await importDeck(scannedDeck, "1", "Scanned Deck");
    expect(status).toBe(201);
    const reloaded = (await (
      await fetch(`${baseUrl}/api/projects/${project!.id}`)
    ).json()) as PresentationProject;
    const slide = reloaded.slides[0]!;
    expect(slide.versions).toHaveLength(1);
    expect(slide.versions[0]!.textLayer).toBeUndefined();
    expect(slide.currentVersionId).toBe(slide.versions[0]!.id);
    const files = await listFiles(join(dataRoot, "projects", project!.id, "assets"));
    expect(files.filter((file) => file.startsWith("text-layers/"))).toEqual([]);
  }, 60_000);

  it("keeps the imported deck free of a job queue entry — the whole path is model-free", async () => {
    if (bindUnavailable) return;
    const { project } = await importDeck(textDeck, "1", "No Jobs");
    // 匯入（含文字層）是同步完成的：專案目錄不會有 job 紀錄。
    const files = await listFiles(join(dataRoot, "projects", project!.id));
    expect(files.filter((file) => /job/i.test(file))).toEqual([]);
  }, 60_000);
});

// ── 標題抽取：跨頁重複的頁首 ───────────────────────────────────────────────
/**
 * BUG-2（已修）：`repeatedBlockKeys` 原本要求同一段文字出現在 **3 頁以上** 才算樣板。
 * 只匯入 2 頁時跨頁比對失效，字級比真標題大的頁首橫幅就會被當成 `purpose`，
 * 兩頁的標題變成同一串樣板文字。規格寫的是「跨多頁重複出現的相同文字」要排除，
 * 而使用者只要在選頁網格上勾成 2 頁就會踩到。
 */
describe("repeated header on a two-page import", () => {
  it("BUG-2 drops a header repeated across a two-page selection from the title", async () => {
    const { renderDeckPages } = await import("../src/pdf-deck.js");
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const heading of ["First", "Second"]) {
      const page = document.addPage([960, 540]);
      page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
      // 頁首橫幅字級（30）比真正的標題（28）大。
      page.drawText("ACME CONFIDENTIAL", {
        x: 30,
        y: 500,
        size: 30,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
      page.drawText(heading, { x: 40, y: 400, size: 28, font, color: rgb(0, 0, 0) });
      page.drawText("body copy here", { x: 40, y: 300, size: 14, font, color: rgb(0, 0, 0) });
    }
    const result = await renderDeckPages(await document.save(), [1, 2]);
    expect(result.pages.map((page) => page.title)).toEqual(["First", "Second"]);
  }, 60_000);
});

// ── 文字顏色：絕不落到 schema 預設 #ffffff ─────────────────────────────────
describe("text colour never falls back to the schema default", () => {
  /** 白底、兩種深色文字：operator list 有多色而回 undefined，必須靠像素反推。 */
  async function makeAmbiguousColourSlide(): Promise<Uint8Array> {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([960, 540]);
    page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(1, 1, 1) });
    page.drawText("Crimson Heading", { x: 40, y: 430, size: 44, font, color: rgb(0.8, 0.05, 0.1) });
    page.drawText("charcoal body text", {
      x: 40,
      y: 300,
      size: 26,
      font,
      color: rgb(0.15, 0.15, 0.15),
    });
    return document.save();
  }

  it("recovers a dark colour for every line on a white page", async () => {
    const { renderDeckPages } = await import("../src/pdf-deck.js");
    const pdf = await makeAmbiguousColourSlide();
    const [rendered] = (await renderDeckPages(pdf, [1], {}, { textLayer: true })).pages;
    const layer = rendered!.textLayer!;
    expect(layer.boxes).toHaveLength(2);
    for (const box of layer.boxes) {
      expect(box.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(box.color).not.toBe("#ffffff");
      const [r, g, b] = [1, 3, 5].map((offset) =>
        Number.parseInt(box.color.slice(offset, offset + 2), 16),
      );
      // 白底上的文字必須明顯比底色暗，否則使用者會看到「文字消失」。
      const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      expect(luminance).toBeLessThan(180);
    }
    // 紅色標題要留住紅：紅通道明顯高於綠／藍。
    const heading = layer.boxes[0]!;
    const red = Number.parseInt(heading.color.slice(1, 3), 16);
    const green = Number.parseInt(heading.color.slice(3, 5), 16);
    expect(red).toBeGreaterThan(green + 40);
  }, 60_000);
});

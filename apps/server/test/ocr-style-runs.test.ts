import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationJob,
  PresentationProject,
  StructuredTextProvider,
  StructuredTextRequest,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import type { OcrAdapter, RawOcrResult } from "../src/ocr.js";

/**
 * 抽字時「框內多色」的端到端契約。
 *
 * 這條路有兩個獨立的部分，這個檔守它們接起來之後的行為：
 *   (a) 模型回 `runs`（片段文字）→ `alignRunsToText()` 對齊回 OCR 原文 → 落地成 `runs` 欄位
 *   (b) **顏色一律從原圖量**（`measureRunColors()`），模型給的只當退路；模型憑空切出來的
 *       假分段會因為兩段量到同色而被合併回單色
 *
 * 底圖由測試自己畫（ground truth 精確），OCR 與文字模型都是 stub，不打任何模型。
 */

const LINE = { x: 120, y: 110, width: 960, height: 120 };
const TEXT = "打造 AI Agent 的未來";

/** 一張 1920×1080 的圖，指定的字段各自上色。 */
function slideImage(segments: readonly { text: string; color: string }[]): string {
  const tspans = segments
    .map((segment) => `<tspan fill="${segment.color}" xml:space="preserve">${segment.text}</tspan>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#ffffff"/><text x="${LINE.x}" y="200" font-family="Arial, Helvetica" font-size="72">${tspans}</text></svg>`;
}

const ONE_LINE: RawOcrResult = {
  width: 1920,
  height: 1080,
  boxes: [
    {
      text: TEXT,
      confidence: 0.95,
      polygon: [
        [LINE.x, LINE.y],
        [LINE.x + LINE.width, LINE.y],
        [LINE.x + LINE.width, LINE.y + LINE.height],
        [LINE.x, LINE.y + LINE.height],
      ],
    },
  ],
};

function instantOcr(result: RawOcrResult): OcrAdapter {
  return {
    status: async () => ({ available: true, message: "ok" }),
    recognize: async () => result,
  };
}

async function fakeInpaintEngine(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "slide-maker-runs-engine-"));
  const png = join(dir, "result.png");
  await writeFile(
    png,
    await sharp({ create: { width: 1920, height: 1080, channels: 4, background: "#ffffff" } })
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
  return async () => {
    if (previousPython === undefined) delete process.env.SLIDE_MAKER_INPAINT_PYTHON;
    else process.env.SLIDE_MAKER_INPAINT_PYTHON = previousPython;
    if (previousScript === undefined) delete process.env.SLIDE_MAKER_INPAINT_SCRIPT;
    else process.env.SLIDE_MAKER_INPAINT_SCRIPT = previousScript;
    await rm(dir, { recursive: true, force: true });
  };
}

function promptBoxIds(prompt: string): string[] {
  const marker = "OCR_BOXES_JSON\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return (JSON.parse(prompt.slice(index + marker.length)) as { id: string }[]).map((box) => box.id);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("抽字：框內多色", () => {
  let server: Server | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  /** 起 server、建一個單頁專案，並把那一頁的圖換成指定的內容。 */
  const setup = async (segments: readonly { text: string; color: string }[]) => {
    cleanups.push(await fakeInpaintEngine());
    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-runs-")), ".slide-maker-data");
    const app = await createApp(dataRoot, join(tmpdir(), "slide-maker-no-editor-dist"), {
      ocr: instantOcr(ONE_LINE),
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
    });
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const call = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const { status, body } = await call(path, init);
      if (status >= 400) throw new Error(`${status} ${String(body.error ?? "")}`);
      return body as T;
    };
    let project = await json<PresentationProject>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        topic: "框內多色",
        brief: { desiredSlideCount: 1, webSearchMode: "disabled" },
      }),
    });
    await json(`/api/projects/${project.id}/outline`, {
      method: "POST",
      body: JSON.stringify({ replace: true }),
    });
    project = await json<PresentationProject>(`/api/projects/${project.id}`);
    const slideId = project.slides[0]!.id;
    await json<GenerationJob>(`/api/projects/${project.id}/slides/${slideId}/generate`, {
      method: "POST",
      body: JSON.stringify({ providerId: "mock-image" }),
    });
    await waitUntil(async () => {
      project = await json<PresentationProject>(`/api/projects/${project.id}`);
      return project.slides[0]!.currentVersionId !== undefined;
    });
    /*
     * 把生成出來的圖換成這個測試要的內容：顏色量測讀的就是這張。
     * mock provider 落地的是 `.svg`，所以這裡也寫 SVG（`imagePath` 已含 `assets/` 前綴）。
     */
    const version = project.slides[0]!.versions.at(-1)!;
    await writeFile(
      join(dataRoot, "projects", project.id, version.imagePath),
      slideImage(segments),
      "utf8",
    );
    return {
      extract: () =>
        call(`/api/projects/${project.id}/slides/${slideId}/extract-text`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
    };
  };

  const stubModel = (
    runsFor: (id: string) => { text: string; color: string }[] | undefined,
  ): void => {
    vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockImplementation(
      () =>
        ({
          id: "stub-text",
          availability: { status: "available" },
          runStructured: async (request: StructuredTextRequest) => ({
            value: {
              boxes: promptBoxIds(request.prompt).map((id) => {
                const runs = runsFor(id);
                return {
                  id,
                  role: "presentation",
                  fontFamily: "Arial",
                  fontWeight: 400,
                  // 模型給的顏色刻意是「相近但不對」的值，落地的必須是量出來的。
                  color: "#1d1d1d",
                  align: "left",
                  ...(runs ? { runs } : {}),
                };
              }),
            },
          }),
        }) as unknown as StructuredTextProvider,
    );
  };

  const MULTI = [
    { text: "打造 ", color: "#111111" },
    { text: "AI Agent", color: "#ff6b35" },
    { text: " 的未來", color: "#111111" },
  ];

  it("模型回 runs 時落地成 runs 欄位，顏色是從原圖量的（不是模型給的）", async () => {
    const context = await setup(MULTI);
    stubModel(() => [
      { text: "打造 ", color: "#1d1d1d" },
      { text: "AI Agent", color: "#ff6b4a" },
      { text: " 的未來", color: "#1d1d1d" },
    ]);
    const response = await context.extract();
    expect(response.status).toBe(202);
    const job = response.body as unknown as GenerationJob;
    const box = job.textExtraction!.boxes[0]!;
    expect(box.runs?.map((run) => run.length)).toEqual([3, 8, 4]);
    // 模型給的是 #ff6b4a／#1d1d1d，圖上畫的是 #ff6b35／#111111。
    expect(box.runs?.map((run) => run.color)).toEqual(["#111111", "#ff6b35", "#111111"]);
    /*
     * 框的主色＝佔字數最多的那個顏色（同色的段先加總）。這一行裡橘色 8 個字、
     * 黑色 3+4=7 個字，所以主色是橘色。它的用途是「`runs` 蓋不到的字用什麼顏色」
     * 與屬性面板那顆色票的初值，不是「這一行看起來是什麼顏色」。
     */
    expect(box.color).toBe("#ff6b35");
  });

  it("模型沒回 runs 時不寫這個欄位（單色框與加入這個功能之前逐位元相同）", async () => {
    const context = await setup([{ text: TEXT, color: "#2563eb" }]);
    stubModel(() => undefined);
    const response = await context.extract();
    const box = (response.body as unknown as GenerationJob).textExtraction!.boxes[0]!;
    expect(box.runs).toBeUndefined();
    // 顏色仍然從圖上量——單色框也受惠。
    expect(box.color).toBe("#2563eb");
  });

  it("模型憑空把單色行切成兩段時，像素量到同色就合併回去，不寫 runs", async () => {
    const context = await setup([{ text: TEXT, color: "#111111" }]);
    stubModel(() => [
      { text: "打造 AI", color: "#111111" },
      { text: " Agent 的未來", color: "#2563eb" },
    ]);
    const response = await context.extract();
    const box = (response.body as unknown as GenerationJob).textExtraction!.boxes[0]!;
    expect(box.runs).toBeUndefined();
    expect(box.color).toBe("#111111");
  });

  it("模型順手改掉 OCR 的錯字時，分段仍對齊回原文", async () => {
    const context = await setup(MULTI);
    // 模型把空格補成全形、又把 Agent 寫成 Agents——分段的意圖仍然成立。
    stubModel(() => [
      { text: "打造　", color: "#1d1d1d" },
      { text: "AI Agents", color: "#ff6b4a" },
      { text: " 的未來", color: "#1d1d1d" },
    ]);
    const response = await context.extract();
    const box = (response.body as unknown as GenerationJob).textExtraction!.boxes[0]!;
    // 落地的文字一定是 OCR 讀到的那份，長度加起來剛好蓋滿它。
    expect(box.text).toBe(TEXT);
    expect(box.runs!.reduce((sum, run) => sum + run.length, 0)).toBe(TEXT.length);
    expect(box.runs!.map((run) => run.color)).toEqual(["#111111", "#ff6b35", "#111111"]);
  });

  it("多色的統計進 log，但框裡的字與顏色一個都不進去", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const context = await setup(MULTI);
    stubModel(() => [
      { text: "打造 ", color: "#1d1d1d" },
      { text: "AI Agent", color: "#ff6b4a" },
      { text: " 的未來", color: "#1d1d1d" },
    ]);
    await context.extract();
    const entry = lines
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .find((item) => item.event === "ocr_style_runs");
    expect(entry).toMatchObject({ multiColorBoxes: 1, vetoedByPixels: 0, boxCount: 1 });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("打造");
    expect(serialized).not.toContain("AI Agent");
    expect(serialized).not.toContain("ff6b35");
  });
});

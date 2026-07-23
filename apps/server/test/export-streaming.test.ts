import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { exportPresentation, type ExportFormat } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";
import { RESPONSE_CHUNK_BYTES, sendChunked } from "../src/http-stream.js";

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string } | null> {
  let server: Server | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return null;
    throw error;
  }
  if (!server) throw new Error("Local test server did not initialize");
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** zip 內每個檔案的內容雜湊；zip 本身的 DOS 時間戳每次匯出都不同，故不比對整份位元組。 */
function entryDigests(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([name, content]) => [
      name,
      createHash("sha256").update(content).digest("hex"),
    ]),
  );
}

/** `logWarn` 寫的是一行 JSON 到 console.warn；測試只關心其中的 `event` 欄位。 */
function captureWarnEvents(): { events: string[]; restore: () => void } {
  const events: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    try {
      const parsed: unknown = JSON.parse(String(line));
      if (parsed && typeof parsed === "object" && "event" in parsed) {
        events.push(String((parsed as { event: unknown }).event));
      }
    } catch {
      // 非結構化的 warn（第三方套件）忽略即可。
    }
  });
  return { events, restore: () => spy.mockRestore() };
}

/** 等 `promise`，逾時就回 false——中止路徑「永不返回」的迴歸就靠這個斷言抓。 */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms).unref()),
  ]);
}

describe("sendChunked", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  // 大於單一 chunk（且遠大於 socket 的 highWaterMark），確保迴圈會跨多塊並實際等到 drain。
  const body = new Uint8Array(randomBytes(RESPONSE_CHUNK_BYTES * 4 + 1234));

  beforeAll(async () => {
    const app = express();
    app.get("/blob", async (_request, response) => {
      response.setHeader("Content-Type", "application/octet-stream");
      await sendChunked(response, body);
    });
    const started = await listen(app);
    if (!started) {
      unavailable = true;
      return;
    }
    ({ server, baseUrl } = started);
  });

  afterAll(() => close(server));

  it("streams a multi-chunk body verbatim without a Content-Length", async (context) => {
    if (unavailable) return context.skip();
    const response = await fetch(`${baseUrl}/blob`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBe("chunked");
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.length).toBe(body.length);
    expect(Buffer.from(received).equals(Buffer.from(body))).toBe(true);
  });

  it("streams a body smaller than one chunk", async (context) => {
    if (unavailable) return context.skip();
    const app = express();
    const small = new Uint8Array([1, 2, 3, 4, 5]);
    app.get("/small", async (_request, response) => {
      await sendChunked(response, small);
    });
    const started = await listen(app);
    if (!started) return context.skip();
    try {
      const response = await fetch(`${started.baseUrl}/small`);
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("transfer-encoding")).toBe("chunked");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(small);
    } finally {
      await close(started.server);
    }
  });

  it("resolves and warns when the client aborts before the first write", async (context) => {
    if (unavailable) return context.skip();
    const app = express();
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => (entered = resolve));
    let finished!: () => void;
    const handlerFinished = new Promise<void>((resolve) => (finished = resolve));
    app.get("/aborted-early", async (_request, response) => {
      response.setHeader("Content-Type", "application/octet-stream");
      entered();
      // 模擬「匯出組檔要好幾秒、期間使用者按取消」：等 close 發射完才開始寫。
      // 此時 socket 已 destroyed，write() 直接回 false，而 drain/close 都不會再來。
      await new Promise<void>((resolve) => response.once("close", () => resolve()));
      await sendChunked(response, body);
      finished();
    });
    const started = await listen(app);
    if (!started) return context.skip();
    const warn = captureWarnEvents();
    const controller = new AbortController();
    try {
      const pending = fetch(`${started.baseUrl}/aborted-early`, {
        signal: controller.signal,
      }).catch(() => undefined);
      await handlerEntered;
      controller.abort();
      await pending;
      expect(await settlesWithin(handlerFinished, 3000)).toBe(true);
      expect(warn.events).toContain("response_stream_aborted");
    } finally {
      warn.restore();
      await close(started.server);
    }
  });

  it("resolves and warns when the client aborts mid-stream", async (context) => {
    if (unavailable) return context.skip();
    const app = express();
    // 遠大於 socket 緩衝：客戶端停止讀取後，迴圈一定會卡在 waitForDrain。
    const huge = new Uint8Array(RESPONSE_CHUNK_BYTES * 64);
    let finished!: () => void;
    const handlerFinished = new Promise<void>((resolve) => (finished = resolve));
    app.get("/aborted-midway", async (_request, response) => {
      response.setHeader("Content-Type", "application/octet-stream");
      await sendChunked(response, huge);
      finished();
    });
    const started = await listen(app);
    if (!started) return context.skip();
    const warn = captureWarnEvents();
    const controller = new AbortController();
    try {
      const response = await fetch(`${started.baseUrl}/aborted-midway`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      expect(await settlesWithin(handlerFinished, 3000)).toBe(true);
      expect(warn.events).toContain("response_stream_aborted");
    } finally {
      warn.restore();
      await close(started.server);
    }
  });
});

describe("project export streaming", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  let repository: FileProjectRepository;
  let project: PresentationProject;

  beforeAll(async () => {
    const root = join(await mkdtemp(join(tmpdir(), "slide-maker-export-stream-")), "data");
    repository = new FileProjectRepository(root);
    await repository.initialize();
    project = createProject({ topic: "匯出串流", brief: { desiredSlideCount: 2 } });
    // 亂數雜訊：PNG 壓不掉，單頁就超過一個 chunk，讓匯出走完整的多塊路徑。
    const noise = new Uint8Array(
      await sharp(randomBytes(1920 * 1080 * 3), {
        raw: { width: 1920, height: 1080, channels: 3 },
      })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    );
    const flat = new Uint8Array(
      await sharp({
        create: { width: 1920, height: 1080, channels: 3, background: "#123456" },
      })
        .png()
        .toBuffer(),
    );
    const now = new Date().toISOString();
    for (const [index, slide] of project.slides.entries()) {
      const imagePath = await repository.saveAsset(
        project.id,
        `${slide.id}/v1.png`,
        index === 0 ? noise : flat,
      );
      slide.versions.push({
        id: `${slide.id}-v1`,
        imagePath,
        prompt: "",
        providerId: "test",
        model: "test",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      });
      slide.currentVersionId = `${slide.id}-v1`;
    }
    await repository.saveProject(project);

    const started = await listen(await createApp(root, undefined, {}));
    if (!started) {
      unavailable = true;
      return;
    }
    ({ server, baseUrl } = started);
  }, 60_000);

  afterAll(() => close(server));

  const formats: ExportFormat[] = ["pptx", "pdf", "png.zip", "slide-project"];

  it("streams every format chunked and delivers exactly what the exporter produced", async (context) => {
    if (unavailable) return context.skip();
    for (const format of formats) {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/${format}`);
      expect(response.status, format).toBe(200);
      // Cloud Run 對 non-streamed 回應有 32 MiB 上限：這兩條 header 就是「沒有回頭用
      // response.send()」的守門，缺一則大型匯出在雲端會直接失敗。
      expect(response.headers.get("content-length"), format).toBeNull();
      expect(response.headers.get("transfer-encoding"), format).toBe("chunked");
      expect(response.headers.get("content-disposition"), format).toContain("attachment;");

      const received = new Uint8Array(await response.arrayBuffer());
      const expected = await exportPresentation(repository, project, format);
      expect(received.length, format).toBe(expected.length);
      // 每一份都比一個 chunk 大，串流路徑才真的被走過（截斷或錯位都會在下面爆）。
      expect(received.length, format).toBeGreaterThan(RESPONSE_CHUNK_BYTES);
      if (format === "png.zip" || format === "slide-project") {
        // 內容逐檔比對雜湊；zip 標頭的 DOS 時間戳每次匯出都不同，不列入比較。
        expect(entryDigests(received), format).toEqual(entryDigests(expected));
      } else if (format === "pptx") {
        // docProps/core.xml 帶建立時間，同樣排除。
        const { "docProps/core.xml": _created, ...entries } = entryDigests(received);
        const { "docProps/core.xml": _expectedCreated, ...expectedEntries } =
          entryDigests(expected);
        expect(entries).toEqual(expectedEntries);
      } else {
        // PDF 內嵌建立時間，無法逐位元組比對；改驗結構完整（截斷的話 load 會直接失敗）。
        const pdf = await PDFDocument.load(received);
        expect(pdf.getPageCount()).toBe(project.slides.length);
      }
    }
  }, 60_000);
});

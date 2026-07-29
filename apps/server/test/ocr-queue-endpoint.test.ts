import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITABLE_TEXT_BOX_LIMIT } from "@slide-maker/core";
import type {
  GenerationJob,
  PresentationProject,
  StructuredTextProvider,
  StructuredTextRequest,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import type { OcrAdapter, RawOcrResult } from "../src/ocr.js";
import type { OcrQueue } from "../src/ocr-queue.js";

/**
 * extract-text 端點在 OCR 併發閘門前後的**外部契約**：狀態碼、繁中說明、真正的序列化，
 * 以及既有同步錯誤沒有被新分支搶走。
 *
 * 為什麼要打真的 Express app 而不是只測 `OcrQueue`：閘門的價值全在接線上——名額有沒有
 * 真的包住 `ocr.recognize()`、拒絕碼有沒有在錯誤中介層被前面的 regex 分支（`/not found/i`、
 * `^(SOURCE_|…)`）吃掉而變成 404／400、`OCR_QUEUE_BUSY` 有沒有落到最後那條 500。這幾件事
 * 在單元測試裡一條都看不到，壞掉的症狀卻是使用者按下「抽離文字」拿到一個沒有下一步的
 * 錯誤，或（更糟）兩個 4 GB 的 PaddleOCR 同時 spawn。
 *
 * 全程 mock `OcrAdapter`，不碰 `.venv-ocr`（CI 沒有裝）。
 */

/** 一次 `recognize()` 呼叫：測試決定它什麼時候、以什麼結果結束。 */
type OcrCall = {
  imagePath: string;
  /** 呼叫發生的**次序**（第幾次被呼叫），用來證明序列化。 */
  index: number;
  settle: (result: RawOcrResult) => void;
  fail: (reason: Error) => void;
};

/** 一個高信賴度的方框，落在指定格子上。 */
function rawBox(text: string, x: number, y: number, width = 360, height = 64) {
  return {
    text,
    confidence: 0.93,
    polygon: [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ] as [number, number][],
  };
}

const ONE_BOX: RawOcrResult = {
  width: 1920,
  height: 1080,
  boxes: [rawBox("測試標題", 120, 120)],
};
const NO_BOX: RawOcrResult = { width: 1920, height: 1080, boxes: [] };

/**
 * 手動控制每一次 `recognize()` 何時結束的假 OCR。
 *
 * 用 deferred 而不是 `setTimeout`：序列化要證的是「第二筆的 `recognize()` 在第一筆**結束
 * 之後**才被呼叫」，拿睡眠時間賭順序在慢機器上會偽綠、在快機器上會偽紅。
 */
function deferredOcr(available = true): {
  adapter: OcrAdapter;
  calls: OcrCall[];
  waitForCalls: (count: number) => Promise<void>;
} {
  const calls: OcrCall[] = [];
  const adapter: OcrAdapter = {
    status: async () => ({ available, message: available ? "ok" : "沒有安裝 OCR 環境" }),
    recognize: (imagePath: string) =>
      new Promise<RawOcrResult>((resolve, reject) => {
        calls.push({ imagePath, index: calls.length, settle: resolve, fail: reject });
      }),
  };
  return {
    adapter,
    calls,
    waitForCalls: (count) => waitUntil(() => calls.length >= count),
  };
}

/** 立刻回同一份結果的假 OCR（不需要控制時序時用）。 */
function instantOcr(result: RawOcrResult | (() => RawOcrResult)): {
  adapter: OcrAdapter;
  inputs: string[];
} {
  const inputs: string[] = [];
  return {
    inputs,
    adapter: {
      status: async () => ({ available: true, message: "ok" }),
      recognize: async (imagePath: string) => {
        inputs.push(imagePath);
        return typeof result === "function" ? result() : result;
      },
    },
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

/** 假的 local-inpaint 引擎：抽字成功時會排一個 job，沒有它 readiness 就過不了。 */
async function fakeInpaintEngine(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "slide-maker-ocr-queue-engine-"));
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
  return async () => {
    if (previousPython === undefined) delete process.env.SLIDE_MAKER_INPAINT_PYTHON;
    else process.env.SLIDE_MAKER_INPAINT_PYTHON = previousPython;
    if (previousScript === undefined) delete process.env.SLIDE_MAKER_INPAINT_SCRIPT;
    else process.env.SLIDE_MAKER_INPAINT_SCRIPT = previousScript;
    await rm(dir, { recursive: true, force: true });
  };
}

describe("extract-text 的 OCR 併發閘門（HTTP 契約）", () => {
  let server: Server | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  /** 起 server、建一個已生好圖的專案，回傳打端點需要的一切。 */
  const setup = async (ocr: OcrAdapter, slideCount = 1) => {
    cleanups.push(await fakeInpaintEngine());
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-ocr-queue-http-")),
      ".slide-maker-data",
    );
    const app = await createApp(dataRoot, join(tmpdir(), "slide-maker-no-editor-dist"), { ocr });
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
      if (status >= 400) throw new Error(`${status} ${String(body.error ?? "")}`);
      return body as T;
    };
    let project = await json<PresentationProject>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        topic: "營收機密簡報",
        brief: { desiredSlideCount: slideCount, webSearchMode: "disabled" },
      }),
    });
    await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
      method: "POST",
      body: JSON.stringify({ replace: true }),
    });
    project = await json<PresentationProject>(`/api/projects/${project.id}`);
    const slideIds = project.slides.map((slide) => slide.id);
    for (const slideId of slideIds)
      await json<GenerationJob>(`/api/projects/${project.id}/slides/${slideId}/generate`, {
        method: "POST",
        body: JSON.stringify({ providerId: "mock-image" }),
      });
    await waitUntil(async () => {
      project = await json<PresentationProject>(`/api/projects/${project.id}`);
      return project.slides.every((slide) => slide.currentVersionId !== undefined);
    });
    const ocrInputDir = join(dataRoot, "projects", project.id, "assets", "ocr-input");
    return {
      app,
      baseUrl,
      call,
      json,
      dataRoot,
      projectId: project.id,
      slideIds,
      project,
      queue: app.locals.ocrQueue as OcrQueue,
      /** `ocr-input/` 底下現存的檔名（目錄不存在＝空，那也是乾淨的）。 */
      ocrInputFiles: () => readdir(ocrInputDir).catch(() => [] as string[]),
      extract: (slideId: string, body: Record<string, unknown> = {}) =>
        call(`/api/projects/${project.id}/slides/${slideId}/extract-text`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      /** 不等回應的 POST，用來把請求停在佇列裡。 */
      extractRaw: (slideId: string, init: RequestInit = {}) =>
        fetch(`${baseUrl}/api/projects/${project.id}/slides/${slideId}/extract-text`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          ...init,
        }),
    };
  };

  /**
   * 佇列滿了要回 429（不是 500，也不是 4xx 裡隨便一個）並附一句可行動的繁中說明。
   *
   * 請求是**逐一**送進去並等佇列狀態確定後才送下一筆：四筆一起 fire 的話，誰排到第幾位
   * 由 event loop 決定，「第四筆拿到 429」會變成機率題。
   */
  it("佇列滿載回 429＋繁中說明，且第四筆完全沒碰到 OCR", async () => {
    const ocr = deferredOcr();
    const context = await setup(ocr.adapter);
    const slideId = context.slideIds[0]!;

    const first = context.extract(slideId);
    await ocr.waitForCalls(1);
    expect(context.queue.activeCount).toBe(1);

    const second = context.extract(slideId);
    await waitUntil(() => context.queue.queuedCount === 1);
    const third = context.extract(slideId);
    await waitUntil(() => context.queue.queuedCount === 2);

    const rejected = await context.extract(slideId);
    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toBe("OCR_QUEUE_BUSY");
    // 抽字按鈕直接顯示 message，所以它必須是一句人看得懂、講得出下一步的中文。
    expect(String(rejected.body.message)).toContain("請稍候再試");
    expect(String(rejected.body.message)).toMatch(/[一-鿿]/);
    // 被擋下的那一筆一個 OCR 子程序都沒有 spawn——這正是整個閘門存在的理由。
    expect(ocr.calls).toHaveLength(1);
    // 拒絕不影響佇列狀態：前面三筆照樣排著。
    expect(context.queue.queuedCount).toBe(2);

    // 收尾：三筆都放行（都沒有框 → 422，不會排 job）。
    for (let index = 0; index < 3; index += 1) {
      await ocr.waitForCalls(index + 1);
      ocr.calls[index]!.settle(NO_BOX);
    }
    for (const pending of [first, second, third])
      expect((await pending).body.error).toBe("OCR_NO_TEXT");
  }, 60_000);

  /**
   * 「一次只跑一個」的**行為**證明。
   *
   * 只看 `queuedCount` 不夠：那是佇列自己的帳。真正要證的是第二頁的 `recognize()` 不會與
   * 第一頁的重疊——重疊就是兩個 4.3 GB 的程序，Cloud Run（2 GiB）當場 OOM。
   */
  it("兩頁同時抽字時，第二頁的 recognize() 要等第一頁結束後才被呼叫", async () => {
    const ocr = deferredOcr();
    const context = await setup(ocr.adapter, 2);
    const [slideA, slideB] = context.slideIds as [string, string];

    const firstResponse = context.extract(slideA);
    await ocr.waitForCalls(1);
    const secondResponse = context.extract(slideB);
    // 排進去了（handler 已經走到閘門），但 recognize 還是只被呼叫過一次。
    await waitUntil(() => context.queue.queuedCount === 1);
    expect(ocr.calls).toHaveLength(1);
    // 多等一會兒也一樣：這不是「還沒輪到 event loop」，是真的被擋住。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ocr.calls).toHaveLength(1);

    ocr.calls[0]!.settle(NO_BOX);
    expect((await firstResponse).body.error).toBe("OCR_NO_TEXT");
    // 第一筆結束之後才輪到第二筆。
    await ocr.waitForCalls(2);
    expect(ocr.calls[1]!.index).toBe(1);
    ocr.calls[1]!.settle(NO_BOX);
    expect((await secondResponse).body.error).toBe("OCR_NO_TEXT");
    expect(context.queue.activeCount).toBe(0);
  }, 60_000);

  /**
   * 429 的 log 只准帶 id 與數字。
   *
   * `logWarn("ocr_queue_rejected", …)` 是使用者回報「一直失敗」時唯一的證據，但 OCR 認到的
   * 字、使用者打的字、頁面內文一個字都不能進去——這條照 outline-overflow.test.ts 的做法直接
   * 對序列化後的整串斷言，欄位改名、多塞一個 `boxes` 都會紅。
   */
  it("ocr_queue_rejected 的 log 不含 OCR 正文或頁面內文", async () => {
    const secret = "第三季毛利率四十七點二";
    const ocr = deferredOcr();
    const context = await setup(ocr.adapter);
    const slideId = context.slideIds[0]!;
    const slideContent = context.project.slides[0]!.content;

    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });

    const inflight = context.extract(slideId);
    await ocr.waitForCalls(1);
    // 逐一送、逐一等佇列長度確定：兩筆一起 fire 的話，誰排在前面由 event loop 決定。
    const queued = [context.extract(slideId)];
    await waitUntil(() => context.queue.queuedCount === 1);
    queued.push(context.extract(slideId));
    await waitUntil(() => context.queue.queuedCount === 2);
    const rejected = await context.extract(slideId);
    expect(rejected.status).toBe(429);

    // 進行中的那一筆真的把機密文字帶進了伺服器（否則這條測試等於什麼都沒驗）。
    ocr.calls[0]!.settle({ width: 1920, height: 1080, boxes: [rawBox(secret, 120, 120)] });
    await inflight;
    // 先把三筆 OCR 全部放行，最後才一起收回應。反過來寫（放行一筆就 await 一筆）會依賴
    // 「陣列第 n 筆 == 佇列第 n 筆」，而那個對應關係並不保證——對不上時就死鎖在這裡。
    for (let index = 1; index <= 2; index += 1) {
      await ocr.waitForCalls(index + 1);
      ocr.calls[index]!.settle(NO_BOX);
    }
    for (const response of await Promise.all(queued))
      expect(response.body.error).toBe("OCR_NO_TEXT");

    const rejectionLogs = warnings
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === "ocr_queue_rejected");
    expect(rejectionLogs).toHaveLength(1);
    expect(rejectionLogs[0]).toMatchObject({
      severity: "WARNING",
      projectId: context.projectId,
      slideId,
      activeCount: 1,
      queuedCount: 2,
    });
    // 整串 warning（不只那一筆）都不得出現正文。
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(slideContent);
    expect(serialized).not.toContain("營收機密簡報");
  }, 60_000);

  /**
   * 關機之後進來的抽字要回 503（暫時性、可重試），不是 500。
   *
   * Cloud Run 送 SIGTERM 之後還會有一小段時間收到請求；回 500 的話前端只會顯示
   * INTERNAL_SERVER_ERROR，使用者不知道再按一次就好。
   */
  it("關機後回 503 OCR_QUEUE_SHUTDOWN 並附繁中說明", async () => {
    const ocr = instantOcr(ONE_BOX);
    const context = await setup(ocr.adapter);
    await context.queue.shutdown();

    const response = await context.extract(context.slideIds[0]!);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("OCR_QUEUE_SHUTDOWN");
    expect(String(response.body.message)).toContain("稍候");
    // 關機後不得再 spawn OCR。
    expect(ocr.inputs).toHaveLength(0);
  }, 60_000);

  /**
   * client 中途斷線時**不取消**：那一筆照樣跑完，成果照樣落地。
   *
   * 這條釘的是一個刻意的設計決定，不是實作細節。抽字的產物是持久化的——OCR 之後 handler 會
   * 一路做完樣式精修、產遮罩、`jobs.enqueue()` 把抹字 job 寫進 project.json，202 的 body 只是
   * 那個 job 物件，前端拿到後也只是重抓專案。所以斷線時這次 OCR 一點都沒白費，使用者回來就
   * 看到抽好的文字層。若哪天有人「順手」加回斷線取消，使用者的體驗會反過來變成：回來發現
   * 什麼都沒發生、只好再按一次，於是真的多跑一次 4 GB 的 OCR。
   *
   * 同時驗最後那個 202 是寫給一個**已經關掉的 socket** 的：Node 對此不得丟出未處理的例外。
   */
  it("client 中途斷線時 OCR 照跑、文字層照落地，且寫回已關閉的 socket 不會噴錯", async () => {
    const ocr = deferredOcr();
    const context = await setup(ocr.adapter);
    const slideId = context.slideIds[0]!;

    // 這條專門要看「有沒有人在背景噴錯」，所以把行程層級的兩個出口都接起來。
    const processErrors: unknown[] = [];
    const onProcessError = (error: unknown) => processErrors.push(error);
    process.on("uncaughtException", onProcessError);
    process.on("unhandledRejection", onProcessError);
    try {
      const aborter = new AbortController();
      const abandoned = context
        .extractRaw(slideId, { signal: aborter.signal })
        .then(() => "responded")
        .catch(() => "aborted");

      // 等 OCR 真的開跑，再把 client 拔掉。
      await ocr.waitForCalls(1);
      aborter.abort();
      expect(await abandoned).toBe("aborted");

      // 斷線後才回來的 OCR 結果：整條路要照走完。
      ocr.calls[0]!.settle(ONE_BOX);

      // 使用者回來看得到成果——這就是「沒有白費」的定義。
      await waitUntil(async () => {
        const project = await context.json<PresentationProject>(
          `/api/projects/${context.projectId}`,
        );
        const slide = project.slides.find((candidate) => candidate.id === slideId);
        return !!slide?.versions.some((version) => version.textLayer);
      });

      // 名額有還回來，佇列沒有被那一筆卡住。
      await waitUntil(() => context.queue.activeCount === 0);
      expect(context.queue.queuedCount).toBe(0);
      // 伺服器還活著：下一個請求照常處理。
      const after = context.extract(slideId);
      await ocr.waitForCalls(2);
      ocr.calls[1]!.settle(NO_BOX);
      expect((await after).status).toBeGreaterThanOrEqual(200);
      // 對已關閉的 socket 寫 202 不得變成 uncaughtException／unhandledRejection。
      expect(processErrors).toEqual([]);
    } finally {
      process.off("uncaughtException", onProcessError);
      process.off("unhandledRejection", onProcessError);
    }
  }, 60_000);
});

/**
 * 閘門進場之前就存在的同步錯誤契約。
 *
 * 新的 `OCR_QUEUE_*` 分支插在錯誤中介層的**最前面**，而這幾條各自走不同的路：409 是
 * handler 內的 early return（`OCR_UNAVAILABLE`）、422 是 handler 尾端的 return
 * （`OCR_NO_TEXT`／`OCR_NO_PRESENTATION_TEXT`）、`TEXT_LAYER_BOX_LIMIT` 是 409 的 return。
 * 只要有人把新分支寫成前綴比對或改動了順序，這幾個碼就會被改寫成別的狀態碼，而前端對它們
 * 各有不同的下一步。
 */
describe("extract-text 既有同步錯誤契約（迴歸）", () => {
  let server: Server | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  const setup = async (ocr: OcrAdapter) => {
    cleanups.push(await fakeInpaintEngine());
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-ocr-contract-")),
      ".slide-maker-data",
    );
    const app = await createApp(dataRoot, join(tmpdir(), "slide-maker-no-editor-dist"), { ocr });
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
        topic: "錯誤契約",
        brief: { desiredSlideCount: 1, webSearchMode: "disabled" },
      }),
    });
    await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
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
    return {
      extract: (body: Record<string, unknown> = {}) =>
        call(`/api/projects/${project.id}/slides/${slideId}/extract-text`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
    };
  };

  it("OCR 環境不可用時仍是 409 OCR_UNAVAILABLE，並保留 adapter 的說明", async () => {
    const context = await setup({
      status: async () => ({ available: false, message: "找不到 .venv-ocr" }),
      recognize: async () => {
        throw new Error("不該被呼叫");
      },
    });
    const response = await context.extract();
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("OCR_UNAVAILABLE");
    expect(response.body.message).toBe("找不到 .venv-ocr");
  }, 60_000);

  it("一個框都沒抽到仍是 422 OCR_NO_TEXT", async () => {
    const context = await setup(instantOcr(NO_BOX).adapter);
    const response = await context.extract();
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("OCR_NO_TEXT");
    expect(String(response.body.message)).toContain("門檻");
  }, 60_000);

  it("抽到的框全被判成 logo／裝飾時仍是 422 OCR_NO_PRESENTATION_TEXT", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    // 這條 422 只有在樣式精修真的跑過（把 role 改掉）時才到得了：`boxesFromOcr` 一律給
    // presentation。所以要接上一個「可用」的文字模型並讓它把每個框都標成 logo。
    // 一定要在 setup **之後**才換掉：專案的大綱也走同一支 provider，提前換掉會讓建專案
    // 那幾步先炸掉。
    vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        const ids = (
          JSON.parse(request.prompt.slice(request.prompt.indexOf("OCR_BOXES_JSON") + 15)) as {
            id: string;
          }[]
        ).map((box) => box.id);
        return {
          boxes: ids.map((id) => ({
            id,
            role: "logo",
            fontFamily: "Arial",
            fontWeight: 400,
            color: "#ffffff",
            align: "left",
          })),
        };
      },
    } as unknown as StructuredTextProvider);
    const response = await context.extract();
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("OCR_NO_PRESENTATION_TEXT");
  }, 60_000);

  it("合併後超過文字框上限仍是 409 TEXT_LAYER_BOX_LIMIT，且 log 只有數字", async () => {
    const overLimit: RawOcrResult = {
      width: 1920,
      height: 1080,
      boxes: Array.from({ length: EDITABLE_TEXT_BOX_LIMIT + 1 }, (_, index) =>
        // 格狀鋪開、彼此不重疊：合併／拆框邏輯不會把數量改掉。
        rawBox("字", 8 + (index % 32) * 59, 8 + Math.floor(index / 32) * 66, 48, 30),
      ),
    };
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const context = await setup(instantOcr(overLimit).adapter);
    const response = await context.extract();
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("TEXT_LAYER_BOX_LIMIT");
    expect(String(response.body.message)).toContain(String(EDITABLE_TEXT_BOX_LIMIT));
    // 框裡的字不得進 log。
    expect(
      warnings
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === "text_extraction_box_limit_exceeded"),
    ).toBeDefined();
    expect(JSON.stringify(warnings)).not.toContain('"字"');
  }, 120_000);
});

/**
 * `assets/ocr-input/*.png` 不得外洩。
 *
 * 端點把正規化後的 1920×1080 PNG（約 1–3 MB）寫到 `ocr-input/`，只給 `ocr.recognize()` 與
 * 樣式精修讀，之後沒有任何持久化紀錄引用它。以前從來沒有人刪，於是每按一次「抽離文字」就
 * 漏一張；429 與早退那幾條更是使用者連點時反覆踩的路徑。
 *
 * 這一組把**每一條出口**都走一遍：清理若只掛在成功路徑上，下面任何一條都會紅。
 */
describe("extract-text 的 ocr-input 中間產物清理", () => {
  let server: Server | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  const setup = async (ocr: OcrAdapter) => {
    cleanups.push(await fakeInpaintEngine());
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-ocr-input-")),
      ".slide-maker-data",
    );
    const app = await createApp(dataRoot, join(tmpdir(), "slide-maker-no-editor-dist"), { ocr });
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
        topic: "中間產物",
        brief: { desiredSlideCount: 1, webSearchMode: "disabled" },
      }),
    });
    await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
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
    const assetsRoot = join(dataRoot, "projects", project.id, "assets");
    return {
      app,
      dataRoot,
      projectId: project.id,
      slideId,
      queue: app.locals.ocrQueue as OcrQueue,
      assetsRoot,
      /** `ocr-input/` 底下現存的檔名（目錄不存在＝空，那也算乾淨）。 */
      ocrInputFiles: () => readdir(join(assetsRoot, "ocr-input")).catch(() => [] as string[]),
      extract: (body: Record<string, unknown> = {}) =>
        call(`/api/projects/${project.id}/slides/${slideId}/extract-text`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
    };
  };

  /**
   * 等 `ocr-input/` 收斂到 `expected` 個檔。
   *
   * 用等的而不是立刻斷言：清理在 handler 的 `finally` 裡，而回應在那之前就已經寫出去了
   * （`return response.status(...).json(...)`），所以 client 拿到回應時刪除可能還沒跑完。
   * 這不是實作細節的遷就——「檔案最終不會留下」才是要守的性質。收斂後再斷言一次，失敗時
   * 才看得到實際殘留了哪些檔名。
   */
  const expectOcrInputDrained = async (
    context: { ocrInputFiles: () => Promise<string[]> },
    expected = 0,
  ) => {
    // 5 秒對一次 rm 綽綽有餘；沒收斂就讓下面的斷言帶著實際檔名紅掉。
    await waitUntil(async () => (await context.ocrInputFiles()).length === expected, 5_000).catch(
      () => undefined,
    );
    expect(await context.ocrInputFiles()).toHaveLength(expected);
  };

  it("成功回 202 之後不留殘檔", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    const response = await context.extract();
    expect(response.status).toBe(202);
    await expectOcrInputDrained(context);
  }, 60_000);

  it("OCR_NO_TEXT（422 早退）之後不留殘檔", async () => {
    const context = await setup(instantOcr(NO_BOX).adapter);
    expect((await context.extract()).body.error).toBe("OCR_NO_TEXT");
    await expectOcrInputDrained(context);
  }, 60_000);

  it("OCR_NO_PRESENTATION_TEXT（422 早退）之後不留殘檔", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    // 與既有那條 422 測試同一個手法：接一個「可用」的文字模型並讓它把每個框都標成 logo。
    vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        const ids = (
          JSON.parse(request.prompt.slice(request.prompt.indexOf("OCR_BOXES_JSON") + 15)) as {
            id: string;
          }[]
        ).map((box) => box.id);
        return {
          boxes: ids.map((id) => ({
            id,
            role: "logo",
            fontFamily: "Arial",
            fontWeight: 400,
            color: "#ffffff",
            align: "left",
          })),
        };
      },
    } as unknown as StructuredTextProvider);
    expect((await context.extract()).body.error).toBe("OCR_NO_PRESENTATION_TEXT");
    // 樣式精修**也**讀這個檔（`imagePaths`），所以這條同時證明清理沒有早於最後一個讀取點。
    await expectOcrInputDrained(context);
  }, 60_000);

  it("TEXT_LAYER_BOX_LIMIT（409 早退）之後不留殘檔", async () => {
    const overLimit: RawOcrResult = {
      width: 1920,
      height: 1080,
      boxes: Array.from({ length: EDITABLE_TEXT_BOX_LIMIT + 1 }, (_, index) =>
        rawBox("字", 8 + (index % 32) * 59, 8 + Math.floor(index / 32) * 66, 48, 30),
      ),
    };
    const context = await setup(instantOcr(overLimit).adapter);
    expect((await context.extract()).body.error).toBe("TEXT_LAYER_BOX_LIMIT");
    await expectOcrInputDrained(context);
  }, 120_000);

  /**
   * 429 是這條洩漏在現實中最常被踩的路徑：使用者連點抽字，被擋下的那幾筆**已經**把圖寫到
   * 磁碟上了（`saveAsset` 在閘門之前），卻從來沒有人刪。
   *
   * 這裡刻意在 429 當下就數一次：那一刻應該只剩「進行中 1 筆＋排隊 2 筆」的 3 個檔，
   * 被回絕的第 4 筆必須已經清掉自己。只在最後數的話，分不出「它清乾淨了」與「它根本沒寫」。
   */
  it("OCR_QUEUE_BUSY（429）被回絕的那一筆當場清掉自己的殘檔", async () => {
    const ocr = deferredOcr();
    const context = await setup(ocr.adapter);

    const first = context.extract();
    await ocr.waitForCalls(1);
    const second = context.extract();
    await waitUntil(() => context.queue.queuedCount === 1);
    const third = context.extract();
    await waitUntil(() => context.queue.queuedCount === 2);
    // 三筆都已經越過 saveAsset，各自的檔案都還活著（正在被讀／等著被讀）。
    expect(await context.ocrInputFiles()).toHaveLength(3);

    const rejected = await context.extract();
    expect(rejected.status).toBe(429);
    // 第 4 筆寫過檔又被回絕——它必須自己收乾淨，否則會停在 4。前三筆全被 deferred OCR 釘住，
    // 所以這個數字只可能由 4 收斂到 3，不會誤判成「它根本沒寫」。
    await expectOcrInputDrained(context, 3);

    for (let index = 0; index < 3; index += 1) {
      await ocr.waitForCalls(index + 1);
      ocr.calls[index]!.settle(NO_BOX);
    }
    for (const pending of [first, second, third])
      expect((await pending).body.error).toBe("OCR_NO_TEXT");
    await expectOcrInputDrained(context);
  }, 60_000);

  /**
   * 啟動掃除：try/finally 擋不住行程被砍，而「OCR 途中被 OOM 砍掉」正是這整個閘門要防的
   * 情境，它必然留下殘檔。
   *
   * 同時釘住掃除的**範圍**：只能清 `ocr-input/`。掃過頭會刪掉版本圖與 job 引用的遮罩，
   * 那是不可復原的資料損毀。
   */
  it("啟動時清掉 ocr-input 殘骸，且不動其他資產前綴", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    const plant = async (relativePath: string) => {
      const target = join(context.assetsRoot, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "stale");
      return target;
    };
    // 上一輪行程被砍掉時留下的殘骸。
    await plant("ocr-input/stale-a.png");
    await plant("ocr-input/stale-b.png");
    // 這些是有主的：絕不能被掃到。
    const survivors = [
      await plant("text-layers/keep-composite.png"),
      await plant("edit-masks/keep-mask.png"),
      await plant("sources/some-source/keep.pdf"),
      await plant("keep-at-root.png"),
    ];
    expect(await context.ocrInputFiles()).toHaveLength(2);

    // 重新啟動（只建 app，不 listen：啟動掃除跑在 createApp 裡）。
    await createApp(context.dataRoot, join(tmpdir(), "slide-maker-no-editor-dist"), {
      ocr: instantOcr(ONE_BOX).adapter,
    });

    expect(await context.ocrInputFiles()).toEqual([]);
    for (const survivor of survivors) expect(await stat(survivor).then(() => true)).toBe(true);
  }, 60_000);
});

/**
 * 簡→繁轉換的**接線**：判準本身由 `traditionalize.test.ts` 釘住，這裡只證三件在單元測試
 * 裡看不到的事——預設是開的（body 什麼都不帶就會轉）、`false` 真的關得掉（zod 沒有把它
 * coerce 成 true），以及轉換結果真的進了 202 回傳的 `textExtraction.boxes`（不是在某個
 * 中間步驟被丟掉）。
 */
describe("extract-text 的簡→繁轉換（HTTP 契約）", () => {
  let server: Server | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  /** PaddleOCR 把繁體投影片讀成簡體的那一框。 */
  const SIMPLIFIED: RawOcrResult = {
    width: 1920,
    height: 1080,
    boxes: [rawBox("营收成长", 120, 120)],
  };

  const setup = async (result: RawOcrResult = SIMPLIFIED) => {
    cleanups.push(await fakeInpaintEngine());
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-ocr-tc-")),
      ".slide-maker-data",
    );
    const app = await createApp(dataRoot, join(tmpdir(), "slide-maker-no-editor-dist"), {
      ocr: instantOcr(result).adapter,
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
        topic: "簡繁轉換",
        brief: { desiredSlideCount: 1, webSearchMode: "disabled" },
      }),
    });
    await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
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
    return {
      /** 把這一頁的大綱換成指定文字（`textRepair: "outline"` 的錨）。 */
      setOutline: (content: string, layoutHint: string) =>
        json<PresentationProject>(`/api/projects/${project.id}/slides/${slideId}`, {
          method: "PATCH",
          body: JSON.stringify({ content, layoutHint }),
        }),
      /** 回傳 202 的 job 裡，這一頁抽出來的框文字。 */
      extractedTexts: async (body: Record<string, unknown> = {}) => {
        const { status, body: job } = await call(
          `/api/projects/${project.id}/slides/${slideId}/extract-text`,
          { method: "POST", body: JSON.stringify(body) },
        );
        expect(status).toBe(202);
        return ((job as unknown as GenerationJob).textExtraction?.boxes ?? []).map(
          (entry) => entry.text,
        );
      },
    };
  };

  it("body 不帶 traditionalize 時預設會轉", async () => {
    const context = await setup();
    expect(await context.extractedTexts()).toEqual(["營收成長"]);
  }, 60_000);

  it("traditionalize:false 時原樣保留 OCR 讀到的簡體", async () => {
    const context = await setup();
    // `z.boolean()` 而不是 `z.coerce.boolean()`：後者連 `"false"` 都會變成 true。
    expect(await context.extractedTexts({ traditionalize: false })).toEqual(["营收成长"]);
  }, 60_000);

  /**
   * 順序不變量：簡→繁一定要排在 `refineOcrBoxes` **之前**。
   *
   * 大綱是繁體的，OCR 讀出來的是簡體；先修復再轉繁等於拿混著簡體的字串去做模糊比對，
   * 編輯距離被那幾個簡體字拉高到超過 `MAX_ERROR_RATIO`（34%），該對上的那一行就對不上。
   * 這裡刻意讓大綱帶空格：對上時空格會被還原回來，因此「有沒有對上」在結果字串上直接
   * 看得出來，兩行對調就會紅。
   */
  /** 9 個字裡有 4 個簡體（营／长／与／获）＝ 44% 差異，先修復必定超過 34% 的門檻。 */
  const MOSTLY_SIMPLIFIED: RawOcrResult = {
    width: 1920,
    height: 1080,
    boxes: [rawBox("营收成长与获利能力", 120, 120, 720, 64)],
  };

  it("traditionalize 搭 textRepair:outline 時，大綱修復對得上（順序不可對調）", async () => {
    const context = await setup(MOSTLY_SIMPLIFIED);
    await context.setOutline("營收成長 與 獲利能力", "標題置中");
    expect(await context.extractedTexts({ textRepair: "outline" })).toEqual([
      // 空格是大綱獨有的，只有真的對上才會出現在結果裡。兩行對調的話會拿到
      // `營收成長與獲利能力`（沒有空格＝沒對上，只是照樣被轉繁）。
      "營收成長 與 獲利能力",
    ]);
  }, 60_000);

  it("同一份輸入關掉 traditionalize 就對不上——證明門檻真的擋在那裡", async () => {
    const context = await setup(MOSTLY_SIMPLIFIED);
    await context.setOutline("營收成長 與 獲利能力", "標題置中");
    // 沒有轉繁的 needle 與大綱差 44%，`correctTextFromSources` 直接放棄，原文原樣留下。
    expect(await context.extractedTexts({ textRepair: "outline", traditionalize: false })).toEqual([
      "营收成长与获利能力",
    ]);
  }, 60_000);

  /**
   * `ocr_traditionalized` 的 log 只准帶 id 與數字。
   *
   * 與 `ocr_queue_rejected` 同一條紀律，做法也照抄 `outline-overflow.test.ts`：直接對序列化
   * 後的整串斷言，任何人不小心把 `boxes`／原文塞進欄位都會紅。
   */
  it("ocr_traditionalized 的 log 不含 OCR 正文或頁面內文", async () => {
    const context = await setup();
    const secret = "第三季毛利率四十七點二";
    await context.setOutline(secret, "標題置中");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    expect(await context.extractedTexts()).toEqual(["營收成長"]);

    const logged = logs.filter((line) => line.includes("ocr_traditionalized"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({
      changedBoxes: 1,
      // 营→營、长→長；`收`／`成` 兩個字簡繁同形。
      changedChars: 2,
      severity: "INFO",
    });
    // OCR 讀到的字（轉換前後都算）與頁面內文一個字都不能進去。
    expect(logged[0]).not.toContain("营收成长");
    expect(logged[0]).not.toContain("營收成長");
    expect(logged[0]).not.toContain(secret);
  }, 60_000);
});

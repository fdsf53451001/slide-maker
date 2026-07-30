import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
import { ModelLibraryError, ModelRuntime } from "../src/model-runtime.js";
import type { OcrAdapter, RawOcrResult } from "../src/ocr.js";

/**
 * 抽字的「視覺樣式精修」失敗時，使用者到底看得到什麼？
 *
 * 實機踩到的缺陷：專案綁的模型組合被刪掉之後，`resolveStructuredText` 丟
 * `COMBINATION_NOT_FOUND`，而端點的 catch 是**完全空的**——樣式精修整段沒跑，整頁 31 個框
 * 全部落在 `boxesFromOcr` 的預設值（白字 `#ffffff` ＋ Arial），伺服器一行 log 都沒有，前端
 * 也拿不到任何線索。使用者只看得到「字全白」。
 *
 * 這一組釘住修法的兩半：
 *   (a) **設定錯誤在 OCR 之前擋下**——使用者現在就能修，而且必然整頁無風格，所以不要花掉
 *       OCR 與配額才回報。證明方式是「`recognize()` 一次都沒被呼叫」，不是只看狀態碼。
 *   (b) **執行期失敗才降級**——模型不可用、呼叫／解析失敗這兩種當下修不好，照樣產出文字層，
 *       但伺服器留下原因代碼、job 帶回 `styleRefinement.applied:false`。
 *
 * 全程 mock `OcrAdapter` 與文字 provider，不碰 `.venv-ocr`、不打任何模型。
 */

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

/** 框裡的字刻意選一個好認的字串：log 紀律那條要拿它去搜整份 log。 */
const SECRET_TEXT = "併購對價機密";
const ONE_BOX: RawOcrResult = { width: 1920, height: 1080, boxes: [rawBox(SECRET_TEXT, 120, 120)] };
const TWO_BOXES: RawOcrResult = {
  width: 1920,
  height: 1080,
  boxes: [rawBox(SECRET_TEXT, 120, 120), rawBox("第二段落文字", 120, 400)],
};
const NO_BOX: RawOcrResult = { width: 1920, height: 1080, boxes: [] };

/** 立刻回同一份結果的假 OCR；`inputs` 記下每一次呼叫，用來證明「根本沒跑」。 */
function instantOcr(result: RawOcrResult): { adapter: OcrAdapter; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    adapter: {
      status: async () => ({ available: true, message: "ok" }),
      recognize: async (imagePath: string) => {
        inputs.push(imagePath);
        return result;
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

/** 假的 local-inpaint 引擎（把輸入原樣複製到輸出），沒有它 readiness 過不了。 */
async function fakeInpaintEngine(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "slide-maker-style-gate-engine-"));
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

/** 從 prompt 尾巴的 `OCR_BOXES_JSON` 取出框 id（樣式精修的回覆要逐 id 對上）。 */
function promptBoxIds(prompt: string): string[] {
  const marker = "OCR_BOXES_JSON\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return (JSON.parse(prompt.slice(index + marker.length)) as { id: string }[]).map((box) => box.id);
}

describe("抽字的樣式精修失敗契約", () => {
  let server: Server | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  /** 攔下 `logWarn` 的輸出（同時讓測試輸出保持乾淨）；回傳的函式在請求結束後才解析。 */
  const captureWarnings = (): {
    lines: () => string[];
    entries: () => Record<string, unknown>[];
  } => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    return {
      lines: () => lines,
      entries: () =>
        lines.flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        }),
    };
  };

  /** 起 server、建一個已生好圖的單頁專案。 */
  const setup = async (ocr: OcrAdapter) => {
    cleanups.push(await fakeInpaintEngine());
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-style-gate-")),
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
        topic: "樣式精修契約",
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
    const ocrInputDir = join(dataRoot, "projects", project.id, "assets", "ocr-input");
    return {
      projectId: project.id,
      slideId,
      json,
      /** 打 JSON body 的 POST／PATCH／PUT（模型庫 CRUD 用）。 */
      send: <T>(path: string, method: string, payload: unknown): Promise<T> =>
        json<T>(path, { method, body: JSON.stringify(payload) }),
      /** `ocr-input/` 底下現存的檔名（目錄不存在＝空）。 */
      ocrInputFiles: () => readdir(ocrInputDir).catch(() => [] as string[]),
      extract: (body: Record<string, unknown> = {}) =>
        call(`/api/projects/${project.id}/slides/${slideId}/extract-text`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
    };
  };

  /**
   * 一定要在 `setup()` **之後**才換掉 provider：建專案的大綱也走同一支，提前換掉會讓
   * 前置步驟先炸掉，測到的就不是抽字這條路。
   */
  const stubResolveText = (implementation: () => StructuredTextProvider) => {
    vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockImplementation(implementation);
  };

  /** 一支「可用」且把每個框都標成藍色粗體 presentation 的文字 provider。 */
  const workingProvider = (): StructuredTextProvider =>
    ({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => ({
        value: {
          boxes: promptBoxIds(request.prompt).map((id) => ({
            id,
            role: "presentation",
            fontFamily: "Noto Sans TC",
            fontWeight: 700,
            color: "#111111",
            align: "left",
          })),
        },
      }),
    }) as unknown as StructuredTextProvider;

  it.each([
    {
      code: "COMBINATION_NOT_FOUND",
      thrown: "找不到模型組合：deleted-combo",
      expected: "重新選一個模型組合",
    },
    {
      code: "COMBINATION_TEXT_MISSING",
      thrown: "此組合未設定文字模型。",
      expected: "指定文字模型",
    },
    {
      code: "NO_DEFAULT_COMBINATION",
      thrown: "模型庫尚未設定預設組合。",
      expected: "設為預設",
    },
  ])(
    "$code：在跑 OCR 之前就回 409＋繁中說明，`recognize()` 一次都沒被呼叫",
    async ({ code, thrown, expected }) => {
      const ocr = instantOcr(ONE_BOX);
      const context = await setup(ocr.adapter);
      const warnings = captureWarnings();
      stubResolveText(() => {
        throw new ModelLibraryError(code, thrown);
      });
      const response = await context.extract();
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(code);
      // 訊息要能導向下一步動作，不是通用的「找不到模型組合：<id>」。
      expect(String(response.body.message)).toContain(expected);
      expect(String(response.body.message)).toContain("白字 Arial");
      // 這才是這條的重點：配額與時間都還沒花掉。
      expect(ocr.inputs).toEqual([]);
      // 連正規化 PNG 都不該落地。
      expect(await context.ocrInputFiles()).toEqual([]);
      // 伺服器留下可判讀的原因，而不是一片空白。
      const entry = warnings
        .entries()
        .find((item) => item.event === "text_extraction_style_model_unresolved");
      expect(entry).toBeDefined();
      expect(entry?.code).toBe(code);
      expect(entry?.slideId).toBe(context.slideId);
    },
    120_000,
  );

  /**
   * `TEXT_MODEL_NOT_FOUND` 走**真的**模型庫，一個 stub 都不用。
   *
   * 這條以前是裸 500 `INTERNAL_SERVER_ERROR`（沒有 message、沒有下一步）：
   * `ProviderRegistry.get()` 對查不到的 id 丟裸 `Error`，而 `#buildText` 對
   * `providerKind: "mock"` 的 entry 回 undefined＝不註冊。模型庫的種類清單含 `mock`、
   * 組合的文字下拉又只濾掉 `local`，所以這是使用者按幾下就建得出來的狀態。
   */
  it("組合綁到不會產生文字的模型（text × mock）：409 TEXT_MODEL_NOT_FOUND，不是 500", async () => {
    const ocr = instantOcr(ONE_BOX);
    const context = await setup(ocr.adapter);
    const warnings = captureWarnings();
    const library = await context.send<{ models: { id: string }[] }>(
      "/api/model-library/models",
      "POST",
      { name: "假的文字模型", capability: "text", providerKind: "mock" },
    );
    const textModel = library.models.at(-1)!;
    const withCombination = await context.send<{ combinations: { id: string }[] }>(
      "/api/model-library/combinations",
      "POST",
      { name: "綁到 mock 文字模型", imageModelRef: "mock-image", textModelRef: textModel.id },
    );
    await context.send(`/api/projects/${context.projectId}/combination`, "PATCH", {
      combinationId: withCombination.combinations.at(-1)!.id,
    });

    const response = await context.extract();
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("TEXT_MODEL_NOT_FOUND");
    expect(String(response.body.message)).toContain("改掉這個組合的文字模型");
    expect(ocr.inputs).toEqual([]);
    expect(
      warnings.entries().find((item) => item.event === "text_extraction_style_model_unresolved")
        ?.code,
    ).toBe("TEXT_MODEL_NOT_FOUND");
  }, 120_000);

  it("模型可用時照常套上樣式，job 帶回 styleRefinement.applied:true", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    stubResolveText(workingProvider);
    const response = await context.extract();
    expect(response.status).toBe(202);
    const job = response.body as unknown as GenerationJob;
    expect(job.textExtraction?.styleRefinement).toEqual({ applied: true });
    // 樣式真的套上去了：不是預設的白字 Arial。
    expect(job.textExtraction?.boxes[0]?.color).toBe("#111111");
    expect(job.textExtraction?.boxes[0]?.fontFamily).toBe("Noto Sans TC");
  }, 120_000);

  it("模型不可用：照常產出文字層，applied:false＋TEXT_MODEL_UNAVAILABLE，且有 logWarn", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    const warnings = captureWarnings();
    stubResolveText(
      () =>
        ({
          id: "stub-text",
          availability: { status: "unavailable", reason: "找不到 codex CLI" },
          runStructured: async () => {
            throw new Error("不該被呼叫");
          },
        }) as unknown as StructuredTextProvider,
    );
    const response = await context.extract();
    // 擋下也沒用（使用者當下修不好），所以照常做完。
    expect(response.status).toBe(202);
    const job = response.body as unknown as GenerationJob;
    expect(job.textExtraction?.styleRefinement).toEqual({
      applied: false,
      reason: "TEXT_MODEL_UNAVAILABLE",
      // provider 的可用性理由是靜態設定字串（不含憑證或正文），要一路帶到使用者眼前——
      // 「找不到 codex CLI」這種句子本身就是下一步。
      detail: "找不到 codex CLI",
    });
    // 降級的證據：框停在 `boxesFromOcr` 的預設值。
    expect(job.textExtraction?.boxes[0]?.color).toBe("#ffffff");
    const entry = warnings.entries().find((item) => item.event === "ocr_style_refine_skipped");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("TEXT_MODEL_UNAVAILABLE");
    expect(entry?.slideId).toBe(context.slideId);
    expect(entry?.boxCount).toBe(1);
  }, 120_000);

  it("runStructured 丟錯：維持降級，applied:false＋STYLE_REFINE_FAILED，且有 logWarn", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    const warnings = captureWarnings();
    stubResolveText(
      () =>
        ({
          id: "stub-text",
          availability: { status: "available" },
          runStructured: async () => {
            throw new Error("HTTP 503 from gateway");
          },
        }) as unknown as StructuredTextProvider,
    );
    const response = await context.extract();
    expect(response.status).toBe(202);
    const job = response.body as unknown as GenerationJob;
    expect(job.textExtraction?.styleRefinement).toEqual({
      applied: false,
      reason: "STYLE_REFINE_FAILED",
    });
    expect(job.textExtraction?.boxes[0]?.color).toBe("#ffffff");
    const entry = warnings.entries().find((item) => item.event === "ocr_style_refine_failed");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("STYLE_REFINE_FAILED");
    expect(entry?.slideId).toBe(context.slideId);
  }, 120_000);

  it("回覆解析失敗（schema 不合）也走 STYLE_REFINE_FAILED，不是靜默成功", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    stubResolveText(
      () =>
        ({
          id: "stub-text",
          availability: { status: "available" },
          // 少了 `boxes`，`ocrStyleRefinementSchema.parse` 會丟。
          runStructured: async () => ({ value: { nonsense: true } }),
        }) as unknown as StructuredTextProvider,
    );
    const response = await context.extract();
    expect(response.status).toBe(202);
    expect((response.body as unknown as GenerationJob).textExtraction?.styleRefinement).toEqual({
      applied: false,
      reason: "STYLE_REFINE_FAILED",
    });
  }, 120_000);

  /*
   * 「沒有 throw」不等於「樣式套上了」。
   *
   * `ocrStyleRefinementSchema` 對 `boxes` 只有上限、沒有下限也不比對 id，所以回空陣列或
   * 自己編一組 id 都會 parse 成功。少了命中計數，job 會回 `applied: true`、零 log、前端不
   * 提示，而整頁停在白字 Arial——使用者看到的畫面與原本那個 bug 一模一樣，只是換了個入口。
   * CLAUDE.md 明載非嚴格 gateway（尤其 Gemini 系）不遵守 `json_schema`，這正是常見形狀。
   */
  it.each([
    { label: "回空陣列", boxes: () => [], returnedCount: 0 },
    {
      label: "自己編一組對不上的 id",
      boxes: () => [
        {
          id: "11111111-2222-3333-4444-555555555555",
          role: "presentation",
          fontFamily: "Noto Sans TC",
          fontWeight: 700,
          color: "#111111",
          align: "left",
        },
      ],
      returnedCount: 1,
    },
  ])(
    "模型$label：applied:false＋STYLE_REFINE_EMPTY，並記下命中數",
    async ({ boxes, returnedCount }) => {
      const context = await setup(instantOcr(ONE_BOX).adapter);
      const warnings = captureWarnings();
      stubResolveText(
        () =>
          ({
            id: "stub-text",
            availability: { status: "available" },
            runStructured: async () => ({ value: { boxes: boxes() } }),
          }) as unknown as StructuredTextProvider,
      );
      const response = await context.extract();
      expect(response.status).toBe(202);
      const job = response.body as unknown as GenerationJob;
      expect(job.textExtraction?.styleRefinement).toEqual({
        applied: false,
        reason: "STYLE_REFINE_EMPTY",
      });
      // 降級的證據：框停在 `boxesFromOcr` 的預設值。
      expect(job.textExtraction?.boxes[0]?.color).toBe("#ffffff");
      expect(job.textExtraction?.boxes[0]?.fontFamily).toBe("Arial");
      const entry = warnings.entries().find((item) => item.event === "ocr_style_refine_empty");
      expect(entry).toBeDefined();
      expect(entry?.matched).toBe(0);
      expect(entry?.returnedCount).toBe(returnedCount);
      expect(entry?.boxCount).toBe(1);
      // 全是數字：框裡的字不得跟著進 log。
      expect(JSON.stringify(warnings.lines())).not.toContain(SECRET_TEXT);
    },
    120_000,
  );

  /**
   * 部分命中**不算**降級（多數框有風格，硬說整頁沒風格是假警報），但要留下兩個數字：
   * 模型持續只回一半是換模型的訊號，而畫面上只看得到「有幾個框特別白」。
   */
  it("模型只回一部分 id：applied 仍為 true，但留下 matched／boxCount", async () => {
    const context = await setup(instantOcr(TWO_BOXES).adapter);
    const warnings = captureWarnings();
    stubResolveText(
      () =>
        ({
          id: "stub-text",
          availability: { status: "available" },
          runStructured: async (request: StructuredTextRequest) => ({
            value: {
              boxes: promptBoxIds(request.prompt)
                .slice(0, 1)
                .map((id) => ({
                  id,
                  role: "presentation",
                  fontFamily: "Noto Sans TC",
                  fontWeight: 700,
                  color: "#111111",
                  align: "left",
                })),
            },
          }),
        }) as unknown as StructuredTextProvider,
    );
    const response = await context.extract();
    expect(response.status).toBe(202);
    const job = response.body as unknown as GenerationJob;
    expect(job.textExtraction?.styleRefinement).toEqual({ applied: true });
    const entry = warnings.entries().find((item) => item.event === "ocr_style_refine_partial");
    expect(entry).toBeDefined();
    expect(entry?.matched).toBe(1);
    expect(entry?.boxCount).toBe(2);
    expect(JSON.stringify(warnings.lines())).not.toContain(SECRET_TEXT);
  }, 120_000);

  /**
   * 一個框都沒抽到時，樣式精修連呼叫都不該發生（那一趟必然是白花的），也不該留下
   * `boxCount: 0` 的降級紀錄——那一次根本沒有產出文字層。
   */
  it("零個框：422 OCR_NO_TEXT，文字模型一次都沒被呼叫，也沒有降級紀錄", async () => {
    const context = await setup(instantOcr(NO_BOX).adapter);
    const warnings = captureWarnings();
    let calls = 0;
    stubResolveText(
      () =>
        ({
          id: "stub-text",
          // 不可用＋零框：舊寫法會在這裡先記一筆 `boxCount: 0` 的降級，再回 422。
          availability: { status: "unavailable", reason: "找不到 codex CLI" },
          runStructured: async () => {
            calls += 1;
            return { value: { boxes: [] } };
          },
        }) as unknown as StructuredTextProvider,
    );
    const response = await context.extract();
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("OCR_NO_TEXT");
    expect(calls).toBe(0);
    expect(
      warnings.entries().filter((item) => String(item.event).startsWith("ocr_style_refine_")),
    ).toEqual([]);
  }, 120_000);

  /*
   * log 紀律：這兩個 case 的例外**本身**就夾帶正文，所以「把整個 error 丟給 logWarn」的
   * 寫法會直接轉紅——這正是要釘住的東西。用不含正文的錯誤訊息去測等於什麼都沒測。
   */
  it("gateway 把 request body 回聲進錯誤訊息時，prompt 與正文都不得進 log", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    const warnings = captureWarnings();
    stubResolveText(
      () =>
        ({
          id: "stub-text",
          availability: { status: "available" },
          // 非嚴格 gateway 的實際行為：400 的 message 原樣附上收到的 request body。
          runStructured: async (request: StructuredTextRequest) => {
            throw new Error(`HTTP 400 from gateway: ${request.prompt}`);
          },
        }) as unknown as StructuredTextProvider,
    );
    expect((await context.extract()).status).toBe(202);
    const serialized = JSON.stringify(warnings.lines());
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(serialized).not.toContain("OCR_BOXES_JSON");
    // 仍要留得下可判讀的原因（只是不含內容）。
    expect(
      warnings.entries().find((item) => item.event === "ocr_style_refine_failed"),
    ).toMatchObject({ reason: "STYLE_REFINE_FAILED", errorName: "Error" });
  }, 120_000);

  it("zod issue 夾帶「實際收到的值」時，那個值也不得進 log", async () => {
    const context = await setup(instantOcr(ONE_BOX).adapter);
    const warnings = captureWarnings();
    stubResolveText(
      () =>
        ({
          id: "stub-text",
          availability: { status: "available" },
          // `role` 是 enum：`invalid_enum_value` 的 issue 會把收到的值寫進 ZodError.message。
          // 模型把 OCR 正文回填到欄位裡並不罕見，這裡直接模擬那個形狀。
          runStructured: async (request: StructuredTextRequest) => ({
            value: {
              boxes: promptBoxIds(request.prompt).map((id) => ({
                id,
                role: SECRET_TEXT,
                fontFamily: "Arial",
                fontWeight: 400,
                color: "#ffffff",
                align: "left",
              })),
            },
          }),
        }) as unknown as StructuredTextProvider,
    );
    expect((await context.extract()).status).toBe(202);
    expect(JSON.stringify(warnings.lines())).not.toContain(SECRET_TEXT);
    // zod 的欄位**路徑**（不含值）留得下來，診斷才有東西可看。
    const entry = warnings.entries().find((item) => item.event === "ocr_style_refine_failed");
    expect(entry?.errorName).toBe("ZodError");
    expect(entry?.zodPaths).toEqual(["boxes.0.role"]);
  }, 120_000);
});

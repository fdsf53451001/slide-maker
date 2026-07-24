import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  GeneratedImage,
  ImageGenerationContext,
  ImageGenerationRequest,
  ImageProvider,
  ProviderPreflightResult,
} from "@slide-maker/core";
import { DEFAULT_SIGKILL_GRACE_MS, runReapableChild } from "./subprocess.js";

/** Telea inpaint 在 1920×1080 上實測數秒內完成；上限給足餘裕仍遠短於生圖模型。 */
const RUN_TIMEOUT_MS = 120_000;

/**
 * 本地 OpenCV 抹字 inpaint provider（`scripts/local_inpaint.py`）。
 *
 * 只服務 extract-text 的遮罩去字：`generate()` 僅受理帶 `edit`＋`maskImageIndex`
 * 的請求，從 references 取 base 與遮罩路徑，spawn `.venv-ocr` 的 python（cv2／numpy
 * 已隨 paddleocr 存在，零新依賴）。不能整頁生成（`fullSlideGeneration: false`）。
 * 補充的風格／內容參考圖對抹字沒有意義，收到會直接忽略；capability 仍宣告支援，
 * 否則帶風格參考圖的專案會在 jobs 的 gate 被 `STYLE_REFERENCES_UNSUPPORTED` 擋下，
 * 完全無法抽字。
 */
export class LocalInpaintProvider implements ImageProvider {
  readonly id: string;
  readonly name = "OpenCV 抹字修補（本機）";
  readonly availability = { status: "available" as const };
  readonly capabilities = {
    fullSlideGeneration: false,
    referenceImages: true,
    imageEditing: true,
    maskedEditing: true,
    multipleReferenceImages: true,
    supportedSizes: [{ width: 1920, height: 1080 }],
    reproducibleParameters: [],
  };
  readonly #python: string;
  readonly #script: string;
  readonly #sigkillGraceMs: number;

  constructor(options: { id?: string; root?: string; sigkillGraceMs?: number } = {}) {
    this.id = options.id ?? "local-inpaint";
    const root = options.root ?? resolve(process.cwd());
    this.#python =
      process.env.SLIDE_MAKER_INPAINT_PYTHON ?? join(root, ".venv-ocr", "bin", "python");
    this.#script =
      process.env.SLIDE_MAKER_INPAINT_SCRIPT ?? join(root, "scripts", "local_inpaint.py");
    this.#sigkillGraceMs = options.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;
  }

  /** 非生成 readiness：只檢查 venv python 與腳本存在，不打外部網路。 */
  async preflight(): Promise<ProviderPreflightResult> {
    try {
      await Promise.all([access(this.#python), access(this.#script)]);
      return { status: "ready" };
    } catch {
      // 與 OCR 同一個 venv：未安裝時請使用者跑 pnpm setup:ocr（extract-text 入口
      // 的 OCR 檢查會給出這句話；這裡回 disabled 讓 readiness gate 擋下生成）。
      return { status: "disabled" };
    }
  }

  async generate(
    request: ImageGenerationRequest,
    context?: ImageGenerationContext,
  ): Promise<GeneratedImage> {
    if (context?.signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
    const edit = request.edit;
    if (!edit || edit.maskImageIndex === undefined)
      throw new Error(
        "LOCAL_INPAINT_REQUIRES_MASKED_EDIT: local-inpaint 只支援遮罩去字（extract-text），不支援整頁生成或無遮罩編輯。",
      );
    const base = request.references[edit.baseImageIndex];
    const mask = request.references[edit.maskImageIndex];
    if (!base || !mask) throw new Error("LOCAL_INPAINT_REFERENCES_MISSING");
    const workDir = await mkdtemp(join(tmpdir(), "slide-maker-local-inpaint-"));
    const outputPath = join(workDir, `${randomUUID()}.png`);
    try {
      const result = await this.#run([this.#script, base.path, mask.path, outputPath], context);
      if (result.code !== 0)
        throw new Error(
          `LOCAL_INPAINT_FAILED:${result.stderr.trim().slice(0, 500) || `exit code ${result.code}`}`,
        );
      const bytes = new Uint8Array(await readFile(outputPath));
      return {
        bytes,
        mediaType: "image/png",
        extension: "png",
        model: "opencv-inpaint-telea-v2",
        parameters: { ...request.parameters, engine: "opencv-inpaint-telea-v2" },
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // 收屍狀態機（含 SIGTERM→SIGKILL 升級）抽到 `subprocess.ts` 共用；這裡只組合參數。
  #run(argv: string[], context?: ImageGenerationContext) {
    return runReapableChild({
      command: this.#python,
      args: argv,
      spawnOptions: { stdio: ["ignore", "ignore", "pipe"] },
      timeoutMs: RUN_TIMEOUT_MS,
      sigkillGraceMs: this.#sigkillGraceMs,
      ...(context?.signal ? { signal: context.signal } : {}),
      onTimeout: () =>
        new Error(`LOCAL_INPAINT_TIMEOUT: OpenCV 抹字未在 ${RUN_TIMEOUT_MS}ms 內完成，已中止。`),
      onAbort: () => new DOMException("Generation cancelled", "AbortError"),
    });
  }
}

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logError } from "@slide-maker/core";
import { z } from "zod";
import { DEFAULT_SIGKILL_GRACE_MS, runReapableChild } from "./subprocess.js";

/** 單次 OCR 子程序的預設上限；含模型載入與下載，故給到 5 分鐘。 */
const DEFAULT_OCR_TIMEOUT_MS = 5 * 60_000;

const pointSchema = z.tuple([z.number(), z.number()]);
/**
 * 直書（縱向排列的 CJK 文字）的逐字框，來自 PaddleOCR `return_word_box=True`。
 *
 * 只有 `text-layers.ts` 判定這一框是直書時才用得到（見 `isVerticalRun()`）；橫排文字
 * 一律忽略這批資料——PaddleOCR 的逐字框只是把偵測框寬度均分給每個字，沒有真正量測
 * 字墨，精度遠不如既有 `measureInk`／`solveBoxGeometry` 那套，用在橫排上是倒退。
 */
const rawWordSchema = z.object({
  text: z.string(),
  /** `[x0, y0, x1, y1]`，與 `polygon` 同一份原始（未縮放）OCR 影像座標系。 */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
const rawBoxSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  polygon: z.array(pointSchema).min(4),
  words: z.array(rawWordSchema).min(2).optional(),
});
const outputSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  boxes: z.array(rawBoxSchema),
});

export type RawOcrResult = z.infer<typeof outputSchema>;

export interface OcrAdapter {
  status(): Promise<{ available: boolean; message: string }>;
  recognize(imagePath: string): Promise<RawOcrResult>;
}

export interface PaddleOcrOptions {
  modelTier?: string;
  detSideLen?: number;
  /** OCR 子程序上限，預設 DEFAULT_OCR_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** SIGTERM 後的 SIGKILL 寬限期，預設 DEFAULT_SIGKILL_GRACE_MS。 */
  sigkillGraceMs?: number;
}

export class PaddleOcrAdapter implements OcrAdapter {
  readonly #root: string;
  readonly #python: string;
  readonly #script: string;
  readonly #env: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #sigkillGraceMs: number;

  constructor(root = resolve(process.cwd()), options: PaddleOcrOptions = {}) {
    this.#root = root;
    this.#python = process.env.SLIDE_MAKER_OCR_PYTHON ?? join(root, ".venv-ocr", "bin", "python");
    this.#script = process.env.SLIDE_MAKER_OCR_SCRIPT ?? join(root, "scripts", "paddle_ocr.py");
    this.#env = {
      ...(options.modelTier ? { SLIDE_MAKER_OCR_MODEL_TIER: options.modelTier } : {}),
      ...(options.detSideLen ? { SLIDE_MAKER_OCR_DET_SIDE_LEN: String(options.detSideLen) } : {}),
    };
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
    this.#sigkillGraceMs = options.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;
  }

  async status(): Promise<{ available: boolean; message: string }> {
    try {
      await Promise.all([
        access(this.#python),
        access(this.#script),
        access(join(this.#root, ".venv-ocr", ".ready")),
      ]);
      return { available: true, message: "PaddleOCR CPU 已就緒" };
    } catch {
      return { available: false, message: "尚未安裝 OCR，請在專案根目錄執行 pnpm setup:ocr" };
    }
  }

  async recognize(imagePath: string): Promise<RawOcrResult> {
    const result = await this.run([this.#script, imagePath]);
    if (result.code !== 0)
      throw new Error(
        `OCR_FAILED:${result.stderr.trim().slice(0, 500) || "unknown error"}（若為模型載入或下載失敗，請重新執行 pnpm setup:ocr）`,
      );
    try {
      return outputSchema.parse(JSON.parse(result.stdout));
    } catch (error) {
      // stdout 合約是「單行機器 JSON」；違反時保持嚴格丟錯（合約修正在 python 端），
      // 但先記下實際輸出內容，否則像 oneDNN 對 fd 1 printf 這種污染只會看到解析失敗。
      logError(
        "ocr_output_invalid",
        {
          stdoutPreview: result.stdout.slice(0, 500),
          stderrPreview: result.stderr.slice(0, 500),
        },
        error,
      );
      throw new Error("OCR_OUTPUT_INVALID");
    }
  }

  // 收屍狀態機（逾時 reject＋SIGTERM→SIGKILL 升級）抽到 `subprocess.ts` 共用。
  // 舊版逾時只送 SIGTERM、不 reject、也無 SIGKILL 升級：子程序不 close 時 recognize()
  // 會永久 await，卡死整個 extract-text 請求。
  private run(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return runReapableChild({
      command: this.#python,
      args: argv,
      spawnOptions: {
        cwd: this.#root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...this.#env },
      },
      timeoutMs: this.#timeoutMs,
      sigkillGraceMs: this.#sigkillGraceMs,
      onTimeout: () =>
        new Error(
          `OCR_TIMEOUT: OCR 未在 ${this.#timeoutMs}ms 內完成，已中止（若為模型載入或下載失敗，請重新執行 pnpm setup:ocr）。`,
        ),
    });
  }
}

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logError } from "@slide-maker/core";
import { z } from "zod";

const pointSchema = z.tuple([z.number(), z.number()]);
const rawBoxSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  polygon: z.array(pointSchema).min(4),
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
}

export class PaddleOcrAdapter implements OcrAdapter {
  readonly #root: string;
  readonly #python: string;
  readonly #script: string;
  readonly #env: Record<string, string>;

  constructor(root = resolve(process.cwd()), options: PaddleOcrOptions = {}) {
    this.#root = root;
    this.#python = process.env.SLIDE_MAKER_OCR_PYTHON ?? join(root, ".venv-ocr", "bin", "python");
    this.#script = process.env.SLIDE_MAKER_OCR_SCRIPT ?? join(root, "scripts", "paddle_ocr.py");
    this.#env = {
      ...(options.modelTier ? { SLIDE_MAKER_OCR_MODEL_TIER: options.modelTier } : {}),
      ...(options.detSideLen ? { SLIDE_MAKER_OCR_DET_SIDE_LEN: String(options.detSideLen) } : {}),
    };
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
    const result = await this.run([this.#script, imagePath], 5 * 60_000);
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

  private run(
    argv: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.#python, argv, {
        cwd: this.#root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...this.#env },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({ code, stdout, stderr });
        }
      });
    });
  }
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawOcrResult } from "../src/ocr.js";

/**
 * `scripts/paddle_ocr.py` 的 `return_word_box=True` 改動：真的跑一次 PaddleOCR
 * （需要 pnpm setup:ocr 裝好的 .venv-ocr，未安裝時整組跳過，同 `local-inpaint-pixels.test.ts`
 * 的慣例），釘住兩件事：
 *
 *   1. 直書（縱向排列 CJK）的偵測框會帶回 `words`——這批資料是 PaddleOCR 自己算好的，
 *      我們只是多要求它輸出（見 `paddle_ocr.py` 的長註解）；
 *   2. 一般橫排文字的既有欄位（`text`／`confidence`／`polygon`）完全不受影響——
 *      開這個參數不能是一次隱性的行為改變。
 *
 * 這裡不驗證 TypeScript 端怎麼把 `words`組回 `EditableTextBox`（那是
 * `ocr-vertical-text.test.ts` 用手造資料釘住的，跑得快、不需要真模型）；這裡只驗證
 * Python 腳本真的把 PaddleOCR 已經算好的東西吐出來了。
 */
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PYTHON = join(ROOT, ".venv-ocr", "bin", "python");
const SCRIPT = join(ROOT, "scripts", "paddle_ocr.py");
const HAS_OCR_VENV = existsSync(PYTHON) && existsSync(SCRIPT);

function run(imagePath: string): Promise<RawOcrResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(PYTHON, [SCRIPT, imagePath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`paddle_ocr.py exited ${code}: ${stderr}`));
      try {
        resolvePromise(JSON.parse(stdout.trim()) as RawOcrResult);
      } catch (error) {
        reject(new Error(`paddle_ocr.py stdout not JSON: ${stdout.slice(0, 200)}: ${String(error)}`));
      }
    });
  });
}

describe.skipIf(!HAS_OCR_VENV)("paddle_ocr.py：return_word_box", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "slide-maker-word-box-"));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "直書標籤的偵測框帶回逐字的 words",
    { timeout: 60_000 },
    async () => {
      // 一個字一行、由上往下——與實機根因案例（「活動核心」）同一種版面。
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">
        <rect width="400" height="500" fill="#1e3a8a"/>
        <text x="200" y="100" font-family="PingFang TC, Helvetica" font-size="60" fill="#ffffff" text-anchor="middle">活</text>
        <text x="200" y="180" font-family="PingFang TC, Helvetica" font-size="60" fill="#ffffff" text-anchor="middle">動</text>
        <text x="200" y="260" font-family="PingFang TC, Helvetica" font-size="60" fill="#ffffff" text-anchor="middle">核</text>
        <text x="200" y="340" font-family="PingFang TC, Helvetica" font-size="60" fill="#ffffff" text-anchor="middle">心</text>
      </svg>`;
      const imagePath = join(dir, "vertical.png");
      await writeFile(imagePath, await sharp(Buffer.from(svg)).png().toBuffer());

      const result = await run(imagePath);
      const box = result.boxes.find((candidate) => candidate.text.includes("活"));
      expect(box, `没找到「活」所在的框，實際辨識結果：${JSON.stringify(result.boxes.map((b) => b.text))}`).toBeDefined();
      expect(box!.words).toBeDefined();
      expect(box!.words!.map((word) => word.text).join("")).toBe(box!.text);
      expect(box!.words!.length).toBeGreaterThanOrEqual(2);
      // 逐字框由上往下依序排列，且共用同一段 x 範圍（同一欄）。
      const ys = box!.words!.map((word) => word.box[1]);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
      const xs = box!.words!.map((word) => word.box[0]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(20);
    },
  );

  it(
    "一般橫排文字的既有欄位不受影響",
    { timeout: 60_000 },
    async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
        <rect width="800" height="200" fill="#ffffff"/>
        <text x="40" y="120" font-family="PingFang TC, Helvetica" font-size="60" fill="#111111">打造未來</text>
      </svg>`;
      const imagePath = join(dir, "horizontal.png");
      await writeFile(imagePath, await sharp(Buffer.from(svg)).png().toBuffer());

      const result = await run(imagePath);
      expect(result.width).toBe(800);
      expect(result.height).toBe(200);
      const box = result.boxes.find((candidate) => candidate.text.includes("打造"));
      expect(box).toBeDefined();
      expect(box!.text).toContain("打造未來");
      expect(box!.confidence).toBeGreaterThan(0.5);
      expect(box!.polygon.length).toBeGreaterThanOrEqual(4);
    },
  );
});

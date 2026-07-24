import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 抹字演算法的像素級回歸：跑真正的 `scripts/local_inpaint.py`（需要 pnpm setup:ocr
 * 裝好的 .venv-ocr，未安裝時整組跳過，維持 pnpm check 可在乾淨環境執行）。
 *
 * 這裡釘住三件舊版做不到、且正是「圖表線被抹糊」根因的行為：
 *   1. 遮罩外的像素一個都不能動（舊版膨脹 7×7 兩次會外擴 6px 咬掉框外線段）；
 *   2. 穿過遮罩的線／色塊要原樣保留（背景由框外顏色蔓延定義，不是灰階門檻）；
 *   3. 被文字蓋住的線要接回來（軸向橋接），而不是留下缺口。
 */
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PYTHON = join(ROOT, ".venv-ocr", "bin", "python");
const SCRIPT = join(ROOT, "scripts", "local_inpaint.py");
const HAS_OCR_VENV = existsSync(PYTHON) && existsSync(SCRIPT);

const WIDTH = 240;
const HEIGHT = 120;
const BACKGROUND = { r: 255, g: 255, b: 255 };
const LINE = { r: 37, g: 99, b: 235 };
const LINE_TOP = 60;
const LINE_HEIGHT = 2;
/** 遮罩矩形：上下都切過藍線所在的列，左右也伸出「文字」之外。 */
const MASK = { x: 70, y: 30, width: 100, height: 60 };

interface Pixels {
  data: Buffer;
  channels: number;
}

function at(pixels: Pixels, x: number, y: number): { r: number; g: number; b: number } {
  const offset = (y * WIDTH + x) * pixels.channels;
  return {
    r: pixels.data[offset]!,
    g: pixels.data[offset + 1]!,
    b: pixels.data[offset + 2]!,
  };
}

function distance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** 白底 + 橫貫的藍線 + 若干黑色方塊（模擬字墨）。 */
async function baseImage(blocks: readonly { x: number; y: number; w: number; h: number }[]) {
  const rects = blocks
    .map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#000000"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
    <rect x="0" y="${LINE_TOP}" width="${WIDTH}" height="${LINE_HEIGHT}" fill="#2563eb"/>
    ${rects}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function maskImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect x="${MASK.x}" y="${MASK.y}" width="${MASK.width}" height="${MASK.height}" fill="#ffffff"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function readPixels(path: string): Promise<Pixels> {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels };
}

function runScript(base: string, mask: string, out: string): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(PYTHON, [SCRIPT, base, mask, out], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`local_inpaint.py exited ${code}: ${stderr}`));
      else resolvePromise(code);
    });
  });
}

describe.skipIf(!HAS_OCR_VENV)("local_inpaint.py 抹字精準度", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "slide-maker-inpaint-pixels-"));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function erase(
    name: string,
    blocks: readonly { x: number; y: number; w: number; h: number }[],
  ) {
    const basePath = join(dir, `${name}.base.png`);
    const maskPath = join(dir, `${name}.mask.png`);
    const outPath = join(dir, `${name}.out.png`);
    await writeFile(basePath, await baseImage(blocks));
    await writeFile(maskPath, await maskImage());
    await runScript(basePath, maskPath, outPath);
    return { before: await readPixels(basePath), after: await readPixels(outPath) };
  }

  it("遮罩外的像素完全不被改動", async () => {
    // 方塊貼著藍線上下，舊版的 6px 外擴會從遮罩左右邊界咬進框外的線。
    const { before, after } = await erase("outside", [
      { x: 80, y: 40, w: 40, h: 18 },
      { x: 120, y: 64, w: 40, h: 18 },
    ]);
    const changed: string[] = [];
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const inside =
          x >= MASK.x && x < MASK.x + MASK.width && y >= MASK.y && y < MASK.y + MASK.height;
        if (inside) continue;
        if (distance(at(before, x, y), at(after, x, y)) > 0) changed.push(`${x},${y}`);
      }
    }
    expect(changed.slice(0, 10)).toEqual([]);
  });

  it("穿過遮罩的線原樣保留，字墨被抹成背景", async () => {
    const { after } = await erase("keep-line", [
      { x: 80, y: 40, w: 40, h: 18 },
      { x: 120, y: 64, w: 40, h: 18 },
    ]);
    for (let x = MASK.x; x < MASK.x + MASK.width; x += 1) {
      expect(distance(at(after, x, LINE_TOP), LINE)).toBeLessThan(24);
    }
    // 字墨原位置回到白底（取方塊中心，避開與線相接的邊緣）。
    expect(distance(at(after, 100, 48), BACKGROUND)).toBeLessThan(16);
    expect(distance(at(after, 140, 74), BACKGROUND)).toBeLessThan(16);
  });

  it("被文字蓋住的線會被接回，而不是留下缺口", async () => {
    // 方塊完整覆蓋藍線的 x=100..139 一段：輸入影像裡那段線根本不存在。
    const { after } = await erase("bridge", [{ x: 100, y: 50, w: 40, h: 24 }]);
    for (let x = 100; x < 140; x += 1) {
      expect(distance(at(after, x, LINE_TOP), LINE)).toBeLessThan(24);
    }
    expect(distance(at(after, 120, 44), BACKGROUND)).toBeLessThan(16);
    expect(distance(at(after, 120, 80), BACKGROUND)).toBeLessThan(16);
  });
});

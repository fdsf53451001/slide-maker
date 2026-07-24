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

const WIDTH = 480;
const HEIGHT = 120;
const BACKGROUND = { r: 255, g: 255, b: 255 };
const LINE = { r: 37, g: 99, b: 235 };
const LINE_TOP = 60;
const LINE_HEIGHT = 2;
const VERTICAL_LINE_LEFT = 120;
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

interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
}

/** 白底 + 橫貫的藍線 + 若干色塊（模擬字墨）。`blur` 模擬重新編碼過的柔邊文字。 */
async function baseImage(blocks: readonly Block[], options: { blur?: number } = {}) {
  const rects = blocks
    .map(
      (b) =>
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${b.fill ?? "#000000"}"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
    <rect x="0" y="${LINE_TOP}" width="${WIDTH}" height="${LINE_HEIGHT}" fill="#2563eb"/>
    ${rects}
  </svg>`;
  const image = sharp(Buffer.from(svg));
  return (options.blur ? image.blur(options.blur) : image).png().toBuffer();
}

/** 白底 + 一條垂直藍線（測橋接的另一軸）。 */
async function verticalBase(blocks: readonly Block[]) {
  const rects = blocks
    .map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#000000"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
    <rect x="${VERTICAL_LINE_LEFT}" y="0" width="${LINE_HEIGHT}" height="${HEIGHT}" fill="#2563eb"/>
    ${rects}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function maskImage(rect: { x: number; y: number; width: number; height: number } = MASK) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="#ffffff"/>
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
    blocks: readonly Block[],
    options: { blur?: number; vertical?: boolean; mask?: typeof MASK } = {},
  ) {
    const basePath = join(dir, `${name}.base.png`);
    const maskPath = join(dir, `${name}.mask.png`);
    const outPath = join(dir, `${name}.out.png`);
    await writeFile(
      basePath,
      options.vertical ? await verticalBase(blocks) : await baseImage(blocks, options),
    );
    await writeFile(maskPath, await maskImage(options.mask));
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
    // 上方方塊底邊壓在線上（y 58..75 蓋過 y 60..61），確保線所在的列真的落在字墨
    // 判定範圍內——否則這個案例只驗到膨脹沒有外擴，等於沒測到結構保留。
    const { after } = await erase("keep-line", [
      { x: 80, y: 40, w: 30, h: 18 },
      { x: 120, y: 58, w: 30, h: 18 },
    ]);
    for (let x = MASK.x; x < MASK.x + MASK.width; x += 1) {
      expect(distance(at(after, x, LINE_TOP), LINE)).toBeLessThan(24);
    }
    // 字墨原位置回到白底（取方塊中心，避開與線相接的邊緣）。
    expect(distance(at(after, 95, 48), BACKGROUND)).toBeLessThan(16);
    expect(distance(at(after, 135, 70), BACKGROUND)).toBeLessThan(16);
  });

  it("被文字蓋住的線會被接回，而不是留下缺口", async () => {
    // 方塊完整覆蓋藍線的 x=100..139 一段：輸入影像裡那段線根本不存在。
    const { after } = await erase("bridge", [{ x: 100, y: 50, w: 40, h: 24 }]);
    for (let x = 100; x < 140; x += 1) {
      expect(distance(at(after, x, LINE_TOP), LINE)).toBeLessThan(8);
    }
    expect(distance(at(after, 120, 44), BACKGROUND)).toBeLessThan(16);
    expect(distance(at(after, 120, 80), BACKGROUND)).toBeLessThan(16);
  });

  it("被文字蓋住的『垂直』線同樣接回（橋接不可固定偏好水平軸）", async () => {
    // 兩軸都能橋接：水平方向兩端是白底、垂直方向兩端是藍線，兩者色差都是 0。
    // 若 tie-break 固定給水平，這條線會被整段塗成白底。
    const { after } = await erase("bridge-vertical", [{ x: 100, y: 45, w: 44, h: 30 }], {
      vertical: true,
    });
    for (let y = 45; y < 75; y += 1) {
      expect(distance(at(after, VERTICAL_LINE_LEFT, y), LINE)).toBeLessThan(8);
    }
    expect(distance(at(after, 105, 60), BACKGROUND)).toBeLessThan(16);
  });

  it("柔邊低對比文字仍被抹掉，不留輪廓殘影", async () => {
    // 重新編碼／縮放過的投影片，字緣 ramp 每像素只差幾級，flood 容差擋不住；
    // 背景還必須「顏色出現在框外樣本裡」這道才攔得下來。
    const { before, after } = await erase(
      "soft-edge",
      [{ x: 85, y: 40, w: 70, h: 30, fill: "#b9b9b9" }],
      { blur: 1.6 },
    );
    let ghosts = 0;
    for (let y = MASK.y; y < MASK.y + MASK.height; y += 1) {
      for (let x = MASK.x; x < MASK.x + MASK.width; x += 1) {
        if (y >= LINE_TOP - 2 && y <= LINE_TOP + LINE_HEIGHT + 1) continue; // 線本來就該留著
        const wasInk = distance(at(before, x, y), BACKGROUND) > 20;
        if (wasInk && distance(at(after, x, y), BACKGROUND) > 20) ghosts += 1;
      }
    }
    expect(ghosts).toBe(0);
  });

  it("遮罩切在筆劃中間時，框內那半不會被當成背景留下來", async () => {
    // 一整條連通的墨（模擬底線相連的文字）從遮罩右緣露出 2px：字會沿著自己
    // 蔓延成「背景」而完全不被抹掉，除非另外檢查團塊有沒有貫穿到框外。
    // 刻意讓它不碰到藍線——墨若與貫穿結構相連就分不開了，那是已知限制，
    // 不是這條測試要釘的行為。
    const mask = { x: 60, y: 20, width: 100, height: 34 };
    const { before, after } = await erase(
      "boundary-leak",
      [
        { x: 70, y: 26, w: 92, h: 6 },
        { x: 70, y: 26, w: 6, h: 22 },
        { x: 100, y: 26, w: 6, h: 22 },
        { x: 130, y: 26, w: 6, h: 22 },
      ],
      { mask },
    );
    // 排除緊貼遮罩邊界的 6px：墨跨出遮罩時框外那半依不變量①不能動，內側這幾個
    // 像素抹掉只會留下一道銳利切口，留著反而自然。整條墨沒被抹的回歸是數百 px 級，
    // 這個排除範圍擋不住它。
    const skin = 6;
    let ghosts = 0;
    for (let y = mask.y; y < mask.y + mask.height; y += 1) {
      for (let x = mask.x; x < mask.x + mask.width - skin; x += 1) {
        if (y >= LINE_TOP - 2 && y <= LINE_TOP + LINE_HEIGHT + 1) continue;
        const wasInk = distance(at(before, x, y), BACKGROUND) > 20;
        if (wasInk && distance(at(after, x, y), BACKGROUND) > 20) ghosts += 1;
      }
    }
    expect(ghosts).toBe(0);
  });

  it("鄰接的抹除帶不會讓另一軸把線整條塗掉", async () => {
    // 第二塊落在第一塊右探針（4px）的範圍內 → 水平軸整條 run 都無法取樣。剩下的
    // 垂直軸兩端都是白底，若讓它無條件覆蓋，就會把藍線塗成一條白帶。
    const mask = { x: 40, y: 40, width: 190, height: 40 };
    const { after } = await erase(
      "probe-contamination",
      [
        { x: 60, y: 50, w: 120, h: 20 },
        { x: 185, y: 50, w: 30, h: 20 },
      ],
      { mask },
    );
    for (let x = 60; x < 180; x += 1) {
      expect(distance(at(after, x, LINE_TOP), LINE)).toBeLessThan(24);
    }
  });

  it("超過 BRIDGE_MAX_GAP 的抹除帶仍接得回線（寬帶只需自證承載結構）", async () => {
    // 整行標題壓在表格線上時抹除帶輕易超過上限；硬拒會讓那條線永遠接不回來。
    // 遮罩左右各留 20px，讓藍線在框外仍有本體（全寬遮罩會落入「結構完全被遮罩
    // 包住」的已知限制，測到的就不是寬帶了）。
    const wide = { x: 20, y: 40, width: WIDTH - 40, height: 40 };
    const block = { x: 30, y: 50, w: WIDTH - 60, h: 20 };
    expect(block.w + 2).toBeGreaterThan(420); // 膨脹後的抹除帶確實超過上限
    const { after } = await erase("wide-span", [block], { mask: wide });
    for (let x = block.x; x < block.x + block.w; x += 1) {
      expect(distance(at(after, x, LINE_TOP), LINE)).toBeLessThan(24);
    }
  });

  it("顆粒背景不會被整片當成字墨抹平", async () => {
    // 固定容差對照片／顆粒背景蔓延不進去，整塊乾淨背景會被判成墨再填平。
    const basePath = join(dir, "grain.base.png");
    const maskPath = join(dir, "grain.mask.png");
    const outPath = join(dir, "grain.out.png");
    const noise = Buffer.alloc(WIDTH * HEIGHT * 3);
    let seed = 12345;
    for (let i = 0; i < noise.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff; // 可重現的偽亂數
      noise[i] = 120 + (((seed >> 16) % 21) - 10); // ±10：照片級顆粒，固定容差 6 蔓延不過去
    }
    const grain = await sharp(noise, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
      .png()
      .toBuffer();
    const before = await sharp(grain).raw().toBuffer({ resolveWithObject: true });
    await writeFile(
      basePath,
      await sharp(grain)
        .composite([
          {
            input: Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
                <rect x="90" y="45" width="60" height="30" fill="#ffffff"/>
              </svg>`,
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer(),
    );
    await writeFile(maskPath, await maskImage());
    await runScript(basePath, maskPath, outPath);
    const after = await readPixels(outPath);
    const original: Pixels = { data: before.data, channels: before.info.channels };
    // 遮罩內、離「文字」至少 5px 的顆粒背景應該原封不動（容 JPEG 級的微小誤差）。
    let damaged = 0;
    for (let y = MASK.y; y < MASK.y + MASK.height; y += 1) {
      for (let x = MASK.x; x < MASK.x + MASK.width; x += 1) {
        if (x >= 85 && x <= 155 && y >= 40 && y <= 80) continue;
        if (distance(at(original, x, y), at(after, x, y)) > 24) damaged += 1;
      }
    }
    expect(damaged).toBe(0);
  });

  it("遮罩蓋滿整張圖時明確失敗，而不是靜默回傳原圖", async () => {
    // 沒有框外樣本就無從判斷背景；若照樣 exit 0，呼叫端會把「還有字的原圖」
    // 當成去字背景存起來，編輯器再把文字層疊上去 → 使用者看到雙重文字。
    const basePath = join(dir, "full.base.png");
    const maskPath = join(dir, "full.mask.png");
    await writeFile(basePath, await baseImage([{ x: 80, y: 40, w: 40, h: 18 }]));
    await writeFile(maskPath, await maskImage({ x: 0, y: 0, width: WIDTH, height: HEIGHT }));
    await expect(runScript(basePath, maskPath, join(dir, "full.out.png"))).rejects.toThrow(
      /no background to sample/,
    );
  });
});

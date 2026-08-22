import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  compressTextRuns,
  createProject,
  resolveTextRuns,
  type EditableTextBox,
} from "@slide-maker/core";
import { exportPresentation } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";
import { measureRunColors } from "../src/text-run-colors.js";
import { textElements, textOverlaySvg } from "../src/text-layers.js";

/**
 * 框內多色的兩件事：從原圖**量**出每一段的顏色，以及把量到的顏色畫回去。
 *
 * 這一組不打任何模型：輸入是自己畫的圖（ground truth 精確），驗的是量測與渲染。
 * 模型那一半由 `text-run-align.test.ts`（容錯對齊）與端點測試負責。
 */

const CANVAS = { width: 900, height: 200 };

/** 畫一行字，每段指定顏色；回傳 raw RGB 供 `measureRunColors` 使用。 */
async function renderLine(
  segments: readonly { text: string; color: string }[],
  options: { background?: string; fontSize?: number } = {},
) {
  const fontSize = options.fontSize ?? 64;
  const tspans = segments
    .map((segment) => `<tspan fill="${segment.color}" xml:space="preserve">${segment.text}</tspan>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}"><rect width="${CANVAS.width}" height="${CANVAS.height}" fill="${options.background ?? "#ffffff"}"/><text x="40" y="120" font-family="Arial, Helvetica" font-size="${fontSize}">${tspans}</text></svg>`;
  const png = new Resvg(svg).render().asPng();
  const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(raw.data),
    width: raw.info.width,
    height: raw.info.height,
    channels: raw.info.channels,
  };
}

/** 覆蓋整行文字的取樣框（比字墨大一圈，四邊才取得到背景色）。 */
const LINE_BOX = { x: 20, y: 40, width: 860, height: 110, fontSize: 64 };

function near(actual: string, expected: string, tolerance = 12): void {
  const parse = (value: string) => {
    const n = Number.parseInt(value.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [ar, ag, ab] = parse(actual);
  const [er, eg, eb] = parse(expected);
  const distance = Math.hypot(ar! - er!, ag! - eg!, ab! - eb!);
  expect(
    distance,
    `顏色 ${actual} 與預期的 ${expected} 差太多（RGB 距離 ${distance.toFixed(1)}）`,
  ).toBeLessThan(tolerance);
}

describe("measureRunColors：顏色從原圖量，不信模型", () => {
  it("量出每一段的實際顏色，而不是沿用模型猜的色票", async () => {
    const image = await renderLine([
      { text: "打造 ", color: "#111111" },
      { text: "AI Agent", color: "#ff6b35" },
      { text: " 的未來", color: "#111111" },
    ]);
    // 模型給的顏色刻意全部是「相近但不對」的值——實測模型就是這樣回的
    // （Tailwind 色票：#1d1d1d、#ff6b4a…）。量測必須把它們換掉。
    const measured = measureRunColors(image, LINE_BOX, [
      { text: "打造 ", color: "#1d1d1d" },
      { text: "AI Agent", color: "#ff6b4a" },
      { text: " 的未來", color: "#1d1d1d" },
    ]);
    expect(measured.verdict).toBe("measured");
    expect(measured.runs).toHaveLength(3);
    near(measured.runs[0]!.color, "#111111");
    near(measured.runs[1]!.color, "#ff6b35");
    near(measured.runs[2]!.color, "#111111");
  });

  it("單色框也量：整框一色時顏色同樣以原圖為準", async () => {
    const image = await renderLine([{ text: "整行都是這個顏色", color: "#2563eb" }]);
    const measured = measureRunColors(image, LINE_BOX, [
      { text: "整行都是這個顏色", color: "#1d4ed8" },
    ]);
    expect(measured.verdict).toBe("single");
    expect(measured.runs).toHaveLength(1);
    near(measured.runs[0]!.color, "#2563eb");
  });

  it("深底白字也量得到（背景估計不預設淺色）", async () => {
    const image = await renderLine(
      [
        { text: "All agents ", color: "#ffffff" },
        { text: "passed", color: "#facc15" },
      ],
      { background: "#111827" },
    );
    const measured = measureRunColors(image, LINE_BOX, [
      { text: "All agents ", color: "#f5f5f5" },
      { text: "passed", color: "#ffc83b" },
    ]);
    expect(measured.verdict).toBe("measured");
    near(measured.runs[0]!.color, "#ffffff");
    near(measured.runs[1]!.color, "#facc15");
  });

  it(
    "模型漏判分段時（宣稱整行同色，其實混著兩種顏色）取眾數色，不取對比較強的少數色",
    async () => {
      /*
       * 實機根因（2026-08-22，`d56f8f92` 專案「公開產出提供交流入口，讓專業」這一行）：
       * 這行 10 個黑字＋4 個紫字，模型這次判成整行一段（沒偵測到「交流入口」該是紫色）。
       * 舊版對「宣稱整段同色」照樣套用「相對峰值階梯」，而紫字對白底的 Lab 距離**剛好
       * 比黑字更大**（紫色的 a／b 色度差是黑色沒有的額外貢獻），門檻被紫字定住，佔多數
       * 的黑字反而大多過不了門檻——整行 14 個字因此全部染成紫色，只有中間 4 個字真的是
       * 紫的。純中位數也解不了：黑紫兩群逐軸獨立取中位數會混出第三種、兩邊都不是的顏色。
       * 眾數色（`modeColor`）問的是「哪一種顏色的像素最多」，才會正確落在黑色。
       */
      const image = await renderLine([
        { text: "公開產出提供", color: "#1a1a1a" },
        { text: "交流入口", color: "#5c2096" },
        { text: "，讓專業", color: "#1a1a1a" },
      ]);
      const measured = measureRunColors(image, LINE_BOX, [
        // 模型宣稱整行只有一段——這正是漏判的那次真實輸出的形狀。
        { text: "公開產出提供交流入口，讓專業", color: "#333333" },
      ]);
      expect(measured.verdict).toBe("single");
      expect(measured.runs).toHaveLength(1);
      // 佔多數的黑字才是正確答案；不能是紫色（模型完全沒說錯的那個少數色）。
      near(measured.runs[0]!.color, "#1a1a1a", 15);
    },
  );

  it("模型憑空把單色行切成兩段時，像素量到同色就合併回去", async () => {
    // 這是對抗模型幻覺的防線：實測模型偶爾真的會這樣切。
    const image = await renderLine([{ text: "這一整行只有一個顏色", color: "#111111" }]);
    const measured = measureRunColors(image, LINE_BOX, [
      { text: "這一整行", color: "#111111" },
      { text: "只有一個顏色", color: "#2563eb" },
    ]);
    expect(measured.verdict).toBe("merged");
    expect(measured.runs).toHaveLength(1);
    expect(measured.runs[0]!.text).toBe("這一整行只有一個顏色");
    near(measured.runs[0]!.color, "#111111");
  });

  it("量不到字墨時走確定性退路，而不是沿用模型的顏色", async () => {
    // 模型的顏色每次都會重猜一遍（實測同一個框五次拿到五個不同值），
    // 沿用它就等於「同一頁抽兩次，顏色不一樣」。
    const image = await renderLine([{ text: "", color: "#111111" }], { background: "#0f766e" });
    const first = measureRunColors(image, LINE_BOX, [{ text: "看不見的字", color: "#13979c" }]);
    const second = measureRunColors(image, LINE_BOX, [{ text: "看不見的字", color: "#0b6a61" }]);
    expect(first.verdict).toBe("no-ink");
    // 兩次模型給的顏色不同，量測結果必須相同。
    expect(first.runs[0]!.color).toBe(second.runs[0]!.color);
  });

  it("模型回大寫 hex 時正規化成小寫（否則同一個顏色會被當成兩種）", async () => {
    const image = await renderLine([{ text: "", color: "#111111" }], { background: "#0f766e" });
    const measured = measureRunColors(image, LINE_BOX, [{ text: "看不見的字", color: "#00AABB" }]);
    expect(measured.runs[0]!.color).toBe(measured.runs[0]!.color.toLowerCase());
  });

  it(
    "小字多段時（像程式碼語法高亮）顏色仍要落在真值附近，不能被抗鋸齒邊緣拉向背景",
    async () => {
      /*
       * 實機根因（2026-08-22，`r19` 投影片的 `import { serve } from './server';` 這行，
       * 17px 小字）：舊版 `measureSpan` 用「排名前 60%」取樣——這是**依樣本總數**取窗，
       * 樣本一多，窗口就跟著撐大，深入到幾乎等於背景的抗鋸齒邊緣像素，中位數被拉向
       * 背景。真實資料量出來的 `serve`（真值 `#9ec7ec`）只有 `#7094ba`，用真實 VS Code
       * 色票量的 ΔE 高達 20+。這裡用同樣字級、同樣「短段夾在長段之間」的形狀重現，
       * 只是換一組容易斷言的顏色。
       */
      const image = await renderLine(
        [
          { text: "import", color: "#d4d4d4" },
          { text: " { ", color: "#d4d4d4" },
          { text: "serve", color: "#4fc3f7" },
          { text: " } ", color: "#d4d4d4" },
        ],
        { background: "#0a0e14", fontSize: 17 },
      );
      const measured = measureRunColors(
        image,
        // renderLine() 的文字基準線固定在 y=120，字級 17px 時字墨大約落在 y=100–130；
        // x 從 20 開始（比文字起點 40 早），留出左邊界供背景色取樣。
        { x: 20, y: 95, width: 300, height: 40, fontSize: 17 },
        [
          { text: "import", color: "#c586c0" },
          { text: " { ", color: "#d4d4d4" },
          { text: "serve", color: "#9cdcfe" },
          { text: " } ", color: "#d4d4d4" },
        ],
      );
      const serve = measured.runs.find((run) => run.text.includes("serve"));
      expect(serve).toBeDefined();
      // 容差比大字的測試寬（17px 小字先天有解析度限制，量不到 ΔE 0），
      // 但必須落在「藍」這個顏色家族，不能被拉成大字測試裡那種灰黑色。
      near(serve!.color, "#4fc3f7", 40);
    },
  );

  it("多行框不做逐段定位（x 軸不是單調的），沿用模型的顏色", async () => {
    const image = await renderLine([{ text: "任意", color: "#111111" }]);
    const measured = measureRunColors(image, LINE_BOX, [
      { text: "第一行\n第二行", color: "#123456" },
    ]);
    expect(measured.verdict).toBe("multiline");
    expect(measured.runs[0]!.color).toBe("#123456");
  });
});

function box(overrides: Partial<EditableTextBox> = {}): EditableTextBox {
  return {
    id: "box",
    text: "打造 AI Agent 的未來",
    x: 40,
    y: 40,
    width: 820,
    height: 90,
    fontFamily: "Arial",
    fontSize: 64,
    fontWeight: 400,
    color: "#111111",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 0.99,
    role: "presentation",
    ...overrides,
  };
}

const RUNS = [
  { length: 3, color: "#111111" },
  { length: 8, color: "#ff6b35" },
  { length: 4, color: "#111111" },
];

describe("SVG 合成：框內分段", () => {
  it("單色框的輸出與這個功能加入之前逐字元相同", () => {
    /*
     * GOLDEN 是加入這個功能**之前**的實際輸出。沒有 `runs` 的框必須逐字元走原路徑——
     * 這個專案所有既有的合成圖、PPTX、快照與像素測試都建立在它上面，多一個屬性就是
     * 一次無聲的全面回歸。分段路徑專用的 `xml:space` 與逐段 `fill` 因此不得出現在這裡。
     */
    const GOLDEN =
      '<text x="40" y="100.576" text-anchor="start" font-family="Arial" font-size="64" font-weight="400" fill="#111111" fill-opacity="1" letter-spacing="0"><tspan x="40" dy="0">打造 AI Agent 的未來</tspan></text>';
    expect(textElements([box()])).toBe(GOLDEN);
    // runs 只有一段（例如編輯後被壓成單色）時，走的也必須是同一條路。
    expect(textElements([box({ runs: [{ length: 15, color: "#111111" }] })])).toBe(GOLDEN);
  });

  it("多色框逐段輸出 fill，且保留段邊界的空白", () => {
    const svg = textElements([box({ runs: RUNS })]);
    expect(svg).toContain(`fill="#ff6b35" xml:space="preserve">AI Agent</tspan>`);
    expect(svg).toContain(`xml:space="preserve">打造 </tspan>`);
    expect(svg).toContain(`xml:space="preserve"> 的未來</tspan>`);
  });

  it("多行 × 多色：每一行都是自己的 chunk（帶 x 與 dy），行內再分段", () => {
    const svg = textElements([
      box({
        text: "第一行\n第二行末",
        runs: [
          { length: 6, color: "#111111" },
          { length: 3, color: "#ff0000" },
        ],
      }),
    ]);
    // 第二行的第一段帶 x 與 dy（換行），同行的第二段不帶（自然接續）。
    expect(svg).toContain(`<tspan x="40" dy="76.8" fill="#111111"`);
    expect(svg).toContain(`<tspan fill="#ff0000"`);
  });

  it("渲染出來的像素真的是兩種顏色", async () => {
    const svg = textOverlaySvg([box({ runs: RUNS })], CANVAS.width, CANVAS.height);
    const png = new Resvg(svg.toString("utf8"), {
      background: "#ffffff",
    })
      .render()
      .asPng();
    const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const counts = new Map<string, number>();
    for (let index = 0; index < raw.data.length; index += raw.info.channels) {
      const key = `${raw.data[index]},${raw.data[index + 1]},${raw.data[index + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // 橘色與深色都必須大量存在——只有一種顏色代表分段沒有被畫出來。
    expect(counts.get("255,107,53") ?? 0).toBeGreaterThan(200);
    expect(counts.get("17,17,17") ?? 0).toBeGreaterThan(200);
  });
});

describe("core 的 runs 壓縮與展開（跨端唯一真相）", () => {
  it("量到的分段壓成 runs 之後，展開回來與量測結果一致", () => {
    const measured = [
      { text: "打造 ", color: "#111111" },
      { text: "AI Agent", color: "#ff6b35" },
      { text: " 的未來", color: "#111111" },
    ];
    const runs = compressTextRuns(measured);
    expect(runs).toEqual(RUNS);
    expect(
      resolveTextRuns({ text: "打造 AI Agent 的未來", color: "#111111", runs: runs! }),
    ).toEqual(measured);
  });
});

/**
 * PPTX 端。多色框走 pptxgenjs 的 run 陣列（每個 run 一個 `<a:r>`，各自帶 `<a:solidFill>`）；
 * 單色框仍然傳字串，輸出的 XML 與這個功能加入之前逐位元相同。
 */
describe("PPTX 匯出：框內分段", () => {
  async function exportSlideXml(boxes: EditableTextBox[]): Promise<string> {
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-text-runs-")),
    );
    await repository.initialize();
    const project = createProject({ topic: "框內多色", brief: { desiredSlideCount: 1 } });
    const slide = project.slides[0]!;
    const now = new Date().toISOString();
    const background = new Uint8Array(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%" fill="#123456"/></svg>`,
      )
        .render()
        .asPng(),
    );
    const backgroundPath = await repository.saveAsset(
      project.id,
      `${slide.id}/background.png`,
      background,
    );
    const versionId = "layered-version";
    slide.versions.push({
      id: versionId,
      imagePath: backgroundPath,
      prompt: "",
      providerId: "test",
      model: "test",
      parameters: {},
      styleVersion: 1,
      sources: [],
      createdAt: now,
      textLayer: {
        originalVersionId: "original",
        backgroundPath,
        compositePath: backgroundPath,
        threshold: 0.75,
        renderRevision: 0,
        extractedAt: now,
        updatedAt: now,
        boxes,
      },
    });
    slide.currentVersionId = versionId;
    const pptx = await exportPresentation(repository, project, "pptx");
    return Buffer.from(unzipSync(pptx)["ppt/slides/slide1.xml"]!).toString("utf8");
  }

  it("單色框只有一個 <a:r>（＝加入這個功能之前的輸出）", async () => {
    const xml = await exportSlideXml([box()]);
    expect(xml.match(/<a:r>/g) ?? []).toHaveLength(1);
    expect(xml).toContain("打造 AI Agent 的未來");
  });

  it("多色框逐段輸出 <a:r>，每段帶自己的 solidFill", async () => {
    const xml = await exportSlideXml([box({ runs: RUNS })]);
    expect(xml.match(/<a:r>/g) ?? []).toHaveLength(3);
    expect(xml).toContain("FF6B35");
    expect(xml).toContain("111111");
    // 每個 run 都必須顯式關掉斷行，否則三段會變成三行——shape 層的 breakLine 管不到它們。
    expect(xml.match(/<a:br\/>/g) ?? []).toHaveLength(0);
  });
});

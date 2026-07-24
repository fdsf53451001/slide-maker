import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import sharp from "sharp";
import {
  createProject,
  editableTextBoxSchema,
  parseProject,
  type EditableTextBox,
  type PresentationProject,
} from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { compressSlideImage, exportPresentation, parseProjectBundle } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";
import { renderComposite, textOverlaySvg } from "../src/text-layers.js";

/**
 * 文字框底色的**對抗性**驗證。
 *
 * 與 `text-background.test.ts` 的分工：那一份斷言的是「產生出來的字串長什麼樣」，
 * 這一份一律斷言**渲染後的像素**與**往返後的資料**——字串對了但落點差一格、
 * 旋轉中心不同、疊層順序反了、往返掉欄位，字串斷言全部照樣綠燈。
 */

const CANVAS = { width: 960, height: 540 };

function box(overrides: Partial<EditableTextBox> = {}): EditableTextBox {
  return {
    id: "box",
    // 預設空字串：幾何測試要的是**只有底色矩形**的畫面，任何字墨都會污染 bbox／質心。
    text: "",
    x: 100,
    y: 120,
    width: 400,
    height: 200,
    fontFamily: "Arial",
    fontSize: 48,
    fontWeight: 400,
    color: "#ffffff",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 1,
    role: "presentation",
    ...overrides,
  };
}

/** 底色 SVG 疊在純色底上，用**與 renderComposite 相同的 sharp 管線**打成 RGBA 像素。 */
async function rasterize(
  boxes: readonly EditableTextBox[],
  base = "#000000",
): Promise<{ data: Buffer; at: (x: number, y: number) => [number, number, number] }> {
  const baseline = await sharp({
    create: { width: CANVAS.width, height: CANVAS.height, channels: 4, background: base },
  })
    .png()
    .toBuffer();
  const overlay = textOverlaySvg(boxes, CANVAS.width, CANVAS.height);
  const data = await sharp(baseline)
    .composite([{ input: overlay, blend: "over" }])
    .removeAlpha()
    .raw()
    .toBuffer();
  return {
    data,
    at: (x, y) => {
      const offset = (y * CANVAS.width + x) * 3;
      return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
    },
  };
}

/** 與底色相符的像素集合的 bbox 與質心（用來驗落點、尺寸與旋轉中心）。 */
function inkStats(
  data: Buffer,
  match: (rgb: [number, number, number]) => boolean,
): { minX: number; maxX: number; minY: number; maxY: number; cx: number; cy: number; n: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < CANVAS.height; y += 1)
    for (let x = 0; x < CANVAS.width; x += 1) {
      const offset = (y * CANVAS.width + x) * 3;
      if (!match([data[offset]!, data[offset + 1]!, data[offset + 2]!])) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      n += 1;
    }
  return { minX, maxX, minY, maxY, cx: sumX / n, cy: sumY / n, n };
}

const isRed = (rgb: [number, number, number]) => rgb[0] > 200 && rgb[1] < 60 && rgb[2] < 60;

describe("底色矩形的像素落點（SVG 合成路徑）", () => {
  it("未旋轉時填滿的像素恰好是框本身，外面一圈完全沒被碰到", async () => {
    const { at } = await rasterize([box({ backgroundColor: "#ff0000" })]);
    // 四個角的內側像素都要是底色。
    expect(at(100, 120)).toEqual([255, 0, 0]);
    expect(at(499, 120)).toEqual([255, 0, 0]);
    expect(at(100, 319)).toEqual([255, 0, 0]);
    expect(at(499, 319)).toEqual([255, 0, 0]);
    // 緊貼框外的像素必須原封不動——底色多外擴一格就會咬到隔壁元素。
    expect(at(99, 200)).toEqual([0, 0, 0]);
    expect(at(500, 200)).toEqual([0, 0, 0]);
    expect(at(300, 119)).toEqual([0, 0, 0]);
    expect(at(300, 320)).toEqual([0, 0, 0]);
  });

  it("填滿面積恰好等於 width×height，沒有多畫也沒有少畫", async () => {
    const { data } = await rasterize([box({ backgroundColor: "#ff0000" })]);
    const stats = inkStats(data, isRed);
    expect(stats.n).toBe(400 * 200);
    expect([stats.minX, stats.maxX, stats.minY, stats.maxY]).toEqual([100, 499, 120, 319]);
  });

  /**
   * 旋轉中心一致性：SVG 用 `rotate(a cx cy)`，編輯器 DOM 用 CSS `transform: rotate()`
   * 搭 `transform-origin: center`。兩者只有在「旋轉中心都等於框中心」時才會疊合。
   * 旋轉後填滿區的**質心**恆等於旋轉中心，所以任何角度都可以拿它當共同座標系的探針；
   * 若哪天有人把 SVG 改成繞 (x, y) 轉，這裡會立刻位移到別的點。
   */
  it.each([0, 37, 45, 90, -45, -90, 180, -180, 179.5])(
    "旋轉 %s 度時填滿區的質心仍是框中心（＝ DOM 的 transform-origin: center）",
    async (rotation) => {
      const centered = box({
        backgroundColor: "#ff0000",
        x: 280,
        y: 170,
        width: 400,
        height: 200,
        rotation,
      });
      const { data } = await rasterize([centered]);
      const stats = inkStats(data, isRed);
      expect(stats.n).toBeGreaterThan(400 * 200 * 0.9);
      // 像素中心是 (x+0.5, y+0.5)，所以幾何中心 480/270 對應到質心 479.5/269.5。
      expect(stats.cx).toBeCloseTo(479.5, 0);
      expect(stats.cy).toBeCloseTo(269.5, 0);
    },
  );

  it("±180 度與 0 度的填滿區完全重合（旋轉不會讓框整個平移）", async () => {
    const base = box({ backgroundColor: "#ff0000", x: 280, y: 170 });
    const flat = inkStats((await rasterize([base])).data, isRed);
    for (const rotation of [180, -180]) {
      const turned = inkStats((await rasterize([{ ...base, rotation }])).data, isRed);
      expect([turned.minX, turned.maxX, turned.minY, turned.maxY]).toEqual([
        flat.minX,
        flat.maxX,
        flat.minY,
        flat.maxY,
      ]);
    }
  });

  it("旋轉 90 度時 bbox 是寬高互換後繞中心的框（不是原地不動）", async () => {
    const { data } = await rasterize([
      box({ backgroundColor: "#ff0000", x: 280, y: 170, width: 400, height: 200, rotation: 90 }),
    ]);
    const stats = inkStats(data, isRed);
    // 中心 (480,270)，轉 90 度後半寬 100、半高 200。
    expect(stats.minX).toBeCloseTo(380, -0.5);
    expect(stats.maxX).toBeCloseTo(579, -0.5);
    expect(stats.minY).toBeCloseTo(70, -0.5);
    expect(stats.maxY).toBeCloseTo(469, -0.5);
  });
});

describe("底色的透明度與退化輸入", () => {
  it("backgroundOpacity 0.5 的紅底疊在黑底上是半亮紅（與 DOM 的 rgba(...,0.5) 同一個混色）", async () => {
    const { at } = await rasterize([box({ backgroundColor: "#ff0000", backgroundOpacity: 0.5 })]);
    const [r, g, b] = at(300, 200);
    expect(r).toBeGreaterThanOrEqual(126);
    expect(r).toBeLessThanOrEqual(130);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it("backgroundOpacity 0 的畫面與完全沒有底色的畫面逐位元組相同", async () => {
    const withZero = await rasterize([
      box({ text: "文字", backgroundColor: "#ff0000", backgroundOpacity: 0 }),
    ]);
    const without = await rasterize([box({ text: "文字" })]);
    expect(Buffer.compare(withZero.data, without.data)).toBe(0);
  });

  it("只有 backgroundOpacity 沒有 backgroundColor 時完全不畫底色", async () => {
    const orphan = await rasterize([box({ text: "文字", backgroundOpacity: 0.6 })]);
    const without = await rasterize([box({ text: "文字" })]);
    expect(Buffer.compare(orphan.data, without.data)).toBe(0);
  });

  it("大小寫混合的 hex 與小寫解析成同一個顏色", async () => {
    const upper = await rasterize([box({ backgroundColor: "#AbCdEf" })]);
    const lower = await rasterize([box({ backgroundColor: "#abcdef" })]);
    expect(upper.at(300, 200)).toEqual([0xab, 0xcd, 0xef]);
    expect(Buffer.compare(upper.data, lower.data)).toBe(0);
  });

  it("框超出畫布右下角時只畫得到的部分，不丟例外也不位移", async () => {
    const { data, at } = await rasterize([
      box({ backgroundColor: "#ff0000", x: 860, y: 490, width: 400, height: 200 }),
    ]);
    expect(at(959, 539)).toEqual([255, 0, 0]);
    expect(at(859, 539)).toEqual([0, 0, 0]);
    const stats = inkStats(data, isRed);
    expect([stats.minX, stats.maxX, stats.minY, stats.maxY]).toEqual([860, 959, 490, 539]);
  });

  it("極小框（1×1）仍然畫得出恰好一個像素", async () => {
    const { data } = await rasterize([
      box({ backgroundColor: "#ff0000", x: 500, y: 300, width: 1, height: 1 }),
    ]);
    const stats = inkStats(data, isRed);
    expect(stats.n).toBe(1);
    expect([stats.minX, stats.minY]).toEqual([500, 300]);
  });

  it("疊層：後面框的底色蓋掉前面框的文字，順序反過來就蓋不到", async () => {
    const under = box({
      id: "under",
      text: "XXXXXXXX",
      x: 100,
      y: 120,
      width: 400,
      height: 200,
      fontSize: 120,
      color: "#00ff00",
    });
    const over = box({
      id: "over",
      x: 100,
      y: 120,
      width: 400,
      height: 200,
      backgroundColor: "#ff0000",
    });
    const isGreen = (rgb: [number, number, number]) => rgb[1] > 200 && rgb[0] < 60;
    /** 只看落在 over 這個框裡的綠字墨；框外的字墨兩端都不裁，本來就該留著。 */
    const insideOver = (data: Buffer) => {
      let n = 0;
      for (let y = 120; y < 320; y += 1)
        for (let x = 100; x < 500; x += 1) {
          const offset = (y * CANVAS.width + x) * 3;
          if (isGreen([data[offset]!, data[offset + 1]!, data[offset + 2]!])) n += 1;
        }
      return n;
    };

    const covered = await rasterize([under, over]);
    expect(insideOver(covered.data)).toBe(0);
    expect(inkStats(covered.data, isRed).n).toBe(400 * 200);
    // 框外溢出的字墨不受底色影響——底色永遠只有框那麼大，不會跟著字一起外擴。
    expect(inkStats(covered.data, isGreen).n).toBeGreaterThan(0);

    const exposed = await rasterize([over, under]);
    expect(insideOver(exposed.data)).toBeGreaterThan(0);
  });

  it("接近上限的 500 個帶底色的框仍能合成，且每個框都真的畫出來", async () => {
    const boxes = Array.from({ length: 500 }, (_, index) =>
      box({
        id: `box-${index}`,
        x: (index % 25) * 38,
        y: Math.floor(index / 25) * 27,
        width: 30,
        height: 20,
        backgroundColor: "#ff0000",
      }),
    );
    editableTextBoxSchema.array().max(500).parse(boxes);
    const { data } = await rasterize(boxes);
    expect(inkStats(data, isRed).n).toBe(500 * 30 * 20);
  });
});

describe("schema 的舊資料相容與邊界", () => {
  /** 加入功能之前的文字框 JSON（逐欄照抄 schema，只是沒有兩個新欄位）。 */
  const legacyJson = {
    id: "legacy",
    text: "舊資料",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    fontFamily: "Arial",
    fontSize: 30,
    fontWeight: 400,
    color: "#ffffff",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 0.9,
    role: "presentation",
  };

  it("舊資料 parse 後兩個新欄位仍然「不存在」，不是 undefined 也不是預設值", () => {
    const parsed = editableTextBoxSchema.parse(legacyJson);
    expect("backgroundColor" in parsed).toBe(false);
    expect("backgroundOpacity" in parsed).toBe(false);
    // 序列化回去也不能多出 key，否則舊 project.json 一經讀寫就被污染。
    expect(JSON.stringify(parsed)).not.toContain("background");
  });

  it("舊資料在渲染端與加入功能之前的輸出逐位元組相同", async () => {
    const parsed = editableTextBoxSchema.parse({ ...legacyJson, text: "舊資料" });
    const rendered = await rasterize([parsed]);
    // 手動建構一個同樣沒有新欄位的框，兩者必須完全一樣（＝新程式碼沒有偷偷加東西）。
    const { backgroundColor: _c, backgroundOpacity: _o, ...bare } = box({ ...parsed });
    expect(Buffer.compare(rendered.data, (await rasterize([bare as EditableTextBox])).data)).toBe(
      0,
    );
  });

  it.each(["#fff", "#12345g", "ff0000", "#ff00000", "", "red", "rgb(1,2,3)"])(
    "非法 hex %s 一律被 schema 擋下",
    (backgroundColor) => {
      expect(editableTextBoxSchema.safeParse({ ...legacyJson, backgroundColor }).success).toBe(
        false,
      );
    },
  );

  it.each([-0.01, 1.01, Number.NaN, Infinity])(
    "超界的 backgroundOpacity %s 一律被 schema 擋下",
    (backgroundOpacity) => {
      expect(editableTextBoxSchema.safeParse({ ...legacyJson, backgroundOpacity }).success).toBe(
        false,
      );
    },
  );

  it("大小寫混合的 hex 與 0／1 兩端都合法且原樣保存", () => {
    for (const [color, opacity] of [
      ["#AABBCC", 0],
      ["#aAbBcC", 1],
    ] as const) {
      const parsed = editableTextBoxSchema.parse({
        ...legacyJson,
        backgroundColor: color,
        backgroundOpacity: opacity,
      });
      expect(parsed.backgroundColor).toBe(color);
      expect(parsed.backgroundOpacity).toBe(opacity);
    }
  });
});

/** 建一個一頁、單一版本帶可編輯文字層的專案，背景是純黑底圖。 */
async function layeredProject(
  repository: FileProjectRepository,
  boxes: EditableTextBox[],
): Promise<{ project: PresentationProject; versionId: string }> {
  const project = createProject({ topic: "底色往返", brief: { desiredSlideCount: 1 } });
  project.canvas = { ...project.canvas, ...CANVAS };
  project.workflowStage = "editing";
  const slide = project.slides[0]!;
  const now = new Date().toISOString();
  const background = new Uint8Array(
    await sharp({
      create: { width: CANVAS.width, height: CANVAS.height, channels: 4, background: "#000000" },
    })
      .png()
      .toBuffer(),
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
  return { project, versionId };
}

describe("端到端往返：合成圖 → 匯出 → 再匯入", () => {
  const decorated = box({
    id: "decorated",
    text: "保真",
    x: 100,
    y: 120,
    width: 400,
    height: 200,
    backgroundColor: "#AbCdEf",
    backgroundOpacity: 0.75,
  });

  it("renderComposite 真的把底色烘進合成圖（png.zip／PDF 都吃這張）", async () => {
    const repository = new FileProjectRepository(await mkdtemp(join(tmpdir(), "qa-bg-render-")));
    await repository.initialize();
    const { project, versionId } = await layeredProject(repository, [decorated]);
    const layer = project.slides[0]!.versions.find((v) => v.id === versionId)!.textLayer!;
    const compositePath = await renderComposite(repository, project, layer);
    const pixels = await sharp(
      repository.assetPath(project.id, compositePath.replace(/^assets\//, "")),
    )
      .removeAlpha()
      .raw()
      .toBuffer();
    const offset = (200 * CANVAS.width + 300) * 3;
    // #AbCdEf 以 0.75 疊在黑底上 ≈ (128, 154, 179)；librsvg 走 8-bit premultiplied alpha，
    // 允許 ±1 的量化誤差，但顏色本身必須是這個色而不是別的框或原色。
    expect(pixels[offset]!).toBeCloseTo(128, -0.4);
    expect(pixels[offset + 1]!).toBeCloseTo(154, -0.4);
    expect(pixels[offset + 2]!).toBeCloseTo(179, -0.4);
  });

  it("slide-project 封存 → parseProjectBundle → 再匯入，兩個欄位原值保真", async () => {
    const repository = new FileProjectRepository(await mkdtemp(join(tmpdir(), "qa-bg-archive-")));
    await repository.initialize();
    const { project } = await layeredProject(repository, [decorated]);
    await repository.saveProject(project);
    const archive = await exportPresentation(repository, project, "slide-project");
    const { project: restored } = parseProjectBundle(archive);
    const box0 = restored.slides[0]!.versions[0]!.textLayer!.boxes[0]!;
    expect(box0.backgroundColor).toBe("#AbCdEf");
    expect(box0.backgroundOpacity).toBe(0.75);
    // 再跑一次 parseProject（＝匯入端的第二次驗證）也不能掉欄位。
    expect(parseProject(JSON.parse(JSON.stringify(restored)))).toEqual(restored);
  });

  it("png.zip 匯出的圖裡底色仍在（走 compositePath 那條）", async () => {
    const repository = new FileProjectRepository(await mkdtemp(join(tmpdir(), "qa-bg-png-")));
    await repository.initialize();
    const { project, versionId } = await layeredProject(repository, [
      { ...decorated, backgroundColor: "#ff0000", backgroundOpacity: 1 },
    ]);
    const version = project.slides[0]!.versions.find((v) => v.id === versionId)!;
    version.textLayer!.compositePath = await renderComposite(
      repository,
      project,
      version.textLayer!,
    );
    version.imagePath = version.textLayer!.compositePath;
    await repository.saveProject(project);
    const zip = unzipSync(await exportPresentation(repository, project, "png.zip"));
    const entry = Object.entries(zip).find(([name]) => name.endsWith(".png"))!;
    const pixels = await sharp(Buffer.from(entry[1])).removeAlpha().raw().toBuffer();
    const offset = (200 * CANVAS.width + 300) * 3;
    expect([pixels[offset], pixels[offset + 1], pixels[offset + 2]]).toEqual([255, 0, 0]);
  });
});

describe("PPTX 底色矩形的對抗性檢查", () => {
  async function slideXml(boxes: EditableTextBox[]): Promise<string> {
    const repository = new FileProjectRepository(await mkdtemp(join(tmpdir(), "qa-bg-pptx-")));
    await repository.initialize();
    const { project } = await layeredProject(repository, boxes);
    const pptx = await exportPresentation(repository, project, "pptx");
    return Buffer.from(unzipSync(pptx)["ppt/slides/slide1.xml"]!).toString("utf8");
  }

  it("底色矩形不宣告任何線條屬性（SVG 那端沒有 stroke，PPTX 多一條就對不上）", async () => {
    const xml = await slideXml([box({ text: "標題", backgroundColor: "#ff0000" })]);
    expect(xml).toContain('val="FF0000"');
    // pptxgenjs 對每個 <p:sp> 都會吐一個空的 <a:ln></a:ln>（＝未指定線條），
    // 文字框與頁碼色塊一直都是這樣。底色矩形必須落在同一類，不能帶 solidFill／w／prstDash。
    const lines = xml.match(/<a:ln[^>]*>[\s\S]*?<\/a:ln>|<a:ln[^>]*\/>/g) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toBe("<a:ln></a:ln>");
  });

  it("backgroundOpacity 1 不寫 alpha（完全不透明），0 則寫 alpha=0", async () => {
    const opaque = await slideXml([box({ backgroundColor: "#ff0000", backgroundOpacity: 1 })]);
    expect(opaque).toContain('<a:srgbClr val="FF0000"/>');
    expect(opaque).not.toContain("<a:alpha");
    const invisible = await slideXml([box({ backgroundColor: "#ff0000", backgroundOpacity: 0 })]);
    expect(invisible).toContain('<a:srgbClr val="FF0000"><a:alpha val="0"/></a:srgbClr>');
  });

  it("負角度照樣寫進 rot（OOXML 的 rot 允許負值）", async () => {
    const xml = await slideXml([box({ backgroundColor: "#ff0000", rotation: -30 })]);
    expect(xml).toContain('rot="-1800000"');
  });

  it("大小寫混合的 hex 會被正規化成 OOXML 接受的大寫", async () => {
    const xml = await slideXml([box({ backgroundColor: "#AbCdEf" })]);
    expect(xml).toContain('val="ABCDEF"');
    expect(xml).not.toContain("AbCdEf");
  });

  it("多框時每個底色都排在自己那個文字之前、前一個文字之後", async () => {
    const xml = await slideXml([
      box({ id: "a", text: "前框", x: 10, y: 10, width: 200, height: 80 }),
      box({
        id: "b",
        text: "後框",
        x: 40,
        y: 40,
        width: 200,
        height: 80,
        backgroundColor: "#ff0000",
      }),
    ]);
    expect(xml.indexOf("前框")).toBeLessThan(xml.indexOf("FF0000"));
    expect(xml.indexOf("FF0000")).toBeLessThan(xml.indexOf("後框"));
  });

  it("非 presentation 角色的框不會偷偷畫出底色", async () => {
    const xml = await slideXml([
      box({ id: "logo", text: "LOGO", role: "logo", backgroundColor: "#ff0000" }),
    ]);
    expect(xml).not.toContain("FF0000");
    expect(xml).not.toContain("LOGO");
  });
});

describe("HTTP 端到端：PUT /text-layer → 重新讀取 → 匯出 → 再匯入", () => {
  /** 起一個真的 server，並用同一個資料根目錄的第二個 repository 落地帶文字層的 fixture。 */
  async function bootstrap(boxes: EditableTextBox[]) {
    const root = join(await mkdtemp(join(tmpdir(), "qa-bg-http-")), ".slide-maker-data");
    const app = await createApp(root);
    const repository = new FileProjectRepository(root);
    await repository.initialize();
    let server: Server | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return undefined;
      throw error;
    }
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const { project, versionId } = await layeredProject(repository, boxes);
    await repository.saveProject(project);
    return { server: server!, baseUrl, repository, project, versionId };
  }

  const putBoxes = (
    baseUrl: string,
    project: PresentationProject,
    versionId: string,
    boxes: unknown[],
  ) =>
    fetch(
      `${baseUrl}/api/projects/${project.id}/slides/${project.slides[0]!.id}/versions/${versionId}/text-layer`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boxes }),
      },
    );

  it("PUT 帶底色的框 → GET 回來欄位原值保真，合成圖也真的重畫了", async (context) => {
    const env = await bootstrap([box({ id: "b1", text: "保真" })]);
    if (!env) return context.skip();
    const { server, baseUrl, repository, project, versionId } = env;
    try {
      const painted = {
        ...box({
          id: "b1",
          text: "保真",
          x: 100,
          y: 120,
          width: 400,
          height: 200,
          backgroundColor: "#AbCdEf",
          backgroundOpacity: 0.75,
        }),
      };
      const response = await putBoxes(baseUrl, project, versionId, [painted]);
      expect(response.status).toBe(200);

      const reloaded = (await (
        await fetch(`${baseUrl}/api/projects/${project.id}`)
      ).json()) as PresentationProject;
      const version = reloaded.slides[0]!.versions.find((v) => v.id === versionId)!;
      const stored = version.textLayer!.boxes[0]!;
      expect(stored.backgroundColor).toBe("#AbCdEf");
      expect(stored.backgroundOpacity).toBe(0.75);
      // PUT 會把 imagePath 指到新的合成圖；png.zip／PDF 兩條匯出都讀它。
      expect(version.imagePath).toBe(version.textLayer!.compositePath);

      const composite = await sharp(
        repository.assetPath(reloaded.id, version.imagePath.replace(/^assets\//, "")),
      )
        .removeAlpha()
        .raw()
        .toBuffer();
      const offset = (200 * CANVAS.width + 300) * 3;
      expect(composite[offset]!).toBeCloseTo(128, -0.4);

      // 封存 → 再匯入：欄位必須一路帶到新專案。走真正的匯出端點（sendChunked 那條）。
      const archive = await fetch(
        `${baseUrl}/api/projects/${reloaded.id}/export/slide-project`,
      ).then((r) => r.arrayBuffer());
      const imported = await fetch(`${baseUrl}/api/projects/import`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: archive,
      });
      expect(imported.status).toBe(201);
      const next = (await imported.json()) as PresentationProject;
      const nextBox = next.slides[0]!.versions.find((v) => v.textLayer)!.textLayer!.boxes[0]!;
      expect(nextBox.backgroundColor).toBe("#AbCdEf");
      expect(nextBox.backgroundOpacity).toBe(0.75);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PUT 超界的 backgroundOpacity 與非法 hex 都被伺服器擋下，舊資料原封不動", async (context) => {
    const env = await bootstrap([box({ id: "b1", text: "守門" })]);
    if (!env) return context.skip();
    const { server, baseUrl, project, versionId } = env;
    try {
      for (const bad of [{ backgroundOpacity: 1.5 }, { backgroundColor: "#fff" }]) {
        const response = await putBoxes(baseUrl, project, versionId, [
          { ...box({ id: "b1", text: "守門" }), ...bad },
        ]);
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      const reloaded = (await (
        await fetch(`${baseUrl}/api/projects/${project.id}`)
      ).json()) as PresentationProject;
      const stored = reloaded.slides[0]!.versions.find((v) => v.id === versionId)!.textLayer!
        .boxes[0]!;
      expect("backgroundColor" in stored).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PDF 匯出內嵌的 JPEG 就是含底色的合成圖", async (context) => {
    const env = await bootstrap([box({ id: "b1", text: "PDF" })]);
    if (!env) return context.skip();
    const { server, baseUrl, repository, project, versionId } = env;
    try {
      await putBoxes(baseUrl, project, versionId, [
        box({
          id: "b1",
          text: "PDF",
          x: 100,
          y: 120,
          width: 400,
          height: 200,
          backgroundColor: "#ff0000",
        }),
      ]);
      const reloaded = (await (
        await fetch(`${baseUrl}/api/projects/${project.id}`)
      ).json()) as PresentationProject;
      const version = reloaded.slides[0]!.versions.find((v) => v.id === versionId)!;
      const composite = await readFile(
        repository.assetPath(reloaded.id, version.imagePath.replace(/^assets\//, "")),
      );
      const jpeg = Buffer.from(await compressSlideImage(new Uint8Array(composite)));
      // 這份 JPEG 是 PDF 與 PPTX 共用的壓縮結果；先確認紅底撐過 q88。
      const pixels = await sharp(jpeg).removeAlpha().raw().toBuffer();
      const offset = (200 * CANVAS.width + 300) * 3;
      expect(pixels[offset]!).toBeGreaterThan(230);
      expect(pixels[offset + 1]!).toBeLessThan(30);
      // pdf-lib 的 embedJpg 是逐位元組內嵌，所以整段 JPEG 必然出現在 PDF 裡。
      const pdf = Buffer.from(await exportPresentation(repository, reloaded, "pdf"));
      expect(pdf.includes(jpeg)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import { expect } from "vitest";
import sharp from "sharp";
import type { EditableTextBox } from "@slide-maker/core";
import {
  BOLD_FONT_SIZE,
  refineOcrBoxes,
  type RasterImage,
  type RefineResult,
} from "../../src/ocr-refine.js";
import { textOverlaySvg } from "../../src/text-layers.js";
import {
  defaultTextMetrics,
  INK_DELTA_SUM,
  type GlyphMetrics,
  type TextMetricsProvider,
} from "../../src/text-metrics.js";

/**
 * 字級／位置精修的 round-trip 自洽測試骨架。
 *
 * 舊測試用純色方塊當字墨，期望值又直接照抄程式裡的同一組字墨常數，
 * 因此「常數與真實字形不符」這類 bug 結構上抓不到——OCR 跑版才會反覆重現。
 * 這裡改成：用**真正的合成渲染路徑**畫出已知字級／位置的文字當假原圖，
 * 再依 OCR unclip 的行為外擴出偵測框餵進精修管線，斷言能還原原始字級與位置。
 * 所有期望值都由渲染本身推導，沒有任何寫死的像素或 em 常數，因此換機器、
 * 換字型都不會假性失敗，但只要 metrics 與渲染脫節就一定會被抓到。
 */
export interface RoundTripSpec {
  text: string;
  /** 原圖上真實使用的字級。 */
  fontSize: number;
  fontFamily?: string;
  /** 預設沿用管線的「字級 → 粗體」啟發式，避免用字重差異混淆幾何斷言。 */
  fontWeight?: number;
  x?: number;
  y?: number;
  /** 模擬 OCR 偵測框相對字墨的外擴量（px）。 */
  unclipX?: number;
  unclipY?: number;
  /**
   * 框寬比前進寬多出來的餘裕（px）。align 為 left 時無感，
   * center／right 才會把文字推離框左緣——這正是驗證錨點推導的必要條件。
   */
  slack?: number;
  align?: EditableTextBox["align"];
  /** 文字顏色；深底白字案例用得到。 */
  color?: string;
  /**
   * 偵測框自帶的字級初估相對真值的倍率（1 = 用 `boxesFromOcr` 的 框高×0.78）。
   * 這個初估會決定 `measureInk` 的「元件切分間隙」與「邊緣細條」門檻，
   * 是刀鋒式行為的來源：門檻掃過某個值時窄字形會突然被剔掉。
   */
  detectionScale?: number;
}

type ResolvedSpec = Required<RoundTripSpec>;

/** 假原圖上額外畫的非文字元素（卡片邊框、分隔線……），用來模擬字墨量測的污染源。 */
export interface Decoration {
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface SlideOptions {
  /** 假原圖底色；預設白底。深底白字會走 measureInk 的「邊框中位數推背景」那條路。 */
  background?: string;
  decorations?: readonly Decoration[];
  /** 畫布尺寸下限（讓裝飾元素不會被裁掉）。 */
  minCanvas?: { width: number; height: number };
}

export interface RenderedSlide {
  /** 原圖上真實渲染出來的框（ground truth），順序同 specs。 */
  truths: EditableTextBox[];
  /**
   * 每行文字真正的起始點（框左上角 + align 造成的位移）。
   * 精修後的框寬恆等於前進寬，所以位置誤差要跟這個錨點比，而非框的 x。
   */
  origins: readonly { x: number; y: number }[];
  /** 餵進管線的模擬 OCR 偵測框，順序同 specs。 */
  detections: EditableTextBox[];
  image: RasterImage;
  canvas: { width: number; height: number };
  background: string;
}

export interface RoundTripOutcome {
  spec: ResolvedSpec;
  truth: EditableTextBox;
  detection: EditableTextBox;
  /** 精修後的框。 */
  refined: EditableTextBox;
  /** 以精修後字型量到的 metrics。 */
  glyph: GlyphMetrics;
  /** 精修後的框實際會渲染出的前進寬。 */
  renderedWidth: number;
  fontSizeError: number;
  /** 位置誤差，以真實字級的 em 為單位。 */
  dxEm: number;
  dyEm: number;
  /**
   * 渲染前進寬 ÷ 偵測框寬。精修後的框寬本來就是用同一份 metrics 算出來的
   * （width = advance × fontSize），拿它當分母幾乎恆等於 1；真正會看出「跑版」的
   * 是「文字有沒有撐出 OCR 當初框到的範圍」，所以另外記錄這個比值。
   */
  overflowVsDetection: number;
}

const CANVAS_MARGIN = 80;
const LINE_HEIGHT = 1.2;
const TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND = "#ffffff";

function resolve(spec: RoundTripSpec): ResolvedSpec {
  return {
    text: spec.text,
    fontSize: spec.fontSize,
    fontFamily: spec.fontFamily ?? "Arial",
    fontWeight: spec.fontWeight ?? (spec.fontSize >= BOLD_FONT_SIZE ? 700 : 400),
    x: spec.x ?? 120,
    y: spec.y ?? 120,
    unclipX: spec.unclipX ?? 6,
    unclipY: spec.unclipY ?? 6,
    slack: spec.slack ?? 0,
    align: spec.align ?? "left",
    color: spec.color ?? TEXT_COLOR,
    detectionScale: spec.detectionScale ?? 1,
  };
}

function textBox(overrides: Partial<EditableTextBox> & { id: string }): EditableTextBox {
  return {
    text: "",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fontFamily: "Arial",
    fontSize: 30,
    fontWeight: 400,
    color: TEXT_COLOR,
    opacity: 1,
    lineHeight: LINE_HEIGHT,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 0.9,
    role: "presentation",
    ...overrides,
  };
}

/** 以合成路徑把一組文字框畫成假原圖（原始像素，供 measureInk 使用）。 */
export async function renderRaster(
  boxes: readonly EditableTextBox[],
  canvas: { width: number; height: number },
  options: SlideOptions = {},
): Promise<RasterImage> {
  const background = options.background ?? DEFAULT_BACKGROUND;
  const layers = [
    { input: textOverlaySvg(boxes, canvas.width, canvas.height), blend: "over" as const },
  ];
  const decorations = options.decorations ?? [];
  if (decorations.length) {
    const rects = decorations
      .map(
        (rect) =>
          `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="${rect.color ?? TEXT_COLOR}"/>`,
      )
      .join("");
    layers.unshift({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">${rects}</svg>`,
      ),
      blend: "over" as const,
    });
  }
  const raw = await sharp({
    create: { width: canvas.width, height: canvas.height, channels: 3, background },
  })
    .composite(layers)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(raw.data),
    width: raw.info.width,
    height: raw.info.height,
    channels: raw.info.channels,
  };
}

function parseHex(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * 在指定裁切區內掃出字墨外框（相對整張圖的座標）。
 * 端對端對位用：把「來源渲染」與「精修後重新渲染」兩張圖的同一條行帶各掃一次，
 * 直接比字墨落點，不經過 measureInk 的選帶／去細條邏輯，避免用被測物驗被測物。
 */
export function inkBBox(
  image: RasterImage,
  crop: { x: number; y: number; width: number; height: number },
  background: string = DEFAULT_BACKGROUND,
): { x: number; y: number; width: number; height: number } | null {
  const [br, bg, bb] = parseHex(background);
  const x0 = Math.max(0, Math.floor(crop.x));
  const y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(image.width, Math.ceil(crop.x + crop.width));
  const y1 = Math.min(image.height, Math.ceil(crop.y + crop.height));
  let minX = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * image.channels;
      const delta =
        Math.abs((image.data[o] ?? 0) - br) +
        Math.abs((image.data[o + 1] ?? 0) - bg) +
        Math.abs((image.data[o + 2] ?? 0) - bb);
      if (delta <= INK_DELTA_SUM) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 依 `boxesFromOcr` 的規則，把「字墨外框 + unclip 外擴」換算成偵測框：
 * 字級與粗體都是從框高推的粗估——精修的工作就是把它修回真值。
 */
function detectionFromInk(
  id: string,
  spec: ResolvedSpec,
  ink: { x: number; y: number; width: number; height: number },
): EditableTextBox {
  const height = ink.height + spec.unclipY * 2;
  return textBox({
    id,
    text: spec.text,
    x: Math.max(0, ink.x - spec.unclipX),
    y: Math.max(0, ink.y - spec.unclipY),
    width: ink.width + spec.unclipX * 2,
    height,
    fontSize: Math.max(10, Math.min(180, height * 0.78 * spec.detectionScale)),
    fontWeight: height >= 52 ? 700 : 400,
    fontFamily: spec.fontFamily,
    color: spec.color,
  });
}

/**
 * align 造成的文字起點位移：`textOverlaySvg` 的錨點是
 * left → 框左緣、center → 框中線、right → 框右緣，因此文字左緣＝框左緣＋餘裕的
 * 0／一半／全部。精修後的框寬恆等於前進寬（餘裕為 0），位置比對必須用這個錨點。
 */
function originShift(spec: ResolvedSpec): number {
  if (spec.align === "center") return spec.slack / 2;
  if (spec.align === "right") return spec.slack;
  return 0;
}

/** 把 specs 渲染成假原圖，並造出對應的模擬 OCR 偵測框。 */
export async function renderSlide(
  specs: readonly RoundTripSpec[],
  options: SlideOptions = {},
): Promise<RenderedSlide> {
  const resolved = specs.map(resolve);
  const glyphs = await Promise.all(
    resolved.map((spec) =>
      defaultTextMetrics.measure({
        text: spec.text,
        fontFamily: spec.fontFamily,
        fontWeight: spec.fontWeight,
        lineHeight: LINE_HEIGHT,
      }),
    ),
  );
  const truths = resolved.map((spec, index) => {
    const glyph = glyphs[index]!;
    return textBox({
      id: `truth-${index}`,
      text: spec.text,
      x: spec.x,
      y: spec.y,
      width: glyph.advance * spec.fontSize + spec.slack,
      height: spec.fontSize * LINE_HEIGHT,
      fontFamily: spec.fontFamily,
      fontSize: spec.fontSize,
      fontWeight: spec.fontWeight,
      align: spec.align,
      color: spec.color,
    });
  });
  const origins = resolved.map((spec) => ({ x: spec.x + originShift(spec), y: spec.y }));
  const detections = resolved.map((spec, index) => {
    const glyph = glyphs[index]!;
    const origin = origins[index]!;
    return detectionFromInk(`box-${index}`, spec, {
      x: origin.x + glyph.bearing * spec.fontSize,
      y: origin.y + glyph.inkTop * spec.fontSize,
      width: glyph.inkWidth * spec.fontSize,
      height: glyph.inkHeight * spec.fontSize,
    });
  });
  const canvas = {
    width: Math.max(
      options.minCanvas?.width ?? 0,
      Math.ceil(Math.max(...truths.map((box) => box.x + box.width)) + CANVAS_MARGIN),
    ),
    height: Math.max(
      options.minCanvas?.height ?? 0,
      Math.ceil(Math.max(...truths.map((box) => box.y + box.height)) + CANVAS_MARGIN),
    ),
  };
  return {
    truths,
    origins,
    detections,
    canvas,
    background: options.background ?? DEFAULT_BACKGROUND,
    image: await renderRaster(truths, canvas, options),
  };
}

/** 依 refine 的結果組出可斷言的比較資料。 */
export async function compareToTruth(
  specs: readonly RoundTripSpec[],
  slide: RenderedSlide,
  boxes: readonly EditableTextBox[],
): Promise<RoundTripOutcome[]> {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  return Promise.all(
    specs.map(resolve).map(async (spec, index) => {
      const truth = slide.truths[index]!;
      const origin = slide.origins[index]!;
      const detection = slide.detections[index]!;
      const refined = byId.get(detection.id);
      if (!refined) throw new Error(`精修後找不到 ${detection.id}（${spec.text}）`);
      const glyph = await defaultTextMetrics.measure({
        text: refined.text,
        fontFamily: refined.fontFamily,
        fontWeight: refined.fontWeight,
        lineHeight: refined.lineHeight,
      });
      return {
        spec,
        truth,
        detection,
        refined,
        glyph,
        renderedWidth: glyph.advance * refined.fontSize,
        fontSizeError: Math.abs(refined.fontSize - spec.fontSize) / spec.fontSize,
        dxEm: (refined.x - origin.x) / spec.fontSize,
        dyEm: (refined.y - origin.y) / spec.fontSize,
        overflowVsDetection: (glyph.advance * refined.fontSize) / detection.width,
      };
    }),
  );
}

export async function runRoundTrip(
  specs: readonly RoundTripSpec[],
  options: {
    sourceTexts?: readonly string[];
    metrics?: TextMetricsProvider;
    slide?: SlideOptions;
    /** 精修時宣告的字型（跨字型替代政策測試用；不給就沿用來源字型）。 */
    refineFontFamily?: string;
  } = {},
): Promise<{ outcomes: RoundTripOutcome[]; slide: RenderedSlide; result: RefineResult }> {
  const slide = await renderSlide(specs, options.slide ?? {});
  const declared = options.refineFontFamily;
  const detections = declared
    ? slide.detections.map((box) => ({ ...box, fontFamily: declared }))
    : slide.detections;
  const result = await refineOcrBoxes(detections, {
    sourceTexts: options.sourceTexts ?? [],
    image: slide.image,
    // 假原圖一律用真實量測器渲染；只有精修這一側可被替換，才能觀察
    //「metrics 與渲染脫節」時管線會壞成什麼樣子。
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });
  return { outcomes: await compareToTruth(specs, slide, result.boxes), slide, result };
}

export interface RoundTripTolerance {
  /** 字級相對誤差上限。 */
  fontSize?: number;
  /** 位置誤差上限（em）。 */
  position?: number;
  /** 渲染寬 ÷ 框寬 的上限（不溢出不變式）。 */
  overflow?: number;
  /** 渲染寬 ÷ 偵測框寬 的上限（文字不得撐出 OCR 框到的範圍）。 */
  detectionOverflow?: number;
}

export function assertRoundTrip(
  outcome: RoundTripOutcome,
  tolerance: RoundTripTolerance = {},
): void {
  const { fontSize = 0.05, position = 0.05, overflow = 1.05, detectionOverflow = 1.05 } = tolerance;
  const label = `${outcome.spec.text} @${outcome.spec.fontSize}`;
  expect(outcome.refined.text, label).toBe(outcome.spec.text);
  expect(outcome.fontSizeError, `${label} 字級誤差`).toBeLessThan(fontSize);
  expect(Math.abs(outcome.dxEm), `${label} x 誤差`).toBeLessThan(position);
  expect(Math.abs(outcome.dyEm), `${label} y 誤差`).toBeLessThan(position);
  expect(
    outcome.renderedWidth / outcome.refined.width,
    `${label} 渲染寬 ÷ 框寬`,
  ).toBeLessThanOrEqual(overflow);
  // 框寬本身就是用同一份 metrics 算出來的，上一條在對位成功時幾乎恆等於 1；
  // 這一條才會抓到「字級被放大到撐出原始版面」的跑版。
  expect(outcome.overflowVsDetection, `${label} 渲染寬 ÷ 偵測框寬`).toBeLessThanOrEqual(
    detectionOverflow,
  );
}

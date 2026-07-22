import sharp from "sharp";
import type { EditableTextBox } from "@slide-maker/core";
import { textOverlaySvg } from "./text-layers.js";

/**
 * 字墨判準：像素與背景色的 RGB 絕對差總和門檻。
 * `measureInk`（量原圖）與本模組（量渲染樣本）必須共用同一門檻，否則
 * 「量到的字墨」與「渲染出的字墨」邊界定義不同，反推的字級會系統性偏移。
 */
export const INK_DELTA_SUM = 90;

/**
 * 字元級元件的最大內部間隙（em）：小於它的空白算同一元件內的字距，大於它才切開。
 * 原圖端另有 3px 下限（抗鋸齒保護），換算成 em 後必然 ≥ 本門檻，因此
 * 「原圖切得開的地方樣本一定也切得開」——兩端的元件切法不會反向不一致。
 */
export const COMPONENT_GAP_EM = 0.08;
/** 邊緣細條門檻（em）：窄於它的**邊緣**元件視為可疑（卡片分隔線，或 I l 1 這類窄字形）。 */
export const THIN_COMPONENT_EM = 0.12;

/** 元件切分用的間隙門檻（px）；下限 3px 是抗鋸齒與取樣誤差的保護。 */
export function componentGapPx(fontSize: number): number {
  return Math.max(3, fontSize * COMPONENT_GAP_EM);
}

/** 樣本渲染字級；所有回傳值都除以它，成為與字級無關的 em 比例。 */
const SAMPLE_FONT_SIZE = 100;
/**
 * 樣本四周留白：容納上伸部、下伸部與 half-leading，並確保背景可辨識。
 * 樣本畫布是量測期間的記憶體大宗（一行長 CJK 就是數 MB），留白只要夠用，
 * 開大等於整頁量測都白付這筆記憶體。
 */
const MARGIN = 60;
/** 左右對齊兩個樣本的垂直間距（> 一行字墨高，才能用列位置切開兩帶）。 */
const BAND_GAP = SAMPLE_FONT_SIZE * 3;
/**
 * 單字元寬度上限估計（em）；超出時字墨會被畫布裁掉。
 * CJK 實際約 1.0em/字，抓 1.1 已有餘裕；真的被裁到時 CLIPPED 會用三倍寬重試，
 * 不必為極端字形讓每一次量測都多付一倍畫布。
 */
const MAX_CHAR_ADVANCE = 1.1;
const MAX_CANVAS_WIDTH = 20000;
const CACHE_LIMIT = 4096;
/** 快取滿時淘汰最舊的一批（Map 保有插入順序）；整份 clear 會讓同一頁的量測全部重算。 */
const CACHE_EVICTION = 512;
/**
 * 同時進行的樣本渲染上限。每張樣本在 librsvg／sharp 內是數 MB 級的點陣緩衝，
 * 一頁二十幾行同時展開會讓尖峰 RSS 衝到數百 MB；這是長時間執行的伺服器，
 * 且同時還壓著 OCR raster 與 sharp buffer，尖峰壓不住就是受限容器上的 OOM。
 */
const MAX_CONCURRENT_RENDERS = 4;

/** 以 fontSize=1 正規化的字形 metrics，全部相對於 EditableTextBox 的左上角。 */
export interface GlyphMetrics {
  /** 整串前進寬 ÷ fontSize（渲染會佔用的水平空間，含首尾 bearing）。 */
  advance: number;
  /** 字墨外框寬 ÷ fontSize；已依 dropLeading／dropTrailing 剔除對應的邊緣元件。 */
  inkWidth: number;
  /** 整串字墨外框高 ÷ fontSize（不因剔除邊緣元件而改變，與原圖的列帶量法對齊）。 */
  inkHeight: number;
  /** 框頂（含 lineHeight half-leading）到字墨頂 ÷ fontSize。 */
  inkTop: number;
  /** 框左到（剔除後的）字墨左 ÷ fontSize。 */
  bearing: number;
  /**
   * 整串（未剔除前）首／尾元件的寬 ÷ fontSize。
   * 呼叫端用它判斷「原圖邊緣多出來的那條細墨」到底是這串字的首／尾字形，
   * 還是卡片分隔線之類的外來元素——兩者寬度差一個數量級。
   */
  leadComponent: number;
  tailComponent: number;
}

export interface TextMetricsRequest {
  text: string;
  fontFamily: string;
  fontWeight: number;
  lineHeight: number;
  /** 字距，單位是 **em**（呼叫端需以 box.letterSpacing ÷ fontSize 換算）。 */
  letterSpacing?: number;
  /**
   * 原圖端剔除了第一個／最後一個邊緣元件時，量測端要以相同方式剔除，
   * 兩邊才是同一個量；否則以窄字形（I、l、1、：）開頭或結尾的行會被系統性低估。
   */
  dropLeading?: boolean;
  dropTrailing?: boolean;
}

export interface TextMetricsProvider {
  measure(request: TextMetricsRequest): Promise<GlyphMetrics>;
}

export class TextMetricsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextMetricsError";
  }
}

export interface InkBand {
  start: number;
  /** exclusive */
  end: number;
}

/**
 * 把剖面切成連續帶：計數 ≥ minCount 的位置算「有墨」，中間空隙不超過 maxGap 就併為同一帶。
 * 原圖與渲染樣本共用同一個切法，兩端量到的元件邊界才有可比性。
 */
export function inkBands(counts: readonly number[], minCount: number, maxGap: number): InkBand[] {
  const result: InkBand[] = [];
  let start = -1;
  let gap = 0;
  counts.forEach((count, index) => {
    if (count >= minCount) {
      if (start < 0) start = index;
      gap = 0;
      return;
    }
    if (start >= 0 && ++gap > maxGap) {
      result.push({ start, end: index - gap + 1 });
      start = -1;
    }
  });
  if (start >= 0) result.push({ start, end: counts.length - gap });
  return result;
}

function sampleBox(
  request: TextMetricsRequest,
  y: number,
  width: number,
  align: "left" | "right",
): EditableTextBox {
  return {
    id: "text-metrics-sample",
    text: request.text,
    x: MARGIN,
    y,
    width,
    height: SAMPLE_FONT_SIZE * request.lineHeight,
    fontFamily: request.fontFamily,
    fontSize: SAMPLE_FONT_SIZE,
    fontWeight: request.fontWeight,
    color: "#000000",
    opacity: 1,
    lineHeight: request.lineHeight,
    // request.letterSpacing 是 em；樣本以 fontSize=100 渲染，字距也必須同步放大，
    // 否則量到的是「1/100 字距」的假 metrics（實測讓字級高估兩成以上）。
    letterSpacing: (request.letterSpacing ?? 0) * SAMPLE_FONT_SIZE,
    align,
    verticalAlign: "top",
    rotation: 0,
    confidence: 1,
    role: "presentation",
  };
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 掃描灰階樣本，取指定列區間內的字墨外框；沒有任何字墨時回 null。 */
function inkBounds(
  gray: Uint8Array,
  width: number,
  rowStart: number,
  rowEnd: number,
  cutoff: number,
): Bounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = -1;
  for (let y = rowStart; y < rowEnd; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if ((gray[row + x] ?? 255) > cutoff) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { minX, maxX, minY, maxY };
}

/** 併發閘：把同時進行的樣本渲染壓在上限之內。 */
class RenderGate {
  readonly #limit: number;
  readonly #waiting: (() => void)[] = [];
  #active = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit)
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

/**
 * 以「與合成完全相同的渲染路徑」量測字形 metrics。
 *
 * 寫死的字墨常數（拉丁 0.74em、CJK 0.94em）不看字串實際字形：同一條渲染路徑下
 * 「AI-Ready API Security」有下伸部，字墨高其實是 0.94em，用 0.74 反推字級會高估
 * 27%，文字整行溢出框。這裡直接用 `textOverlaySvg` 渲染 fontSize=100 的樣本再量，
 * 量到什麼就會渲染成什麼，常數不可能與渲染器脫節。
 *
 * 前進寬用「左對齊樣本」與「右對齊樣本」的字墨左緣差反推：
 * 左對齊時 inkLeft = x + bearing；右對齊時 inkLeft = x + width − advance + bearing，
 * 相減即得 advance，不必仰賴字型表，也不會被 kerning 影響。
 */
export class RenderedTextMetrics implements TextMetricsProvider {
  readonly #cache = new Map<string, Promise<GlyphMetrics>>();
  readonly #gate = new RenderGate(MAX_CONCURRENT_RENDERS);

  async measure(request: TextMetricsRequest): Promise<GlyphMetrics> {
    if (!request.text.trim())
      throw new TextMetricsError("TEXT_METRICS_EMPTY_TEXT: 空白字串沒有字墨可量測。");
    // fontFamily 是模型自由填的字串，可能含分隔字元；用 JSON 序列化避免不同請求撞 key。
    const key = JSON.stringify([
      request.fontFamily,
      request.fontWeight,
      request.lineHeight,
      request.letterSpacing ?? 0,
      request.dropLeading ?? false,
      request.dropTrailing ?? false,
      request.text,
    ]);
    const cached = this.#cache.get(key);
    if (cached) return cached;
    if (this.#cache.size >= CACHE_LIMIT) this.#evictOldest();
    const pending = this.#measureUncached(request).catch((error: unknown) => {
      // 失敗不留在快取裡，否則字型暫時性問題會鎖死整個行程。
      this.#cache.delete(key);
      throw error;
    });
    this.#cache.set(key, pending);
    return pending;
  }

  /** 只淘汰最舊的一批；整份 clear 會讓同一頁還沒量完的字串全部重算。 */
  #evictOldest(): void {
    let removed = 0;
    for (const key of this.#cache.keys()) {
      this.#cache.delete(key);
      if (++removed >= CACHE_EVICTION) break;
    }
  }

  /** 樣本寬度只是估計；真的被裁到就用更寬的畫布重來一次，不硬報錯。 */
  async #measureUncached(request: TextMetricsRequest): Promise<GlyphMetrics> {
    return this.#gate.run(async () => {
      try {
        return await this.#render(request, MAX_CHAR_ADVANCE);
      } catch (error) {
        if (!(error instanceof TextMetricsError) || !error.message.includes("TEXT_METRICS_CLIPPED"))
          throw error;
        return this.#render(request, MAX_CHAR_ADVANCE * 3);
      }
    });
  }

  async #render(request: TextMetricsRequest, charAdvance: number): Promise<GlyphMetrics> {
    const chars = [...request.text].length;
    const letterSpacing = request.letterSpacing ?? 0;
    const boxWidth = Math.min(
      MAX_CANVAS_WIDTH - MARGIN * 2,
      Math.ceil(chars * (charAdvance + Math.max(0, letterSpacing)) * SAMPLE_FONT_SIZE) +
        SAMPLE_FONT_SIZE,
    );
    const width = boxWidth + MARGIN * 2;
    const secondBandY = MARGIN + BAND_GAP;
    const height = secondBandY + Math.ceil(SAMPLE_FONT_SIZE * request.lineHeight) + MARGIN;
    const svg = textOverlaySvg(
      [
        sampleBox(request, MARGIN, boxWidth, "left"),
        sampleBox(request, secondBandY, boxWidth, "right"),
      ],
      width,
      height,
    );
    const sample = await sharp({
      create: { width, height, channels: 3, background: "#ffffff" },
    })
      .composite([{ input: svg, blend: "over" }])
      .greyscale()
      .raw()
      .toBuffer();
    const gray = new Uint8Array(sample.buffer, sample.byteOffset, sample.byteLength);
    // 背景是純白（255），字墨為黑；灰階單通道的差值 × 3 才等同 RGB 絕對差總和。
    const cutoff = 255 - INK_DELTA_SUM / 3;
    const split = MARGIN + BAND_GAP / 2;
    const left = inkBounds(gray, width, 0, split, cutoff);
    const right = inkBounds(gray, width, split, height, cutoff);
    const describe = `text=${JSON.stringify(request.text)} font=${request.fontFamily}/${request.fontWeight}`;
    if (!left || !right)
      throw new TextMetricsError(
        `TEXT_METRICS_NO_INK: 渲染樣本量不到任何字墨（${describe}）。請確認伺服器的字型環境（fontconfig / CJK fallback）可用。`,
      );
    if (left.minX <= 0 || left.maxX >= width - 1 || right.minX <= 0 || right.maxX >= width - 1)
      throw new TextMetricsError(
        `TEXT_METRICS_CLIPPED: 渲染樣本的字墨碰到畫布邊界，量測不可信（${describe}）。`,
      );
    const components = componentsOf(gray, width, left, cutoff);
    const kept = keepComponents(components, request);
    const head = kept[0];
    const tail = kept[kept.length - 1];
    const lead = components[0];
    const last = components[components.length - 1];
    if (!head || !tail || !lead || !last)
      throw new TextMetricsError(`TEXT_METRICS_DEGENERATE: 樣本切不出任何元件（${describe}）。`);
    const advance = (boxWidth + left.minX - right.minX) / SAMPLE_FONT_SIZE;
    const inkWidth = (tail.end - head.start) / SAMPLE_FONT_SIZE;
    if (!(advance > 0) || !(inkWidth > 0))
      throw new TextMetricsError(`TEXT_METRICS_DEGENERATE: 量到非正的字寬（${describe}）。`);
    return {
      advance,
      inkWidth,
      inkHeight: (left.maxY - left.minY + 1) / SAMPLE_FONT_SIZE,
      inkTop: (left.minY - MARGIN) / SAMPLE_FONT_SIZE,
      bearing: (head.start - MARGIN) / SAMPLE_FONT_SIZE,
      leadComponent: (lead.end - lead.start) / SAMPLE_FONT_SIZE,
      tailComponent: (last.end - last.start) / SAMPLE_FONT_SIZE,
    };
  }
}

/** 以左對齊樣本的字墨列區間做行剖面，切出字元級元件。 */
function componentsOf(gray: Uint8Array, width: number, left: Bounds, cutoff: number): InkBand[] {
  const counts = new Array<number>(width).fill(0);
  for (let y = left.minY; y <= left.maxY; y++) {
    const row = y * width;
    for (let x = left.minX; x <= left.maxX; x++)
      if ((gray[row + x] ?? 255) <= cutoff) counts[x] = (counts[x] ?? 0) + 1;
  }
  return inkBands(counts, 1, componentGapPx(SAMPLE_FONT_SIZE));
}

/** 依請求剔除首／尾元件；剔到沒東西剩就整組保留（原圖多出來的那條顯然不屬於這串字）。 */
function keepComponents(components: readonly InkBand[], request: TextMetricsRequest): InkBand[] {
  let first = 0;
  let last = components.length - 1;
  if (request.dropLeading && last - first >= 1) first += 1;
  if (request.dropTrailing && last - first >= 1) last -= 1;
  return components.slice(first, last + 1);
}

/** 行程層級共用（含快取）的量測器；測試可改注入自己的實作。 */
export const defaultTextMetrics: TextMetricsProvider = new RenderedTextMetrics();

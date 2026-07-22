import { randomUUID } from "node:crypto";
import type { EditableTextBox } from "@slide-maker/core";
import {
  componentGapPx,
  defaultTextMetrics,
  inkBands,
  INK_DELTA_SUM,
  THIN_COMPONENT_EM,
  type GlyphMetrics,
  type InkBand,
  type TextMetricsProvider,
  type TextMetricsRequest,
} from "./text-metrics.js";

// 與 text-layers.ts boxesFromOcr 的估計一致：fontSize ≈ 偵測框高 × 0.78。
const FONT_HEIGHT_RATIO = 0.78;
// boxesFromOcr 以框高 52px 為粗體門檻，換算成 fontSize 即 52 × 0.78。
export const BOLD_FONT_SIZE = 52 * FONT_HEIGHT_RATIO;
// 校正僅在 OCR 文字與來源片段的編輯距離 ≤ 34% 時採用來源文字，
// 避免把不在大綱裡的裝飾字（logo、浮水印）錯改成大綱內容。
const MAX_ERROR_RATIO = 0.34;
// 拆分後右段估出的字級需比原框小 15% 以上才視為「標題＋內文被黏成一框」；
// 尺寸相近的 ｜ 視為同一段落的設計符號，不拆。
const SPLIT_MIN_RATIO = 0.85;
// 字級聚類容差（錨定在群組最小值）：純偵測框估計有 ±12% 抖動需寬容差；
// 字墨對位後誤差只剩 ±數 %，收緊以免把相鄰層級（副標 vs 內文）誤併。
const CLUSTER_RATIO_DETECTION = 1.25;
const CLUSTER_RATIO_INK = 1.12;

// 量到的字墨高與「字級 × 該字串的字墨高比例」差多少才判定量測被污染
//（鄰行滲入、卡片邊框或分隔線被算進字墨帶）。乾淨量測的偏差在數 % 內。
const HEIGHT_MISMATCH_TOLERANCE = 0.35;

// `measureInk` 往偵測框外多找的像素：偵測框只是 unclip 後的粗略範圍，字墨可能略微外露。
const INK_SEARCH_MARGIN = 6;
// 字墨帶「疑似吃進鄰行」的判定與收斂。
// 乾淨字墨永遠不會貼到搜尋區邊緣（偵測框外還有 INK_SEARCH_MARGIN 的留白），
// 貼邊代表墨一路延伸出搜尋區——典型是行距緊時上一行的下伸部尾巴（y／g 的
// 2–5px 細墨）把兩行的列剖面橋接成同一帶（實機：System 的 y 尾巴讓下一行
// Monitoring 的 ink.y 被拉高 18px，兩行渲染後疊在一起）。
// 收斂方式是**從受污染的那一邊往內走、切在第一個低墨谷**：行間空隙與稀疏的
// 尾巴列（約峰值的 4–10%）是谷、字帽列（大寫的豎筆＋上伸部，約 15–30%）不是，
// 門檻取峰值的 12% 恰好落在兩者之間——取高了會把下一行的字帽也當谷切掉，
// y 錨點反而往下掉。不能用單一
// 「列墨量門檻」分類整個剖面——長行的大寫列與粗體尾巴的墨量同數量級，
// 振幅分不開；也不能用固定高度的視窗——視窗高度得依賴偵測框的字級初估
//（±2 成誤差），估大了照樣蓋到鄰行。
const TRIM_VALLEY_RATIO = 0.12;
// 一條「貫穿整個搜尋區」的垂直線需要覆蓋多少比例的列，才被當成卡片邊框而非字形。
const RULE_ROW_COVERAGE = 0.9;
// 字距非零時，px→em 的換算需要字級（正是待解的量），以估計值迭代到穩定；
// 常態 letterSpacing=0 時第一次就是答案，不會多量。
const LETTER_SPACING_PASSES = 3;
// 「原圖剔掉的邊緣細條」與「該字串首／尾字形的預期寬度」相差多少仍算同一個東西。
// 分隔線與字形的寬度通常差一個數量級，容差寬鬆無妨；下限則是量化誤差的保護。
const EDGE_MATCH_TOLERANCE = 0.4;
const EDGE_MATCH_FLOOR = 2;

export interface RasterImage {
  /** RGB(A) 像素，需與 canvas 尺寸一致（extract-text 已 normalize 成 canvas 大小）。 */
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 僅供遮罩 padding 依比例縮放。 */
  fontSize: number;
}

export interface OcrRefineOptions {
  /** 投影片的已知文字來源（大綱 content、layoutHint 等），逐行做模糊比對。 */
  sourceTexts: readonly string[];
  /** 原圖像素；提供時會以實際字墨校正每個框的字級與位置。 */
  image?: RasterImage;
  /** 字形量測器；預設用與合成同一條渲染路徑的量測器，測試可注入替身。 */
  metrics?: TextMetricsProvider;
}

/** 原圖字墨量測結果。 */
export interface InkMeasurement {
  /** 剔除邊緣細條後的字墨矩形；字級與位置對位都以它為準。 */
  ink: Rect;
  /**
   * 未剔除任何邊緣細條的字墨水平範圍。
   * 剔除是為了讓「原圖量到的」與「樣本量到的」是同一個量，但抹除遮罩要的是
   * 另一件事——把原圖上屬於這行文字的墨清乾淨。被剔掉的若是真字形，它仍在原圖上，
   * 遮罩必須蓋到它，否則行首／行尾會留下一條殘墨。
   */
  untrimmed: { x: number; width: number };
  /**
   * 邊緣被剔掉的細條寬度（px，0 表示沒剔）。
   * 剔除的可能是卡片分隔線（外來，該剔），也可能是 I／l／1 這類窄字形（該留）；
   * 兩者只差在寬度是否與該字串首／尾字形相符，所以寬度必須一路帶到量測端比對。
   * 少了這一步，以窄字形開頭或結尾的行會被系統性低估兩成。
   */
  dropped: { leading: number; trailing: number };
}

/** 對位所需的原圖證據，供字型定案後以最終字型重解一次幾何。 */
export interface InkGeometry extends InkMeasurement {
  /** 原始偵測框寬，作為字級聚類階段的「不溢出」上界。 */
  detectionWidth: number;
}

export interface RefineResult {
  boxes: EditableTextBox[];
  /**
   * 每個框的抹除遮罩範圍（偵測框 ∪ 字墨框）。渲染幾何被收緊後仍需把
   * 原始偵測範圍整塊抹掉，否則字緣殘影會留在背景上。
   */
  maskRects: Map<string, MaskRect>;
  /** 有量到字墨的框才有；`resnapWithFinalFonts` 用它以最終字型重解幾何。 */
  inkGeometry: Map<string, InkGeometry>;
}

interface FoldedText {
  /** NFKC 正規化並移除空白後的字元序列（比對用）。 */
  chars: readonly string[];
  /** folded 索引 → 原始字元索引，用於把命中的視窗還原成原文（保留原始空格）。 */
  map: readonly number[];
  original: readonly string[];
}

function fold(text: string): FoldedText {
  const original = [...text];
  const chars: string[] = [];
  const map: number[] = [];
  original.forEach((char, index) => {
    for (const part of char.normalize("NFKC")) {
      if (/\s/.test(part)) continue;
      chars.push(part);
      map.push(index);
    }
  });
  return { chars, map, original };
}

interface Window {
  distance: number;
  start: number;
  end: number;
}

// 子字串編輯距離（fitting alignment）：needle 對 hay 任意連續視窗的最小編輯距離。
// hay 為單行大綱文字（不跨行比對），規模皆在數十～數百字元，O(n·m) 足夠。
function bestWindow(needle: readonly string[], hay: readonly string[]): Window | null {
  const n = needle.length;
  const m = hay.length;
  if (!n || !m) return null;
  let prev = new Array<number>(m + 1).fill(0);
  let prevStart = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0);
    const curStart = new Array<number>(m + 1).fill(0);
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const substitution = (prev[j - 1] ?? 0) + (needle[i - 1] === hay[j - 1] ? 0 : 1);
      const deletion = (prev[j] ?? 0) + 1;
      const insertion = (cur[j - 1] ?? 0) + 1;
      let best = substitution;
      let start = prevStart[j - 1] ?? 0;
      // 平手時偏好較早的起點（較長視窗）：頭尾誤認字走「替換」而非「刪除」，
      // 否則像「将代理…」的首字或「…診斷一」的尾字會被整個吃掉。
      if (deletion < best || (deletion === best && (prevStart[j] ?? 0) < start)) {
        best = deletion;
        start = prevStart[j] ?? 0;
      }
      if (insertion < best || (insertion === best && (curStart[j - 1] ?? 0) < start)) {
        best = insertion;
        start = curStart[j - 1] ?? 0;
      }
      cur[j] = best;
      curStart[j] = start;
    }
    prev = cur;
    prevStart = curStart;
  }
  let bestEnd = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestLength = Number.POSITIVE_INFINITY;
  for (let j = 1; j <= m; j++) {
    const distance = prev[j] ?? Number.POSITIVE_INFINITY;
    const length = j - (prevStart[j] ?? 0);
    if (distance < bestDistance || (distance === bestDistance && length > bestLength)) {
      bestDistance = distance;
      bestLength = length;
      bestEnd = j;
    }
  }
  if (bestEnd < 0) return null;
  return { distance: bestDistance, start: prevStart[bestEnd] ?? 0, end: bestEnd };
}

// 視窗尾端緊接的全形標點（OCR 常漏抓行尾的 。｜，等）最多補回兩個，
// 讓合成結果與原設計一致，也讓遮罩能蓋到這些殘留字墨。
const TRAILING_PUNCT = /[。，、；：！？]/;

export interface CorrectedText {
  text: string;
  /** 從來源補回的行尾全形標點數（呼叫端需按 1em/字放寬框寬）。 */
  appendedChars: number;
}

/**
 * 以投影片已知文字為錨，校正 OCR 誤認字。
 * PaddleOCR（lang=ch）常把繁體認成簡體（將→将、結→结）、破折號認成「一」、
 * 並吃掉設計上的空格；大綱文字是這張圖的生成來源，命中時直接採用來源片段。
 */
export function correctTextFromSources(
  text: string,
  sources: readonly FoldedText[],
): CorrectedText {
  const unchanged = { text, appendedChars: 0 };
  const needle = fold(text);
  if (needle.chars.length < 2) return unchanged;
  let best: (Window & { line: FoldedText }) | null = null;
  for (const line of sources) {
    const window = bestWindow(needle.chars, line.chars);
    if (!window) continue;
    if (window.distance / needle.chars.length > MAX_ERROR_RATIO) continue;
    if (!best || window.distance < best.distance) best = { ...window, line };
  }
  if (!best || best.end <= best.start) return unchanged;
  let end = best.end;
  let appendedChars = 0;
  while (
    needle.chars.length >= 4 &&
    appendedChars < 2 &&
    end < best.line.chars.length &&
    TRAILING_PUNCT.test(best.line.original[best.line.map[end] ?? -1] ?? "")
  ) {
    end += 1;
    appendedChars += 1;
  }
  const from = best.line.map[best.start];
  const to = best.line.map[end - 1];
  if (from === undefined || to === undefined) return unchanged;
  const replacement = best.line.original
    .slice(from, to + 1)
    .join("")
    .trim();
  return replacement ? { text: replacement, appendedChars } : unchanged;
}

function foldSources(sourceTexts: readonly string[]): FoldedText[] {
  return sourceTexts
    .flatMap((source) => source.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .map(fold);
}

// CJK／全形／箭頭等佔滿 em 寬的字元。
const WIDE_CHAR =
  /[\u1100-\u115F\u2000-\u206F\u2190-\u21FF\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

// 粗估整行的前進寬（em）：CJK 取 0.99em/字，拉丁與數字取常見比例近似。
// **只給 splitMergedBox 用**：拆框發生在讀取原圖之前（同步、且只需要「左右兩段
// 尺寸差很多嗎」這種粗略比較），±10% 誤差可接受。字級對位不得再用它——那正是
// 舊實作把唯一可信的寬度證據判成「不可信」的原因（實測 12.68 vs 實際 9.68 em）。
function advanceUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    if (WIDE_CHAR.test(char)) units += 0.99;
    else if (/\s/.test(char)) units += 0.26;
    else if (/[0-9]/.test(char)) units += 0.556;
    else if (/[A-Z]/.test(char)) units += 0.72;
    else if (/[a-z]/.test(char)) units += 0.5;
    else units += 0.4;
  }
  return units;
}

/**
 * 拆開「標題｜內文」被偵測成同一框的情況（兩段字級不同時，
 * 合併框會讓內文以標題的大字級粗體渲染）。以 em 寬度反推右段字級，
 * 差距夠大才拆；來源文字裡的 ｜ 正是視覺分隔線的位置。
 */
export function splitMergedBox(box: EditableTextBox): EditableTextBox[] {
  if (box.text.includes("\n")) return [box];
  const separatorIndex = box.text.search(/[｜|]/);
  if (separatorIndex < 0) return [box];
  const left = box.text.slice(0, separatorIndex).trim();
  const right = box.text.slice(separatorIndex + 1).trim();
  if (!left) return right ? splitMergedBox({ ...box, text: right }) : [box];
  if (!right) return [{ ...box, text: left }];
  const leftUnits = advanceUnits(left);
  const rightUnits = advanceUnits(right);
  if (!leftUnits || !rightUnits) return [box];
  const gap = box.fontSize * 0.7; // 分隔線本體與左右留白
  const leftWidth = Math.min(box.width * 0.8, leftUnits * box.fontSize);
  const rightWidth = box.width - leftWidth - gap;
  if (rightWidth < 16) return [box];
  const rightFontSize = Math.max(10, Math.min(box.fontSize, rightWidth / rightUnits));
  if (rightFontSize >= box.fontSize * SPLIT_MIN_RATIO) return [box];
  const rightHeight = Math.max(8, rightFontSize / FONT_HEIGHT_RATIO);
  const rightBox: EditableTextBox = {
    ...box,
    id: randomUUID(),
    text: right,
    x: box.x + leftWidth + gap,
    // 這類卡片版式的內文行與大字標題垂直置中對齊（實測與 baseline 對齊等價）；
    // 有影像時後續的字墨對位還會再精修。
    y: Math.max(0, box.y + (box.height - rightHeight) / 2),
    width: rightWidth,
    height: rightHeight,
    fontSize: rightFontSize,
    fontWeight: rightFontSize >= BOLD_FONT_SIZE ? 700 : 400,
  };
  return [{ ...box, text: left, width: leftWidth }, ...splitMergedBox(rightBox)];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pickBand(candidates: readonly InkBand[], center: number): InkBand | null {
  let best: InkBand | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const band of candidates) {
    const distance =
      center < band.start ? band.start - center : center >= band.end ? center - band.end + 1 : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = band;
    }
  }
  return best;
}

/**
 * 量測框內實際字墨範圍。偵測框帶著 unclip 外擴（高度普遍比字墨大 20–25%），
 * 直接以框高換算字級會系統性偏大、位置偏上偏左；字墨才是對位基準。
 * 以「列剖面選帶」排除上下鄰行滲入、「行剖面去邊緣細條」排除 ｜ 分隔線。
 */
export function measureInk(image: RasterImage, box: Rect & { fontSize: number }): Rect | null {
  return measureInkDetailed(image, box)?.ink ?? null;
}

/** `measureInk` 的完整結果：多回傳「剔除了哪幾邊」，供量測端以相同方式剔除樣本。 */
export function measureInkDetailed(
  image: RasterImage,
  box: Rect & { fontSize: number },
): InkMeasurement | null {
  const margin = INK_SEARCH_MARGIN;
  const x0 = Math.max(0, Math.floor(box.x - margin));
  const y0 = Math.max(0, Math.floor(box.y - margin));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width + margin));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height + margin));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const { data, channels, width } = image;
  const offset = (x: number, y: number) => (y * width + x) * channels;
  // 區域邊框像素的中位數當背景色（文字區的四周通常是留白）。
  const border: [number[], number[], number[]] = [[], [], []];
  const sampleAt = (x: number, y: number) => {
    const o = offset(x, y);
    border[0].push(data[o] ?? 0);
    border[1].push(data[o + 1] ?? 0);
    border[2].push(data[o + 2] ?? 0);
  };
  for (let x = x0; x < x1; x++) {
    sampleAt(x, y0);
    sampleAt(x, y1 - 1);
  }
  for (let y = y0; y < y1; y++) {
    sampleAt(x0, y);
    sampleAt(x1 - 1, y);
  }
  const background = border.map((values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 255;
  });
  const isInk = (x: number, y: number) => {
    const o = offset(x, y);
    return (
      Math.abs((data[o] ?? 0) - (background[0] ?? 255)) +
        Math.abs((data[o + 1] ?? 0) - (background[1] ?? 255)) +
        Math.abs((data[o + 2] ?? 0) - (background[2] ?? 255)) >
      INK_DELTA_SUM
    );
  };
  const columns = x1 - x0;
  const rows = y1 - y0;
  const thin = (band: InkBand) => band.end - band.start < box.fontSize * THIN_COMPONENT_EM;
  const selectRowBand = (skip: Uint8Array | null) => {
    const rowCounts = Array.from({ length: rows }, (_, row) => {
      let count = 0;
      for (let x = x0; x < x1; x++) if (!skip?.[x - x0] && isInk(x, y0 + row)) count += 1;
      return count;
    });
    const band = pickBand(inkBands(rowCounts, 2, 2), Math.round(box.y + box.height / 2) - y0);
    return band ? { band, rowCounts } : null;
  };
  let skip: Uint8Array | null = null;
  let selected = selectRowBand(null);
  const spansRegion = (band: InkBand) => band.start <= 1 && band.end >= rows - 1;
  const tooTall = (band: InkBand) => band.end - band.start > box.height * 1.2;
  // 選不出字墨帶、選出的帶頭尾都頂到搜尋區邊界、或高得離譜，通常是因為卡片邊框
  // 這種**縱向貫穿整個搜尋區**的細線：每一列都有墨，列剖面因此併成一整帶，不是
  // 高度超標被放棄（整框退回未精修的偵測框），就是把位置整個往上拉。字形不可能
  // 佔滿每一列，邊框會——只在這條路徑上把貫穿的細線排除後重選一次，乾淨的框不受影響。
  if (!selected || spansRegion(selected.band) || tooTall(selected.band)) {
    const spanning = Array.from({ length: columns }, (_, col) => {
      let count = 0;
      for (let y = y0; y < y1; y++) if (isInk(x0 + col, y)) count += 1;
      return count >= rows * RULE_ROW_COVERAGE ? 1 : 0;
    });
    const rules = inkBands(spanning, 1, 0).filter(thin);
    if (rules.length) {
      const mask = new Uint8Array(columns);
      for (const rule of rules) for (let col = rule.start; col < rule.end; col++) mask[col] = 1;
      const retried = selectRowBand(mask);
      // 排除細線後仍選不出合理字墨帶，代表它不是主因，維持原判。
      if (retried) {
        skip = mask;
        selected = retried;
      }
    }
  }
  if (!selected) return null;
  let rowBand = selected.band;
  // 細線處理完之後，帶仍貼到搜尋區邊緣（乾淨字墨不會——偵測框外還有 margin 的
  // 留白），代表吃進了鄰行——典型是行距緊時上一行的下伸部尾巴把兩行的列剖面
  // 橋接成同一帶。貼到哪一邊，污染就來自哪一邊：從那一邊往內走，越過（可能存在
  // 的）鄰行字身，切在第一個低墨谷的內側。乾淨的帶不會觸發，行為不變。
  {
    const { rowCounts } = selected;
    let peak = 0;
    for (let row = rowBand.start; row < rowBand.end; row++)
      peak = Math.max(peak, rowCounts[row] ?? 0);
    const valley = Math.max(2, peak * TRIM_VALLEY_RATIO);
    const isValley = (row: number) => (rowCounts[row] ?? 0) < valley;
    if (rowBand.end >= rows - 1 && rowBand.start > 1) {
      // 底邊受污染：由下往上找到第一段谷，帶的新底邊是谷的上緣。
      let cut = rowBand.end - 1;
      while (cut > rowBand.start && !isValley(cut)) cut -= 1;
      while (cut > rowBand.start && isValley(cut)) cut -= 1;
      if (cut > rowBand.start) rowBand = { start: rowBand.start, end: cut + 1 };
    } else if (rowBand.start <= 1 && rowBand.end < rows - 1) {
      // 頂邊受污染：由上往下找到第一段谷，帶的新頂邊是谷的下緣。
      let cut = rowBand.start;
      while (cut < rowBand.end - 1 && !isValley(cut)) cut += 1;
      while (cut < rowBand.end - 1 && isValley(cut)) cut += 1;
      if (cut < rowBand.end - 1) rowBand = { start: cut, end: rowBand.end };
    }
  }
  if (rowBand.end - rowBand.start < 8 || tooTall(rowBand)) return null;
  const inkTop = y0 + rowBand.start;
  const inkHeight = rowBand.end - rowBand.start;
  const colCounts = Array.from({ length: columns }, (_, col) => {
    if (skip?.[col]) return 0;
    let count = 0;
    for (let y = inkTop; y < inkTop + inkHeight; y++) if (isInk(x0 + col, y)) count += 1;
    return count;
  });
  // 行方向用細顆粒切成字元級元件，再丟掉貼在邊緣的細條
  //（被切到的分隔線、鄰框滲入的筆畫殘邊），避免污染寬度估計。
  const components = inkBands(colCounts, 1, componentGapPx(box.fontSize));
  const dropped = { leading: 0, trailing: 0 };
  // 剔除前先記下完整範圍：遮罩要蓋的是原圖上的墨，不是收緊後的量測範圍。
  const rawFirst = components[0];
  const rawLast = components[components.length - 1];
  const first = components[0];
  if (components.length >= 2 && first && thin(first)) {
    components.shift();
    dropped.leading = first.end - first.start;
  }
  const last = components[components.length - 1];
  if (components.length >= 2 && last && thin(last)) {
    components.pop();
    dropped.trailing = last.end - last.start;
  }
  const head = components[0];
  const tail = components[components.length - 1];
  if (!head || !tail || !rawFirst || !rawLast) return null;
  const inkLeft = x0 + head.start;
  const inkWidth = tail.end - head.start;
  if (inkWidth < box.fontSize * 0.25) return null;
  return {
    ink: { x: inkLeft, y: inkTop, width: inkWidth, height: inkHeight },
    untrimmed: { x: x0 + rawFirst.start, width: rawLast.end - rawFirst.start },
    dropped,
  };
}

interface Solution {
  box: EditableTextBox;
  /**
   * 各邊的剔除**經過驗證後**的結論：true 表示該邊剔掉的細條確實是這串字的字形
   * （量測端也照樣剔），false 表示它是外來的分隔線／邊框（量測端不剔）。
   * 抹除遮罩據此決定要不要往外蓋回被剔掉的那一段。
   */
  drop: EdgeDrop;
  /**
   * 寬度反推的字級與高度反推的字級相差多少（相對值）。
   * 量測乾淨且字重猜對時兩者一致；字重猜錯會差一個字重寬度比（Arial 約 7%），
   * 量測被污染則會差更多——所以它同時是污染偵測器與字重的裁判。
   */
  mismatch: number;
}

interface EdgeDrop {
  leading: boolean;
  trailing: boolean;
}

function glyphRequest(
  box: EditableTextBox,
  fontWeight: number,
  fontSize: number,
  drop: EdgeDrop,
): TextMetricsRequest {
  // 量測的字串必須與最終渲染的字串完全一致（含前導空白），否則 bearing／前進寬
  // 對不上；whitespace-only 的框在呼叫端就已經略過對位。
  return {
    text: box.text,
    fontFamily: box.fontFamily,
    fontWeight,
    lineHeight: box.lineHeight,
    // EditableTextBox 的字距是 px、量測端是 em，換算需要字級。
    letterSpacing: box.letterSpacing / Math.max(1, fontSize),
    dropLeading: drop.leading,
    dropTrailing: drop.trailing,
  };
}

/**
 * 以「原圖剔除了哪幾邊」量出對應的 metrics。
 *
 * 原圖剔掉的邊緣細條有兩種身分：卡片分隔線（外來，剔對了）與 I／l／1 這類窄字形
 * （是這串字的一部分，剔了就等於兩邊量的不是同一個量，字級直接掉兩成）。
 * 分辨方式是拿它的寬度跟「該字串首／尾字形在同一比例下該有的寬度」比對——
 * 分隔線與字形的寬度差一個數量級，比不上就把該邊的剔除撤回。
 */
async function measureAgainstInk(
  box: EditableTextBox,
  ink: Rect,
  metrics: TextMetricsProvider,
  fontWeight: number,
  dropped: InkMeasurement["dropped"],
  fontSize: number,
): Promise<{ glyph: GlyphMetrics; drop: EdgeDrop }> {
  const drop: EdgeDrop = { leading: dropped.leading > 0, trailing: dropped.trailing > 0 };
  const glyph = await metrics.measure(glyphRequest(box, fontWeight, fontSize, drop));
  if (!drop.leading && !drop.trailing) return { glyph, drop };
  const scale = ink.width / glyph.inkWidth;
  const belongs = (actual: number, expected: number) =>
    Math.abs(actual - expected * scale) <=
    Math.max(EDGE_MATCH_FLOOR, expected * scale * EDGE_MATCH_TOLERANCE);
  const verified: EdgeDrop = {
    leading: drop.leading && belongs(dropped.leading, glyph.leadComponent),
    trailing: drop.trailing && belongs(dropped.trailing, glyph.tailComponent),
  };
  if (verified.leading === drop.leading && verified.trailing === drop.trailing)
    return { glyph, drop };
  return {
    glyph: await metrics.measure(glyphRequest(box, fontWeight, fontSize, verified)),
    drop: verified,
  };
}

/**
 * 以字墨反推渲染幾何，使 librsvg 合成結果與原圖對位。
 *
 * 字級**以寬度為主錨**：`fontSize = 字墨寬 ÷ 該字串在同一渲染路徑下的字墨寬（em）`。
 * 字墨「高度」不是字級的可靠證據——同一條渲染路徑下，有下伸部的
 * 「AI-Ready API Security」字墨高 0.95em，沒有下伸部的「MCP / Tool Allow-list」只有
 * 0.75em；用固定常數除會讓前者的字級高估近三成，整行溢出框。高度在這裡只當
 * 獨立證據：量到的字墨高若與「寬度反推的字級 × 該字串字墨高比例」差太多，
 * 代表字墨帶吃進了鄰行／分隔線／卡片邊框，才退回高度估計並取較小值
 *（寧可略小也不要重現「字偏大」）；同一個差距也用來裁決字重（見 `snapBoxToInk`）。
 *
 * 幾何全部以量到的 metrics 反推，因此框寬正好等於渲染前進寬、框高正好等於行框高：
 * 之後不論 align／verticalAlign 被樣式精修改成什麼，文字都渲染在同一個位置。
 */
async function solveBoxGeometry(
  box: EditableTextBox,
  ink: Rect,
  metrics: TextMetricsProvider,
  fontWeight: number,
  dropped: InkMeasurement["dropped"],
): Promise<Solution> {
  let estimate = Math.max(1, box.fontSize);
  const resolved = await measureAgainstInk(box, ink, metrics, fontWeight, dropped, estimate);
  const drop = resolved.drop;
  let glyph = resolved.glyph;
  let widthBased = ink.width / glyph.inkWidth;
  for (let pass = 1; box.letterSpacing && pass < LETTER_SPACING_PASSES; pass++) {
    if (Math.abs(widthBased - estimate) <= estimate * 0.005) break;
    estimate = widthBased;
    glyph = await metrics.measure(glyphRequest(box, fontWeight, estimate, drop));
    widthBased = ink.width / glyph.inkWidth;
  }
  const heightBased = ink.height / glyph.inkHeight;
  const mismatch = Math.abs(widthBased - heightBased) / widthBased;
  // 字級以寬度為主錨；只有在高度證據明顯對不上（字墨帶吃進鄰行／分隔線／邊框）時
  // 才退回較小者。這裡沒有其他上界夾制：字級既然是由量到的字墨寬反推，渲染出來
  // 的字墨寬必然回到原本的字墨寬，「溢出」在寬度錨定下不是這一步會發生的事。
  const fontSize = Math.max(
    10,
    mismatch > HEIGHT_MISMATCH_TOLERANCE ? Math.min(widthBased, heightBased) : widthBased,
  );
  return {
    mismatch,
    drop,
    box: {
      ...box,
      fontSize,
      x: Math.max(0, ink.x - glyph.bearing * fontSize),
      y: Math.max(0, ink.y - glyph.inkTop * fontSize),
      width: glyph.advance * fontSize,
      height: fontSize * box.lineHeight,
      fontWeight,
    },
  };
}

async function snapBoxToInk(
  box: EditableTextBox,
  geometry: InkMeasurement,
  metrics: TextMetricsProvider,
  deriveWeight: boolean,
): Promise<Solution> {
  const first = await solveBoxGeometry(
    box,
    geometry.ink,
    metrics,
    box.fontWeight,
    geometry.dropped,
  );
  if (!deriveWeight) return first;
  const weight = first.box.fontSize >= BOLD_FONT_SIZE ? 700 : 400;
  if (weight === box.fontWeight) return first;
  const flipped = await solveBoxGeometry(box, geometry.ink, metrics, weight, geometry.dropped);
  // 字重會改變前進寬（Arial Bold 比 Regular 寬約 7%），所以翻轉字重就一定會改變字級。
  // 直接採用翻轉結果會得到「用 Bold metrics 算出來的字級」配上一個依同一條啟發式
  // 應該是 Regular 的字級——兩者互不支持，實測在門檻附近讓字級低估 6–11%。
  // 高度幾乎不隨字重改變，是這裡唯一可用的獨立證據：選寬度與高度兩條反推最一致的那個字重。
  return flipped.mismatch < first.mismatch ? flipped : first;
}

/**
 * 將字級依相對容差聚類並貼齊各群的加權中位數。
 * 逐框估計的字級有 ±10% 抖動，會讓同層級標題出現 42～51px 的落差；
 * 貼齊後同層級文字字級一致。
 *
 * **不改字重**：字重會改變前進寬，改了就必須以新字重重解幾何才自洽，而這裡
 * 拿不到量測器。過去在這裡依貼齊後的字級重定字重，會把字墨證據解出的字重
 * 翻掉，留下「用粗體算出來的字級」配「常規字重」的組合，兩邊都不對。
 */
export function normalizeFontSizes(
  boxes: readonly EditableTextBox[],
  ratio: number = CLUSTER_RATIO_DETECTION,
): EditableTextBox[] {
  if (boxes.length < 2) return [...boxes];
  const sorted = boxes
    .map((box, index) => ({ box, index }))
    .sort((a, b) => a.box.fontSize - b.box.fontSize);
  const snapped = new Map<number, number>();
  let cluster: { box: EditableTextBox; index: number }[] = [];
  const flush = () => {
    if (cluster.length >= 2) {
      // 以字元數加權取中位數，讓文字量大的主流層級決定貼齊目標。
      const weighted = cluster
        .flatMap(({ box }) =>
          Array.from({ length: Math.max(1, box.text.length) }, () => box.fontSize),
        )
        .sort((a, b) => a - b);
      const median = weighted[Math.floor(weighted.length / 2)];
      if (median !== undefined) for (const { index } of cluster) snapped.set(index, median);
    }
    cluster = [];
  };
  for (const entry of sorted) {
    // 容差錨定在群組最小值而非前一個元素：單鏈合併會讓落在兩層級之間的
    // 少數框（副標、被灌水的估計）把內文與標題「橋接」成同一群。
    const first = cluster[0];
    if (first && entry.box.fontSize > first.box.fontSize * ratio) flush();
    cluster.push(entry);
  }
  flush();
  return boxes.map((box, index) => {
    const fontSize = snapped.get(index);
    if (fontSize === undefined || fontSize === box.fontSize) return box;
    return { ...box, fontSize };
  });
}

/**
 * 抹除遮罩範圍：垂直取「偵測框 ∪ 字墨」確保上下緣殘墨清乾淨；
 * 水平以字墨為準——偵測框的 unclip 外擴常吃到緊鄰的「｜」卡片分隔線，
 * 用偵測框當遮罩會把設計元素抹掉（或抹一半留殘影）。
 *
 * 但字墨量測會剔除邊緣細條，而細條有兩種身分：外來的分隔線（不可抹）與
 * I／l／1 這類窄字形（必須抹，否則行首／行尾留一條殘墨）。`drop` 帶的正是
 * 驗證後的結論，所以只在「剔掉的是真字形」那一邊把範圍還原成未剔除的字墨。
 */
function maskRect(
  detection: Rect,
  ink: Rect,
  untrimmed: InkMeasurement["untrimmed"],
  drop: EdgeDrop,
): Rect {
  const y = Math.min(detection.y, ink.y);
  const left = drop.leading ? Math.min(ink.x, untrimmed.x) : ink.x;
  const right = drop.trailing
    ? Math.max(ink.x + ink.width, untrimmed.x + untrimmed.width)
    : ink.x + ink.width;
  return {
    x: left,
    y,
    width: right - left,
    height: Math.max(detection.y + detection.height, ink.y + ink.height) - y,
  };
}

/**
 * 貼齊字級後再夾一次「不溢出」：聚類會把字級往上拉（實測 42.55 → 44.59），
 * 拉過頭的框整行就會超出原本的排版寬度。會溢出的框不參與貼齊、維持自己的字級；
 * 接受貼齊的框則以新字級重解幾何，讓框寬／框高與新字級保持一致。
 */
async function finalizeFontSizes(
  snapped: readonly EditableTextBox[],
  inkGeometry: ReadonlyMap<string, InkGeometry>,
  metrics: TextMetricsProvider,
  ratio: number,
): Promise<EditableTextBox[]> {
  const clustered = normalizeFontSizes(snapped, ratio);
  return Promise.all(
    clustered.map(async (target, index) => {
      const before = snapped[index];
      if (!before || target.fontSize === before.fontSize) return before ?? target;
      const geometry = inkGeometry.get(target.id);
      if (!geometry) return target;
      const { glyph } = await measureAgainstInk(
        target,
        geometry.ink,
        metrics,
        target.fontWeight,
        geometry.dropped,
        target.fontSize,
      );
      // 貼齊只能往上拉到「原本的字級」或「偵測框裝得下的字級」為止，
      // 兩者取大：偵測框帶著 unclip 外擴，硬用它壓會把字墨證據壓掉。
      const clusterCeiling = Math.max(before.fontSize, geometry.detectionWidth / glyph.advance);
      if (target.fontSize > clusterCeiling) return before;
      return {
        ...target,
        x: Math.max(0, geometry.ink.x - glyph.bearing * target.fontSize),
        y: Math.max(0, geometry.ink.y - glyph.inkTop * target.fontSize),
        width: glyph.advance * target.fontSize,
        height: target.fontSize * target.lineHeight,
      };
    }),
  );
}

/**
 * 樣式精修定案 fontFamily／fontWeight 之後，用**最終字型**重解一次字級與位置。
 * 沿用第一輪已量到的字墨幾何（原圖證據不變），只換 metrics 重算——否則就會出現
 * 「用 Arial 的假設算字級，最後卻以 Noto Sans TC 渲染」這種算繪不一致的跑版。
 * 字重由呼叫端（模型）定案，這裡不再用字級啟發式覆寫。
 */
export async function resnapWithFinalFonts(
  boxes: readonly EditableTextBox[],
  inkGeometry: ReadonlyMap<string, InkGeometry>,
  options: { metrics?: TextMetricsProvider } = {},
): Promise<EditableTextBox[]> {
  const metrics = options.metrics ?? defaultTextMetrics;
  const snapped = await Promise.all(
    boxes.map(async (box) => {
      const geometry = inkGeometry.get(box.id);
      if (!geometry || !box.text.trim()) return box;
      return (await snapBoxToInk(box, geometry, metrics, false)).box;
    }),
  );
  return finalizeFontSizes(
    snapped,
    inkGeometry,
    metrics,
    inkGeometry.size ? CLUSTER_RATIO_INK : CLUSTER_RATIO_DETECTION,
  );
}

export interface StyleRefinementOutcome {
  boxes: EditableTextBox[];
  /** 重解幾何失敗的原因；呼叫端必須記錄，不可靜默丟掉。 */
  resnapError?: string;
}

/**
 * 把模型判定的樣式（role／color／fontFamily／字重／對齊）落地，再以最終字型重解幾何。
 *
 * 兩者是**獨立**的：樣式是模型的判定結果，重解只是幾何精度。過去兩件事共用同一個
 * try/catch，重解失敗（例如字型環境壞掉丟 TEXT_METRICS_NO_INK）會讓整批 role 一起
 * 遺失、所有框退回 presentation——抹除遮罩就會把 logo 與插圖裡的數字徽章一併抹掉，
 * 而使用者端沒有任何訊號。這裡確保樣式先落地，重解失敗只讓幾何停在精修後的狀態。
 */
export async function applyStyleRefinement(
  boxes: readonly EditableTextBox[],
  styles: ReadonlyMap<string, Partial<EditableTextBox>>,
  inkGeometry: ReadonlyMap<string, InkGeometry>,
  options: { metrics?: TextMetricsProvider } = {},
): Promise<StyleRefinementOutcome> {
  const styled = boxes.map((box) => {
    const style = styles.get(box.id);
    return style ? { ...box, ...style } : box;
  });
  try {
    return { boxes: await resnapWithFinalFonts(styled, inkGeometry, options) };
  } catch (error) {
    return {
      boxes: styled,
      resnapError: error instanceof Error ? error.message : "UnknownError",
    };
  }
}

/**
 * OCR 框的確定性後處理：來源錨定文字校正 → 合併框拆分 → 字墨對位 → 字級聚類。
 * 不依賴外部服務；沒有來源時跳過校正，沒有影像時跳過對位。
 * maskRects 保留每框的「偵測範圍 ∪ 字墨範圍」，抹除遮罩必須用它而非收緊後的
 * 渲染框，否則偵測框邊緣的殘墨會留在背景上。
 */
export async function refineOcrBoxes(
  boxes: readonly EditableTextBox[],
  options: OcrRefineOptions,
): Promise<RefineResult> {
  const sources = foldSources(options.sourceTexts);
  // 先拆一次：OCR 會把「編號徽章｜問句」「標題｜內文」併進同一框。若整框直接去對位來源，
  // 完全命中的長段（問句）會稀釋短前綴（徽章「01」）的誤差，讓校正把 OCR 已正確辨識的
  // 編號改寫成來源的鄰詞（「研究主線」→「主線」）。拆開後逐段各自錨定，徽章在大綱裡找不到
  // 匹配便原封保留，問句照常校正。
  const preSplit = boxes.flatMap((box) => splitMergedBox(box));
  const corrected = preSplit.map((box) => {
    if (!sources.length) return box;
    const { text, appendedChars } = correctTextFromSources(box.text, sources);
    // 補回的行尾標點在原圖上緊接在偵測框右緣之外，放寬框寬讓量測與遮罩蓋到。
    return { ...box, text, width: box.width + appendedChars * box.fontSize };
  });
  // 再拆一次：校正可能還原被 OCR 吃掉的分隔線（｜ 認成「一」或整個漏掉），此時才拆得開。
  const split = corrected.flatMap((box) => splitMergedBox(box));
  const metrics = options.metrics ?? defaultTextMetrics;
  const maskRects = new Map<string, MaskRect>();
  const inkGeometry = new Map<string, InkGeometry>();
  const snapped = await Promise.all(
    split.map(async (box) => {
      const detectionRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      let measured =
        options.image && box.text.trim() && !box.text.includes("\n") && !box.rotation
          ? measureInkDetailed(options.image, box)
          : null;
      let result = box;
      // 沒有量到字墨時遮罩退回偵測框，此時沒有任何剔除可言。
      let drop: EdgeDrop = { leading: false, trailing: false };
      if (measured) {
        try {
          const solution = await snapBoxToInk(box, measured, metrics, true);
          result = solution.box;
          drop = solution.drop;
        } catch (error) {
          // 字形量測失敗（多半是伺服器缺 CJK fallback 這種字型環境問題）只該讓
          // 這一框退回未精修的偵測框幾何，不該讓整頁抽離文字失敗——使用者拿不到
          // 任何結果，比拿到略粗的幾何糟得多。錯誤仍往上拋一份訊息給呼叫端記錄。
          console.error("OCR ink snapping failed; falling back to detection geometry", {
            id: box.id,
            reason: error instanceof Error ? error.message : "UnknownError",
          });
          measured = null;
        }
      }
      if (measured) inkGeometry.set(box.id, { ...measured, detectionWidth: box.width });
      const mask = measured
        ? maskRect(detectionRect, measured.ink, measured.untrimmed, drop)
        : detectionRect;
      maskRects.set(box.id, { ...mask, fontSize: result.fontSize });
      return result;
    }),
  );
  return {
    boxes: await finalizeFontSizes(
      snapped,
      inkGeometry,
      metrics,
      options.image ? CLUSTER_RATIO_INK : CLUSTER_RATIO_DETECTION,
    ),
    maskRects,
    inkGeometry,
  };
}

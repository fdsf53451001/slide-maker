import { randomUUID } from "node:crypto";
import type { EditableTextBox } from "@slide-maker/core";

// 與 text-layers.ts boxesFromOcr 的估計一致：fontSize ≈ 偵測框高 × 0.78。
const FONT_HEIGHT_RATIO = 0.78;
// boxesFromOcr 以框高 52px 為粗體門檻，換算成 fontSize 即 52 × 0.78。
const BOLD_FONT_SIZE = 52 * FONT_HEIGHT_RATIO;
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

// 合成端（librsvg + fontconfig CJK fallback）實測字墨 metrics：
// 以 textOverlaySvg 在 fontSize=100、lineHeight=1.2 白底渲染後量得。
// 不同機器的 CJK fallback 字型略有差異，但表意文字的設計空間相當一致（±2%）。
const RENDER = {
  cjkInkHeight: 0.94, // 字墨高 ÷ fontSize
  cjkInkTop: 0.12, // 框頂到字墨頂 ÷ fontSize（含 lineHeight 1.2 的 half-leading）
  cjkBearing: 0.05, // 首個 CJK 字元的左側留白 ÷ fontSize
  latinInkHeight: 0.74,
  latinInkTop: 0.22,
  latinBearing: 0.02,
} as const;

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
}

export interface RefineResult {
  boxes: EditableTextBox[];
  /**
   * 每個框的抹除遮罩範圍（偵測框 ∪ 字墨框）。渲染幾何被收緊後仍需把
   * 原始偵測範圍整塊抹掉，否則字緣殘影會留在背景上。
   */
  maskRects: Map<string, MaskRect>;
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

// 估算整行的前進寬（em）：CJK 實測 0.99em/字，拉丁與數字取常見比例近似。
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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Band {
  start: number;
  end: number; // exclusive
}

function bands(counts: readonly number[], minCount: number, maxGap: number): Band[] {
  const result: Band[] = [];
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

function pickBand(candidates: readonly Band[], center: number): Band | null {
  let best: Band | null = null;
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
  const margin = 6;
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
      90
    );
  };
  const rowCounts = Array.from({ length: y1 - y0 }, (_, row) => {
    let count = 0;
    for (let x = x0; x < x1; x++) if (isInk(x, y0 + row)) count += 1;
    return count;
  });
  const rowBand = pickBand(bands(rowCounts, 2, 2), Math.round(box.y + box.height / 2) - y0);
  if (!rowBand) return null;
  const inkTop = y0 + rowBand.start;
  const inkHeight = rowBand.end - rowBand.start;
  if (inkHeight < 8 || inkHeight > box.height * 1.2) return null;
  const colCounts = Array.from({ length: x1 - x0 }, (_, col) => {
    let count = 0;
    for (let y = inkTop; y < inkTop + inkHeight; y++) if (isInk(x0 + col, y)) count += 1;
    return count;
  });
  // 行方向用細顆粒切成字元級元件，再丟掉貼在邊緣的細條
  //（被切到的分隔線、鄰框滲入的筆畫殘邊），避免污染寬度估計。
  const components = bands(colCounts, 1, Math.max(3, Math.round(box.fontSize * 0.08)));
  const thin = (band: Band) => band.end - band.start < box.fontSize * 0.12;
  const first = components[0];
  if (components.length >= 2 && first && thin(first)) components.shift();
  const last = components[components.length - 1];
  if (components.length >= 2 && last && thin(last)) components.pop();
  const head = components[0];
  const tail = components[components.length - 1];
  if (!head || !tail) return null;
  const inkLeft = x0 + head.start;
  const inkWidth = tail.end - head.start;
  if (inkWidth < box.fontSize * 0.25) return null;
  return { x: inkLeft, y: inkTop, width: inkWidth, height: inkHeight };
}

/**
 * 以字墨反推渲染幾何，使 librsvg 合成結果與原圖對位：
 * 行寬對齊最影響觀感，因此字級優先取「行寬 ÷ 前進寬」；但寬度估計可能被
 * 灌水（校正後文字比圖上少了空格、量到非文字筆畫），只在字墨高估計的
 * 合理區間內才採信，否則回退高度估計。兩者皆可信時取較小值——renderer 的
 * CJK 字墨（0.94em）在常見字型中偏大，寧可略小也不要重現「字偏大」。
 */
function snapBoxToInk(box: EditableTextBox, ink: Rect): EditableTextBox {
  // 字墨「高度」由整行最高的字種決定：CJK／全形字撐滿 em box，拉丁大寫僅約 0.72em。
  // 因此只要行內含任一全高字元，量到的字墨高就對應 CJK 尺度，須用 cjk 除數與頂距；
  // 用「多數決」會把「Kimi K3 模型研究」這種混排行誤判為拉丁，字級高估近三成。
  const cjk = WIDE_CHAR.test(box.text);
  const heightBased = ink.height / (cjk ? RENDER.cjkInkHeight : RENDER.latinInkHeight);
  const units = advanceUnits(box.text.trim());
  const widthBased = units > 0.5 ? ink.width / units : heightBased;
  const widthTrusted = widthBased >= heightBased * 0.85 && widthBased <= heightBased * 1.15;
  const fontSize = Math.max(10, widthTrusted ? Math.min(widthBased, heightBased) : heightBased);
  const firstChar = box.text.trim().charAt(0);
  const bearing = WIDE_CHAR.test(firstChar) ? RENDER.cjkBearing : RENDER.latinBearing;
  return {
    ...box,
    fontSize,
    x: Math.max(0, ink.x - bearing * fontSize),
    y: Math.max(0, ink.y - (cjk ? RENDER.cjkInkTop : RENDER.latinInkTop) * fontSize),
    width: ink.width + fontSize * 0.1,
    height: fontSize * box.lineHeight,
    fontWeight: fontSize >= BOLD_FONT_SIZE ? 700 : 400,
  };
}

/**
 * 將字級依相對容差聚類並貼齊各群的加權中位數。
 * 逐框估計的字級有 ±10% 抖動，會讓同層級標題出現 42～51px 的落差；
 * 貼齊後同層級文字字級一致，粗體判定也隨之穩定。
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
    return { ...box, fontSize, fontWeight: fontSize >= BOLD_FONT_SIZE ? 700 : 400 };
  });
}

/**
 * 抹除遮罩範圍：垂直取「偵測框 ∪ 字墨」確保上下緣殘墨清乾淨；
 * 水平只取字墨範圍——偵測框的 unclip 外擴常吃到緊鄰的「｜」卡片分隔線，
 * 用偵測框當遮罩會把設計元素抹掉（或抹一半留殘影），字墨量測本就會
 * 剔除邊緣細條，水平邊界以它為準。
 */
function maskRect(detection: Rect, ink: Rect): Rect {
  const y = Math.min(detection.y, ink.y);
  return {
    x: ink.x,
    y,
    width: ink.width,
    height: Math.max(detection.y + detection.height, ink.y + ink.height) - y,
  };
}

/**
 * OCR 框的確定性後處理：來源錨定文字校正 → 合併框拆分 → 字墨對位 → 字級聚類。
 * 不依賴外部服務；沒有來源時跳過校正，沒有影像時跳過對位。
 * maskRects 保留每框的「偵測範圍 ∪ 字墨範圍」，抹除遮罩必須用它而非收緊後的
 * 渲染框，否則偵測框邊緣的殘墨會留在背景上。
 */
export function refineOcrBoxes(
  boxes: readonly EditableTextBox[],
  options: OcrRefineOptions,
): RefineResult {
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
  const maskRects = new Map<string, MaskRect>();
  const snapped = split.map((box) => {
    const detectionRect = { x: box.x, y: box.y, width: box.width, height: box.height };
    const ink =
      options.image && !box.text.includes("\n") && !box.rotation
        ? measureInk(options.image, box)
        : null;
    const result = ink ? snapBoxToInk(box, ink) : box;
    const mask = ink ? maskRect(detectionRect, ink) : detectionRect;
    maskRects.set(box.id, { ...mask, fontSize: result.fontSize });
    return result;
  });
  return {
    boxes: normalizeFontSizes(snapped, options.image ? CLUSTER_RATIO_INK : CLUSTER_RATIO_DETECTION),
    maskRects,
  };
}

import type { ResolvedTextRun } from "@slide-maker/core";
import type { RasterImage, Rect } from "./ocr-refine.js";

/**
 * 從原圖量出「這一框的每一段字實際上是什麼顏色」。
 *
 * 為什麼顏色不由模型給：實測（2026-08-18，CLI2Proxy／`gemini-3-flash-agent` 與
 * `gpt-5.6-luna`）文字模型報的顏色是**憑記憶說色票**而不是量像素——同一張 fixture 上
 * 它們一路吐 Tailwind 的 `#2563eb`／`#22c55e`／`#f59e0b`，平均 ΔE 2–7、最糟超過 100；
 * 同一批框用這裡的量法**每一段都逐位元命中真值**（`#ff6b35`、`#16a34a`、`#1d4ed8`、
 * `#facc15`），連 `#555555` 這種低對比的深灰都對，而模型在那一格給的是 `#6b7280`。
 *
 * 分工因此是：**模型定「換色落在第幾個字」，像素定「顏色是什麼」。** 模型知道
 * `AI Agent` 是一個詞、像素不知道；像素量得到 ΔE 0 的顏色、模型量不到。
 *
 * 相鄰段量到同色就合併，這是對抗模型幻覺的防線：模型偶爾會把單色行憑空切成兩段
 * （實測真的會發生），但兩段量出來的顏色一樣，合併後就回到單色。**不要**改成
 * 「像素自己找換色點、再去對齊模型的段」——那條路試過，抗鋸齒與字重差異會讓單色行
 * 分出第二群，反而把假分段確認成真的。
 */

/** 相鄰兩段的顏色差小於這個值就視為同一種顏色。 */
const MERGE_DELTA_E = 8;
/**
 * 極短段（`SHORT_RUN_CHARS` 個字以內）用這個較寬的門檻合併。
 *
 * 抖動幾乎都長成這樣：同一個框，這次回 `[[6,灰]]`、下次回 `[[1,淺灰],[5,灰]]`——模型對
 * 小字、低對比截圖的**第一個字元**判斷不穩。那一個字的顏色與鄰段本來就只差 ΔE 十幾，
 * 視覺上分不出來，卻讓兩次抽字的結果不同。門檻只在顏色相近時才吃得到，真正的強調色
 * （ΔE 30 以上）不受影響；代價是「整段只有一個字是相近色」這種罕見設計會被併掉。
 */
const SHORT_MERGE_DELTA_E = 18;
const SHORT_RUN_CHARS = 2;
/** 字墨判定：與背景的 Lab 距離門檻，取「離背景最遠者」的比例與絕對下限兩者取大。 */
const INK_RATIO = 0.55;
const INK_FLOOR = 18;
/**
 * 段內取色的核心比例，採「相對這一段自己峰值的距離」而不是「排名前 N%」，
 * 而且由嚴到寬依序嘗試，取第一個樣本數還夠的門檻——能拿多準就拿多準，樣本不夠才讓步。
 *
 * 實測（2026-08-22，`r19` 投影片的程式碼截圖行 `import { serve } from './server';`，
 * VS Code 語法高亮小字，字級僅 17px）抓出這條路的真實 bug：舊版「排名前 60%」是**依樣本
 * 總數**取窗，樣本一多（一個 40px 寬的字墨區塊有 300 個像素）窗口就跟著撐大，深入到
 * `distance≈18`（幾乎等於背景）的抗鋸齒邊緣像素，中位數被拉向背景——量到 `serve`（真值
 * `#9cdcfe`）變成 `#7094ba`，整條線八段顏色全部偏濁、偏暗，跟「字大時逐位元命中真值」
 * 的 fixture 結果差了一大截。改成相對峰值的比例：同一批像素，門檻抓緊到峰值的 80%
 * 就只剩 10 個樣本（太少，中位數不穩），退到 70% 有 40 個樣本、量到 `rgb(113,153,193)`
 * （ΔE 明顯縮小），這正是階梯式門檻要抓的平衡點——小字通常沒有真正「未被抗鋸齒污染」的
 * 純色像素（筆劃寬度本身只有幾個像素、鋸齒核心比例就佔掉大半），逼近但抓不到完美值是
 * 解析度限制，階梯的目的是在「準」與「樣本夠不夠穩」之間，每一段各自找最接近的平衡，
 * 而不是全部套同一個對長文字系統性太寬鬆的比例。
 */
const SPAN_CORE_RATIO_LADDER = [0.8, 0.7, 0.6, 0.5];
/**
 * 取色時每一段左右各內縮的比例。
 *
 * 段的 x 範圍是用「字元數佔比」估的，而中英混排時字寬差一倍（`Reduce cost by 42% in Q3`
 * 的 `42%` 佔 3/24 個字元卻不佔 12.5% 的寬度），估出來的邊界一定會偏。內縮讓取樣落在
 * 段的中段，邊界偏個一兩成也不會混進鄰段的顏色；配合中位數，少量污染也吃得掉。
 */
const INSET_RATIO = 0.18;
/** 一段至少要有這麼多個字墨像素才信得過。 */
const MIN_SAMPLE = 12;

export interface RunColorMeasurement {
  /** 量測後的分段：文字切法沿用模型，顏色換成實測值，相鄰同色已合併。 */
  runs: ResolvedTextRun[];
  /**
   * 這一框發生了什麼，供呼叫端記 log。
   * - `measured`：量到多種顏色，分段成立
   * - `merged`：模型給了多段，但像素量出來是同一種顏色，已合併回單色
   * - `single`：模型本來就只給一段
   * - `no-ink`：量不到字墨（框太小、字壓在複雜背景上），整框沿用模型的顏色
   * - `multiline`：多行框不做逐段定位（x 軸不是單調的），沿用模型的顏色
   */
  verdict: "measured" | "merged" | "single" | "no-ink" | "multiline";
}

interface Lab {
  l: number;
  a: number;
  b: number;
}

function toLab(r: number, g: number, b: number): Lab {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [f(r), f(g), f(b)];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const g_ = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [g_(x), g_(y), g_(z)];
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function labDistance(a: Lab, b: Lab): number {
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}

/**
 * 把 hex 顏色正規化成小寫。
 *
 * 不是美觀問題：模型會回 `#008E88` 這種大寫（實測 `gemini-3-flash-agent` 同一頁裡
 * 大小寫混著給），而顏色最後是以字串存進 `project.json`、也以字串比對「這兩段是不是
 * 同色」。少了這一步，`#008E88` 與 `#008e88` 會被當成兩種顏色，同一個框每抽一次
 * 就可能長得不一樣。
 */
export function normalizeHex(color: string): string {
  return color.toLowerCase();
}

/** 兩個 hex 顏色的感知距離（CIE76 ΔE）。 */
export function colorDistance(a: string, b: string): number {
  const parse = (value: string): Lab => {
    const n = Number.parseInt(value.slice(1), 16);
    return toLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  };
  return labDistance(parse(a), parse(b));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

interface InkPixel {
  x: number;
  r: number;
  g: number;
  b: number;
  distance: number;
  /** 這個像素是否被判為字墨（`collectPixels` 會回全部像素，`inkPixels` 才篩）。 */
  ink?: boolean;
}

/** 框內的全部像素（含每個像素離背景多遠）。 */
function collectPixels(image: RasterImage, rect: Rect): InkPixel[] {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
  if (x1 - x0 < 4 || y1 - y0 < 4) return [];
  const { data, channels, width } = image;
  const at = (x: number, y: number): [number, number, number] => {
    const offset = (y * width + x) * channels;
    return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
  };
  // 背景色取 ROI 四邊邊框像素的中位數（文字區四周通常是留白），與 `measureInk` 同一套。
  const border: [number[], number[], number[]] = [[], [], []];
  const sample = (x: number, y: number) => {
    const [r, g, b] = at(x, y);
    border[0].push(r);
    border[1].push(g);
    border[2].push(b);
  };
  for (let x = x0; x < x1; x++) {
    sample(x, y0);
    sample(x, y1 - 1);
  }
  for (let y = y0; y < y1; y++) {
    sample(x0, y);
    sample(x1 - 1, y);
  }
  const background = toLab(median(border[0]), median(border[1]), median(border[2]));
  const all: (InkPixel & { ink: boolean })[] = [];
  let maxDistance = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = at(x, y);
      const distance = labDistance(toLab(r, g, b), background);
      if (distance > maxDistance) maxDistance = distance;
      all.push({ x, r, g, b, distance, ink: false });
    }
  const threshold = Math.max(INK_FLOOR, maxDistance * INK_RATIO);
  return all.map((pixel) => ({ ...pixel, ink: pixel.distance >= threshold }));
}

/** 取出框內的字墨像素。 */
function inkPixels(image: RasterImage, rect: Rect): InkPixel[] {
  return collectPixels(image, rect).filter((pixel) => pixel.ink);
}

/**
 * 量不到字墨時的退路：取整框「離背景最遠的前 10%」像素的中位數。
 *
 * **不可**退回模型給的顏色。實測（10 張真實頁 × 5 次）不穩定的框幾乎全部出在這條路上：
 * 同一個框五次拿到 `#13979c`／`#0b6a61`／`#008E88`／`#004f42`／`#085452`——那是模型每次
 * 重猜一遍的結果，而使用者看到的是「同一頁抽兩次，顏色不一樣」。這裡的退路是確定性的：
 * 同一張圖同一個框永遠得到同一個值，就算那個值只是背景雜訊（那種框本來就沒有字）。
 */
function fallbackColor(image: RasterImage, rect: Rect): string | undefined {
  const all = collectPixels(image, rect);
  if (!all.length) return undefined;
  const sorted = [...all].sort((a, b) => b.distance - a.distance);
  const core = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1)));
  return hex(
    median(core.map((pixel) => pixel.r)),
    median(core.map((pixel) => pixel.g)),
    median(core.map((pixel) => pixel.b)),
  );
}

/**
 * 每軸粗量化成 16 階（`>> 4`）的格子數。太粗（例如 32 階）會把深淺相近的不同色系
 * 併成一格，太細（例如 4 階）會讓抗鋸齒噪訊各自佔一格、找不出真正的眾數。
 */
const MODE_BUCKET_SHIFT = 4;

/**
 * 眾數色：把像素粗量化成小格子，取「像素數最多的那一格」的中位數。
 *
 * 只在**模型宣稱這一框整段同色**（`modelRuns.length === 1`）時使用——這個宣稱可能是
 * 錯的（模型沒偵測到框內其實混著至少兩種顏色），而這種情況下中位數與「相對峰值階梯」
 * 兩種既有取色法都會系統性選錯：
 *
 * 實機根因（2026-08-22，`d56f8f92` 專案「公開產出提供交流入口，讓專業」這一行）——
 * 這行有 10 個黑字＋4 個紫字（「交流入口」），模型這次判成整行一段。逐像素查證：
 * 純中位數（每軸各自取中位）量到 `#34263a`（黑紫混出來的第三種顏色，兩邊都不是，
 * 逐軸獨立取中位數對雙峰分布本來就會失真）；「相對峰值階梯」量到 `#3f0c95`（紫），
 * 因為紫字對白底的 Lab 距離**剛好比黑字更大**（紫色的 a／b 色度差是黑色沒有的額外
 * 貢獻），階梯門檻既然是「相對這個池子自己的峰值」，門檻就被紫字定住，佔像素數
 * 79% 的黑字反而大多數過不了門檻。眾數色量到 `#161618`，正確對到黑——它問的是
 * 「哪一種顏色的像素最多」，不是「哪一種顏色離背景最遠」，兩個問題只有在**真的同色**
 * 時答案才一樣。
 *
 * 多段時**不**用這個：那時每一段的 x 範圍已經是模型切過的、理應同色的範圍，
 * `measureSpan` 的階梯法在那裡解的是另一個問題（小字抗鋸齒把顏色拉向背景），
 * 眾數色在樣本更少的窄範圍裡反而不穩。
 */
function modeColor(pixels: readonly InkPixel[]): string | undefined {
  if (!pixels.length) return undefined;
  const buckets = new Map<string, { n: number; r: number[]; g: number[]; b: number[] }>();
  for (const pixel of pixels) {
    const key = `${pixel.r >> MODE_BUCKET_SHIFT},${pixel.g >> MODE_BUCKET_SHIFT},${pixel.b >> MODE_BUCKET_SHIFT}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.n += 1;
      bucket.r.push(pixel.r);
      bucket.g.push(pixel.g);
      bucket.b.push(pixel.b);
    } else buckets.set(key, { n: 1, r: [pixel.r], g: [pixel.g], b: [pixel.b] });
  }
  let top: { n: number; r: number[]; g: number[]; b: number[] } | undefined;
  for (const bucket of buckets.values()) if (!top || bucket.n > top.n) top = bucket;
  if (!top) return undefined;
  return hex(median(top.r), median(top.g), median(top.b));
}

/** 一段 x 範圍內的字墨顏色（中位數）；樣本不足時回 undefined。 */
function measureSpan(pixels: readonly InkPixel[], from: number, to: number): string | undefined {
  const inside = pixels.filter((pixel) => pixel.x >= from && pixel.x <= to);
  if (inside.length < MIN_SAMPLE) return undefined;
  // 峰值取這一段**自己的**最遠距離，不沿用別段或整框的——不同 token 天生對比不同
  // （深色背景上淺藍字 vs 深紫字，峰值可以差一倍），門檻要跟著各自的峰值走才公平。
  const maxDistance = Math.max(...inside.map((pixel) => pixel.distance));
  for (const ratio of SPAN_CORE_RATIO_LADDER) {
    const core = inside.filter((pixel) => pixel.distance >= maxDistance * ratio);
    if (core.length >= MIN_SAMPLE)
      return hex(
        median(core.map((pixel) => pixel.r)),
        median(core.map((pixel) => pixel.g)),
        median(core.map((pixel) => pixel.b)),
      );
  }
  // 連最寬的門檻都湊不滿：這段字墨本來就稀薄（極小字、極細筆劃），用全部樣本，
  // 好過直接放棄整段量測（回 undefined 會讓呼叫端退回模型憑記憶猜的色票）。
  return hex(
    median(inside.map((pixel) => pixel.r)),
    median(inside.map((pixel) => pixel.g)),
    median(inside.map((pixel) => pixel.b)),
  );
}

/** 相鄰段顏色相近就合併（合併後的顏色取字數較多的那一段）。 */
function mergeAdjacent(runs: readonly ResolvedTextRun[]): ResolvedTextRun[] {
  const out: ResolvedTextRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    const shortEdge =
      last && (run.text.length <= SHORT_RUN_CHARS || last.text.length <= SHORT_RUN_CHARS)
        ? SHORT_MERGE_DELTA_E
        : MERGE_DELTA_E;
    if (last && colorDistance(last.color, run.color) < shortEdge) {
      const keepLast = last.text.length >= run.text.length;
      last.text += run.text;
      if (!keepLast) last.color = run.color;
    } else out.push({ ...run });
  }
  return out;
}

/**
 * 用原圖像素校正一個框的分段顏色。
 *
 * `modelRuns` 是模型給的分段（文字切法 ＋ 它猜的顏色）。回傳的 `runs` 沿用同一套文字
 * 切法，顏色換成實測值；量不到的段沿用模型給的顏色（那是唯一還剩的資訊）。
 */
export function measureRunColors(
  image: RasterImage,
  box: Rect & { fontSize: number },
  modelRuns: readonly ResolvedTextRun[],
): RunColorMeasurement {
  const fallback = modelRuns.map((run) => ({ ...run, color: normalizeHex(run.color) }));
  if (!modelRuns.length) return { runs: [], verdict: "single" };
  if (modelRuns.some((run) => run.text.includes("\n")))
    return { runs: fallback, verdict: "multiline" };
  const pixels = inkPixels(image, box);
  if (pixels.length < MIN_SAMPLE) {
    // 整框合併成一段，顏色用確定性的退路——模型的顏色每次都會變（見 `fallbackColor`）。
    const text = modelRuns.map((run) => run.text).join("");
    const color = fallbackColor(image, box);
    return {
      runs: color && text ? [{ text, color }] : fallback,
      verdict: "no-ink",
    };
  }
  // 定位基準用**字墨的實際範圍**而不是框寬：偵測框帶著 unclip 外擴，用框寬會讓每一段
  // 的估計位置整體偏移。
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const pixel of pixels) {
    if (pixel.x < left) left = pixel.x;
    if (pixel.x > right) right = pixel.x;
  }
  const span = Math.max(1, right - left);
  const totalChars = modelRuns.reduce((sum, run) => sum + run.text.length, 0);
  if (!totalChars) return { runs: fallback, verdict: "no-ink" };
  let consumed = 0;
  /*
   * 內縮只在「有鄰段」時才做——它的目的是不讓取樣混進鄰段的顏色，只有一段時沒有鄰居，
   * 內縮反而是白白把整行的取樣範圍往中間縮。
   *
   * 這不是理論推演：實機（2026-08-22，`d56f8f92` 專案「公開產出提供交流入口，讓專業」
   * 這一行）踩到的真實 bug——模型這次只回了一段（沒偵測到「交流入口」該是紫色），
   * 於是 `modelRuns.length===1`、`from=left`、`to=right`（整行 14 字的字墨範圍），
   * 但仍套用 18% 內縮，把頭尾各裁掉約 2.5 個字——而「交流入口」剛好落在整行正中間，
   * 頭尾被裁掉的恰好都是純黑字。中間留下的取樣池黑紫混雜，紫色對比度天生比黑色對白底
   * 更高，`measureSpan` 的階梯門檻(`SPAN_CORE_RATIO_LADDER`) 因此收斂到紫色——整行 14
   * 個字因此全部染成紫色 `#420f99`，只有中間 4 個字真的是紫的。不內縮、對整行取中位數
   * 則正確量到黑色 `#1a1a1c`（多數像素本來就是黑的）。
   */
  const measured = modelRuns.map((run) => {
    const from = left + (consumed / totalChars) * span;
    const to = left + ((consumed + run.text.length) / totalChars) * span;
    consumed += run.text.length;
    const inset = modelRuns.length > 1 ? (to - from) * INSET_RATIO : 0;
    const color =
      // 模型宣稱整框只有一段時，這個宣稱本身可能是錯的（見 `modeColor()` 的長註解），
      // 用眾數色而不是階梯法——階梯法在那種情況下會選中對比較強的少數顏色。
      (modelRuns.length === 1 ? modeColor(pixels) : undefined) ??
      measureSpan(pixels, from + inset, to - inset) ??
      // 內縮之後樣本太少（很短的段，例如一個 `%`）就退回不內縮的範圍。
      measureSpan(pixels, from, to) ??
      normalizeHex(run.color);
    return { text: run.text, color };
  });
  const merged = mergeAdjacent(measured);
  if (modelRuns.length === 1) return { runs: merged, verdict: "single" };
  return { runs: merged, verdict: merged.length > 1 ? "measured" : "merged" };
}

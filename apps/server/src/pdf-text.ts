/**
 * PDF 原生文字層的幾何整理：把 pdf.js 破碎的 text item 併成行、再併成塊，
 * 排出版面閱讀順序，並用純幾何規則抽出頁面標題（零模型）。
 *
 * 只處理幾何，不碰 pdf.js API，讓規則可以單獨用合成資料測試。
 * 座標一律是「已套用 viewport 的裝置座標」：x 向右、y 向下、單位為 px。
 */

/** 單一 pdf.js text item 轉成的裝置座標文字片段。 */
export interface PdfTextFragment {
  text: string;
  /** 片段左緣。 */
  x: number;
  /** 基線 y（向下為正）。 */
  baseline: number;
  /** 片段寬度（px）。 */
  width: number;
  /** 字級（px，取變換矩陣的垂直縮放）。 */
  fontSize: number;
  fontName: string;
}

export interface PdfTextLine {
  text: string;
  x: number;
  baseline: number;
  width: number;
  fontSize: number;
  fontName: string;
}

/** 合併後的文字塊（一段落／一個標題／一格表格）。 */
export interface PdfTextBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 塊內最大字級。 */
  fontSize: number;
  fontName: string;
  lines: PdfTextLine[];
}

const CJK = /[⺀-鿿豈-﫿＀-￯]/;

/** 兩個片段接合處是否需要補空白（CJK 之間不補）。 */
function needsSpace(left: string, right: string, gap: number, fontSize: number): boolean {
  if (!left || !right) return false;
  if (/\s$/.test(left) || /^\s/.test(right)) return false;
  if (gap <= fontSize * 0.16) return false;
  const leftChar = left.at(-1)!;
  const rightChar = right[0]!;
  if (CJK.test(leftChar) && CJK.test(rightChar)) return false;
  return true;
}

/**
 * 文字層 run 的接續門檻。
 *
 * `maxGapRatio` 是「這段空隙能不能用一個空白字元表示」的上限：`needsSpace` 在
 * 空隙超過 0.16 字級時補一個空白，而空白本身約 0.28 字級寬，所以 0.5 字級以內的空隙
 * 補完空白的位移不超過約 0.22 字級（大字級上約 8px），肉眼看不出來；再寬就會讓
 * 後面的字整段左移。閱讀順序用的 1.5 字級在這裡太寬鬆——上標與欄內縮排都會被吃進來。
 *
 * `maxBaselineRatio` 收緊到 0.15 是為了上下標：同字級的上標基線位移約 0.3 字級，
 * 原本的 0.4 會把它壓回主行基線。
 *
 * `RUN_SIZE_TOLERANCE` 只吸收浮點抖動——同一段文字流的片段字級本來就完全相同。
 */
const RUN_MAX_GAP_RATIO = 0.5;
const RUN_MAX_BASELINE_RATIO = 0.15;
const RUN_SIZE_TOLERANCE = 0.02;

/** 片段接行的幾何／樣式條件，見 `mergeFragmentsIntoLines` 與 `mergeFragmentsIntoRuns`。 */
interface LineMergeRules {
  /** 可接續的最大水平間距（前一段字級的倍率）。 */
  maxGapRatio: number;
  /** 可接續的最大基線落差（前一段字級的倍率）。 */
  maxBaselineRatio: number;
  /** 幾何條件之外的額外門檻（字級／樣式一致）。 */
  joinable?: (line: PdfTextLine, fragment: PdfTextFragment) => boolean;
}

function mergeFragments(
  fragments: readonly PdfTextFragment[],
  rules: LineMergeRules,
): PdfTextLine[] {
  const usable = fragments.filter((fragment) => fragment.text.trim() && fragment.fontSize > 0);
  const sorted = [...usable].sort(
    (left, right) => left.baseline - right.baseline || left.x - right.x,
  );
  const lines: PdfTextLine[] = [];
  for (const fragment of sorted) {
    const current = lines.at(-1);
    const gap = current ? fragment.x - (current.x + current.width) : 0;
    const sameBaseline =
      !!current &&
      Math.abs(fragment.baseline - current.baseline) <= current.fontSize * rules.maxBaselineRatio;
    if (
      current &&
      sameBaseline &&
      gap <= current.fontSize * rules.maxGapRatio &&
      gap > -current.fontSize * 2 &&
      (rules.joinable?.(current, fragment) ?? true)
    ) {
      const separator = needsSpace(current.text, fragment.text, gap, current.fontSize) ? " " : "";
      current.text += separator + fragment.text;
      current.width = Math.max(current.width, fragment.x + fragment.width - current.x);
      current.fontSize = Math.max(current.fontSize, fragment.fontSize);
      continue;
    }
    lines.push({
      text: fragment.text,
      x: fragment.x,
      baseline: fragment.baseline,
      width: fragment.width,
      fontSize: fragment.fontSize,
      fontName: fragment.fontName,
    });
  }
  return lines.map((line) => ({ ...line, text: line.text.replace(/\s+/g, " ").trim() }));
}

/**
 * 片段合併成行：先依基線、再依 x 排序，接著沿著同一條基線向右接。
 * 雙欄版面靠「水平間距超過 1.5 字級就斷開」自然分離。
 *
 * 這是**閱讀順序**用的行（`content`／`purpose` 的來源），刻意把整條視覺行併成一段，
 * 不管中間換了幾種字級或字型。要重畫版面的文字層請改用 `mergeFragmentsIntoRuns`。
 */
export function mergeFragmentsIntoLines(fragments: readonly PdfTextFragment[]): PdfTextLine[] {
  return mergeFragments(fragments, { maxGapRatio: 1.5, maxBaselineRatio: 0.4 });
}

/**
 * 同一條視覺行裡，**可以用單一 `EditableTextBox` 忠實重畫**的最長連續片段（run）。
 *
 * `mergeFragmentsIntoLines` 是為 `content` 抽取設計的：整條視覺行併成一段文字，
 * 字級取 `Math.max`、字型取第一段。拿它畫文字層會壞在兩件事上：
 *
 *  1. **混字級行整條被放大**。「陳惠菁」64px 粗體 + 「玉山商業銀行 資訊處 …」48px 常規
 *     併成一段後整段用 64px 畫，19 個字要 1216px、原本只佔 1019px，直接溢出版面右緣。
 *  2. **片段之間的空隙被壓成一個空白字元**。上標「註1」佔 35px，換成 36px 的空白只剩
 *     ~10px，它後面的字全部左移 ~25px，正好撞上獨立定位的上標框——就是「大小字疊在一起」。
 *
 * 兩者的共通點是 `EditableTextBox` 只有一組字級／字重／字族，也只有一個 x：一段文字裡
 * 塞不下第二種樣式，也塞不下「這裡要空 35px」的資訊。所以文字層在樣式改變或空隙大到
 * 無法用空白表示時就斷開，讓每個 run 帶著自己的 x、字級與樣式各畫各的。
 *
 * `styleKey` 由呼叫端從 `fontName` 解析（伺服器端是解析後的 fontFamily 與 fontWeight），
 * 因為「兩個內嵌 subset 字型會不會畫成同一種字」只有解析過字型物件的那一端知道。
 * 用解析後的樣式而不是 `fontName` 本身比較，同一種字的不同 subset 才不會被拆散。
 */
export function mergeFragmentsIntoRuns(
  fragments: readonly PdfTextFragment[],
  styleKey: (fontName: string) => string,
): PdfTextLine[] {
  return mergeFragments(fragments, {
    maxGapRatio: RUN_MAX_GAP_RATIO,
    maxBaselineRatio: RUN_MAX_BASELINE_RATIO,
    joinable: (line, fragment) => {
      const larger = Math.max(line.fontSize, fragment.fontSize);
      if (larger - Math.min(line.fontSize, fragment.fontSize) > larger * RUN_SIZE_TOLERANCE)
        return false;
      return styleKey(line.fontName) === styleKey(fragment.fontName);
    },
  });
}

function horizontalOverlap(
  left: { x: number; width: number },
  right: { x: number; width: number },
): number {
  const start = Math.max(left.x, right.x);
  const end = Math.min(left.x + left.width, right.x + right.width);
  return Math.max(0, end - start);
}

/**
 * 只含項目符號的行。`·` 也算——真實簡報用它當項目符號，但它同樣是常見的行內分隔號
 * （「A · B」），所以還要靠 `attachBulletMarkers` 的左側淨空條件才收得乾淨。
 */
const BULLET_MARKER = /^[•‧∙‣▪▫◦●○◆■·・\-–]$/;
/** 項目符號與它所屬文字之間、以及它左側必須淨空的距離（字級倍率）。 */
const BULLET_TEXT_GAP = 3;
const BULLET_LEFT_CLEARANCE = 3;

/**
 * 把「單獨成行的項目符號」併進它右邊那一行。
 *
 * pdf.js 會把 `•` 與後面的文字切成兩個 item，中間的縮排又大於 `mergeFragmentsIntoLines`
 * 的斷行門檻，於是每個項目符號都變成獨立的行、獨立的塊，`content` 裡出現大量孤立的
 * `•`；更糟的是這些符號在欄內垂直相鄰、字級相同，塊合併時會自己黏成一整條符號柱。
 *
 * 兩個條件缺一不可：右邊近距離有文字，**且**左邊在同一條基線上是淨空的。少了左側條件，
 * 封面「截至 … · GCR SMB GTM」這種行內分隔號會被誤判成項目符號。
 *
 * 先算完配對再一次輸出，而不是邊掃邊 push：`lines` 依「基線、x」排序，而同一條視覺行的
 * 基線容許 ±0.5 字級的落差，所以項目文字有可能排在符號**前面**。邊掃邊 push 的話那一行
 * 會先以自己的身分輸出一次、再被併進符號裡輸出一次，`content` 就多出一份重複的文字。
 */
function attachBulletMarkers(lines: readonly PdfTextLine[]): PdfTextLine[] {
  const consumed = new Set<number>();
  const merged = new Map<number, PdfTextLine>();
  for (const [index, line] of lines.entries()) {
    if (!BULLET_MARKER.test(line.text)) continue;
    const sameBaseline = [...lines.entries()].filter(
      ([other, candidate]) =>
        other !== index &&
        !consumed.has(other) &&
        Math.abs(candidate.baseline - line.baseline) <= line.fontSize * 0.5,
    );
    const blockedOnTheLeft = sameBaseline.some(
      ([, candidate]) =>
        candidate.x < line.x &&
        line.x - (candidate.x + candidate.width) <= line.fontSize * BULLET_LEFT_CLEARANCE,
    );
    const target = blockedOnTheLeft
      ? undefined
      : sameBaseline
          .filter(([, candidate]) => !BULLET_MARKER.test(candidate.text))
          .map(([other, candidate]) => ({
            other,
            candidate,
            gap: candidate.x - (line.x + line.width),
          }))
          .filter(({ gap }) => gap >= 0 && gap <= line.fontSize * BULLET_TEXT_GAP)
          .sort((left, right) => left.gap - right.gap)[0];
    if (!target) continue;
    consumed.add(target.other);
    merged.set(index, {
      ...target.candidate,
      text: `${line.text} ${target.candidate.text}`,
      x: line.x,
      width: target.candidate.x + target.candidate.width - line.x,
    });
  }
  return lines.flatMap((line, index) => (consumed.has(index) ? [] : [merged.get(index) ?? line]));
}

/** 字級相近、行距不超過 1.9 倍、水平範圍重疊 30% 以上 = 同一段的續行。 */
const BLOCK_SIZE_RATIO = 0.75;
const BLOCK_LINE_GAP_RATIO = 1.9;
const BLOCK_OVERLAP_RATIO = 0.3;

/**
 * 這一行要接到哪一個已開啟的塊。
 *
 * 關鍵在於候選是**所有**還開著的塊，而不是只有最後一個：多欄版面的行是依基線交錯進來的
 * （左欄第一行、中欄第一行、右欄第一行、左欄第二行 …），只看最後一個塊的話同一欄的續行
 * 永遠接不上，整段會碎成一行一塊。合格的候選裡取行距最近、其次水平重疊最多的那一個，
 * 水平重疊條件本身就把別欄排除掉了。
 */
function blockForLine(
  blocks: readonly PdfTextBlock[],
  line: PdfTextLine,
): PdfTextBlock | undefined {
  let best: { block: PdfTextBlock; gap: number; overlap: number } | undefined;
  for (const block of blocks) {
    const last = block.lines.at(-1);
    if (!last) continue;
    const larger = Math.max(line.fontSize, last.fontSize);
    const sizeRatio = larger ? Math.min(line.fontSize, last.fontSize) / larger : 1;
    if (sizeRatio < BLOCK_SIZE_RATIO) continue;
    const gap = line.baseline - last.baseline;
    if (gap <= 0 || gap > line.fontSize * BLOCK_LINE_GAP_RATIO) continue;
    const overlap = horizontalOverlap(line, block) / Math.max(1, Math.min(line.width, block.width));
    if (overlap < BLOCK_OVERLAP_RATIO) continue;
    if (!best || gap < best.gap - 0.01 || (gap <= best.gap + 0.01 && overlap > best.overlap))
      best = { block, gap, overlap };
  }
  return best?.block;
}

/** 行併成塊：字級相近、行距不超過 1.9 倍、且水平範圍重疊的相鄰行視為同一段。 */
export function mergeLinesIntoBlocks(lines: readonly PdfTextLine[]): PdfTextBlock[] {
  const blocks: PdfTextBlock[] = [];
  for (const line of attachBulletMarkers(lines)) {
    const target = blockForLine(blocks, line);
    if (target) {
      target.lines.push(line);
      target.text += `\n${line.text}`;
      const right = Math.max(target.x + target.width, line.x + line.width);
      target.x = Math.min(target.x, line.x);
      target.width = right - target.x;
      target.height = line.baseline + line.fontSize * 0.25 - target.y;
      target.fontSize = Math.max(target.fontSize, line.fontSize);
      continue;
    }
    blocks.push({
      text: line.text,
      x: line.x,
      y: line.baseline - line.fontSize * 0.85,
      width: line.width,
      height: line.fontSize * 1.1,
      fontSize: line.fontSize,
      fontName: line.fontName,
      lines: [line],
    });
  }
  return blocks;
}

/** 依垂直位置把塊分成「列」：中心線落在同一條帶子上的塊算同一列。 */
function groupIntoRows(sortedByPosition: readonly PdfTextBlock[]): PdfTextBlock[][] {
  const rows: PdfTextBlock[][] = [];
  for (const block of sortedByPosition) {
    const row = rows.at(-1);
    const last = row?.at(-1);
    if (row && last) {
      const gap = Math.abs(block.y + block.height / 2 - (last.y + last.height / 2));
      if (gap <= Math.max(last.height, block.height) * 0.6) {
        row.push(block);
        continue;
      }
    }
    rows.push([block]);
  }
  return rows;
}

/** 版面分析用的水平區間（欄帶、佔用帶）。 */
interface LayoutSpan {
  start: number;
  end: number;
}

/** 欄距門檻：小於這個寬度的空隙不算欄距，只是段落內的縮排。 */
const COLUMN_GUTTER_RATIO = 0.02;
/** 佔滿整條佔用帶這個比例的塊視為「跨欄」（標題、跨欄前言、註腳）。 */
const SPANNING_WIDTH_RATIO = 0.6;
/** 兩段之間垂直空白超過字級的這個倍數才算換段落區（而不是段內換行）。 */
const SECTION_GAP_RATIO = 3;
/** 相鄰段落區的欄結構要重疊到這個比例才視為同一段多欄流程，合併回去。 */
const SECTION_BAND_MATCH_RATIO = 0.5;

function byPositionOrder(left: PdfTextBlock, right: PdfTextBlock): number {
  return left.y - right.y || left.x - right.x;
}

function spanOverlap(left: LayoutSpan, right: LayoutSpan): number {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
}

/** 把塊的 x 區間併成不重疊的佔用帶；帶與帶之間的空隙就是欄距。 */
function occupiedSpans(blocks: readonly PdfTextBlock[], minGutter: number): LayoutSpan[] {
  const spans = blocks
    .map((block) => ({ start: block.x, end: block.x + block.width }))
    .sort((left, right) => left.start - right.start);
  const runs: LayoutSpan[] = [];
  for (const span of spans) {
    const last = runs.at(-1);
    if (last && span.start - last.end < minGutter) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    runs.push({ ...span });
  }
  return runs;
}

interface ColumnLayout {
  /** 由左到右的欄帶。單欄版面只有一條。 */
  bands: LayoutSpan[];
  /** 橫跨多欄、必須留在原本 y 位置的塊。 */
  spanning: Set<PdfTextBlock>;
}

/**
 * N 欄偵測。
 *
 * 從塊的 x 區間直接長出欄帶，所以雙欄、三欄、四欄一視同仁——舊版只找**單一**分隔線，
 * 三欄版面必然漏掉一條，退回純 y 排序後每一欄的內容會被逐行交錯切碎。
 *
 * 佔用帶只有一條時再試一次：把「幾乎佔滿整條帶」的塊（置中大標、跨欄前言）拿掉，
 * 看看底下會不會露出欄距。這一步有兩道防守，免得把單欄頁誤判成多欄：
 * 露出來的每一欄至少要有兩塊，且被拿掉的塊必須真的橫跨其中兩欄以上。
 */
function detectColumns(blocks: readonly PdfTextBlock[], minGutter: number): ColumnLayout {
  const runs = occupiedSpans(blocks, minGutter);
  const single = (): ColumnLayout => ({
    bands: runs.length ? [runs[0]!] : [],
    spanning: new Set(),
  });
  if (blocks.length < 2 || !runs.length) return single();
  const descend = (groups: readonly { span: LayoutSpan; blocks: PdfTextBlock[] }[]) => {
    const bands: LayoutSpan[] = [];
    const spanning = new Set<PdfTextBlock>();
    for (const group of groups) {
      const nested = detectColumns(group.blocks, minGutter);
      bands.push(...(nested.bands.length ? nested.bands : [group.span]));
      for (const block of nested.spanning) spanning.add(block);
    }
    return { bands, spanning };
  };
  const within = (span: LayoutSpan, candidates: readonly PdfTextBlock[]) =>
    candidates.filter(
      (block) => spanOverlap({ start: block.x, end: block.x + block.width }, span) > 0,
    );
  if (runs.length >= 2)
    return descend(runs.map((span) => ({ span, blocks: within(span, blocks) })));
  const run = runs[0]!;
  const wide = blocks.filter(
    (block) => block.width >= (run.end - run.start) * SPANNING_WIDTH_RATIO,
  );
  const narrow = blocks.filter((block) => !wide.includes(block));
  if (!wide.length || narrow.length < 2) return single();
  const subRuns = occupiedSpans(narrow, minGutter);
  if (subRuns.length < 2) return single();
  const groups = subRuns.map((span) => ({ span, blocks: within(span, narrow) }));
  if (groups.some((group) => group.blocks.length < 2)) return single();
  const spansTwoColumns = (block: PdfTextBlock) =>
    subRuns.filter((span) => spanOverlap({ start: block.x, end: block.x + block.width }, span) > 0)
      .length >= 2;
  if (!wide.every(spansTwoColumns)) return single();
  const nested = descend(groups);
  for (const block of wide) nested.spanning.add(block);
  return nested;
}

/**
 * 表格偵測：欄帶 ≥ 3、列與列的儲存格一格對一欄、而且**儲存格不換行**。
 *
 * 前兩個條件多欄卡片／多欄列表同樣滿足（三張並排的卡片就是三欄乘上幾「列」），
 * 舊版只看這兩個條件，於是真實簡報大量使用的三欄版面被判成表格、走 row-major，
 * 把每一欄的連續段落按行交錯切碎。真正分得開的是儲存格內容：表格格子放的是標籤與
 * 數字，一格一行；多欄卡片放的是整句整段，必然換行。
 *
 * 表格必須走 row-major 輸出——把同一列的儲存格拆到不同欄再重排，
 * 「標籤 ↔ 數字」的對應關係整個消失，而錯配的數字會原樣送進生圖模型。
 */
const TABLE_MIN_BANDS = 3;
const TABLE_MAX_CELL_LINES = 2;
const TABLE_MAX_WRAPPED_RATIO = 0.2;

function looksTabular(blocks: readonly PdfTextBlock[], bands: readonly LayoutSpan[]): boolean {
  if (bands.length < TABLE_MIN_BANDS || blocks.length < TABLE_MIN_BANDS * 2) return false;
  const rows = groupIntoRows([...blocks].sort(byPositionOrder));
  if (rows.length < 2) return false;
  for (const row of rows) {
    const cells = bands.map(() => 0);
    for (const block of row) {
      const band = bandIndexOf(block, bands);
      cells[band] = (cells[band] ?? 0) + 1;
    }
    if (cells.some((count) => count > 1)) return false;
    if (cells.filter((count) => count === 1).length < TABLE_MIN_BANDS) return false;
  }
  const wrapped = blocks.filter((block) => block.lines.length > 1);
  if (wrapped.some((block) => block.lines.length > TABLE_MAX_CELL_LINES)) return false;
  return wrapped.length <= blocks.length * TABLE_MAX_WRAPPED_RATIO;
}

/** 塊屬於哪一欄：水平重疊最多的那一欄，全都不重疊時取中心最近的。 */
function bandIndexOf(block: PdfTextBlock, bands: readonly LayoutSpan[]): number {
  const span = { start: block.x, end: block.x + block.width };
  const center = block.x + block.width / 2;
  let best = 0;
  let bestOverlap = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, band] of bands.entries()) {
    const overlap = spanOverlap(span, band);
    const distance = Math.abs((band.start + band.end) / 2 - center);
    if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      best = index;
      bestOverlap = overlap;
      bestDistance = distance;
    }
  }
  return best;
}

/** 一群欄內塊的輸出順序：真表格 row-major，多欄版面 column-major。 */
function orderColumnGroup(
  blocks: readonly PdfTextBlock[],
  bands: readonly LayoutSpan[],
): PdfTextBlock[] {
  const byPosition = [...blocks].sort(byPositionOrder);
  if (bands.length < 2) return byPosition;
  if (looksTabular(byPosition, bands))
    return groupIntoRows(byPosition).flatMap((row) =>
      [...row].sort((left, right) => left.x - right.x),
    );
  const buckets: PdfTextBlock[][] = bands.map(() => []);
  for (const block of byPosition) buckets[bandIndexOf(block, bands)]!.push(block);
  return buckets.flat();
}

/**
 * 依垂直空白把頁面切成段落區。標題／副標與底下的欄位版面因此分開分析——
 * 置中的大標常常只橫跨中間那一欄的 x 範圍（不是整頁寬），跟欄內容混在一起算欄帶時
 * 會被當成某一欄的成員，整個標題就掉進第 2 欄的閱讀順序裡。
 */
function splitIntoSections(byPosition: readonly PdfTextBlock[]): PdfTextBlock[][] {
  const threshold = median(byPosition.map((block) => block.fontSize)) * SECTION_GAP_RATIO;
  const sections: PdfTextBlock[][] = [];
  let bottom = Number.NEGATIVE_INFINITY;
  for (const block of byPosition) {
    const section = sections.at(-1);
    if (!section || block.y - bottom > threshold) sections.push([block]);
    else section.push(block);
    bottom = Math.max(bottom, block.y + block.height);
  }
  return sections;
}

function bandsMatch(left: readonly LayoutSpan[], right: readonly LayoutSpan[]): boolean {
  if (!left.length || left.length !== right.length) return false;
  return left.every((band, index) => {
    const other = right[index]!;
    const narrower = Math.max(1, Math.min(band.end - band.start, other.end - other.start));
    return spanOverlap(band, other) / narrower >= SECTION_BAND_MATCH_RATIO;
  });
}

interface LayoutSection {
  blocks: PdfTextBlock[];
  layout: ColumnLayout;
}

/**
 * 段落區之間的垂直空白只是「行距變大」時（多欄列表的項目之間、表格的列之間）
 * 切出來的相鄰區其實是同一段多欄流程，欄結構會一模一樣——合併回去，
 * 否則同一欄的內容會被切成好幾段各自 column-major，欄的連續性一樣斷掉。
 */
function layoutSections(byPosition: readonly PdfTextBlock[], minGutter: number): LayoutSection[] {
  const sections: LayoutSection[] = splitIntoSections(byPosition).map((blocks) => ({
    blocks,
    layout: detectColumns(blocks, minGutter),
  }));
  for (let index = 0; index + 1 < sections.length;) {
    const current = sections[index]!;
    const next = sections[index + 1]!;
    if (!bandsMatch(current.layout.bands, next.layout.bands)) {
      index += 1;
      continue;
    }
    const blocks = [...current.blocks, ...next.blocks].sort(byPositionOrder);
    sections.splice(index, 2, { blocks, layout: detectColumns(blocks, minGutter) });
  }
  return sections;
}

/**
 * 版面閱讀順序：先切段落區，每一區各自做 N 欄偵測，
 * 跨欄塊留在原本的 y 位置、並把它前後的欄內容切成獨立的群，
 * 每一群再依「真表格 row-major／多欄 column-major」輸出。
 */
export function orderBlocksForReading(
  blocks: readonly PdfTextBlock[],
  pageWidth: number,
): PdfTextBlock[] {
  const byPosition = [...blocks].sort(byPositionOrder);
  if (byPosition.length < 2) return byPosition;
  const minGutter = Math.max(1, pageWidth * COLUMN_GUTTER_RATIO);
  const ordered: PdfTextBlock[] = [];
  for (const section of layoutSections(byPosition, minGutter)) {
    let pending: PdfTextBlock[] = [];
    const flush = () => {
      if (!pending.length) return;
      ordered.push(...orderColumnGroup(pending, section.layout.bands));
      pending = [];
    };
    for (const block of section.blocks) {
      if (section.layout.spanning.has(block)) {
        flush();
        ordered.push(block);
        continue;
      }
      pending.push(block);
    }
    flush();
  }
  return ordered;
}

/** 頁首／頁尾比對用的正規化鍵：小寫、壓縮空白、數字換成 `#`（頁碼因此可跨頁比中）。 */
export function repeatKey(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#").trim();
}

/**
 * 在多頁上重複出現的相同文字視為頁首／頁尾樣板，標題抽取時排除。
 *
 * 門檻是 3 頁，但只匯入 2 頁時要降到 2——否則兩頁的 deck（使用者在選頁網格上
 * 勾掉其他頁就會出現）完全比對不到樣板，字級比真標題大的頁首橫幅會變成兩頁的
 * `purpose`。單頁沒有「跨頁」可言，一律不視為樣板。
 */
export function repeatedBlockKeys(pages: readonly (readonly PdfTextBlock[])[]): Set<string> {
  if (pages.length < 2) return new Set();
  const threshold = Math.min(3, pages.length);
  const counts = new Map<string, number>();
  for (const blocks of pages) {
    const seen = new Set<string>();
    for (const block of blocks) {
      const key = repeatKey(block.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
}

const TITLE_MAX_CHARS = 80;
const TITLE_MAX_LINES = 3;
/**
 * 全頁最大與最小字級差距沒超過這個倍數 = 字級一致（條列頁、圖表頁），視為「沒有標題」。
 * 這是規格第 4 條「抽不到就留空，不要猜」的實作。
 */
const TITLE_SIZE_RATIO = 1.15;
/**
 * 字級一致性規則只套用在「密集」的頁面上。規格第 4 條的留空對象是條列頁與圖表頁，
 * 不是只有一兩塊字的封面：單一大標的封面、或「標題＋同字級副標」的封面都字級一致，
 * 不加這道門檻的話它們的標題會一起被吃掉——而 `pickAnalysisSlides` 又固定把第 1 頁
 * 當封面送去風格分析，兩邊訊號會不一致。
 */
const TITLE_DENSE_PAGE_LINES = 3;

function isPageNumberLike(text: string): boolean {
  return /^[\s\d.,\-–—/|]*$/.test(text) || /^(?:page|第)?\s*\d+\s*(?:頁|\/\s*\d+)?$/i.test(text);
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * 純幾何標題抽取：取字級最大的塊，並列時取最靠上者。
 * 頁碼、跨頁重複的頁首頁尾、過長的塊都排除；字級與全頁一致（條列頁、圖表頁）時回空字串。
 * 抽不到就留空，不猜。
 */
export function extractTitle(
  blocks: readonly PdfTextBlock[],
  repeated: ReadonlySet<string> = new Set(),
): string {
  const candidates = blocks.filter(
    (block) =>
      block.text.trim() &&
      block.text.length <= TITLE_MAX_CHARS &&
      block.lines.length <= TITLE_MAX_LINES &&
      !isPageNumberLike(block.text) &&
      !repeated.has(repeatKey(block.text)),
  );
  if (!candidates.length) return "";
  const sizes = blocks.map((block) => block.fontSize).filter((size) => size > 0);
  const smallest = sizes.length ? Math.min(...sizes) : 0;
  const largestOnPage = sizes.length ? Math.max(...sizes) : 0;
  const lineCount = blocks.reduce((total, block) => total + block.lines.length, 0);
  if (
    lineCount >= TITLE_DENSE_PAGE_LINES &&
    smallest > 0 &&
    largestOnPage <= smallest * TITLE_SIZE_RATIO
  )
    return "";
  const largest = candidates.reduce((best, block) =>
    block.fontSize > best.fontSize + 0.01
      ? block
      : Math.abs(block.fontSize - best.fontSize) <= 0.01 && block.y < best.y
        ? block
        : best,
  );
  return largest.text.replace(/\s*\n\s*/g, " ").trim();
}

/** 全頁文字，依版面閱讀順序，塊與塊之間空一行。 */
export function pageContent(orderedBlocks: readonly PdfTextBlock[]): string {
  return orderedBlocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

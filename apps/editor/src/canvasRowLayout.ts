/**
 * 畫布列（`.canvas-row`）的文字工具列方向決策。
 *
 * 工具列可以是畫布右側的直排側欄，也可以是畫布下方的橫排。哪一種比較好，取決於**視窗比例
 * 與畫布比例的關係**，不是固定的：
 * ・視窗寬高比大於畫布比例（例：最大化瀏覽器 1920×940，高度被 chrome 吃掉）＝畫布**高度**
 *   受限，水平方向本來就有空白，側欄不從畫布身上拿任何東西；
 * ・視窗寬高比小於畫布比例（例：全螢幕 1920×1080）＝畫布**寬度**受限，畫布下方空著一兩百
 *   px，此時側欄每一個 px 都是直接從畫布寬度扣的，把它移到下方那條空白裡才不浪費。
 * 因此這裡不設 media query 斷點（斷點只看視窗寬，看不到「畫布被哪一軸夾住」），而是把兩種
 * 佈局的畫布尺寸都算出來，取畫布較大的那一個。
 */

/**
 * 工具列厚度的**退路**常數，對應 styles.css 的 `--text-rail-thickness`
 * （28px 按鈕 ＋ 6px×2 padding ＋ 1px×2 border）。
 *
 * 有工具列時一律以 DOM 量測為準；這個常數只在工具列**還沒掛載**（這一頁還沒有圖）時填進
 * `railThickness`，而那個情形下它填 42、0 還是 999 都不影響任何一個像素——沒有工具列時
 * 兩種假想佈局的可用區域完全相同（誰都不必扣厚度），決策必然是平手、必然維持側排。
 * 留著它只是為了讓 `CanvasRowLayout` 沒有「有時候沒有厚度」這種半殘狀態。
 * 兩邊的數值一致由 canvasRowLayout.test.ts 的「CSS 幾何地基」直接比對 styles.css 釘住。
 */
export const TEXT_RAIL_THICKNESS_PX = 42;

/**
 * `.canvas-row` 的 gap 退路常數，對應 styles.css 的 `--canvas-row-gap`。
 *
 * 只在**讀不到** computed style（jsdom、元素不在文件裡）時使用。注意「讀到 `normal`」不算
 * 讀不到：那是 flex gap 的初始值，語意就是 0，不可以退到這個常數（否則有人把 `.canvas-row`
 * 的 gap 拿掉之後，決策會憑空多扣 10px）。
 */
export const CANVAS_ROW_GAP_PX = 10;

/**
 * 橫排修飾類別。
 *
 * 名字由這裡定義、JSX 掛上去、styles.css 寫同一個字面值（由測試比對），JS 這一側**不再**
 * 反過來讀它：決策只吃尺寸，不看「目前是哪一種佈局」。
 */
export const CANVAS_ROW_STACKED_CLASS = "canvas-row-stacked";

export interface CanvasRowLayout {
  /**
   * `.canvas-row` 的 padding box（`clientWidth`／`clientHeight`：含 padding、不含 border 與捲軸）。
   *
   * 今天 `.canvas-row` 既沒有 padding 也沒有 border，所以這組數字就是畫布與工具列真正能用的
   * 空間；日後若替它加上 padding，這裡會高估可用空間、決策偏向橫排。`.canvas-row` 不得有
   * padding／border 這件事由 canvasRowLayout.test.ts 的「CSS 幾何地基」擋著。
   *
   * **兩種佈局必須用同一組 W×H 去比**，絕不可拿「目前佈局下畫布欄剩下的空間」來算：那會讓
   * 判斷的輸入被判斷的輸出改變——切到橫排後畫布欄變寬，再算一次就得到「側排比較好」，切回
   * 側排後又變回「橫排比較好」，每一次 resize 都可能陷入來回抖動。`.canvas-row` 是
   * `flex: 1 1 auto` 撐滿舞台、又有 `container-type: size`（內容不影響自身尺寸），
   * 它的尺寸不受內部工具列方向影響，所以它是唯一穩定的輸入。
   */
  rowWidth: number;
  rowHeight: number;
  /** 畫布比例（寬 ÷ 高）。 */
  canvasAspect: number;
  /** 工具列厚度：直排時是它的寬、橫排時是它的高，同一個值。 */
  railThickness: number;
  /** 側排（`.canvas-row` 是 row flex）時，畫布與工具列之間的 column-gap。 */
  columnGap: number;
  /** 橫排（column flex）時的 row-gap。兩種佈局各用各的軸，不必假設兩軸同值。 */
  rowGap: number;
}

/**
 * 在 `width × height` 的可用區域內，內接 `canvasAspect` 比例的最大矩形面積。
 *
 * 與 styles.css `.canvas` 的 `min(100cqw, 100cqh * ar) × min(100cqh, 100cqw / ar)` 同一條公式——
 * 那邊是渲染，這邊是預測；兩者算出來的必須是同一個矩形，否則決策依據與畫面對不上。
 */
export function inscribedCanvasArea(width: number, height: number, canvasAspect: number): number {
  if (!(width > 0) || !(height > 0) || !(canvasAspect > 0) || !Number.isFinite(canvasAspect))
    return 0;
  return Math.min(width, height * canvasAspect) * Math.min(height, width / canvasAspect);
}

/**
 * 工具列要不要改成畫布下方的橫排。
 *
 * 比的是兩種佈局下畫布**面積**（同比例的矩形，比面積等同比邊長）。平手時回 false 維持側排：
 * 側排是預設，沒有明確好處就不要動版面。
 */
export function shouldStackTextRail(layout: CanvasRowLayout): boolean {
  const side = inscribedCanvasArea(
    layout.rowWidth - layout.railThickness - layout.columnGap,
    layout.rowHeight,
    layout.canvasAspect,
  );
  const stacked = inscribedCanvasArea(
    layout.rowWidth,
    layout.rowHeight - layout.railThickness - layout.rowGap,
    layout.canvasAspect,
  );
  return stacked > side;
}

/**
 * computed style 的 gap 值轉成 px。
 *
 * `normal` 是 flex gap 的初始值（語意＝0），**不是**「讀不到」——把它當讀不到會讓沒有 gap 的
 * 版面被多扣一個常數。真正讀不到（空字串、非瀏覽器環境）才回 undefined 讓呼叫端用退路常數。
 */
function cssGapPx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (value === "normal") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 從 DOM 量出決策所需的輸入。
 *
 * 厚度取工具列**兩軸的較小者**：它永遠是「一薄一長」（四顆按鈕排成一線），所以不論目前是
 * 直排還是橫排，較小的那一軸就是厚度。刻意不依「目前是哪一種佈局」去挑軸——一旦要挑，
 * 挑錯就會讓決策跟著佈局翻面（實測 1000×600 是真的會 2-cycle 來回抖動的臨界尺寸），
 * 取 min 讓那類錯誤在結構上不可能發生。順帶也免疫傳統捲軸：側排時若冒出垂直捲軸，
 * `offsetWidth` 會變成 57 而不是 42，取 min 仍拿到另一軸的真實厚度。
 *
 * 尺寸一律取自 `.canvas-row` 本身而不是畫布欄——理由見 `CanvasRowLayout.rowWidth` 的註解。
 */
export function measureCanvasRowLayout(
  row: HTMLElement,
  rail: HTMLElement | null,
  canvasAspect: number,
): CanvasRowLayout {
  const thickness = rail ? Math.min(rail.offsetWidth, rail.offsetHeight) : 0;
  const style = row.ownerDocument.defaultView?.getComputedStyle(row);
  return {
    rowWidth: row.clientWidth,
    rowHeight: row.clientHeight,
    canvasAspect,
    // 量到 0 代表工具列還沒有版面（未掛載、display:none、非瀏覽器環境），此時只能用常數。
    railThickness: thickness > 0 ? thickness : TEXT_RAIL_THICKNESS_PX,
    columnGap: cssGapPx(style?.columnGap) ?? CANVAS_ROW_GAP_PX,
    rowGap: cssGapPx(style?.rowGap) ?? CANVAS_ROW_GAP_PX,
  };
}

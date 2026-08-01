import type { EditableTextBox } from "@slide-maker/core";

/**
 * 工具列「新增文字框」的預設框（白字 44px）。
 *
 * 抽成函式是因為兩條路要一模一樣的東西：已有文字層時直接推進 `textBoxes`，還沒有時
 * 得先拿它去建立文字編輯版本。
 */
export function defaultTextBox(): EditableTextBox {
  return {
    id: crypto.randomUUID(),
    text: "新增文字",
    x: 120,
    y: 120,
    width: 420,
    height: 80,
    fontFamily: "Arial",
    fontSize: 44,
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
  };
}

export const RESIZE_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

const TEXT_HISTORY_LIMIT = 60;

/** 啟用文字框底色時的預設色；文字預設是白字，配黑底才看得見。 */
export const TEXT_BACKGROUND_DEFAULT_COLOR = "#000000";

/**
 * 貼上文字框時相對來源的位移（畫布座標）。
 *
 * 貼在原位的話副本會完全蓋住來源，使用者看不出貼上成功，也拖不到底下那一個。
 */
const TEXT_PASTE_OFFSET = 24;

/**
 * 貼上的副本在單一軸上的落點（`start` 是來源座標，`limit` 是該軸的畫布尺寸）。
 *
 * 正向位移優先，但夾在畫布內會有兩個退化情形，都會讓副本原地重疊、看不出貼上成功：
 * 來源已貼齊右／下緣（右對齊頁尾、底部圖說很常見）時往回退同樣的距離；框本身就比
 * 畫布寬／高時怎麼放都會溢出，維持正向位移，可見比夾回 0 更重要。
 */
function placePastedBox(start: number, size: number, limit: number, offset: number): number {
  const forward = Math.min(Math.max(0, limit - size), start + offset);
  if (forward > start) return forward;
  return start >= offset ? start - offset : start + offset;
}

/**
 * 連續貼上最多往下找幾階：框被夾在畫布邊緣時每一階都可能算出同一個點，不能無限找。
 * 找滿了就讓它重疊——那已經是畫布放不下的情形，重疊比卡住好。
 */
const TEXT_PASTE_MAX_STEP = 40;

/**
 * 貼上的副本落點：從第一階開始往下找，直到那個點沒有被現有文字框佔住。
 *
 * 刻意不記「上一次貼到第幾階」。階數一旦要記，就得同時綁來源框與投影片，於是
 * 換頁往返、或只是重新按一次 ⌘C（即使複製的是同一個框），都會把它重算成第一階——
 * 而第一階的位置早被上一份副本佔走，新副本逐像素疊上去，使用者看到的是「⌘V 沒反應」。
 * 改看實際佔用還順帶拿到兩件事：刪掉副本後空出來的位置會被重新使用，以及沒有任何
 * 跨頁／跨專案的階梯狀態需要清除。
 */
export function pastePosition(
  source: EditableTextBox,
  boxes: EditableTextBox[],
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  let spot = { x: source.x, y: source.y };
  for (let step = 1; step <= TEXT_PASTE_MAX_STEP; step += 1) {
    const offset = step * TEXT_PASTE_OFFSET;
    spot = {
      x: placePastedBox(source.x, source.width, canvasWidth, offset),
      y: placePastedBox(source.y, source.height, canvasHeight, offset),
    };
    if (!boxes.some((box) => box.x === spot.x && box.y === spot.y)) return spot;
  }
  return spot;
}

/**
 * 這個 keydown 是否落在「使用者正在輸入」的地方，該原封不動交給瀏覽器。
 *
 * 與方向鍵換頁那條 handler 的判定刻意有兩處不同，寫在這裡免得日後被當成筆誤「修掉」：
 * ・textarea 要看 `readOnly`——唯讀的那個就是尚未進入編輯的文字框本體，快捷鍵必須生效；
 *   非唯讀代表使用者正在打字，這三個鍵是字元層級的複製／貼上／刪字，攔了連字都刪不掉。
 * ・`button` 不放行——剛按完工具列按鈕（例如「＋ 文字框」）焦點還留在按鈕上，這時按
 *   Delete 的意圖顯然是刪畫布上選取的框，而 Delete/Backspace 對按鈕本身沒有原生行為。
 * `a` 則與那條一致放行：某些設定下 Backspace-on-link 是瀏覽器的上一頁手勢。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  return target.matches("input, select, a") || target.isContentEditable;
}

/** 某一頁正在跑的文字圖層工作。 */
export type TextLayerTask = "save" | "extract" | "create";

/** 待寫入伺服器的文字圖層變更；`boxes` 直接存引用（文字框陣列一律不可變更新）。 */
export type PendingTextSave = {
  projectId: string;
  slideId: string;
  versionId: string;
  boxes: EditableTextBox[];
  threshold: number;
};

// 文字框陣列一律以不可變方式更新，歷史可直接存引用，不需深拷貝。
export function pushHistory(
  history: EditableTextBox[][],
  boxes: EditableTextBox[],
): EditableTextBox[][] {
  return [...history, boxes].slice(-TEXT_HISTORY_LIMIT);
}

/** 單一文字框的 key 順序無關序列化；見 {@link sameBoxes}。 */
function stableBoxKey(box: EditableTextBox): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(box).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
}

/**
 * 兩批文字框是否等價——**必須與 key 順序無關**，這是自動儲存唯一的守門員。
 *
 * 不能直接比 `JSON.stringify(boxes)`：optional 欄位（目前是底色那兩個）在本地是執行期
 * 才被 spread 加上去的，會排在物件尾端；而伺服器回應是 zod 依 schema 宣告順序重建的，
 * 同一個框的兩份字串永遠不相等。守門員一失效，自動儲存就進入
 * 「存 → 收到新 project → effect 重跑 → 仍判定不相等 → 再存」的無限迴圈
 * （`textDirty` 只在重新播種時歸零，PUT 不會清掉它），而每一輪伺服器都要重跑一次
 * `renderComposite()` 並換掉 `imagePath`，畫布會跟著每秒重新載入。
 */
export function sameBoxes(a: readonly EditableTextBox[], b: readonly EditableTextBox[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((box, index) => {
    const other = b[index];
    return other !== undefined && stableBoxKey(box) === stableBoxKey(other);
  });
}

/**
 * 文字框底色的 CSS 值；沒設定底色就回 undefined（＝沿用 styles.css 的選取提示底）。
 *
 * 底色與文字的 `opacity` 是獨立的兩件事，所以透明度只能吃進色值本身，
 * 不能用容器的 `opacity`（那會連帶把文字與選取外框一起變淡）。
 */
export function textBoxBackground(box: EditableTextBox): string | undefined {
  if (!box.backgroundColor) return undefined;
  return rgba(box.backgroundColor, box.backgroundOpacity ?? 1);
}

/**
 * 描邊的 CSS 色值。
 *
 * 透明度必須吃進色值本身：`-webkit-text-stroke-color` 沒有對應的 `-opacity` 屬性
 * （不像 SVG 的 `stroke-opacity`），而容器的 `opacity` 會把字身一起淡掉。
 */
export function strokeCssColor(stroke: { color: string; opacity: number }): string {
  return rgba(stroke.color, stroke.opacity);
}

function rgba(hex: string, alpha: number): string {
  const value = hex.slice(1);
  const channel = (offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}

import {
  TEXT_STROKE_DEFAULT_OPACITY,
  TEXT_STROKE_DEFAULT_WIDTH_EM,
  type EditableTextBox,
} from "./schemas.js";

/**
 * 一個文字框實際要畫的描邊；沒有描邊時回 `undefined`。
 *
 * 這是描邊的**唯一真相**，三個渲染端（伺服器 SVG、編輯器 DOM、PPTX）都必須呼叫它，
 * 不得各自讀 `box.strokeColor` 再自己乘一次字級——`strokeWidth` 存的是 em，換算成
 * 各端的長度單位是這個功能唯一會算錯的地方，而算錯的症狀是「編輯畫面與匯出的描邊
 * 粗細不一樣」，那是三端幾何不一致這個專案已經踩過三次（autofit、margin 順序、
 * CJK advance）的同一類坑。`page-number.ts` 是同一個模式。
 *
 * 回傳的 `widthPx` 是**畫布 px**：伺服器 SVG 直接用，編輯器換成 `cqh`，PPTX 換成 pt。
 */
export function textStroke(
  box: Pick<EditableTextBox, "strokeColor" | "strokeWidth" | "strokeOpacity" | "fontSize">,
): { color: string; widthPx: number; opacity: number } | undefined {
  // 色彩欄位是開關（與 `backgroundColor` 一致）；寬度被調到 0 一樣視為沒有描邊，
  // 否則會送出一個 `stroke-width="0"` 的無效果屬性到三個端點去。
  if (!box.strokeColor) return undefined;
  const widthEm = box.strokeWidth ?? TEXT_STROKE_DEFAULT_WIDTH_EM;
  const widthPx = box.fontSize * widthEm;
  if (widthPx <= 0) return undefined;
  return {
    color: box.strokeColor,
    widthPx,
    opacity: box.strokeOpacity ?? TEXT_STROKE_DEFAULT_OPACITY,
  };
}

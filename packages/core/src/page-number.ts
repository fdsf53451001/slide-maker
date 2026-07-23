import type { EditableTextBox, PageNumberSettings } from "./schemas.js";

/**
 * 這一頁要顯示的數字；不編號時回 undefined。`index` 是 0-based 的 `slide.order`。
 */
export function pageNumberValue(settings: PageNumberSettings, index: number): number | undefined {
  if (!settings.enabled) return undefined;
  if (settings.skipFirstSlide && index === 0) return undefined;
  return index - (settings.skipFirstSlide ? 1 : 0) + settings.startAt;
}

/**
 * `n / N` 的 N：最後一頁顯示的數字，而不是投影片張數——跳過封面時兩者差 1。
 */
export function pageNumberTotal(settings: PageNumberSettings, slideCount: number): number {
  const last = slideCount - 1 - (settings.skipFirstSlide ? 1 : 0) + settings.startAt;
  return Math.max(settings.startAt, last);
}

export function pageNumberLabel(
  settings: PageNumberSettings,
  index: number,
  slideCount: number,
): string | undefined {
  const value = pageNumberValue(settings, index);
  if (value === undefined) return undefined;
  if (settings.format === "number-total")
    return `${value} / ${pageNumberTotal(settings, slideCount)}`;
  if (settings.format === "zh-page") return `第 ${value} 頁`;
  return String(value);
}

/**
 * 全形／CJK 判定。色塊寬度只需要「三端算出同一個數字」，不需要真實字型量測——
 * 伺服器（resvg）、瀏覽器與 PowerPoint 的量測結果本來就不會一致，一致性比絕對精準重要。
 */
const FULL_WIDTH = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/**
 * 近似文字寬度（px）：全形 1em、半形空白 0.3em、其餘 0.6em。
 *
 * 只認半形空白與 tab，不用 `\s`——全形空白 U+3000 實際佔 1em，落進 `\s` 會被當成 0.3em。
 */
export function approximateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) {
    if (/[ \t]/.test(char)) em += 0.3;
    else if (FULL_WIDTH.test(char)) em += 1;
    else em += 0.6;
  }
  return em * fontSize;
}

export type PageNumberChip = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  color: string;
  opacity: number;
  /**
   * 色塊左右內距（px）。色塊本身是往外墊出去的，文字仍錨在 `text` 的邊距上；
   * 把文字框換成色塊幾何的渲染端（PPTX）要靠這個值把文字起點推回原本的邊距。
   */
  padX: number;
};

export type PageNumberLayout = {
  /** 與 `editableTextBoxSchema` 相容，可直接餵給 `textOverlaySvg()` 或 pptx 轉換。 */
  text: EditableTextBox;
  chip?: PageNumberChip;
};

/**
 * 頁碼的版面幾何，三個渲染端（伺服器 SVG 合成、編輯器 DOM、PPTX 文字框）共用同一份。
 *
 * 文字框刻意取全寬並靠 `align` 對齊，而不是依文字量測算出緊框：量測在三端不可能一致，
 * 全寬對齊則讓落點只取決於邊距，預覽與匯出因此必然對得上。
 */
export function pageNumberLayout(
  settings: PageNumberSettings,
  canvas: { width: number; height: number },
  label: string,
): PageNumberLayout {
  const marginX = Math.round(canvas.width * 0.033);
  const marginY = Math.round(canvas.height * 0.037);
  const height = Math.round(settings.fontSize * 1.2);
  const y = canvas.height - marginY - height;
  const align =
    settings.position === "bottom-left"
      ? ("left" as const)
      : settings.position === "bottom-center"
        ? ("center" as const)
        : ("right" as const);
  const text: EditableTextBox = {
    id: "page-number",
    text: label,
    x: marginX,
    y,
    width: canvas.width - marginX * 2,
    height,
    // 已知落差：三端的 "Arial" fallback 不同（resvg 依伺服器字型設定、瀏覽器依系統、
    // PowerPoint 依安裝字型），`第 N 頁` 這種 CJK 標籤的實際字寬因此三端不會完全一致。
    // 文字錨點只取決於邊距（全寬對齊）所以落點仍一致，受影響的只有色塊寬度的近似值。
    fontFamily: "Arial",
    fontSize: settings.fontSize,
    fontWeight: 400,
    color: settings.color,
    opacity: settings.opacity,
    lineHeight: 1.2,
    letterSpacing: 0,
    align,
    verticalAlign: "middle",
    rotation: 0,
    confidence: 1,
    role: "presentation",
  };
  if (!settings.background.enabled) return { text };
  const padX = settings.fontSize * 0.55;
  const padY = settings.fontSize * 0.32;
  const chipWidth = approximateTextWidth(label, settings.fontSize) + padX * 2;
  const chipHeight = height + padY * 2;
  const idealX =
    align === "left"
      ? marginX - padX
      : align === "center"
        ? (canvas.width - chipWidth) / 2
        : canvas.width - marginX + padX - chipWidth;
  // 兩側對稱夾制：極端字級／窄畫布下色塊可能比畫布還寬，左右都要夾住才不會出現負的 x
  // 或整塊掉到右緣外。色塊比畫布寬時退化成貼齊左緣（`Math.max(0, …)` 的上界仍是 0）。
  const chipX = Math.min(Math.max(idealX, 0), Math.max(canvas.width - chipWidth, 0));
  return {
    text,
    chip: {
      x: chipX,
      // 與文字框共用中線，色塊才會真的墊在字底下而不是偏上／偏下。
      y: y + height / 2 - chipHeight / 2,
      width: chipWidth,
      height: chipHeight,
      radius: chipHeight / 2,
      color: settings.background.color,
      opacity: settings.background.opacity,
      padX,
    },
  };
}

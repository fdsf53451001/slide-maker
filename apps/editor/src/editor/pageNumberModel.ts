import type { PageNumberSettings } from "@slide-maker/core";

/** 頁碼設定的部分更新；`background` 是巢狀 partial，與伺服器端的 PATCH schema 同形。 */
export type PageNumberPatch = Partial<Omit<PageNumberSettings, "background">> & {
  background?: Partial<PageNumberSettings["background"]>;
};

/**
 * 連續型控制項（滑桿、色票）合併連發變更的視窗。
 *
 * 拖一次滑桿是數十個 change；取到「放手後幾乎立刻生效」與「一次拖曳只寫一次」的平衡。
 */
export const PAGE_NUMBER_DEBOUNCE_MS = 250;

export function mergePageNumber(
  current: PageNumberSettings,
  patch: PageNumberPatch,
): PageNumberSettings {
  return { ...current, ...patch, background: { ...current.background, ...patch.background } };
}

import { useEffect, useLayoutEffect } from "react";

/**
 * 量版面的 effect 要在繪製前跑（見 `Editor` 裡的用處），但 `useLayoutEffect` 在沒有 DOM 的
 * 環境會警告。`apps/editor` 另外有 library build，可能被別人放進 SSR 的頁面裡，所以在那邊
 * 退回 passive effect——反正沒有 DOM 時本來也量不到東西。
 */
export const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

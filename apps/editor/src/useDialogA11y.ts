import { useEffect, useRef, type RefObject } from "react";

/**
 * 對話框的焦點契約：進場聚焦、離場還原、Tab 關在框內。
 *
 * 抽成一份而不是各對話框自己寫，是因為三件事必須**一起**成立才有意義，而它們很容易只做一半：
 * 只做進場聚焦，關閉後焦點掉回 `<body>`，鍵盤使用者要從頁首重新 Tab 一次；只做焦點還原，
 * Tab 仍會走出對話框、進到那片已被 `aria-modal="true"` 宣告為不存在的頁面（螢幕閱讀器此刻
 * 念的是「不該存在的內容」，視覺焦點環則消失在遮罩底下）。實測過的具體災情：來源面板的收合鈕
 * 就在對話框背後，Tab 走到它按下去，`display: none` 讓 `position: fixed` 的後代跟著消失，
 * 填到一半的對話框整個不見。
 *
 * Escape 刻意**不**由這支 hook 處理：專案裡的 Escape 有既有的集中式鏈（`SourcePanel` 逐層
 * 關閉、`Editor` 的簡報／影像編輯／風格選擇），順序與忙碌守衛都有語意，這裡再攔一次只會兩邊
 * 打架。呼叫端自己接 Escape，這支只管焦點。
 */
export function useDialogA11y(containerRef: RefObject<HTMLElement | null>, open: boolean): void {
  // 觸發者存在 ref 而不是 state：還原時機在 cleanup，重新 render 不該影響它。
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  // 擷取觸發者必須在 **render 期**，不能放進 effect：React 在 commit 階段就把 `autoFocus`
  // 的焦點搬進對話框，而 passive effect 跑在那之後——effect 裡讀到的 `document.activeElement`
  // 已經是框內那個輸入框，於是「還原焦點」會指著一個馬上要被卸載的節點，`isConnected` 為 false、
  // 整個還原靜默失效。實測受影響的正是四個使用者在裡面打字的對話框（搜尋、貼上網址、輸入文字
  // 來源、編輯當頁圖片），而沒有 `autoFocus` 的系統設定卻是好的——所以只測一個對話框會誤判成通過。
  // 改用 `useLayoutEffect` 沒有用，React 的 autoFocus 一樣贏過 layout effect。
  //
  // 只在 false→true 那一次擷取，**且不在關閉時的 render 清掉**：關閉是「先 render(open=false)、
  // 再跑 cleanup」，在 render 裡清掉的話 cleanup 拿到的就是 null，等於又把還原弄壞一次。
  if (open && !wasOpen.current) {
    const previous = document.activeElement;
    // `document.body` 也是 HTMLElement，而它正是「使用者用滑鼠點開對話框」在 Safari 下的
    // 常態（Safari 不會把焦點給按鈕）。存下 body 只會讓 cleanup 對著 body 呼叫 focus()。
    returnFocusTo.current =
      previous instanceof HTMLElement && previous !== document.body ? previous : null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    // 進場聚焦：對話框內若已有元素被 autoFocus 接走就不要搶（搶了會把游標從輸入框拉出來）。
    if (!container.contains(document.activeElement)) {
      const target = firstFocusable(container) ?? container;
      target.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        // 沒有可聚焦的子元素時，焦點只能留在對話框本身（呼叫端會給 tabIndex={-1}）。
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      // 焦點還在對話框外（剛開啟、或被別的程式碼搶走）時，一律拉回邊界，
      // 否則第一次 Tab 會從頁面某處繼續走，等於沒有 trap。
      if (!(active instanceof HTMLElement) || !container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // capture 階段：畫布與全域快捷鍵也掛在 window 上，讓 trap 先拿到 Tab。
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const back = returnFocusTo.current;
      returnFocusTo.current = null;
      // 觸發者可能已隨對話框一起卸載（例如「刪除」後那一列就不在了），此時不要硬搶焦點。
      if (back && back.isConnected) back.focus();
    };
  }, [containerRef, open]);
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 匯出給測試用（生產程式碼裡只有這支 hook 需要它）。
 *
 * 釘 trap 行為的測試要斷言「首／末可聚焦元素」，而它原本自己重寫了一份選擇器、還漏掉
 * `inert`／`aria-hidden`／`checkVisibility` 三道過濾——同一個真相的兩份拷貝而且已經不一致，
 * 於是改動這裡的選擇器時，測試會靜默地拿另一組元素去比對，看起來全綠。
 */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute("inert") &&
      element.getAttribute("aria-hidden") !== "true" &&
      // jsdom 沒有版面資訊，`offsetParent` 永遠是 null；用它過濾會讓測試裡一個元素都不剩。
      (typeof element.checkVisibility === "function" ? element.checkVisibility() : true),
  );
}

function firstFocusable(container: HTMLElement): HTMLElement | undefined {
  return focusableWithin(container)[0];
}

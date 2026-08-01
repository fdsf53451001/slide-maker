import { useEffect } from "react";

/**
 * 對話框自己接 Escape。
 *
 * 刻意**不**掛回 `Editor` 那條集中式鏈：用到這支的三個對話框各有兩個以上的渲染點
 * （系統設定與三選一在編輯器與精靈都會出現、刪除簡報確認住在 `CreateProject`），而那條鏈
 * 的 effect 有 `project && workflowStage === "editing"` 的前提，精靈與專案列表那幾處根本
 * 跑不到它——集中化在這裡買不到一致性，只會讓一半的渲染點按 Esc 沒反應。
 *
 * `busy` 是忙碌守衛，語意與各對話框遮罩點擊那道一致：刪除／送出進行中時 Esc 不關閉，
 * 否則畫面收掉了、在飛的請求照樣跑完，使用者以為自己取消了。
 */
export function useDialogEscape(onEscape: () => void, busy = false): void {
  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape, busy]);
}

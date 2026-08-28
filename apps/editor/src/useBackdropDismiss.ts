import { useRef, type MouseEvent } from "react";

/**
 * 遮罩的關閉條件是「按下與放開都落在遮罩上」，不是 `onClick`。
 *
 * 在內文按住往外拖曳選字時，瀏覽器把 `click` 派送到兩者的共同祖先＝遮罩本身，
 * 面板會在放開滑鼠的瞬間關掉、選到的字也沒了。因為事件 target 本來就是遮罩，
 * 內容層的 `stopPropagation` 擋不住這條，只能比對按下時的落點。
 *
 * `enabled` 給忙碌守衛：請求還在跑時連點遮罩都不關（與 Escape 同一條理由）。
 */
export function useBackdropDismiss(onDismiss: () => void, enabled = true) {
  const pressedOnBackdrop = useRef(false);
  return {
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      pressedOnBackdrop.current = event.target === event.currentTarget;
    },
    onMouseUp: (event: MouseEvent<HTMLElement>) => {
      const fromBackdrop = pressedOnBackdrop.current;
      pressedOnBackdrop.current = false;
      if (fromBackdrop && event.target === event.currentTarget && enabled) onDismiss();
    },
  };
}

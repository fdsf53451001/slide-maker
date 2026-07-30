import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * TEXT BOX 面板裡一個「效果」的一整列：**勾選框開關 ＋ 旁邊一顆下拉**，
 * 詳細參數（色票、不透明度、粗細）全部收在下拉裡。
 *
 * 為什麼是這個形狀而不是把參數攤在面板上：底色與描邊各有 2–3 個參數，攤開就是兩個
 * 三四欄的 grid、佔掉面板約 150px，而它們是偶爾才調一次的東西——字體、字級、顏色
 * 那幾列才是常用的。收起來之後「有沒有套」仍然由勾選框本身講清楚（不需要另外一段
 * 摘要文字），色票則直接畫在觸發鈕上，不必打開就看得到現在是什麼顏色。
 *
 * 面板（`.panel-content`）是 `overflow-y: auto`，所以下拉**不能**用 `position: absolute`
 * ——會被捲動容器裁掉。改成 `position: fixed` 並由觸發鈕的 `getBoundingClientRect()`
 * 定位，捲動與改變視窗大小時重算，下方空間不足時往上翻。
 */
export function TextEffectRow({
  label,
  enabled,
  onEnabledChange,
  swatchColor,
  open,
  onOpenChange,
  children,
}: {
  /** 「底色」「描邊」。同時是勾選框的可見標籤與下拉的無障礙名稱來源。 */
  label: string;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** 畫在觸發鈕上的色塊；效果關閉時不畫（改用斜線底），免得看起來像已經套上了。 */
  swatchColor: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  children: ReactNode;
}) {
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  const close = useCallback(() => {
    onOpenChange(false);
    // 焦點回到剛才按的那顆按鈕——與專案其他彈出層一致，否則鍵盤使用者會被丟回文件開頭。
    triggerRef.current?.focus();
  }, [onOpenChange]);

  /**
   * 定位。用 `useLayoutEffect` 在瀏覽器繪製前算完，否則下拉會先閃在左上角再跳到定位。
   * 右緣對齊觸發鈕（面板靠右，往左展開才不會超出視窗），下方放不下就往上翻。
   */
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const anchor = trigger.getBoundingClientRect();
      const { width, height } = popover.getBoundingClientRect();
      const below = anchor.bottom + 6;
      const flip = below + height > window.innerHeight - 8;
      setPosition({
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
        top: flip ? Math.max(8, anchor.top - height - 6) : below,
      });
    };
    reposition();
    // capture 才收得到面板自己的捲動（scroll 不冒泡）。
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  /** Escape 與點擊外部都要關得掉——下拉沒有遮罩，這是唯一的兩條退路。 */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 不擋掉其他 Escape 消費者以外的事：這一層開著時，Escape 就是關這一層。
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // 點外面只關閉，不把焦點搶回按鈕——使用者的滑鼠已經去了別的地方。
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close, onOpenChange]);

  return (
    <div className="text-effect-row">
      <label className="text-effect-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            onEnabledChange(event.target.checked);
            // 關掉效果時把下拉一起收起來：裡面的控制項全是停用的，留著只是一片灰。
            if (!event.target.checked) onOpenChange(false);
          }}
        />
        {label}
      </label>
      <button
        ref={triggerRef}
        type="button"
        className="text-effect-trigger"
        // 這顆按鈕的可見內容只有色塊與箭頭，名稱一定要靠 aria-label。
        aria-label={`${label}設定`}
        title={enabled ? `${label}設定` : `先勾選${label}才能調整`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        // 沒套用就沒有東西可調；停用比「開了一片灰控制項」誠實。
        disabled={!enabled}
        onClick={() => onOpenChange(!open)}
      >
        <span
          className={`text-effect-swatch${enabled ? "" : " off"}`}
          style={enabled ? { background: swatchColor } : undefined}
          aria-hidden="true"
        />
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          className="text-effect-popover"
          role="dialog"
          aria-label={`${label}設定`}
          style={
            position
              ? { left: position.left, top: position.top }
              : // 還沒量到位置前先藏起來，避免閃一下左上角。
                { visibility: "hidden" }
          }
        >
          {children}
        </div>
      )}
    </div>
  );
}

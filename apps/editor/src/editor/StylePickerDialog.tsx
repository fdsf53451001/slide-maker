import type { RefObject } from "react";
import { STYLE_REFERENCE_IMAGE_LIMIT, type StylePreset } from "@slide-maker/core";
import { styleAssetUrl } from "../api.js";

/**
 * 「把這張圖加入風格庫」的風格選擇對話框。
 *
 * `dialogRef` 由呼叫端傳入，`useDialogA11y` 也留在那裡：它在 render 期就要擷取
 * `document.activeElement`，而 `Editor` 的 hook 全部必須排在路由 early return 之前——
 * 搬進這個只在開啟時才掛載的元件會改變 hook 的呼叫順序。
 *
 * 忙碌守衛（backdrop 點擊、關閉鈕、每張卡片）與集中 keydown 的 Esc 那道一致：顯示
 * 「正在準備參考圖…」時放行，對話框會消失但交棒流程照樣跑完並導頁。
 */
export function StylePickerDialog({
  dialogRef,
  styles,
  busy,
  onPick,
  onClose,
}: {
  dialogRef: RefObject<HTMLDivElement | null>;
  styles: readonly StylePreset[];
  busy: boolean;
  onPick: (styleId?: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div
      ref={dialogRef}
      className="style-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="選擇風格"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section className="style-picker" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="section-label">ADD TO STYLE LIBRARY</span>
            <h2>選擇要加入的風格</h2>
            <p>圖片會先帶入風格編輯頁，確認設定後再儲存新版本。</p>
          </div>
          <button aria-label="關閉風格選擇" disabled={busy} onClick={() => onClose()}>
            ×
          </button>
        </header>
        <button className="style-picker-new" disabled={busy} onClick={() => void onPick()}>
          <b>＋</b>
          <span>
            <strong>建立新風格</strong>
            <small>用這張圖片作為第一張參考圖</small>
          </span>
          <i>→</i>
        </button>
        <div className="style-picker-list">
          {styles.filter((style) => !style.system).length === 0 && (
            <p className="style-picker-empty">目前還沒有自訂風格，可以先建立新風格。</p>
          )}
          {styles
            .filter((style) => !style.system)
            .map((style) => {
              const cover =
                style.referenceImages.find((item) => item.id === style.coverImageId) ??
                style.referenceImages[0];
              const full = style.referenceImages.length >= STYLE_REFERENCE_IMAGE_LIMIT;
              return (
                <button
                  key={style.id}
                  className="style-picker-card"
                  disabled={busy || full}
                  onClick={() => void onPick(style.id)}
                >
                  <span
                    className="style-picker-cover"
                    style={
                      cover ? { backgroundImage: `url(${styleAssetUrl(cover.id)})` } : undefined
                    }
                  >
                    {cover ? "" : style.name.slice(0, 1)}
                  </span>
                  <span>
                    <strong>{style.name}</strong>
                    <small>
                      v{style.version} · 密度{" "}
                      {style.density === "high" ? "高" : style.density === "medium" ? "中" : "低"} ·
                      參考圖 {style.referenceImages.length}/{STYLE_REFERENCE_IMAGE_LIMIT}
                    </small>
                    {full && <em>參考圖已滿</em>}
                  </span>
                  <i>→</i>
                </button>
              );
            })}
        </div>
        {busy && <div className="style-picker-loading">正在準備參考圖…</div>}
      </section>
    </div>
  );
}

import { useRef } from "react";
import { useDialogA11y } from "../useDialogA11y.js";
import { useDialogEscape } from "./dialogEscape.js";
import { WebSearchToggle } from "./webSearch.js";
import type { CombinationSummary } from "./projectHelpers.js";

/**
 * 系統設定對話框。
 *
 * `error` 是**模態內**的失敗訊息，不能改用全域的 `ErrorToast`：`.toast` 是 `z-index: 20`、
 * `.system-settings-backdrop` 是 `z-index: 940`，而兩者同為 `.shell` 的子節點（`.shell` 沒有
 * transform／filter／contain，不建立 stacking context），所以 toast 會被鋪在遮罩底下。使用者
 * 只會看到勾選框閃一下就彈回原狀、毫無說明；jsdom 沒有版面，測試還照樣是綠的。模態內的失敗
 * 就在模態內講，不要改成把全域 toast 的 z-index 拉高（那等於讓錯誤浮在遮罩上、蓋住對話框）。
 */
export function SystemSettingsDialog({
  webSearchEnabled,
  webSearchBusy,
  onWebSearchToggle,
  combinations,
  combinationId,
  onCombinationId,
  onOpenModelLibrary,
  onClose,
  error,
}: {
  webSearchEnabled: boolean;
  webSearchBusy: boolean;
  onWebSearchToggle: (next: boolean) => void;
  combinations: CombinationSummary[];
  combinationId: string | undefined;
  onCombinationId: (value: string) => void;
  onOpenModelLibrary: () => void;
  onClose: () => void;
  error: string | undefined;
}) {
  const defaultCombination = combinations.find((item) => item.isDefault);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 焦點契約與 Escape：兩者都缺會讓「按齒輪 → 改一個設定 → 想收掉」變成無路可退——
  // Esc 沒反應、Tab 走出對話框到那片已宣告為不存在的頁面、關掉之後焦點掉回 <body>。
  useDialogA11y(dialogRef, true);
  useDialogEscape(onClose);
  return (
    <div
      ref={dialogRef}
      className="system-settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="系統設定"
      onClick={onClose}
    >
      <div className="system-settings-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="section-label">SYSTEM</span>
            <h2>系統設定</h2>
            <p>影像／文字／搜尋模型都由專案的模型組合決定。</p>
          </div>
          <button type="button" aria-label="關閉系統設定" onClick={onClose}>
            ×
          </button>
        </header>
        <label>
          專案模型組合
          <select
            value={combinationId ?? ""}
            disabled={combinations.length === 0}
            onChange={(event) => {
              if (event.target.value) onCombinationId(event.target.value);
            }}
          >
            <option value="">
              {`跟隨預設${defaultCombination ? `（${defaultCombination.name}）` : ""}`}
            </option>
            {combinations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.isDefault ? "（預設）" : ""}
              </option>
            ))}
          </select>
        </label>
        {/* 舊版是 live／cached／disabled 三選一，但 live 與 cached 在伺服器端行為完全相同
            （只有 disabled 會跳過搜尋），留著三個選項只是讓人以為有差別。 */}
        <WebSearchToggle
          className="system-settings-toggle"
          enabled={webSearchEnabled}
          busy={webSearchBusy}
          disabled={false}
          onToggle={onWebSearchToggle}
        />
        {error && (
          <p className="system-settings-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="system-settings-link" onClick={onOpenModelLibrary}>
          管理模型組合（模型庫）→
        </button>
      </div>
    </div>
  );
}

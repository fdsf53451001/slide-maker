import { useId, useRef, type ReactNode } from "react";
import { useDialogA11y } from "../useDialogA11y.js";
import { useDialogEscape } from "./dialogEscape.js";

/**
 * 批次生成遇到隱藏頁時，使用者選了什麼。
 *
 * `"all"` 刻意對應「不傳 `slideIds`」而不是「傳全部 id」：那是加入這個對話框之前的行為，
 * 沒有隱藏頁的專案完全不會走到這裡，兩條路才會逐位元相同。
 */
export type BatchGenerateChoice = "all" | "visible-only";

/**
 * 這個三選一問的是哪一種批次。
 *
 * 兩者的成本結構相同（隱藏頁不進成品，但處理它一樣燒一次影像模型配額），差別只在動詞與
 * 分母的意義：`generate` 的分母是整份簡報的頁數，`extract` 的分母是這次要抽字的頁數
 * （已經有文字層、還沒有圖的頁根本不在名單裡）。
 */
type BatchChoiceVariant = "generate" | "extract";

// 沒有獨立的 `label` 欄位：對話框的名稱直接指向畫面上的 `heading`，兩份字串必然一致。
const BATCH_CHOICE_COPY: Record<
  BatchChoiceVariant,
  { heading: string; visibleOnly: string; all: string }
> = {
  generate: {
    heading: "要連隱藏頁一起生成嗎？",
    visibleOnly: "只生成可見頁",
    all: "含隱藏頁一起生成",
  },
  extract: {
    heading: "要連隱藏頁一起抽離文字嗎？",
    visibleOnly: "只抽可見頁",
    all: "含隱藏頁一起抽",
  },
};

/**
 * 有隱藏頁、而且這次動作會為每一頁燒配額時，按下去要先問清楚要不要連隱藏頁一起做。
 *
 * 為什麼要問而不是只告知：隱藏頁不進 `pptx`／`pdf`、也不放映，但處理它一樣消耗影像模型
 * 配額——「全部頁面」這個字面承諾與「隱藏」這個意圖在這裡直接衝突，兩種答案都合理，
 * 所以是使用者的決定。`confirm()` 只有兩個答案，裝不下三選一。
 *
 * 三個呼叫點（inspector 的批次生成、精靈的確認生成、inspector 的批次抽字）共用這一份，
 * 不各寫一個。抽字只有在抹字引擎是**生圖模型**時才走這裡；OpenCV 在本機跑、不吃配額，
 * 沒有取捨可問，多一次點擊只是純粹的阻礙。
 */
export function BatchGenerateDialog({
  total,
  hiddenCount,
  busy,
  variant = "generate",
  body,
  onChoose,
  onCancel,
}: {
  total: number;
  hiddenCount: number;
  busy: boolean;
  variant?: BatchChoiceVariant;
  /** 覆寫說明段落；省略時用批次生成那一段。 */
  body?: ReactNode;
  onChoose: (choice: BatchGenerateChoice) => void;
  onCancel: () => void;
}) {
  const copy = BATCH_CHOICE_COPY[variant];
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useDialogA11y(dialogRef, true);
  // 忙碌守衛與遮罩點擊那道一致：整批已經在送出時關掉畫面不會取消任何東西。
  useDialogEscape(onCancel, busy);
  return (
    <div
      className="confirm-backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog choices"
        role="dialog"
        aria-modal="true"
        /*
         * 名稱指向畫面上那個 `<h2>`，不另外寫一份 `aria-label`：舊寫法的 `copy.label`
         * （「批次生成與隱藏頁」）與標題（「要連隱藏頁一起生成嗎？」）是兩串不同的字，
         * 聽到的和看到的對不起來，使用者無從確認自己在回答哪一個問題。
         */
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={headingId}>{copy.heading}</h2>
        <p>
          {body ?? (
            <>
              這份簡報共 <strong>{total}</strong> 頁，其中 <strong>{hiddenCount}</strong> 頁已隱藏。
              隱藏頁不會進 pptx／pdf 匯出，也不會出現在簡報放映中，但生成它一樣會消耗影像模型配額。
            </>
          )}
        </p>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" disabled={busy} onClick={() => onChoose("visible-only")}>
            {copy.visibleOnly}（{total - hiddenCount} 頁）
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => onChoose("all")}>
            {copy.all}（{total} 頁）
          </button>
        </div>
      </div>
    </div>
  );
}

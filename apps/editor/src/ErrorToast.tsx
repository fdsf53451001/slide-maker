/**
 * 錯誤 toast：畫面底部置中的那條紅色訊息。
 *
 * 抽成共用元件而不是各頁自己寫，是因為它在四個地方出現過四種寫法，而稽核抓到的正是這種漂移：
 * 同一個 `.toast error` 在編輯器主畫面有 `role="alert"`、在精靈與模型庫沒有——錯誤跳出來時
 * 螢幕閱讀器完全靜默，而那往往是「儲存失敗」。
 *
 * 結構上刻意是 `div[role="alert"]` 內含一顆具名按鈕，而**不是** `button[role="alert"]`：
 * `role="alert"` 會覆寫掉隱含的 button 角色，於是螢幕閱讀器會播報錯誤文字，卻不會告訴使用者
 * 這是一顆可以按下去關掉的東西，末尾那個 `×` 也只會被念成「乘號」或直接跳過。
 *
 * 代價是滑鼠命中區從「整條 toast」縮成那顆關閉鈕，所以 `styles.css` 給它 28px 見方——
 * 它是錯誤訊息唯一的關閉途徑。
 */
export function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="toast error" role="alert">
      {message}{" "}
      <button type="button" aria-label="關閉錯誤訊息" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import type { StyleReferenceImage } from "@slide-maker/core";
import { api } from "./api.js";
import { useDialogA11y } from "./useDialogA11y.js";

/**
 * 「從 PDF 建立風格」的頁面挑選器。無狀態流程：
 *  選 PDF → server render 前 N 頁回 data URL → 使用者勾選最多 `remaining` 張 →
 *  選中的頁面轉成 PNG File 走既有 uploadStyleReference 存成正式參考圖，回傳給 StyleEditor。
 */
export function PdfImportModal({
  remaining,
  onImported,
  onClose,
}: {
  remaining: number;
  onImported: (references: StyleReferenceImage[]) => void;
  onClose: () => void;
}) {
  const [pages, setPages] = useState<string[]>();
  const [totalPages, setTotalPages] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [fileName, setFileName] = useState<string>();
  const [selected, setSelected] = useState<number[]>([]); // 依勾選順序保留的頁碼
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogA11y(dialogRef, true);

  /**
   * Escape 關閉，但忙碌中一律不理會。
   *
   * 與遮罩點擊、關閉鈕同一條守衛：`confirm()` 的上傳迴圈是元件自己的 state，對話框一關
   * 就整個消失——已經成功的參考圖回不到 StyleEditor，失敗訊息也一起不見，而請求還在跑。
   * 這裡不接進任何集中式 Escape 鏈：風格編輯頁沒有那條鏈，這是唯一的一層。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const pick = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.renderPdfPages(file);
      setPages(result.pages);
      setTotalPages(result.totalPages);
      setTruncated(result.truncated);
      setFileName(file.name);
      setSelected([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PDF 解析失敗");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (index: number) =>
    setSelected((current) => {
      if (current.includes(index)) return current.filter((item) => item !== index);
      if (current.length >= remaining) return current; // 已達可加入上限
      return [...current, index];
    });

  const confirm = async () => {
    if (!pages || !selected.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const base = (fileName ?? "pdf").replace(/\.pdf$/i, "");
      const references: StyleReferenceImage[] = [];
      for (const index of selected) {
        const blob = await (await fetch(pages[index]!)).blob();
        const file = new File([blob], `${base}-p${index + 1}.png`, { type: "image/png" });
        references.push(await api.uploadStyleReference(file));
      }
      onImported(references);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "匯入失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    // 遮罩點擊與關閉鈕、Escape 共用同一條忙碌守衛：76／129 兩顆按鈕早就擋了 busy，只有這裡
    // 沒擋——上傳期間手滑點到背景就會把整個對話框連同進行中的迴圈與錯誤訊息一起丟掉。
    <div className="pdf-modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
      {/*
        無障礙樹上這原本是一團匿名 div：按下「從 PDF 匯入」之後，螢幕閱讀器不會有任何
        「有東西打開了」的訊息。形狀比照隔壁的 PdfDeckImportModal，只是名稱改用
        aria-labelledby 指向標題本身，標題改字時名稱不會漏掉沒改。
      */}
      <div
        className="pdf-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pdf-modal-header">
          <strong id={titleId}>從 PDF 匯入參考圖</strong>
          <button className="pdf-modal-close" onClick={onClose} disabled={busy} aria-label="關閉">
            ×
          </button>
        </header>
        {!pages ? (
          <label className="pdf-drop">
            {busy ? "解析中…" : "選擇 PDF 檔"}
            <input
              type="file"
              accept="application/pdf"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void pick(file);
              }}
            />
            <small>
              PowerPoint／Keynote 可先「另存為 PDF」再匯入。此風格還可加入 {remaining} 張參考圖。
            </small>
          </label>
        ) : (
          <>
            <div className="pdf-modal-note">
              {truncated
                ? `共 ${totalPages} 頁，僅顯示前 ${pages.length} 頁。`
                : `共 ${pages.length} 頁。`}{" "}
              已選 {selected.length}/{remaining}。
            </div>
            <div className="pdf-page-grid">
              {pages.map((dataUrl, index) => {
                const order = selected.indexOf(index);
                const chosen = order >= 0;
                const disabled = !chosen && selected.length >= remaining;
                return (
                  <button
                    key={index}
                    type="button"
                    className={`pdf-page${chosen ? " chosen" : ""}${disabled ? " disabled" : ""}`}
                    onClick={() => toggle(index)}
                    disabled={busy || disabled}
                  >
                    <img src={dataUrl} alt={`第 ${index + 1} 頁`} />
                    <span className="pdf-page-num">{index + 1}</span>
                    {chosen && <span className="pdf-page-badge">{order + 1}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {/*
          錯誤要 role="alert"：它出現的時機是使用者按下按鈕之後、焦點還停在按鈕上，畫面
          別處冒出一行紅字沒有任何機制會被讀出來。
        */}
        {error && (
          <div className="pdf-modal-error" role="alert">
            {error}
          </div>
        )}
        {/*
          解析與匯入都是分鐘級的等待（匯入還是一張一張上傳），只在按鈕與 drop 區改文字，
          讀屏使用者不會知道有東西在跑。做法與隔壁 PdfDeckImportModal 的進度列一致。
        */}
        {busy && (
          <div className="pdf-modal-progress" role="status">
            {pages
              ? `正在上傳 ${selected.length} 張參考圖，請勿關閉視窗。`
              : "正在解析 PDF 頁面，請稍候。"}
          </div>
        )}
        <footer className="pdf-modal-footer">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          {pages && (
            <button
              className="primary"
              disabled={busy || !selected.length}
              onClick={() => void confirm()}
            >
              {busy ? "匯入中…" : `加入 ${selected.length} 張`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

import { useState } from "react";
import type { StyleReferenceImage } from "@slide-maker/core";
import { api } from "./api.js";

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
    <div className="pdf-modal-backdrop" onClick={onClose}>
      <div className="pdf-modal" onClick={(event) => event.stopPropagation()}>
        <header className="pdf-modal-header">
          <strong>從 PDF 匯入參考圖</strong>
          <button className="pdf-modal-close" onClick={onClose} disabled={busy}>
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
        {error && <div className="pdf-modal-error">{error}</div>}
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

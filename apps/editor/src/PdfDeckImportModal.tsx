import { useState } from "react";
import type { PresentationProject } from "@slide-maker/core";
import { api, type PdfDeckImportReport, type PdfDeckInspection } from "./api.js";

/**
 * 「把一份既有 PDF 匯入成簡報專案」的選頁對話框。
 *
 * 與 `PdfImportModal`（從 PDF 建立風格參考圖）沒有共用：那條是挑最多 4 張參考圖，
 * 這條是把整份 PDF 落地成專案。流程：
 *   選檔 → server 前置比例檢查（不 render）＋縮圖 → 預設全選、可取消勾選 → 確認匯入。
 */
export function PdfDeckImportModal({
  onImported,
  onClose,
}: {
  onImported: (project: PresentationProject, report: PdfDeckImportReport) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File>();
  const [inspection, setInspection] = useState<PdfDeckInspection>();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const pick = async (picked: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.inspectPdfDeck(picked);
      setInspection(result);
      setFile(picked);
      setName(picked.name.replace(/\.pdf$/i, "").trim() || "匯入的簡報");
      // 預設全選；封底、附錄由使用者自行取消勾選。
      setSelected(result.acceptedPages.filter((page) => !result.failedPages.includes(page)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PDF 解析失敗");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (pageNumber: number) =>
    setSelected((current) =>
      current.includes(pageNumber)
        ? current.filter((item) => item !== pageNumber)
        : [...current, pageNumber].sort((left, right) => left - right),
    );

  const confirm = async () => {
    if (!file || !selected.length || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const { project, report } = await api.importPdfDeck(file, name.trim(), selected);
      onImported(project, report);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "匯入失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pdf-modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div
        className="pdf-modal"
        role="dialog"
        aria-modal="true"
        aria-label="從 PDF 匯入簡報"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pdf-modal-header">
          <strong>從 PDF 匯入簡報</strong>
          <button className="pdf-modal-close" onClick={onClose} disabled={busy} aria-label="關閉">
            ×
          </button>
        </header>
        {!inspection ? (
          <label className="pdf-drop">
            {busy ? "解析中…" : "選擇 PDF 檔"}
            <input
              type="file"
              accept="application/pdf"
              disabled={busy}
              onChange={(event) => {
                const picked = event.target.files?.[0];
                event.target.value = "";
                if (picked) void pick(picked);
              }}
            />
            <small>
              只收 16:9 的頁面，最多 150 頁、100MB。PowerPoint／Keynote 可先「另存為 PDF」再匯入。
            </small>
          </label>
        ) : (
          <>
            <div className="pdf-deck-name">
              <label>
                簡報名稱
                <input
                  value={name}
                  maxLength={200}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <span>
                共 {inspection.totalPages} 頁，已選 {selected.length} 頁。
              </span>
            </div>
            {(inspection.skippedPages.length > 0 ||
              inspection.failedPages.length > 0 ||
              inspection.truncated) && (
              <div className="pdf-modal-note">
                {inspection.skippedPages.length > 0 && (
                  <div>比例與第一頁不同，已略過：第 {inspection.skippedPages.join("、")} 頁。</div>
                )}
                {inspection.failedPages.length > 0 && (
                  <div>無法讀取預覽，已略過：第 {inspection.failedPages.join("、")} 頁。</div>
                )}
                {inspection.truncated && <div>超過 {inspection.maxPages} 頁的部分不會匯入。</div>}
              </div>
            )}
            <div className="pdf-page-grid">
              {inspection.previews.map((preview) => {
                const chosen = selected.includes(preview.pageNumber);
                return (
                  <button
                    key={preview.pageNumber}
                    type="button"
                    className={`pdf-page${chosen ? " chosen" : ""}`}
                    aria-pressed={chosen}
                    onClick={() => toggle(preview.pageNumber)}
                    disabled={busy}
                  >
                    <img src={preview.dataUrl} alt={`第 ${preview.pageNumber} 頁`} />
                    <span className="pdf-page-num">{preview.pageNumber}</span>
                    {chosen && <span className="pdf-page-badge">✓</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {error && <div className="pdf-modal-error">{error}</div>}
        {/*
          每頁要 render 原圖、再抽一次可編輯文字層，實測約 0.6 秒／頁——150 頁要一分半。
          按鈕上的「匯入中…」不足以說明這段等待，這裡明講在做什麼、大概多久。
        */}
        {busy && inspection && (
          <div className="pdf-modal-progress" role="status">
            正在處理 {selected.length} 頁：每頁都會建立原始頁面與可編輯文字兩個版本， 大約需要{" "}
            {Math.max(1, Math.round((selected.length * 0.65) / 5) * 5)} 秒，請勿關閉視窗。
          </div>
        )}
        <footer className="pdf-modal-footer">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          {inspection && (
            <button
              className="primary"
              disabled={busy || !selected.length || !name.trim()}
              onClick={() => void confirm()}
            >
              {busy ? "匯入中…" : `匯入 ${selected.length} 頁`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

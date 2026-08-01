import { useCallback, useId, useRef, useState } from "react";
import type { PresentationProject, StylePreset } from "@slide-maker/core";
import { api, styleAssetUrl } from "../api.js";
import { LibraryHeader } from "../LibraryHeader.js";
import { PdfDeckImportModal } from "../PdfDeckImportModal.js";
import { useDialogA11y } from "../useDialogA11y.js";
import { useDialogEscape } from "./dialogEscape.js";
import { currentImage } from "./projectHelpers.js";

export function CreateProject({
  projects,
  styles,
  styleLibrary,
  onOpen,
  onCreate,
  onNavigate,
  onDelete,
  onImportNotice,
  onError,
}: {
  projects: PresentationProject[];
  styles: StylePreset[];
  styleLibrary: boolean;
  onOpen: (project: PresentationProject) => void;
  onCreate: (topic: string, styleId?: string) => Promise<void>;
  onNavigate: (path: string) => void;
  onDelete: (project: PresentationProject) => Promise<void>;
  /** 匯入報告要交給上層顯示：`onOpen` 會立刻把這個元件換掉。 */
  onImportNotice: (notice: string | undefined) => void;
  /**
   * 失敗訊息也往上交給 App 的那一個 toast。`.toast` 是 `position: fixed` 的固定座標，
   * 這裡自己再渲染一個會與 App 的疊在同一點（例如開頁時 listProjects 失敗、又接著
   * 匯入失敗），後蓋前，其中一則就此看不到。
   */
  onError: (message: string | undefined) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [topic, setTopic] = useState("");
  const [selectedStyleId, setSelectedStyleId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("style") ?? undefined,
  );
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PresentationProject | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);
  const bundleInput = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmHeadingId = useId();
  useDialogA11y(confirmRef, !!pendingDelete);
  /*
   * 刪除是破壞性的，而 Escape 正是使用者最想反悔的那一下——在此之前它完全沒反應，只剩
   * 「取消」按鈕與遮罩點擊兩條路。`useCallback` 讓 `deleting` 以外的 render 不重掛 listener。
   * 刪除進行中不關閉：畫面收掉了請求照樣跑完，使用者會以為自己攔下了它。
   */
  useDialogEscape(
    useCallback(() => setPendingDelete(undefined), []),
    !pendingDelete || deleting,
  );

  /** 匯入 `.slide-project.zip`：成功就直接進該專案，失敗把伺服器的理由留在畫面上。 */
  const importBundle = async (file: File) => {
    setBundleBusy(true);
    onError(undefined);
    try {
      onOpen(await api.importProjectBundle(file));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "匯入專案檔失敗");
    } finally {
      setBundleBusy(false);
    }
  };
  const styleCard = (style: StylePreset) => {
    const cover =
      style.referenceImages.find((item) => item.id === style.coverImageId) ??
      style.referenceImages[0];
    return (
      <article key={style.id} className="style-card">
        <button className="style-card-preview" onClick={() => onNavigate(`/styles/${style.id}`)}>
          {cover ? (
            <img src={styleAssetUrl(cover.id)} alt={`${style.name} 封面`} />
          ) : (
            <span>
              {style.name}
              <small>尚無封面圖</small>
            </span>
          )}
        </button>
        <strong>{style.name}</strong>
        <small>
          v{style.version} · 密度{" "}
          {style.density === "high" ? "高" : style.density === "medium" ? "中" : "低"}
        </small>
        <div>
          <button onClick={() => onNavigate(`/styles/${style.id}`)}>編輯</button>
          <button onClick={() => onNavigate(`/?style=${style.id}`)}>套用建立</button>
        </div>
      </article>
    );
  };
  return (
    <main className={`welcome dashboard ${styleLibrary ? "library-mode" : ""}`}>
      <LibraryHeader active={styleLibrary ? "styles" : "decks"} onNavigate={onNavigate} />
      <div className="dashboard-content">
        {!styleLibrary ? (
          <>
            <section className="create-panel">
              <div>
                <span className="section-label">NEW PRESENTATION</span>
                <h1>今天想做什麼簡報？</h1>
                <p>描述主題、用途、對象與想要的頁數，AI 會先整理成可確認的大綱。</p>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!topic.trim()) return;
                  setBusy(true);
                  void onCreate(topic, selectedStyleId).finally(() => setBusy(false));
                }}
              >
                <input
                  aria-label="簡報需求"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="例如：向主管說明 AI agent 導入計畫、效益與風險"
                  autoFocus
                />
                <button className="primary" disabled={busy || !topic.trim()}>
                  {busy ? "建立中…" : "開始規劃 →"}
                </button>
              </form>
              <small>
                頁數由你的需求與 AI 大綱決定。
                {selectedStyleId
                  ? `目前風格：${styles.find((item) => item.id === selectedStyleId)?.name ?? "已選風格"}`
                  : "未指定時由 AI 自由設計。"}
              </small>
            </section>

            <section className="dashboard-section style-start-section">
              <div className="dashboard-section-heading">
                <div>
                  <span className="section-label">START WITH A STYLE</span>
                  <h2>從風格開始</h2>
                </div>
                <button onClick={() => onNavigate("/styles")}>查看風格庫 →</button>
              </div>
              <div className="style-quick-list">
                {styles.map((style) => {
                  const cover =
                    style.referenceImages.find((item) => item.id === style.coverImageId) ??
                    style.referenceImages[0];
                  return (
                    <button
                      key={style.id}
                      className={`style-quick-card ${selectedStyleId === style.id ? "selected" : ""}`}
                      onClick={() => setSelectedStyleId(style.id)}
                    >
                      <span>
                        {cover ? (
                          <img src={styleAssetUrl(cover.id)} alt="" />
                        ) : (
                          <b>{style.name.slice(0, 1)}</b>
                        )}
                      </span>
                      <strong>{style.name}</strong>
                      <small>
                        密度{" "}
                        {style.density === "high" ? "高" : style.density === "medium" ? "中" : "低"}
                      </small>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="dashboard-section recent-projects">
              <div className="dashboard-section-heading">
                <div>
                  <span className="section-label">YOUR WORK</span>
                  <h2>最近簡報</h2>
                </div>
                {/*
                  兩條匯入入口與「建立簡報」地位對等，都不進四步 wizard：
                  PDF 選頁後專案立刻落地，`.slide-project.zip` 則是還原一份既有備份。
                */}
                <div className="dashboard-section-actions">
                  <span>{projects.length} 份簡報</span>
                  <button type="button" onClick={() => setImporting(true)}>
                    匯入 PDF
                  </button>
                  <button
                    type="button"
                    disabled={bundleBusy}
                    onClick={() => bundleInput.current?.click()}
                  >
                    {bundleBusy ? "匯入中…" : "匯入專案檔"}
                  </button>
                  {/*
                    瀏覽器的 accept 只認最後一段副檔名，寫 `.slide-project.zip` 不會生效。
                    同一個檔案再選一次也要能觸發，所以讀完就把 value 清掉。
                  */}
                  <input
                    ref={bundleInput}
                    type="file"
                    accept=".zip"
                    hidden
                    aria-hidden="true"
                    onChange={(event) => {
                      const picked = event.target.files?.[0];
                      event.target.value = "";
                      if (picked) void importBundle(picked);
                    }}
                  />
                </div>
              </div>
              {projects.length === 0 ? (
                <div className="empty-dashboard">
                  <b>還沒有簡報</b>
                  <span>在上方輸入需求，建立第一份內容。</span>
                </div>
              ) : (
                <div className="project-grid">
                  {projects.map((project) => {
                    const cover = project.slides[0]
                      ? currentImage(project, project.slides[0])
                      : undefined;
                    return (
                      <div key={project.id} className="project-card">
                        <button
                          className="project-card-body"
                          onClick={() => onOpen(project)}
                          aria-label={`開啟 ${project.name}`}
                        >
                          <span className="project-card-cover">
                            {cover ? (
                              <img src={cover} alt={`${project.name} 第一頁`} />
                            ) : (
                              <b>
                                {project.slides.length ? `${project.slides.length} 頁` : "空白"}
                              </b>
                            )}
                          </span>
                          <span className="project-card-info">
                            <strong>{project.name}</strong>
                            <small>
                              {project.slides.length} 頁 ·{" "}
                              {new Date(project.updatedAt).toLocaleString("zh-TW")}
                            </small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="project-card-delete"
                          aria-label={`刪除 ${project.name}`}
                          title="刪除簡報"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(project);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="dashboard-section style-library-section">
            <div className="library-heading">
              <div>
                <span className="section-label">STYLE LIBRARY</span>
                <h1>風格庫</h1>
                <p>用參考圖與視覺規則，維持不同簡報之間的一致性。</p>
              </div>
              <button className="primary new-style" onClick={() => onNavigate("/styles/new")}>
                ＋ 建立風格
              </button>
            </div>
            <div className="style-library">{styles.map(styleCard)}</div>
          </section>
        )}
      </div>
      {importing && (
        <PdfDeckImportModal
          onClose={() => setImporting(false)}
          onImported={(project, report) => {
            setImporting(false);
            const notes = [
              report.skippedPages.length
                ? `比例不符略過第 ${report.skippedPages.join("、")} 頁`
                : "",
              report.failedPages.length
                ? `render 失敗略過第 ${report.failedPages.join("、")} 頁`
                : "",
              report.textLayerFailedPages.length
                ? `第 ${report.textLayerFailedPages.join("、")} 頁沒有可編輯文字版本`
                : "",
              report.truncated ? `頁數超過上限，只取前 ${report.importedPages.length} 頁` : "",
            ].filter(Boolean);
            onImportNotice(
              notes.length
                ? `已匯入 ${project.slides.length} 頁：${notes.join("；")}。`
                : undefined,
            );
            onOpen(project);
          }}
        />
      )}
      {pendingDelete && (
        <div
          className="confirm-backdrop"
          onClick={() => {
            if (!deleting) setPendingDelete(undefined);
          }}
        >
          <div
            ref={confirmRef}
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            // 沒有名稱時螢幕閱讀器只念得到「對話方塊」；破壞性確認尤其不能沒有標題。
            aria-labelledby={confirmHeadingId}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={confirmHeadingId}>刪除簡報</h2>
            <p>
              確定要刪除「<strong>{pendingDelete.name}</strong>
              」嗎？此動作無法復原，簡報的所有頁面與版本都會一併移除。
            </p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setPendingDelete(undefined)} disabled={deleting}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={deleting}
                onClick={async () => {
                  const target = pendingDelete;
                  setDeleting(true);
                  try {
                    await onDelete(target);
                    setPendingDelete(undefined);
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? "刪除中…" : "刪除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

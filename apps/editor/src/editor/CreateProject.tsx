import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
  TONAL_REGISTER_LABELS,
  type PresentationProject,
  type StylePreset,
} from "@slide-maker/core";
import { api, styleAssetUrl } from "../api.js";
import { LibraryHeader } from "../LibraryHeader.js";
import { PdfDeckImportModal } from "../PdfDeckImportModal.js";
import { useDialogA11y } from "../useDialogA11y.js";
import {
  AI_STYLE_ORIGIN_LABELS,
  aiStyleEntries,
  styleLibraryCopyInput,
  type AiStyleEntry,
} from "./aiStyles.js";
import { useDialogEscape } from "./dialogEscape.js";
import { currentImage } from "./projectHelpers.js";

/**
 * 「AI 產生」區的兩段固定文案。
 *
 * 寫成字串常數而不是直接放進 JSX：這兩句都超過一行，Prettier 會把它們折行，而 JSX 把
 * 「換行＋縮排」收斂成一個半形空白——中文句子中間於是多出一個看得見的空格。
 */
const AI_STYLE_TRADEOFF =
  "複製到風格庫的是當下的快照：原簡報維持不變、之後兩邊也不會互相同步，而且複本只帶設計系統，不含參考圖。";

const AI_STYLE_EMPTY_HINT =
  "用「AI 自由設計」產生大綱後，系統會替那份簡報決議一套專屬的設計系統；從 PDF 匯入並分析參考圖也會產生一套。它們只屬於各自的簡報，會列在這裡。";

export function CreateProject({
  projects,
  styles,
  styleLibrary,
  onOpen,
  onCreate,
  onNavigate,
  onDelete,
  onStyleCreated,
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
  /**
   * 新建立的風格庫項目（目前只有「AI 產生」區的複製動作會用到）。交回上層而不是自己
   * 重抓一次 `GET /api/styles`：`styles` 這份清單住在 `Editor`，這裡塞不回去，而少了它，
   * 使用者按完複製之後上方的風格庫要等重新整理才看得到新的那一份。
   */
  onStyleCreated: (style: StylePreset) => void;
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
  /** 正在複製到風格庫的那一份（專案 id）。同時只允許一個：兩下點擊會建出兩份同名風格。 */
  const [copyingStyleFor, setCopyingStyleFor] = useState<string>();
  /** 已經複製成功的專案 id → 複本名稱。訊息留在卡片上，不佔全域 toast。 */
  const [copiedStyles, setCopiedStyles] = useState<Record<string, string>>({});
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
  // 只在風格庫頁用得到，但 hook 不能掛在條件裡。
  const aiStyles = useMemo(() => aiStyleEntries(projects), [projects]);

  /**
   * 複製一份到風格庫。**新 id、快照拷貝、原專案不改指向**——改指向就等於把它放回
   * 「風格庫查得到 → 版本一動就被整包蓋掉」的老路（見 `aiStyles.ts` 的註解）。
   */
  const copyStyleToLibrary = async (entry: AiStyleEntry) => {
    setCopyingStyleFor(entry.project.id);
    onError(undefined);
    try {
      const created = await api.createStyle(styleLibraryCopyInput(entry));
      onStyleCreated(created);
      setCopiedStyles((current) => ({ ...current, [entry.project.id]: created.name }));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "複製到風格庫失敗");
    } finally {
      setCopyingStyleFor(undefined);
    }
  };

  const aiStyleCard = (entry: AiStyleEntry) => {
    const copying = copyingStyleFor === entry.project.id;
    const copied = copiedStyles[entry.project.id];
    return (
      <article key={entry.project.id} className="style-card ai-style-card">
        <button
          className="style-card-preview"
          /*
           * 縮圖點下去看的是**設計系統**，不是開簡報。這一區存在的理由就是那份設計系統
           * 在此之前完全不可見（產生了、每頁都在用、但沒有任何路徑讀得到它），點縮圖跳去
           * 簡報等於把使用者送回原本那個黑箱。開簡報留在下方的具名按鈕。
           *
           * 一般風格卡片的縮圖是 `onNavigate('/styles/:id')`，那條路對這一區不成立——
           * 專案本地風格刻意不在風格庫裡，`GET /api/styles/:id` 會 404。
           */
          onClick={() => onNavigate(`/styles/ai/${entry.project.id}`)}
          aria-label={`查看 ${entry.project.name} 的設計系統`}
        >
          {/* 不寫「第一頁」：取的是第一張**有圖的可見頁**，未必是第 1 頁（見 aiStyles.ts）。 */}
          {entry.cover ? (
            <img src={entry.cover} alt={`${entry.style.name} 的頁面預覽`} />
          ) : (
            <span>
              {entry.style.name}
              <small>尚未生成任何頁面</small>
            </span>
          )}
        </button>
        {/*
         * 版面與一般風格卡片**逐格相同**：粗體識別字 ＋ 一行 dim meta ＋ 兩顆等寬按鈕。
         * 這一區與那一區在同一個 220px 格線裡並排，多一列 chips、多一顆按鈕、底下再多一行
         * 狀態字，看起來就是另一個東西——而它們本來就該讀成同一類。
         *
         * 粗體放**專案名**而不是風格名：風格名常常是「AI 自由設計」這種泛稱（決議那條路
         * 沿用預設風格的名字），三張卡片並排會全部長一樣，分不出誰是誰。
         */}
        <strong>{entry.project.name}</strong>
        <small>
          {AI_STYLE_ORIGIN_LABELS[entry.origin]}
          {/* 舊格式沒有明暗登記那一行就不顯示——猜錯的那一半會把淺色簡報標成深色。 */}
          {entry.tonalRegister && ` · ${TONAL_REGISTER_LABELS[entry.tonalRegister]}`}
        </small>
        <div>
          <button onClick={() => onNavigate(`/styles/ai/${entry.project.id}`)}>查看設計</button>
          {/* 複製結果回報在按鈕自己身上，不另外多一行：那一行會把這張卡片撐得比鄰居高。 */}
          <button disabled={copying || !!copied} onClick={() => void copyStyleToLibrary(entry)}>
            {copying ? "複製中…" : copied ? "已複製" : "複製到風格庫"}
          </button>
        </div>
      </article>
    );
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
          <>
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

            {/*
              各專案自己那份 AI 產生的設計系統。**唯讀衍生視圖**：這裡不做刪除、改名、編輯
              ——那些風格必須留在風格庫之外才不會被生成前的版本同步蓋掉（見 aiStyles.ts）。
              要編輯就先複製一份到風格庫。
            */}
            <section className="dashboard-section ai-style-section">
              <div className="dashboard-section-heading">
                <div>
                  <span className="section-label">GENERATED BY AI</span>
                  <h2>AI 產生</h2>
                  <p>{AI_STYLE_TRADEOFF}</p>
                </div>
                <span>{aiStyles.length} 套</span>
              </div>
              {aiStyles.length === 0 ? (
                <div className="empty-dashboard">
                  <b>還沒有 AI 產生的設計系統</b>
                  <span>{AI_STYLE_EMPTY_HINT}</span>
                </div>
              ) : (
                <div className="style-library">{aiStyles.map(aiStyleCard)}</div>
              )}
            </section>
          </>
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

import { Fragment, useEffect, useRef, useState } from "react";
import type { PresentationProject, SourceAsset } from "@slide-maker/core";
import { api, projectAssetUrl, type UrlSourceFailure, type WebSearchResult } from "./api.js";
import { highlightSegments, matchSource, searchTerms } from "./sourceSearch.js";

export function sourceTypeLabel(source: SourceAsset): string {
  if (source.mediaType.startsWith("image/")) return "圖片";
  if (source.mediaType === "application/pdf") return "PDF";
  if (source.mediaType.includes("presentationml")) return "PPTX";
  if (source.mediaType.includes("wordprocessingml")) return "DOCX";
  if (source.mediaType === "text/markdown") return "Markdown";
  return "文字";
}

function sourceSummary(source: SourceAsset): string {
  return source.extractedText.replace(/\s+/g, " ").trim();
}

function sourceUsageLabel(source: SourceAsset): string {
  return (
    {
      content: "內容依據",
      "visual-reference": "視覺參考",
      "style-reference": "風格參考",
      "direct-asset": "直接素材",
      "exclude-from-generation": "不參與生成",
    } as const
  )[source.usage];
}

function sourceSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 ** 2) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
}

function SourcePreviewDialog({
  projectId,
  source,
  terms,
  onClose,
}: {
  projectId: string;
  source: SourceAsset;
  terms: readonly string[];
  onClose: () => void;
}) {
  const imageSource = source.mediaType.startsWith("image/");
  const summary = sourceSummary(source);
  const assetUrl = projectAssetUrl(projectId, source.assetPath);
  // 只 highlight 全文；簡介是壓縮空白後的另一份文字，兩邊都標會讓視線分散。
  const segments = highlightSegments(source.extractedText, terms);
  const firstHit = segments.findIndex((segment) => segment.hit);
  const firstHitRef = useRef<HTMLElement>(null);
  useEffect(() => {
    firstHitRef.current?.scrollIntoView?.({ block: "center" });
  }, [source.id]);
  return (
    <div
      className="source-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`預覽來源：${source.name}`}
      onClick={onClose}
    >
      <section
        className={`source-preview-dialog ${imageSource ? "image" : "text"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">SOURCE DETAIL · {sourceTypeLabel(source)}</span>
            <h2>{source.name}</h2>
          </div>
          <button type="button" aria-label="關閉來源預覽" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="source-preview-content">
          <section className="source-preview-intro">
            <h3>簡介</h3>
            <dl>
              <div>
                <dt>格式</dt>
                <dd>{sourceTypeLabel(source)}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{sourceSize(source.sizeBytes)}</dd>
              </div>
              <div>
                <dt>生成用途</dt>
                <dd>{sourceUsageLabel(source)}</dd>
              </div>
              <div>
                <dt>AI 使用</dt>
                <dd>{source.allowModelAccess ? "已允許" : "未允許"}</dd>
              </div>
            </dl>
            <p>
              {imageSource
                ? "此圖片可作為生成時的視覺參考或直接素材。"
                : summary || "尚未擷取到可預覽的文字內容。"}
            </p>
          </section>
          <section className="source-preview-full">
            <h3>{imageSource ? "完整圖片" : "全文"}</h3>
            {terms.length > 0 && firstHit < 0 && (
              <p className="source-preview-nohit">
                關鍵字符合{imageSource ? "檔名" : "檔名或網址"}，全文中未出現。
              </p>
            )}
            <div className="source-preview-body">
              {imageSource ? (
                <img src={assetUrl} alt={source.name} />
              ) : summary ? (
                <pre>
                  {segments.map((segment, index) =>
                    segment.hit ? (
                      <mark key={index} ref={index === firstHit ? firstHitRef : null}>
                        {segment.text}
                      </mark>
                    ) : (
                      <Fragment key={index}>{segment.text}</Fragment>
                    ),
                  )}
                </pre>
              ) : (
                <div className="source-preview-empty">這個檔案沒有可顯示的文字內容。</div>
              )}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function WebSourceDialog({
  onCancel,
  onSearch,
  onSave,
}: {
  onCancel: () => void;
  onSearch: (query: string) => Promise<WebSearchResult[]>;
  onSave: (sources: WebSearchResult[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WebSearchResult[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searched, setSearched] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const busy = searching || saving;
  const search = async () => {
    const keyword = query.trim();
    if (keyword.length < 2) return;
    setSearching(true);
    setLocalError(undefined);
    try {
      const found = await onSearch(keyword);
      const unique = [...new Map(found.map((result) => [result.url, result])).values()];
      setResults(unique);
      setSelectedUrls(new Set(unique.map((result) => result.url)));
      setSearched(true);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "搜尋失敗");
    } finally {
      setSearching(false);
    }
  };
  const selected = results.filter((result) => selectedUrls.has(result.url));
  return (
    <div
      className="web-source-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="搜尋並加入資料"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <section className="web-source-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="section-label">ADD WEB SOURCES</span>
            <h2>加入搜尋資料</h2>
            <p>先搜尋並確認結果；加入後會擷取網頁全文、建立索引並存回目前專案。</p>
          </div>
          <button type="button" aria-label="關閉搜尋資料" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <form
          className="web-source-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label>
            搜尋關鍵字
            <input
              aria-label="搜尋關鍵字"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：Grok Build agent development advantages"
            />
          </label>
          <button className="primary" disabled={busy || query.trim().length < 2}>
            {searching ? "正在搜尋網路…" : "搜尋"}
          </button>
        </form>
        {localError && <div className="web-source-error">{localError}</div>}
        <div className="web-search-results">
          {!searched && !searching && (
            <div className="web-search-empty">輸入關鍵字後搜尋，這一步不會直接寫入來源。</div>
          )}
          {searched && results.length === 0 && (
            <div className="web-search-empty">找不到可加入的搜尋結果，請換一組關鍵字。</div>
          )}
          {results.map((result) => (
            <label
              className={`web-search-result ${selectedUrls.has(result.url) ? "selected" : ""}`}
              key={result.url}
            >
              <input
                type="checkbox"
                checked={selectedUrls.has(result.url)}
                onChange={(event) =>
                  setSelectedUrls((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(result.url);
                    else next.delete(result.url);
                    return next;
                  })
                }
              />
              <span>
                <strong>{result.title}</strong>
                <small>{result.url}</small>
                <p>{result.summary}</p>
              </span>
            </label>
          ))}
        </div>
        <footer>
          <span>
            已選 {selected.length} / {results.length} 筆
          </span>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || selected.length === 0}
            onClick={() => {
              setSaving(true);
              setLocalError(undefined);
              void onSave(selected)
                .catch((reason: unknown) =>
                  setLocalError(reason instanceof Error ? reason.message : "加入搜尋資料失敗"),
                )
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "正在擷取全文並儲存…" : `加入所選來源（${selected.length}）`}
          </button>
        </footer>
      </section>
    </div>
  );
}

const MAX_PASTED_URLS = 10;

/**
 * 伺服器錯誤代碼 → 使用者看得懂的原因。沒對到的代碼原樣顯示，總比吞掉好。
 *
 * 每一條對應的**使用者動作**都不一樣：限流要等一分鐘再按一次、逾時可以重試、hash 路由要
 * 改貼別的網址、上限要先刪來源。全部收斂成「該站阻擋自動擷取」等於叫人去做錯的事。
 */
const URL_FAILURE_REASONS: Record<string, string> = {
  WEB_SOURCE_URL_INVALID: "網址格式不正確",
  WEB_SOURCE_URL_UNSUPPORTED: "只支援 http／https 網址",
  WEB_SOURCE_URL_PRIVATE: "指向本機或內網位址，已阻擋",
  WEB_SOURCE_CONTENT_UNVERIFIED: "抓不到網頁正文（可能需要登入、或該站阻擋自動擷取）",
  WEB_SOURCE_HASH_ROUTE_UNSUPPORTED:
    "網址的 # 之後是頁面路徑（單頁應用），伺服器只拿得到首頁；請改貼該頁的實際網址",
  WEB_SOURCE_RENDER_UNAVAILABLE: "這頁要跑 JavaScript 才有內容，但伺服器未啟用外部 render 服務",
  WEB_SOURCE_TIMEOUT: "連線逾時，稍後再試一次",
  WEB_SOURCE_TOO_LARGE: "網頁內容過大，已略過",
  WEB_SOURCE_BATCH_TIMEOUT: "整批擷取已用完時間預算，這一筆還沒輪到；請分批再試",
  WEB_RENDER_RATE_LIMITED: "外部 render 服務目前限流，約一分鐘後再試一次",
  WEB_RENDER_TIMEOUT: "外部 render 服務逾時，稍後再試一次",
  WEB_RENDER_EMPTY: "外部 render 服務沒有取得任何正文",
  WEB_RENDER_TOO_LARGE: "外部 render 服務回傳的內容過大，已略過",
  WEB_RENDER_URL_MISMATCH: "外部 render 服務回傳的是另一個網址的內容，已拒收",
  WEB_RENDER_WARNING: "外部 render 服務回報這個網址擷取有問題",
  WEB_RENDER_FAILED: "外部 render 服務失敗，稍後再試一次",
  SOURCE_PROJECT_LIMIT: "專案來源已達上限（100 份），請先刪掉一些來源",
};

function urlFailureReason(reason: string): string {
  return URL_FAILURE_REASONS[reason] ?? reason;
}

/**
 * 一行一個網址；空行與前後空白忽略，重複的只留一筆。
 *
 * 分隔符含空白與逗號：從文件、聊天訊息或試算表複製過來的網址常常是空白或逗號分隔的，
 * 只切換行會把整段變成一條必定失敗的「網址」。
 */
function parsePastedUrls(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

function UrlSourceDialog({
  onCancel,
  onBusyChange,
  onSubmit,
}: {
  onCancel: () => void;
  /** 讓外層知道請求還在跑：Escape 與其他關閉路徑都要跟著鎖住。 */
  onBusyChange: (busy: boolean) => void;
  onSubmit: (urls: string[]) => Promise<{ failures: UrlSourceFailure[] }>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusyState] = useState(false);
  const setBusy = (next: boolean) => {
    setBusyState(next);
    onBusyChange(next);
  };
  const [failures, setFailures] = useState<UrlSourceFailure[]>([]);
  const [localError, setLocalError] = useState<string>();
  const urls = parsePastedUrls(value);
  const tooMany = urls.length > MAX_PASTED_URLS;
  return (
    <div
      className="text-source-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="貼上網址"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <form
        className="text-source-dialog url-source-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!urls.length || tooMany || busy) return;
          setBusy(true);
          setLocalError(undefined);
          setFailures([]);
          void onSubmit(urls)
            .then((result) => {
              setFailures(result.failures);
              // 全部成功才關閉；有失敗就留著讓使用者看清楚是哪幾筆。
              if (!result.failures.length) onCancel();
              else setValue(result.failures.map((failure) => failure.url).join("\n"));
            })
            .catch((reason: unknown) => {
              setLocalError(reason instanceof Error ? reason.message : "加入網址來源失敗");
              const listed = (reason as { failures?: UrlSourceFailure[] })?.failures;
              setFailures(Array.isArray(listed) ? listed : []);
            })
            .finally(() => setBusy(false));
        }}
      >
        <header>
          <div>
            <span className="section-label">PASTE URL SOURCE</span>
            <h2>貼上網址</h2>
            <p>
              一行一個網址（最多 {MAX_PASTED_URLS} 筆）。系統會擷取網頁正文、建立索引並存回
              目前專案；抓不到正文的網址不會加入，也不會用網頁摘要充數。
            </p>
          </div>
          <button type="button" aria-label="關閉貼上網址" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          網址清單
          <textarea
            aria-label="網址清單"
            autoFocus
            rows={8}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={"https://example.com/article\nhttps://example.com/report"}
          />
        </label>
        <small>
          {urls.length} 個網址{tooMany ? ` · 超過上限 ${MAX_PASTED_URLS} 筆` : ""} · 動態網頁（需要
          JavaScript 才顯示內容的網站）會改由外部 render 服務取得正文，
          該網址與其內容會送往第三方處理。
        </small>
        {localError && <div className="web-source-error">{localError}</div>}
        {failures.length > 0 && (
          <ul className="url-source-failures">
            {/* 同一個無效網址貼兩次就會回兩筆一模一樣的 failure，url 不是唯一鍵。 */}
            {failures.map((failure, index) => (
              <li key={`${failure.url}#${index}`}>
                <b>{failure.url}</b>
                <span>{urlFailureReason(failure.reason)}</span>
              </li>
            ))}
          </ul>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={busy || !urls.length || tooMany}>
            {busy ? "正在擷取網頁正文…" : `加入網址來源（${urls.length}）`}
          </button>
        </footer>
      </form>
    </div>
  );
}

function TextSourceDialog({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, text: string) => void;
}) {
  const [name, setName] = useState("貼上文字.md");
  const [content, setContent] = useState("");
  const normalizedName = /\.(?:md|txt)$/i.test(name.trim())
    ? name.trim()
    : `${name.trim() || "貼上文字"}.md`;
  return (
    <div
      className="text-source-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="輸入文字來源"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <form
        className="text-source-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (content.trim()) onSubmit(normalizedName, content.trim());
        }}
      >
        <header>
          <div>
            <span className="section-label">PASTE TEXT SOURCE</span>
            <h2>輸入文字來源</h2>
            <p>貼上的內容會存成專案來源、切成文字區塊並加入檢索。</p>
          </div>
          <button type="button" aria-label="關閉輸入文字" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          來源名稱
          <input
            aria-label="文字來源名稱"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：訪談筆記.md"
          />
        </label>
        <label>
          文字內容
          <textarea
            aria-label="文字來源內容"
            autoFocus
            rows={14}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="在這裡貼上研究資料、訪談逐字稿、會議筆記或其他文字…"
          />
        </label>
        <small>
          {content.length.toLocaleString("zh-TW")} 字元 · 將儲存為 {normalizedName}
        </small>
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={busy || !content.trim()}>
            {busy ? "正在建立來源…" : "加入文字來源"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/**
 * 專案素材（sources）管理面板：上傳檔案／輸入文字／從網路加入資料，以及來源清單的
 * 搜尋、預覽、AI 存取開關、生成用途與刪除。自管上傳 busy 與三個對話框狀態，透過
 * onProject 回報更新後的專案。編輯器側欄與建立流程「上傳素材」步驟共用此元件。
 *
 * 來源搜尋純在前端比對已載入的 project.sources（全文／檔名／來源網址），不呼叫後端；
 * 命中的來源在預覽對話框裡會 highlight 全文中的關鍵字。
 */
export function SourcePanel({
  project,
  onProject,
  onError,
}: {
  project: PresentationProject;
  onProject: (project: PresentationProject) => void;
  onError: (message: string) => void;
}) {
  const [sourcePreview, setSourcePreview] = useState<SourceAsset>();
  const [showWebSourceSearch, setShowWebSourceSearch] = useState(false);
  const [showUrlSource, setShowUrlSource] = useState(false);
  // 擷取中途按 Esc 會關掉對話框、丟掉失敗清單，而請求還在跑（相鄰的貼上文字有守衛）。
  const [urlSourceBusy, setUrlSourceBusy] = useState(false);
  const [showTextSource, setShowTextSource] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [query, setQuery] = useState("");

  const terms = searchTerms(query);
  // 新增來源後清空搜尋，否則新來源若不符合目前關鍵字會「加了卻沒出現」。
  const visibleSources = terms.length
    ? project.sources.filter((source) => matchSource(source, terms))
    : project.sources;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sourcePreview) setSourcePreview(undefined);
      else if (showWebSourceSearch) setShowWebSourceSearch(false);
      else if (showUrlSource && !urlSourceBusy) setShowUrlSource(false);
      else if (showTextSource && !uploadBusy) setShowTextSource(false);
      else if (query) setQuery("");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    sourcePreview,
    showWebSourceSearch,
    showUrlSource,
    urlSourceBusy,
    showTextSource,
    uploadBusy,
    query,
  ]);

  const run = async (operation: () => Promise<PresentationProject>) => {
    try {
      onProject(await operation());
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "操作失敗");
    }
  };

  const uploadSourceFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploadBusy(true);
    try {
      const results = await Promise.allSettled(
        files.map((file) => api.uploadSource(project.id, file)),
      );
      onProject(await api.getProject(project.id));
      setQuery("");
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length)
        throw new Error(`${files.length - failed.length} 個檔案已上傳，${failed.length} 個失敗`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "來源上傳失敗");
    } finally {
      setUploadBusy(false);
    }
  };

  return (
    <>
      <div className="source-add-actions">
        <label className={`upload-source ${uploadBusy ? "disabled" : ""}`}>
          ＋ {uploadBusy ? "正在上傳來源…" : "上傳來源檔案"}
          <span>可多選 · PDF · PPTX · DOCX · MD · TXT · PNG · JPG</span>
          <input
            aria-label="上傳來源檔案"
            type="file"
            multiple
            disabled={uploadBusy}
            accept=".pdf,.pptx,.docx,.md,.txt,.png,.jpg,.jpeg"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadSourceFiles(files);
            }}
          />
        </label>
        <button
          className="add-text-source"
          disabled={uploadBusy}
          onClick={() => setShowTextSource(true)}
        >
          ＋ 輸入文字<span>貼上文字 · 自動建立索引</span>
        </button>
        <button
          className="add-web-source"
          disabled={uploadBusy}
          onClick={() => setShowWebSourceSearch(true)}
        >
          ＋ 從網路加入資料<span>輸入關鍵字 · 確認後儲存全文</span>
        </button>
        <button
          className="add-url-source"
          disabled={uploadBusy}
          onClick={() => setShowUrlSource(true)}
        >
          ＋ 貼上網址<span>一行一個 · 擷取正文後存入</span>
        </button>
      </div>
      {project.sources.length > 0 && (
        <div className="source-search">
          <label>
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="搜尋來源"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋來源內容、檔名或網址"
            />
          </label>
          {query && (
            <button type="button" aria-label="清除搜尋關鍵字" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>
      )}
      {terms.length > 0 && visibleSources.length > 0 && (
        <p className="source-search-count">
          {visibleSources.length} / {project.sources.length} 份來源符合
        </p>
      )}
      {project.sources.length === 0 && (
        <div className="source-empty">
          <b>尚無來源</b>
          <span>上傳文字、文件或圖片，生成時即可引用。</span>
        </div>
      )}
      {terms.length > 0 && visibleSources.length === 0 && (
        <div className="source-empty">
          <b>找不到符合的來源</b>
          <span>沒有來源包含「{query.trim()}」。</span>
          <button type="button" className="source-search-clear" onClick={() => setQuery("")}>
            清除搜尋
          </button>
        </div>
      )}
      <div className="source-list">
        {visibleSources.map((source) => {
          const imageSource = source.mediaType.startsWith("image/");
          const summary = sourceSummary(source);
          const assetUrl = projectAssetUrl(project.id, source.assetPath);
          return (
            <article key={source.id} className="source-card">
              <header className="source-card-header">
                <label className="source-access-toggle" title="允許 AI 在生成時讀取此來源">
                  <input
                    aria-label={`允許 AI 使用 ${source.name}`}
                    type="checkbox"
                    checked={source.allowModelAccess}
                    onChange={(event) =>
                      void run(() =>
                        api.updateSource(project.id, source.id, {
                          allowModelAccess: event.target.checked,
                        }),
                      )
                    }
                  />
                </label>
                <div>
                  <strong title={source.name}>{source.name}</strong>
                  <small>
                    {sourceSize(source.sizeBytes)} · {source.chunks.length} 個文字區塊
                  </small>
                </div>
                <span className="source-kind">{sourceTypeLabel(source)}</span>
              </header>
              <button
                type="button"
                className={`source-preview-trigger ${imageSource ? "image" : "text"}`}
                aria-label={`預覽 ${source.name}`}
                onClick={() => setSourcePreview(source)}
              >
                {imageSource ? (
                  <img src={assetUrl} alt="" />
                ) : (
                  <p>{summary || "尚未擷取到可預覽的文字內容"}</p>
                )}
                <span>
                  查看來源詳情 <b>→</b>
                </span>
              </button>
              <label className="source-usage">
                生成用途
                <select
                  aria-label={`${source.name} 的生成用途`}
                  value={source.usage}
                  onChange={(event) =>
                    void run(() =>
                      api.updateSource(project.id, source.id, {
                        usage: event.target.value as typeof source.usage,
                      }),
                    )
                  }
                >
                  <option value="content">內容依據</option>
                  <option value="visual-reference">視覺參考</option>
                  <option value="style-reference">風格參考</option>
                  <option value="direct-asset">直接素材</option>
                  <option value="exclude-from-generation">不參與生成</option>
                </select>
              </label>
              <div className="source-card-actions">
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm("刪除來源？既有版本的來源快照仍會保留。"))
                      void run(() => api.deleteSource(project.id, source.id, true));
                  }}
                >
                  刪除來源
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {sourcePreview && (
        <SourcePreviewDialog
          projectId={project.id}
          source={sourcePreview}
          terms={terms}
          onClose={() => setSourcePreview(undefined)}
        />
      )}
      {showWebSourceSearch && (
        <WebSourceDialog
          onCancel={() => setShowWebSourceSearch(false)}
          onSearch={(query) => api.searchWebSources(project.id, query)}
          onSave={async (sources) => {
            onProject(await api.addWebSources(project.id, sources));
            setShowWebSourceSearch(false);
            setQuery("");
          }}
        />
      )}
      {showUrlSource && (
        <UrlSourceDialog
          onCancel={() => setShowUrlSource(false)}
          onBusyChange={setUrlSourceBusy}
          onSubmit={async (urls) => {
            const result = await api.addUrlSources(project.id, urls);
            onProject(result.project);
            setQuery("");
            return { failures: result.failures };
          }}
        />
      )}
      {showTextSource && (
        <TextSourceDialog
          busy={uploadBusy}
          onCancel={() => setShowTextSource(false)}
          onSubmit={(name, text) => {
            setUploadBusy(true);
            const file = new File([text], name, {
              type: name.toLowerCase().endsWith(".txt") ? "text/plain" : "text/markdown",
            });
            void api
              .uploadSource(project.id, file)
              .then((updated) => {
                onProject(updated);
                setShowTextSource(false);
                setQuery("");
              })
              .catch((reason: unknown) =>
                onError(reason instanceof Error ? reason.message : "建立文字來源失敗"),
              )
              .finally(() => setUploadBusy(false));
          }}
        />
      )}
    </>
  );
}

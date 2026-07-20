import { Fragment, useEffect, useRef, useState } from "react";
import type { PresentationProject, SourceAsset } from "@slide-maker/core";
import { api, projectAssetUrl, type WebSearchResult } from "./api.js";
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
      else if (showTextSource && !uploadBusy) setShowTextSource(false);
      else if (query) setQuery("");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sourcePreview, showWebSourceSearch, showTextSource, uploadBusy, query]);

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

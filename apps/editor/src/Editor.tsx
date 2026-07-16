import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { EditableTextBox, PresentationBrief, PresentationProject, SlideSpec, SourceAsset, StylePreset } from "@slide-maker/core";
import { api, imageUrl, projectAssetUrl, styleAssetUrl, type ProviderReadiness, type ProviderSummary, type WebSearchResult } from "./api.js";
import { StyleEditor } from "./StyleEditor.js";

const PHASE_LABELS: Record<string, string> = {
  queued: "等待排程", preparing: "準備資料", launching: "啟動 Codex", waiting_for_codex: "Codex 正在生成",
  validating_output: "驗證圖片", persisting: "保存版本", completed: "完成", failed: "失敗", cancelled: "已取消",
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function currentImage(project: PresentationProject, slide: SlideSpec): string | undefined {
  const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
  return version ? imageUrl(project.id, version.imagePath) : undefined;
}

const RESIZE_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

export function TextLayerCanvas({ background, original, pristine, boxes, canvasWidth, canvasHeight, selectedId, onSelect, onChange }: {
  background: string; original?: string; pristine: boolean; boxes: EditableTextBox[]; canvasWidth: number; canvasHeight: number;
  selectedId: string | undefined; onSelect: (id?: string) => void; onChange: (boxes: EditableTextBox[]) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; direction: "move" | typeof RESIZE_DIRECTIONS[number]; x: number; y: number; box: EditableTextBox } | undefined>(undefined);
  const point = (event: ReactPointerEvent) => {
    const bounds = stageRef.current!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * canvasWidth / bounds.width, y: (event.clientY - bounds.top) * canvasHeight / bounds.height };
  };
  const begin = (event: ReactPointerEvent, box: EditableTextBox, direction: "move" | typeof RESIZE_DIRECTIONS[number]) => {
    event.preventDefault(); event.stopPropagation();
    const start = point(event); drag.current = { id: box.id, direction, x: start.x, y: start.y, box: structuredClone(box) };
    onSelect(box.id); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent) => {
    const active = drag.current; if (!active) return;
    const current = point(event); const dx = current.x - active.x; const dy = current.y - active.y;
    let { x, y, width, height } = active.box;
    if (active.direction === "move") { x += dx; y += dy; }
    else {
      if (active.direction.includes("e")) width += dx;
      if (active.direction.includes("s")) height += dy;
      if (active.direction.includes("w")) { x += dx; width -= dx; }
      if (active.direction.includes("n")) { y += dy; height -= dy; }
    }
    width = Math.max(24, width); height = Math.max(18, height);
    x = Math.max(0, Math.min(canvasWidth - width, x)); y = Math.max(0, Math.min(canvasHeight - height, y));
    onChange(boxes.map((box) => box.id === active.id ? { ...box, x, y, width, height } : box));
  };
  return <div ref={stageRef} className="text-layer-canvas" onPointerMove={move} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} onPointerDown={() => onSelect(undefined)}>
    <img src={pristine && original ? original : background} alt={pristine ? "文字抽離原始預覽" : "文字抽離乾淨背景"} />
    {boxes.filter((box) => box.role === "presentation").map((box) => {
      const lineCount = Math.max(1, box.text.split("\n").length);
      const textHeight = box.fontSize * box.lineHeight * lineCount;
      const spareHeight = Math.max(0, box.height - textHeight);
      const verticalOffset = box.verticalAlign === "bottom" ? spareHeight : box.verticalAlign === "middle" ? spareHeight / 2 : 0;
      return <div key={box.id} className={`editable-text-box ${selectedId === box.id ? "selected" : ""}`} style={{
      left: `${box.x / canvasWidth * 100}%`, top: `${box.y / canvasHeight * 100}%`, width: `${box.width / canvasWidth * 100}%`, height: `${box.height / canvasHeight * 100}%`,
      transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
    }} onPointerDown={(event) => { event.stopPropagation(); onSelect(box.id); }}>
      <textarea aria-label="可編輯簡報文字" value={box.text} onChange={(event) => onChange(boxes.map((candidate) => candidate.id === box.id ? { ...candidate, text: event.target.value } : candidate))} style={{
        fontFamily: box.fontFamily, fontSize: `${box.fontSize / canvasHeight * 100}cqh`, fontWeight: box.fontWeight,
        color: pristine ? "transparent" : box.color, caretColor: box.color, opacity: box.opacity, lineHeight: box.lineHeight, letterSpacing: `${box.letterSpacing}px`, textAlign: box.align,
        paddingTop: `${verticalOffset / canvasHeight * 100}cqh`,
      }} />
      {selectedId === box.id && <><button className="text-drag-handle" aria-label="移動文字框" onPointerDown={(event) => begin(event, box, "move")}>⋮⋮</button>
        {RESIZE_DIRECTIONS.map((direction) => <button key={direction} aria-label={`調整文字框 ${direction}`} className={`text-resize-handle ${direction}`} onPointerDown={(event) => begin(event, box, direction)} />)}
      </>}
    </div>})}
  </div>;
}

function NewSlideDialog({ busy, onCancel, onSubmit }: {
  busy: boolean; onCancel: () => void; onSubmit: (purpose: string) => void;
}) {
  const [purpose, setPurpose] = useState("");
  return <div className="new-slide-backdrop" role="dialog" aria-modal="true" aria-label="新增 AI 頁面" onClick={() => { if (!busy) onCancel(); }}>
    <form className="new-slide-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (purpose.trim()) onSubmit(purpose.trim()); }}>
      <header><div><span className="section-label">ADD ONE SLIDE</span><h2>這一頁要說什麼？</h2><p>AI 會參考整份簡報、來源與資訊密度，產生這一頁的內容與構圖。</p></div><button type="button" aria-label="關閉新增頁面" disabled={busy} onClick={onCancel}>×</button></header>
      <label>新增頁面目的<textarea aria-label="新增頁面目的" autoFocus rows={4} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="例如：比較導入前後的交付時間與失敗率，並提出三個衡量指標" /></label>
      <div className="new-slide-actions"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy || !purpose.trim()}>{busy ? "AI 正在產生頁面架構…" : "用 AI 產生頁面架構 →"}</button></div>
    </form>
  </div>;
}

function sourceTypeLabel(source: SourceAsset): string {
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
  return ({
    content: "內容依據",
    "visual-reference": "視覺參考",
    "style-reference": "風格參考",
    "direct-asset": "直接素材",
    "exclude-from-generation": "不參與生成",
  } as const)[source.usage];
}

function sourceSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 ** 2) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
}

function SourcePreviewDialog({ projectId, source, onClose }: { projectId: string; source: SourceAsset; onClose: () => void }) {
  const imageSource = source.mediaType.startsWith("image/");
  const summary = sourceSummary(source);
  const assetUrl = projectAssetUrl(projectId, source.assetPath);
  return <div className="source-preview-backdrop" role="dialog" aria-modal="true" aria-label={`預覽來源：${source.name}`} onClick={onClose}>
    <section className={`source-preview-dialog ${imageSource ? "image" : "text"}`} onClick={(event) => event.stopPropagation()}>
      <header>
        <div><span className="section-label">SOURCE DETAIL · {sourceTypeLabel(source)}</span><h2>{source.name}</h2></div>
        <button type="button" aria-label="關閉來源預覽" onClick={onClose}>×</button>
      </header>
      <div className="source-preview-content">
        <section className="source-preview-intro">
          <h3>簡介</h3>
          <dl>
            <div><dt>格式</dt><dd>{sourceTypeLabel(source)}</dd></div>
            <div><dt>大小</dt><dd>{sourceSize(source.sizeBytes)}</dd></div>
            <div><dt>生成用途</dt><dd>{sourceUsageLabel(source)}</dd></div>
            <div><dt>AI 使用</dt><dd>{source.allowModelAccess ? "已允許" : "未允許"}</dd></div>
          </dl>
          <p>{imageSource ? "此圖片可作為生成時的視覺參考或直接素材。" : summary || "尚未擷取到可預覽的文字內容。"}</p>
        </section>
        <section className="source-preview-full">
          <h3>{imageSource ? "完整圖片" : "全文"}</h3>
          <div className="source-preview-body">
            {imageSource ? <img src={assetUrl} alt={source.name} /> : summary ? <pre>{source.extractedText}</pre> : <div className="source-preview-empty">這個檔案沒有可顯示的文字內容。</div>}
          </div>
        </section>
      </div>
    </section>
  </div>;
}

function WebSourceDialog({ onCancel, onSearch, onSave }: {
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
    const keyword = query.trim(); if (keyword.length < 2) return;
    setSearching(true); setLocalError(undefined);
    try {
      const found = await onSearch(keyword);
      const unique = [...new Map(found.map((result) => [result.url, result])).values()];
      setResults(unique); setSelectedUrls(new Set(unique.map((result) => result.url))); setSearched(true);
    } catch (reason) { setLocalError(reason instanceof Error ? reason.message : "搜尋失敗"); }
    finally { setSearching(false); }
  };
  const selected = results.filter((result) => selectedUrls.has(result.url));
  return <div className="web-source-backdrop" role="dialog" aria-modal="true" aria-label="搜尋並加入資料" onClick={() => { if (!busy) onCancel(); }}>
    <section className="web-source-dialog" onClick={(event) => event.stopPropagation()}>
      <header><div><span className="section-label">ADD WEB SOURCES</span><h2>加入搜尋資料</h2><p>先搜尋並確認結果；加入後會擷取網頁全文、建立索引並存回目前專案。</p></div><button type="button" aria-label="關閉搜尋資料" disabled={busy} onClick={onCancel}>×</button></header>
      <form className="web-source-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label>搜尋關鍵字<input aria-label="搜尋關鍵字" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：Grok Build agent development advantages" /></label>
        <button className="primary" disabled={busy || query.trim().length < 2}>{searching ? "正在搜尋網路…" : "搜尋"}</button>
      </form>
      {localError && <div className="web-source-error">{localError}</div>}
      <div className="web-search-results">
        {!searched && !searching && <div className="web-search-empty">輸入關鍵字後搜尋，這一步不會直接寫入來源。</div>}
        {searched && results.length === 0 && <div className="web-search-empty">找不到可加入的搜尋結果，請換一組關鍵字。</div>}
        {results.map((result) => <label className={`web-search-result ${selectedUrls.has(result.url) ? "selected" : ""}`} key={result.url}>
          <input type="checkbox" checked={selectedUrls.has(result.url)} onChange={(event) => setSelectedUrls((current) => {
            const next = new Set(current); if (event.target.checked) next.add(result.url); else next.delete(result.url); return next;
          })} />
          <span><strong>{result.title}</strong><small>{result.url}</small><p>{result.summary}</p></span>
        </label>)}
      </div>
      <footer><span>已選 {selected.length} / {results.length} 筆</span><button type="button" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy || selected.length === 0} onClick={() => {
        setSaving(true); setLocalError(undefined);
        void onSave(selected).catch((reason: unknown) => setLocalError(reason instanceof Error ? reason.message : "加入搜尋資料失敗")).finally(() => setSaving(false));
      }}>{saving ? "正在擷取全文並儲存…" : `加入所選來源（${selected.length}）`}</button></footer>
    </section>
  </div>;
}

function TextSourceDialog({ busy, onCancel, onSubmit }: {
  busy: boolean; onCancel: () => void; onSubmit: (name: string, text: string) => void;
}) {
  const [name, setName] = useState("貼上文字.md");
  const [content, setContent] = useState("");
  const normalizedName = /\.(?:md|txt)$/i.test(name.trim()) ? name.trim() : `${name.trim() || "貼上文字"}.md`;
  return <div className="text-source-backdrop" role="dialog" aria-modal="true" aria-label="輸入文字來源" onClick={() => { if (!busy) onCancel(); }}>
    <form className="text-source-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (content.trim()) onSubmit(normalizedName, content.trim()); }}>
      <header><div><span className="section-label">PASTE TEXT SOURCE</span><h2>輸入文字來源</h2><p>貼上的內容會存成專案來源、切成文字區塊並加入檢索。</p></div><button type="button" aria-label="關閉輸入文字" disabled={busy} onClick={onCancel}>×</button></header>
      <label>來源名稱<input aria-label="文字來源名稱" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：訪談筆記.md" /></label>
      <label>文字內容<textarea aria-label="文字來源內容" autoFocus rows={14} value={content} onChange={(event) => setContent(event.target.value)} placeholder="在這裡貼上研究資料、訪談逐字稿、會議筆記或其他文字…" /></label>
      <small>{content.length.toLocaleString("zh-TW")} 字元 · 將儲存為 {normalizedName}</small>
      <footer><button type="button" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy || !content.trim()}>{busy ? "正在建立來源…" : "加入文字來源"}</button></footer>
    </form>
  </div>;
}

function ImageEditDialog({ image, busy, supportsMask, onCancel, onSubmit }: {
  image: string; busy: boolean; supportsMask: boolean; onCancel: () => void;
  onSubmit: (instruction: string, maskDataUrl?: string) => void;
}) {
  type MaskPoint = { x: number; y: number };
  type MaskSelection = MaskPoint & { width: number; height: number };
  const [instruction, setInstruction] = useState("");
  const [maskEnabled, setMaskEnabled] = useState(false);
  const [selection, setSelection] = useState<MaskSelection>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<MaskPoint | undefined>(undefined);
  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>): MaskPoint | undefined => {
    const canvas = canvasRef.current; if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)),
    };
  };
  const drawSelection = (start: MaskPoint, end: MaskPoint): MaskSelection | undefined => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rectangle = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    const context = canvas.getContext("2d"); if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    setSelection(rectangle);
    return rectangle;
  };
  const beginSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!maskEnabled) return;
    const point = canvasPoint(event); if (!point) return;
    dragStart.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawSelection(point, point);
  };
  const moveSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragStart.current) return;
    const point = canvasPoint(event); if (point) drawSelection(dragStart.current, point);
  };
  const finishSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const start = dragStart.current;
    dragStart.current = undefined;
    if (!start) return;
    const point = canvasPoint(event);
    const rectangle = point ? drawSelection(start, point) : undefined;
    if (!rectangle || rectangle.width < 8 || rectangle.height < 8) clearMask();
  };
  const clearMask = () => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    dragStart.current = undefined;
    setSelection(undefined);
  };
  return <div className="image-edit-backdrop" role="dialog" aria-modal="true" aria-label="編輯當頁圖片" onClick={() => { if (!busy) onCancel(); }}>
    <form className="image-edit-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => {
      event.preventDefault();
      if (!instruction.trim()) return;
      onSubmit(instruction.trim(), maskEnabled && selection ? canvasRef.current?.toDataURL("image/png") : undefined);
    }}>
      <header><div><span className="section-label">EDIT CURRENT IMAGE</span><h2>修改當頁圖片</h2><p>以目前版本為基礎修改，不會覆蓋舊版本。</p></div><button type="button" aria-label="關閉圖片編輯" disabled={busy} onClick={onCancel}>×</button></header>
      <div className={`image-mask-stage ${maskEnabled ? "masking" : ""}`}>
        <img src={image} alt="目前頁面圖片" />
        <canvas ref={canvasRef} width={960} height={540} aria-label="圖片修改範圍" onPointerDown={beginSelection} onPointerMove={moveSelection} onPointerUp={finishSelection} onPointerCancel={clearMask} />
        {maskEnabled && selection && <div className="mask-selection-box" style={{ left: `${selection.x / 9.6}%`, top: `${selection.y / 5.4}%`, width: `${selection.width / 9.6}%`, height: `${selection.height / 5.4}%` }} />}
        {maskEnabled && !selection && <span>拖曳框選要修改的區域</span>}
      </div>
      <label className="image-edit-instruction">修改說明<textarea aria-label="圖片修改說明" rows={3} autoFocus value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：只把右上角的機器人改成女性工程師，其他文字與排版保持不變" /></label>
      <div className="mask-controls">
        <label><input type="checkbox" checked={maskEnabled} disabled={!supportsMask} onChange={(event) => { setMaskEnabled(event.target.checked); if (!event.target.checked) clearMask(); }} />限制修改範圍（框選）</label>
        {supportsMask ? <><small>{selection ? "可直接拖曳重選範圍" : "框內可修改，框外保留原圖"}</small><button type="button" disabled={!selection} onClick={clearMask}>清除框選</button></> : <small>目前 Provider 不支援範圍編輯</small>}
      </div>
      <div className="image-edit-actions"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy || !instruction.trim() || (maskEnabled && !selection)}>{busy ? "正在建立圖片編輯工作…" : "套用修改 →"}</button></div>
    </form>
  </div>;
}

function CreateProject({ projects, styles, styleLibrary, onOpen, onCreate, onNavigate }: {
  projects: PresentationProject[];
  styles: StylePreset[];
  styleLibrary: boolean;
  onOpen: (project: PresentationProject) => void;
  onCreate: (topic: string, styleId?: string) => Promise<void>;
  onNavigate: (path: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [selectedStyleId, setSelectedStyleId] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get("style") ?? undefined);
  const [busy, setBusy] = useState(false);
  const styleCard = (style: StylePreset) => {
    const cover = style.referenceImages.find((item) => item.id === style.coverImageId) ?? style.referenceImages[0];
    return <article key={style.id} className="style-card">
      <button className="style-card-preview" onClick={() => onNavigate(`/styles/${style.id}`)}>{cover ? <img src={styleAssetUrl(cover.id)} alt={`${style.name} 封面`} /> : <span>{style.name}<small>尚無封面圖</small></span>}</button>
      <strong>{style.name}</strong><small>v{style.version} · 密度 {style.density === "high" ? "高" : style.density === "medium" ? "中" : "低"}</small>
      <div><button onClick={() => onNavigate(`/styles/${style.id}`)}>編輯</button><button onClick={() => onNavigate(`/?style=${style.id}`)}>套用建立</button></div>
    </article>;
  };
  return <main className={`welcome dashboard ${styleLibrary ? "library-mode" : ""}`}>
    <header className="dashboard-header">
      <button className="dashboard-brand" onClick={() => onNavigate("/")}>SM<span>↗</span></button>
      <nav className="library-tabs"><button className={!styleLibrary ? "active" : ""} onClick={() => onNavigate("/")}>簡報</button><button className={styleLibrary ? "active" : ""} onClick={() => onNavigate("/styles")}>風格庫</button></nav>
      <span className="dashboard-local">LOCAL-FIRST · IMAGE DECKS</span>
    </header>
    <div className="dashboard-content">
      {!styleLibrary ? <>
        <section className="create-panel">
          <div><span className="section-label">NEW PRESENTATION</span><h1>今天想做什麼簡報？</h1><p>描述主題、用途、對象與想要的頁數，AI 會先整理成可確認的大綱。</p></div>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!topic.trim()) return;
            setBusy(true);
            void onCreate(topic, selectedStyleId).finally(() => setBusy(false));
          }}>
            <input aria-label="簡報需求" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="例如：用 8 頁向主管說明 AI agent 導入計畫、效益與風險" autoFocus />
            <button className="primary" disabled={busy || !topic.trim()}>{busy ? "建立中…" : "開始規劃 →"}</button>
          </form>
          <small>頁數由你的需求與 AI 大綱決定。{selectedStyleId ? `目前風格：${styles.find((item) => item.id === selectedStyleId)?.name ?? "已選風格"}` : "未指定時由 AI 自由設計。"}</small>
        </section>

        <section className="dashboard-section style-start-section">
          <div className="dashboard-section-heading"><div><span className="section-label">START WITH A STYLE</span><h2>從風格開始</h2></div><button onClick={() => onNavigate("/styles")}>查看風格庫 →</button></div>
          <div className="style-quick-list">{styles.map((style) => {
            const cover = style.referenceImages.find((item) => item.id === style.coverImageId) ?? style.referenceImages[0];
            return <button key={style.id} className={`style-quick-card ${selectedStyleId === style.id ? "selected" : ""}`} onClick={() => setSelectedStyleId(style.id)}>
              <span>{cover ? <img src={styleAssetUrl(cover.id)} alt="" /> : <b>{style.name.slice(0, 1)}</b>}</span><strong>{style.name}</strong><small>密度 {style.density === "high" ? "高" : style.density === "medium" ? "中" : "低"}</small>
            </button>;
          })}</div>
        </section>

        <section className="dashboard-section recent-projects">
          <div className="dashboard-section-heading"><div><span className="section-label">YOUR WORK</span><h2>最近簡報</h2></div><span>{projects.length} 份簡報</span></div>
          {projects.length === 0 ? <div className="empty-dashboard"><b>還沒有簡報</b><span>在上方輸入需求，建立第一份內容。</span></div> : <div className="project-grid">{projects.map((project) => {
            const cover = project.slides[0] ? currentImage(project, project.slides[0]) : undefined;
            return <button key={project.id} className="project-card" onClick={() => onOpen(project)}>
              <span className="project-card-cover">{cover ? <img src={cover} alt={`${project.name} 第一頁`} /> : <b>{project.slides.length ? `${project.slides.length} 頁` : "空白"}</b>}</span>
              <span className="project-card-info"><strong>{project.name}</strong><small>{project.slides.length} 頁 · {new Date(project.updatedAt).toLocaleString("zh-TW")}</small></span>
            </button>;
          })}</div>}
        </section>
      </> : <section className="dashboard-section style-library-section">
        <div className="library-heading"><div><span className="section-label">STYLE LIBRARY</span><h1>風格庫</h1><p>用參考圖與視覺規則，維持不同簡報之間的一致性。</p></div><button className="primary new-style" onClick={() => onNavigate("/styles/new")}>＋ 建立風格</button></div>
        <div className="style-library">{styles.map(styleCard)}</div>
      </section>}
    </div>
  </main>;
}

function SetupFlow({
  project, providers, styles, providerId, readiness, readinessBusy, acceptUnknownReadiness,
  onProviderId, onAcceptUnknownReadiness, onProject, onExit, onError,
}: {
  project: PresentationProject;
  providers: ProviderSummary[];
  styles: StylePreset[];
  providerId: string;
  readiness?: ProviderReadiness;
  readinessBusy: boolean;
  acceptUnknownReadiness: boolean;
  onProviderId: (value: string) => void;
  onAcceptUnknownReadiness: (value: boolean) => void;
  onProject: (value: PresentationProject) => void;
  onExit: () => void;
  onError: (message: string) => void;
}) {
  const [brief, setBrief] = useState(() => structuredClone(project.brief));
  const [outline, setOutline] = useState(() => structuredClone(project.slides));
  const [busy, setBusy] = useState(false);
  const [showRequirements, setShowRequirements] = useState(project.workflowStage === "requirements");
  const [showNewSlide, setShowNewSlide] = useState(false);
  const provider = providers.find((candidate) => candidate.id === providerId);

  useEffect(() => { setBrief(structuredClone(project.brief)); }, [project.id, project.brief]);
  useEffect(() => { setOutline(structuredClone(project.slides)); }, [project.id, project.workflowStage]);
  useEffect(() => { if (project.workflowStage === "requirements") setShowRequirements(true); }, [project.id, project.workflowStage]);

  const produceOutline = async () => {
    setBusy(true); onError("");
    try {
      const withBrief = await api.updateBrief(project.id, brief);
      onProject(withBrief);
      const withOutline = await api.regenerateOutline(project.id, true);
      onProject(withOutline);
      setShowRequirements(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "產生大綱失敗"); }
    finally { setBusy(false); }
  };

  const confirmAndGenerate = async () => {
    setBusy(true); onError("");
    try {
      let updated = project;
      for (const slide of outline) {
        updated = await api.updateSlide(project.id, slide.id, {
          purpose: slide.purpose,
          content: slide.content,
          narrative: slide.narrative,
          layoutHint: slide.layoutHint,
          imagePrompt: slide.imagePrompt,
          sourceIds: slide.sourceIds,
        });
      }
      onProject(updated);
      const currentReadiness = await api.readiness(providerId);
      if (currentReadiness.blocking || (currentReadiness.requiresAcknowledgement && !acceptUnknownReadiness)) {
        throw new Error(currentReadiness.message);
      }
      await api.generateAll(project.id, providerId, acceptUnknownReadiness);
      onProject(await api.getProject(project.id));
    } catch (reason) { onError(reason instanceof Error ? reason.message : "生成簡報失敗"); }
    finally { setBusy(false); }
  };

  const requirementsStep = project.workflowStage === "requirements" || showRequirements;
  return <main className="setup-page">
    <header className="setup-header">
      <button className="brand" onClick={onExit}>SM<span>↗</span></button>
      <div><strong>{project.name}</strong><small>兩步完成整份簡報</small></div>
    </header>
    <div className="setup-steps" aria-label="建立簡報流程">
      <div className={!requirementsStep ? "done" : "active"}><b>1</b><span>需求 → 大綱</span></div>
      <i />
      <div className={!requirementsStep ? "active" : ""}><b>2</b><span>設定 → 生成簡報</span></div>
    </div>
    {requirementsStep ? <section className="setup-card">
      <div className="section-label">STEP 1 · 需求到大綱</div>
      <h1>先確認這份簡報要說什麼</h1>
      <p>系統會依下列需求建立大綱；頁數以這裡確認的數字為準。</p>
      <div className="setup-grid">
        <label className="wide">簡報需求<textarea rows={4} value={brief.topic} onChange={(event) => setBrief({ ...brief, topic: event.target.value })} /></label>
        <label>目標觀眾<input value={brief.audience} onChange={(event) => setBrief({ ...brief, audience: event.target.value })} /></label>
        <label>簡報目的<input value={brief.purpose} onChange={(event) => setBrief({ ...brief, purpose: event.target.value })} /></label>
        <label>頁數<input aria-label="簡報頁數" type="number" min={1} max={100} value={brief.desiredSlideCount} onChange={(event) => setBrief({ ...brief, desiredSlideCount: Number(event.target.value) })} /></label>
        <label>語言<input value={brief.language} onChange={(event) => setBrief({ ...brief, language: event.target.value })} /></label>
        <label>語氣<input value={brief.tone} onChange={(event) => setBrief({ ...brief, tone: event.target.value })} /></label>
        <label>演講時間（分鐘）<input type="number" min={1} value={brief.durationMinutes ?? ""} onChange={(event) => setBrief({ ...brief, durationMinutes: event.target.value ? Number(event.target.value) : undefined })} /></label>
        <label>Web Search<select value={brief.webSearchMode} onChange={(event) => setBrief({ ...brief, webSearchMode: event.target.value as PresentationBrief["webSearchMode"] })}><option value="live">Live（即時搜尋）</option><option value="cached">Cached</option><option value="disabled">Disabled</option></select></label>
      </div>
      <button className="primary setup-submit" disabled={busy || !brief.topic.trim() || brief.desiredSlideCount < 1 || brief.desiredSlideCount > 100} onClick={() => void produceOutline()}>{busy ? "正在產生大綱…" : `產生 ${brief.desiredSlideCount} 頁大綱`}<span>→</span></button>
    </section> : <section className="setup-card setup-settings">
      <div className="section-label">STEP 2 · 設定到生成簡報</div>
      <h1>確認大綱與生成設定</h1>
      <p>確認後會立即排程大綱中的全部 {outline.length} 頁，不會另外假定頁數。</p>
      {project.outlineRationale && <div className="outline-rationale"><strong>AI 頁數與敘事說明</strong><p>{project.outlineRationale}</p></div>}
      <div className="outline-review">
        {outline.map((slide, index) => <article key={slide.id}>
          <b>{String(index + 1).padStart(2, "0")}</b>
          <div className="outline-fields"><label>頁面目的<input value={slide.purpose} onChange={(event) => setOutline(outline.map((item) => item.id === slide.id ? { ...item, purpose: event.target.value } : item))} /></label>
          <label>頁面內容<textarea rows={2} value={slide.content} onChange={(event) => setOutline(outline.map((item) => item.id === slide.id ? { ...item, content: event.target.value } : item))} /></label>
          <label>敘事<textarea rows={2} value={slide.narrative} onChange={(event) => setOutline(outline.map((item) => item.id === slide.id ? { ...item, narrative: event.target.value } : item))} /></label>
          <label>構圖<textarea rows={2} value={slide.layoutHint} onChange={(event) => setOutline(outline.map((item) => item.id === slide.id ? { ...item, layoutHint: event.target.value } : item))} /></label>
          {project.sources.length > 0 && <fieldset><legend>來源</legend>{project.sources.map((source) => <label className="check-row" key={source.id}><input type="checkbox" checked={slide.sourceIds.includes(source.id)} onChange={(event) => setOutline(outline.map((item) => item.id === slide.id ? { ...item, sourceIds: event.target.checked ? [...item.sourceIds, source.id] : item.sourceIds.filter((id) => id !== source.id) } : item))} />{source.name}</label>)}</fieldset>}</div>
          <div className="outline-actions"><button disabled={busy || index === 0} onClick={() => { const ids = outline.map((item) => item.id); [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; setBusy(true); void api.reorderSlides(project.id, ids).then((updated) => { onProject(updated); setOutline(structuredClone(updated.slides)); }).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "排序失敗")).finally(() => setBusy(false)); }}>↑</button><button disabled={busy || index === outline.length - 1} onClick={() => { const ids = outline.map((item) => item.id); [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!]; setBusy(true); void api.reorderSlides(project.id, ids).then((updated) => { onProject(updated); setOutline(structuredClone(updated.slides)); }).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "排序失敗")).finally(() => setBusy(false)); }}>↓</button><button disabled={busy || outline.length === 1} onClick={() => { setBusy(true); void api.deleteSlide(project.id, slide.id).then((updated) => { onProject(updated); setOutline(structuredClone(updated.slides)); }).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "刪除失敗")).finally(() => setBusy(false)); }}>刪除</button></div>
        </article>)}
      </div>
      <button className="add-outline" disabled={busy} onClick={() => setShowNewSlide(true)}>＋ 新增一頁</button>
      <div className="generation-settings">
        <label>風格<select value={project.styleSnapshot.id} onChange={(event) => { setBusy(true); void api.applyStyle(project.id, event.target.value).then(onProject).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "套用風格失敗")).finally(() => setBusy(false)); }}>{styles.map((style) => <option key={style.id} value={style.id}>{style.name} v{style.version}</option>)}</select></label>
        <label>圖片 Provider<select value={providerId} onChange={(event) => onProviderId(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id} disabled={item.availability.status === "unavailable"}>{item.name}{item.availability.status === "unavailable" ? " — unavailable" : ""}</option>)}</select></label>
      </div>
      {provider?.availability.status === "unavailable" && <div className="provider-note">{provider.availability.reason}</div>}
      {provider?.availability.status === "available" && provider.availability.warning && <div className="provider-warning">⚠ {provider.availability.warning}</div>}
      {readinessBusy && <div className="provider-note" role="status">正在檢查 provider readiness…</div>}
      {readiness && <div className={readiness.blocking ? "provider-note" : "provider-warning"} role="status">{readiness.status === "ready_experimental" ? "⚠ " : ""}{readiness.message}</div>}
      {readiness?.requiresAcknowledgement && <label className="readiness-ack"><input type="checkbox" checked={acceptUnknownReadiness} onChange={(event) => onAcceptUnknownReadiness(event.target.checked)} />我了解 readiness 無法確認，仍要嘗試生成</label>}
      <div className="setup-actions">
        <button onClick={() => setShowRequirements(true)} disabled={busy}>返回修改需求</button>
        <button className="primary" onClick={() => void confirmAndGenerate()} disabled={busy || outline.length === 0 || provider?.availability.status !== "available" || readinessBusy || !readiness || readiness.blocking || (readiness.requiresAcknowledgement && !acceptUnknownReadiness)}>{busy ? "正在建立生成工作…" : `確認設定並生成 ${outline.length} 頁簡報`}<span>→</span></button>
      </div>
    </section>}
    {showNewSlide && <NewSlideDialog busy={busy} onCancel={() => setShowNewSlide(false)} onSubmit={(purpose) => {
      setBusy(true); onError("");
      void api.addAiSlide(project.id, purpose, outline.at(-1)?.id).then((updated) => {
        onProject(updated); setOutline(structuredClone(updated.slides)); setShowNewSlide(false);
      }).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "AI 新增頁面失敗")).finally(() => setBusy(false));
    }} />}
  </main>;
}

export function Editor() {
  const [route, setRoute] = useState(() => window.location.pathname);
  const [projects, setProjects] = useState<PresentationProject[]>([]);
  const [project, setProject] = useState<PresentationProject>();
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<SlideSpec>();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [styles, setStyles] = useState<StylePreset[]>([]);
  const [panel, setPanel] = useState<"slide" | "project" | "sources" | "export">("slide");
  const [briefDraft, setBriefDraft] = useState<PresentationBrief>();
  const [draggedId, setDraggedId] = useState<string>();
  const [providerId, setProviderId] = useState("mock-image");
  const [readiness, setReadiness] = useState<ProviderReadiness>();
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [acceptUnknownReadiness, setAcceptUnknownReadiness] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [presentationIndex, setPresentationIndex] = useState<number | null>(null);
  const [stylePickerVersion, setStylePickerVersion] = useState<{ slideId: string; versionId: string }>();
  const [stylePickerBusy, setStylePickerBusy] = useState(false);
  const [showNewSlide, setShowNewSlide] = useState(false);
  const [newSlideBusy, setNewSlideBusy] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<SourceAsset>();
  const [showImageEdit, setShowImageEdit] = useState(false);
  const [imageEditBusy, setImageEditBusy] = useState(false);
  const [previewVersionId, setPreviewVersionId] = useState<string>();
  const [showWebSourceSearch, setShowWebSourceSearch] = useState(false);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [showTextSource, setShowTextSource] = useState(false);
  const [sourceUploadBusy, setSourceUploadBusy] = useState(false);
  const [textEditing, setTextEditing] = useState(false);
  const [textBoxes, setTextBoxes] = useState<EditableTextBox[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string>();
  const [textThreshold, setTextThreshold] = useState(0.75);
  const [textLayerBusy, setTextLayerBusy] = useState(false);
  const [textLayerChanged, setTextLayerChanged] = useState(false);
  const [textUndo, setTextUndo] = useState<EditableTextBox[][]>([]);
  const [textRedo, setTextRedo] = useState<EditableTextBox[][]>([]);

  const navigate = (path: string) => { window.history.pushState({}, "", path); setRoute(new URL(path, window.location.origin).pathname); };
  useEffect(() => { const pop = () => setRoute(window.location.pathname); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);

  useEffect(() => {
    void Promise.all([api.listProjects(), api.providers(), api.styles()])
      .then(([projectList, providerList, styleList]) => { setProjects(projectList); setProviders(providerList); setStyles(styleList); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "載入失敗"));
  }, []);
  useEffect(() => {
    if (!project) return;
    setProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
  }, [project]);
  useEffect(() => {
    const match = /^\/projects\/([a-zA-Z0-9_-]+)$/.exec(route);
    if (!match) return;
    const found = projects.find((item) => item.id === match[1]);
    if (found && found.id !== project?.id) { setProject(found); setSelectedId(found.slides[0]?.id); }
  }, [route, projects, project?.id]);
  useEffect(() => {
    let current = true;
    setReadiness(undefined);
    setAcceptUnknownReadiness(false);
    setReadinessBusy(true);
    void api.readiness(providerId)
      .then((value) => { if (current) setReadiness(value); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "Provider readiness 檢查失敗"); })
      .finally(() => { if (current) setReadinessBusy(false); });
    return () => { current = false; };
  }, [providerId]);

  const selected = project?.slides.find((slide) => slide.id === selectedId) ?? project?.slides[0];
  const selectedVersion = selected?.versions.find((version) => version.id === selected.currentVersionId);
  const provider = providers.find((candidate) => candidate.id === providerId);
  const activeJob = project?.jobs.find((job) => job.slideId === selected?.id && (job.status === "queued" || job.status === "running"));
  const lastJob = useMemo(() => project?.jobs.filter((job) => job.slideId === selected?.id).at(-1), [project?.jobs, selected?.id]);
  const elapsedMs = activeJob ? now - Date.parse(activeJob.startedAt ?? activeJob.createdAt) : 0;
  const remainingMs = activeJob?.timeoutMs && activeJob.startedAt ? Math.max(0, activeJob.timeoutMs - elapsedMs) : undefined;

  useEffect(() => {
    if (selected) setDraft(structuredClone(selected));
    setPreviewVersionId(undefined);
  }, [selected?.id]);
  useEffect(() => {
    setTextEditing(false); setSelectedTextId(undefined); setTextUndo([]); setTextRedo([]);
    setTextLayerChanged(false);
    setTextBoxes(structuredClone(selectedVersion?.textLayer?.boxes ?? []));
    setTextThreshold(selectedVersion?.textLayer?.threshold ?? 0.75);
  }, [selected?.id, selectedVersion?.id]);
  useEffect(() => {
    if (!project || !selected || !draft || draft.id !== selected.id) return;
    const fields = ["purpose", "content", "narrative", "layoutHint", "imagePrompt"] as const;
    const changed = fields.some((field) => draft[field] !== selected[field])
      || JSON.stringify(draft.sourceIds) !== JSON.stringify(selected.sourceIds);
    if (!changed) return;
    const timer = setTimeout(() => {
      setSaving(true);
      void api.updateSlide(project.id, selected.id, {
        purpose: draft.purpose, content: draft.content, narrative: draft.narrative,
        layoutHint: draft.layoutHint, imagePrompt: draft.imagePrompt, sourceIds: draft.sourceIds,
      }).then(setProject).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "自動儲存失敗")).finally(() => setSaving(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, project?.id, selected]);
  useEffect(() => { if (project) setBriefDraft(structuredClone(project.brief)); }, [project?.id]);
  useEffect(() => {
    if (!project || !project.jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    const timer = setInterval(() => {
      void api.getProject(project.id).then(setProject).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "更新失敗"));
    }, 700);
    return () => clearInterval(timer);
  }, [project]);
  useEffect(() => {
    if (!activeJob) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [activeJob?.id]);
  useEffect(() => {
    if (!project || !selected || !selectedVersion?.textLayer || !textEditing) return;
    if (JSON.stringify(textBoxes) === JSON.stringify(selectedVersion.textLayer.boxes)) return;
    const timer = setTimeout(() => {
      setTextLayerBusy(true);
      void api.updateTextLayer(project.id, selected.id, selectedVersion.id, textBoxes, textThreshold)
        .then(setProject).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "文字圖層自動儲存失敗"))
        .finally(() => setTextLayerBusy(false));
    }, 650);
    return () => clearTimeout(timer);
  }, [project?.id, selected?.id, selectedVersion?.id, selectedVersion?.textLayer, textBoxes, textEditing, textThreshold]);
  useEffect(() => {
    if (!textEditing) return;
    const onUndo = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) {
        const next = textRedo.at(-1); if (!next) return;
        setTextUndo((history) => [...history, structuredClone(textBoxes)].slice(-60)); setTextBoxes(structuredClone(next)); setTextRedo((history) => history.slice(0, -1));
      } else {
        const previous = textUndo.at(-1); if (!previous) return;
        setTextRedo((history) => [...history, structuredClone(textBoxes)].slice(-60)); setTextBoxes(structuredClone(previous)); setTextUndo((history) => history.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onUndo); return () => window.removeEventListener("keydown", onUndo);
  }, [textBoxes, textEditing, textRedo, textUndo]);
  useEffect(() => {
    if (!project || project.workflowStage !== "editing") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const isFormControl = target instanceof HTMLElement && (
        target.matches("input, textarea, select, button, a") || target.isContentEditable
      );
      if (sourcePreview) {
        if (event.key === "Escape") { event.preventDefault(); setSourcePreview(undefined); }
        return;
      }
      if (showWebSourceSearch) {
        if (event.key === "Escape") { event.preventDefault(); setShowWebSourceSearch(false); }
        return;
      }
      if (showTextSource) {
        if (event.key === "Escape" && !sourceUploadBusy) { event.preventDefault(); setShowTextSource(false); }
        return;
      }
      if (showImageEdit) {
        if (event.key === "Escape" && !imageEditBusy) { event.preventDefault(); setShowImageEdit(false); }
        return;
      }
      if (showNewSlide) {
        if (event.key === "Escape" && !newSlideBusy) { event.preventDefault(); setShowNewSlide(false); }
        return;
      }
      if (stylePickerVersion) {
        if (event.key === "Escape") { event.preventDefault(); setStylePickerVersion(undefined); }
        return;
      }
      if (presentationIndex !== null) {
        if (isFormControl && event.key === " ") return;
        const lastIndex = project.slides.length - 1;
        let nextIndex = presentationIndex;
        if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(event.key)) nextIndex = Math.min(lastIndex, presentationIndex + 1);
        else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) nextIndex = Math.max(0, presentationIndex - 1);
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = lastIndex;
        else if (event.key === "Escape") {
          event.preventDefault();
          setPresentationIndex(null);
          if (document.fullscreenElement && document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
          return;
        } else return;
        event.preventDefault();
        setPresentationIndex(nextIndex);
        return;
      }
      if (isFormControl || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const currentIndex = Math.max(0, project.slides.findIndex((slide) => slide.id === selectedId));
      const nextIndex = event.key === "ArrowUp" ? Math.max(0, currentIndex - 1) : Math.min(project.slides.length - 1, currentIndex + 1);
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      setSelectedId(project.slides[nextIndex]?.id);
      setPanel("slide");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imageEditBusy, newSlideBusy, presentationIndex, project, selectedId, showImageEdit, showNewSlide, showTextSource, showWebSourceSearch, sourcePreview, sourceUploadBusy, stylePickerVersion]);
  useEffect(() => {
    if (presentationIndex === null) return;
    const onFullscreenChange = () => { if (!document.fullscreenElement) setPresentationIndex(null); };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [presentationIndex]);

  const versionRoute = /^\/styles\/([a-zA-Z0-9_-]+)\/versions\/(\d+)$/.exec(route);
  const styleRoute = /^\/styles\/([a-zA-Z0-9_-]+)$/.exec(route);
  if (route === "/styles/new" || versionRoute || styleRoute) return <StyleEditor
    {...(route === "/styles/new" ? {} : { styleId: (versionRoute ?? styleRoute)![1] })}
    {...(versionRoute ? { historicalVersion: Number(versionRoute[2]) } : {})}
    onSaved={(saved) => { setStyles((all) => [saved, ...all.filter((item) => item.id !== saved.id)]); navigate(`/styles/${saved.id}`); }}
    onExit={() => navigate("/styles")} />;

  if (!project || route === "/" || route === "/styles") return <>
    {error && <div className="toast error">{error}</div>}
    <CreateProject key={`${route}:${window.location.search}`} projects={projects} styles={styles} styleLibrary={route === "/styles"} onNavigate={navigate} onOpen={(value) => { setProject(value); setSelectedId(value.slides[0]?.id); navigate(`/projects/${value.id}`); }} onCreate={async (topic, styleId) => {
      const value = await api.createProject(topic, styleId);
      setProject(value);
      setSelectedId(value.slides[0]?.id);
      navigate(`/projects/${value.id}`);
    }} />
  </>;

  if (project.workflowStage !== "editing") return <>
    {error && <button className="toast error" onClick={() => setError(undefined)}>{error} ×</button>}
    <SetupFlow
      project={project} providers={providers} styles={styles} providerId={providerId}
      {...(readiness ? { readiness } : {})} readinessBusy={readinessBusy} acceptUnknownReadiness={acceptUnknownReadiness}
      onProviderId={setProviderId} onAcceptUnknownReadiness={setAcceptUnknownReadiness}
      onProject={(value) => { setProject(value); setSelectedId(value.slides[0]?.id); }}
      onExit={() => { setProject(undefined); setSelectedId(undefined); navigate("/"); }}
      onError={(message) => setError(message || undefined)}
    />
  </>;

  const save = async (): Promise<boolean> => {
    if (!draft || !selected) return false;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.updateSlide(project.id, selected.id, {
        purpose: draft.purpose,
        content: draft.content,
        narrative: draft.narrative,
        layoutHint: draft.layoutHint,
        imagePrompt: draft.imagePrompt,
        sourceIds: draft.sourceIds,
      });
      setProject(updated);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "儲存失敗");
      return false;
    } finally { setSaving(false); }
  };

  const generate = async () => {
    if (!selected) return;
    let currentReadiness: ProviderReadiness;
    try {
      currentReadiness = await api.readiness(providerId);
      setReadiness(currentReadiness);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider readiness 檢查失敗");
      return;
    }
    if (currentReadiness.blocking || (currentReadiness.requiresAcknowledgement && !acceptUnknownReadiness)) return;
    if (!await save()) return;
    try {
      await api.generate(project.id, selected.id, providerId, acceptUnknownReadiness);
      setProject(await api.getProject(project.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "生成失敗"); }
  };

  const activeImage = selected ? currentImage(project, selected) : undefined;
  const previewVersion = selected?.versions.find((version) => version.id === previewVersionId && version.id !== selected.currentVersionId);
  const image = previewVersion ? imageUrl(project.id, previewVersion.imagePath) : activeImage;
  const outlineView = previewVersion ? (draft && previewVersion.outlineSnapshot ? { ...draft, ...previewVersion.outlineSnapshot } : undefined) : draft;
  const outlineReadOnly = !!previewVersion;
  const outlineDirty = !!selected?.outlineDirty && !outlineReadOnly;
  const previewOutlineMatchesCurrent = !!draft && !!previewVersion?.outlineSnapshot
    && draft.purpose === previewVersion.outlineSnapshot.purpose && draft.content === previewVersion.outlineSnapshot.content
    && draft.narrative === previewVersion.outlineSnapshot.narrative && draft.layoutHint === previewVersion.outlineSnapshot.layoutHint
    && draft.imagePrompt === previewVersion.outlineSnapshot.imagePrompt
    && JSON.stringify(draft.sourceIds) === JSON.stringify(previewVersion.outlineSnapshot.sourceIds);
  const presentationSlide = presentationIndex === null ? undefined : project.slides[presentationIndex];
  const presentationImage = presentationSlide ? currentImage(project, presentationSlide) : undefined;
  const run = async (operation: () => Promise<PresentationProject>) => {
    setError(undefined);
    try { const updated = await operation(); setProject(updated); return updated; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失敗"); return undefined; }
  };
  const startPresentation = () => {
    const index = Math.max(0, project.slides.findIndex((slide) => slide.id === selected?.id));
    setPresentationIndex(index);
    const request = document.documentElement.requestFullscreen?.();
    if (request) void request.catch(() => undefined);
  };
  const stopPresentation = () => {
    setPresentationIndex(null);
    if (document.fullscreenElement && document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
  };
  const addCurrentImageToStyle = async (styleId?: string) => {
    if (!stylePickerVersion) return;
    setStylePickerBusy(true);
    setError(undefined);
    try {
      const reference = await api.versionToStyleReference(project.id, stylePickerVersion.slideId, stylePickerVersion.versionId);
      sessionStorage.setItem("pendingStyleReference", JSON.stringify(reference));
      setStylePickerVersion(undefined);
      navigate(styleId ? `/styles/${styleId}` : "/styles/new");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加入風格庫失敗");
    } finally { setStylePickerBusy(false); }
  };
  const uploadSourceFiles = async (files: File[]) => {
    if (!files.length) return;
    setSourceUploadBusy(true); setError(undefined);
    try {
      const results = await Promise.allSettled(files.map((file) => api.uploadSource(project.id, file)));
      setProject(await api.getProject(project.id));
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length) throw new Error(`${files.length - failed.length} 個檔案已上傳，${failed.length} 個失敗`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "來源上傳失敗"); }
    finally { setSourceUploadBusy(false); }
  };
  const changeTextBoxes = (next: EditableTextBox[]) => {
    setTextUndo((history) => [...history, structuredClone(textBoxes)].slice(-60));
    setTextRedo([]); setTextLayerChanged(true); setTextBoxes(next);
  };
  const selectedText = textBoxes.find((box) => box.id === selectedTextId);
  const patchSelectedText = (patch: Partial<EditableTextBox>) => {
    if (!selectedTextId) return;
    changeTextBoxes(textBoxes.map((box) => box.id === selectedTextId ? { ...box, ...patch } : box));
  };
  const startTextExtraction = async () => {
    if (!selected || !selectedVersion) return;
    setTextLayerBusy(true); setError(undefined);
    try {
      const status = await api.ocrStatus();
      if (!status.available) throw new Error(status.message);
      await api.extractText(project.id, selected.id, providerId, textThreshold, acceptUnknownReadiness);
      setProject(await api.getProject(project.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "文字抽離失敗"); }
    finally { setTextLayerBusy(false); }
  };
  return <div className="shell">
    <header>
      <button className="brand" onClick={() => { setProject(undefined); setSelectedId(undefined); navigate("/"); }}>SM<span>↗</span></button>
      <div className="title-block"><strong>{project.name}</strong><small>{project.canvas.width} × {project.canvas.height} · {project.styleSnapshot.name}</small></div>
      <nav className="workspace-nav">
        <button onClick={() => setPanel("project")}>專案</button><button onClick={() => setPanel("sources")}>來源 <b>{project.sources.length}</b></button><button onClick={() => setPanel("export")}>匯出</button><button className="present-button" onClick={startPresentation}>▶ 簡報模式</button>
      </nav>
      <div className="header-status"><span className="status-dot" />{saving ? "正在自動儲存…" : "已自動儲存"}</div>
    </header>
    <aside className="rail">
      <div className="rail-heading"><span>PAGES</span><b>{project.slides.length}</b></div>
      <button className="add-page" onClick={() => setShowNewSlide(true)}>＋ 新增頁面</button>
      <div className="thumbnails">
        {project.slides.map((slide) => {
          const thumb = currentImage(project, slide);
          return <div key={slide.id} className={`thumbnail ${slide.id === selected?.id ? "selected" : ""}`} draggable onDragStart={() => setDraggedId(slide.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => {
            if (!draggedId || draggedId === slide.id) return;
            const ids = project.slides.map((item) => item.id); const from = ids.indexOf(draggedId); const to = ids.indexOf(slide.id); ids.splice(to, 0, ids.splice(from, 1)[0]!);
            void run(() => api.reorderSlides(project.id, ids)); setDraggedId(undefined);
          }} onClick={() => { setSelectedId(slide.id); setPanel("slide"); }} role="button" tabIndex={0}>
            <span className="slide-number">{String(slide.order + 1).padStart(2, "0")}</span>
            <span className="thumb-canvas" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}>
              {!thumb && <em>{slide.purpose}</em>}
            </span>
            <span className="thumb-actions"><button title="複製頁面" onClick={(event) => { event.stopPropagation(); void run(() => api.duplicateSlide(project.id, slide.id)); }}>⧉</button><button title="刪除頁面" disabled={project.slides.length === 1} onClick={(event) => { event.stopPropagation(); if (confirm("刪除此頁？")) void run(() => api.deleteSlide(project.id, slide.id)); }}>×</button></span>
          </div>;
        })}
      </div>
    </aside>
    <main className="stage">
      <div className="stage-meta"><span>{selected?.purpose}</span><span className="stage-meta-actions">
        <button onClick={() => { if (selected?.currentVersionId) setStylePickerVersion({ slideId: selected.id, versionId: selected.currentVersionId }); }} disabled={!selected?.currentVersionId || !!activeJob || !!previewVersion}>＋ 將圖片加入風格庫</button>
        {selectedVersion?.textLayer && !previewVersion && <button className={textEditing ? "active" : ""} onClick={() => setTextEditing((value) => !value)}>{textEditing ? "完成文字編輯" : "編輯文字圖層"}</button>}
        <span>{activeJob ? `● ${PHASE_LABELS[activeJob.phase ?? activeJob.status] ?? activeJob.status}` : previewVersion ? "歷史版本預覽" : "16:9 PREVIEW"}</span>
      </span></div>
      <div className={`canvas ${activeJob ? "generating" : ""}`}>
        {textEditing && selectedVersion?.textLayer && !previewVersion
          ? <TextLayerCanvas
            background={imageUrl(project.id, selectedVersion.textLayer.backgroundPath)}
            original={imageUrl(project.id, selected?.versions.find((version) => version.id === selectedVersion.textLayer!.originalVersionId)?.imagePath ?? selectedVersion.imagePath)}
            pristine={!textLayerChanged && selectedVersion.textLayer.renderRevision === 0}
            boxes={textBoxes} canvasWidth={project.canvas.width} canvasHeight={project.canvas.height}
            selectedId={selectedTextId} onSelect={setSelectedTextId} onChange={changeTextBoxes}
          />
          : image ? <img src={image} alt={`Slide ${(selected?.order ?? 0) + 1}`} /> : <div className="canvas-empty"><div className="orbit" /><strong>{selected?.purpose}</strong><p>內容會自動儲存，準備好後即可生成此頁。</p></div>}
      </div>
      {textEditing && selectedVersion?.textLayer && <div className="text-layer-toolbar">
        <span>{textLayerBusy ? "正在重繪並自動儲存…" : `${textBoxes.length} 個可編輯文字框`}</span>
        <button onClick={() => { const box: EditableTextBox = { id: crypto.randomUUID(), text: "新增文字", x: 120, y: 120, width: 420, height: 80, fontFamily: "Arial", fontSize: 44, fontWeight: 400, color: "#ffffff", opacity: 1, lineHeight: 1.2, letterSpacing: 0, align: "left", verticalAlign: "top", rotation: 0, confidence: 1, role: "presentation" }; changeTextBoxes([...textBoxes, box]); setSelectedTextId(box.id); }}>＋ 文字框</button>
        <button disabled={!selectedText} onClick={() => { changeTextBoxes(textBoxes.filter((box) => box.id !== selectedTextId)); setSelectedTextId(undefined); }}>刪除文字框</button>
        <button disabled={!textUndo.length} onClick={() => { const previous = textUndo.at(-1); if (!previous) return; setTextRedo((history) => [...history, structuredClone(textBoxes)]); setTextBoxes(previous); setTextUndo((history) => history.slice(0, -1)); }}>復原</button>
        <button disabled={!textRedo.length} onClick={() => { const next = textRedo.at(-1); if (!next) return; setTextUndo((history) => [...history, structuredClone(textBoxes)]); setTextBoxes(next); setTextRedo((history) => history.slice(0, -1)); }}>重做</button>
      </div>}
      {previewVersion && selected && <div className="version-preview-actions" role="status">
        <span><b>正在預覽歷史版本</b><small>{new Date(previewVersion.createdAt).toLocaleString("zh-TW")}{!previewVersion.outlineSnapshot ? " · 舊版未保存大綱，僅比較圖片" : previewOutlineMatchesCurrent ? " · 大綱與目前版本相同" : " · 圖片與大綱快照"}</small></span>
        <button onClick={() => setPreviewVersionId(undefined)}>返回目前版本</button>
        <button className="primary" disabled={!!activeJob} onClick={() => {
          void run(() => api.activateVersion(project.id, selected.id, previewVersion.id)).then((updated) => {
            if (!updated) return;
            const switched = updated.slides.find((slide) => slide.id === selected.id);
            if (switched) setDraft(structuredClone(switched));
            setPreviewVersionId(undefined);
          });
        }}>切換至此版本</button>
      </div>}
      {activeJob && <div className="job-progress" role="status">
        <div><strong>{PHASE_LABELS[activeJob.phase ?? activeJob.status] ?? activeJob.status}</strong><span>{activeJob.progress ? `步驟 ${activeJob.progress.step} / ${activeJob.progress.total}` : "處理中"}</span></div>
        <div className="progress-track"><i style={{ width: `${((activeJob.progress?.step ?? 1) / (activeJob.progress?.total ?? 6)) * 100}%` }} /></div>
        <div className="job-time"><span>已經過 {duration(elapsedMs)}</span>{remainingMs !== undefined && <span>預估逾時剩餘 {duration(remainingMs)}</span>}</div>
        {activeJob.phase === "waiting_for_codex" && elapsedMs > 120_000 && <p>圖片生成可能需要數分鐘。若接近逾時，請確認 Codex 額度與登入，或調高 server timeout 後重新啟動。</p>}
        <button onClick={() => { void api.cancel(project.id, activeJob.id).then(() => api.getProject(project.id)).then(setProject).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "取消失敗")); }}>取消生成</button>
      </div>}
      {lastJob?.status === "failed" && <div className="job-error">生成失敗{lastJob.errorCode ? `（${lastJob.errorCode}）` : ""}：{lastJob.error}</div>}
      <div className="versions">
        <div className="section-label">版本歷史</div>
        <div className="version-list">
          {selected?.versions.length === 0 && <span className="empty-inline">尚無版本</span>}
          {[...(selected?.versions ?? [])].reverse().map((version) => {
            const isCurrent = version.id === selected?.currentVersionId;
            const isPreviewing = version.id === previewVersion?.id;
            const versionNumber = (selected?.versions.findIndex((candidate) => candidate.id === version.id) ?? 0) + 1;
            return <button key={version.id} aria-label={`版本 ${versionNumber}${isCurrent ? "（目前）" : ""}`} className={`${isCurrent ? "current" : ""} ${isPreviewing ? "previewing" : ""}`.trim()} onClick={() => setPreviewVersionId(isCurrent ? undefined : version.id)}>
            <img src={imageUrl(project.id, version.imagePath)} alt="version" />
            <span>{new Date(version.createdAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}{isCurrent ? " · 使用中" : isPreviewing ? " · 預覽" : ""}</span>
          </button>;
          })}
        </div>
      </div>
    </main>
    <aside className="inspector">
      <div className="inspector-tabs"><button className={panel === "slide" ? "active" : ""} onClick={() => setPanel("slide")}>頁面</button><button className={panel === "project" ? "active" : ""} onClick={() => setPanel("project")}>設定</button><button className={panel === "sources" ? "active" : ""} onClick={() => setPanel("sources")}>來源</button><button className={panel === "export" ? "active" : ""} onClick={() => setPanel("export")}>匯出</button></div>
      {panel === "slide" && <><div className="inspector-heading"><span>SLIDE SPEC</span><b>{String((selected?.order ?? 0) + 1).padStart(2, "0")}</b></div>
      {previewVersion && !previewVersion.outlineSnapshot && <div className="outline-preview-unavailable"><b>此版本沒有大綱快照</b><span>它建立於大綱隨圖片版本保存之前，因此只能比較圖片；切換後目前大綱會保留為待生成草稿。</span></div>}
      {outlineView && draft && <div className="fields">
        <label>頁面目的<input readOnly={outlineReadOnly} value={outlineView.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} /></label>
        <label className={outlineDirty ? "outline-dirty" : ""}>內容<textarea readOnly={outlineReadOnly} rows={4} value={outlineView.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
        <label className={outlineDirty ? "outline-dirty" : ""}>敘事<textarea readOnly={outlineReadOnly} rows={3} value={outlineView.narrative} onChange={(event) => setDraft({ ...draft, narrative: event.target.value })} /></label>
        <label className={outlineDirty ? "outline-dirty" : ""}>構圖提示<textarea readOnly={outlineReadOnly} rows={3} value={outlineView.layoutHint} onChange={(event) => setDraft({ ...draft, layoutHint: event.target.value })} /></label>
        <label className={outlineDirty ? "outline-dirty" : ""}>完整圖片提示詞<textarea readOnly={outlineReadOnly} className="prompt" rows={6} value={outlineView.imagePrompt} onChange={(event) => setDraft({ ...draft, imagePrompt: event.target.value })} /></label>
        <fieldset><legend>此頁來源</legend>{project.sources.length === 0 ? <small>請先在「來源」上傳資料。</small> : project.sources.map((source) => <label className="check-row" key={source.id}><input type="checkbox" disabled={outlineReadOnly} checked={outlineView.sourceIds.includes(source.id)} onChange={(event) => setDraft({ ...draft, sourceIds: event.target.checked ? [...draft.sourceIds, source.id] : draft.sourceIds.filter((id) => id !== source.id) })} />{source.name}</label>)}</fieldset>
        <label>圖片 Provider<select value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id} disabled={item.availability.status === "unavailable"}>{item.name}{item.availability.status === "unavailable" ? " — unavailable" : ""}</option>)}</select></label>
        {provider?.availability.status === "unavailable" && <div className="provider-note">{provider.availability.reason}</div>}
        {provider?.availability.status === "available" && provider.availability.warning && <div className="provider-warning">⚠ {provider.availability.warning}</div>}
        {readinessBusy && <div className="provider-note" role="status">正在檢查 provider readiness…</div>}
        {readiness && <div className={readiness.blocking ? "provider-note" : "provider-warning"} role="status">
          {readiness.status === "ready_experimental" ? "⚠ " : ""}{readiness.message}
        </div>}
        {readiness?.requiresAcknowledgement && <label className="readiness-ack">
          <input type="checkbox" checked={acceptUnknownReadiness} onChange={(event) => setAcceptUnknownReadiness(event.target.checked)} />
          我了解 readiness 無法確認，仍要嘗試生成
        </label>}
        {provider?.timeoutMs && <div className="provider-timeout">單頁逾時：{duration(provider.timeoutMs)}</div>}
      </div>}
      <div className="actions">
        <button className="regenerate-outline" onClick={() => {
          if (!selected) return;
          setOutlineBusy(true); setError(undefined);
          void save().then(async (saved) => {
            if (!saved) return;
            const updated = await api.regenerateSlideOutline(project.id, selected.id);
            const regenerated = updated.slides.find((slide) => slide.id === selected.id);
            setProject(updated); if (regenerated) setDraft(structuredClone(regenerated));
          }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "重新生成單頁大綱失敗")).finally(() => setOutlineBusy(false));
        }} disabled={outlineBusy || !!activeJob || !!previewVersion}>{outlineBusy ? "正在重新檢索來源與生成大綱…" : "重新生成單頁大綱"}</button>
        <button className="primary" onClick={() => void generate()} disabled={!!activeJob || !!previewVersion || provider?.availability.status !== "available" || readinessBusy || !readiness || readiness.blocking || (readiness.requiresAcknowledgement && !acceptUnknownReadiness)}>{activeJob ? "生成中…" : selected?.versions.length ? "重新生成圖片" : "生成此頁"}<span>→</span></button>
        <button className="image-edit-button" onClick={() => setShowImageEdit(true)} disabled={!activeImage || !!activeJob || !!previewVersion || !provider?.capabilities.imageEditing}>編輯當頁圖片</button>
        <div className="text-extraction-control">
          <label>OCR 門檻 <b>{textThreshold.toFixed(2)}</b><input type="range" min="0.5" max="0.95" step="0.05" value={textThreshold} onChange={(event) => setTextThreshold(Number(event.target.value))} /></label>
          <button onClick={() => void startTextExtraction()} disabled={!selectedVersion || !!activeJob || !!previewVersion || textLayerBusy || !provider?.capabilities.maskedEditing}>{textLayerBusy ? "處理中…" : selectedVersion?.textLayer ? "依門檻重新抽離文字" : "文字抽離"}</button>
          <small>只處理當頁；低於門檻的文字保留在原圖。</small>
        </div>
      </div>
      {textEditing && <div className="text-properties fields">
        <div className="section-label">TEXT BOX</div>
        {!selectedText && <small>在畫布選擇一個文字框以調整格式。</small>}
        {selectedText && <>
          <label>字體<input value={selectedText.fontFamily} onChange={(event) => patchSelectedText({ fontFamily: event.target.value })} /></label>
          <div className="text-property-grid"><label>大小<input type="number" min="6" max="300" value={selectedText.fontSize} onChange={(event) => patchSelectedText({ fontSize: Number(event.target.value) })} /></label><label>字重<select value={selectedText.fontWeight} onChange={(event) => patchSelectedText({ fontWeight: Number(event.target.value) })}><option value="400">一般</option><option value="600">半粗</option><option value="700">粗體</option><option value="900">黑體</option></select></label></div>
          <div className="text-property-grid"><label>顏色<input type="color" value={selectedText.color} onChange={(event) => patchSelectedText({ color: event.target.value })} /></label><label>對齊<select value={selectedText.align} onChange={(event) => patchSelectedText({ align: event.target.value as EditableTextBox["align"] })}><option value="left">靠左</option><option value="center">置中</option><option value="right">靠右</option></select></label></div>
          <div className="text-property-grid"><label>行高<input type="number" min="0.8" max="3" step="0.1" value={selectedText.lineHeight} onChange={(event) => patchSelectedText({ lineHeight: Number(event.target.value) })} /></label><label>字距<input type="number" min="-10" max="30" step="0.5" value={selectedText.letterSpacing} onChange={(event) => patchSelectedText({ letterSpacing: Number(event.target.value) })} /></label></div>
        </>}
      </div>}
      </>}
      {panel === "project" && briefDraft && <div className="panel-content fields"><div className="inspector-heading"><span>PROJECT BRIEF</span></div>
        <label>主題<input value={briefDraft.topic} onChange={(event) => setBriefDraft({ ...briefDraft, topic: event.target.value })} /></label>
        <label>目標觀眾<input value={briefDraft.audience} onChange={(event) => setBriefDraft({ ...briefDraft, audience: event.target.value })} /></label>
        <label>目的<input value={briefDraft.purpose} onChange={(event) => setBriefDraft({ ...briefDraft, purpose: event.target.value })} /></label>
        <label>語言<input value={briefDraft.language} onChange={(event) => setBriefDraft({ ...briefDraft, language: event.target.value })} /></label>
        <label>頁數<input type="number" min={1} max={100} value={briefDraft.desiredSlideCount} onChange={(event) => setBriefDraft({ ...briefDraft, desiredSlideCount: Number(event.target.value) })} /></label>
        <label>語氣<input value={briefDraft.tone} onChange={(event) => setBriefDraft({ ...briefDraft, tone: event.target.value })} /></label>
        <label>內容模式<select value={briefDraft.contentMode} onChange={(event) => setBriefDraft({ ...briefDraft, contentMode: event.target.value as PresentationBrief["contentMode"] })}><option value="creative">Creative</option><option value="grounded">Grounded</option></select></label>
        <label>Web Search<select value={briefDraft.webSearchMode} onChange={(event) => setBriefDraft({ ...briefDraft, webSearchMode: event.target.value as PresentationBrief["webSearchMode"] })}><option value="cached">Cached</option><option value="live">Live</option><option value="disabled">Disabled</option></select></label>
        <label>風格<select value={project.styleSnapshot.id} onChange={(event) => void run(() => api.applyStyle(project.id, event.target.value))}>{styles.map((style) => <option key={style.id} value={style.id}>{style.name} v{style.version}</option>)}</select></label>
        <div className="panel-actions"><button className="primary" onClick={() => void run(() => api.updateBrief(project.id, briefDraft))}>儲存 Brief</button><button onClick={() => { if (confirm("重新產生大綱會取代目前頁面，確定繼續？")) void run(() => api.regenerateOutline(project.id, true)); }}>依 Brief 重建大綱</button><button className="batch-generate" onClick={() => { void save().then(async (saved) => { if (!saved) return; try { await api.generateAll(project.id, providerId, acceptUnknownReadiness); setProject(await api.getProject(project.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "批次生成失敗"); } }); }} disabled={project.jobs.some((job) => ["queued", "running"].includes(job.status)) || readinessBusy || !readiness || readiness.blocking}>批次生成全部頁面</button></div>
      </div>}
      {panel === "sources" && <div className="panel-content sources-panel"><div className="inspector-heading"><span>SOURCES</span><b>{project.sources.length}/100</b></div>
        <p className="source-panel-intro">管理 AI 可使用的參考資料。點擊預覽可檢查擷取文字或原始圖片。</p>
        <div className="source-add-actions">
          <label className={`upload-source ${sourceUploadBusy ? "disabled" : ""}`}>＋ {sourceUploadBusy ? "正在上傳來源…" : "上傳來源檔案"}<span>可多選 · PDF · PPTX · DOCX · MD · TXT · PNG · JPG</span><input aria-label="上傳來源檔案" type="file" multiple disabled={sourceUploadBusy} accept=".pdf,.pptx,.docx,.md,.txt,.png,.jpg,.jpeg" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void uploadSourceFiles(files); }} /></label>
          <button className="add-text-source" disabled={sourceUploadBusy} onClick={() => setShowTextSource(true)}>＋ 輸入文字<span>貼上文字 · 自動建立索引</span></button>
          <button className="add-web-source" disabled={sourceUploadBusy} onClick={() => setShowWebSourceSearch(true)}>⌕ 加入搜尋資料<span>輸入關鍵字 · 確認後儲存全文</span></button>
        </div>
        {project.sources.length === 0 && <div className="source-empty"><b>尚無來源</b><span>上傳文字、文件或圖片，生成時即可引用。</span></div>}
        <div className="source-list">{project.sources.map((source) => {
          const imageSource = source.mediaType.startsWith("image/");
          const summary = sourceSummary(source);
          const assetUrl = projectAssetUrl(project.id, source.assetPath);
          return <article key={source.id} className="source-card">
            <header className="source-card-header">
              <label className="source-access-toggle" title="允許 AI 在生成時讀取此來源">
                <input aria-label={`允許 AI 使用 ${source.name}`} type="checkbox" checked={source.allowModelAccess} onChange={(event) => void run(() => api.updateSource(project.id, source.id, { allowModelAccess: event.target.checked }))} />
              </label>
              <div><strong title={source.name}>{source.name}</strong><small>{sourceSize(source.sizeBytes)} · {source.chunks.length} 個文字區塊</small></div>
              <span className="source-kind">{sourceTypeLabel(source)}</span>
            </header>
            <button type="button" className={`source-preview-trigger ${imageSource ? "image" : "text"}`} aria-label={`預覽 ${source.name}`} onClick={() => setSourcePreview(source)}>
              {imageSource ? <img src={assetUrl} alt="" /> : <p>{summary || "尚未擷取到可預覽的文字內容"}</p>}
              <span>查看來源詳情 <b>→</b></span>
            </button>
            <label className="source-usage">生成用途<select aria-label={`${source.name} 的生成用途`} value={source.usage} onChange={(event) => void run(() => api.updateSource(project.id, source.id, { usage: event.target.value as typeof source.usage }))}><option value="content">內容依據</option><option value="visual-reference">視覺參考</option><option value="style-reference">風格參考</option><option value="direct-asset">直接素材</option><option value="exclude-from-generation">不參與生成</option></select></label>
            <div className="source-card-actions"><button className="danger" onClick={() => { if (confirm("刪除來源？既有版本的來源快照仍會保留。")) void run(() => api.deleteSource(project.id, source.id, true)); }}>刪除來源</button></div>
          </article>;
        })}</div>
      </div>}
      {panel === "export" && <div className="panel-content export-panel"><div className="inspector-heading"><span>EXPORT</span></div><p>匯出會依目前頁面順序使用每頁的目前版本；缺少圖片的頁面會阻止匯出。</p>
        <a href={`/api/projects/${encodeURIComponent(project.id)}/export/pptx`}>下載 PowerPoint (.pptx)</a><a href={`/api/projects/${encodeURIComponent(project.id)}/export/pdf`}>下載 PDF (.pdf)</a><a href={`/api/projects/${encodeURIComponent(project.id)}/export/png.zip`}>下載每頁 PNG (.zip)</a><a href={`/api/projects/${encodeURIComponent(project.id)}/export/slide-project`}>備份完整專案 (.slide-project)</a>
      </div>}
    </aside>
    {showNewSlide && <NewSlideDialog busy={newSlideBusy} onCancel={() => setShowNewSlide(false)} onSubmit={(purpose) => {
      setNewSlideBusy(true); setError(undefined);
      const previousIds = new Set(project.slides.map((slide) => slide.id));
      void api.addAiSlide(project.id, purpose, selected?.id).then((updated) => {
        setProject(updated);
        setSelectedId(updated.slides.find((slide) => !previousIds.has(slide.id))?.id);
        setPanel("slide"); setShowNewSlide(false);
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "AI 新增頁面失敗")).finally(() => setNewSlideBusy(false));
    }} />}
    {sourcePreview && <SourcePreviewDialog projectId={project.id} source={sourcePreview} onClose={() => setSourcePreview(undefined)} />}
    {showWebSourceSearch && <WebSourceDialog onCancel={() => setShowWebSourceSearch(false)} onSearch={(query) => api.searchWebSources(project.id, query)} onSave={async (sources) => {
      const updated = await api.addWebSources(project.id, sources);
      setProject(updated); setShowWebSourceSearch(false); setPanel("sources");
    }} />}
    {showTextSource && <TextSourceDialog busy={sourceUploadBusy} onCancel={() => setShowTextSource(false)} onSubmit={(name, text) => {
      setSourceUploadBusy(true); setError(undefined);
      const file = new File([text], name, { type: name.toLowerCase().endsWith(".txt") ? "text/plain" : "text/markdown" });
      void api.uploadSource(project.id, file).then((updated) => { setProject(updated); setShowTextSource(false); setPanel("sources"); })
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "文字來源建立失敗")).finally(() => setSourceUploadBusy(false));
    }} />}
    {showImageEdit && activeImage && selected && <ImageEditDialog image={activeImage} busy={imageEditBusy} supportsMask={!!provider?.capabilities.maskedEditing} onCancel={() => setShowImageEdit(false)} onSubmit={(instruction, maskDataUrl) => {
      setImageEditBusy(true); setError(undefined);
      void save().then(async (saved) => {
        if (!saved) return;
        await api.editSlideImage(project.id, selected.id, providerId, instruction, maskDataUrl, acceptUnknownReadiness);
        setProject(await api.getProject(project.id));
        setShowImageEdit(false);
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "圖片編輯失敗")).finally(() => setImageEditBusy(false));
    }} />}
    {stylePickerVersion && <div className="style-picker-backdrop" role="dialog" aria-modal="true" aria-label="選擇風格" onClick={() => { if (!stylePickerBusy) setStylePickerVersion(undefined); }}>
      <section className="style-picker" onClick={(event) => event.stopPropagation()}>
        <header><div><span className="section-label">ADD TO STYLE LIBRARY</span><h2>選擇要加入的風格</h2><p>圖片會先帶入風格編輯頁，確認設定後再儲存新版本。</p></div><button aria-label="關閉風格選擇" disabled={stylePickerBusy} onClick={() => setStylePickerVersion(undefined)}>×</button></header>
        <button className="style-picker-new" disabled={stylePickerBusy} onClick={() => void addCurrentImageToStyle()}><b>＋</b><span><strong>建立新風格</strong><small>用這張圖片作為第一張參考圖</small></span><i>→</i></button>
        <div className="style-picker-list">
          {styles.filter((style) => !style.system).length === 0 && <p className="style-picker-empty">目前還沒有自訂風格，可以先建立新風格。</p>}
          {styles.filter((style) => !style.system).map((style) => {
            const cover = style.referenceImages.find((item) => item.id === style.coverImageId) ?? style.referenceImages[0];
            const full = style.referenceImages.length >= 4;
            return <button key={style.id} className="style-picker-card" disabled={stylePickerBusy || full} onClick={() => void addCurrentImageToStyle(style.id)}>
              <span className="style-picker-cover" style={cover ? { backgroundImage: `url(${styleAssetUrl(cover.id)})` } : undefined}>{cover ? "" : style.name.slice(0, 1)}</span>
              <span><strong>{style.name}</strong><small>v{style.version} · 密度 {style.density === "high" ? "高" : style.density === "medium" ? "中" : "低"} · 參考圖 {style.referenceImages.length}/4</small>{full && <em>參考圖已滿</em>}</span><i>→</i>
            </button>;
          })}
        </div>
        {stylePickerBusy && <div className="style-picker-loading">正在準備參考圖…</div>}
      </section>
    </div>}
    {presentationIndex !== null && presentationSlide && <div className="presentation-mode" role="dialog" aria-modal="true" aria-label="全螢幕簡報" onClick={() => setPresentationIndex(Math.min(project.slides.length - 1, presentationIndex + 1))}>
      <div className="presentation-surface">
        {presentationImage ? <img src={presentationImage} alt={`簡報第 ${presentationIndex + 1} 頁`} draggable={false} /> : <div className="presentation-empty"><strong>{presentationSlide.purpose}</strong><span>這一頁尚未生成圖片</span></div>}
      </div>
      <div className="presentation-controls" onClick={(event) => event.stopPropagation()}>
        <button aria-label="上一頁" disabled={presentationIndex === 0} onClick={() => setPresentationIndex(Math.max(0, presentationIndex - 1))}>←</button>
        <span>{presentationIndex + 1} / {project.slides.length}</span>
        <button aria-label="下一頁" disabled={presentationIndex === project.slides.length - 1} onClick={() => setPresentationIndex(Math.min(project.slides.length - 1, presentationIndex + 1))}>→</button>
        <small>方向鍵／Space 換頁 · Esc 離開</small>
        <button className="presentation-close" aria-label="離開簡報模式" onClick={stopPresentation}>×</button>
      </div>
    </div>}
    {error && <button className="toast error" onClick={() => setError(undefined)}>{error} ×</button>}
  </div>;
}

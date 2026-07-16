import { useEffect, useMemo, useState } from "react";
import type { StylePreset, StyleReferenceImage } from "@slide-maker/core";
import { api, styleAssetUrl } from "./api.js";

type Draft = Pick<StylePreset, "name" | "description" | "density" | "imageDirection" | "avoid" | "promptTemplate" | "referenceImages"> & { coverImageId: string | undefined };

function fromStyle(style?: StylePreset): Draft {
  return style ? {
    name: style.name, description: style.description, density: style.density, imageDirection: style.imageDirection,
    avoid: [...style.avoid], promptTemplate: style.promptTemplate, referenceImages: [...style.referenceImages],
    coverImageId: style.coverImageId ?? style.referenceImages[0]?.id,
  } : { name: "", description: "", density: "high", imageDirection: "", avoid: [], promptTemplate: "", referenceImages: [], coverImageId: undefined };
}

export function StyleEditor({ styleId, historicalVersion, onSaved, onExit }: {
  styleId?: string; historicalVersion?: number; onSaved: (style: StylePreset) => void; onExit: () => void;
}) {
  const [style, setStyle] = useState<StylePreset>();
  const [versions, setVersions] = useState<StylePreset[]>([]);
  const [draft, setDraft] = useState<Draft>(() => fromStyle());
  const [baseline, setBaseline] = useState(() => JSON.stringify(fromStyle()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = JSON.stringify(draft) !== baseline;
  const readOnly = !!historicalVersion || !!style?.system;

  useEffect(() => {
    let current = true;
    const load = async () => {
      if (!styleId) return;
      const all = await api.styleVersions(styleId);
      const selected = historicalVersion ? all.find((item) => item.version === historicalVersion) : all.at(-1);
      if (!selected) throw new Error("找不到風格版本");
      if (current) { setVersions(all); setStyle(selected); setDraft(fromStyle(selected)); setBaseline(JSON.stringify(fromStyle(selected))); }
    };
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "載入風格失敗"));
    return () => { current = false; };
  }, [styleId, historicalVersion]);

  useEffect(() => {
    const serialized = sessionStorage.getItem("pendingStyleReference");
    if (!serialized || readOnly || (styleId && !style)) return;
    sessionStorage.removeItem("pendingStyleReference");
    try {
      const reference = JSON.parse(serialized) as StyleReferenceImage;
      setDraft((value) => value.referenceImages.length >= 4 ? value : {
        ...value,
        referenceImages: [...value.referenceImages, reference],
        coverImageId: value.coverImageId ?? reference.id,
      });
    } catch { /* ignore stale session data */ }
  }, [styleId, style, readOnly]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const cover = useMemo(() => draft.referenceImages.find((item) => item.id === draft.coverImageId) ?? draft.referenceImages[0], [draft]);
  const leave = () => { if (!dirty || confirm("尚未儲存的風格變更會消失，確定離開？")) onExit(); };
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const saved = styleId ? await api.updateStyle(styleId, draft) : await api.createStyle(draft);
      setStyle(saved); setDraft(fromStyle(saved)); setBaseline(JSON.stringify(fromStyle(saved))); onSaved(saved);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "儲存失敗"); }
    finally { setBusy(false); }
  };
  const move = (index: number, direction: -1 | 1) => {
    const next = [...draft.referenceImages]; const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!]; setDraft({ ...draft, referenceImages: next });
  };

  return <main className="style-editor-page">
    <header className="style-header"><button className="brand" onClick={leave}>SM<span>↗</span></button><div><strong>{styleId ? style?.name ?? "載入中…" : "建立風格"}</strong><small>進階風格設定 · {historicalVersion ? `歷史 v${historicalVersion}` : style ? `v${style.version}` : "新風格"}</small></div></header>
    <section className="style-editor-grid">
      <div className="style-form">
        <div className="section-label">STYLE SETTINGS</div><h1>{readOnly ? "檢視風格版本" : "定義視覺語言"}</h1>
        {style?.system && <div className="provider-note">「AI 自由設計」是唯讀系統風格；可複製後再編輯。</div>}
        <label>名稱<input disabled={readOnly} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>描述<textarea disabled={readOnly} rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label>資訊密度<select disabled={readOnly} value={draft.density} onChange={(event) => setDraft({ ...draft, density: event.target.value as Draft["density"] })}><option value="low">低（視覺優先）</option><option value="medium">中（圖文平衡）</option><option value="high">高（文字／數據優先，預設）</option></select><small className="density-help">高密度會要求更多可讀資訊區塊，並降低裝飾圖片占比。</small></label>
        <label>圖片方向<textarea disabled={readOnly} rows={5} value={draft.imageDirection} onChange={(event) => setDraft({ ...draft, imageDirection: event.target.value })} placeholder="描述影像質感、構圖、光線與視覺節奏" /></label>
        <label>提示詞模板<textarea disabled={readOnly} rows={6} value={draft.promptTemplate} onChange={(event) => setDraft({ ...draft, promptTemplate: event.target.value })} /></label>
        <label>避免項目（每行一項）<textarea disabled={readOnly} rows={4} value={draft.avoid.join("\n")} onChange={(event) => setDraft({ ...draft, avoid: event.target.value.split(/\n/).map((item) => item.trim()).filter(Boolean) })} /></label>
        <div className="style-actions">
          {style?.system && <button onClick={() => { setBusy(true); void api.duplicateStyle(style.id).then(onSaved).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "複製失敗")).finally(() => setBusy(false)); }}>複製為自訂風格</button>}
          {historicalVersion && styleId && <button onClick={() => { setBusy(true); void api.restoreStyle(styleId, historicalVersion).then(onSaved).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "還原失敗")).finally(() => setBusy(false)); }}>以此版本建立最新版本</button>}
          {!readOnly && <button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? "儲存中…" : styleId ? "儲存新版本" : "建立風格"}</button>}
        </div>
      </div>
      <aside className="reference-panel">
        <div className="style-preview" style={cover ? { backgroundImage: `url(${styleAssetUrl(cover.id)})` } : undefined}><span>{cover ? "封面參考圖" : draft.name || "風格預覽"}</span></div>
        <div className="section-label">REFERENCE IMAGES · {draft.referenceImages.length}/4</div>
        {!readOnly && draft.referenceImages.length > 0 && <button className="analyze-style" disabled={busy} onClick={() => {
          setBusy(true); setError(undefined);
          void api.analyzeStyle(draft.referenceImages.map((item) => item.id)).then((suggestion) => {
            const shouldMerge = !draft.imageDirection && !draft.promptTemplate && draft.avoid.length === 0
              || confirm("AI 分析完成。要將建議合併到目前草稿嗎？現有文字會保留並附加建議。");
            if (shouldMerge) setDraft((value) => ({ ...value,
              imageDirection: [value.imageDirection, suggestion.imageDirection].filter(Boolean).join("\n\n"),
              promptTemplate: [value.promptTemplate, suggestion.promptTemplate].filter(Boolean).join("\n\n"),
              avoid: [...new Set([...value.avoid, ...suggestion.avoid])],
            }));
          }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "AI 分析失敗")).finally(() => setBusy(false));
        }}>{busy ? "AI 分析中…" : "AI 分析風格（不會自動儲存）"}</button>}
        {!readOnly && <label className={`upload-source ${draft.referenceImages.length >= 4 ? "disabled" : ""}`}>＋ 加入 PNG / JPG 參考圖<input disabled={draft.referenceImages.length >= 4} type="file" accept="image/png,image/jpeg" onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
          setBusy(true); void api.uploadStyleReference(file).then((reference) => setDraft((value) => ({
            ...value,
            referenceImages: [...value.referenceImages, reference],
            coverImageId: value.coverImageId ?? reference.id,
          }))).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "上傳失敗")).finally(() => setBusy(false));
        }} /></label>}
        <div className="reference-list">{draft.referenceImages.map((reference, index) => <article key={reference.id}>
          <img src={styleAssetUrl(reference.id)} alt={reference.name} /><div><strong>{reference.name}</strong><label><input disabled={readOnly} type="radio" checked={draft.coverImageId === reference.id} onChange={() => setDraft({ ...draft, coverImageId: reference.id })} />設為卡片封面</label></div>
          {!readOnly && <span><button onClick={() => move(index, -1)}>↑</button><button onClick={() => move(index, 1)}>↓</button><button onClick={() => {
            const referenceImages = draft.referenceImages.filter((item) => item.id !== reference.id);
            setDraft({
              ...draft,
              referenceImages,
              coverImageId: draft.coverImageId === reference.id ? referenceImages[0]?.id : draft.coverImageId,
            });
          }}>×</button></span>}
        </article>)}</div>
        {styleId && <div className="version-links"><strong>版本歷史</strong>{versions.map((item) => <a key={item.version} href={`/styles/${styleId}/versions/${item.version}`}>v{item.version} · {new Date(item.updatedAt).toLocaleString("zh-TW")}</a>)}</div>}
      </aside>
    </section>
    {error && <button className="toast error" onClick={() => setError(undefined)}>{error} ×</button>}
  </main>;
}

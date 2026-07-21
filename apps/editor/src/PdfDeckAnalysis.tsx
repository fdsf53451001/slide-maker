import { useEffect, useState } from "react";
import type { PresentationProject, SlideSpec, StylePreset } from "@slide-maker/core";
import { api, imageUrl } from "./api.js";

/** 風格分析一次最多餵 4 張圖（`/api/style-analysis` 的上限）。 */
export const MAX_ANALYSIS_PAGES = 4;

/**
 * 自動挑要送去分析的頁：第 1 頁（封面）、文字量最少的一頁（段落頁）、
 * 文字量中位數的兩頁（內頁）。
 */
export function pickAnalysisSlides(slides: readonly SlideSpec[]): string[] {
  if (!slides.length) return [];
  const chosen = [slides[0]!.id];
  const rest = slides
    .slice(1)
    .map((slide) => ({ id: slide.id, size: slide.content.trim().length }))
    .sort((left, right) => left.size - right.size || left.id.localeCompare(right.id));
  const sparsest = rest[0];
  if (sparsest) chosen.push(sparsest.id);
  const middle = rest.slice(1);
  const center = Math.floor(middle.length / 2);
  for (const candidate of [middle[center], middle[center - 1] ?? middle[center + 1]]) {
    if (!candidate || chosen.includes(candidate.id) || chosen.length >= MAX_ANALYSIS_PAGES)
      continue;
    chosen.push(candidate.id);
  }
  return chosen;
}

/**
 * PDF 匯入後的風格分析頁。這是**專案的一個狀態**（`workflowStage === "settings"`），
 * 不是前端暫存：重新整理會回到這裡，分析成功的結果寫在 `project.styleSnapshot` 上。
 *
 * 頁面上永遠有兩個出口：改用風格庫的風格、先用預設風格進編輯器。
 */
export function PdfDeckAnalysis({
  project,
  styles,
  onProject,
  onEnterEditor,
  onExit,
}: {
  project: PresentationProject;
  styles: StylePreset[];
  onProject: (project: PresentationProject) => void;
  onEnterEditor: (project: PresentationProject) => void;
  onExit: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => pickAnalysisSlides(project.slides));
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState<string>();
  const analysed = !!project.styleSnapshot.designSystem;
  // 分析用的頁面會留在 styleSnapshot.referenceImages 裡，之後這份簡報的每一次生圖
  // 都會附上它們（新頁面才跟原簡報視覺一致）。這是刻意的，但得讓使用者看得到。
  const attachedReferences = project.styleSnapshot.referenceImages.length;

  useEffect(() => {
    setSelected(pickAnalysisSlides(project.slides));
  }, [project.id]);

  const toggle = (slideId: string) =>
    setSelected((current) => {
      if (current.includes(slideId)) return current.filter((item) => item !== slideId);
      if (current.length >= MAX_ANALYSIS_PAGES) return current;
      return [...current, slideId];
    });

  const enterEditor = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onEnterEditor(await api.setWorkflowStage(project.id, "editing"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "進入編輯器失敗");
      setBusy(false);
    }
  };

  const useLibraryStyle = async (styleId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.applyStyle(project.id, styleId);
      onEnterEditor(await api.setWorkflowStage(project.id, "editing"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "套用風格失敗");
      setBusy(false);
    }
  };

  const analyse = async () => {
    if (!selected.length) return;
    setBusy(true);
    setError(undefined);
    try {
      setStep("模型正在分析這份簡報的視覺風格…");
      // 建參考圖 → 分析 → 寫回 styleSnapshot 是伺服器端的一筆交易：分析失敗
      // （被停用、模型交出空殼、逾時）不會在 styles/assets 下留沒有主的頁面圖。
      onProject(
        await api.analyseProjectStyle(project.id, selected, {
          ...(project.combinationId ? { combinationId: project.combinationId } : {}),
          name: `${project.name} 的風格`,
        }),
      );
      setStep("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "風格分析失敗");
      setStep("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="welcome dashboard pdf-analysis">
      <div className="dashboard-content">
        <section className="create-panel pdf-analysis-head">
          <div>
            <span className="section-label">PDF IMPORTED</span>
            <h1>{project.name}</h1>
            <p>
              已匯入 {project.slides.length} 頁。挑最多 {MAX_ANALYSIS_PAGES}{" "}
              頁做風格分析，之後新增的頁面就能沿用同一套視覺語言。
            </p>
          </div>
          <div className="pdf-analysis-actions">
            <button
              className="primary"
              disabled={busy || !selected.length}
              onClick={() => void analyse()}
            >
              {busy && step ? "分析中…" : analysed ? "重新分析風格" : "分析這份簡報的風格"}
            </button>
            <button disabled={busy} onClick={() => void enterEditor()}>
              {analysed ? "進入編輯器 →" : "先用預設風格進編輯器 →"}
            </button>
          </div>
        </section>

        {step && (
          <div className="pdf-analysis-status" role="status">
            {step}
          </div>
        )}
        {error && (
          <div className="pdf-modal-error" role="alert">
            {error}
            <button onClick={() => void analyse()} disabled={busy}>
              重試
            </button>
          </div>
        )}
        {analysed && !error && (
          <div className="pdf-analysis-status" role="status">
            風格分析完成，已套用到這份簡報。
            {attachedReferences > 0 &&
              ` 分析用的 ${attachedReferences} 張頁面也留作參考圖：之後在這份簡報生成的每一頁都會附上它們，新頁面才會跟原簡報看起來是同一份。`}
          </div>
        )}

        <section className="dashboard-section">
          <div className="dashboard-section-heading">
            <div>
              <span className="section-label">ANALYSIS PAGES</span>
              <h2>
                分析頁面 {selected.length}/{MAX_ANALYSIS_PAGES}
              </h2>
            </div>
            <span>點縮圖可改選。</span>
          </div>
          <div className="pdf-page-grid pdf-analysis-grid">
            {project.slides.map((slide) => {
              const version = slide.versions.find(
                (candidate) => candidate.id === slide.currentVersionId,
              );
              const chosen = selected.includes(slide.id);
              return (
                <button
                  key={slide.id}
                  type="button"
                  className={`pdf-page${chosen ? " chosen" : ""}`}
                  aria-pressed={chosen}
                  disabled={busy}
                  onClick={() => toggle(slide.id)}
                >
                  {version && (
                    <img
                      src={imageUrl(project.id, version.imagePath)}
                      alt={`第 ${slide.order + 1} 頁`}
                    />
                  )}
                  <span className="pdf-page-num">{slide.order + 1}</span>
                  {chosen && <span className="pdf-page-badge">✓</span>}
                </button>
              );
            })}
          </div>
        </section>

        <section className="dashboard-section">
          <div className="dashboard-section-heading">
            <div>
              <span className="section-label">OR PICK A STYLE</span>
              <h2>改用風格庫的風格</h2>
            </div>
            <button disabled={busy} onClick={onExit}>
              先回首頁
            </button>
          </div>
          <div className="style-quick-list">
            {styles.map((style) => (
              <button
                key={style.id}
                className="style-quick-card"
                disabled={busy}
                onClick={() => void useLibraryStyle(style.id)}
              >
                <span>
                  <b>{style.name.slice(0, 1)}</b>
                </span>
                <strong>{style.name}</strong>
                <small>套用並進入編輯器</small>
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

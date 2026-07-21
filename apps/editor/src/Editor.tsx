import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  EditableTextBox,
  PresentationBrief,
  PresentationProject,
  SlideSpec,
  SourceAsset,
  StylePreset,
} from "@slide-maker/core";
import {
  api,
  imageUrl,
  projectAssetUrl,
  styleAssetUrl,
  type ProviderReadiness,
  type ProviderSummary,
  type WebSearchResult,
} from "./api.js";
import { StyleEditor } from "./StyleEditor.js";
import { SourcePanel } from "./SourcePanel.js";
import { PdfDeckImportModal } from "./PdfDeckImportModal.js";
import { PdfDeckAnalysis } from "./PdfDeckAnalysis.js";
import { ModelLibrary } from "./ModelLibrary.js";
import { LibraryHeader } from "./LibraryHeader.js";
import { useSystemSettings, type SystemSettings } from "./systemSettings.js";
import { useOneTimeNotice } from "./oneTimeNotice.js";

type CombinationSummary = { id: string; name: string; isDefault: boolean; imageModelRef?: string };

const PHASE_LABELS: Record<string, string> = {
  queued: "等待排程",
  preparing: "準備資料",
  launching: "啟動 Codex",
  waiting_for_codex: "Codex 正在生成",
  validating_output: "驗證圖片",
  persisting: "保存版本",
  completed: "完成",
  failed: "失敗",
  cancelled: "已取消",
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function currentImage(project: PresentationProject, slide: SlideSpec): string | undefined {
  const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
  return version ? imageUrl(project.id, version.imagePath) : undefined;
}

/** 這個版本是不是 PDF 匯入落地的（原圖與可編輯文字兩個版本都算）。 */
function isPdfImportVersion(version?: {
  providerId?: string;
  parameters?: Record<string, unknown>;
}) {
  return version?.providerId === "pdf-import" && version.parameters?.pdfImport === true;
}

/** 這份專案是不是由 PDF 匯入建立的（決定 setup 階段要走分析頁而不是四步 wizard）。 */
function isPdfImportProject(project: PresentationProject): boolean {
  return project.slides.some((slide) =>
    slide.versions.some((version) => isPdfImportVersion(version)),
  );
}

/**
 * 風格下拉選單的選項。
 *
 * 專案自己的 styleSnapshot 不一定在風格庫清單裡（PDF 匯入分析出來的 `pdf-style-*`
 * 就不在），少了代表它的那個 option，`value` 會對不上任何選項，瀏覽器改為顯示
 * 第一個選項「AI 自由設計」——畫面上寫的風格與實際套用的不是同一個。
 */
function styleOptions(styles: StylePreset[], snapshot: StylePreset) {
  return (
    <>
      {!styles.some((style) => style.id === snapshot.id) && (
        <option value={snapshot.id}>{snapshot.name}（本專案專屬）</option>
      )}
      {styles.map((style) => (
        <option key={style.id} value={style.id}>
          {style.name} v{style.version}
        </option>
      ))}
    </>
  );
}

/**
 * 換風格前的確認。專案專屬的分析結果（PDF 匯入分析出來的 designSystem）被庫裡的
 * 風格蓋掉之後沒有復原路徑，所以只有這種情況會問；一般專案照舊直接套用。
 * 回傳 false 代表不要執行。
 */
function confirmStyleReplacement(
  styles: StylePreset[],
  snapshot: StylePreset,
  nextStyleId: string,
): boolean {
  if (nextStyleId === snapshot.id) return false;
  const projectLocal = !styles.some((style) => style.id === snapshot.id);
  if (!projectLocal || !snapshot.designSystem) return true;
  return confirm("這份簡報用的是從 PDF 分析出來的專屬風格，套用其他風格會覆蓋分析結果，確定繼續？");
}

const RESIZE_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

const TEXT_HISTORY_LIMIT = 60;

// 文字框陣列一律以不可變方式更新，歷史可直接存引用，不需深拷貝。
function pushHistory(history: EditableTextBox[][], boxes: EditableTextBox[]): EditableTextBox[][] {
  return [...history, boxes].slice(-TEXT_HISTORY_LIMIT);
}

export function SystemSettingsDialog({
  webSearchMode,
  onWebSearchMode,
  combinations,
  combinationId,
  onCombinationId,
  onOpenModelLibrary,
  onClose,
}: {
  webSearchMode: SystemSettings["webSearchMode"];
  onWebSearchMode: (value: SystemSettings["webSearchMode"]) => void;
  combinations: CombinationSummary[];
  combinationId: string | undefined;
  onCombinationId: (value: string) => void;
  onOpenModelLibrary: () => void;
  onClose: () => void;
}) {
  const defaultCombination = combinations.find((item) => item.isDefault);
  return (
    <div
      className="system-settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="系統設定"
      onClick={onClose}
    >
      <div className="system-settings-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="section-label">SYSTEM</span>
            <h2>系統設定</h2>
            <p>影像／文字／搜尋模型都由專案的模型組合決定。</p>
          </div>
          <button type="button" aria-label="關閉系統設定" onClick={onClose}>
            ×
          </button>
        </header>
        <label>
          專案模型組合
          <select
            value={combinationId ?? ""}
            disabled={combinations.length === 0}
            onChange={(event) => {
              if (event.target.value) onCombinationId(event.target.value);
            }}
          >
            <option value="">
              {`跟隨預設${defaultCombination ? `（${defaultCombination.name}）` : ""}`}
            </option>
            {combinations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.isDefault ? "（預設）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Web Search
          <select
            value={webSearchMode}
            onChange={(event) =>
              onWebSearchMode(event.target.value as SystemSettings["webSearchMode"])
            }
          >
            <option value="live">Live（即時搜尋）</option>
            <option value="cached">Cached</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <button type="button" className="system-settings-link" onClick={onOpenModelLibrary}>
          管理模型組合（模型庫）→
        </button>
      </div>
    </div>
  );
}

export function TextLayerCanvas({
  background,
  boxes,
  canvasWidth,
  canvasHeight,
  selectedId,
  onSelect,
  onChange,
}: {
  background: string;
  boxes: EditableTextBox[];
  canvasWidth: number;
  canvasHeight: number;
  selectedId: string | undefined;
  onSelect: (id?: string) => void;
  onChange: (boxes: EditableTextBox[]) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string>();
  // 拖曳期間的暫存框：只在放開時 commit 一次，避免每個 pointermove 都寫入 undo 歷史與觸發自動儲存。
  const [dragBoxes, setDragBoxes] = useState<EditableTextBox[]>();
  const drag = useRef<
    | {
        id: string;
        direction: "move" | (typeof RESIZE_DIRECTIONS)[number];
        x: number;
        y: number;
        clientX: number;
        clientY: number;
        box: EditableTextBox;
        moved?: boolean;
      }
    | undefined
  >(undefined);
  const point = (event: ReactPointerEvent) => {
    const bounds = stageRef.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) * canvasWidth) / bounds.width,
      y: ((event.clientY - bounds.top) * canvasHeight) / bounds.height,
    };
  };
  const begin = (
    event: ReactPointerEvent,
    box: EditableTextBox,
    direction: "move" | (typeof RESIZE_DIRECTIONS)[number],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const start = point(event);
    drag.current = {
      id: box.id,
      direction,
      x: start.x,
      y: start.y,
      clientX: event.clientX,
      clientY: event.clientY,
      box: structuredClone(box),
    };
    if (editingId !== box.id) setEditingId(undefined);
    onSelect(box.id);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic or already-ended pointers can reject capture; selection must still succeed.
    }
  };
  const move = (event: ReactPointerEvent) => {
    const active = drag.current;
    if (!active) return;
    // 死區用螢幕像素判斷（畫布座標會隨顯示尺寸縮放，雙擊間的手震在小視窗會誤觸拖曳）。
    if (
      active.direction === "move" &&
      !active.moved &&
      Math.hypot(event.clientX - active.clientX, event.clientY - active.clientY) < 3
    )
      return;
    active.moved = true;
    const current = point(event);
    const dx = current.x - active.x;
    const dy = current.y - active.y;
    let { x, y, width, height } = active.box;
    if (active.direction === "move") {
      x += dx;
      y += dy;
    } else {
      if (active.direction.includes("e")) width += dx;
      if (active.direction.includes("s")) height += dy;
      if (active.direction.includes("w")) {
        x += dx;
        width -= dx;
      }
      if (active.direction.includes("n")) {
        y += dy;
        height -= dy;
      }
    }
    width = Math.max(24, width);
    height = Math.max(18, height);
    x = Math.max(0, Math.min(canvasWidth - width, x));
    y = Math.max(0, Math.min(canvasHeight - height, y));
    setDragBoxes(
      boxes.map((box) => (box.id === active.id ? { ...box, x, y, width, height } : box)),
    );
  };
  const finish = (commit: boolean) => {
    if (commit && drag.current?.moved && dragBoxes) onChange(dragBoxes);
    drag.current = undefined;
    setDragBoxes(undefined);
  };
  return (
    <div
      ref={stageRef}
      className="text-layer-canvas"
      onPointerMove={move}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onPointerDown={() => {
        setEditingId(undefined);
        onSelect(undefined);
      }}
    >
      <img src={background} alt="文字抽離乾淨背景" />
      {(dragBoxes ?? boxes)
        .filter((box) => box.role === "presentation")
        .map((box) => {
          const lineCount = Math.max(1, box.text.split("\n").length);
          const textHeight = box.fontSize * box.lineHeight * lineCount;
          const spareHeight = Math.max(0, box.height - textHeight);
          const verticalOffset =
            box.verticalAlign === "bottom"
              ? spareHeight
              : box.verticalAlign === "middle"
                ? spareHeight / 2
                : 0;
          const editing = editingId === box.id && selectedId === box.id;
          return (
            <div
              key={box.id}
              className={`editable-text-box ${selectedId === box.id ? "selected" : ""} ${editing ? "editing" : ""}`}
              style={{
                left: `${(box.x / canvasWidth) * 100}%`,
                top: `${(box.y / canvasHeight) * 100}%`,
                width: `${(box.width / canvasWidth) * 100}%`,
                height: `${(box.height / canvasHeight) * 100}%`,
                transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
              }}
              onPointerDown={(event) => {
                if (editing) {
                  event.stopPropagation();
                  return;
                }
                begin(event, box, "move");
              }}
              onDoubleClick={(event) => {
                setEditingId(box.id);
                onSelect(box.id);
                event.currentTarget.querySelector("textarea")?.focus();
              }}
            >
              <textarea
                aria-label="可編輯簡報文字"
                readOnly={!editing}
                value={box.text}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  setEditingId(undefined);
                  event.currentTarget.blur();
                }}
                onChange={(event) =>
                  onChange(
                    boxes.map((candidate) =>
                      candidate.id === box.id
                        ? { ...candidate, text: event.target.value }
                        : candidate,
                    ),
                  )
                }
                style={{
                  fontFamily: box.fontFamily,
                  fontSize: `${(box.fontSize / canvasHeight) * 100}cqh`,
                  fontWeight: box.fontWeight,
                  color: box.color,
                  caretColor: box.color,
                  opacity: box.opacity,
                  lineHeight: box.lineHeight,
                  letterSpacing: `${box.letterSpacing}px`,
                  textAlign: box.align,
                  paddingTop: `${(verticalOffset / canvasHeight) * 100}cqh`,
                  // 伺服器 SVG 匯出不會在框邊裁字；非編輯狀態放大顯示區，
                  // 讓超出框的文字照樣顯示，與最終合成結果一致。
                  // 編輯中維持框尺寸，避免放大的透明區攔截畫布點擊。
                  ...(editing
                    ? {}
                    : {
                        width: "400%",
                        height: "400%",
                        ...(box.align === "center"
                          ? { left: "-150%" }
                          : box.align === "right"
                            ? { left: "auto", right: 0 }
                            : {}),
                      }),
                }}
              />
              {selectedId === box.id &&
                !editing &&
                RESIZE_DIRECTIONS.map((direction) => (
                  <button
                    key={direction}
                    aria-label={`調整文字框 ${direction}`}
                    className={`text-resize-handle ${direction}`}
                    onPointerDown={(event) => begin(event, box, direction)}
                    onDoubleClick={(event) => event.stopPropagation()}
                  />
                ))}
            </div>
          );
        })}
    </div>
  );
}

function ImageEditDialog({
  image,
  busy,
  supportsMask,
  onCancel,
  onSubmit,
}: {
  image: string;
  busy: boolean;
  supportsMask: boolean;
  onCancel: () => void;
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    return {
      x: Math.max(
        0,
        Math.min(canvas.width, ((event.clientX - bounds.left) * canvas.width) / bounds.width),
      ),
      y: Math.max(
        0,
        Math.min(canvas.height, ((event.clientY - bounds.top) * canvas.height) / bounds.height),
      ),
    };
  };
  const drawSelection = (start: MaskPoint, end: MaskPoint): MaskSelection | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rectangle = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    setSelection(rectangle);
    return rectangle;
  };
  const beginSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!maskEnabled) return;
    const point = canvasPoint(event);
    if (!point) return;
    dragStart.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawSelection(point, point);
  };
  const moveSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragStart.current) return;
    const point = canvasPoint(event);
    if (point) drawSelection(dragStart.current, point);
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
  return (
    <div
      className="image-edit-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="編輯當頁圖片"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <form
        className="image-edit-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!instruction.trim()) return;
          onSubmit(
            instruction.trim(),
            maskEnabled && selection ? canvasRef.current?.toDataURL("image/png") : undefined,
          );
        }}
      >
        <header>
          <div>
            <span className="section-label">EDIT CURRENT IMAGE</span>
            <h2>修改當頁圖片</h2>
            <p>以目前版本為基礎修改，不會覆蓋舊版本。</p>
          </div>
          <button type="button" aria-label="關閉圖片編輯" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <div className={`image-mask-stage ${maskEnabled ? "masking" : ""}`}>
          <img src={image} alt="目前頁面圖片" />
          <canvas
            ref={canvasRef}
            width={960}
            height={540}
            aria-label="圖片修改範圍"
            onPointerDown={beginSelection}
            onPointerMove={moveSelection}
            onPointerUp={finishSelection}
            onPointerCancel={clearMask}
          />
          {maskEnabled && selection && (
            <div
              className="mask-selection-box"
              style={{
                left: `${selection.x / 9.6}%`,
                top: `${selection.y / 5.4}%`,
                width: `${selection.width / 9.6}%`,
                height: `${selection.height / 5.4}%`,
              }}
            />
          )}
          {maskEnabled && !selection && <span>拖曳框選要修改的區域</span>}
        </div>
        <label className="image-edit-instruction">
          修改說明
          <textarea
            aria-label="圖片修改說明"
            rows={3}
            autoFocus
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：只把右上角的機器人改成女性工程師，其他文字與排版保持不變"
          />
        </label>
        <div className="mask-controls">
          <label>
            <input
              type="checkbox"
              checked={maskEnabled}
              disabled={!supportsMask}
              onChange={(event) => {
                setMaskEnabled(event.target.checked);
                if (!event.target.checked) clearMask();
              }}
            />
            限制修改範圍（框選）
          </label>
          {supportsMask ? (
            <>
              <small>{selection ? "可直接拖曳重選範圍" : "框內可修改，框外保留原圖"}</small>
              <button type="button" disabled={!selection} onClick={clearMask}>
                清除框選
              </button>
            </>
          ) : (
            <small>目前 Provider 不支援範圍編輯</small>
          )}
        </div>
        <div className="image-edit-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !instruction.trim() || (maskEnabled && !selection)}
          >
            {busy ? "正在建立圖片編輯工作…" : "套用修改 →"}
          </button>
        </div>
      </form>
    </div>
  );
}

function CreateProject({
  projects,
  styles,
  styleLibrary,
  onOpen,
  onCreate,
  onNavigate,
  onDelete,
  onImportNotice,
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
}) {
  const [importing, setImporting] = useState(false);
  const [topic, setTopic] = useState("");
  const [selectedStyleId, setSelectedStyleId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("style") ?? undefined,
  );
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PresentationProject | undefined>();
  const [deleting, setDeleting] = useState(false);
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

            {/* 匯入 PDF 與「建立簡報」地位對等：不進四步 wizard，選頁後專案立刻落地。 */}
            <section className="dashboard-section import-panel">
              <div>
                <span className="section-label">IMPORT</span>
                <h2>已經有 PDF 了？</h2>
                <p>把既有的 16:9 簡報 PDF 匯入成專案，每頁保留原圖，之後可逐頁編輯文字。</p>
              </div>
              <button className="primary" onClick={() => setImporting(true)}>
                匯入 PDF
              </button>
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
                <span>{projects.length} 份簡報</span>
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
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>刪除簡報</h2>
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

function SetupFlow({
  project,
  providers,
  styles,
  acceptUnknownReadiness,
  onAcceptUnknownReadiness,
  onProject,
  onExit,
  onError,
}: {
  project: PresentationProject;
  providers: ProviderSummary[];
  styles: StylePreset[];
  acceptUnknownReadiness: boolean;
  onAcceptUnknownReadiness: (value: boolean) => void;
  onProject: (value: PresentationProject) => void;
  onExit: () => void;
  onError: (message: string) => void;
}) {
  const [brief, setBrief] = useState(() => structuredClone(project.brief));
  const [outline, setOutline] = useState(() => structuredClone(project.slides));
  const [busy, setBusy] = useState(false);
  const [showRequirements, setShowRequirements] = useState(
    project.workflowStage === "requirements",
  );
  // requirements 階段拆成兩個客戶端子步驟：false=填需求（brief），true=上傳素材。
  // 素材上傳後才產大綱，讓大綱一開始就被素材 grounding。
  const [materialsSubstep, setMaterialsSubstep] = useState(false);
  const providerRef = useRef<HTMLElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const systemSettings = useSystemSettings();
  const [combinations, setCombinations] = useState<
    { id: string; name: string; isDefault: boolean; imageModelRef?: string }[]
  >([]);
  // 生成流程改為「選組合」：影像 provider 由組合（或預設組合）解析，不再單獨選 provider。
  const defaultImageRef = combinations.find((item) => item.isDefault)?.imageModelRef;
  const boundCombination = combinations.find((item) => item.id === project.combinationId);
  const effectiveImageProviderId =
    boundCombination?.imageModelRef ?? defaultImageRef ?? "mock-image";
  const effectiveImageProvider = providers.find(
    (candidate) => candidate.id === effectiveImageProviderId,
  );
  // readiness 追蹤「實際會用到的影像 provider」（由組合解析），不是舊的 system providerId。
  const [readiness, setReadiness] = useState<ProviderReadiness>();
  const [readinessBusy, setReadinessBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setReadiness(undefined);
    setReadinessBusy(true);
    void api
      .readiness(effectiveImageProviderId)
      .then((value) => {
        if (alive) setReadiness(value);
      })
      .catch(() => {
        if (alive) setReadiness(undefined);
      })
      .finally(() => {
        if (alive) setReadinessBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [effectiveImageProviderId]);
  // 生成前先檢查影像模型能力 vs 風格參考圖，讓衝突在此步就顯示、而非生成時才報錯。
  const styleRefCount = project.styleSnapshot.referenceImages.length;
  const referenceIssue =
    effectiveImageProvider &&
    styleRefCount > 0 &&
    !effectiveImageProvider.capabilities.referenceImages
      ? "此組合的影像模型不支援參考圖。請改用支援參考圖的影像模型（OpenAI 影像 API 設為 chat），或移除風格的參考圖。"
      : effectiveImageProvider &&
          styleRefCount > 1 &&
          !effectiveImageProvider.capabilities.multipleReferenceImages
        ? "此組合的影像模型只支援單張參考圖。請把風格的參考圖減到 1 張，或改用支援多張參考圖的影像模型。"
        : undefined;

  useEffect(() => {
    void api
      .modelLibrary()
      .then((library) =>
        setCombinations(
          library.combinations.map((combination) => ({
            id: combination.id,
            name: combination.name,
            isDefault: combination.id === library.defaultCombinationId,
            ...(combination.imageModelRef ? { imageModelRef: combination.imageModelRef } : {}),
          })),
        ),
      )
      .catch(() => setCombinations([]));
  }, []);
  useEffect(() => {
    setBrief(structuredClone(project.brief));
  }, [project.id, project.brief]);
  useEffect(() => {
    setOutline(structuredClone(project.slides));
  }, [project.id, project.workflowStage]);
  useEffect(() => {
    if (project.workflowStage === "requirements") setShowRequirements(true);
  }, [project.id, project.workflowStage]);

  const produceOutline = async () => {
    setBusy(true);
    onError("");
    try {
      const withBrief = await api.updateBrief(project.id, brief);
      onProject(withBrief);
      // 文字模型由專案組合決定（server 端解析），前端不再傳 textEngine。
      const withOutline = await api.regenerateOutline(project.id, true);
      onProject(withOutline);
      // 明確以新大綱同步 outline：若是「返回修改需求」後再生成，workflowStage 仍是
      // "settings" 不變，倚賴 workflowStage 變化的同步 effect 不會觸發，會殘留舊 slide id
      // 導致確認生成時 updateSlide 打到不存在的頁面（NOT_FOUND）。
      setOutline(structuredClone(withOutline.slides));
      setShowRequirements(false);
      setMaterialsSubstep(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "產生大綱失敗");
    } finally {
      setBusy(false);
    }
  };

  const confirmAndGenerate = async () => {
    setBusy(true);
    onError("");
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
      if (referenceIssue) throw new Error(referenceIssue);
      const currentReadiness = await api.readiness(effectiveImageProviderId);
      if (
        currentReadiness.blocking ||
        (currentReadiness.requiresAcknowledgement && !acceptUnknownReadiness)
      ) {
        throw new Error(currentReadiness.message);
      }
      // 不傳 providerId：server 依專案組合（或預設組合）解析影像模型。
      await api.generateAll(project.id, undefined, acceptUnknownReadiness);
      onProject(await api.getProject(project.id));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "生成簡報失敗");
    } finally {
      setBusy(false);
    }
  };

  const requirementsStep = project.workflowStage === "requirements" || showRequirements;
  // 進度列可回跳：已產生過大綱（outlineExists）後任一步都能點回去改，否則只能點到目前步驟為止。
  const outlineExists = project.slides.length > 0;
  const currentStep = !requirementsStep ? 4 : materialsSubstep ? 3 : 2;
  const stepClickable = (step: number) => step === 1 || step <= currentStep || outlineExists;
  const goToStep = (step: number) => {
    if (step === 1) {
      providerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (step === 2) {
      setShowRequirements(true);
      setMaterialsSubstep(false);
    } else if (step === 3) {
      setShowRequirements(true);
      setMaterialsSubstep(true);
    } else if (step === 4 && outlineExists) {
      setShowRequirements(false);
    }
  };
  return (
    <main className="setup-page">
      <header className="setup-header">
        <button className="brand" onClick={onExit}>
          SM<span>↗</span>
        </button>
        <div>
          <strong>{project.name}</strong>
          <small>四步完成整份簡報</small>
        </div>
      </header>
      <div className="setup-steps" aria-label="建立簡報流程">
        {[
          { step: 1, label: "選擇模型" },
          { step: 2, label: "需求" },
          { step: 3, label: "上傳素材" },
          { step: 4, label: "確認生成" },
        ].map(({ step, label }, index) => (
          <Fragment key={step}>
            {index > 0 && <i />}
            <button
              type="button"
              className={step === currentStep ? "active" : step < currentStep ? "done" : ""}
              disabled={busy || !stepClickable(step)}
              aria-current={step === currentStep ? "step" : undefined}
              onClick={() => goToStep(step)}
            >
              <b>{step}</b>
              <span>{label}</span>
            </button>
          </Fragment>
        ))}
      </div>
      <section className="setup-card setup-provider" aria-label="選擇模型組合" ref={providerRef}>
        <div className="section-label">STEP 1 · 選擇模型組合</div>
        <p>影像／文字／搜尋模型都由組合決定。要調整或新增組合，請到模型庫。</p>
        <div className="setup-grid">
          <label>
            專案模型組合
            <select
              value={project.combinationId ?? ""}
              disabled={combinations.length === 0}
              onChange={(event) => {
                const combinationId = event.target.value;
                if (!combinationId) return;
                void api
                  .setProjectCombination(project.id, combinationId)
                  .then(onProject)
                  .catch((reason: unknown) =>
                    onError(reason instanceof Error ? reason.message : "設定組合失敗"),
                  );
              }}
            >
              <option value="">
                {`跟隨預設${
                  combinations.find((item) => item.isDefault)
                    ? `（${combinations.find((item) => item.isDefault)!.name}）`
                    : ""
                }`}
              </option>
              {combinations.map((combination) => (
                <option key={combination.id} value={combination.id}>
                  {combination.name}
                  {combination.isDefault ? "（預設）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Web Search
            <select
              value={systemSettings.webSearchMode}
              onChange={(event) =>
                systemSettings.setWebSearchMode(
                  event.target.value as SystemSettings["webSearchMode"],
                )
              }
            >
              <option value="live">Live（即時搜尋）</option>
              <option value="cached">Cached</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
        </div>
        {effectiveImageProviderId === "mock-image" && (
          <p className="setup-provider-hint">
            此組合的影像模型是
            Mock（不消耗配額、非真實生成）。要用真實模型出圖，請到模型庫調整組合。
          </p>
        )}
        {referenceIssue && <p className="provider-note">{referenceIssue}</p>}
      </section>
      {requirementsStep ? (
        materialsSubstep ? (
          <section className="setup-card setup-materials">
            <div className="section-label">STEP 3 · 上傳素材</div>
            <h1>上傳生成會用到的素材</h1>
            <p>
              文件、圖片、貼上文字或加入搜尋資料都會建立索引；產生大綱與後續生成時即可引用。這一步可略過。
            </p>
            <SourcePanel project={project} onProject={onProject} onError={onError} />
            <div className="setup-materials-actions">
              <button
                type="button"
                className="setup-back"
                disabled={busy}
                onClick={() => setMaterialsSubstep(false)}
              >
                <span>←</span> 上一步
              </button>
              <button
                className="primary setup-submit"
                disabled={busy || !brief.topic.trim()}
                onClick={() => void produceOutline()}
              >
                {busy ? "正在產生大綱…" : `產生 ${brief.desiredSlideCount} 頁大綱`}
                <span>→</span>
              </button>
            </div>
          </section>
        ) : (
          <section className="setup-card">
            <div className="section-label">STEP 2 · 需求</div>
            <h1>先確認這份簡報要說什麼</h1>
            <p>系統會依下列需求建立大綱；頁數以這裡確認的數字為準。</p>
            <div className="setup-grid">
              <label className="wide">
                簡報需求
                <textarea
                  rows={4}
                  value={brief.topic}
                  onChange={(event) => setBrief({ ...brief, topic: event.target.value })}
                />
              </label>
              <label>
                目標觀眾
                <input
                  value={brief.audience}
                  onChange={(event) => setBrief({ ...brief, audience: event.target.value })}
                />
              </label>
              <label>
                簡報目的
                <input
                  value={brief.purpose}
                  onChange={(event) => setBrief({ ...brief, purpose: event.target.value })}
                />
              </label>
              <label>
                頁數
                <input
                  aria-label="簡報頁數"
                  type="number"
                  min={1}
                  max={100}
                  value={brief.desiredSlideCount}
                  onChange={(event) =>
                    setBrief({ ...brief, desiredSlideCount: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                語言
                <input
                  value={brief.language}
                  onChange={(event) => setBrief({ ...brief, language: event.target.value })}
                />
              </label>
              <label>
                語氣
                <input
                  value={brief.tone}
                  onChange={(event) => setBrief({ ...brief, tone: event.target.value })}
                />
              </label>
              <label>
                演講時間（分鐘）
                <input
                  type="number"
                  min={1}
                  value={brief.durationMinutes ?? ""}
                  onChange={(event) =>
                    setBrief({
                      ...brief,
                      durationMinutes: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </label>
            </div>
            <button
              className="primary setup-submit"
              disabled={
                busy ||
                !brief.topic.trim() ||
                brief.desiredSlideCount < 1 ||
                brief.desiredSlideCount > 100
              }
              onClick={() => {
                void api
                  .updateBrief(project.id, brief)
                  .then(onProject)
                  .catch(() => undefined);
                setMaterialsSubstep(true);
              }}
            >
              下一步：上傳素材
              <span>→</span>
            </button>
          </section>
        )
      ) : (
        <section className="setup-card setup-settings">
          <header className="setup-settings-header">
            <div>
              <div className="section-label">STEP 4 · 確認大綱與生成設定</div>
              <h1>確認大綱與生成設定</h1>
              <p>逐頁檢查內容與敘事，確認後會立即排程全部 {outline.length} 頁。</p>
            </div>
            <div className="outline-count" aria-label={`共 ${outline.length} 頁`}>
              <strong>{outline.length}</strong>
              <span>頁簡報</span>
            </div>
          </header>
          {project.outlineRationale && (
            <div className="outline-rationale">
              <strong>AI 頁數與敘事說明</strong>
              <p>{project.outlineRationale}</p>
            </div>
          )}
          <div className="outline-review">
            {outline.map((slide, index) => (
              <article key={slide.id}>
                <div className="outline-card-header">
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <span>第 {index + 1} 頁</span>
                  <div className="outline-actions" aria-label={`第 ${index + 1} 頁操作`}>
                    <button
                      aria-label="往上移動"
                      title="往上移動"
                      disabled={busy || index === 0}
                      onClick={() => {
                        const ids = outline.map((item) => item.id);
                        [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                        setBusy(true);
                        void api
                          .reorderSlides(project.id, ids)
                          .then((updated) => {
                            onProject(updated);
                            setOutline(structuredClone(updated.slides));
                          })
                          .catch((reason: unknown) =>
                            onError(reason instanceof Error ? reason.message : "排序失敗"),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      ↑
                    </button>
                    <button
                      aria-label="往下移動"
                      title="往下移動"
                      disabled={busy || index === outline.length - 1}
                      onClick={() => {
                        const ids = outline.map((item) => item.id);
                        [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
                        setBusy(true);
                        void api
                          .reorderSlides(project.id, ids)
                          .then((updated) => {
                            onProject(updated);
                            setOutline(structuredClone(updated.slides));
                          })
                          .catch((reason: unknown) =>
                            onError(reason instanceof Error ? reason.message : "排序失敗"),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      ↓
                    </button>
                    <button
                      className="outline-delete"
                      disabled={busy || outline.length === 1}
                      onClick={() => {
                        setBusy(true);
                        void api
                          .deleteSlide(project.id, slide.id)
                          .then((updated) => {
                            onProject(updated);
                            setOutline(structuredClone(updated.slides));
                          })
                          .catch((reason: unknown) =>
                            onError(reason instanceof Error ? reason.message : "刪除失敗"),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      刪除
                    </button>
                  </div>
                </div>
                <div className="outline-fields">
                  <label className="outline-purpose">
                    頁面目的
                    <input
                      value={slide.purpose}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id ? { ...item, purpose: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="outline-content">
                    頁面內容
                    <textarea
                      rows={2}
                      value={slide.content}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id ? { ...item, content: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    敘事
                    <textarea
                      rows={2}
                      value={slide.narrative}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id
                              ? { ...item, narrative: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    構圖
                    <textarea
                      rows={2}
                      value={slide.layoutHint}
                      onChange={(event) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id
                              ? { ...item, layoutHint: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  {project.sources.length > 0 && (
                    <div className="outline-sources">
                      <span className="outline-sources-label">
                        來源 · 已選 {slide.sourceIds.length}/{project.sources.length}
                      </span>
                      <div className="outline-source-chips">
                        {project.sources.map((source) => {
                          const checked = slide.sourceIds.includes(source.id);
                          return (
                            <label
                              key={source.id}
                              className={`source-chip${checked ? " selected" : ""}`}
                              title={source.name}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  setOutline(
                                    outline.map((item) =>
                                      item.id === slide.id
                                        ? {
                                            ...item,
                                            sourceIds: event.target.checked
                                              ? [...item.sourceIds, source.id]
                                              : item.sourceIds.filter((id) => id !== source.id),
                                          }
                                        : item,
                                    ),
                                  )
                                }
                              />
                              <span className="source-chip-check" aria-hidden="true">
                                ✓
                              </span>
                              <span className="source-chip-name">{source.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          <button
            className="add-outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onError("");
              const last = outline.at(-1)?.id;
              void api
                .addSlide(project.id, last ? { afterSlideId: last } : {})
                .then((updated) => {
                  onProject(updated);
                  setOutline(structuredClone(updated.slides));
                })
                .catch((reason: unknown) =>
                  onError(reason instanceof Error ? reason.message : "新增頁面失敗"),
                )
                .finally(() => setBusy(false));
            }}
          >
            ＋ 新增一頁
          </button>
          <div className="generation-panel">
            <div className="generation-panel-copy">
              <span className="section-label">FINAL CHECK</span>
              <strong>準備生成 {outline.length} 頁簡報</strong>
              <p>選擇視覺風格後，即可建立全部頁面的生成工作。</p>
            </div>
            <div className="generation-settings">
              <label>
                簡報風格
                <select
                  value={project.styleSnapshot.id}
                  onChange={(event) => {
                    if (!confirmStyleReplacement(styles, project.styleSnapshot, event.target.value))
                      return;
                    setBusy(true);
                    void api
                      .applyStyle(project.id, event.target.value)
                      .then(onProject)
                      .catch((reason: unknown) =>
                        onError(reason instanceof Error ? reason.message : "套用風格失敗"),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  {styleOptions(styles, project.styleSnapshot)}
                </select>
              </label>
            </div>
          </div>
          {effectiveImageProvider?.availability.status === "unavailable" && (
            <div className="provider-note">{effectiveImageProvider.availability.reason}</div>
          )}
          {effectiveImageProvider?.availability.status === "available" &&
            effectiveImageProvider.availability.warning && (
              <div className="provider-warning">
                ⚠ {effectiveImageProvider.availability.warning}
              </div>
            )}
          {readinessBusy && (
            <div className="provider-note" role="status">
              正在檢查 provider readiness…
            </div>
          )}
          {readiness && readiness.status !== "ready" && (
            <div
              className={readiness.blocking ? "provider-note" : "provider-warning"}
              role="status"
            >
              {readiness.status === "ready_experimental" ? "⚠ " : ""}
              {readiness.message}
            </div>
          )}
          {readiness?.requiresAcknowledgement && (
            <label className="readiness-ack">
              <input
                type="checkbox"
                checked={acceptUnknownReadiness}
                onChange={(event) => onAcceptUnknownReadiness(event.target.checked)}
              />
              我了解 readiness 無法確認，仍要嘗試生成
            </label>
          )}
          <div className="setup-actions">
            <button onClick={() => setShowRequirements(true)} disabled={busy}>
              返回修改需求
            </button>
            <button
              className="primary"
              onClick={() => void confirmAndGenerate()}
              disabled={
                busy ||
                outline.length === 0 ||
                !!referenceIssue ||
                effectiveImageProvider?.availability.status !== "available" ||
                readinessBusy ||
                !readiness ||
                readiness.blocking ||
                (readiness.requiresAcknowledgement && !acceptUnknownReadiness)
              }
            >
              {busy ? "正在建立生成工作…" : `確認設定並生成 ${outline.length} 頁簡報`}
              <span>→</span>
            </button>
          </div>
        </section>
      )}
    </main>
  );
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
  const system = useSystemSettings();
  const webSearchMode = system.webSearchMode;
  const [showSystemSettings, setShowSystemSettings] = useState(false);
  // 影像 provider 由專案綁定的組合（或模型庫預設組合）解析，不再用 localStorage 的 providerId。
  const [combinations, setCombinations] = useState<
    { id: string; name: string; isDefault: boolean; imageModelRef?: string }[]
  >([]);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [readiness, setReadiness] = useState<ProviderReadiness>();
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [acceptUnknownReadiness, setAcceptUnknownReadiness] = useState(false);
  const [error, setError] = useState<string>();
  /**
   * PDF 匯入的略過／失敗頁碼。必須放在 `Editor` 這一層：匯入成功會立刻開啟專案，
   * `CreateProject` 當場 unmount，報告放在它裡面等於一次都不會被看到。
   */
  const [importNotice, setImportNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [presentationIndex, setPresentationIndex] = useState<number | null>(null);
  const [stylePickerVersion, setStylePickerVersion] = useState<{
    slideId: string;
    versionId: string;
  }>();
  const [stylePickerBusy, setStylePickerBusy] = useState(false);
  const [newSlideBusy, setNewSlideBusy] = useState(false);
  const [showImageEdit, setShowImageEdit] = useState(false);
  const [imageEditBusy, setImageEditBusy] = useState(false);
  const [previewVersionId, setPreviewVersionId] = useState<string>();
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [textBoxes, setTextBoxes] = useState<EditableTextBox[]>([]);
  // 使用者是否編輯過目前版本的文字圖層；未編輯前自動儲存不得寫回伺服器（見自動儲存 effect）。
  const textDirty = useRef(false);
  const [selectedTextId, setSelectedTextId] = useState<string>();
  const [textThreshold, setTextThreshold] = useState(0.75);
  const [showTextThreshold, setShowTextThreshold] = useState(false);
  const [textLayerBusy, setTextLayerBusy] = useState(false);
  const [textUndo, setTextUndo] = useState<EditableTextBox[][]>([]);
  const [textRedo, setTextRedo] = useState<EditableTextBox[][]>([]);
  // 縮圖列容器：切換投影片時把選取項捲進可視範圍。
  const railRef = useRef<HTMLDivElement>(null);
  // 編輯區滾輪切換頁面的冷卻時間戳，避免慣性滾動一次跳好幾頁。
  const wheelCooldown = useRef(0);

  const navigate = (path: string) => {
    window.history.pushState({}, "", path);
    setRoute(new URL(path, window.location.origin).pathname);
  };
  useEffect(() => {
    const pop = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    void Promise.all([api.listProjects(), api.providers(), api.styles()])
      .then(([projectList, providerList, styleList]) => {
        setProjects(projectList);
        setProviders(providerList);
        setStyles(styleList);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "載入失敗"));
  }, []);
  useEffect(() => {
    if (!project) return;
    setProjects((current) => [
      project,
      ...current.filter((candidate) => candidate.id !== project.id),
    ]);
  }, [project]);
  useEffect(() => {
    const match = /^\/projects\/([a-zA-Z0-9_-]+)$/.exec(route);
    if (!match) return;
    const found = projects.find((item) => item.id === match[1]);
    if (found && found.id !== project?.id) {
      setProject(found);
      setSelectedId(found.slides[0]?.id);
    }
  }, [route, projects, project?.id]);
  useEffect(() => {
    void api
      .modelLibrary()
      .then((library) =>
        setCombinations(
          library.combinations.map((combination) => ({
            id: combination.id,
            name: combination.name,
            isDefault: combination.id === library.defaultCombinationId,
            ...(combination.imageModelRef ? { imageModelRef: combination.imageModelRef } : {}),
          })),
        ),
      )
      .catch(() => setCombinations([]));
  }, []);
  // 影像 provider 由組合（或預設組合）解析；generate 時不再傳 providerId，但 readiness 需先查。
  const defaultImageRef = combinations.find((item) => item.isDefault)?.imageModelRef;
  const boundCombination = combinations.find((item) => item.id === project?.combinationId);
  const effectiveImageProviderId =
    boundCombination?.imageModelRef ?? defaultImageRef ?? "mock-image";
  useEffect(() => {
    let current = true;
    setReadiness(undefined);
    setAcceptUnknownReadiness(false);
    setReadinessBusy(true);
    void api
      .readiness(effectiveImageProviderId)
      .then((value) => {
        if (current) setReadiness(value);
      })
      .catch((reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : "Provider readiness 檢查失敗");
      })
      .finally(() => {
        if (current) setReadinessBusy(false);
      });
    return () => {
      current = false;
    };
  }, [effectiveImageProviderId]);

  const selected = project?.slides.find((slide) => slide.id === selectedId) ?? project?.slides[0];
  // 編輯區滾輪：向下捲切到下一頁、向上捲切到上一頁；用冷卻節流避免慣性滾動連跳。
  const handleStageWheel = (event: ReactWheelEvent) => {
    const slides = project?.slides;
    if (!slides || slides.length < 2 || presentationIndex !== null) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const nowMs = Date.now();
    if (nowMs - wheelCooldown.current < 320) return;
    const currentIndex = Math.max(
      0,
      slides.findIndex((slide) => slide.id === selected?.id),
    );
    const nextIndex =
      event.deltaY > 0
        ? Math.min(slides.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1);
    if (nextIndex === currentIndex) return;
    wheelCooldown.current = nowMs;
    setSelectedId(slides[nextIndex]?.id);
    setPanel("slide");
  };
  const selectedVersion = selected?.versions.find(
    (version) => version.id === selected.currentVersionId,
  );
  const previewVersion = selected?.versions.find(
    (version) => version.id === previewVersionId && version.id !== selected.currentVersionId,
  );
  const provider = providers.find((candidate) => candidate.id === effectiveImageProviderId);
  const activeJob = project?.jobs.find(
    (job) => job.slideId === selected?.id && (job.status === "queued" || job.status === "running"),
  );
  // 生成中或預覽歷史版本時不可互動編輯文字圖層，避免完成瞬間覆蓋掉未儲存的編輯。
  const activeTextLayer = previewVersion || activeJob ? undefined : selectedVersion?.textLayer;
  const textEditing = !!activeTextLayer;
  /**
   * PDF 匯入的「可編輯文字」版本要提示一次系統字型重繪：`pdf-text-layer.ts` 把 PDF
   * 內嵌字型收斂成 Arial／Times New Roman／Courier New（那些字型在瀏覽器與伺服器都
   * 不存在，必然 fallback），所以切到這個版本整頁字型會肉眼可見地改變。不解釋的話
   * 使用者只會覺得「這一頁壞了」。
   */
  const pdfFontNotice = useOneTimeNotice("pdf-import-text-layer-font");
  const showPdfFontNotice =
    !!activeTextLayer && isPdfImportVersion(selectedVersion) && pdfFontNotice.pending;
  const lastJob = useMemo(
    () => project?.jobs.filter((job) => job.slideId === selected?.id).at(-1),
    [project?.jobs, selected?.id],
  );
  const elapsedMs = activeJob ? now - Date.parse(activeJob.startedAt ?? activeJob.createdAt) : 0;
  const remainingMs =
    activeJob?.timeoutMs && activeJob.startedAt
      ? Math.max(0, activeJob.timeoutMs - elapsedMs)
      : undefined;

  useEffect(() => {
    if (selected) setDraft(structuredClone(selected));
    setPreviewVersionId(undefined);
  }, [selected?.id]);
  useEffect(() => {
    setSelectedTextId(undefined);
    setTextUndo([]);
    setTextRedo([]);
    textDirty.current = false;
    setTextBoxes(structuredClone(selectedVersion?.textLayer?.boxes ?? []));
    setTextThreshold(selectedVersion?.textLayer?.threshold ?? 0.75);
    // extractedAt 列入依賴：重新抽離會沿用同一個 version id（jobs.ts replaceVersionId），
    // 只有 extractedAt 會變；不重新播種的話，常駐自動儲存會把舊文字框寫回去蓋掉新結果。
  }, [selected?.id, selectedVersion?.id, selectedVersion?.textLayer?.extractedAt]);
  useEffect(() => {
    if (!project || !selected || !draft || draft.id !== selected.id) return;
    const fields = ["purpose", "content", "narrative", "layoutHint", "imagePrompt"] as const;
    const changed =
      fields.some((field) => draft[field] !== selected[field]) ||
      JSON.stringify(draft.sourceIds) !== JSON.stringify(selected.sourceIds);
    if (!changed) return;
    const timer = setTimeout(() => {
      setSaving(true);
      void api
        .updateSlide(project.id, selected.id, {
          purpose: draft.purpose,
          content: draft.content,
          narrative: draft.narrative,
          layoutHint: draft.layoutHint,
          imagePrompt: draft.imagePrompt,
          sourceIds: draft.sourceIds,
        })
        .then(setProject)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : "自動儲存失敗"),
        )
        .finally(() => setSaving(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, project?.id, selected]);
  useEffect(() => {
    if (project) setBriefDraft(structuredClone(project.brief));
  }, [project?.id]);
  // 系統層級 Web Search Mode：當系統值與目前專案 brief 不一致時，自動同步到伺服器端 brief，
  // 讓大綱生成 / 重建大綱等流程都使用全域偏好，而不需要在每個專案面板重新選擇。
  useEffect(() => {
    if (!project || project.brief.webSearchMode === webSearchMode) return;
    let active = true;
    void api
      .updateBrief(project.id, { webSearchMode })
      .then((updated) => {
        if (active) {
          setProject(updated);
          setBriefDraft(structuredClone(updated.brief));
        }
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "同步 Web Search 設定失敗"),
      );
    return () => {
      active = false;
    };
  }, [project?.id, webSearchMode]);
  useEffect(() => {
    if (
      !project ||
      !project.jobs.some((job) => job.status === "queued" || job.status === "running")
    )
      return;
    const timer = setInterval(() => {
      void api
        .getProject(project.id)
        .then(setProject)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : "更新失敗"),
        );
    }, 700);
    return () => clearInterval(timer);
  }, [project]);
  useEffect(() => {
    if (!activeJob) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [activeJob?.id]);
  useEffect(() => {
    // 只在使用者實際編輯過（textDirty）才儲存：常駐的文字圖層不能把重新播種前的舊狀態寫回伺服器。
    // 刻意不依賴 textEditing——進入歷史版本預覽時，尚未儲存的編輯仍要照常送出。
    if (!project || !selected || !selectedVersion?.textLayer || !textDirty.current) return;
    if (JSON.stringify(textBoxes) === JSON.stringify(selectedVersion.textLayer.boxes)) return;
    const timer = setTimeout(() => {
      setTextLayerBusy(true);
      void api
        .updateTextLayer(project.id, selected.id, selectedVersion.id, textBoxes, textThreshold)
        .then(setProject)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : "文字圖層自動儲存失敗"),
        )
        .finally(() => setTextLayerBusy(false));
    }, 650);
    return () => clearTimeout(timer);
  }, [
    project?.id,
    selected?.id,
    selectedVersion?.id,
    selectedVersion?.textLayer,
    textBoxes,
    textThreshold,
  ]);
  useEffect(() => {
    if (!textEditing) return;
    const onUndo = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !target.closest(".text-layer-canvas") &&
        (target.matches("input, textarea, select") || target.isContentEditable)
      )
        return;
      const source = event.shiftKey ? textRedo : textUndo;
      const snapshot = source.at(-1);
      if (!snapshot) return; // 空堆疊時放行，不吞掉瀏覽器原生的 Cmd/Ctrl+Z
      event.preventDefault();
      textDirty.current = true;
      if (event.shiftKey) {
        setTextUndo((history) => pushHistory(history, textBoxes));
        setTextBoxes(snapshot);
        setTextRedo((history) => history.slice(0, -1));
      } else {
        setTextRedo((history) => pushHistory(history, textBoxes));
        setTextBoxes(snapshot);
        setTextUndo((history) => history.slice(0, -1));
      }
      // 還原後若選中的文字框不在快照中，清掉選取狀態，與按鈕列的還原/重做一致。
      if (selectedTextId && !snapshot.some((box) => box.id === selectedTextId))
        setSelectedTextId(undefined);
    };
    window.addEventListener("keydown", onUndo);
    return () => window.removeEventListener("keydown", onUndo);
  }, [textBoxes, selectedTextId, textEditing, textRedo, textUndo]);
  useEffect(() => {
    if (!project || project.workflowStage !== "editing") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const isFormControl =
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select, button, a") || target.isContentEditable);
      if (showImageEdit) {
        if (event.key === "Escape" && !imageEditBusy) {
          event.preventDefault();
          setShowImageEdit(false);
        }
        return;
      }
      if (stylePickerVersion) {
        if (event.key === "Escape") {
          event.preventDefault();
          setStylePickerVersion(undefined);
        }
        return;
      }
      if (presentationIndex !== null) {
        if (isFormControl && event.key === " ") return;
        const lastIndex = project.slides.length - 1;
        let nextIndex = presentationIndex;
        if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(event.key))
          nextIndex = Math.min(lastIndex, presentationIndex + 1);
        else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key))
          nextIndex = Math.max(0, presentationIndex - 1);
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = lastIndex;
        else if (event.key === "Escape") {
          event.preventDefault();
          setPresentationIndex(null);
          if (document.fullscreenElement && document.exitFullscreen)
            void document.exitFullscreen().catch(() => undefined);
          return;
        } else return;
        event.preventDefault();
        setPresentationIndex(nextIndex);
        return;
      }
      if (isFormControl || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const currentIndex = Math.max(
        0,
        project.slides.findIndex((slide) => slide.id === selectedId),
      );
      const nextIndex =
        event.key === "ArrowUp"
          ? Math.max(0, currentIndex - 1)
          : Math.min(project.slides.length - 1, currentIndex + 1);
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      setSelectedId(project.slides[nextIndex]?.id);
      setPanel("slide");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imageEditBusy, presentationIndex, project, selectedId, showImageEdit, stylePickerVersion]);
  useEffect(() => {
    if (presentationIndex === null) return;
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setPresentationIndex(null);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [presentationIndex]);
  // 選取的縮圖若超出縮圖列可視範圍（例如以方向鍵切換），自動捲入視野。
  useEffect(() => {
    if (!selectedId) return;
    railRef.current?.querySelector(".thumbnail.selected")?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  const importNoticeToast = importNotice ? (
    <button className="toast import-report" onClick={() => setImportNotice(undefined)}>
      {importNotice} ×
    </button>
  ) : null;

  if (route === "/models") return <ModelLibrary onNavigate={navigate} />;

  const versionRoute = /^\/styles\/([a-zA-Z0-9_-]+)\/versions\/(\d+)$/.exec(route);
  const styleRoute = /^\/styles\/([a-zA-Z0-9_-]+)$/.exec(route);
  if (route === "/styles/new" || versionRoute || styleRoute)
    return (
      <StyleEditor
        {...(route === "/styles/new" ? {} : { styleId: (versionRoute ?? styleRoute)![1] })}
        {...(versionRoute ? { historicalVersion: Number(versionRoute[2]) } : {})}
        onSaved={(saved) => {
          setStyles((all) => [saved, ...all.filter((item) => item.id !== saved.id)]);
          navigate(`/styles/${saved.id}`);
        }}
        onExit={() => navigate("/styles")}
      />
    );

  if (!project || route === "/" || route === "/styles")
    return (
      <>
        {error && <div className="toast error">{error}</div>}
        {importNoticeToast}
        <CreateProject
          key={`${route}:${window.location.search}`}
          projects={projects}
          styles={styles}
          styleLibrary={route === "/styles"}
          onNavigate={navigate}
          onImportNotice={setImportNotice}
          onOpen={(value) => {
            setProject(value);
            setSelectedId(value.slides[0]?.id);
            navigate(`/projects/${value.id}`);
          }}
          onCreate={async (topic, styleId) => {
            const value = await api.createProject(topic, styleId);
            setProject(value);
            setSelectedId(value.slides[0]?.id);
            navigate(`/projects/${value.id}`);
          }}
          onDelete={async (target) => {
            await api.deleteProject(target.id);
            setProjects((current) => current.filter((candidate) => candidate.id !== target.id));
          }}
        />
      </>
    );

  // PDF 匯入的專案完全不進四步 wizard：settings 階段就是它的風格分析頁。
  if (project.workflowStage !== "editing" && isPdfImportProject(project))
    return (
      <>
        {error && (
          <button className="toast error" onClick={() => setError(undefined)}>
            {error} ×
          </button>
        )}
        {importNoticeToast}
        <PdfDeckAnalysis
          project={project}
          styles={styles}
          onProject={setProject}
          onEnterEditor={(value) => {
            setProject(value);
            setSelectedId(value.slides[0]?.id);
          }}
          onExit={() => {
            setProject(undefined);
            setSelectedId(undefined);
            navigate("/");
          }}
        />
      </>
    );

  if (project.workflowStage !== "editing")
    return (
      <>
        {error && (
          <button className="toast error" onClick={() => setError(undefined)}>
            {error} ×
          </button>
        )}
        <SetupFlow
          project={project}
          providers={providers}
          styles={styles}
          acceptUnknownReadiness={acceptUnknownReadiness}
          onAcceptUnknownReadiness={setAcceptUnknownReadiness}
          onProject={(value) => {
            setProject(value);
            setSelectedId(value.slides[0]?.id);
          }}
          onExit={() => {
            setProject(undefined);
            setSelectedId(undefined);
            navigate("/");
          }}
          onError={(message) => setError(message || undefined)}
        />
      </>
    );

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
    } finally {
      setSaving(false);
    }
  };

  // 新增頁面一律建空白頁，接著沿用既有的單頁流程：填目的 → 生成大綱 → 生成圖片。
  // 不再走專用的一次性 AI 端點，新頁與既有頁的操作方式因此完全一致。
  const addBlankSlide = async () => {
    setNewSlideBusy(true);
    setError(undefined);
    const previousIds = new Set(project.slides.map((slide) => slide.id));
    try {
      const updated = await api.addSlide(project.id, selected ? { afterSlideId: selected.id } : {});
      setProject(updated);
      setSelectedId(updated.slides.find((slide) => !previousIds.has(slide.id))?.id);
      setPanel("slide");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新增頁面失敗");
    } finally {
      setNewSlideBusy(false);
    }
  };

  const generate = async () => {
    if (!selected) return;
    let currentReadiness: ProviderReadiness;
    try {
      currentReadiness = await api.readiness(effectiveImageProviderId);
      setReadiness(currentReadiness);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider readiness 檢查失敗");
      return;
    }
    if (
      currentReadiness.blocking ||
      (currentReadiness.requiresAcknowledgement && !acceptUnknownReadiness)
    )
      return;
    if (!(await save())) return;
    try {
      // 不傳 providerId：server 依專案組合（或預設組合）解析影像模型。
      await api.generate(project.id, selected.id, undefined, acceptUnknownReadiness);
      setProject(await api.getProject(project.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成失敗");
    }
  };

  const activeImage = selected ? currentImage(project, selected) : undefined;
  const image = previewVersion ? imageUrl(project.id, previewVersion.imagePath) : activeImage;
  const outlineView = previewVersion
    ? draft && previewVersion.outlineSnapshot
      ? { ...draft, ...previewVersion.outlineSnapshot }
      : undefined
    : draft;
  const outlineReadOnly = !!previewVersion;
  const outlineDirty = !!selected?.outlineDirty && !outlineReadOnly;
  // 目前使用中版本生成時的 outline 快照，作為「哪一欄與畫面上的圖片不同步」的比對基準。
  const currentOutlineSnapshot = selectedVersion?.outlineSnapshot;
  // 逐欄標示：只有實際與現有圖片不同步的那一欄才亮橘框；
  // 無快照可比（例如尚未生成過圖片）時退回整組標示。
  const fieldDirty = (field: "content" | "narrative" | "layoutHint" | "imagePrompt"): boolean => {
    if (!outlineDirty) return false;
    if (!currentOutlineSnapshot || !outlineView) return true;
    return outlineView[field] !== currentOutlineSnapshot[field];
  };
  const previewOutlineMatchesCurrent =
    !!draft &&
    !!previewVersion?.outlineSnapshot &&
    draft.purpose === previewVersion.outlineSnapshot.purpose &&
    draft.content === previewVersion.outlineSnapshot.content &&
    draft.narrative === previewVersion.outlineSnapshot.narrative &&
    draft.layoutHint === previewVersion.outlineSnapshot.layoutHint &&
    draft.imagePrompt === previewVersion.outlineSnapshot.imagePrompt &&
    JSON.stringify(draft.sourceIds) === JSON.stringify(previewVersion.outlineSnapshot.sourceIds);
  const presentationSlide =
    presentationIndex === null ? undefined : project.slides[presentationIndex];
  // 正在預覽歷史版本時，簡報模式的該頁要跟編輯畫布一致，顯示預覽中的版本。
  const presentationImage = presentationSlide
    ? presentationSlide.id === selected?.id && previewVersion
      ? imageUrl(project.id, previewVersion.imagePath)
      : currentImage(project, presentationSlide)
    : undefined;
  const run = async (operation: () => Promise<PresentationProject>) => {
    setError(undefined);
    try {
      const updated = await operation();
      setProject(updated);
      return updated;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失敗");
      return undefined;
    }
  };
  const startPresentation = () => {
    const index = Math.max(
      0,
      project.slides.findIndex((slide) => slide.id === selected?.id),
    );
    setPresentationIndex(index);
    const request = document.documentElement.requestFullscreen?.();
    if (request) void request.catch(() => undefined);
  };
  const stopPresentation = () => {
    setPresentationIndex(null);
    if (document.fullscreenElement && document.exitFullscreen)
      void document.exitFullscreen().catch(() => undefined);
  };
  const addCurrentImageToStyle = async (styleId?: string) => {
    if (!stylePickerVersion) return;
    setStylePickerBusy(true);
    setError(undefined);
    try {
      const reference = await api.versionToStyleReference(
        project.id,
        stylePickerVersion.slideId,
        stylePickerVersion.versionId,
      );
      sessionStorage.setItem("pendingStyleReference", JSON.stringify(reference));
      setStylePickerVersion(undefined);
      navigate(styleId ? `/styles/${styleId}` : "/styles/new");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加入風格庫失敗");
    } finally {
      setStylePickerBusy(false);
    }
  };
  const changeTextBoxes = (next: EditableTextBox[]) => {
    setTextUndo((history) => pushHistory(history, textBoxes));
    setTextRedo([]);
    textDirty.current = true;
    setTextBoxes(next);
  };
  const selectedText = textBoxes.find((box) => box.id === selectedTextId);
  const patchSelectedText = (patch: Partial<EditableTextBox>) => {
    if (!selectedTextId) return;
    changeTextBoxes(
      textBoxes.map((box) => (box.id === selectedTextId ? { ...box, ...patch } : box)),
    );
  };
  const startTextExtraction = async () => {
    if (!selected || !selectedVersion) return;
    setTextLayerBusy(true);
    setError(undefined);
    try {
      const status = await api.ocrStatus();
      if (!status.available) throw new Error(status.message);
      await api.extractText(
        project.id,
        selected.id,
        effectiveImageProviderId,
        textThreshold,
        acceptUnknownReadiness,
      );
      setProject(await api.getProject(project.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文字抽離失敗");
    } finally {
      setTextLayerBusy(false);
    }
  };
  return (
    <div className="shell">
      <header>
        <button
          className="brand"
          onClick={() => {
            setProject(undefined);
            setSelectedId(undefined);
            navigate("/");
          }}
        >
          SM<span>↗</span>
        </button>
        <div className="title-block">
          {editingName ? (
            <input
              className="title-name-input"
              autoFocus
              value={nameDraft}
              maxLength={200}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => {
                setEditingName(false);
                const next = nameDraft.trim();
                if (next && next !== project.name) {
                  void api
                    .updateProjectName(project.id, next)
                    .then((updated) => setProject(updated))
                    .catch((reason: unknown) =>
                      setError(reason instanceof Error ? reason.message : "重新命名失敗"),
                    );
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  (event.currentTarget as HTMLInputElement).blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <strong
              className="title-name"
              role="button"
              tabIndex={0}
              title="點一下重新命名"
              onClick={() => {
                setNameDraft(project.name);
                setEditingName(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setNameDraft(project.name);
                  setEditingName(true);
                }
              }}
            >
              {project.name}
            </strong>
          )}
          <small>
            {project.canvas.width} × {project.canvas.height} · {project.styleSnapshot.name}
          </small>
        </div>
        <nav className="workspace-nav">
          <button onClick={() => setPanel("project")}>專案</button>
          <button onClick={() => setPanel("sources")}>
            來源 <b>{project.sources.length}</b>
          </button>
          <button onClick={() => setPanel("export")}>匯出</button>
          <button className="present-button" onClick={startPresentation}>
            ▶ 簡報模式
          </button>
        </nav>
        <div className="header-status">
          <span className="status-dot" />
          {saving ? "正在自動儲存…" : "已自動儲存"}
        </div>
        <button
          className="system-settings-button"
          aria-label="系統設定"
          title="系統設定"
          onClick={() => setShowSystemSettings(true)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </header>
      {showSystemSettings && (
        <SystemSettingsDialog
          webSearchMode={system.webSearchMode}
          onWebSearchMode={system.setWebSearchMode}
          combinations={combinations}
          combinationId={project.combinationId}
          onCombinationId={(combinationId) => {
            void api
              .setProjectCombination(project.id, combinationId)
              .then((updated) => setProject(updated))
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : "設定組合失敗"),
              );
          }}
          onOpenModelLibrary={() => navigate("/models")}
          onClose={() => setShowSystemSettings(false)}
        />
      )}
      <aside className="rail">
        <div className="rail-heading">
          <span>PAGES</span>
          <span className="rail-heading-count">
            <b>{project.slides.length}</b>
            <button
              className="add-page"
              aria-label="新增頁面"
              title="新增空白頁"
              disabled={newSlideBusy}
              onClick={() => void addBlankSlide()}
            >
              ＋
            </button>
          </span>
        </div>
        <div className="thumbnails" ref={railRef}>
          {project.slides.map((slide) => {
            const thumb = currentImage(project, slide);
            return (
              <div
                key={slide.id}
                className={`thumbnail ${slide.id === selected?.id ? "selected" : ""}`}
                draggable
                onDragStart={() => setDraggedId(slide.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (!draggedId || draggedId === slide.id) return;
                  const ids = project.slides.map((item) => item.id);
                  const from = ids.indexOf(draggedId);
                  const to = ids.indexOf(slide.id);
                  ids.splice(to, 0, ids.splice(from, 1)[0]!);
                  void run(() => api.reorderSlides(project.id, ids));
                  setDraggedId(undefined);
                }}
                onClick={() => {
                  setSelectedId(slide.id);
                  setPanel("slide");
                }}
                role="button"
                tabIndex={0}
              >
                <span className="slide-number">{String(slide.order + 1).padStart(2, "0")}</span>
                <span
                  className="thumb-canvas"
                  style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
                >
                  {!thumb && <em>{slide.purpose}</em>}
                </span>
                <span className="thumb-actions">
                  <button
                    title="複製頁面"
                    onClick={(event) => {
                      event.stopPropagation();
                      void run(() => api.duplicateSlide(project.id, slide.id));
                    }}
                  >
                    ⧉
                  </button>
                  <button
                    title="刪除頁面"
                    disabled={project.slides.length === 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (confirm("刪除此頁？"))
                        void run(() => api.deleteSlide(project.id, slide.id));
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </aside>
      <main className="stage">
        <div className="stage-meta">
          <span>{selected?.purpose}</span>
          <span className="stage-meta-actions">
            <button
              onClick={() => {
                if (selected?.currentVersionId)
                  setStylePickerVersion({
                    slideId: selected.id,
                    versionId: selected.currentVersionId,
                  });
              }}
              disabled={!selected?.currentVersionId || !!activeJob || !!previewVersion}
            >
              ＋ 將圖片加入風格庫
            </button>
            <span>
              {activeJob
                ? `● ${PHASE_LABELS[activeJob.phase ?? activeJob.status] ?? activeJob.status}`
                : previewVersion
                  ? "歷史版本預覽"
                  : "16:9 PREVIEW"}
            </span>
          </span>
        </div>
        <div className="canvas-fit" onWheel={handleStageWheel}>
          <div
            className={`canvas ${activeJob ? "generating" : ""}`}
            style={{ aspectRatio: `${project.canvas.width} / ${project.canvas.height}` }}
          >
            {activeTextLayer ? (
              <TextLayerCanvas
                background={imageUrl(project.id, activeTextLayer.backgroundPath)}
                boxes={textBoxes}
                canvasWidth={project.canvas.width}
                canvasHeight={project.canvas.height}
                selectedId={selectedTextId}
                onSelect={setSelectedTextId}
                onChange={changeTextBoxes}
              />
            ) : image ? (
              <img src={image} alt={`Slide ${(selected?.order ?? 0) + 1}`} />
            ) : (
              <div className="canvas-empty">
                <div className="orbit" />
                <strong>{selected?.purpose || "尚未設定頁面目的"}</strong>
                <p>請輸入頁面目的後，點下方生成大綱，再生成圖片。</p>
                <p>同時可以至來源頁添加素材，生成大綱時會一併引用。</p>
              </div>
            )}
          </div>
        </div>
        {showPdfFontNotice && (
          <div className="pdf-font-notice" role="status">
            <span>
              這是從 PDF 匯入的「可編輯文字」版本：文字會以系統字型重繪，字型看起來會和原始 PDF
              不同。要保留原始字型外觀，請切回「原始頁面」版本，匯出時也會保真。
            </span>
            <button onClick={pdfFontNotice.acknowledge}>知道了</button>
          </div>
        )}
        {activeTextLayer && (
          <div className="text-layer-toolbar">
            <span>
              {textLayerBusy
                ? "正在重繪並自動儲存…"
                : `${textBoxes.length} 個文字框 · 單擊選取 · 雙擊編輯文字`}
            </span>
            <button
              onClick={() => {
                const box: EditableTextBox = {
                  id: crypto.randomUUID(),
                  text: "新增文字",
                  x: 120,
                  y: 120,
                  width: 420,
                  height: 80,
                  fontFamily: "Arial",
                  fontSize: 44,
                  fontWeight: 400,
                  color: "#ffffff",
                  opacity: 1,
                  lineHeight: 1.2,
                  letterSpacing: 0,
                  align: "left",
                  verticalAlign: "top",
                  rotation: 0,
                  confidence: 1,
                  role: "presentation",
                };
                changeTextBoxes([...textBoxes, box]);
                setSelectedTextId(box.id);
              }}
            >
              ＋ 文字框
            </button>
            <button
              disabled={!selectedText}
              onClick={() => {
                changeTextBoxes(textBoxes.filter((box) => box.id !== selectedTextId));
                setSelectedTextId(undefined);
              }}
            >
              刪除文字框
            </button>
            <button
              disabled={!textUndo.length}
              onClick={() => {
                const previous = textUndo.at(-1);
                if (!previous) return;
                textDirty.current = true;
                setTextRedo((history) => pushHistory(history, textBoxes));
                setTextBoxes(previous);
                setTextUndo((history) => history.slice(0, -1));
                // 還原後若選中的文字框已不在快照中，清掉選取，避免「刪除」按鈕看起來莫名熄滅。
                if (selectedTextId && !previous.some((box) => box.id === selectedTextId))
                  setSelectedTextId(undefined);
              }}
            >
              復原
            </button>
            <button
              disabled={!textRedo.length}
              onClick={() => {
                const next = textRedo.at(-1);
                if (!next) return;
                textDirty.current = true;
                setTextUndo((history) => pushHistory(history, textBoxes));
                setTextBoxes(next);
                setTextRedo((history) => history.slice(0, -1));
                if (selectedTextId && !next.some((box) => box.id === selectedTextId))
                  setSelectedTextId(undefined);
              }}
            >
              重做
            </button>
          </div>
        )}
        {previewVersion && selected && (
          <div className="version-preview-actions" role="status">
            <span>
              <b>正在預覽歷史版本</b>
              <small>
                {new Date(previewVersion.createdAt).toLocaleString("zh-TW")}
                {!previewVersion.outlineSnapshot
                  ? " · 舊版未保存大綱，僅比較圖片"
                  : previewOutlineMatchesCurrent
                    ? " · 大綱與目前版本相同"
                    : " · 圖片與大綱快照"}
              </small>
            </span>
            <button onClick={() => setPreviewVersionId(undefined)}>返回目前版本</button>
            <button
              className="primary"
              disabled={!!activeJob}
              onClick={() => {
                void run(() =>
                  api.activateVersion(project.id, selected.id, previewVersion.id),
                ).then((updated) => {
                  if (!updated) return;
                  const switched = updated.slides.find((slide) => slide.id === selected.id);
                  if (switched) setDraft(structuredClone(switched));
                  setPreviewVersionId(undefined);
                });
              }}
            >
              切換至此版本
            </button>
          </div>
        )}
        {activeJob && (
          <div className="job-progress" role="status">
            <div>
              <strong>
                {PHASE_LABELS[activeJob.phase ?? activeJob.status] ?? activeJob.status}
              </strong>
              <span>
                {activeJob.progress
                  ? `步驟 ${activeJob.progress.step} / ${activeJob.progress.total}`
                  : "處理中"}
              </span>
            </div>
            <div className="progress-track">
              <i
                style={{
                  width: `${((activeJob.progress?.step ?? 1) / (activeJob.progress?.total ?? 6)) * 100}%`,
                }}
              />
            </div>
            <div className="job-time">
              <span>已經過 {duration(elapsedMs)}</span>
              {remainingMs !== undefined && <span>預估逾時剩餘 {duration(remainingMs)}</span>}
            </div>
            {activeJob.phase === "waiting_for_codex" && elapsedMs > 120_000 && (
              <p>
                圖片生成可能需要數分鐘。若接近逾時，請確認 Codex 額度與登入，或調高 server timeout
                後重新啟動。
              </p>
            )}
            <button
              onClick={() => {
                void api
                  .cancel(project.id, activeJob.id)
                  .then(() => api.getProject(project.id))
                  .then(setProject)
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : "取消失敗"),
                  );
              }}
            >
              取消生成
            </button>
          </div>
        )}
        {lastJob?.status === "failed" && (
          <div className="job-error">
            生成失敗{lastJob.errorCode ? `（${lastJob.errorCode}）` : ""}：{lastJob.error}
          </div>
        )}
        <div className="versions">
          <div className="section-label">版本歷史</div>
          <div className="version-list">
            {selected?.versions.length === 0 && <span className="empty-inline">尚無版本</span>}
            {[...(selected?.versions ?? [])].reverse().map((version) => {
              const isCurrent = version.id === selected?.currentVersionId;
              const isPreviewing = version.id === previewVersion?.id;
              const versionNumber =
                (selected?.versions.findIndex((candidate) => candidate.id === version.id) ?? 0) + 1;
              return (
                <button
                  key={version.id}
                  aria-label={`版本 ${versionNumber}${version.label ? `：${version.label}` : ""}${isCurrent ? "（目前）" : ""}`}
                  className={`${isCurrent ? "current" : ""} ${isPreviewing ? "previewing" : ""}`.trim()}
                  onClick={() => setPreviewVersionId(isCurrent ? undefined : version.id)}
                >
                  <img src={imageUrl(project.id, version.imagePath)} alt="version" />
                  {/*
                    PDF 匯入的兩個版本是同一秒建立的，只看時間戳分不出哪個是原圖、
                    哪個是可編輯文字，所以有 label 就顯示 label。
                  */}
                  {version.label && <span className="version-label">{version.label}</span>}
                  <span>
                    {(() => {
                      const d = new Date(version.createdAt);
                      const p2 = (n: number) => String(n).padStart(2, "0");
                      return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(
                        d.getMinutes(),
                      )}`;
                    })()}
                    {isCurrent ? " · 使用中" : isPreviewing ? " · 預覽" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </main>
      <aside className="inspector">
        <div className="inspector-tabs">
          <button className={panel === "slide" ? "active" : ""} onClick={() => setPanel("slide")}>
            頁面
          </button>
          <button
            className={panel === "project" ? "active" : ""}
            onClick={() => setPanel("project")}
          >
            設定
          </button>
          <button
            className={panel === "sources" ? "active" : ""}
            onClick={() => setPanel("sources")}
          >
            來源
          </button>
          <button className={panel === "export" ? "active" : ""} onClick={() => setPanel("export")}>
            匯出
          </button>
        </div>
        {panel === "slide" && (
          <>
            <div className="inspector-heading">
              <span>SLIDE SPEC</span>
              <b>{String((selected?.order ?? 0) + 1).padStart(2, "0")}</b>
            </div>
            {previewVersion && !previewVersion.outlineSnapshot && (
              <div className="outline-preview-unavailable">
                <b>此版本沒有大綱快照</b>
                <span>
                  它建立於大綱隨圖片版本保存之前，因此只能比較圖片；切換後目前大綱會保留為待生成草稿。
                </span>
              </div>
            )}
            {outlineView && draft && (
              <div className="fields">
                <label>
                  頁面目的
                  <input
                    readOnly={outlineReadOnly}
                    value={outlineView.purpose}
                    onChange={(event) => setDraft({ ...draft, purpose: event.target.value })}
                  />
                </label>
                <label className={fieldDirty("content") ? "outline-dirty" : ""}>
                  內容
                  <textarea
                    readOnly={outlineReadOnly}
                    rows={4}
                    value={outlineView.content}
                    onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  />
                </label>
                <label className={fieldDirty("narrative") ? "outline-dirty" : ""}>
                  敘事
                  <textarea
                    readOnly={outlineReadOnly}
                    rows={3}
                    value={outlineView.narrative}
                    onChange={(event) => setDraft({ ...draft, narrative: event.target.value })}
                  />
                </label>
                <label className={fieldDirty("layoutHint") ? "outline-dirty" : ""}>
                  構圖提示
                  <textarea
                    readOnly={outlineReadOnly}
                    rows={3}
                    value={outlineView.layoutHint}
                    onChange={(event) => setDraft({ ...draft, layoutHint: event.target.value })}
                  />
                </label>
                <label className={fieldDirty("imagePrompt") ? "outline-dirty" : ""}>
                  完整圖片提示詞
                  <textarea
                    readOnly={outlineReadOnly}
                    className="prompt"
                    rows={6}
                    value={outlineView.imagePrompt}
                    onChange={(event) => setDraft({ ...draft, imagePrompt: event.target.value })}
                  />
                </label>
                <fieldset>
                  <legend>此頁來源</legend>
                  {project.sources.length === 0 ? (
                    <small>請先在「來源」上傳資料。</small>
                  ) : (
                    project.sources.map((source) => (
                      <label className="check-row" key={source.id}>
                        <input
                          type="checkbox"
                          disabled={outlineReadOnly}
                          checked={outlineView.sourceIds.includes(source.id)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              sourceIds: event.target.checked
                                ? [...draft.sourceIds, source.id]
                                : draft.sourceIds.filter((id) => id !== source.id),
                            })
                          }
                        />
                        {source.name}
                      </label>
                    ))
                  )}
                </fieldset>
                {provider?.availability.status === "unavailable" && (
                  <div className="provider-note">{provider.availability.reason}</div>
                )}
                {provider?.availability.status === "available" && provider.availability.warning && (
                  <div className="provider-warning">⚠ {provider.availability.warning}</div>
                )}
                {readinessBusy && (
                  <div className="provider-note" role="status">
                    正在檢查 provider readiness…
                  </div>
                )}
                {readiness && readiness.status !== "ready" && (
                  <div
                    className={readiness.blocking ? "provider-note" : "provider-warning"}
                    role="status"
                  >
                    {readiness.status === "ready_experimental" ? "⚠ " : ""}
                    {readiness.message}
                  </div>
                )}
                {readiness?.requiresAcknowledgement && (
                  <label className="readiness-ack">
                    <input
                      type="checkbox"
                      checked={acceptUnknownReadiness}
                      onChange={(event) => setAcceptUnknownReadiness(event.target.checked)}
                    />
                    我了解 readiness 無法確認，仍要嘗試生成
                  </label>
                )}
                {provider?.timeoutMs && (
                  <div className="provider-timeout">單頁逾時：{duration(provider.timeoutMs)}</div>
                )}
              </div>
            )}
            <div className="actions">
              <button
                className="regenerate-outline"
                onClick={() => {
                  if (!selected) return;
                  setOutlineBusy(true);
                  setError(undefined);
                  void save()
                    .then(async (saved) => {
                      if (!saved) return;
                      const updated = await api.regenerateSlideOutline(project.id, selected.id);
                      const regenerated = updated.slides.find((slide) => slide.id === selected.id);
                      setProject(updated);
                      if (regenerated) setDraft(structuredClone(regenerated));
                    })
                    .catch((reason: unknown) =>
                      setError(reason instanceof Error ? reason.message : "重新生成單頁大綱失敗"),
                    )
                    .finally(() => setOutlineBusy(false));
                }}
                disabled={outlineBusy || !!activeJob || !!previewVersion || !draft?.purpose.trim()}
                title={draft?.purpose.trim() ? undefined : "請先填寫頁面目的"}
              >
                {outlineBusy
                  ? "正在重新檢索來源與生成大綱…"
                  : draft?.content.trim()
                    ? "重新生成單頁大綱"
                    : "生成大綱"}
              </button>
              <button
                className="primary"
                onClick={() => void generate()}
                disabled={
                  !!activeJob ||
                  !!previewVersion ||
                  provider?.availability.status !== "available" ||
                  readinessBusy ||
                  !readiness ||
                  readiness.blocking ||
                  (readiness.requiresAcknowledgement && !acceptUnknownReadiness)
                }
              >
                {activeJob ? "生成中…" : selected?.versions.length ? "重新生成圖片" : "生成此頁"}
                <span>→</span>
              </button>
              <button
                className="image-edit-button"
                onClick={() => setShowImageEdit(true)}
                disabled={
                  !activeImage ||
                  !!activeJob ||
                  !!previewVersion ||
                  !provider?.capabilities.imageEditing
                }
              >
                編輯當頁圖片
              </button>
              <div
                className={`text-extraction-control${showTextThreshold ? " open" : ""}`}
                title="只處理當頁；低於門檻的文字保留在原圖。"
              >
                <div className="text-extraction-row">
                  <button
                    className="extract-button"
                    onClick={() => void startTextExtraction()}
                    disabled={
                      !selectedVersion ||
                      !!activeJob ||
                      !!previewVersion ||
                      textLayerBusy ||
                      // 這個版本已經有文字層了：再抽一次是拿 OCR ＋ 生圖模型重做一份
                      // 已經精確而且零成本的東西（PDF 匯入的文字層取自原生文字層）。
                      !!selectedVersion?.textLayer ||
                      !provider?.capabilities.maskedEditing
                    }
                    title={
                      selectedVersion?.textLayer
                        ? "這個版本已經有可編輯文字層了"
                        : "以 OCR 抽離文字並抹除原圖上的文字"
                    }
                  >
                    {textLayerBusy ? "處理中…" : "抽離文字"}
                  </button>
                  <button
                    className="threshold-toggle"
                    aria-expanded={showTextThreshold}
                    aria-label="調整文字抽離門檻"
                    title="調整文字抽離門檻"
                    onClick={() => setShowTextThreshold((open) => !open)}
                  >
                    <span className="caret">▾</span>
                  </button>
                </div>
                {showTextThreshold && (
                  <label className="threshold-slider">
                    門檻 <b>{textThreshold.toFixed(2)}</b>
                    <input
                      type="range"
                      min="0.5"
                      max="0.95"
                      step="0.05"
                      value={textThreshold}
                      onChange={(event) => setTextThreshold(Number(event.target.value))}
                    />
                  </label>
                )}
              </div>
            </div>
            {textEditing && (
              <div className="text-properties fields">
                <div className="section-label">TEXT BOX</div>
                {!selectedText && <small>在畫布選擇一個文字框以調整格式。</small>}
                {selectedText && (
                  <>
                    <div className="text-property-grid font-row">
                      <label>
                        字體
                        <input
                          value={selectedText.fontFamily}
                          onChange={(event) =>
                            patchSelectedText({ fontFamily: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        大小
                        <input
                          type="number"
                          min="6"
                          max="300"
                          value={selectedText.fontSize}
                          onChange={(event) =>
                            patchSelectedText({ fontSize: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        字重
                        <select
                          value={selectedText.fontWeight}
                          onChange={(event) =>
                            patchSelectedText({ fontWeight: Number(event.target.value) })
                          }
                        >
                          <option value="400">一般</option>
                          <option value="600">半粗</option>
                          <option value="700">粗體</option>
                          <option value="900">黑體</option>
                        </select>
                      </label>
                    </div>
                    <div className="text-property-grid detail-row">
                      <label>
                        顏色
                        <input
                          type="color"
                          value={selectedText.color}
                          onChange={(event) => patchSelectedText({ color: event.target.value })}
                        />
                      </label>
                      <label>
                        對齊
                        <select
                          value={selectedText.align}
                          onChange={(event) =>
                            patchSelectedText({
                              align: event.target.value as EditableTextBox["align"],
                            })
                          }
                        >
                          <option value="left">靠左</option>
                          <option value="center">置中</option>
                          <option value="right">靠右</option>
                        </select>
                      </label>
                      <label>
                        行高
                        <input
                          type="number"
                          min="0.8"
                          max="3"
                          step="0.1"
                          value={selectedText.lineHeight}
                          onChange={(event) =>
                            patchSelectedText({ lineHeight: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        字距
                        <input
                          type="number"
                          min="-10"
                          max="30"
                          step="0.5"
                          value={selectedText.letterSpacing}
                          onChange={(event) =>
                            patchSelectedText({ letterSpacing: Number(event.target.value) })
                          }
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {panel === "project" && briefDraft && (
          <div className="panel-content fields">
            <div className="inspector-heading">
              <span>PROJECT BRIEF</span>
            </div>
            <label>
              主題
              <input
                value={briefDraft.topic}
                onChange={(event) => setBriefDraft({ ...briefDraft, topic: event.target.value })}
              />
            </label>
            <label>
              目標觀眾
              <input
                value={briefDraft.audience}
                onChange={(event) => setBriefDraft({ ...briefDraft, audience: event.target.value })}
              />
            </label>
            <label>
              目的
              <input
                value={briefDraft.purpose}
                onChange={(event) => setBriefDraft({ ...briefDraft, purpose: event.target.value })}
              />
            </label>
            <label>
              語言
              <input
                value={briefDraft.language}
                onChange={(event) => setBriefDraft({ ...briefDraft, language: event.target.value })}
              />
            </label>
            <label>
              頁數
              <input
                type="number"
                min={1}
                max={100}
                value={briefDraft.desiredSlideCount}
                onChange={(event) =>
                  setBriefDraft({ ...briefDraft, desiredSlideCount: Number(event.target.value) })
                }
              />
            </label>
            <label>
              語氣
              <input
                value={briefDraft.tone}
                onChange={(event) => setBriefDraft({ ...briefDraft, tone: event.target.value })}
              />
            </label>
            <label>
              內容模式
              <select
                value={briefDraft.contentMode}
                onChange={(event) =>
                  setBriefDraft({
                    ...briefDraft,
                    contentMode: event.target.value as PresentationBrief["contentMode"],
                  })
                }
              >
                <option value="creative">Creative</option>
                <option value="grounded">Grounded</option>
              </select>
            </label>
            <label>
              風格
              <select
                value={project.styleSnapshot.id}
                onChange={(event) => {
                  if (!confirmStyleReplacement(styles, project.styleSnapshot, event.target.value))
                    return;
                  void run(() => api.applyStyle(project.id, event.target.value));
                }}
              >
                {styleOptions(styles, project.styleSnapshot)}
              </select>
            </label>
            <div className="panel-actions">
              <button
                className="primary"
                onClick={() => void run(() => api.updateBrief(project.id, briefDraft))}
              >
                儲存 Brief
              </button>
              <button
                onClick={() => {
                  if (confirm("重新產生大綱會取代目前頁面，確定繼續？"))
                    void run(() => api.regenerateOutline(project.id, true));
                }}
              >
                依 Brief 重建大綱
              </button>
              <button
                className="batch-generate"
                onClick={() => {
                  void save().then(async (saved) => {
                    if (!saved) return;
                    try {
                      await api.generateAll(project.id, undefined, acceptUnknownReadiness);
                      setProject(await api.getProject(project.id));
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : "批次生成失敗");
                    }
                  });
                }}
                disabled={
                  project.jobs.some((job) => ["queued", "running"].includes(job.status)) ||
                  readinessBusy ||
                  !readiness ||
                  readiness.blocking
                }
              >
                批次生成全部頁面
              </button>
            </div>
          </div>
        )}
        {panel === "sources" && (
          <div className="panel-content sources-panel">
            <div className="inspector-heading">
              <span>SOURCES</span>
              <b>{project.sources.length}/100</b>
            </div>
            <p className="source-panel-intro">
              管理 AI 可使用的參考資料。點擊預覽可檢查擷取文字或原始圖片。
            </p>
            <SourcePanel project={project} onProject={setProject} onError={setError} />
          </div>
        )}
        {panel === "export" && (
          <div className="panel-content export-panel">
            <div className="inspector-heading">
              <span>EXPORT</span>
            </div>
            <p>匯出會依目前頁面順序使用每頁的目前版本；缺少圖片的頁面會阻止匯出。</p>
            <a href={`/api/projects/${encodeURIComponent(project.id)}/export/pptx`}>
              下載 PowerPoint (.pptx)
            </a>
            <a href={`/api/projects/${encodeURIComponent(project.id)}/export/pdf`}>
              下載 PDF (.pdf)
            </a>
            <a href={`/api/projects/${encodeURIComponent(project.id)}/export/png.zip`}>
              下載每頁 PNG (.zip)
            </a>
            <a href={`/api/projects/${encodeURIComponent(project.id)}/export/slide-project`}>
              備份完整專案 (.slide-project)
            </a>
          </div>
        )}
      </aside>
      {showImageEdit && activeImage && selected && (
        <ImageEditDialog
          image={activeImage}
          busy={imageEditBusy}
          supportsMask={!!provider?.capabilities.maskedEditing}
          onCancel={() => setShowImageEdit(false)}
          onSubmit={(instruction, maskDataUrl) => {
            setImageEditBusy(true);
            setError(undefined);
            void save()
              .then(async (saved) => {
                if (!saved) return;
                await api.editSlideImage(
                  project.id,
                  selected.id,
                  effectiveImageProviderId,
                  instruction,
                  maskDataUrl,
                  acceptUnknownReadiness,
                );
                setProject(await api.getProject(project.id));
                setShowImageEdit(false);
              })
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : "圖片編輯失敗"),
              )
              .finally(() => setImageEditBusy(false));
          }}
        />
      )}
      {stylePickerVersion && (
        <div
          className="style-picker-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="選擇風格"
          onClick={() => {
            if (!stylePickerBusy) setStylePickerVersion(undefined);
          }}
        >
          <section className="style-picker" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span className="section-label">ADD TO STYLE LIBRARY</span>
                <h2>選擇要加入的風格</h2>
                <p>圖片會先帶入風格編輯頁，確認設定後再儲存新版本。</p>
              </div>
              <button
                aria-label="關閉風格選擇"
                disabled={stylePickerBusy}
                onClick={() => setStylePickerVersion(undefined)}
              >
                ×
              </button>
            </header>
            <button
              className="style-picker-new"
              disabled={stylePickerBusy}
              onClick={() => void addCurrentImageToStyle()}
            >
              <b>＋</b>
              <span>
                <strong>建立新風格</strong>
                <small>用這張圖片作為第一張參考圖</small>
              </span>
              <i>→</i>
            </button>
            <div className="style-picker-list">
              {styles.filter((style) => !style.system).length === 0 && (
                <p className="style-picker-empty">目前還沒有自訂風格，可以先建立新風格。</p>
              )}
              {styles
                .filter((style) => !style.system)
                .map((style) => {
                  const cover =
                    style.referenceImages.find((item) => item.id === style.coverImageId) ??
                    style.referenceImages[0];
                  const full = style.referenceImages.length >= 4;
                  return (
                    <button
                      key={style.id}
                      className="style-picker-card"
                      disabled={stylePickerBusy || full}
                      onClick={() => void addCurrentImageToStyle(style.id)}
                    >
                      <span
                        className="style-picker-cover"
                        style={
                          cover ? { backgroundImage: `url(${styleAssetUrl(cover.id)})` } : undefined
                        }
                      >
                        {cover ? "" : style.name.slice(0, 1)}
                      </span>
                      <span>
                        <strong>{style.name}</strong>
                        <small>
                          v{style.version} · 密度{" "}
                          {style.density === "high"
                            ? "高"
                            : style.density === "medium"
                              ? "中"
                              : "低"}{" "}
                          · 參考圖 {style.referenceImages.length}/4
                        </small>
                        {full && <em>參考圖已滿</em>}
                      </span>
                      <i>→</i>
                    </button>
                  );
                })}
            </div>
            {stylePickerBusy && <div className="style-picker-loading">正在準備參考圖…</div>}
          </section>
        </div>
      )}
      {presentationIndex !== null && presentationSlide && (
        <div
          className="presentation-mode"
          role="dialog"
          aria-modal="true"
          aria-label="全螢幕簡報"
          onClick={() =>
            setPresentationIndex(Math.min(project.slides.length - 1, presentationIndex + 1))
          }
        >
          <div className="presentation-surface">
            {presentationImage ? (
              <img
                src={presentationImage}
                alt={`簡報第 ${presentationIndex + 1} 頁`}
                draggable={false}
              />
            ) : (
              <div className="presentation-empty">
                <strong>{presentationSlide.purpose}</strong>
                <span>這一頁尚未生成圖片</span>
              </div>
            )}
          </div>
          <div className="presentation-controls" onClick={(event) => event.stopPropagation()}>
            <button
              aria-label="上一頁"
              disabled={presentationIndex === 0}
              onClick={() => setPresentationIndex(Math.max(0, presentationIndex - 1))}
            >
              ←
            </button>
            <span>
              {presentationIndex + 1} / {project.slides.length}
            </span>
            <button
              aria-label="下一頁"
              disabled={presentationIndex === project.slides.length - 1}
              onClick={() =>
                setPresentationIndex(Math.min(project.slides.length - 1, presentationIndex + 1))
              }
            >
              →
            </button>
            <small>方向鍵／Space 換頁 · Esc 離開</small>
            <button
              className="presentation-close"
              aria-label="離開簡報模式"
              onClick={stopPresentation}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {importNoticeToast}
      {error && (
        <button className="toast error" onClick={() => setError(undefined)}>
          {error} ×
        </button>
      )}
    </div>
  );
}

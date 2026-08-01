import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  pageNumberFormatSchema,
  pageNumberLayout,
  pageNumberPositionSchema,
  pageNumberSlideLabel,
  TEXT_STROKE_DEFAULT_COLOR,
  TEXT_STROKE_DEFAULT_OPACITY,
  TEXT_STROKE_DEFAULT_WIDTH_EM,
  TEXT_STROKE_MAX_WIDTH_EM,
  type EditableTextBox,
  type PageNumberSettings,
  type PresentationBrief,
  type PresentationProject,
  type SlideSpec,
  type StylePreset,
  SOURCE_COUNT_LIMIT,
  STYLE_REFERENCE_IMAGE_LIMIT,
} from "@slide-maker/core";
import {
  api,
  ApiError,
  imageUrl,
  projectAssetUrl,
  styleAssetUrl,
  type ProviderReadiness,
  type ProviderSummary,
  type WebSearchResult,
} from "./api.js";
import { StyleEditor } from "./StyleEditor.js";
import { SourcePanel, isDescribing, parsingExpired } from "./SourcePanel.js";
import { TextEffectRow } from "./TextEffectRow.js";
import { UsagePanel } from "./UsagePanel.js";
import { PdfDeckImportModal } from "./PdfDeckImportModal.js";
import { PdfDeckAnalysis } from "./PdfDeckAnalysis.js";
import { ModelLibrary } from "./ModelLibrary.js";
import { LibraryHeader } from "./LibraryHeader.js";
import { useOneTimeNotice } from "./oneTimeNotice.js";
import { toggleSourcePin } from "./sourceSelection.js";
import {
  measureCanvasRowLayout,
  shouldStackTextRail,
  CANVAS_ROW_STACKED_CLASS,
} from "./canvasRowLayout.js";
import { useDialogA11y } from "./useDialogA11y.js";
import { modalDialogOpen } from "./modalDialogOpen.js";
import { ErrorToast } from "./ErrorToast.js";
import {
  firstPresentableIndex,
  hiddenSlideCount,
  nextVisibleIndex,
  visibleSlideIds,
} from "./editor/slideVisibility.js";
import {
  batchExtractPlan,
  isBatchAbortingFailure,
  styleRefinementFailure,
  styleRefinementReasonText,
  OCR_CONFIG_ABORT_CODES,
  type StyleRefinementFailure,
} from "./editor/extractionPlan.js";
import {
  defaultTextBox,
  isTypingTarget,
  pastePosition,
  pushHistory,
  sameBoxes,
  TEXT_BACKGROUND_DEFAULT_COLOR,
  type PendingTextSave,
  type TextLayerTask,
} from "./editor/textBoxModel.js";
import {
  normalizeWheelDelta,
  WHEEL_GESTURE_GAP_MS,
  WHEEL_MAX_LOCK_MS,
  WHEEL_PAGE_LOCK_MS,
  WHEEL_PAGE_THRESHOLD_PX,
} from "./editor/wheel.js";
import {
  briefPatchWithoutWebSearch,
  confirmStyleReplacement,
  currentImage,
  duration,
  isPdfImportProject,
  isPdfImportVersion,
  styleOptions,
  versionDeleteConfirmText,
  PHASE_LABELS,
  VERSION_DELETE_MESSAGES,
  type CombinationSummary,
} from "./editor/projectHelpers.js";
import {
  mergePageNumber,
  PAGE_NUMBER_DEBOUNCE_MS,
  type PageNumberPatch,
} from "./editor/pageNumberModel.js";
import { useIsomorphicLayoutEffect } from "./editor/useIsomorphicLayoutEffect.js";
import { useDialogEscape } from "./editor/dialogEscape.js";
import { useWebSearchToggle, WebSearchToggle } from "./editor/webSearch.js";
import { SlideVisibilityIcon, TextToolIcon } from "./editor/icons.js";
import { SlideSourceChips } from "./editor/SlideSourceChips.js";
import { TextLayerCanvas } from "./editor/TextLayerCanvas.js";

/*
 * 拆檔後的 re-export：`Editor.tsx` 對外的符號面必須與拆分前逐一相同——測試檔與
 * library build 的 `index.ts` 全部 import 自 `./Editor.js`，改路徑等於改對外契約。
 */
export {
  firstPresentableIndex,
  hiddenSlideCount,
  nextVisibleIndex,
  visibleSlideIds,
} from "./editor/slideVisibility.js";
export { batchExtractPlan, type BatchExtractPlan } from "./editor/extractionPlan.js";
export { strokeCssColor, textBoxBackground } from "./editor/textBoxModel.js";
export { TextLayerCanvas } from "./editor/TextLayerCanvas.js";

// 錯誤通知列已抽到 `./ErrorToast.tsx`（連同它那份「為什麼是 div 包 button 而不是
// button[role=alert]」的說明）：模型庫與風格編輯器各自寫了一份形狀不同的 toast，而稽核抓到的
// 問題正是同一份 UI 漂移成多份拷貝（其中兩份漏了 role="alert"）。理由只留在元件那一份，
// 這裡不再複述——同一段理由的兩份拷貝遲早會有一份先過期。

/**
 * 系統設定對話框。
 *
 * `error` 是**模態內**的失敗訊息，不能改用全域的 `ErrorToast`：`.toast` 是 `z-index: 20`、
 * `.system-settings-backdrop` 是 `z-index: 940`，而兩者同為 `.shell` 的子節點（`.shell` 沒有
 * transform／filter／contain，不建立 stacking context），所以 toast 會被鋪在遮罩底下。使用者
 * 只會看到勾選框閃一下就彈回原狀、毫無說明；jsdom 沒有版面，測試還照樣是綠的。模態內的失敗
 * 就在模態內講，不要改成把全域 toast 的 z-index 拉高（那等於讓錯誤浮在遮罩上、蓋住對話框）。
 */
export function SystemSettingsDialog({
  webSearchEnabled,
  webSearchBusy,
  onWebSearchToggle,
  combinations,
  combinationId,
  onCombinationId,
  onOpenModelLibrary,
  onClose,
  error,
}: {
  webSearchEnabled: boolean;
  webSearchBusy: boolean;
  onWebSearchToggle: (next: boolean) => void;
  combinations: CombinationSummary[];
  combinationId: string | undefined;
  onCombinationId: (value: string) => void;
  onOpenModelLibrary: () => void;
  onClose: () => void;
  error: string | undefined;
}) {
  const defaultCombination = combinations.find((item) => item.isDefault);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 焦點契約與 Escape：兩者都缺會讓「按齒輪 → 改一個設定 → 想收掉」變成無路可退——
  // Esc 沒反應、Tab 走出對話框到那片已宣告為不存在的頁面、關掉之後焦點掉回 <body>。
  useDialogA11y(dialogRef, true);
  useDialogEscape(onClose);
  return (
    <div
      ref={dialogRef}
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
        {/* 舊版是 live／cached／disabled 三選一，但 live 與 cached 在伺服器端行為完全相同
            （只有 disabled 會跳過搜尋），留著三個選項只是讓人以為有差別。 */}
        <WebSearchToggle
          className="system-settings-toggle"
          enabled={webSearchEnabled}
          busy={webSearchBusy}
          disabled={false}
          onToggle={onWebSearchToggle}
        />
        {error && (
          <p className="system-settings-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="system-settings-link" onClick={onOpenModelLibrary}>
          管理模型組合（模型庫）→
        </button>
      </div>
    </div>
  );
}

/**
 * 批次生成遇到隱藏頁時，使用者選了什麼。
 *
 * `"all"` 刻意對應「不傳 `slideIds`」而不是「傳全部 id」：那是加入這個對話框之前的行為，
 * 沒有隱藏頁的專案完全不會走到這裡，兩條路才會逐位元相同。
 */
type BatchGenerateChoice = "all" | "visible-only";

/**
 * 這個三選一問的是哪一種批次。
 *
 * 兩者的成本結構相同（隱藏頁不進成品，但處理它一樣燒一次影像模型配額），差別只在動詞與
 * 分母的意義：`generate` 的分母是整份簡報的頁數，`extract` 的分母是這次要抽字的頁數
 * （已經有文字層、還沒有圖的頁根本不在名單裡）。
 */
type BatchChoiceVariant = "generate" | "extract";

// 沒有獨立的 `label` 欄位：對話框的名稱直接指向畫面上的 `heading`，兩份字串必然一致。
const BATCH_CHOICE_COPY: Record<
  BatchChoiceVariant,
  { heading: string; visibleOnly: string; all: string }
> = {
  generate: {
    heading: "要連隱藏頁一起生成嗎？",
    visibleOnly: "只生成可見頁",
    all: "含隱藏頁一起生成",
  },
  extract: {
    heading: "要連隱藏頁一起抽離文字嗎？",
    visibleOnly: "只抽可見頁",
    all: "含隱藏頁一起抽",
  },
};

/**
 * 有隱藏頁、而且這次動作會為每一頁燒配額時，按下去要先問清楚要不要連隱藏頁一起做。
 *
 * 為什麼要問而不是只告知：隱藏頁不進 `pptx`／`pdf`、也不放映，但處理它一樣消耗影像模型
 * 配額——「全部頁面」這個字面承諾與「隱藏」這個意圖在這裡直接衝突，兩種答案都合理，
 * 所以是使用者的決定。`confirm()` 只有兩個答案，裝不下三選一。
 *
 * 三個呼叫點（inspector 的批次生成、精靈的確認生成、inspector 的批次抽字）共用這一份，
 * 不各寫一個。抽字只有在抹字引擎是**生圖模型**時才走這裡；OpenCV 在本機跑、不吃配額，
 * 沒有取捨可問，多一次點擊只是純粹的阻礙。
 */
function BatchGenerateDialog({
  total,
  hiddenCount,
  busy,
  variant = "generate",
  body,
  onChoose,
  onCancel,
}: {
  total: number;
  hiddenCount: number;
  busy: boolean;
  variant?: BatchChoiceVariant;
  /** 覆寫說明段落；省略時用批次生成那一段。 */
  body?: ReactNode;
  onChoose: (choice: BatchGenerateChoice) => void;
  onCancel: () => void;
}) {
  const copy = BATCH_CHOICE_COPY[variant];
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useDialogA11y(dialogRef, true);
  // 忙碌守衛與遮罩點擊那道一致：整批已經在送出時關掉畫面不會取消任何東西。
  useDialogEscape(onCancel, busy);
  return (
    <div
      className="confirm-backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog choices"
        role="dialog"
        aria-modal="true"
        /*
         * 名稱指向畫面上那個 `<h2>`，不另外寫一份 `aria-label`：舊寫法的 `copy.label`
         * （「批次生成與隱藏頁」）與標題（「要連隱藏頁一起生成嗎？」）是兩串不同的字，
         * 聽到的和看到的對不起來，使用者無從確認自己在回答哪一個問題。
         */
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={headingId}>{copy.heading}</h2>
        <p>
          {body ?? (
            <>
              這份簡報共 <strong>{total}</strong> 頁，其中 <strong>{hiddenCount}</strong> 頁已隱藏。
              隱藏頁不會進 pptx／pdf 匯出，也不會出現在簡報放映中，但生成它一樣會消耗影像模型配額。
            </>
          )}
        </p>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" disabled={busy} onClick={() => onChoose("visible-only")}>
            {copy.visibleOnly}（{total - hiddenCount} 頁）
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => onChoose("all")}>
            {copy.all}（{total} 頁）
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 系統合成的頁碼，畫在畫布與簡報模式的圖片之上。
 *
 * 幾何與文字都來自 core 的 `pageNumberLayout`，與匯出端是同一份計算，預覽才會與匯出落點一致。
 * 尺寸一律用容器查詢單位（外層是 `container-type: size` 的畫布）——畫布是縮放顯示的，
 * 寫死 px 會讓頁碼在小視窗變得比匯出結果大得多。
 *
 * 收的是 `order` 而不是「第幾個」：可見序號由 `pageNumberSlideLabel` 從整份 `slides` 算，
 * 這一端不得自行扣掉隱藏頁（那會變成第五份規則）。
 */
export function PageNumberOverlay({
  project,
  order,
}: {
  project: PresentationProject;
  order: number;
}) {
  const label = pageNumberSlideLabel(project.pageNumber, project.slides, order);
  if (!label) return null;
  const { width, height } = project.canvas;
  const { text, chip } = pageNumberLayout(project.pageNumber, project.canvas, label);
  return (
    <div className="page-number-layer">
      {chip && (
        <div
          className="page-number-chip"
          style={{
            left: `${(chip.x / width) * 100}%`,
            top: `${(chip.y / height) * 100}%`,
            width: `${(chip.width / width) * 100}%`,
            height: `${(chip.height / height) * 100}%`,
            borderRadius: `${(chip.radius / height) * 100}cqh`,
            background: chip.color,
            opacity: chip.opacity,
          }}
        />
      )}
      <div
        className="page-number-text"
        style={{
          left: `${(text.x / width) * 100}%`,
          top: `${(text.y / height) * 100}%`,
          width: `${(text.width / width) * 100}%`,
          height: `${(text.height / height) * 100}%`,
          justifyContent:
            text.align === "center" ? "center" : text.align === "right" ? "flex-end" : "flex-start",
          fontFamily: text.fontFamily,
          fontSize: `${(text.fontSize / height) * 100}cqh`,
          fontWeight: text.fontWeight,
          lineHeight: text.lineHeight,
          color: text.color,
          opacity: text.opacity,
        }}
      >
        {label}
      </div>
    </div>
  );
}

/**
 * 受控、但延後送出的整數輸入框。
 *
 * 每個 keystroke 就送出去的話，「30 → 45」這種兩位數修改永遠打不進去：伺服器先收到的是
 * `4`，違反 `min` 被擋成 400，受控 input 當場被打回舊值——12–120 這種區間裡每個值的
 * 首位數字都小於下界，必中。清空欄位同理（`Number("") === 0`）。
 * 因此打字期間只動本地 draft，失焦或按 Enter 才夾進合法區間送出；空字串與非數字一律還原。
 */
export function ClampedNumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // 值從外部變動（切換專案、送出後伺服器夾過的結果）時同步回 draft。
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const parsed = Number(draft.trim());
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
        }}
      />
    </label>
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
  const [selection, setSelection] = useState<MaskSelection>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape 已由 `Editor` 的集中式鏈處理（它有 `imageEditBusy` 守衛），這裡只補焦點。
  // 說明欄的 `autoFocus` 不會被搶走：hook 只在焦點還沒進到對話框裡時才主動聚焦。
  useDialogA11y(dialogRef, true);
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
    if (!supportsMask) return;
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
      ref={dialogRef}
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
            selection ? canvasRef.current?.toDataURL("image/png") : undefined,
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
        <div className={`image-mask-stage ${supportsMask ? "masking" : ""}`}>
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
          {selection && (
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
          {supportsMask && !selection && <span>拖曳框選要修改的區域（不框選＝整張套用）</span>}
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
          {supportsMask ? (
            <>
              <small>
                {selection
                  ? "框內可修改，框外保留原圖；可直接拖曳重選"
                  : "直接在圖上拖曳即可限定修改範圍"}
              </small>
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
          <button className="primary" disabled={busy || !instruction.trim()}>
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
  // 隱藏頁只有「返回修改需求」回到精靈時才可能存在（大綱是在編輯器裡才隱藏得了頁面的）。
  // 數的是 project.slides 而不是 outline 草稿：`generateAll` 作用的是伺服器上那一份。
  const hiddenCount = hiddenSlideCount(project.slides);
  const [askBatchChoice, setAskBatchChoice] = useState(false);
  const [showRequirements, setShowRequirements] = useState(
    project.workflowStage === "requirements",
  );
  // requirements 階段拆成兩個客戶端子步驟：false=填需求（brief），true=上傳素材。
  // 素材上傳後才產大綱，讓大綱一開始就被素材 grounding。
  const [materialsSubstep, setMaterialsSubstep] = useState(false);
  const providerRef = useRef<HTMLElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const webSearch = useWebSearchToggle(project, onProject, onError);
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
  /*
    重新播種 brief 草稿的依賴是「伺服器上這份 brief 的**草稿欄位**指紋」，而不是 `project.brief`
    的物件識別：那個物件每次 `onProject` 都是新的，於是 STEP 3 的任何動作（上傳素材、切換自動
    搜尋）都會把使用者在 STEP 2 打到一半、還沒按「下一步」的輸入洗掉。`webSearchMode` 不列入
    指紋——它由勾選框獨佔、不屬於這份草稿（送出時也會被 `briefPatchWithoutWebSearch` 剝掉），
    列進去等於讓「切換自動搜尋」重新獲得清空草稿的能力。
  */
  const serverBriefKey = JSON.stringify({ ...project.brief, webSearchMode: null });
  useEffect(() => {
    setBrief(structuredClone(project.brief));
  }, [project.id, serverBriefKey]);
  useEffect(() => {
    setOutline(structuredClone(project.slides));
  }, [project.id, project.workflowStage]);
  useEffect(() => {
    if (project.workflowStage === "requirements") setShowRequirements(true);
  }, [project.id, project.workflowStage]);

  // 關閉自動搜尋時網路來源不存在，沒有素材就沒有任何可 grounding 的內容，故擋住產生大綱。
  // 解析失敗（status: "failed"）的素材抽不出任何內容，不算數；圖片等其他狀態都算。
  const materialsRequired =
    !webSearch.enabled && !project.sources.some((source) => source.status !== "failed");

  const produceOutline = async () => {
    setBusy(true);
    onError("");
    try {
      const withBrief = await api.updateBrief(project.id, briefPatchWithoutWebSearch(brief));
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

  const confirmAndGenerate = async (choice: BatchGenerateChoice = "all") => {
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
          pinnedSourceIds: slide.pinnedSourceIds,
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
      // slideIds 同理只在「只生成可見頁」時才傳，"all" 走的是加入隱藏頁之前的同一條路。
      await api.generateAll(
        project.id,
        undefined,
        acceptUnknownReadiness,
        choice === "visible-only" ? visibleSlideIds(updated.slides) : undefined,
      );
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
              文件、圖片、貼上文字或加入搜尋資料都會建立索引；產生大綱與後續生成時即可引用。開啟自動搜尋網路資源時，這一步可略過；關閉時必須至少提供一項素材。
            </p>
            <SourcePanel project={project} onProject={onProject} onError={onError} />
            {materialsRequired && (
              <p className="setup-materials-hint" id="setup-materials-hint">
                已關閉自動搜尋，請先上傳或貼上至少一項素材再產生大綱。
              </p>
            )}
            <div className="setup-materials-actions">
              <button
                type="button"
                className="setup-back"
                disabled={busy}
                onClick={() => setMaterialsSubstep(false)}
              >
                <span>←</span> 上一步
              </button>
              <div className="setup-materials-submit">
                <WebSearchToggle
                  className="setup-websearch-toggle"
                  enabled={webSearch.enabled}
                  busy={webSearch.busy}
                  disabled={busy}
                  onToggle={webSearch.toggle}
                />
                <button
                  className="primary setup-submit"
                  disabled={busy || !brief.topic.trim() || materialsRequired}
                  // 停用按鈕本身不會說明原因，讀屏使用者需要指回那句提示。
                  aria-describedby={materialsRequired ? "setup-materials-hint" : undefined}
                  onClick={() => void produceOutline()}
                >
                  {busy ? "正在產生大綱…" : `產生 ${brief.desiredSlideCount} 頁大綱`}
                  <span>→</span>
                </button>
              </div>
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
                  .updateBrief(project.id, briefPatchWithoutWebSearch(brief))
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
                    <SlideSourceChips
                      groupId={slide.id}
                      sources={project.sources}
                      selection={slide}
                      onToggle={(sourceId) =>
                        setOutline(
                          outline.map((item) =>
                            item.id === slide.id ? toggleSourcePin(item, sourceId) : item,
                          ),
                        )
                      }
                    />
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
              // 有隱藏頁就先問，而且是在整條 async 鏈**開始之前**問掉：鏈中途彈窗會讓
              // 「已經寫回去的大綱」與「還沒決定要不要生成」兩件事同時懸在半空。
              // 沒有隱藏頁時完全不多一次點擊，與加入這個對話框之前一致。
              onClick={() => {
                if (hiddenCount > 0) setAskBatchChoice(true);
                else void confirmAndGenerate("all");
              }}
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
      {askBatchChoice && (
        <BatchGenerateDialog
          total={project.slides.length}
          hiddenCount={hiddenCount}
          busy={busy}
          onCancel={() => setAskBatchChoice(false)}
          onChoose={(choice) => {
            setAskBatchChoice(false);
            void confirmAndGenerate(choice);
          }}
        />
      )}
    </main>
  );
}

export function Editor() {
  const [route, setRoute] = useState(() => window.location.pathname);
  const [projects, setProjects] = useState<PresentationProject[]>([]);
  const [project, setProject] = useState<PresentationProject>();
  const projectId = project?.id;
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<SlideSpec>();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [styles, setStyles] = useState<StylePreset[]>([]);
  const [panel, setPanel] = useState<"slide" | "project" | "sources" | "export">("slide");
  // 收起側邊欄只縮版面、不卸載面板內容（見 styles.css 的 .inspector-collapsed）：
  // 面板裡有未存檔的大綱草稿與捲動位置，收合一次就清掉等於懲罰使用者把畫布放大。
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [briefDraft, setBriefDraft] = useState<PresentationBrief>();
  const [draggedId, setDraggedId] = useState<string>();
  const [showSystemSettings, setShowSystemSettings] = useState(false);
  // 系統設定對話框自己的錯誤訊息；為什麼不共用全域 toast 見 `SystemSettingsDialog` 的 JSDoc。
  const [systemSettingsError, setSystemSettingsError] = useState<string>();
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
  const stylePickerRef = useRef<HTMLDivElement>(null);
  // 風格選擇是這個檔案裡唯一以 inline JSX 渲染的對話框，所以 ref 與焦點 hook 只能宣告在
  // 這裡——它必須排在下面那幾條 early return（/models、/styles）之前，hook 順序才不會錯位。
  useDialogA11y(stylePickerRef, !!stylePickerVersion);
  const [newSlideBusy, setNewSlideBusy] = useState(false);
  const [showImageEdit, setShowImageEdit] = useState(false);
  const [imageEditBusy, setImageEditBusy] = useState(false);
  /**
   * 「生成此頁」自己的 busy。
   *
   * 不能只看 `activeJob`：`generate()` 要跑完 readiness → save → generate → getProject
   * 四趟往返，`activeJob` 才會出現，這段空窗按鈕是亮的，連按兩下就排得出兩個 job（各燒一次
   * 影像模型配額）。批次抽字那顆早就學到這件事（見 `runBatchTextExtraction` 的註解），
   * 這裡與下面的批次生成只是把同一個教訓補上。
   */
  const [generateBusy, setGenerateBusy] = useState(false);
  /** 批次生成的本地 busy；理由同上，`project.jobs` 要等 `getProject` 回來才有東西。 */
  const [batchGenerateBusy, setBatchGenerateBusy] = useState(false);
  /**
   * Brief 面板正在跑的動作。
   *
   * 「依 Brief 重建大綱」會跑一次網路搜尋加兩階段大綱生成，實測數十秒到數分鐘，而在此之前
   * 它不 disabled、文案不變、也沒有進度——使用者必然再按一次，**每一次都重跑一整輪搜尋與
   * 模型呼叫**，最後幾筆回應還會互相覆蓋掉剛生出來的大綱。分成兩種而不是一個 boolean，
   * 是為了讓按鈕文案講得出正在做的是哪一件事。
   */
  const [briefBusy, setBriefBusy] = useState<"save" | "regenerate">();
  /**
   * 縮圖列的頁面操作（排序、隱藏、複製、刪除）正在寫入。
   *
   * 一個共用旗標而不是逐頁逐動作各一個：這四件事都會改動 `project.slides` 整個陣列，兩個
   * 在飛的請求誰後回誰算數。實測後果最明顯的是複製——連點兩下就得到兩份副本。
   */
  const [thumbBusy, setThumbBusy] = useState(false);
  /**
   * 同一件事的 ref 版本，給 `runThumbAction` 的函式內守衛用。
   *
   * 讀 state 的那個版本在它聲稱要處理的情境下必定是 no-op：兩下點擊之間如果 React 還沒
   * 重新 render，handler 閉包裡的 `thumbBusy` 就還是同一個過期的 `false`。ref 沒有這個問題。
   */
  const thumbBusyRef = useRef(false);
  /** 取消生成也會連按：它不 disabled、也不改文案，看起來就像沒反應。 */
  const [cancelBusy, setCancelBusy] = useState(false);
  /** 大綱欄位「與目前圖片不同步」那句說明的 id，供 dirty 欄位的 `aria-describedby` 指過去。 */
  const outlineDirtyNoteId = useId();
  // 批次生成遇到隱藏頁時的三選一確認框；沒有隱藏頁時永遠不會被打開。
  const [askBatchChoice, setAskBatchChoice] = useState(false);
  const [previewVersionId, setPreviewVersionId] = useState<string>();
  // 正在刪除中的版本 id：刪除鈕不 disable 的話，連點第二下會對已刪掉的版本再送一次
  // DELETE，使用者看到的是刪除成功後跳出 NOT_FOUND 錯誤。
  const [deletingVersionId, setDeletingVersionId] = useState<string>();
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [textBoxes, setTextBoxes] = useState<EditableTextBox[]>([]);
  // 使用者是否編輯過目前版本的文字圖層；未編輯前自動儲存不得寫回伺服器（見自動儲存 effect）。
  const textDirty = useRef(false);
  /**
   * 還沒送到伺服器的文字圖層變更（`undefined` ＝ 沒有待寫入的東西）。
   *
   * 連 slide／version id 一起記，是因為換頁時的 flush 會在 `textBoxes` 已經換成新頁之後
   * 才有機會跑；只有這份快照能把「舊那頁」的內容送回「舊那頁」去。與 `textDirty`
   * 是同一件事的兩面，重新播種時要一起歸零。
   */
  const pendingTextSave = useRef<PendingTextSave>(undefined);
  const [selectedTextId, setSelectedTextId] = useState<string>();
  /**
   * 手動建立文字編輯版本後要選中的那個框。
   *
   * 走 ref 而不是在回應裡直接 `setSelectedTextId`：新版本一換上來，下面重新播種的 effect
   * 就會跑，而它會把選取清成 undefined（effect 永遠在同一批 setState 之後）。交給那個
   * effect 消化，選取才留得住。
   *
   * 連 versionId 一起記，是因為「設下這個 ref」與「重新播種的 effect 消化它」之間沒有保證
   * 一定接得上：使用者在請求飛行途中換頁時，回應寫回的是別頁的專案，重新播種不會跑，
   * 這個 ref 就留到下一次換頁才被讀到——那時它已經是別的版本裡不存在的 id。
   */
  const pendingTextSelect = useRef<{ versionId: string; boxId: string }>(undefined);
  const [textThreshold, setTextThreshold] = useState(0.75);
  const [showTextThreshold, setShowTextThreshold] = useState(false);
  /**
   * TEXT BOX 面板裡哪一個效果的下拉開著（`undefined` ＝都關著）。
   *
   * 用單一狀態而不是讓兩列各記各的：兩個下拉同時浮在畫面上會互相重疊，而且使用者
   * 一次只調得動一個。狀態掛在 Editor、不逐框記，換選文字框時由 `setSelectedTextId`
   * 那邊一起關掉——留著的話下拉會浮在原地卻改到另一個框的參數。
   */
  const [openTextEffect, setOpenTextEffect] = useState<"background" | "stroke">();
  /*
   * 換選文字框就把下拉關掉。用 effect 收斂在一處，而不是在每個 `setSelectedTextId` 呼叫點
   * 補一行——選取的入口有畫布點擊、鍵盤、貼上、復原、切頁等好幾條，漏掉任何一條都會讓
   * 下拉浮在原地卻改到另一個框的參數（而且它是 fixed 定位的，連位置都不會跟著移）。
   */
  useEffect(() => setOpenTextEffect(undefined), [selectedTextId]);
  // 抹字引擎：本地 OpenCV inpaint（快、零配額，預設）或專案組合的生圖模型。
  const [textExtractEngine, setTextExtractEngine] = useState<"opencv" | "model">("opencv");
  // 文字修復：預設關（OCR 讀到什麼就是什麼）。「大綱修復」拿這頁的大綱回頭改 OCR 的字，
  // 圖上文字逐字來自大綱時能修好空格與誤認字，否則會把正確的字換成大綱裡的相似片段。
  const [textRepair, setTextRepair] = useState<"off" | "outline">("off");
  // 簡體轉繁體：預設開。PaddleOCR 的中文模型是簡體語料訓練出來的，讀繁體投影片會零星
  // 吐出簡體字形；只替換「簡體專屬字」，繁體中本來就合法的字形（台／里／面／后／干）不動。
  const [traditionalize, setTraditionalize] = useState(true);
  /**
   * 「批次抽離全部文字」的進度（`undefined` ＝ 沒有在跑）。`current` 是**正在處理**的第幾頁
   * （1-based），不是已完成數：使用者盯著的是「現在卡在哪一頁」。
   */
  const [batchExtract, setBatchExtract] = useState<{
    current: number;
    total: number;
    /** 使用者已經按過「停止」：按鈕要改口，但當前這一頁還在飛。 */
    stopping: boolean;
  }>();
  /**
   * 批次抽字的「不要再送下一頁」旗標。
   *
   * 走 ref 而不是 state：整批是一個長壽的 async 迴圈，它閉包裡抓到的 state 永遠是按下開始
   * 那一刻的值，使用者後來按「停止」它一輩子讀不到。
   *
   * 只有「不再送出下一頁」的語意，**沒有取消**：抽字端點刻意沒有取消機制（見
   * `apps/server/src/ocr-queue.ts`），已經在飛的那一頁會做完、抹字 job 照建、版本照落地。
   * 不要「改進」成 `AbortController` 假裝取消得掉——那只會讓伺服器算完的 4GB OCR 成果沒人收，
   * 使用者回來看到的是什麼都沒發生。
   *
   * 分兩種而不是 boolean：`"user"` 是使用者按停止（做完當前這一頁、寫回結果、報告中止），
   * `"left"` 是元件卸載或換了專案（連當前這一頁的結果都不可以寫回去——那會把 A 專案的內容
   * 蓋到 B 專案的畫面上）。
   */
  const batchExtractStop = useRef<"user" | "left">(undefined);
  /**
   * 畫面上「現在是哪一份專案」，由上面那個 layout effect 在 commit 期間同步更新。
   * 批次抽字每一次寫回之前都拿它與**呼叫當下**的 id 比對。
   */
  const activeProjectId = useRef<string>(undefined);
  /** 抹字引擎是生圖模型、又有隱藏頁時，開三選一對話框問要不要連隱藏頁一起抽。 */
  const [askBatchExtractChoice, setAskBatchExtractChoice] = useState(false);
  /**
   * 文字圖層正在跑的工作，**逐頁**記錄（key 是 slide id）。
   *
   * 分成三種而不是一個 boolean：三者耗時與意義都不同——`save` 是每次編輯後的自動儲存重繪
   * （伺服器重跑合成），`extract` 是抽離文字（OCR＋抹字，可能數十秒），`create` 是在沒有
   * 文字層的版本上建立文字編輯版本（一次合成＋開版本）。只報「處理中」等於把幾件事混成
   * 一句話，使用者無從判斷該不該等。
   *
   * 以前是編輯器層級的單一 state，那會讓工作跟著使用者跑：A 頁的抽字還沒回來時，切到 B 頁
   * 那顆抽字鈕也是灰的，而「正在抽取文字…」的進度條會顯示在 B 頁的畫布上——兩件事都在說謊。
   * 這些工作本來就是綁在某一頁上的，state 也照著綁。
   */
  const [textLayerTasks, setTextLayerTasks] = useState<ReadonlyMap<string, TextLayerTask>>(
    () => new Map(),
  );
  const trackTextLayerTask = (slideId: string, task: TextLayerTask | undefined) =>
    setTextLayerTasks((current) => {
      if (current.get(slideId) === task) return current;
      const next = new Map(current);
      if (task) next.set(slideId, task);
      else next.delete(slideId);
      return next;
    });
  const [textUndo, setTextUndo] = useState<EditableTextBox[][]>([]);
  const [textRedo, setTextRedo] = useState<EditableTextBox[][]>([]);
  /**
   * 文字框剪貼簿。放 ref 而不是 state：它不影響任何畫面，進 state 只是讓每次複製多跑一輪 render。
   * 也刻意不隨投影片重置——使用者複製一個文字框後常常是要貼到別頁去。
   */
  const textClipboard = useRef<EditableTextBox>(undefined);
  // 縮圖列容器：切換投影片時把選取項捲進可視範圍。
  const railRef = useRef<HTMLDivElement>(null);
  /**
   * 文字工具列要不要改成畫布下方的橫排（決策見 canvasRowLayout.ts）。
   *
   * 元素本身走 callback ref 存進 state 而不是 `useRef`：畫布列會隨著離開專案回到列表
   * （`!project`）、切到精靈或 PDF 分析頁（`workflowStage !== "editing"`）而整個卸載再換一個
   * 新節點回來，工具列則跟著「這一頁有沒有圖」進出。用 ref 的話 effect 不會知道元素換了人，
   * ResizeObserver 會留在一個已經脫離文件的節點上，之後永遠不再更新。
   * （簡報模式不在此列：它是 `position: fixed` 的 overlay，`.canvas-row` 全程掛著。）
   */
  const [canvasRowElement, setCanvasRowElement] = useState<HTMLDivElement | null>(null);
  const [textRailElement, setTextRailElement] = useState<HTMLDivElement | null>(null);
  const [stackTextRail, setStackTextRail] = useState(false);
  const canvasAspect = project ? project.canvas.width / project.canvas.height : undefined;
  /**
   * 刻意是 layout effect 而不是 passive effect：passive effect 在瀏覽器繪製之後才跑，
   * 開專案、從專案列表返回、換一個不同比例的專案時，第一幀會先用上一次的方向畫出來、
   * 下一幀才翻正，使用者看到的就是畫布寬度跳一下——正是工具列改成常駐佔位時花力氣消掉的
   * 那個現象（見下方 `.text-layer-rail` 的註解）。量測本來就要在 commit 之後、繪製之前做。
   */
  useIsomorphicLayoutEffect(() => {
    if (!canvasRowElement || canvasAspect === undefined) return;
    const measure = () => {
      setStackTextRail(
        shouldStackTextRail(
          measureCanvasRowLayout(canvasRowElement, textRailElement, canvasAspect),
        ),
      );
    };
    measure();
    // jsdom 沒有 ResizeObserver。測試環境本來就沒有版面（量到的全是 0），量一次就停手。
    if (typeof ResizeObserver === "undefined") return;
    /**
     * 只觀察 `.canvas-row` 一個節點。
     *
     * **不可以改成觀察畫布欄或工具列**：那兩者的尺寸正是這個決策的產物，決策一改它們就變，
     * 變了又餵回決策，切換之後條件翻轉就會來回抖動（觀察者迴圈）。`.canvas-row` 是
     * `flex: 1 1 auto` 撐滿舞台，尺寸不受內部工具列方向影響，所以它是唯一穩定的輸入。
     */
    const observer = new ResizeObserver(measure);
    observer.observe(canvasRowElement);
    return () => observer.disconnect();
  }, [canvasRowElement, textRailElement, canvasAspect]);
  // 編輯區滾輪切換頁面的冷卻時間戳，避免慣性滾動一次跳好幾頁。
  const wheelCooldown = useRef(0);
  /**
   * 簡報模式滾輪換頁的手勢狀態。
   *
   * 放在 ref 而不是 effect 的區域變數：換頁會改 `presentationIndex`，effect 因此重掛，
   * 區域變數會連同冷卻與累積量一起被重置，慣性尾巴就攔不住了。
   */
  const presentationWheel = useRef({ accumulated: 0, lastEventAt: 0, lockUntil: 0, lockCap: 0 });
  /**
   * 頁碼設定的樂觀本地值（未定義代表「就用伺服器上那份」）。
   *
   * 滑桿拖一次會連發數十個 change，每一次都送 PATCH 等於讓
   * `repository.updateProject`（取檔鎖 → 讀 project.json → 全量 zod 驗證 → 原子寫）跑數十趟；
   * 150 頁 PDF 匯入專案的 project.json 相當大。連續型控制項因此先寫進這裡讓畫布即時反應，
   * 真正的請求 debounce 之後只送最後一次。
   */
  const [pageNumberDraft, setPageNumberDraft] = useState<PageNumberSettings>();
  /** 遞增的請求序號：debounce 之後仍可能兩筆在途，回應亂序時只認最新那一筆。 */
  const pageNumberSeq = useRef(0);
  const pageNumberTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** 還沒送出的欄位。debounce 期間改到別的欄位要併進同一筆，否則前一筆會被計時器取消掉。 */
  const pageNumberPending = useRef<PageNumberPatch>({});
  // 換專案時丟掉樂觀值與在途請求，免得上一份專案的頁碼設定套到下一份上。
  useEffect(() => {
    setPageNumberDraft(undefined);
    pageNumberPending.current = {};
    return () => {
      pageNumberSeq.current += 1;
      pageNumberPending.current = {};
      if (pageNumberTimer.current === undefined) return;
      clearTimeout(pageNumberTimer.current);
      pageNumberTimer.current = undefined;
    };
  }, [project?.id]);
  /**
   * 離開這份專案（換專案或整個卸載）時，批次抽字不再送出後續頁面，且在途那一頁的結果
   * 不可以寫回來——`setProject` 收到的是**上一份**專案的內容，會直接蓋掉畫面上的新專案。
   * 收尾一律用「呼叫當下」抓下來的 id，這裡只負責記錄「現在畫面上是誰」。
   *
   * **一定要是 layout effect。** passive effect 的 cleanup 是排進 scheduler 的另一個 task 才
   * flush 的，而 `api.getProject()` 的續行走 microtask——換專案的 commit 與那個 flush 之間
   * 隔著一整個空窗，落在裡面的寫回讀到的旗標還是 `undefined`，舊專案照樣蓋上去。layout
   * effect 的 cleanup 在 commit 期間**同步**跑完，換專案這個離散事件結束時旗標必定已經立好。
   *
   * 兩道守衛並存不是重複：`activeProjectId` 是正向的身分比對（換專案），`"left"` 旗標
   * 涵蓋卸載——卸載後沒有新的 effect body 會跑，ref 裡留著的還是舊 id，比對不出來。
   */
  useIsomorphicLayoutEffect(() => {
    activeProjectId.current = project?.id;
    return () => {
      batchExtractStop.current = "left";
    };
  }, [project?.id]);

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
  /*
   * 下面的 UI 一律只看「**這一頁**在跑什麼」。別頁的工作照樣在跑、完成時照樣寫回專案狀態，
   * 只是不該讓這一頁的按鈕變灰、也不該把進度條掛到這一頁的畫布上。
   */
  const textLayerTask = selected ? textLayerTasks.get(selected.id) : undefined;
  const textLayerBusy = textLayerTask !== undefined;
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
   *
   * 手動層要排除，理由與 `versionDeleteConfirmText` 那個 `origin !== "manual"` 同一個
   * spread 陷阱：手動層的新版本是 `{ ...原版本 }` 複製出來的，在 PDF 匯入的原圖上手動加字
   * 就同時滿足 `isPdfImportVersion() && textLayer`。那份文字不是 PDF 的原生文字層，字型
   * 沒有被收斂過，而提示說的「切回原始頁面版本就保真」在這裡等於叫使用者丟掉剛打的字。
   * 更糟的是這是 localStorage 記住的一次性提示：在這裡被看掉、按掉，真正的 PDF 文字版本
   * 就永遠不會再提示。
   */
  const pdfFontNotice = useOneTimeNotice("pdf-import-text-layer-font");
  const showPdfFontNotice =
    !!activeTextLayer &&
    activeTextLayer.origin !== "manual" &&
    isPdfImportVersion(selectedVersion) &&
    pdfFontNotice.pending;
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
    // 剛手動建立的框要保住選取（見 `pendingTextSelect`）；其餘情形一律清空。
    const pendingSelect = pendingTextSelect.current;
    pendingTextSelect.current = undefined;
    setSelectedTextId(
      pendingSelect && pendingSelect.versionId === selectedVersion?.id
        ? pendingSelect.boxId
        : undefined,
    );
    setTextUndo([]);
    setTextRedo([]);
    textDirty.current = false;
    // 待寫入的變更跟著作廢：重新播種的來源就是伺服器上的最新內容（重新抽離會沿用同一個
    // version id，只換 extractedAt），這時把舊文字框 flush 回去會蓋掉剛抽出來的結果。
    pendingTextSave.current = undefined;
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
      JSON.stringify(draft.sourceIds) !== JSON.stringify(selected.sourceIds) ||
      JSON.stringify(draft.pinnedSourceIds) !== JSON.stringify(selected.pinnedSourceIds);
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
          pinnedSourceIds: draft.pinnedSourceIds,
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
  // 自動搜尋開關（設計理由見 `useWebSearchToggle` 的 JSDoc）。失敗訊息收在對話框自己身上，
  // 不走全域 toast——理由見 `SystemSettingsDialog` 的 JSDoc。
  const webSearch = useWebSearchToggle(project, setProject, setSystemSettingsError);
  /*
    開啟設定對話框時重抓一次專案。

    自動搜尋是專案設定，別人改過之後這裡要看得到最新值；而下面那條專案輪詢在「沒有 job 也沒有
    來源在分析」時整條 early-return 不跑，所以閒置中的分頁會一直停在開專案當下的值——那正好戳
    中這次改動的立論（畫面上的值與實際生效的值不一致）。開啟當下抓一次是便宜且對症的修法；
    刻意**不**為它加常駐輪詢，那會讓每個開著的分頁固定打專案 JSON，代價遠大於收益。
  */
  useEffect(() => {
    if (!showSystemSettings || !projectId) return;
    // 上一次開著時留下的失敗訊息不該跟著這一次開啟一起出現。
    setSystemSettingsError(undefined);
    let active = true;
    void api
      .getProject(projectId)
      .then((latest) => {
        if (active) setProject(latest);
      })
      .catch(() =>
        active
          ? setSystemSettingsError("讀不到最新設定，以下顯示的可能不是伺服器上的現值。")
          : undefined,
      );
    return () => {
      active = false;
    };
  }, [showSystemSettings, projectId]);
  /**
   * 專案輪詢：生成中的 job，以及背景分析中的來源（上傳圖片後伺服器會跑內容描述）。
   *
   * 圖片描述沿用這同一條輪詢而不是另外架一套通知：它與 job 一樣是「伺服器端非同步完成、
   * 完成後只是專案內容變了」。兩者共用一個 interval，才不會在兩件事同時發生時各自拉一份
   * 專案互相覆寫。間隔看情況：job 要即時看到進度條，描述只要「好了會自己出現」，拉長到
   * 1.5 秒省下大半無謂的請求（一次描述動輒十幾秒，再快也只是白拉專案 JSON）。
   */
  const jobsBusy = !!project?.jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );
  // 分析中的來源只在「還沒超過上限」時才值得輪詢。伺服器被砍在描述途中、或收尾寫入失敗
  // 時，來源會一直是 parsing——沒有上限的話每個開著的分頁都會以 1.5 秒為週期永遠打下去，
  // 而且畫面上完全看不出異常。逾時後停手並改口（見 SourcePanel 的「可能已中斷」），下一次
  // 伺服器啟動本來就會把它修回 indexed。
  // `isDescribing` 只認「用途仍是視覺參考」的 parsing：使用者在排隊期間改掉用途後，那筆
  // 來源要到背景工作輪到它才會收尾，不該為它一直輪詢。
  const sourcesParsing = !!project?.sources.some(
    (source) => isDescribing(source) && !parsingExpired(source, project.sources),
  );
  useEffect(() => {
    if (!project || (!jobsBusy && !sourcesParsing)) return;
    const timer = setInterval(
      () => {
        void api
          .getProject(project.id)
          .then(setProject)
          .catch((reason: unknown) =>
            setError(reason instanceof Error ? reason.message : "更新失敗"),
          );
      },
      jobsBusy ? 700 : 1_500,
    );
    return () => clearInterval(timer);
  }, [project, jobsBusy, sourcesParsing]);
  /**
   * 批次生成收尾時讓用量面板重抓一次（`jobsBusy` 的 **false 邊緣**）。
   *
   * 那一刻正是使用者最想看用量的時候，而面板自己只在掛載與按下「重新整理」時抓——停在
   * 「專案」分頁看著批次跑完的人，數字會停在開跑前。
   *
   * **不可以改成監聽 `project.jobs`**：批次生成每完成一頁就換一次專案物件（上面那條輪詢
   * 每 700 毫秒拉一份），而 `GET /usage` 會先 `await usageLedger.idle()`——那等於在伺服器
   * 最忙的時候對它連打幾十次。這裡也刻意**不開任何定時器**，輪詢只有上面那一條。
   *
   * 換專案時只重設邊緣、不觸發：`project.id` 一變，`UsagePanel` 就被 `key` 重建並自己抓
   * 一次，這裡再遞一個訊號只是同一份資料多打一次；而「上一份專案忙完」對新專案的畫面
   * 也不是有意義的事件。
   *
   * **批次抽字期間整條關掉**（`batchExtractBusy`）。批次**生成**只有一個邊緣：伺服器一次把
   * 所有 job 排進佇列，`jobsBusy` 全程都是 true。批次**抽字**不是——它是前端的逐頁迴圈，每
   * 一頁換來一個抹字 job，那個 job 往往在迴圈等下一頁 OCR 的時候就跑完了，`jobsBusy` 於是
   * 一頁掉一次 false：20 頁就是約 20 次 `GET /usage`，每一次都要 `await usageLedger.idle()`
   * 加一趟完整的專案載入與帳本解析，而抽字按鈕就在「專案」分頁上、面板全程掛著（畫面還會
   * 跟著閃「更新中…」）。收尾補一次即可：批次結束時若還有 job 在飛就不補，等它自己的 false
   * 邊緣，那一份數字才是完整的。
   */
  const [usageRefreshToken, setUsageRefreshToken] = useState(0);
  const batchExtractBusy = batchExtract !== undefined;
  const usageBusyEdge = useRef<{
    projectId: string | undefined;
    busy: boolean;
    batching: boolean;
  }>({
    projectId: project?.id,
    busy: jobsBusy,
    batching: batchExtractBusy,
  });
  useEffect(() => {
    const previous = usageBusyEdge.current;
    usageBusyEdge.current = {
      projectId: project?.id,
      busy: jobsBusy,
      batching: batchExtractBusy,
    };
    if (previous.projectId !== project?.id) return;
    if (batchExtractBusy) return;
    // 批次抽字剛收尾：期間的邊緣全被壓掉了，這裡補上那一次。
    if (previous.batching) {
      if (!jobsBusy) setUsageRefreshToken((token) => token + 1);
      return;
    }
    if (previous.busy && !jobsBusy) setUsageRefreshToken((token) => token + 1);
  }, [project?.id, jobsBusy, batchExtractBusy]);
  useEffect(() => {
    if (!activeJob) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [activeJob?.id]);
  /**
   * 送出一筆待寫入的文字圖層變更（debounce 到期與換頁 flush 共用這條路）。
   *
   * 以物件識別當閘門：兩條路都可能先到，後到的那個必須整筆讓掉，否則同一份內容會送兩次
   * PUT——而每一次 PUT 伺服器都要重跑 `renderComposite()`。錯誤訊息也因此只有一份。
   */
  const saveTextLayer = (pending: PendingTextSave) => {
    if (pendingTextSave.current !== pending) return;
    pendingTextSave.current = undefined;
    trackTextLayerTask(pending.slideId, "save");
    void api
      .updateTextLayer(
        pending.projectId,
        pending.slideId,
        pending.versionId,
        pending.boxes,
        pending.threshold,
      )
      .then(setProject)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "文字圖層自動儲存失敗"),
      )
      // 換頁 flush 也走這條路，所以收尾要用 `pending` 裡的那一頁，不是收尾當下的 `selected`。
      .finally(() => trackTextLayerTask(pending.slideId, undefined));
  };
  useEffect(() => {
    // 只在使用者實際編輯過（textDirty）才儲存：常駐的文字圖層不能把重新播種前的舊狀態寫回伺服器。
    // 刻意不依賴 textEditing——進入歷史版本預覽時，尚未儲存的編輯仍要照常送出。
    if (!project || !selected || !selectedVersion?.textLayer || !textDirty.current) return;
    if (sameBoxes(textBoxes, selectedVersion.textLayer.boxes)) return;
    const pending: PendingTextSave = {
      projectId: project.id,
      slideId: selected.id,
      versionId: selectedVersion.id,
      boxes: textBoxes,
      threshold: textThreshold,
    };
    pendingTextSave.current = pending;
    const timer = setTimeout(() => saveTextLayer(pending), 650);
    return () => clearTimeout(timer);
  }, [
    project?.id,
    selected?.id,
    selectedVersion?.id,
    selectedVersion?.textLayer,
    textBoxes,
    textThreshold,
  ]);
  /**
   * 換頁／換版本（以及整個編輯器卸載）前，把待寫入的變更立刻送出。
   *
   * 少了這一刀，650ms 的 debounce 會在換頁時無聲蒸發：cleanup 先 clearTimeout，緊接著
   * 重新播種的 effect 把 `textDirty` 設回 false、`textBoxes` 換成新頁的內容——那次編輯
   * 既沒送出、也沒保留，更不會報錯。鍵盤快捷鍵讓「Delete → ArrowDown」變成很自然的節奏，
   * 撞上這個空窗遠比用滑鼠點工具列容易。
   *
   * 寫在 cleanup 而不是換頁的 handler 裡，是為了涵蓋所有換頁入口（縮圖列、方向鍵、滾輪、
   * 版本切換、離開專案）。順序是安全的：React 會先跑完整批 effect 的 cleanup 才跑 effect
   * 本體，所以這裡讀到的 `pendingTextSave` 一定還是舊那頁的快照。
   */
  useEffect(() => {
    return () => {
      const pending = pendingTextSave.current;
      if (pending) saveTextLayer(pending);
    };
  }, [selected?.id, selectedVersion?.id]);
  /**
   * 編輯畫布是不是使用者當下真正在互動的那一面。
   *
   * 全域 keydown listener 掛在 window 上，而覆蓋層（簡報模式、影像編輯／風格選擇對話框、
   * 系統設定）與別條路由（模型庫、風格庫）都只是蓋住畫布，不會卸載專案狀態——
   * `textEditing` 仍為 true。不 gate 的話，在簡報模式按 Backspace（PowerPoint／Keynote
   * 的「上一頁」反射動作）會無聲刪掉編輯頁的文字框，650ms 後還自動存回伺服器，
   * 而且簡報換頁改的是 `presentationIndex`、被刪的不一定是正在放映的那頁。
   * Cmd/Ctrl+Z 還原／重做同理：非畫布焦點下誤按會靜默改動並自動存回，覆蓋既有資料。
   * 抽成一份共用判定，是為了不讓它和方向鍵換頁那條 handler 日後各自漂移。
   */
  const canvasIsActiveSurface =
    !!project &&
    project.workflowStage === "editing" &&
    route.startsWith("/projects/") &&
    presentationIndex === null &&
    !showImageEdit &&
    !stylePickerVersion &&
    !showSystemSettings;
  /**
   * 文字歷史的唯一狀態轉移：鍵盤快捷鍵與工具列按鈕都走這裡，避免其中一條漏推另一側
   * 堆疊，或忘了清掉已不在快照裡的選取項。
   *
   * 回傳 false 代表來源堆疊是空的；鍵盤呼叫端靠它決定不攔截瀏覽器原生的 undo／redo。
   */
  const applyTextHistory = useCallback(
    (direction: "undo" | "redo"): boolean => {
      const source = direction === "undo" ? textUndo : textRedo;
      const snapshot = source.at(-1);
      if (!snapshot) return false;
      textDirty.current = true;
      if (direction === "undo") {
        setTextRedo((history) => pushHistory(history, textBoxes));
        setTextUndo((history) => history.slice(0, -1));
      } else {
        setTextUndo((history) => pushHistory(history, textBoxes));
        setTextRedo((history) => history.slice(0, -1));
      }
      setTextBoxes(snapshot);
      if (selectedTextId && !snapshot.some((box) => box.id === selectedTextId))
        setSelectedTextId(undefined);
      return true;
    },
    [selectedTextId, textBoxes, textRedo, textUndo],
  );
  useEffect(() => {
    if (!textEditing) return;
    // 與 Delete／複製貼上、方向鍵換頁共用同一份「畫布是不是當前互動面」判定：漏掉這道
    // gate 時，簡報模式或別條路由誤按 Cmd/Ctrl+Z 會靜默 undo／redo 並自動存回，覆蓋資料。
    if (!canvasIsActiveSurface) return;
    const onUndo = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      // `canvasIsActiveSurface` 只認得這個檔案裡的覆蓋層；別的元件開的對話框要靠即時的
      // DOM 查詢才擋得住（見 `modalDialogOpen`）。排在修飾鍵與 key 判斷**之後**：這是一次
      // `document.querySelector`，放在最前面等於使用者在文字框裡打的每一個字都掃一次 DOM，
      // 而真正需要它的只有 ⌘Z／Ctrl+Z 那一種鍵。
      if (modalDialogOpen()) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !target.closest(".text-layer-canvas") &&
        (target.matches("input, textarea, select") || target.isContentEditable)
      )
        return;
      // 空堆疊時放行，不吞掉瀏覽器原生的 Cmd/Ctrl+Z。
      if (!applyTextHistory(event.shiftKey ? "redo" : "undo")) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onUndo);
    return () => window.removeEventListener("keydown", onUndo);
  }, [applyTextHistory, textEditing, canvasIsActiveSurface]);
  /**
   * 文字框層級的複製／貼上／刪除。
   *
   * `changeTextBoxes` 宣告在這裡（而不是工具列附近）是為了避開 TDZ：`const` 若放在
   * `/models` 那幾個提早 return 之後，走那條路的 render 根本不會初始化它，
   * 而 effect 在那次 render 重新註冊的話，下一次 ⌘V 就會丟
   * `ReferenceError: Cannot access 'changeTextBoxes' before initialization`。
   */
  const changeTextBoxes = (next: EditableTextBox[]) => {
    setTextUndo((history) => pushHistory(history, textBoxes));
    setTextRedo([]);
    textDirty.current = true;
    setTextBoxes(next);
  };
  useEffect(() => {
    if (!textEditing || !project || !canvasIsActiveSurface) return;
    const { width: canvasWidth, height: canvasHeight } = project.canvas;
    const onKeyDown = (event: KeyboardEvent) => {
      // 長按會以 ~30/s 重複觸發：壓兩秒就貼出數十個框，每個都推一筆 undo 歷史，
      // 一次長按足以把 TEXT_HISTORY_LIMIT（60）筆歷史全擠掉——那正是出事時唯一的退路。
      if (event.repeat) return;
      // 對話框開著時 Delete／Backspace 會無聲刪掉背後選中的文字框，並在 650ms 後自動存回
      // 伺服器——這是本檔最貴的一條誤觸，別的元件開的對話框只有即時 DOM 查詢擋得住。
      if (modalDialogOpen()) return;
      if (isTypingTarget(event.target)) return;
      const selectedBox = textBoxes.find((box) => box.id === selectedTextId);
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        // Ctrl+Shift+V 是「貼成純文字」、⌘⌥V 等組合另有其意，一律不搶。
        if (event.shiftKey || event.altKey) return;
        if (key === "c") {
          // 使用者圈選了頁面文字時，要複製的是那段文字而不是整個文字框，放行給瀏覽器。
          if (!selectedBox || window.getSelection()?.toString()) return;
          event.preventDefault();
          textClipboard.current = structuredClone(selectedBox);
          return;
        }
        if (key !== "v") return;
        const source = textClipboard.current;
        if (!source) return; // 剪貼簿空的就放行，不吞掉瀏覽器原生的貼上
        event.preventDefault();
        // 落點由「這一頁現在有哪些框」決定（見 pastePosition）：階梯不記在任何狀態裡，
        // 跨頁往返與重新複製都不會退回被佔住的第一階。
        const copy: EditableTextBox = {
          ...structuredClone(source),
          id: crypto.randomUUID(),
          ...pastePosition(source, textBoxes, canvasWidth, canvasHeight),
        };
        changeTextBoxes([...textBoxes, copy]);
        setSelectedTextId(copy.id);
        return;
      }
      if (event.altKey) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (!selectedBox) return;
      event.preventDefault();
      changeTextBoxes(textBoxes.filter((box) => box.id !== selectedBox.id));
      setSelectedTextId(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // 變更一律走 changeTextBoxes，Ctrl+Z 復原與自動儲存才吃得到這些操作。
  }, [
    textBoxes,
    selectedTextId,
    textEditing,
    canvasIsActiveSurface,
    project?.canvas.width,
    project?.canvas.height,
  ]);
  /**
   * 「使用者主動結束這場放映」的唯一出口。三條**會退出的**路徑（Esc、控制列的關閉鈕、
   * 以 F11／瀏覽器原生方式離開全螢幕）共用這一份，理由與 `nextVisibleIndex` 相同：退出時
   * 要把選取同步成「剛剛在放映的那一頁」，各自複製一份的話，日後只會有一條路被記得改。
   *
   * 退出後選取放映頁，是因為使用者放映到哪就是想從哪繼續編輯；停在進場前那一頁等於
   * 把整段放映的位移丟掉（縮圖列的自動捲入由既有的 `selectedId` effect 處理）。
   *
   * 另外兩種「簡報就這樣沒了」的情形**不走這裡**，各自純清狀態（見下方兩條 effect）：
   * 離開專案／換路由，以及正在放映的那一頁消失。它們不該同步選取——換專案時同步等於
   * 拿舊專案的 index 去改寫新專案的選取，刪頁時那個 index 指向的頁已經不存在了。
   */
  const exitPresentation = useCallback(() => {
    // 放映途中該頁在別的分頁被刪掉、或 index 越界時 slide 是 `undefined`：維持原本選取，
    // 不可寫入 `undefined`——那會讓 `selected` 退回 `slides[0]`，等於無故跳到第一頁。
    const presentedId =
      presentationIndex === null ? undefined : project?.slides[presentationIndex]?.id;
    if (presentedId) setSelectedId(presentedId);
    setPresentationIndex(null);
    // 走 fullscreenchange 進來時全螢幕已經退掉了，`fullscreenElement` 是 null，這段自動跳過。
    if (document.fullscreenElement && document.exitFullscreen)
      void document.exitFullscreen().catch(() => undefined);
  }, [presentationIndex, project]);
  /**
   * 離開這個專案（換專案、按瀏覽器上一頁回專案列表、切到模型庫／風格庫路由）就結束放映。
   * 少了這條，`presentationIndex` 會跨越專案存活：放映 A 到第 3 頁 → 瀏覽器上一頁回列表
   * （keydown handler 遇 metaKey／altKey 直接 return，瀏覽器照常導航）→ 再點 A，
   * `found.id !== project?.id` 為 false，什麼都不重設，簡報覆蓋層直接彈回第 3 頁；
   * 點別的專案 B 更糟，B 會以簡報模式開在 `B.slides[2]`。
   *
   * 純清狀態，**不要**改成呼叫 `exitPresentation()`：那會連帶把選取改寫成放映頁，
   * 而離開專案時同步選取沒有意義（換到 B 時甚至會用 A 的 index 去污染 B 的選取）。
   */
  useEffect(() => {
    setPresentationIndex(null);
  }, [project?.id, route]);
  /**
   * 正在放映的那一頁消失（自己刪掉、或別的分頁刪掉後輪詢回來、index 越界）就結束放映。
   * 少了這條會留下「隱形簡報模式」：`presentationSlide` 是 undefined，覆蓋層連同關閉鈕
   * 一起 unmount，但 `presentationIndex` 仍非 null——`canvasIsActiveSurface` 為 false，
   * 畫布上的 Delete／⌘Z／方向鍵全部靜默失效，方向鍵反而落進上面那條簡報分支，
   * 把覆蓋層叫回來。唯一出路是盲按 Esc。
   *
   * 同樣純清狀態、不走 `exitPresentation()`：那個 index 指向的頁已經不存在，沒有「放映
   * 到哪一頁」可以同步過去，選取必須原封不動留在使用者原本選的那一頁。
   */
  useEffect(() => {
    if (presentationIndex === null) return;
    if (project?.slides[presentationIndex]) return;
    setPresentationIndex(null);
  }, [presentationIndex, project]);
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
        // 忙碌守衛與遮罩點擊那道一致（見風格選擇的 backdrop onClick）：顯示「正在準備
        // 參考圖…」時按 Esc，對話框會消失，但 `addCurrentImageToStyle` 照樣跑完並導頁——
        // 使用者以為取消了，畫面卻自己跳去風格編輯頁。
        if (event.key === "Escape" && !stylePickerBusy) {
          event.preventDefault();
          setStylePickerVersion(undefined);
        }
        return;
      }
      if (presentationIndex !== null) {
        if (isFormControl && event.key === " ") return;
        const slides = project.slides;
        // 四條換頁路徑共用 nextVisibleIndex：隱藏頁一律跳過，到頭到尾停在原地不迴圈。
        // Home／End 也走它（`-1` / `length` 當起點），否則會停在被隱藏的首／末頁。
        let nextIndex = presentationIndex;
        if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(event.key))
          nextIndex = nextVisibleIndex(slides, presentationIndex, 1) ?? presentationIndex;
        else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key))
          nextIndex = nextVisibleIndex(slides, presentationIndex, -1) ?? presentationIndex;
        else if (event.key === "Home") nextIndex = nextVisibleIndex(slides, -1, 1) ?? nextIndex;
        else if (event.key === "End")
          nextIndex = nextVisibleIndex(slides, slides.length, -1) ?? nextIndex;
        else if (event.key === "Escape") {
          event.preventDefault();
          exitPresentation();
          return;
        } else return;
        event.preventDefault();
        setPresentationIndex(nextIndex);
        return;
      }
      // 與文字框快捷鍵共用同一份「畫布是不是當前互動面」判定：這條原本漏掉系統設定
      // 對話框與別條路由（模型庫、風格庫都不會清掉 project），方向鍵會在那些畫面上換頁。
      if (!canvasIsActiveSurface) return;
      // 這一行必須排在簡報那條分支**之後**：簡報覆蓋層自己就是 `aria-modal` 的對話框，
      // 而它正是靠方向鍵換頁的。放到前面等於把簡報模式的鍵盤操作整個關掉。
      if (modalDialogOpen()) return;
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
  }, [
    canvasIsActiveSurface,
    exitPresentation,
    imageEditBusy,
    presentationIndex,
    project,
    selectedId,
    showImageEdit,
    stylePickerBusy,
    stylePickerVersion,
  ]);
  useEffect(() => {
    if (presentationIndex === null) return;
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) exitPresentation();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
    // 依賴 `exitPresentation` 而不是只綁 `presentationIndex`：換頁本來就會重掛（它已經
    // 在依賴裡），會過期的是 `exitPresentation` 閉包捕住的 **`project`**——輪詢或另一個
    // 分頁刪掉某頁之後，舊的那份會拿過期的 slides 去換算「剛剛放映的是哪一頁」。
  }, [presentationIndex, exitPresentation]);
  // 簡報模式滾輪換頁：向下／向右一頁，向上／向左一頁，到頭到尾就停住不迴圈。
  // listener 只在簡報模式期間存在（依賴 presentationIndex），離開後編輯畫面的滾輪完全不受影響。
  useEffect(() => {
    if (presentationIndex === null || !project) return;
    const slides = project.slides;
    const onWheel = (event: WheelEvent) => {
      // Ctrl／⌘＋滾輪是瀏覽器的縮放手勢，不是換頁；連它一起擋掉會讓簡報模式無法縮放。
      if (event.ctrlKey || event.metaKey) return;
      // 簡報是覆蓋全螢幕的，滾輪不該讓底下的編輯畫面捲動；macOS 上不擋還會整頁彈跳。
      // 要能 preventDefault 就必須以 passive: false 註冊。
      event.preventDefault();
      const gesture = presentationWheel.current;
      const nowMs = Date.now();
      const newGesture = nowMs - gesture.lastEventAt >= WHEEL_GESTURE_GAP_MS;
      gesture.lastEventAt = nowMs;
      if (newGesture) gesture.accumulated = 0;
      if (nowMs < gesture.lockUntil) {
        gesture.accumulated = 0;
        // 事件還在連續進來 → 同一次手勢（含慣性尾巴）還沒結束，把鎖往後推；
        // 但不超過 lockCap，否則一直轉滾輪的人會永遠停在同一頁。
        gesture.lockUntil = Math.min(
          gesture.lockCap,
          Math.max(gesture.lockUntil, nowMs + WHEEL_GESTURE_GAP_MS),
        );
        return;
      }
      gesture.accumulated += normalizeWheelDelta(event);
      if (Math.abs(gesture.accumulated) < WHEEL_PAGE_THRESHOLD_PX) return;
      const forward = gesture.accumulated > 0;
      gesture.accumulated = 0;
      gesture.lockUntil = nowMs + WHEEL_PAGE_LOCK_MS;
      gesture.lockCap = nowMs + WHEEL_MAX_LOCK_MS;
      // 邊界與跳過隱藏頁的規則與鍵盤換頁共用同一支 nextVisibleIndex；
      // 沒有下一張可見頁時 nextIndex 不變，不迴圈。
      const nextIndex = nextVisibleIndex(slides, presentationIndex, forward ? 1 : -1);
      if (nextIndex !== undefined && nextIndex !== presentationIndex)
        setPresentationIndex(nextIndex);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
    // 直接依賴整個 `project`（與上面那條 keydown effect 相同）而不是挑幾個欄位：listener
    // 是閉包，捕住的是掛載當下那份 slides，只看 `slides.length` 會讓它拿著過期的可見頁
    // 清單換頁。手寫的逐頁 key 修得了「現在讀到的欄位」，但下一個讀 slide 欄位的人不會
    // 記得回來加，編譯器也不會提醒。重掛 listener 是免費的：手勢狀態放在 ref 裡。
  }, [presentationIndex, project]);
  // 選取的縮圖若超出縮圖列可視範圍（例如以方向鍵切換），自動捲入視野。
  useEffect(() => {
    if (!selectedId) return;
    railRef.current?.querySelector(".thumbnail.selected")?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  /**
   * 批次抽字的名單。放在 `useMemo` 而不是每次 render 直接算：它對**全部**頁面各跑一次
   * `versions.find()`，而這個元件會因為拖曳頁碼滑桿、打字改大綱等等高頻互動不斷重繪，
   * 150 頁的專案等於每一幀重跑 150 次線性搜尋。
   *
   * 也一定要放在所有 early return **之前**——下面 `route === "/models"` 那幾條提早回傳的
   * 分支若把這個 hook 跳過，hook 順序就會在切換路由時錯位。
   */
  const extractPlan = useMemo(() => batchExtractPlan(project?.slides ?? []), [project?.slides]);

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
        {/* 可關閉且會播報：匯入失敗時畫面上只有按鈕文字從「匯入中…」變回原字，
            螢幕閱讀器不會有任何提示，而使用者要能把它關掉再換一個檔案重試。 */}
        {error && <ErrorToast message={error} onDismiss={() => setError(undefined)} />}
        {importNoticeToast}
        <CreateProject
          key={`${route}:${window.location.search}`}
          projects={projects}
          styles={styles}
          styleLibrary={route === "/styles"}
          onNavigate={navigate}
          onImportNotice={setImportNotice}
          onError={setError}
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
        {error && <ErrorToast message={error} onDismiss={() => setError(undefined)} />}
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
        {error && <ErrorToast message={error} onDismiss={() => setError(undefined)} />}
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
        pinnedSourceIds: draft.pinnedSourceIds,
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
    if (!selected || generateBusy) return;
    // 整段（含 readiness 與 save 那兩趟）都算 busy：只包住 `api.generate` 的話，空窗仍在。
    setGenerateBusy(true);
    try {
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
    } finally {
      setGenerateBusy(false);
    }
  };

  const activeImage = selected ? currentImage(project, selected) : undefined;
  const image = previewVersion ? imageUrl(project.id, previewVersion.imagePath) : activeImage;
  /**
   * 這一版還沒有文字層，但可以就地建立一個（背景就是原圖，一個字都不抹）。
   *
   * 排除條件與 `activeTextLayer` 同一套：預覽歷史版本或有進行中的 job 時，畫面上的圖並不是
   * 「等一下會被掛上文字層的那一版」；沒有圖更是連背景都沒有。
   */
  const canStartManualText =
    !previewVersion &&
    !activeJob &&
    !!selectedVersion &&
    !!activeImage &&
    !selectedVersion.textLayer;
  const outlineView = previewVersion
    ? draft && previewVersion.outlineSnapshot
      ? // 指定的來源刻意不在 outlineSnapshot 裡（它只描述「圖是照什麼大綱畫的」），
        // 但版本本身有記錄當時生效的指定。少了這一行，預覽舊版時會拿現在的指定去標，
        // 於是顯示成「那時候就指定了」——一個當下並不成立的狀態。
        {
          ...draft,
          ...previewVersion.outlineSnapshot,
          pinnedSourceIds: previewVersion.pinnedSourceIds ?? [],
        }
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
  /**
   * 有哪幾欄與目前這張圖不同步。
   *
   * 在此之前這件事只由 `.outline-dirty` 的橘色邊框表達，而整份程式碼裡沒有任何一句文字
   * 解釋那圈橘框是什麼意思——色盲使用者與螢幕閱讀器使用者完全收不到這個訊號，結果是改了
   * 大綱、匯出成品，才發現圖片還是舊的。`fieldDirty()` 的逐欄比對寫得很細，缺的只是把它
   * 講出來。欄名要**逐欄**列出而不是說「有些欄位」：使用者要知道自己該回頭看哪一格。
   */
  const dirtyFieldLabels = (
    [
      ["content", "內容"],
      ["narrative", "敘事"],
      ["layoutHint", "構圖提示"],
      ["imagePrompt", "完整圖片提示詞"],
    ] as const
  )
    .filter(([field]) => fieldDirty(field))
    .map(([, label]) => label);
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
  // 點擊舞台與控制列兩條路徑同樣走 nextVisibleIndex；`undefined` 直接就是按鈕的 disabled 條件。
  const presentationPrev =
    presentationIndex === null
      ? undefined
      : nextVisibleIndex(project.slides, presentationIndex, -1);
  const presentationNext =
    presentationIndex === null ? undefined : nextVisibleIndex(project.slides, presentationIndex, 1);
  const visibleSlideCount = project.slides.filter((slide) => !slide.hidden).length;
  const hiddenCount = project.slides.length - visibleSlideCount;
  /**
   * 縮圖列 PAGES 的清點文字。有隱藏頁才寫「可見數/總數」：縮圖列列出的是**全部**頁面，
   * 單一個總數會讓「為什麼放映與 pptx／pdf 只有 14 頁」在這裡完全沒有線索。沒有隱藏頁
   * 就維持單一數字，不寫成 `17/17`——那個分母不帶任何資訊，只是多一個要解讀的符號。
   *
   * 這是 rail 的清點，**不是**頁碼，所以刻意不呼叫 `pageNumberSlideLabel()`：那份帶
   * `startAt`／`skipFirstSlide`，是印在成品上的 chrome，關掉頁碼時它根本不該消失。
   *
   * 句子要把**可見頁數**講出來，不能只說「4 頁，其中 1 頁隱藏」讓人自己減：眼睛看到的
   * 是分子 `3`，閱讀器卻只聽得到 4 與 1，兩者對不起來。
   */
  const slideCountTitle =
    hiddenCount > 0
      ? `${project.slides.length} 頁，其中 ${hiddenCount} 頁隱藏，${visibleSlideCount} 頁會放映`
      : `${project.slides.length} 頁`;
  /**
   * 控制列的「第幾頁 / 共幾頁」。與頁碼疊層**只**共用「隱藏頁不算」這一條，刻意不套
   * `startAt`／`skipFirstSlide`：那兩個是印在成品上的 chrome 設定（`skipFirstSlide` 開、
   * `startAt: 10` 時，色塊寫「第 10 頁」而這裡寫「1 / 4」，兩者都對），控制列則是放映進度，
   * 必須從 1 數到可見頁數。不要「統一」成呼叫 `pageNumberSlideLabel()`——那會讓進度指示
   * 在關閉頁碼時整個消失、開啟 skipFirstSlide 時第一頁變成空白。
   *
   * 夾到至少 1：放映中的那頁若在別的分頁被改成隱藏、而它又正好是 index 0，未夾制時
   * 這裡會算出 `0 / 3`（`alt` 也會變成「簡報第 0 頁」）。落差只在顯示上，不值得為它在
   * 簡報途中強制跳頁，但「第 0 頁」是明顯錯的字。
   */
  const presentationPosition =
    presentationIndex === null
      ? 0
      : Math.max(
          1,
          project.slides.slice(0, presentationIndex + 1).filter((slide) => !slide.hidden).length,
        );
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
  /**
   * 縮圖列的頁面操作（排序、隱藏、複製、刪除）。
   *
   * 共用 `thumbBusy` 而不是各自 `run()`：這四件事改的都是 `project.slides` 整個陣列，兩個
   * 在飛的請求誰後回誰算數。實測最明顯的是複製——連點兩下就得到兩份副本，而使用者只按了
   * 一次「⧉」。
   *
   * 實際擋住連點的是按鈕的 `disabled`（React 對離散事件同步 flush，第二下按到的已經是停用
   * 的按鈕）。函式內這道守衛是第二層，用來擋「不經按鈕」的呼叫路徑；它讀 **ref** 而不是
   * `thumbBusy` state，因為兩下點擊之間若 React 還沒重新 render，handler 閉包裡的 state 就還是
   * 那個過期的 `false`——那正是這道守衛聲稱要處理的情境，讀 state 等於在唯一需要它的時候
   * 什麼都不做。
   */
  const runThumbAction = async (operation: () => Promise<PresentationProject>) => {
    if (thumbBusyRef.current) return;
    thumbBusyRef.current = true;
    setThumbBusy(true);
    try {
      await run(operation);
    } finally {
      thumbBusyRef.current = false;
      setThumbBusy(false);
    }
  };
  /**
   * 批次生成：先存下編輯中的大綱，再依使用者的選擇決定要不要把隱藏頁也排進去。
   * `"all"` 不傳 `slideIds`，與加入隱藏頁之前完全同一條路。
   */
  const runBatchGenerate = async (choice: BatchGenerateChoice) => {
    if (batchGenerateBusy) return;
    setBatchGenerateBusy(true);
    try {
      const saved = await save();
      if (!saved) return;
      try {
        await api.generateAll(
          project.id,
          undefined,
          acceptUnknownReadiness,
          choice === "visible-only" ? visibleSlideIds(project.slides) : undefined,
        );
        setProject(await api.getProject(project.id));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "批次生成失敗");
      }
    } finally {
      setBatchGenerateBusy(false);
    }
  };
  const textLayerHint = `${textBoxes.length} 個文字框`;
  // 面板與預覽一律讀樂觀值；只有它才會在滑桿還沒 debounce 出去時就跟著動。
  const pageNumber = pageNumberDraft ?? project.pageNumber;
  const pageNumberProject = pageNumberDraft ? { ...project, pageNumber: pageNumberDraft } : project;
  const flushPageNumber = async () => {
    if (pageNumberTimer.current !== undefined) {
      clearTimeout(pageNumberTimer.current);
      pageNumberTimer.current = undefined;
    }
    const patch = pageNumberPending.current;
    pageNumberPending.current = {};
    if (!Object.keys(patch).length) return;
    const seq = (pageNumberSeq.current += 1);
    setError(undefined);
    try {
      const updated = await api.updatePageNumber(project.id, patch);
      // 更晚送出的一筆已經在途（或已回來）時，這筆是舊資料，寫進去就是 UI 跳回舊值。
      if (seq !== pageNumberSeq.current) return;
      setProject(updated);
      // 還有排隊中的變更時樂觀值比伺服器新，留著等下一輪回應再收。
      if (pageNumberTimer.current === undefined) setPageNumberDraft(undefined);
    } catch (reason) {
      if (seq !== pageNumberSeq.current) return;
      // 失敗就退回伺服器上那份，不讓畫布停在一個沒被接受的狀態。
      setPageNumberDraft(undefined);
      setError(reason instanceof Error ? reason.message : "操作失敗");
    }
  };
  /**
   * `debounce` 給滑桿與色票這種一次操作連發數十個 change 的控制項；其餘控制項一次一個值，
   * 立刻送出。兩者都先寫樂觀值，畫布因此永遠是即時的。
   */
  const patchPageNumber = (patch: PageNumberPatch, options: { debounce?: boolean } = {}) => {
    setPageNumberDraft((current) => mergePageNumber(current ?? project.pageNumber, patch));
    const pending = pageNumberPending.current;
    // 巢狀欄位逐欄併：整個換掉的話，同一輪裡先改的 background.color 會被後改的 opacity 蓋掉。
    const background = { ...pending.background, ...patch.background };
    pageNumberPending.current = {
      ...pending,
      ...patch,
      ...(Object.keys(background).length ? { background } : {}),
    };
    if (pageNumberTimer.current !== undefined) clearTimeout(pageNumberTimer.current);
    pageNumberTimer.current = undefined;
    if (!options.debounce) {
      void flushPageNumber();
      return;
    }
    pageNumberTimer.current = setTimeout(() => {
      pageNumberTimer.current = undefined;
      void flushPageNumber();
    }, PAGE_NUMBER_DEBOUNCE_MS);
  };
  const startPresentation = () => {
    const preferred = Math.max(
      0,
      project.slides.findIndex((slide) => slide.id === selected?.id),
    );
    // 選取的那頁被隱藏時落到最近的可見頁；一張可見頁都沒有就不進場——空的簡報模式
    // 只會是一片黑幕加上「0 / 0」，離開的唯一辦法還是 Esc。
    const index = firstPresentableIndex(project.slides, preferred);
    if (index === undefined) {
      setError("所有頁面都已隱藏，無法開始簡報。請先取消隱藏至少一頁。");
      return;
    }
    // 手勢狀態跟著這次簡報從零開始：上一輪留下的冷卻會把進場後第一下滾輪吃掉。
    presentationWheel.current = { accumulated: 0, lastEventAt: 0, lockUntil: 0, lockCap: 0 };
    setPresentationIndex(index);
    const request = document.documentElement.requestFullscreen?.();
    if (request) void request.catch(() => undefined);
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
  const selectedText = textBoxes.find((box) => box.id === selectedTextId);
  const patchSelectedText = (patch: Partial<EditableTextBox>) => {
    if (!selectedTextId) return;
    changeTextBoxes(
      textBoxes.map((box) => (box.id === selectedTextId ? { ...box, ...patch } : box)),
    );
  };
  /**
   * 關閉底色：把兩個 optional 欄位整個**移除**，而不是設成 undefined。
   * `patchSelectedText` 的 `{ ...box, ...patch }` 只能覆寫既有 key，刪不掉欄位；
   * 而 schema 開了 `exactOptionalPropertyTypes`，顯式指定 undefined 型別也不會過。
   */
  const clearSelectedTextBackground = () => {
    if (!selectedTextId) return;
    changeTextBoxes(
      textBoxes.map((box) => {
        if (box.id !== selectedTextId) return box;
        const { backgroundColor: _color, backgroundOpacity: _opacity, ...rest } = box;
        return rest;
      }),
    );
  };
  /** 關閉描邊；三個 optional 欄位一起移除，理由同上面那條。 */
  const clearSelectedTextStroke = () => {
    if (!selectedTextId) return;
    changeTextBoxes(
      textBoxes.map((box) => {
        if (box.id !== selectedTextId) return box;
        const { strokeColor: _color, strokeWidth: _width, strokeOpacity: _opacity, ...rest } = box;
        return rest;
      }),
    );
  };
  /**
   * 工具列「新增文字框」：這一版已經有文字層就直接加一個框，還沒有的話先請伺服器建立
   * 「文字編輯版本」（背景＝原圖，一個字都不抹），再由新版本承接這個框。
   */
  const addTextBox = () => {
    const box = defaultTextBox();
    if (activeTextLayer) {
      changeTextBoxes([...textBoxes, box]);
      setSelectedTextId(box.id);
      return;
    }
    if (!selected || !selectedVersion || !canStartManualText) return;
    // 這一輪的頁面，收尾時一律用它：非同步期間使用者可能已經切到別頁。
    const slideId = selected.id;
    trackTextLayerTask(slideId, "create");
    setError(undefined);
    void api
      .createManualTextLayer(project.id, slideId, selectedVersion.id, [box])
      .then((updated) => {
        const nextVersionId = updated.slides.find(
          (candidate) => candidate.id === slideId,
        )?.currentVersionId;
        if (nextVersionId) pendingTextSelect.current = { versionId: nextVersionId, boxId: box.id };
        setProject(updated);
      })
      .catch((reason: unknown) =>
        // 刻意沒有 `TEXT_LAYER_EXISTS` 的翻譯：伺服器允許同一張原圖有多個手動層版本，而這一顆
        // 只在「這一版沒有文字層」時按得下去，所以那個代碼在這條路上定義上到不了畫面上。
        setError(reason instanceof Error ? reason.message : "建立文字編輯版本失敗"),
      )
      .finally(() => trackTextLayerTask(slideId, undefined));
  };
  /**
   * 抽字要交給哪個 provider。單頁與批次共用同一個運算式——兩條路的參數一旦分岔，
   * 使用者在面板上選的引擎就會只對其中一顆按鈕生效。
   */
  const textExtractProviderId =
    textExtractEngine === "opencv" ? "local-inpaint" : effectiveImageProviderId;
  /** 抹字引擎寫給使用者看的名字（確認框與 tooltip 共用）。 */
  const textExtractEngineLabel =
    textExtractEngine === "opencv" ? "OpenCV（本機、不消耗配額）" : "生圖模型（會消耗影像配額）";
  /**
   * 生圖模型引擎才受影像 provider 限制（遮罩編輯能力＋readiness，與「生成此頁」同一組門檻）。
   * OpenCV 在本機跑、不碰 provider，什麼都不必等。
   */
  const batchExtractModelBlocked =
    textExtractEngine === "model" &&
    (!provider?.capabilities.maskedEditing ||
      readinessBusy ||
      !readiness ||
      readiness.blocking ||
      (readiness.requiresAcknowledgement && !acceptUnknownReadiness));
  // 比照「批次生成全部頁面」點擊時的門檻：有圖片工作在跑時，這一頁的圖等一下就會換掉，
  // 現在對它抽字抽到的是舊圖。
  const batchExtractJobsBusy = project.jobs.some((job) =>
    ["queued", "running"].includes(job.status),
  );
  /**
   * 有沒有**單頁**抽字正在飛。
   *
   * 這是循序不變量的另一半：伺服器的 OCR 閘門是 1 active ＋ 2 waiting，批次自己排得再整齊，
   * 只要旁邊有第二個來源同時送，就可能撞出 429 `OCR_QUEUE_BUSY` 而讓整批中止。所以兩顆按鈕
   * 必須互斥——這裡擋「單頁在跑時不准開批次」，單頁那顆則以 `batchExtract` 擋反方向。
   *
   * 只認 `extract`：`save`（自動儲存重繪）與 `create`（建立手動文字層）都不碰 OCR。
   */
  const singleExtractInFlight = [...textLayerTasks.values()].some((task) => task === "extract");
  const batchExtractDisabled =
    extractPlan.targets.length === 0 ||
    batchExtract !== undefined ||
    singleExtractInFlight ||
    batchExtractJobsBusy ||
    batchExtractModelBlocked;
  /**
   * 灰掉時一定要說明原因：抹字引擎的選單在另一個分頁（頁面）的收合區裡，使用者在專案分頁
   * 上看到一顆沒有理由的灰按鈕，是完全猜不到要去哪裡改的。
   */
  const batchExtractTitle = batchExtract
    ? "逐頁排隊處理中；按「停止」會在做完目前這一頁之後停下。"
    : extractPlan.targets.length === 0
      ? extractPlan.skippedExtracted === 0
        ? "還沒有任何頁面有圖片可以抽離文字。"
        : extractPlan.skippedNoImage === 0
          ? "所有頁面都已經有可編輯文字層。"
          : "沒有可以抽離文字的頁面：其餘頁面不是已有文字層，就是還沒有圖。"
      : singleExtractInFlight
        ? "有頁面正在抽離文字，等它完成再開始批次（伺服器一次只跑一頁 OCR）。"
        : batchExtractJobsBusy
          ? "有頁面的圖片工作還在跑（生成或抹字），等它完成再抽字。"
          : batchExtractModelBlocked
            ? !provider?.capabilities.maskedEditing
              ? "目前的生圖模型不支援遮罩編輯；請到「頁面」分頁把抹字引擎改回 OpenCV。"
              : (readiness?.message ?? "正在檢查生圖模型狀態…")
            : `逐頁以 OCR 抽離文字，共 ${extractPlan.targets.length} 頁（抹字引擎：${textExtractEngineLabel}）。`;
  const startTextExtraction = async () => {
    if (!selected || !selectedVersion) return;
    // 抽字要等 OCR 排隊＋辨識，數十秒起跳，使用者這段時間多半已經去看別頁了：收尾一定要
    // 用**呼叫當下**的頁面，拿收尾時的 `selected` 會把狀態清到別頁上（那一頁的抽字鈕就此
    // 永遠灰著，而這一頁的進度條永遠轉著）。
    const slideId = selected.id;
    trackTextLayerTask(slideId, "extract");
    setError(undefined);
    /*
     * 通知列也要清。
     *
     * 上一輪留下的「字色與字型是預設值」在使用者把模型組合修好、重抽成功之後**不會**自己
     * 消失（成功路徑不寫訊息，而通知列只有點擊才關得掉），於是那句話會指著一份其實有風格
     * 的產物。這一次的結果由這一次負責寫。
     */
    setImportNotice(undefined);
    try {
      const status = await api.ocrStatus();
      if (!status.available) throw new Error(status.message);
      const job = await api.extractText(
        project.id,
        slideId,
        textExtractProviderId,
        textThreshold,
        acceptUnknownReadiness,
        textRepair,
        traditionalize,
      );
      setProject(await api.getProject(project.id));
      /*
       * 樣式精修被降級掉的話一定要講出來，而且用**非錯誤**的通知列：抽字本身成功了
       * （框、幾何、抹字都在），只是字色與字型停在預設值。使用者看到的是「整頁白字」，
       * 與「這一頁本來就是白字」在畫面上分不出來——沒有這句話就只能靠反推。
       */
      const styleFailure = styleRefinementFailure(job);
      if (styleFailure)
        setImportNotice(
          `這一頁的字色與字型是預設值（白字 Arial），不是從圖上估出來的：${styleRefinementReasonText(
            styleFailure,
          )}。文字與位置不受影響；修好模型組合的文字模型之後再抽一次，就會拿回從圖上估出來的樣式。`,
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文字抽離失敗");
    } finally {
      trackTextLayerTask(slideId, undefined);
    }
  };
  /**
   * 「批次抽離全部文字」：對 {@link batchExtractPlan} 挑出來的每一頁跑一次既有的抽字端點。
   *
   * 完全複用單頁那條路（同一個端點、同一組參數），這裡只多做三件事：先問一次、逐頁排隊、
   * 把逐頁的失敗收成一份摘要。
   */
  const batchExtractConfirmMessage = (count: number, hidden: number) => {
    const skippedTotal = extractPlan.skippedExtracted + extractPlan.skippedNoImage;
    const skipReasons = [
      ...(extractPlan.skippedExtracted > 0
        ? [`${extractPlan.skippedExtracted} 頁已經有可編輯文字層`]
        : []),
      ...(extractPlan.skippedNoImage > 0 ? [`${extractPlan.skippedNoImage} 頁還沒有圖`] : []),
    ];
    return [
      `批次抽離全部文字：會處理 ${count} 頁` +
        (hidden > 0 ? `（其中 ${hidden} 頁是隱藏頁，一併處理）` : "") +
        (skippedTotal > 0 ? `，跳過 ${skippedTotal} 頁（${skipReasons.join("、")}）` : "") +
        "。",
      `抹字引擎：${textExtractEngineLabel}。`,
      // 換專案會讓整批靜默停下（見寫回前的守衛），事後畫面上不留任何痕跡——使用者回來
      // 只會以為它跑完了。這句話要在開始之前就講。
      "頁面會逐一排隊送出（伺服器一次只跑一頁 OCR），整批可能需要數分鐘；" +
        "中途離開這份專案會停止批次。確定開始？",
    ].join("\n");
  };
  const runBatchTextExtraction = async (
    targets: readonly SlideSpec[],
    /** 三選一對話框已經問過了，不要再跳一次 `confirm()`。 */
    preConfirmed = false,
  ) => {
    if (targets.length === 0 || batchExtract) return;
    if (
      !preConfirmed &&
      !confirm(batchExtractConfirmMessage(targets.length, hiddenSlideCount(targets)))
    )
      return;
    // 收尾一律用**呼叫當下**的專案 id：整批可能跑好幾分鐘，這期間使用者可以換專案。
    const projectId = project.id;
    /**
     * 這一輪的結果還能不能寫回畫面？
     *
     * 兩道守衛缺一不可：`activeProjectId` 是正向的身分比對（使用者換去了別的專案，
     * 寫回等於把舊專案蓋上去），`"left"` 旗標則涵蓋卸載——卸載後不會再有 effect body 跑，
     * ref 裡留的還是這份專案的 id，光比對是分不出來的。
     */
    const abandoned = () =>
      batchExtractStop.current === "left" || activeProjectId.current !== projectId;
    batchExtractStop.current = undefined;
    setError(undefined);
    // 上一輪的降級提示由這一輪重寫（理由見 `startTextExtraction`）。
    setImportNotice(undefined);
    // 立刻進「進行中」，不要等到第一頁真的送出去：`confirm()` 一關掉按鈕就會重新算 disabled，
    // 中間若空著一段（例如下面查 OCR 狀態的那趟往返），使用者連按兩下就開得起兩批。
    setBatchExtract({ current: 1, total: targets.length, stopping: false });
    const failures: { order: number; reason: string }[] = [];
    /**
     * 成功了、但樣式精修被降級掉的頁。
     *
     * 不列進 `failures`：那一頁的框、幾何與抹字都做出來了，記成失敗會讓使用者以為要重做。
     * 但也不能不講——這幾頁的字色與字型全是預設的白字 Arial。
     */
    const styleSkipped: { order: number; failure: StyleRefinementFailure }[] = [];
    let succeeded = 0;
    /** 整批提前停下的原因；`undefined` ＝ 每一頁都送出去過了。 */
    let abortedBy: "user" | "server" | undefined;
    let abortMessage: string | undefined;
    /**
     * 中止的那一頁到底有沒有被「用掉」。
     *
     * `remaining`（還有幾頁沒送出）預設把它算成已處理，前提是它至少送出去過。但新的設定
     * 錯誤是**擋在 OCR 之前**的：那一頁一點事都沒發生，仍然整頁待抽——算掉它的話，使用者
     * 看到「還有 2 頁沒有送出」，實際重跑時會處理 3 頁。
     */
    let abortConsumedPage = true;
    /** 開跑前的準備就失敗了（查 OCR 狀態那一趟），連迴圈都沒有進去。 */
    let preflightMessage: string | undefined;
    try {
      // OCR 可不可用是**伺服器層級**的事，只在開跑前檢查一次；逐頁各檢查一次只是每頁多一趟
      // 往返，而且答案不會不一樣（真的中途壞掉時，下面的錯誤碼分岔會把整批停下來）。
      const status = await api.ocrStatus();
      // 丟出去而不是 `return`：`return` 會連同下面的 `finally` 一起結束整個函式，
      // try/finally 之後那段回報摘要的程式碼一行都不會跑，使用者什麼訊息都看不到。
      // 交給下面那道 catch 統一收（與單頁 `startTextExtraction` 同一個寫法）。
      if (!status.available) throw new Error(status.message);
      for (const [index, slide] of targets.entries()) {
        /*
         * 「停止」只擋得下**還沒送出**的頁。
         *
         * 抽字端點刻意沒有取消機制（見 `apps/server/src/ocr-queue.ts`）：OCR 跑完就會一路
         * 做完樣式精修、產遮罩、把抹字 job 寫進 project.json，中途放棄只會讓算完的成果沒人收。
         * 所以旗標只在「要不要送下一頁」這個點上讀，不要「補上」中斷在途請求的能力。
         */
        if (abandoned()) return;
        if (batchExtractStop.current === "user") {
          abortedBy = "user";
          break;
        }
        setBatchExtract({ current: index + 1, total: targets.length, stopping: false });
        trackTextLayerTask(slide.id, "extract");
        try {
          /*
           * **一定要 await，一頁一頁送。**
           *
           * 伺服器的 OCR 閘門併發是 1、等待區只有 2 筆（`ocr-queue.ts`），第 4 筆起立刻回
           * 429 `OCR_QUEUE_BUSY`。改成 `Promise.all` 或預先併發送出，在 4 頁以上的專案上
           * 必定整批爆掉；就算閘門放寬，單一 OCR 程序峰值約 4GB RSS 且並行零共享，那是直接
           * 把伺服器打到 OOM。這裡慢不是還沒優化，是規格。
           */
          const job = await api.extractText(
            projectId,
            slide.id,
            textExtractProviderId,
            textThreshold,
            acceptUnknownReadiness,
            textRepair,
            traditionalize,
          );
          // 202 已經回來了＝這一頁抽字成功（抹字 job 已排進 project.json）。下面那趟重讀
          // 只是為了讓畫面跟上，**不是**成功與否的一部分。
          succeeded += 1;
          const styleFailure = styleRefinementFailure(job);
          if (styleFailure) styleSkipped.push({ order: slide.order + 1, failure: styleFailure });
          /*
           * 逐頁重讀專案，畫布與縮圖列才會一頁一頁亮起來，而不是整批跑完才一次跳完。
           *
           * 這一趟**不是**多餘的：專案輪詢（`jobsBusy` 那條 effect）的觸發條件是
           * `project.jobs` 裡有 queued/running 的 job，而 `project` 只有靠這裡寫回才會知道
           * 抽字剛排了一個抹字 job——沒有這一趟，`jobsBusy` 從頭到尾都是 false，輪詢一次
           * 都不會啟動（它自己 bootstrap 不了）。
           *
           * `.catch` 吞掉是刻意的：網路抖一下害重讀失敗時，這一頁的抽字其實已經成功了，
           * 把它記成「這一頁失敗」是在說謊——最壞的後果只是這一頁晚一點才更新，而輪詢
           * 接手之後也會補上。
           */
          const refreshed = await api.getProject(projectId).catch(() => undefined);
          // 這趟往返中間使用者可能已經換掉專案：`refreshed` 是**上一份**專案的內容，
          // 寫回去等於把它蓋到畫面上的新專案。
          if (abandoned()) return;
          if (refreshed) setProject(refreshed);
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "文字抽離失敗";
          if (isBatchAbortingFailure(reason)) {
            // 原因不在這一頁身上，所以不列進逐頁失敗清單，而是整批停下來。
            abortedBy = "server";
            abortMessage = message;
            // 設定錯誤是在伺服器跑 OCR 之前擋下的：這一頁完全沒被碰過，仍要算進「沒有送出」。
            abortConsumedPage = !(
              reason instanceof ApiError &&
              reason.code !== undefined &&
              OCR_CONFIG_ABORT_CODES.has(reason.code)
            );
            break;
          }
          failures.push({ order: slide.order + 1, reason: message });
        } finally {
          trackTextLayerTask(slide.id, undefined);
        }
      }
      // 停止按在最後一頁上時迴圈是自然結束的，旗標沒有人讀到——不補這一句，使用者按了
      // 停止卻連一句回應都沒有（按鈕直接消失，命中下面「全部跑完不留訊息」那條）。
      if (abortedBy === undefined && batchExtractStop.current === "user") abortedBy = "user";
    } catch (reason) {
      /*
       * 這一層是 `api.ocrStatus()` 等「迴圈之外」的失敗的唯一出口。
       *
       * 少了它，`/api/ocr/status` 回 500 或非 JSON 時例外會一路穿出這個 async 函式，
       * 而呼叫端是 `void runBatchTextExtraction(...)`——沒有人接，變成 unhandled rejection：
       * 使用者按下去只看到按鈕閃一下，畫面上一個字都沒有。單頁那條本來就有這道 catch。
       */
      preflightMessage = reason instanceof Error ? reason.message : "批次抽離文字失敗";
    } finally {
      setBatchExtract(undefined);
    }
    // 換專案／卸載就什麼都不要說：這份摘要講的是另一份專案的事。
    if (abandoned()) return;
    if (preflightMessage !== undefined) {
      setError(preflightMessage);
      return;
    }
    /*
     * 樣式精修被降級掉的頁要單獨講：那幾頁「成功」了，但字色與字型全是預設的白字 Arial。
     * 措辭與單頁那條同一份，只是換成頁號清單。
     */
    const styleDetail = styleSkipped.length
      ? `其中 ${styleSkipped.length} 頁的字色與字型是預設值（白字 Arial），不是從圖上估出來的（${styleSkipped
          .slice(0, 6)
          .map((item) => `第 ${item.order} 頁：${styleRefinementReasonText(item.failure)}`)
          .join("；")}${
          styleSkipped.length > 6 ? `；另有 ${styleSkipped.length - 6} 頁` : ""
        }）。文字與位置不受影響；修好模型組合的文字模型之後再抽一次即可。`
      : "";
    // 全部順利跑完時不留任何訊息——畫面已經逐頁更新過了，一句「成功 12 頁」佔著通知列
    // 反而像出了事。但「有頁面沒有風格」不算順利跑完，那一定要說。
    if (failures.length === 0 && abortedBy === undefined && styleSkipped.length === 0) return;
    // 「還沒送出」預設不含撞出中止的那一頁：它已經送過了，只是原因不在它身上所以沒有列進
    // 逐頁清單。例外是被擋在 OCR 之前的設定錯誤（見 `abortConsumedPage`），那一頁完全沒
    // 被碰過，仍然整頁待抽。
    const remaining =
      targets.length -
      succeeded -
      failures.length -
      (abortedBy === "server" && abortConsumedPage ? 1 : 0);
    /*
     * 逐頁原因最多列 6 筆。通知列是一顆按鈕，把 100 頁的原因全串上去等於一面文字牆，
     * 而失敗多半是同一個原因重複，看前幾筆就夠判斷。
     */
    const shown = failures.slice(0, 6).map((item) => `第 ${item.order} 頁：${item.reason}`);
    const failureDetail = failures.length
      ? `，失敗 ${failures.length} 頁（${shown.join("；")}${
          failures.length > shown.length ? `；另有 ${failures.length - shown.length} 頁` : ""
        }）`
      : "";
    const headline =
      abortedBy === "user"
        ? remaining > 0
          ? `批次抽離文字已由你中止：完成 ${succeeded} 頁`
          : // 停止按下去時剩的正好是最後一頁：它照樣做完了，說「中止」會讓人以為有東西沒做。
            `你按下停止時已經是最後一頁：完成 ${succeeded} 頁`
        : abortedBy === "server"
          ? `批次抽離文字已中止：完成 ${succeeded} 頁`
          : `批次抽離文字完成：成功 ${succeeded} 頁`;
    const summary =
      `${headline}${failureDetail}${remaining > 0 ? `，還有 ${remaining} 頁沒有送出` : ""}。` +
      (abortMessage ? ` ${abortMessage}` : "") +
      (styleDetail ? ` ${styleDetail}` : "");
    /*
     * 沒有任何一頁失敗時走**非錯誤**的通知列（`importNotice` 那條，紅色的錯誤列留給真的
     * 出錯的情況）：使用者自己按的停止不是故障，用紅字回報等於在說他做錯了什麼。
     * 伺服器層級的中止仍算錯誤——那是真的有東西壞了。
     */
    if (failures.length === 0 && abortedBy !== "server") setImportNotice(summary);
    else setError(summary);
  };
  return (
    <div className={`shell${inspectorCollapsed ? " inspector-collapsed" : ""}`}>
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
              // 沒有 label、沒有 placeholder，螢幕閱讀器只念得到一個空的文字框——而它一進場
              // 就 autoFocus，使用者聽到的第一句話會是「編輯」兩個字。
              aria-label="專案名稱"
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
              // 長名字在 header 會被 ellipsis 截斷，tooltip 是看到全名的唯一途徑。
              title={`${project.name}\n點一下重新命名`}
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
        {/* 專案／來源／匯出三個面板的唯一入口是右側 inspector 的分頁；header 只留簡報模式。 */}
        <nav className="workspace-nav">
          <button className="present-button" onClick={startPresentation}>
            ▶ 簡報模式
          </button>
        </nav>
        {/* 自動儲存是「不用你按存檔」的唯一證據，而它只有一個色點加一句文字；沒有
            live region 時，看不到畫面的人不會知道自己的編輯到底送出去了沒有。
            已知取捨：每次自動儲存會播報兩次（「正在…」→「已…」），編輯文字層時偏吵；
            但相對於完全不知道存了沒有，吵是比較小的錯。 */}
        <div className="header-status" role="status">
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
          webSearchEnabled={webSearch.enabled}
          webSearchBusy={webSearch.busy}
          onWebSearchToggle={webSearch.toggle}
          combinations={combinations}
          combinationId={project.combinationId}
          onCombinationId={(combinationId) => {
            setSystemSettingsError(undefined);
            void api
              .setProjectCombination(project.id, combinationId)
              .then((updated) => setProject(updated))
              // 與勾選框同一個坑：全域 toast 被遮罩蓋住，這裡的失敗只能在模態內講。
              .catch((reason: unknown) =>
                setSystemSettingsError(reason instanceof Error ? reason.message : "設定組合失敗"),
              );
          }}
          onOpenModelLibrary={() => navigate("/models")}
          onClose={() => setShowSystemSettings(false)}
          error={systemSettingsError}
        />
      )}
      <aside className="rail">
        <div className="rail-heading">
          <span>PAGES</span>
          <span className="rail-heading-count">
            <b title={slideCountTitle}>
              {/* 「14/17」被螢幕閱讀器念成「十四斜線十七」，等於沒有資訊：數字給眼睛，
                  完整句子給閱讀器，兩者互斥地各出現一次，不會被重複播報。
                  已知缺口：`title` 只有滑鼠 hover 讀得到（`<b>` 不可聚焦，而原生 tooltip
                  本來也不在鍵盤焦點上顯示），所以「不用滑鼠、也不用閱讀器」的人看不到
                  這句話。刻意不為它加 `tabIndex`（憑空多一個沒有動作的 Tab 停點）或改寫
                  成自製 tooltip 元件——閱讀器那條路已經完整，剩下的缺口不值那個成本。 */}
              <span aria-hidden="true">
                {hiddenCount > 0
                  ? `${visibleSlideCount}/${project.slides.length}`
                  : project.slides.length}
              </span>
              <span className="visually-hidden">{slideCountTitle}</span>
            </b>
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
                className={`thumbnail ${slide.id === selected?.id ? "selected" : ""} ${slide.hidden ? "hidden-slide" : ""}`}
                draggable
                onDragStart={() => setDraggedId(slide.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (!draggedId || draggedId === slide.id) return;
                  const ids = project.slides.map((item) => item.id);
                  const from = ids.indexOf(draggedId);
                  const to = ids.indexOf(slide.id);
                  ids.splice(to, 0, ids.splice(from, 1)[0]!);
                  void runThumbAction(() => api.reorderSlides(project.id, ids));
                  setDraggedId(undefined);
                }}
                onClick={() => {
                  setSelectedId(slide.id);
                  setPanel("slide");
                }}
                /*
                 * `role="button"` **不會**像真的 `<button>` 那樣把 Enter／Space 合成成 click，
                 * 所以必須自己接。在此之前這一格 Tab 得到、焦點環會亮、閱讀器也念「按鈕」，
                 * 按下去卻毫無反應——選頁是編輯器的核心動線，等於整個編輯器對純鍵盤使用者
                 * 不可用。寫法照抄 header 專案名稱那顆同為 `role="button"` 的 `<strong>`。
                 *
                 * 只認 `target === currentTarget`：裡面那排操作按鈕是真的 `<button>`，Enter
                 * 會被它們自己處理完再冒泡上來，不擋的話「按 Enter 刪除這一頁」會順帶把
                 * 這一頁選起來。
                 */
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setSelectedId(slide.id);
                  setPanel("slide");
                }}
                role="button"
                tabIndex={0}
                // 選中狀態原本只有 CSS class：閱讀器聽到的是一排長得一模一樣的按鈕，
                // 無從得知現在停在哪一頁。
                {...(slide.id === selected?.id ? { "aria-current": "page" as const } : {})}
              >
                <span className="slide-number">{String(slide.order + 1).padStart(2, "0")}</span>
                <span
                  className="thumb-canvas"
                  style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
                >
                  {!thumb && <em>{slide.purpose}</em>}
                </span>
                {/* 淡化本身不夠：縮圖本來就有深有淺，只靠透明度看不出是「被隱藏」還是
                    「這張圖比較暗」，所以再補一個明講的標記。它刻意是 .thumb-canvas 的
                    兄弟而不是子節點——父層的 opacity 會把標記一起淡掉。 */}
                {slide.hidden && <i className="thumb-hidden-badge">已隱藏</i>}
                <span className="thumb-actions">
                  <button
                    /* 隱藏中的頁面，這顆按鈕是唯一的復原途徑，因此 `.hidden-slide` 讓
                       `.thumb-actions` 永遠可見（見 styles.css）；只在 hover 顯示會讓使用者
                       找不到怎麼取消隱藏。
                       名稱跟著狀態翻（「取消隱藏此頁」已經蘊含「這一頁現在是隱藏的」），
                       所以**不加** `aria-pressed`：兩者併用時螢幕閱讀器會念出
                       「取消隱藏此頁, 已按下」——雙重否定，比沒有狀態資訊更糟。
                       視覺上的狀態由「已隱藏」標記與淡化的縮圖承擔。 */
                    className="thumb-hide"
                    title={slide.hidden ? "取消隱藏此頁" : "隱藏此頁（不放映、不匯出 pptx／pdf）"}
                    aria-label={slide.hidden ? "取消隱藏此頁" : "隱藏此頁"}
                    disabled={thumbBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runThumbAction(() =>
                        api.setSlideHidden(project.id, slide.id, !slide.hidden),
                      );
                    }}
                  >
                    <SlideVisibilityIcon hidden={!!slide.hidden} />
                  </button>
                  {/* `title` 不在鍵盤焦點時顯示、行動裝置無法觸發、部分閱讀器設定會忽略它，
                      所以名稱要靠 `aria-label`——同一排的第一顆本來就兩個都有。 */}
                  <button
                    aria-label="複製頁面"
                    title="複製頁面"
                    disabled={thumbBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runThumbAction(() => api.duplicateSlide(project.id, slide.id));
                    }}
                  >
                    ⧉
                  </button>
                  <button
                    aria-label="刪除頁面"
                    title="刪除頁面"
                    disabled={thumbBusy || project.slides.length === 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (confirm("刪除此頁？"))
                        void runThumbAction(() => api.deleteSlide(project.id, slide.id));
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
            {/* 文字圖層只在這條既有的狀態列報框數，不另闢一行吃掉畫布高度。快捷鍵說明依
                使用者要求拿掉（維持移除），但要誠實記下放棄了什麼：那串字除了 Delete／
                ⌘Z／⇧⌘Z／⌘C／⌘V 這些通用鍵位，還帶著「單擊選取」「雙擊編輯文字」兩個
                **本 app 專屬**、別處學不到的手勢，現在畫面上沒有任何地方寫。工具列的
                tooltip 只補得到新增／刪除／復原／重做四顆按鈕，複製、貼上與那兩個滑鼠
                手勢沒有替代出口。這是拿發現性換整條標題列的空間，不是「反正都寫在別處」。
                內文短到不會被截斷，因此也不再掛 `title`（與內文一字不差的 tooltip 只是多
                一次滑鼠停留）。
                進行中的工作**不**擠進來——那是畫布下方 `.text-layer-progress` 的事。 */}
            {activeTextLayer && <span className="text-layer-status">{textLayerHint}</span>}
            <span>
              {activeJob
                ? `● ${PHASE_LABELS[activeJob.phase ?? activeJob.status] ?? activeJob.status}`
                : previewVersion
                  ? "歷史版本預覽"
                  : "16:9"}
            </span>
          </span>
        </div>
        {/*
          畫布與文字工具列同一列。工具列的方向**自適應**：預設是畫布右側的垂直側欄，但當
          畫布是寬度受限（畫布下方本來就空著一大條）時，改成畫布下方的水平橫排，那條空白
          才不會白留、側欄也就不用從畫布寬度身上拿。兩種佈局的畫布尺寸各算一次取大者，
          決策與不震盪的理由都在 canvasRowLayout.ts；這裡不用 media query（斷點只看得到
          視窗寬度，看不到「畫布被哪一軸夾住」）。
        */}
        <div
          ref={setCanvasRowElement}
          className={`canvas-row${stackTextRail ? ` ${CANVAS_ROW_STACKED_CLASS}` : ""}`}
          // `--ar` 是純數字（寬÷高）餵給 styles.css 算 letterbox 尺寸——`calc()` 要拿它當
          // 除數，寫成 "1920 / 1080" 會展開成 `100cqw / 1920 / 1080`。
          // 用 aspect-ratio 則會被 max-width 夾掉而失效，見 styles.css 的 `.canvas`。
          // 掛在**這一層**（而不是 `.canvas` 上）是因為橫排時 `.canvas-fit` 也要拿它算高度，
          // 而 CSS 自訂屬性只往下繼承；`.canvas` 照樣繼承得到同一個值。
          style={{ "--ar": project.canvas.width / project.canvas.height } as CSSProperties}
        >
          <div className="canvas-fit" onWheel={handleStageWheel}>
            <div className={`canvas ${activeJob ? "generating" : ""}`}>
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
              {(activeTextLayer || image) && selected && (
                <PageNumberOverlay project={pageNumberProject} order={selected.order} />
              )}
            </div>
            {/*
              進行中的工作要有自己的一條狀態欄，不能塞進上面那排說明——「正在重繪」與
              「正在抽取文字」是使用者需要等的事，得看得見。

              放在畫布那一欄（而不是整列）才會對齊畫布中線；刻意絕對定位、不佔版面高度：
              自動儲存在每次編輯後都會出現一次，若它撐開版面，畫布會在打字途中反覆縮放。
            */}
            {textLayerTask && (
              <div className="text-layer-progress" role="status">
                <i className="text-layer-progress-dot" />
                {textLayerTask === "extract"
                  ? "正在抽取文字…"
                  : textLayerTask === "create"
                    ? "正在建立文字編輯版本…"
                    : "正在重繪並自動儲存…"}
              </div>
            )}
          </div>
          {/*
            工具列**只要這一頁有圖就佔位**，按不按得下去交給每一顆自己的 disabled。
            它與畫布分食同一列（側排時是右邊一欄、橫排時是下方一條），掛載與卸載會直接改變
            畫布的可用空間：實測 1440×900（側排）下畫布在
            597px ↔ 649px 之間跳約 9%，而預覽歷史版本、生成中、剛建立文字層都會觸發，
            使用者眼中就是圖自己忽大忽小。語意沒有放寬——預覽與生成中依然不能加字，
            只是按鈕變灰而不是整條消失。
            剩下唯一還會跳的情形是「這一頁連圖都還沒生成」：那時畫布是空狀態插畫、
            使用者也沒有東西可編輯，跳一次可以接受，不值得為它留一條空工具列。
          */}
          {image && (
            <div
              ref={setTextRailElement}
              className="text-layer-rail"
              role="group"
              aria-label="文字工具"
            >
              <button
                onClick={addTextBox}
                /*
                 * 沒有文字層時，任何進行中的文字圖層工作都要擋住這一顆：
                 * - `create` 是連按第二下，會生出第二個手動層版本。
                 * - `extract` 更隱蔽：`startTextExtraction` 要等一次往返才把 job 寫進專案狀態，
                 *   在那之前 `activeJob` 還是 undefined、`canStartManualText` 仍然成立，按下去
                 *   建出來的手動層會被隨後完成的抽字版本擠掉 currentVersionId（字沒丟，但要去
                 *   版本列表才找得回來）。
                 * 有文字層時**不能**用 textLayerBusy 擋：那條路的 busy 幾乎都是編輯後的常駐
                 * autosave（`save`），擋掉等於打字期間不准加框。
                 * 第一項 `!activeTextLayer && !canStartManualText` 是工具列改成常駐佔位之後的
                 * 主要守門：預覽歷史版本、生成中，以及「這一版已經有文字層但現在不可互動」
                 * 都落在這裡。
                 */
                disabled={
                  (!activeTextLayer && !canStartManualText) ||
                  textLayerTask === "create" ||
                  (!activeTextLayer && textLayerBusy)
                }
                aria-label="新增文字框"
                title={activeTextLayer ? "新增文字框" : "新增文字框（會先建立可編輯文字的新版本）"}
              >
                <TextToolIcon shape="add" />
              </button>
              {/*
                後面三顆都要自己帶上 `!activeTextLayer`，不能只靠「沒有選中框／沒有歷史」：
                工具列常駐之後，預覽歷史版本時 `textBoxes` 與 `selectedTextId` 仍然是**目前
                版本**的（重新播種只跟著 currentVersionId 走），按下去會改到畫面上根本沒顯示
                的那一版，而且會觸發自動儲存。工具列還會卸載的時代這是不可能發生的。
              */}
              <button
                disabled={!activeTextLayer || !selectedText}
                aria-label="刪除文字框"
                title="刪除文字框（Delete）"
                onClick={() => {
                  changeTextBoxes(textBoxes.filter((box) => box.id !== selectedTextId));
                  setSelectedTextId(undefined);
                }}
              >
                <TextToolIcon shape="delete" />
              </button>
              <button
                disabled={!activeTextLayer || !textUndo.length}
                aria-label="復原"
                title="復原（⌘/Ctrl+Z）"
                onClick={() => applyTextHistory("undo")}
              >
                <TextToolIcon shape="undo" />
              </button>
              <button
                disabled={!activeTextLayer || !textRedo.length}
                aria-label="重做"
                title="重做（⇧⌘/Ctrl+Shift+Z）"
                onClick={() => applyTextHistory("redo")}
              >
                <TextToolIcon shape="redo" />
              </button>
            </div>
          )}
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
            {/* 連按會對同一個 job 送出好幾次 DELETE，而畫面上完全沒有「已經按過了」的痕跡。 */}
            <button
              disabled={cancelBusy}
              onClick={() => {
                setCancelBusy(true);
                void api
                  .cancel(project.id, activeJob.id)
                  .then(() => api.getProject(project.id))
                  .then(setProject)
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : "取消失敗"),
                  )
                  .finally(() => setCancelBusy(false));
              }}
            >
              {cancelBusy ? "正在取消…" : "取消生成"}
            </button>
          </div>
        )}
        {lastJob?.status === "failed" && (
          /*
           * 生成是這個 app 的核心動作，也是最常失敗的（配額、逾時、readiness、provider
           * 不支援），但這裡原本只有一行不會被播報、也沒有下一步的死訊息。`role="alert"`
           * 讓它出現時就講出來，重試鈕比照 `PdfDeckAnalysis` 的錯誤列——重跑同一頁的生成。
           *
           * 不另外做「關閉」：重試成功會排出新 job，`lastJob` 隨即換人，這則訊息自己會走。
           */
          <div className="job-error" role="alert">
            生成失敗{lastJob.errorCode ? `（${lastJob.errorCode}）` : ""}：{lastJob.error}
            <button
              onClick={() => void generate()}
              disabled={
                generateBusy ||
                !!activeJob ||
                !!previewVersion ||
                provider?.availability.status !== "available" ||
                readinessBusy
              }
            >
              重試
            </button>
          </div>
        )}
        {/* 刻意不放「版本歷史」標題：縮圖卡片本身已帶時間戳與「使用中」標記，
            省下的高度全部讓給畫布。無障礙資訊仍在每張卡片的 aria-label 上。 */}
        <div className="versions">
          <div className="version-list">
            {selected?.versions.length === 0 && <span className="empty-inline">尚無版本</span>}
            {[...(selected?.versions ?? [])].reverse().map((version) => {
              const isCurrent = version.id === selected?.currentVersionId;
              const isPreviewing = version.id === previewVersion?.id;
              const versionNumber =
                (selected?.versions.findIndex((candidate) => candidate.id === version.id) ?? 0) + 1;
              return (
                // 刪除鈕必須是獨立的 button，巢狀 button 是無效 HTML；因此外層改用 div
                // 當定位容器，預覽仍然是裡面那顆原本的 button。
                <div className="version-item" key={version.id}>
                  <button
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
                  {/* 使用中的版本刪不掉（伺服器也擋），不顯示按鈕免得使用者白按一次。 */}
                  {!isCurrent && selected && (
                    <button
                      type="button"
                      className="version-delete"
                      aria-label={`刪除版本 ${versionNumber}`}
                      disabled={!!deletingVersionId}
                      onClick={() => {
                        if (deletingVersionId) return;
                        if (!window.confirm(versionDeleteConfirmText(version))) return;
                        setDeletingVersionId(version.id);
                        void run(async () => {
                          try {
                            return await api.deleteVersion(project.id, selected.id, version.id);
                          } catch (reason) {
                            const code = reason instanceof Error ? reason.message : "";
                            throw new Error(
                              VERSION_DELETE_MESSAGES[code] ?? (code || "刪除版本失敗"),
                            );
                          }
                        })
                          .then((updated) => {
                            // 預覽中的版本被刪掉後，這個 id 已經指不到任何版本了；留著它
                            // 只會讓下一次點同一張卡片的切換行為看起來時靈時不靈。
                            if (updated && previewVersionId === version.id)
                              setPreviewVersionId(undefined);
                          })
                          .finally(() => setDeletingVersionId(undefined));
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </main>
      <aside className="inspector" id="inspector">
        {/*
          選中狀態原本只有 CSS class 撐著：閱讀器聽到四顆一模一樣的按鈕，唯一得知現狀的
          辦法是按下去——而按下去就換掉了整個面板。`aria-current="page"` 是最小修法；
          完整的 `role="tablist"` 要連帶實作方向鍵巡覽（Home／End、`aria-controls`、
          roving tabindex），成本高得多，這次不做。
        */}
        <div className="inspector-tabs">
          <button
            className={panel === "slide" ? "active" : ""}
            {...(panel === "slide" ? { "aria-current": "page" as const } : {})}
            onClick={() => setPanel("slide")}
          >
            頁面
          </button>
          <button
            className={panel === "project" ? "active" : ""}
            {...(panel === "project" ? { "aria-current": "page" as const } : {})}
            onClick={() => setPanel("project")}
          >
            專案
          </button>
          {/* 來源筆數原本掛在 header 的導覽列上，導覽列收掉後改由這個分頁承接（accessible name 仍是「來源 N」）。 */}
          <button
            className={panel === "sources" ? "active" : ""}
            {...(panel === "sources" ? { "aria-current": "page" as const } : {})}
            onClick={() => setPanel("sources")}
          >
            來源 <b>{project.sources.length}</b>
          </button>
          <button
            className={panel === "export" ? "active" : ""}
            {...(panel === "export" ? { "aria-current": "page" as const } : {})}
            onClick={() => setPanel("export")}
          >
            匯出
          </button>
          {/*
           * 收合鈕留在分頁列裡，收起來之後它是側邊欄唯一還看得見的東西（其餘由 CSS 藏掉），
           * 所以還原鈕與收合鈕是同一顆——不必另外找地方擺一個只有收合時才存在的按鈕。
           */}
          <button
            type="button"
            className="inspector-collapse"
            // 少了 aria-controls，讀螢幕的人只聽得到「已展開／已收合」，卻不知道是什麼展開了。
            aria-controls="inspector"
            aria-expanded={!inspectorCollapsed}
            aria-label={inspectorCollapsed ? "展開側邊欄" : "收起側邊欄"}
            title={inspectorCollapsed ? "展開側邊欄" : "收起側邊欄，放大編輯區"}
            onClick={() => setInspectorCollapsed((collapsed) => !collapsed)}
          >
            {inspectorCollapsed ? "‹" : "›"}
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
                {/* 橘框的文字版本。用既有的 `.provider-note` 提示樣式，沒有新增 class。 */}
                {dirtyFieldLabels.length > 0 && (
                  <div className="provider-note" id={outlineDirtyNoteId}>
                    {dirtyFieldLabels.join("、")}
                    ：這幾欄已修改，尚未反映到目前的圖片——重新生成才會套用。
                  </div>
                )}
                <label className={fieldDirty("content") ? "outline-dirty" : ""}>
                  內容
                  <textarea
                    readOnly={outlineReadOnly}
                    rows={4}
                    value={outlineView.content}
                    {...(fieldDirty("content") ? { "aria-describedby": outlineDirtyNoteId } : {})}
                    onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  />
                </label>
                <label className={fieldDirty("narrative") ? "outline-dirty" : ""}>
                  敘事
                  <textarea
                    readOnly={outlineReadOnly}
                    rows={3}
                    value={outlineView.narrative}
                    {...(fieldDirty("narrative") ? { "aria-describedby": outlineDirtyNoteId } : {})}
                    onChange={(event) => setDraft({ ...draft, narrative: event.target.value })}
                  />
                </label>
                <label className={fieldDirty("layoutHint") ? "outline-dirty" : ""}>
                  構圖提示
                  <textarea
                    readOnly={outlineReadOnly}
                    rows={3}
                    value={outlineView.layoutHint}
                    {...(fieldDirty("layoutHint")
                      ? { "aria-describedby": outlineDirtyNoteId }
                      : {})}
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
                    {...(fieldDirty("imagePrompt")
                      ? { "aria-describedby": outlineDirtyNoteId }
                      : {})}
                    onChange={(event) => setDraft({ ...draft, imagePrompt: event.target.value })}
                  />
                </label>
                <fieldset>
                  <legend>此頁來源</legend>
                  {project.sources.length === 0 ? (
                    <small>請先在「來源」上傳資料。</small>
                  ) : (
                    <SlideSourceChips
                      groupId={outlineView.id}
                      sources={project.sources}
                      selection={outlineView}
                      disabled={outlineReadOnly}
                      layout="stack"
                      // 一律以畫面上顯示的那份選取為準來切換。預覽歷史版本時 outlineView 是
                      // 舊快照、draft 是目前草稿，兩者的 sourceIds 並不一致；雖然唯讀時點不到，
                      // 讀 draft 會讓「看到的」與「改到的」不是同一份，是留給後人的地雷。
                      onToggle={(sourceId) => setDraft(toggleSourcePin(outlineView, sourceId))}
                    />
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
                // `generateBusy` 補的是 `activeJob` 出現之前那段空窗（readiness → save →
                // generate → getProject 四趟往返），那段時間按鈕本來是亮的。
                disabled={
                  generateBusy ||
                  !!activeJob ||
                  !!previewVersion ||
                  provider?.availability.status !== "available" ||
                  readinessBusy ||
                  !readiness ||
                  readiness.blocking ||
                  (readiness.requiresAcknowledgement && !acceptUnknownReadiness)
                }
              >
                {activeJob || generateBusy
                  ? "生成中…"
                  : selected?.versions.length
                    ? "重新生成圖片"
                    : "生成此頁"}
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
                // 說明掛在外層而不是按鈕上：批次進行中那顆是 disabled 的，而瀏覽器不會對
                // disabled 的表單控制項派送指標事件，掛在它身上的 tooltip 永遠顯示不出來。
                title={
                  batchExtract
                    ? "批次抽離文字進行中；伺服器一次只跑一頁 OCR，等它跑完或按「停止」再抽這一頁。"
                    : "只處理當頁；低於門檻的文字保留在原圖。"
                }
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
                      /*
                       * 批次抽字進行中時不准單獨再抽一頁。
                       *
                       * `textLayerBusy` 擋不住這個：它只看**當前這一頁**，使用者切到別頁
                       * 那顆就亮了，於是兩個 OCR 請求同時在飛。伺服器的閘門是 1 active ＋
                       * 2 waiting，多出來的那一筆很容易讓批次裡的某一頁撞上 429
                       * `OCR_QUEUE_BUSY`——而那個代碼會把**整批**停掉。
                       */
                      batchExtract !== undefined ||
                      // 這個版本已經有抽出來的文字層了：再抽一次是拿 OCR ＋ 抹字引擎重做一份
                      // 已經精確而且零成本的東西（PDF 匯入的文字層取自原生文字層）。手動層
                      // 不在此列——它的背景一個字都沒抹，圖上原本的文字還等著被抽出來。
                      (!!selectedVersion?.textLayer &&
                        (selectedVersion.textLayer.origin ?? "extracted") === "extracted") ||
                      // OpenCV 引擎在本機跑，不受生圖模型的 maskedEditing 能力限制。
                      (textExtractEngine === "model" && !provider?.capabilities.maskedEditing)
                    }
                    title={
                      selectedVersion?.textLayer?.origin === "manual"
                        ? "把圖上原本的文字也抽出來（會與你手動加的文字合併成新版本）"
                        : selectedVersion?.textLayer
                          ? "這個版本已經有可編輯文字層了"
                          : "以 OCR 抽離文字並抹除原圖上的文字"
                    }
                  >
                    {textLayerBusy ? "處理中…" : "抽離文字"}
                  </button>
                  <button
                    className="threshold-toggle"
                    aria-expanded={showTextThreshold}
                    aria-label="調整文字抽離選項"
                    title="調整文字抽離選項"
                    onClick={() => setShowTextThreshold((open) => !open)}
                  >
                    <span className="caret">▾</span>
                  </button>
                </div>
                {showTextThreshold && (
                  <>
                    <label className="extract-engine">
                      抹字引擎
                      <select
                        aria-label="抹字引擎"
                        value={textExtractEngine}
                        onChange={(event) =>
                          setTextExtractEngine(event.target.value as "opencv" | "model")
                        }
                      >
                        <option value="opencv">OpenCV（快速，預設）</option>
                        <option value="model">生圖模型</option>
                      </select>
                    </label>
                    <label className="extract-engine">
                      文字修復
                      <select
                        aria-label="文字修復"
                        value={textRepair}
                        onChange={(event) => setTextRepair(event.target.value as "off" | "outline")}
                      >
                        <option value="off">關閉（預設，照 OCR 讀到的）</option>
                        <option value="outline">大綱修復</option>
                      </select>
                    </label>
                    {textRepair === "outline" && (
                      <small className="extract-hint">
                        以這頁的大綱為準修掉 OCR 的空格與誤認字；圖上文字若不是逐字來自大綱，
                        可能被改成大綱裡的相似句子。
                      </small>
                    )}
                    {/* 說明走原生 title tooltip 而非常駐 <small>：這段字比選項本身長三倍，
                        常駐會把門檻滑桿擠出面板可視範圍；且面板祖先是 overflow: hidden，
                        自繪的 tooltip 泡泡會被裁掉，原生的不會。與 .text-layer-rail 那排
                        圖示鈕同一套慣例。 */}
                    <label
                      className="extract-toggle"
                      title={
                        "只改簡體專屬字形：「台」「里」「面」「后」「干」「云」這類繁體中本來就合法的字不會被動到" +
                        "（所以「云计算」只會修成「云計算」）。\n含日文假名的文字框整框跳過。"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={traditionalize}
                        onChange={(event) => setTraditionalize(event.target.checked)}
                      />
                      簡體轉繁體
                    </label>
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
                  </>
                )}
              </div>
            </div>
            {/* 沒有選取文字框時整塊不出現：只剩一個 TEXT BOX 標題與一句「去選一個」
                的區塊，本身沒有任何可操作的東西，卻在面板上佔著一段高度並讓人以為
                這裡壞了。標題與內容一起出現、一起消失。 */}
            {textEditing && selectedText && (
              <div className="text-properties fields">
                <div className="section-label">TEXT BOX</div>
                <div className="text-property-grid font-row">
                  <label>
                    字體
                    <input
                      value={selectedText.fontFamily}
                      onChange={(event) => patchSelectedText({ fontFamily: event.target.value })}
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
                {/*
                  底色與描邊：各是**勾選框開關 ＋ 旁邊一顆下拉**，參數收在下拉裡，兩組再併成
                  同一排。攤開就是兩個三四欄的 grid、佔掉面板約 150px，而它們是偶爾才調一次的
                  東西；縮成一顆下拉之後每組只剩約 95px 寬，一排放得下兩組，再拆成兩排等於白
                  吃掉一整行。
                  「有沒有套」由勾選框本身講清楚，現在是什麼顏色則直接畫在觸發鈕的色塊上，
                  兩件事都不必打開下拉就看得到。細節與定位理由見 `TextEffectRow`。
                */}
                <div className="text-effect-rows">
                  <TextEffectRow
                    label="底色"
                    enabled={Boolean(selectedText.backgroundColor)}
                    swatchColor={selectedText.backgroundColor ?? TEXT_BACKGROUND_DEFAULT_COLOR}
                    open={openTextEffect === "background"}
                    onOpenChange={(next) => setOpenTextEffect(next ? "background" : undefined)}
                    onEnabledChange={(next) => {
                      if (!next) {
                        clearSelectedTextBackground();
                        return;
                      }
                      patchSelectedText({
                        backgroundColor: TEXT_BACKGROUND_DEFAULT_COLOR,
                        backgroundOpacity: 1,
                      });
                    }}
                  >
                    <label>
                      色票
                      <input
                        type="color"
                        aria-label="文字框底色"
                        value={selectedText.backgroundColor ?? TEXT_BACKGROUND_DEFAULT_COLOR}
                        onChange={(event) =>
                          patchSelectedText({ backgroundColor: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      底色不透明度
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={selectedText.backgroundOpacity ?? 1}
                        onChange={(event) => {
                          // 數字框可以被清空或打進超界值；schema 只收 0–1，
                          // 這裡先夾好再寫入，否則存檔時整批文字框會被伺服器擋下。
                          // 清空／非數字一律保留原值：`Number("")` 是 0（而且是有限數），
                          // 照寫回去等於底色無聲消失，勾選框卻還是勾的。
                          const raw = event.target.value.trim();
                          if (!raw) return;
                          const next = Number(raw);
                          if (!Number.isFinite(next)) return;
                          patchSelectedText({ backgroundOpacity: Math.min(1, Math.max(0, next)) });
                        }}
                      />
                    </label>
                  </TextEffectRow>
                  {/* 描邊：形狀與上面那組底色一致（色彩欄位＝開關，其餘是它的參數）。
                      刻意是**逐框**的可選項而不是專案級開關：白字壓在明暗不定的生成圖上時
                      它是可讀性的解藥，但同一份簡報裡乾淨純色底的那幾頁套上去只會顯得髒。 */}
                  <TextEffectRow
                    label="描邊"
                    enabled={Boolean(selectedText.strokeColor)}
                    swatchColor={selectedText.strokeColor ?? TEXT_STROKE_DEFAULT_COLOR}
                    open={openTextEffect === "stroke"}
                    onOpenChange={(next) => setOpenTextEffect(next ? "stroke" : undefined)}
                    onEnabledChange={(next) => {
                      if (!next) {
                        clearSelectedTextStroke();
                        return;
                      }
                      patchSelectedText({
                        strokeColor: TEXT_STROKE_DEFAULT_COLOR,
                        strokeWidth: TEXT_STROKE_DEFAULT_WIDTH_EM,
                        strokeOpacity: TEXT_STROKE_DEFAULT_OPACITY,
                      });
                    }}
                  >
                    <label>
                      描邊色
                      <input
                        type="color"
                        aria-label="文字描邊色"
                        value={selectedText.strokeColor ?? TEXT_STROKE_DEFAULT_COLOR}
                        onChange={(event) => patchSelectedText({ strokeColor: event.target.value })}
                      />
                    </label>
                    <label>
                      {/* 單位是 em（字級的倍數），所以改字級時描邊會等比跟著走。 */}
                      粗細（em）
                      <input
                        type="number"
                        min="0"
                        max={TEXT_STROKE_MAX_WIDTH_EM}
                        step="0.01"
                        aria-label="文字描邊粗細"
                        value={selectedText.strokeWidth ?? TEXT_STROKE_DEFAULT_WIDTH_EM}
                        onChange={(event) => {
                          // 與底色不透明度同一套：清空／非數字保留原值，超界先夾再寫。
                          const raw = event.target.value.trim();
                          if (!raw) return;
                          const next = Number(raw);
                          if (!Number.isFinite(next)) return;
                          patchSelectedText({
                            strokeWidth: Math.min(TEXT_STROKE_MAX_WIDTH_EM, Math.max(0, next)),
                          });
                        }}
                      />
                    </label>
                    <label>
                      描邊不透明度
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        aria-label="文字描邊不透明度"
                        value={selectedText.strokeOpacity ?? TEXT_STROKE_DEFAULT_OPACITY}
                        onChange={(event) => {
                          const raw = event.target.value.trim();
                          if (!raw) return;
                          const next = Number(raw);
                          if (!Number.isFinite(next)) return;
                          patchSelectedText({ strokeOpacity: Math.min(1, Math.max(0, next)) });
                        }}
                      />
                    </label>
                  </TextEffectRow>
                </div>
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
            <div className="inspector-heading page-number-heading">
              <span>PAGE NUMBER</span>
            </div>
            {/* 頁碼是專案級設定，改了立即套用，不併進「儲存 Brief」——它與大綱無關，
                而且畫布上的預覽要馬上跟著動才看得出調整效果。
                滑桿與色票走 debounce（見 patchPageNumber），其餘控制項一次一個值即時送出。 */}
            <label className="check-row page-number-toggle">
              <input
                type="checkbox"
                checked={pageNumber.enabled}
                onChange={(event) => patchPageNumber({ enabled: event.target.checked })}
              />
              顯示頁碼
            </label>
            {pageNumber.enabled && (
              <div className="page-number-fields">
                <label>
                  位置
                  <select
                    value={pageNumber.position}
                    onChange={(event) =>
                      patchPageNumber({
                        position: pageNumberPositionSchema.parse(event.target.value),
                      })
                    }
                  >
                    <option value="bottom-left">左下</option>
                    <option value="bottom-center">置中</option>
                    <option value="bottom-right">右下</option>
                  </select>
                </label>
                <label>
                  格式
                  <select
                    value={pageNumber.format}
                    onChange={(event) =>
                      patchPageNumber({ format: pageNumberFormatSchema.parse(event.target.value) })
                    }
                  >
                    <option value="number">3</option>
                    <option value="number-total">3 / 12</option>
                    <option value="zh-page">第 3 頁</option>
                  </select>
                </label>
                <ClampedNumberField
                  label="起始頁碼"
                  value={pageNumber.startAt}
                  min={1}
                  max={999}
                  onCommit={(startAt) => patchPageNumber({ startAt })}
                />
                <label className="check-row page-number-toggle">
                  <input
                    type="checkbox"
                    checked={pageNumber.skipFirstSlide}
                    onChange={(event) => patchPageNumber({ skipFirstSlide: event.target.checked })}
                  />
                  封面不編號
                </label>
                <ClampedNumberField
                  label="字級"
                  value={pageNumber.fontSize}
                  min={12}
                  max={120}
                  onCommit={(fontSize) => patchPageNumber({ fontSize })}
                />
                <label>
                  顏色
                  <input
                    type="color"
                    value={pageNumber.color}
                    onChange={(event) =>
                      patchPageNumber({ color: event.target.value }, { debounce: true })
                    }
                  />
                </label>
                <label>
                  透明度
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={pageNumber.opacity}
                    onChange={(event) =>
                      patchPageNumber({ opacity: Number(event.target.value) }, { debounce: true })
                    }
                  />
                </label>
                <label className="check-row page-number-toggle">
                  <input
                    type="checkbox"
                    checked={pageNumber.background.enabled}
                    onChange={(event) =>
                      patchPageNumber({ background: { enabled: event.target.checked } })
                    }
                  />
                  加上背景色塊
                </label>
                {pageNumber.background.enabled && (
                  <>
                    <label>
                      色塊顏色
                      <input
                        type="color"
                        value={pageNumber.background.color}
                        onChange={(event) =>
                          patchPageNumber(
                            { background: { color: event.target.value } },
                            { debounce: true },
                          )
                        }
                      />
                    </label>
                    <label>
                      色塊透明度
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={pageNumber.background.opacity}
                        onChange={(event) =>
                          patchPageNumber(
                            { background: { opacity: Number(event.target.value) } },
                            { debounce: true },
                          )
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            {/*
              這兩顆原本零回饋：不 disabled、文案不變、也沒有進度。「依 Brief 重建大綱」會跑
              一次網路搜尋加兩階段大綱生成（實測數十秒到數分鐘），使用者的必然反應是再按一次
              ——而每一次都重跑一整輪搜尋與模型呼叫（燒配額），最後幾筆回應還會互相覆蓋掉剛
              生出來的大綱。照抄同檔 `outlineBusy` 那顆的模式：進行中改文案並互相 disabled。
            */}
            <div className="panel-actions">
              <button
                className="primary"
                disabled={briefBusy !== undefined}
                onClick={() => {
                  setBriefBusy("save");
                  void run(() =>
                    api.updateBrief(project.id, briefPatchWithoutWebSearch(briefDraft)),
                  ).finally(() => setBriefBusy(undefined));
                }}
              >
                {briefBusy === "save" ? "正在儲存…" : "儲存 Brief"}
              </button>
              <button
                disabled={briefBusy !== undefined}
                onClick={() => {
                  // 指定的來源是使用者最不預期會失去的東西：頁面整批換成新的，指定自然
                  // 跟著消失，所以確認視窗要講明白，而不是只說「取代目前頁面」。
                  if (!confirm("重新產生大綱會取代目前頁面（包含你指定的來源），確定繼續？"))
                    return;
                  setBriefBusy("regenerate");
                  void run(() => api.regenerateOutline(project.id, true)).finally(() =>
                    setBriefBusy(undefined),
                  );
                }}
              >
                {briefBusy === "regenerate" ? "正在檢索來源與重建大綱…" : "依 Brief 重建大綱"}
              </button>
              <button
                className="batch-generate"
                // 有隱藏頁就先問要不要連它們一起生成；沒有就完全不多一次點擊。
                onClick={() => {
                  if (hiddenCount > 0) setAskBatchChoice(true);
                  else void runBatchGenerate("all");
                }}
                // `batchGenerateBusy` 補的是 `project.jobs` 出現排隊中的 job 之前那段空窗
                // （save ＋ generateAll ＋ getProject 三趟往返），那段時間按鈕本來是亮的。
                disabled={
                  batchGenerateBusy ||
                  project.jobs.some((job) => ["queued", "running"].includes(job.status)) ||
                  readinessBusy ||
                  !readiness ||
                  readiness.blocking
                }
              >
                {batchGenerateBusy ? "正在排程批次生成…" : "批次生成全部頁面"}
              </button>
              {/*
                批次抽離全部文字。進行中時這一顆變成進度顯示（不可再按），旁邊多長出一顆
                「停止」——停止只擋得下還沒送出的頁，所以兩顆要並排在同一列，讓「正在做的
                是第幾頁」與「停下來」在同一個視線落點上。
              */}
              {/*
                `title` 掛在這一列而不是按鈕上：按鈕在最需要解釋的時候（灰掉時）正好是
                disabled 的，而 Chrome／Safari 不會對 disabled 的表單控制項派送指標事件，
                掛在它身上的 tooltip 一次都不會出現（jsdom 抓得到屬性，所以測試綠不代表看得到）。
              */}
              <div className="batch-extract-row" title={batchExtractTitle}>
                <button
                  className="batch-extract"
                  // 抹字引擎是生圖模型時，每一頁都會排一個遮罩編輯 job、燒一次影像配額，
                  // 隱藏頁因此變成一個真的取捨（與批次生成同一個結構）：走共用的三選一。
                  // OpenCV 或沒有隱藏頁時維持單一 confirm，不多一次點擊。
                  onClick={() => {
                    if (textExtractEngine === "model" && extractPlan.hiddenTargets > 0)
                      setAskBatchExtractChoice(true);
                    else void runBatchTextExtraction(extractPlan.targets);
                  }}
                  disabled={batchExtractDisabled}
                >
                  {batchExtract
                    ? `抽離文字 ${batchExtract.current} / ${batchExtract.total}…`
                    : "批次抽離全部文字"}
                </button>
                {batchExtract && (
                  <button
                    className="batch-extract-stop"
                    // 只立旗：在飛的那一頁沒有取消機制（見 `runBatchTextExtraction` 的註解），
                    // 這顆的語意就是「做完這一頁之後不要再送了」。
                    onClick={() => {
                      batchExtractStop.current = "user";
                      setBatchExtract((current) =>
                        current ? { ...current, stopping: true } : current,
                      );
                    }}
                    disabled={batchExtract.stopping}
                    title="做完目前這一頁就停下；已經送出的那一頁沒有辦法取消。"
                  >
                    {batchExtract.stopping ? "停止中…" : "停止"}
                  </button>
                )}
              </div>
            </div>
            {/*
              模型用量統計。面板自己抓資料（切到這個分頁＝掛載＝抓一次），**沒有輪詢**——
              `Editor.tsx` 已經有一條專案輪詢，用量再加一條定時器只是多打請求。批次生成
              收尾時另外遞一個 `usageRefreshToken` 讓它重抓一次（見上面那條 effect）。
              `key` 是第二道保險：換專案時強制重建，上一份專案的數字不可能留在畫面上
              （元件內部另有一道 render 期的守衛，見 `UsagePanel.tsx`）。
            */}
            <UsagePanel key={project.id} projectId={project.id} refreshToken={usageRefreshToken} />
          </div>
        )}
        {panel === "sources" && (
          <div className="panel-content sources-panel">
            <div className="inspector-heading">
              <span>SOURCES</span>
              {/*
                分母來自 core 的常數，不是抄一份數字：使用者實測時看到的 `SOURCES 175/100`
                就是抄出來的——伺服器早放寬到 200，畫面上還印著 100，而且沒有任何測試會紅。
              */}
              <b>
                {project.sources.length}/{SOURCE_COUNT_LIMIT}
              </b>
            </div>
            <SourcePanel project={project} onProject={setProject} onError={setError} />
          </div>
        )}
        {panel === "export" && (
          <div className="panel-content export-panel">
            <div className="inspector-heading">
              <span>EXPORT</span>
            </div>
            <section className="export-group">
              <h3>專案</h3>
              {/*
                靜態的匯出規則說明已依使用者要求移除；只留「這份簡報實際上有隱藏頁」這一句，
                因為那不是通則而是當下狀態，且 pptx／pdf 的頁數會與畫面上看到的不同——
                「哪些頁面會進成品」在有差異時仍必須寫在下載點旁邊（縮圖列那顆 23px 按鈕的
                tooltip 在使用者按下「下載 PowerPoint」時是看不到的）。
              */}
              {hiddenCount > 0 && (
                <p>
                  有 <strong>{hiddenCount}</strong> 頁隱藏：pptx／pdf 只含可見的{" "}
                  <strong>{visibleSlideCount}</strong> 頁。
                </p>
              )}
              {visibleSlideCount === 0 ? (
                // 全部隱藏時伺服器會回 400；匯出連結是裸 `<a href>`，讓它按下去等於把一段
                // JSON 丟進瀏覽器分頁。這裡先擋住並就地說明。
                <p className="export-blocked" role="status">
                  所有頁面都已隱藏，pptx／pdf 沒有可以匯出的頁面。請先取消隱藏至少一頁；
                  下方兩種格式仍會收錄全部頁面。
                </p>
              ) : (
                <>
                  <a href={`/api/projects/${encodeURIComponent(project.id)}/export/pptx`}>
                    下載 PowerPoint (.pptx)
                  </a>
                  <a href={`/api/projects/${encodeURIComponent(project.id)}/export/pdf`}>
                    下載 PDF (.pdf)
                  </a>
                </>
              )}
              <a href={`/api/projects/${encodeURIComponent(project.id)}/export/png.zip`}>
                下載每頁 PNG (.zip)
              </a>
              <a href={`/api/projects/${encodeURIComponent(project.id)}/export/slide-project`}>
                備份完整專案 (.slide-project.zip)
              </a>
            </section>
            <section className="export-group">
              <h3>
                <span>當前頁面</span>
                {selected && <b>第 {selected.order + 1} 頁</b>}
              </h3>
              {/*
                隱藏頁照樣給連結：`hidden` 的語意是「這一頁不上場」而不是「不要這張圖」，
                png.zip 本來就收錄它。沒有目前版本時整個不給連結——伺服器會回 400，而這是
                裸 `<a href>`，按下去只會得到一段 JSON。
              */}
              {selected && activeImage ? (
                <a
                  href={`/api/projects/${encodeURIComponent(project.id)}/slides/${encodeURIComponent(selected.id)}/export/png`}
                >
                  下載此頁 PNG (.png)
                </a>
              ) : (
                <p className="export-blocked" role="status">
                  這一頁還沒有圖片，沒有可以下載的 PNG。請先生成這一頁。
                </p>
              )}
            </section>
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
          ref={stylePickerRef}
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
                  const full = style.referenceImages.length >= STYLE_REFERENCE_IMAGE_LIMIT;
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
                          · 參考圖 {style.referenceImages.length}/{STYLE_REFERENCE_IMAGE_LIMIT}
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
          onClick={() => {
            if (presentationNext !== undefined) setPresentationIndex(presentationNext);
          }}
        >
          <div className="presentation-surface">
            {presentationImage ? (
              // 頁碼要疊在「圖片實際佔到的那塊矩形」上，而不是整個 100vw×100vh 的舞台：
              // 圖片是 letterbox 置中的，兩者的比例不同時會差一整條黑邊。
              //
              // 尺寸顯式算出來，不用 aspect-ratio + max-width：這裡是 grid item，auto track
              // 依 max-content 撐大並溢出，`max-width` 夾不住，窄視窗下右側會被裁掉。
              // 長度單位取 `.presentation-surface` 的容器查詢單位而非 vw／vh，見 styles.css。
              <div
                className="presentation-stage"
                style={{
                  width: `min(100cqw, calc(100cqh * ${project.canvas.width} / ${project.canvas.height}))`,
                  height: `min(100cqh, calc(100cqw * ${project.canvas.height} / ${project.canvas.width}))`,
                }}
              >
                <img
                  src={presentationImage}
                  alt={`簡報第 ${presentationPosition} 頁`}
                  draggable={false}
                />
                <PageNumberOverlay project={pageNumberProject} order={presentationSlide.order} />
              </div>
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
              disabled={presentationPrev === undefined}
              onClick={() => {
                if (presentationPrev !== undefined) setPresentationIndex(presentationPrev);
              }}
            >
              ←
            </button>
            <span>
              {presentationPosition} / {visibleSlideCount}
            </span>
            <button
              aria-label="下一頁"
              disabled={presentationNext === undefined}
              onClick={() => {
                if (presentationNext !== undefined) setPresentationIndex(presentationNext);
              }}
            >
              →
            </button>
            <button
              className="presentation-close"
              aria-label="離開簡報模式"
              onClick={exitPresentation}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {askBatchChoice && (
        <BatchGenerateDialog
          total={project.slides.length}
          hiddenCount={hiddenCount}
          busy={saving}
          onCancel={() => setAskBatchChoice(false)}
          onChoose={(choice) => {
            setAskBatchChoice(false);
            void runBatchGenerate(choice);
          }}
        />
      )}
      {askBatchExtractChoice && (
        <BatchGenerateDialog
          variant="extract"
          // 分母是**這次要抽字的頁數**，不是整份簡報：已經有文字層、還沒有圖的頁根本不在
          // 名單裡，拿總頁數當分母會讓兩顆按鈕上的數字對不上使用者按下去真正會發生的事。
          total={extractPlan.targets.length}
          hiddenCount={extractPlan.hiddenTargets}
          busy={false}
          body={
            <>
              這次會處理 <strong>{extractPlan.targets.length}</strong> 頁，其中{" "}
              <strong>{extractPlan.hiddenTargets}</strong> 頁已隱藏。 隱藏頁不會進 pptx／pdf
              匯出，也不會出現在簡報放映中，而你選的抹字引擎是
              <strong>生圖模型</strong>，每一頁都會消耗一次影像模型配額。
              頁面會逐一排隊送出（伺服器一次只跑一頁 OCR），整批可能需要數分鐘；
              中途離開這份專案會停止批次。
            </>
          }
          onCancel={() => setAskBatchExtractChoice(false)}
          onChoose={(choice) => {
            setAskBatchExtractChoice(false);
            // 這個對話框本身就是那次確認，不要再跳一次 `confirm()`——連問兩遍同一件事
            // 只會讓人以為第一次沒按到。
            void runBatchTextExtraction(
              choice === "visible-only"
                ? extractPlan.targets.filter((slide) => !slide.hidden)
                : extractPlan.targets,
              true,
            );
          }}
        />
      )}
      {/*
        批次抽字的進度。這是全 app 最長的操作（150 頁的專案十幾分鐘），程式碼為它寫了大量
        中止、守衛與摘要邏輯，但進度在此之前只存在於按鈕文字裡——按下開始之後，看不到畫面的
        人完全不知道跑到第幾頁、有沒有卡住。同檔的 job 進度與文字圖層進度都有 `role="status"`，
        這裡是唯一漏掉的一條。

        掛在 shell 這一層而不是那顆按鈕旁邊：live region 必須先在 DOM 裡存在、之後的內容變動
        才會被播報，而按鈕住在「專案」分頁裡——使用者切到別的分頁時整條 live region 會卸載，
        剩下的頁數就此靜默。空字串時不佔版面也不播報。
      */}
      <div className="visually-hidden" role="status">
        {batchExtract
          ? `批次抽離文字：正在處理第 ${batchExtract.current} 頁，共 ${batchExtract.total} 頁。${
              batchExtract.stopping ? "已要求停止，做完這一頁就會停下。" : ""
            }`
          : ""}
      </div>
      {importNoticeToast}
      {error && <ErrorToast message={error} onDismiss={() => setError(undefined)} />}
    </div>
  );
}

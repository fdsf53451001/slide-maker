import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  type PresentationBrief,
  type PresentationProject,
  type SlideSpec,
  type StylePreset,
  SOURCE_COUNT_LIMIT,
  STYLE_REFERENCE_IMAGE_LIMIT,
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
import { UsagePanel } from "./UsagePanel.js";
import { PdfDeckAnalysis } from "./PdfDeckAnalysis.js";
import { ModelLibrary } from "./ModelLibrary.js";
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
import { nextVisibleIndex, visibleSlideIds } from "./editor/slideVisibility.js";
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
} from "./editor/projectHelpers.js";
import { useIsomorphicLayoutEffect } from "./editor/useIsomorphicLayoutEffect.js";
import { usePageNumberDraft } from "./editor/usePageNumberDraft.js";
import { useProjectPolling } from "./editor/useProjectPolling.js";
import { usePresentation } from "./editor/usePresentation.js";
import { useTextLayerEditing } from "./editor/useTextLayerEditing.js";
import { useTextExtraction } from "./editor/useTextExtraction.js";
import { useWebSearchToggle } from "./editor/webSearch.js";
import { SlideVisibilityIcon, TextToolIcon } from "./editor/icons.js";
import { SlideSourceChips } from "./editor/SlideSourceChips.js";
import { TextLayerCanvas } from "./editor/TextLayerCanvas.js";
import { PageNumberOverlay } from "./editor/PageNumberOverlay.js";
import { PageNumberFields } from "./editor/PageNumberFields.js";
import { ExportPanel } from "./editor/ExportPanel.js";
import { TextBoxProperties } from "./editor/TextBoxProperties.js";
import { SystemSettingsDialog } from "./editor/SystemSettingsDialog.js";
import { BatchGenerateDialog, type BatchGenerateChoice } from "./editor/BatchGenerateDialog.js";
import { ImageEditDialog } from "./editor/ImageEditDialog.js";
import { CreateProject } from "./editor/CreateProject.js";
import { SetupFlow } from "./editor/SetupFlow.js";

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
export { PageNumberOverlay } from "./editor/PageNumberOverlay.js";
export { ClampedNumberField } from "./editor/ClampedNumberField.js";
export { SystemSettingsDialog } from "./editor/SystemSettingsDialog.js";

// 錯誤通知列已抽到 `./ErrorToast.tsx`（連同它那份「為什麼是 div 包 button 而不是
// button[role=alert]」的說明）：模型庫與風格編輯器各自寫了一份形狀不同的 toast，而稽核抓到的
// 問題正是同一份 UI 漂移成多份拷貝（其中兩份漏了 role="alert"）。理由只留在元件那一份，
// 這裡不再複述——同一段理由的兩份拷貝遲早會有一份先過期。

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
  const [showTextThreshold, setShowTextThreshold] = useState(false);
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
  // 頁碼設定的樂觀值、序號防亂序與 debounce 寫回（整簇在 `usePageNumberDraft`）。
  const { pageNumberDraft, patchPageNumber } = usePageNumberDraft(project, setProject, setError);

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
  /*
   * `activeImage` 與 `canStartManualText` 宣告在這裡（而不是它們唯一的讀者 JSX 旁邊）：
   * `useTextLayerEditing` 的呼叫點必須排在下面那幾條 early return 之前，而 `addTextBox`
   * 兩者都要。多出來的 `project &&` 只是讓型別看得出「專案不存在時畫面上也沒有圖」——
   * early return 之後 `project` 恆非空，值與原本逐字相同。
   */
  const activeImage = project && selected ? currentImage(project, selected) : undefined;
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

  useEffect(() => {
    if (selected) setDraft(structuredClone(selected));
    setPreviewVersionId(undefined);
  }, [selected?.id]);
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
  /*
   * 簡報（放映）模式整簇：進場／退場、兩條自動清狀態、滾輪換頁（路徑②）與覆蓋層衍生值。
   * 鍵盤換頁（路徑①）刻意留在下方那條集中 keydown listener 裡（理由見 hook 的 JSDoc）。
   * 呼叫點排在 `canvasIsActiveSurface` 之前：那個判定在 render 期就要讀 `presentationIndex`。
   */
  const {
    presentationIndex,
    setPresentationIndex,
    presentationSlide,
    presentationImage,
    presentationPrev,
    presentationNext,
    presentationPosition,
    exitPresentation,
    startPresentation,
  } = usePresentation({
    project,
    route,
    selected,
    previewVersion,
    setSelectedId,
    setError,
  });
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
  /*
   * 文字圖層編輯整簇：文字框與復原歷史、重新播種、自動儲存與換頁 flush、文字框專用的兩條
   * keydown（複製／貼上／刪除、⌘Z／⇧⌘Z），以及屬性面板與工具列的變更入口。
   *
   * 呼叫點必須排在 `canvasIsActiveSurface` **之後**（那兩條 keydown 要它當 gate）、所有
   * early return **之前**（hook 順序不可隨路由變動）。下面那條集中 keydown 仍留在這裡，
   * 而且必須排在這個 hook **之後**——window listener 依註冊順序派送，換過去會讓集中鏈的
   * 簡報分支先於文字框的 Delete 拿到事件。
   */
  const {
    textBoxes,
    selectedTextId,
    setSelectedTextId,
    selectedText,
    textThreshold,
    setTextThreshold,
    textUndo,
    textRedo,
    openTextEffect,
    setOpenTextEffect,
    textLayerTasks,
    textLayerTask,
    textLayerBusy,
    trackTextLayerTask,
    changeTextBoxes,
    applyTextHistory,
    patchSelectedText,
    clearSelectedTextBackground,
    clearSelectedTextStroke,
    addTextBox,
  } = useTextLayerEditing({
    project,
    selected,
    selectedVersion,
    textEditing,
    canStartManualText,
    canvasIsActiveSurface,
    setProject,
    setError,
  });
  /*
   * 抽離文字整簇：三個選項、單頁與批次抽字、兩顆按鈕的 disabled 與 tooltip。
   * 呼叫點排在 `useTextLayerEditing` 之後（要它的 `textThreshold` 與 `trackTextLayerTask`）、
   * `useProjectPolling` 之前（`batchExtractBusy` 是輪詢那條用量邊緣的輸入）。
   */
  const {
    textExtractEngine,
    setTextExtractEngine,
    textRepair,
    setTextRepair,
    traditionalize,
    setTraditionalize,
    extractPlan,
    batchExtract,
    batchExtractBusy,
    batchExtractDisabled,
    batchExtractTitle,
    askBatchExtractChoice,
    setAskBatchExtractChoice,
    startTextExtraction,
    runBatchTextExtraction,
    requestStop,
  } = useTextExtraction({
    project,
    selected,
    selectedVersion,
    provider,
    readiness,
    readinessBusy,
    acceptUnknownReadiness,
    effectiveImageProviderId,
    textThreshold,
    textLayerTasks,
    trackTextLayerTask,
    setProject,
    setError,
    setImportNotice,
  });
  // 專案輪詢、用量刷新的 false 邊緣、job 計時器 tick（整簇在 `useProjectPolling`）。
  // 排在抽字之後：`batchExtractBusy` 期間整條用量邊緣要壓掉（見該 hook 的 JSDoc）。
  const { now, usageRefreshToken } = useProjectPolling({
    project,
    activeJobId: activeJob?.id,
    batchExtractBusy,
    setProject,
    setError,
  });
  const elapsedMs = activeJob ? now - Date.parse(activeJob.startedAt ?? activeJob.createdAt) : 0;
  const remainingMs =
    activeJob?.timeoutMs && activeJob.startedAt
      ? Math.max(0, activeJob.timeoutMs - elapsedMs)
      : undefined;
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

  const image = previewVersion ? imageUrl(project.id, previewVersion.imagePath) : activeImage;
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
              <TextBoxProperties
                selectedText={selectedText}
                openTextEffect={openTextEffect}
                onOpenTextEffect={setOpenTextEffect}
                onPatch={patchSelectedText}
                onClearBackground={clearSelectedTextBackground}
                onClearStroke={clearSelectedTextStroke}
              />
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
            <PageNumberFields pageNumber={pageNumber} onPatch={patchPageNumber} />
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
                    // 只立旗（見 `requestStop`）：在飛的那一頁沒有取消機制，這顆的語意
                    // 就是「做完這一頁之後不要再送了」。
                    onClick={requestStop}
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
          <ExportPanel
            projectId={project.id}
            selected={selected}
            activeImage={activeImage}
            hiddenCount={hiddenCount}
            visibleSlideCount={visibleSlideCount}
          />
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

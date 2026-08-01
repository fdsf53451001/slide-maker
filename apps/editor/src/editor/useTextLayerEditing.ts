import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EditableTextBox,
  PresentationProject,
  SlideSpec,
  SlideVersion,
} from "@slide-maker/core";
import { api } from "../api.js";
import { modalDialogOpen } from "../modalDialogOpen.js";
import {
  defaultTextBox,
  isTypingTarget,
  pastePosition,
  pushHistory,
  sameBoxes,
  type PendingTextSave,
  type TextLayerTask,
} from "./textBoxModel.js";

/**
 * 文字圖層編輯整簇：文字框狀態與復原歷史、換頁／換版本的重新播種、debounce 自動儲存與
 * 換頁 flush、文字框層級的鍵盤快捷鍵（複製／貼上／刪除、⌘Z／⇧⌘Z），以及屬性面板與工具列
 * 用的那幾個變更入口。
 *
 * **這裡的兩條 keydown listener 是文字框專用的**，與 `Editor` 那條集中 keydown（對話框
 * Esc → 簡報換頁 → 編輯模式上下鍵）不同：那條的分支順序本身就是行為，整條留在 `Editor`。
 * 兩者共用 `canvasIsActiveSurface` 這一份「畫布是不是當前互動面」的判定，由呼叫端傳入。
 *
 * `project` 可空是因為呼叫點必須排在 `Editor` 那幾條 early return 之前（`canvasIsActiveSurface`
 * 要先算出來，它讀得到簡報模式與各對話框的開關）。實務上這些函式都只在專案存在時才被 JSX
 * 呼叫得到，幾個 `!project` 守衛只是讓型別看得出這件事。
 *
 * 變更一律走 `changeTextBoxes`（唯一變更入口）與 `applyTextHistory`（唯一歷史轉移），
 * 寫回一律走 `saveTextLayer`（唯一 PUT 出口）——三者各自的理由見下方註解。
 */
export function useTextLayerEditing({
  project,
  selected,
  selectedVersion,
  textEditing,
  canStartManualText,
  canvasIsActiveSurface,
  setProject,
  setError,
}: {
  project: PresentationProject | undefined;
  selected: SlideSpec | undefined;
  selectedVersion: SlideVersion | undefined;
  /** 這一頁現在有沒有**可互動**的文字層（預覽歷史版本／生成中都不算）。 */
  textEditing: boolean;
  /** 這一版還沒有文字層，但可以就地建立一個（見呼叫端的 JSDoc）。 */
  canStartManualText: boolean;
  canvasIsActiveSurface: boolean;
  setProject: (value: PresentationProject) => void;
  setError: (message: string | undefined) => void;
}): {
  textBoxes: EditableTextBox[];
  selectedTextId: string | undefined;
  setSelectedTextId: (boxId: string | undefined) => void;
  selectedText: EditableTextBox | undefined;
  textThreshold: number;
  setTextThreshold: (value: number) => void;
  textUndo: EditableTextBox[][];
  textRedo: EditableTextBox[][];
  openTextEffect: "background" | "stroke" | undefined;
  setOpenTextEffect: (effect: "background" | "stroke" | undefined) => void;
  textLayerTasks: ReadonlyMap<string, TextLayerTask>;
  textLayerTask: TextLayerTask | undefined;
  textLayerBusy: boolean;
  trackTextLayerTask: (slideId: string, task: TextLayerTask | undefined) => void;
  changeTextBoxes: (next: EditableTextBox[]) => void;
  applyTextHistory: (direction: "undo" | "redo") => boolean;
  patchSelectedText: (patch: Partial<EditableTextBox>) => void;
  clearSelectedTextBackground: () => void;
  clearSelectedTextStroke: () => void;
  addTextBox: () => void;
} {
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
  /**
   * TEXT BOX 面板裡哪一個效果的下拉開著（`undefined` ＝都關著）。
   *
   * 用單一狀態而不是讓兩列各記各的：兩個下拉同時浮在畫面上會互相重疊，而且使用者
   * 一次只調得動一個。狀態掛在這裡、不逐框記，換選文字框時由 `setSelectedTextId`
   * 那邊一起關掉——留著的話下拉會浮在原地卻改到另一個框的參數。
   */
  const [openTextEffect, setOpenTextEffect] = useState<"background" | "stroke">();
  /*
   * 換選文字框就把下拉關掉。用 effect 收斂在一處，而不是在每個 `setSelectedTextId` 呼叫點
   * 補一行——選取的入口有畫布點擊、鍵盤、貼上、復原、切頁等好幾條，漏掉任何一條都會讓
   * 下拉浮在原地卻改到另一個框的參數（而且它是 fixed 定位的，連位置都不會跟著移）。
   */
  useEffect(() => setOpenTextEffect(undefined), [selectedTextId]);
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
  /*
   * 下面的 UI 一律只看「**這一頁**在跑什麼」。別頁的工作照樣在跑、完成時照樣寫回專案狀態，
   * 只是不該讓這一頁的按鈕變灰、也不該把進度條掛到這一頁的畫布上。
   */
  const textLayerTask = selected ? textLayerTasks.get(selected.id) : undefined;
  const textLayerBusy = textLayerTask !== undefined;
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
      // `canvasIsActiveSurface` 只認得 `Editor` 裡的覆蓋層；別的元件開的對話框要靠即時的
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
   * `changeTextBoxes` 宣告在這裡（而不是工具列附近）原本是為了避開 TDZ：`const` 若放在
   * `Editor` 那幾條提早 return 之後，走那條路的 render 根本不會初始化它，而 effect 在那次
   * render 重新註冊的話，下一次 ⌘V 就會丟
   * `ReferenceError: Cannot access 'changeTextBoxes' before initialization`。
   * 整簇搬進 hook 之後這個約束自然消失（hook 內沒有 early return），但教訓要留著：
   * 這幾個變更入口與讀它們的 effect 必須待在同一個永遠會跑完的區塊裡。
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
      // 伺服器——這是最貴的一條誤觸，別的元件開的對話框只有即時 DOM 查詢擋得住。
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
    if (textEditing) {
      changeTextBoxes([...textBoxes, box]);
      setSelectedTextId(box.id);
      return;
    }
    if (!project || !selected || !selectedVersion || !canStartManualText) return;
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
  return {
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
  };
}

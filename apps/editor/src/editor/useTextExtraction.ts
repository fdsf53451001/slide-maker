import { useMemo, useRef, useState } from "react";
import type { PresentationProject, SlideSpec, SlideVersion } from "@slide-maker/core";
import { api, ApiError, type ProviderReadiness, type ProviderSummary } from "../api.js";
import {
  batchExtractPlan,
  isBatchAbortingFailure,
  styleRefinementFailure,
  styleRefinementReasonText,
  OCR_CONFIG_ABORT_CODES,
  type BatchExtractPlan,
  type StyleRefinementFailure,
} from "./extractionPlan.js";
import { hiddenSlideCount } from "./slideVisibility.js";
import type { TextLayerTask } from "./textBoxModel.js";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect.js";

/**
 * 抽離文字整簇：抹字引擎／文字修復／簡繁三個選項、單頁抽字、批次抽字（逐頁排隊、中止、
 * 摘要），以及兩顆按鈕的 disabled 與 tooltip。
 *
 * 三件守衛必須待在一起，缺一都會重現已修好的 bug——所以它們同檔同 commit：
 * ①`activeProjectId` 的 **layout effect**（不可退成 passive effect，理由見該處註解）；
 * ②`batchExtractStop` 的 `"user"`／`"left"` 雙語意；③迴圈裡的逐頁循序 `await`。
 *
 * `project` 可空是因為呼叫點必須排在 `Editor` 那幾條 early return 之前（`extractPlan` 這個
 * memo 尤其不可被路由跳過）；兩顆按鈕都只在專案存在時才渲染得出來，`!project` 守衛只是讓
 * 型別看得出這件事。
 */
export function useTextExtraction({
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
}: {
  project: PresentationProject | undefined;
  selected: SlideSpec | undefined;
  selectedVersion: SlideVersion | undefined;
  provider: ProviderSummary | undefined;
  readiness: ProviderReadiness | undefined;
  readinessBusy: boolean;
  acceptUnknownReadiness: boolean;
  effectiveImageProviderId: string;
  textThreshold: number;
  textLayerTasks: ReadonlyMap<string, TextLayerTask>;
  trackTextLayerTask: (slideId: string, task: TextLayerTask | undefined) => void;
  setProject: (value: PresentationProject) => void;
  setError: (message: string | undefined) => void;
  setImportNotice: (message: string | undefined) => void;
}): {
  textExtractEngine: "opencv" | "model";
  setTextExtractEngine: (engine: "opencv" | "model") => void;
  textRepair: "off" | "outline";
  setTextRepair: (repair: "off" | "outline") => void;
  traditionalize: boolean;
  setTraditionalize: (enabled: boolean) => void;
  extractPlan: BatchExtractPlan;
  batchExtract: { current: number; total: number; stopping: boolean } | undefined;
  /** 批次抽字有沒有在跑；`useProjectPolling` 拿它壓掉逐頁的用量刷新邊緣。 */
  batchExtractBusy: boolean;
  batchExtractDisabled: boolean;
  batchExtractTitle: string;
  askBatchExtractChoice: boolean;
  setAskBatchExtractChoice: (open: boolean) => void;
  startTextExtraction: () => Promise<void>;
  runBatchTextExtraction: (targets: readonly SlideSpec[], preConfirmed?: boolean) => Promise<void>;
  requestStop: () => void;
} {
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
   * 畫面上「現在是哪一份專案」，由下面那個 layout effect 在 commit 期間同步更新。
   * 批次抽字每一次寫回之前都拿它與**呼叫當下**的 id 比對。
   */
  const activeProjectId = useRef<string>(undefined);
  /** 抹字引擎是生圖模型、又有隱藏頁時，開三選一對話框問要不要連隱藏頁一起抽。 */
  const [askBatchExtractChoice, setAskBatchExtractChoice] = useState(false);
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
  /**
   * 批次抽字的名單。放在 `useMemo` 而不是每次 render 直接算：它對**全部**頁面各跑一次
   * `versions.find()`，而 `Editor` 會因為拖曳頁碼滑桿、打字改大綱等等高頻互動不斷重繪，
   * 150 頁的專案等於每一幀重跑 150 次線性搜尋。
   *
   * 也一定要放在所有 early return **之前**——`Editor` 裡 `route === "/models"` 那幾條提早
   * 回傳的分支若把這個 hook 跳過，hook 順序就會在切換路由時錯位。
   */
  const extractPlan = useMemo(() => batchExtractPlan(project?.slides ?? []), [project?.slides]);
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
  const batchExtractJobsBusy = !!project?.jobs.some((job) =>
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
    if (!project || !selected || !selectedVersion) return;
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
    if (!project || targets.length === 0 || batchExtract) return;
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
  /**
   * 「停止」只立旗：在飛的那一頁沒有取消機制（見 `runBatchTextExtraction` 的註解），
   * 這顆的語意就是「做完這一頁之後不要再送了」。
   */
  const requestStop = () => {
    batchExtractStop.current = "user";
    setBatchExtract((current) => (current ? { ...current, stopping: true } : current));
  };
  return {
    textExtractEngine,
    setTextExtractEngine,
    textRepair,
    setTextRepair,
    traditionalize,
    setTraditionalize,
    extractPlan,
    batchExtract,
    batchExtractBusy: batchExtract !== undefined,
    batchExtractDisabled,
    batchExtractTitle,
    askBatchExtractChoice,
    setAskBatchExtractChoice,
    startTextExtraction,
    runBatchTextExtraction,
    requestStop,
  };
}

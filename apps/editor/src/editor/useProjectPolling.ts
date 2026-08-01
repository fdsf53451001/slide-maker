import { useEffect, useRef, useState } from "react";
import type { PresentationProject } from "@slide-maker/core";
import { api } from "../api.js";
import { isDescribing, parsingExpired } from "../SourcePanel.js";

/**
 * 專案輪詢、用量刷新的忙碌邊緣偵測，以及 job 計時器的每秒 tick。
 *
 * 三件事同一個 hook：它們讀的是同一組「伺服器現在忙不忙」的判定（`jobsBusy`），拆開等於
 * 讓同一份判定長出第二份拷貝。輪詢本身也刻意只有這一條 interval（見下方各段註解）。
 *
 * `activeJobId` 而不是整個 job 物件：計時器只用它判斷「有沒有 job 在跑」與「換了一個 job
 * 沒有」，而 job 的 id 恆為非空字串，兩者等價（原本的依賴陣列就是 `[activeJob?.id]`）。
 */
export function useProjectPolling({
  project,
  activeJobId,
  batchExtractBusy,
  setProject,
  setError,
}: {
  project: PresentationProject | undefined;
  activeJobId: string | undefined;
  batchExtractBusy: boolean;
  setProject: (value: PresentationProject) => void;
  setError: (message: string) => void;
}): { now: number; usageRefreshToken: number } {
  /** job 進度列的「已經過 N 秒」時鐘；只有 job 在跑時才走（見最下面那條 effect）。 */
  const [now, setNow] = useState(Date.now());
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
    if (!activeJobId) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [activeJobId]);
  return { now, usageRefreshToken };
}

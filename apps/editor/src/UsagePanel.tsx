import { useEffect, useState } from "react";
import { api, type UsageBucket, type UsageModelBucket, type UsageSummary } from "./api.js";

/**
 * 專案的模型用量統計（inspector「專案」分頁的 USAGE 區塊）。
 *
 * 這個面板存在的理由是**誠實**，所以有三件事不可以為了畫面好看而簡化掉：
 *
 * ① **未回報的呼叫要明著寫出來。** 它們燒了配額，但 gateway 沒告訴我們燒了多少，所以
 *    伺服器一個 token 都沒有把它們算進總和。UI 若不講，使用者看到的會是一個看似精確、
 *    實際上系統性低估的數字——那比一句「其中 N 次未回報」糟得多。
 * ② **本機呼叫與未回報是兩件完全不同的事。** OpenCV 抹字與 mock 沒有碰到任何模型；批次
 *    抽字一次就會產生幾十筆。混在一起會讓「未回報」這個數字失去它唯一的用途：指出是哪
 *    一條通道不回報用量。
 * ③ **`unreadable` 不可以顯示成 0。** 帳本讀不出來時，「沒有數字」與「沒有呼叫過」在畫面
 *    上長得一模一樣，而它們的意思剛好相反。
 *
 * **前端不得自己重算任何聚合規則**（見 CLAUDE.md 與 `api.ts` 的 `UsageSummary`）：畫面上
 * 每一個計數與 token 都直接取自伺服器欄位。唯一的算術是「送出請求比呼叫多幾次」——那是
 * 把伺服器已經給的兩個數字相減來說明它們為什麼不同，不是重新實作一條聚合規則。
 *
 * 金額刻意一個字都不顯示：`UsageSummary.cost` 有值，但金額 UI 不在這一版的範圍內。
 */

/** 千分位。`toLocaleString` 會跟著執行環境的 ICU 走，統計數字不需要那種不確定性。 */
export function formatCount(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** ISO 時間 → 使用者本機時區的 `YYYY-MM-DD HH:mm`；解析不了就原樣顯示。 */
export function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 能力／操作的中文標籤。查不到就顯示原始鍵值——伺服器兩者都是封閉的字面量聯集，但新增
 * 一個值時「顯示英文鍵」遠比「這一列整個消失」好。
 */
const CAPABILITY_LABELS: Record<string, string> = {
  image: "影像",
  text: "文字",
  search: "搜尋",
};

const OPERATION_LABELS: Record<string, string> = {
  generate: "生成投影片",
  edit: "影像編輯",
  "extract-text": "抽離文字",
  search: "網路搜尋",
  "style-analysis": "風格分析",
  "outline-generate": "大綱生成",
  "outline-regenerate": "大綱重建",
  "ocr-style-refine": "抽字樣式精修",
  "image-description": "圖片內容描述",
};

/** 能力對應的色帶 class（沿用模型庫的 `cap-*`）。 */
const CAPABILITY_CLASS: Record<string, string> = {
  image: "cap-image",
  text: "cap-text",
  search: "cap-search",
};

const BUCKET_KEYS = [
  "calls",
  "requests",
  "reportedCalls",
  "localCalls",
  "failedCalls",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedTokens",
  "imageTokens",
  "totalTokens",
] as const;

const SUMMARY_COUNT_KEYS = [
  "totalCalls",
  "totalRequests",
  "reportedCalls",
  "unreportedCalls",
  "localCalls",
  "failedCalls",
  "malformedLines",
  "droppedRecords",
] as const;

function isBucket(value: unknown): value is UsageBucket {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return BUCKET_KEYS.every((key) => typeof record[key] === "number");
}

/**
 * 回應到底是不是一份統計。
 *
 * **用量面板絕不可以有本事弄壞編輯器。** 它是觀測，不是產品功能——伺服器改了欄位、
 * 反向代理插了一頁 HTML、或這條路根本沒部署到，代價都只該是「這一區顯示不出來」，
 * 不該是整個 inspector 白畫面（實測：舊測試的 catch-all stub 回了一份專案 JSON，
 * `totals` 是 undefined，render 直接炸掉整棵樹）。
 *
 * 認不得的回應走**錯誤**而不是補 0 的預設值：一排 0 與「這個專案沒有呼叫過模型」
 * 在畫面上完全一樣，而那正是這個面板最不該說的謊。
 */
export function isUsageSummary(value: unknown): value is UsageSummary {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!SUMMARY_COUNT_KEYS.every((key) => typeof record[key] === "number")) return false;
  if (typeof record["truncated"] !== "boolean" || typeof record["unreadable"] !== "boolean")
    return false;
  if (!isBucket(record["totals"])) return false;
  if (!Array.isArray(record["byModel"]) || !record["byModel"].every(isBucket)) return false;
  return [record["byCapability"], record["byOperation"]].every(
    (group) =>
      typeof group === "object" &&
      group !== null &&
      Object.values(group as Record<string, unknown>).every(isBucket),
  );
}

type UsageState =
  | { projectId: string; status: "loading" }
  | { projectId: string; status: "error"; message: string }
  | { projectId: string; status: "ready"; summary: UsageSummary };

/** 一列分組統計（依能力／依模型／依操作共用）。 */
function BucketRow({
  name,
  badge,
  badgeClass,
  bucket,
}: {
  name: string;
  badge?: string;
  badgeClass?: string;
  bucket: UsageBucket;
}) {
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-row-name">{name}</span>
        {badge ? (
          <span className={`usage-row-badge${badgeClass ? ` ${badgeClass}` : ""}`}>{badge}</span>
        ) : null}
      </div>
      <div className="usage-row-figures">
        <span>{formatCount(bucket.calls)} 次呼叫</span>
        {bucket.requests > bucket.calls && <span>{formatCount(bucket.requests)} 次請求</span>}
        <span>{formatCount(bucket.totalTokens)} token</span>
      </div>
      {/*
        分組層級刻意只並排伺服器給的兩個數字，不在這裡算「未回報 = calls − reported − local」。
        那條規則屬於伺服器；前端補算它就等於維護第二份會漂移的定義。
      */}
      {bucket.reportedCalls < bucket.calls && (
        <div className="usage-row-note">
          已回報用量 {formatCount(bucket.reportedCalls)} / {formatCount(bucket.calls)} 次
          {bucket.localCalls > 0 && `（含本機 ${formatCount(bucket.localCalls)} 次）`}
        </div>
      )}
      {bucket.failedCalls > 0 && (
        <div className="usage-row-note warn">失敗 {formatCount(bucket.failedCalls)} 次</div>
      )}
    </div>
  );
}

function modelName(bucket: UsageModelBucket): string {
  return bucket.model || bucket.modelEntryId || "未知模型";
}

function UsageFigures({ summary }: { summary: UsageSummary }) {
  const totals = summary.totals;
  // 伺服器已經給了 totalRequests 與 totalCalls；這個差額就是「provider 內部重試了幾次」，
  // 是整個面板最有價值的一個訊號，不把它講出來等於把兩個數字丟給使用者自己心算。
  const retries = summary.totalRequests - summary.totalCalls;
  return (
    <>
      <dl className="usage-figures">
        <div>
          <dt>呼叫次數</dt>
          <dd>{formatCount(summary.totalCalls)}</dd>
        </div>
        <div>
          <dt>送出請求</dt>
          <dd>{formatCount(summary.totalRequests)}</dd>
        </div>
        <div>
          <dt>輸入 token</dt>
          <dd>{formatCount(totals.inputTokens)}</dd>
        </div>
        <div>
          <dt>輸出 token</dt>
          <dd>{formatCount(totals.outputTokens)}</dd>
        </div>
        <div className="usage-figure-total">
          <dt>合計 token</dt>
          <dd>{formatCount(totals.totalTokens)}</dd>
        </div>
      </dl>
      {retries > 0 && (
        <p className="usage-retry">
          送出的請求比呼叫多 {formatCount(retries)} 次，那是失敗後重試打出去的。
        </p>
      )}
      {(totals.reasoningTokens > 0 || totals.cachedTokens > 0 || totals.imageTokens > 0) && (
        <ul className="usage-subtokens">
          {totals.reasoningTokens > 0 && (
            <li>其中推理 token {formatCount(totals.reasoningTokens)}</li>
          )}
          {totals.cachedTokens > 0 && <li>其中快取 token {formatCount(totals.cachedTokens)}</li>}
          {totals.imageTokens > 0 && <li>其中影像 token {formatCount(totals.imageTokens)}</li>}
        </ul>
      )}
      <ul className="usage-signals">
        {summary.unreportedCalls > 0 && (
          <li className="warn">
            其中 {formatCount(summary.unreportedCalls)}{" "}
            次未回報用量：這些呼叫一樣消耗了配額，但模型端沒有回報數量，因此
            <b>沒有</b>計入上面的 token。
          </li>
        )}
        {summary.localCalls > 0 && (
          <li>
            另有 {formatCount(summary.localCalls)} 次由本機處理（OpenCV
            抹字、mock），沒有消耗任何模型配額。
          </li>
        )}
        {summary.failedCalls > 0 && (
          <li className="warn">
            {formatCount(summary.failedCalls)} 次呼叫失敗；失敗的呼叫一樣會消耗配額。
          </li>
        )}
      </ul>
    </>
  );
}

function UsageBreakdown({ summary }: { summary: UsageSummary }) {
  // 排序只是呈現（伺服器對 byModel 已經排好，Record 走的是它的插入順序）。
  const capabilities = Object.entries(summary.byCapability).sort((a, b) => b[1].calls - a[1].calls);
  const operations = Object.entries(summary.byOperation).sort((a, b) => b[1].calls - a[1].calls);
  return (
    <>
      {capabilities.length > 0 && (
        <section className="usage-section">
          <h4>依能力</h4>
          {capabilities.map(([capability, bucket]) => (
            <BucketRow
              key={capability}
              name={CAPABILITY_LABELS[capability] ?? capability}
              {...(CAPABILITY_CLASS[capability] === undefined
                ? {}
                : { badgeClass: CAPABILITY_CLASS[capability] })}
              bucket={bucket}
            />
          ))}
        </section>
      )}
      {summary.byModel.length > 0 && (
        <section className="usage-section">
          <h4>依模型</h4>
          {summary.byModel.map((bucket) => (
            <BucketRow
              key={bucket.modelEntryId || bucket.model || "unknown"}
              name={modelName(bucket)}
              {...(bucket.providerKind ? { badge: bucket.providerKind } : {})}
              bucket={bucket}
            />
          ))}
        </section>
      )}
      {operations.length > 0 && (
        // 依操作比另外兩組細得多，預設折疊：它回答的是「哪一種動作在吃配額」，
        // 而那是使用者已經想深究之後才會問的問題。
        <details className="usage-section usage-operations">
          <summary>依操作（{formatCount(operations.length)} 種）</summary>
          {operations.map(([operation, bucket]) => (
            <BucketRow
              key={operation}
              name={OPERATION_LABELS[operation] ?? operation}
              bucket={bucket}
            />
          ))}
        </details>
      )}
    </>
  );
}

export function UsagePanel({ projectId }: { projectId: string }) {
  const [state, setState] = useState<UsageState>({ projectId, status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState(true);
  /*
   * 換專案時**在同一個 render 裡**就丟掉上一份資料。
   *
   * 靠 effect 清是不夠的：effect 在 commit 之後才跑，中間那一幀畫的是新專案的標題配上
   * 舊專案的數字。這個 repo 已經踩過好幾次「上一份專案的結果寫回新專案畫面」（見
   * `Editor.tsx` 的頁碼草稿與批次抽字），用量是唯讀的，但顯示錯的帳一樣是說謊。
   * 呼叫端另外用 `key` 掛了同一道保險，兩者都留著。
   */
  if (state.projectId !== projectId) setState({ projectId, status: "loading" });

  useEffect(() => {
    // 切到「專案」分頁（元件掛載）時抓一次，加上使用者自己按「重新整理」。
    // **刻意沒有定時器**：`Editor.tsx` 已經有專案輪詢，再加一條只會多打一份請求；
    // 生成跑完之後回到這個分頁就會重新掛載、自然拿到新數字。
    let abandoned = false;
    setPending(true);
    api
      .projectUsage(projectId)
      .then((summary) => {
        if (abandoned) return;
        if (!isUsageSummary(summary)) {
          setState({
            projectId,
            status: "error",
            message: "用量統計的格式無法解析，這一區暫時顯示不出來。",
          });
          return;
        }
        setState({ projectId, status: "ready", summary });
      })
      .catch((reason: unknown) => {
        if (abandoned) return;
        setState({
          projectId,
          status: "error",
          message: reason instanceof Error ? reason.message : "用量統計載入失敗",
        });
      })
      .finally(() => {
        if (!abandoned) setPending(false);
      });
    // 在途的請求屬於上一個 projectId：它回來時畫面上已經是另一份專案了，一律丟掉。
    return () => {
      abandoned = true;
    };
  }, [projectId, reloadToken]);

  const summary = state.status === "ready" ? state.summary : undefined;
  return (
    <div className="usage-panel">
      <div className="inspector-heading usage-heading">
        <span>USAGE</span>
        <button
          className="usage-refresh"
          onClick={() => setReloadToken((token) => token + 1)}
          disabled={pending}
        >
          {pending ? "更新中…" : "重新整理"}
        </button>
      </div>
      {state.status === "loading" && <p className="usage-loading">讀取用量統計…</p>}
      {state.status === "error" && <p className="usage-error">{state.message}</p>}
      {summary && (
        <>
          {summary.unreadable ? (
            /*
             * 讀不出來時**不畫任何數字**。一整排 0 與「這個專案沒有呼叫過模型」在畫面上
             * 完全一樣，而這裡的實情是「我們不知道」。
             */
            <p className="usage-unreadable">
              用量帳本讀不出來，這裡沒有任何數字可以顯示——
              <b>這不代表這個專案沒有呼叫過模型</b>，只代表這份紀錄現在讀不到。
            </p>
          ) : (
            <>
              {summary.truncated && (
                <p className="usage-truncated">
                  帳本輪替過，以下<b>不是</b>這個專案的全部歷史
                  {summary.droppedRecords > 0
                    ? `（較早的 ${formatCount(summary.droppedRecords)} 筆紀錄已被捨棄）`
                    : ""}
                  。
                </p>
              )}
              {summary.malformedLines > 0 && (
                <p className="usage-malformed">
                  有 {formatCount(summary.malformedLines)} 行紀錄無法解析，已略過。
                </p>
              )}
              {summary.totalCalls === 0 ? (
                <div className="usage-empty">
                  {/*
                    帳本輪替過時不可以說「還沒有任何呼叫」——那份歷史存在過，只是被砍了。
                    兩句話的差別正是這個面板的重點：不知道與沒發生過是兩件事。
                  */}
                  <b>
                    {summary.truncated
                      ? "目前保留的紀錄裡沒有任何模型呼叫"
                      : "這個專案還沒有任何模型呼叫"}
                  </b>
                  <span>生成投影片、抽離文字或搜尋來源之後，用量會出現在這裡。</span>
                </div>
              ) : (
                <>
                  <UsageFigures summary={summary} />
                  <UsageBreakdown summary={summary} />
                  {summary.firstAt && summary.lastAt && (
                    <p className="usage-range">
                      紀錄區間 {formatMoment(summary.firstAt)} → {formatMoment(summary.lastAt)}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

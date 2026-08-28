import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  URL_SOURCE_BATCH_LIMIT,
  type PresentationProject,
  type SourceAsset,
} from "@slide-maker/core";
import { api, projectAssetUrl, type UrlSourceFailure, type WebSearchResult } from "./api.js";
import { highlightSegments, matchSource, searchTerms } from "./sourceSearch.js";
import { useBackdropDismiss } from "./useBackdropDismiss.js";
import { useDialogA11y } from "./useDialogA11y.js";
import { modalDialogOpen } from "./modalDialogOpen.js";

export function sourceTypeLabel(source: SourceAsset): string {
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

/**
 * 這筆來源在畫面上算不算「AI 正在讀圖」。
 *
 * `status` 單獨不夠：使用者可以在描述還排隊時把用途改成別的，伺服器那條背景工作輪到它
 * 才會發現並收尾（前面排了一長串時可能是好幾分鐘）。這段期間卡片對著一份「直接素材」
 * 顯示「AI 分析圖片內容中」是錯的。
 */
export function isDescribing(source: SourceAsset): boolean {
  return source.status === "parsing" && source.usage === "visual-reference";
}

/**
 * 伺服器端的單張硬上限（`image-description.ts` 的 `IMAGE_DESCRIPTION_TIMEOUT_MS`）與
 * 背景佇列的併發上限。前端要判斷「這筆是不是卡住了」，只能用同一組數字推算。
 */
const DESCRIBE_SLOT_MS = 90_000;
const DESCRIBE_CONCURRENCY = 2;
/** 上傳、寫回、輪詢間隔與觀測誤差的餘裕。 */
const DESCRIBE_GRACE_MS = 120_000;

/**
 * 一批 `parsingCount` 張圖裡，最後一張最壞要等多久。
 *
 * 併發 2、單張上限 90 秒 ⇒ 第 k 張最壞在 `90 × ⌊(k−1)/2⌋` 秒才輪到。固定 5 分鐘在七張
 * 以上的批次就不成立：後面幾張會在伺服器一切正常的情況下被判成「已中斷」、輪詢停掉，
 * 描述靜靜落地卻不會出現在畫面上。
 */
export function parsingBudgetMs(parsingCount: number): number {
  const rounds = Math.ceil(Math.max(1, parsingCount) / DESCRIBE_CONCURRENCY);
  return DESCRIBE_GRACE_MS + DESCRIBE_SLOT_MS * rounds;
}

/**
 * 每筆來源第一次「被這個瀏覽器看到是 parsing」的時刻與當時的預算。
 *
 * **刻意不拿伺服器的 `updatedAt` 去比 `Date.now()`**：那等於要求兩邊時鐘一致。客戶端快
 * 幾分鐘（沒對時的機器很常見）時，每張剛上傳的圖在 t=0 就被算成逾時，輪詢根本不會啟動，
 * 描述完成也不會出現。改用客戶端自己的錨點之後，判斷只依賴同一個時鐘的兩次讀數。
 */
const parsingAnchors = new Map<string, { since: number; budgetMs: number }>();

/**
 * 這筆來源是不是已經停在 parsing 超過它應得的時間。
 *
 * 有副作用（第一次看到時記錄錨點），但這樣就不可能忘記在某個呼叫點先「登記」；重複呼叫
 * 是冪等的，render 期間呼叫也安全。
 */
export function parsingExpired(
  source: SourceAsset,
  sources: readonly SourceAsset[],
  now = Date.now(),
): boolean {
  if (!isDescribing(source)) {
    parsingAnchors.delete(source.id);
    return false;
  }
  const backlog = sources.filter(isDescribing).length;
  const anchor = parsingAnchors.get(source.id);
  const since = anchor?.since ?? now;
  // 預算只增不減：批次跑到後面時 backlog 會縮小，若拿當下的 backlog 重算，最後一張會在
  // 自己都還沒開跑之前就先過期。
  const budgetMs = Math.max(anchor?.budgetMs ?? 0, parsingBudgetMs(backlog));
  parsingAnchors.set(source.id, { since, budgetMs });
  return now - since > budgetMs;
}

/** 分析中的來源在清單與詳情裡顯示的那一行字。 */
function parsingLabel(source: SourceAsset, sources: readonly SourceAsset[]): string {
  return parsingExpired(source, sources) ? "AI 分析可能已中斷" : "AI 分析圖片內容中…";
}

/**
 * 這筆來源改成 `usage` 之後，值不值得**問**使用者要不要補跑 AI 內容描述。
 *
 * 只鏡射伺服器 `shouldDescribeImageSource()` 裡「前端手上這份 payload 就看得到」的條件
 * （用途、媒體類型、是否已有內容、有沒有正在跑）。**不鏡射伺服器組態**——文字模型有沒有
 * 設、可不可用、`SLIDE_MAKER_IMAGE_DESCRIPTION` 開不開，前端無從得知，鏡射它必然漂移。
 * 那一半改用觀測處理：送出後看回應裡這筆來源有沒有真的變成 `parsing`（見 `changeUsage`）。
 */
function canDescribe(source: SourceAsset, usage: SourceAsset["usage"]): boolean {
  return (
    usage === "visual-reference" &&
    (source.mediaType === "image/png" || source.mediaType === "image/jpeg") &&
    source.allowModelAccess &&
    source.status !== "parsing" &&
    !source.extractedText.trim()
  );
}

/**
 * 圖片內容描述的失敗原因 → 使用者看得懂的一句話與下一步。
 *
 * 與「貼上網址」的 `URL_FAILURE_REASONS` 同一個精神：沒有這張表的話，「跑過但失敗」與
 * 「從來沒跑過」在畫面上長得一模一樣，最常見的失敗（選到的文字模型不會讀圖）就會變成
 * 每上傳一張圖都白打一次請求，使用者卻永遠看不到線索。
 */
const IMAGE_DESCRIPTION_FAILURES: Record<string, string> = {
  unavailable: "目前的模型組合沒有可用的文字模型，未讀取這張圖的內容。可到模型庫設定後再試。",
  unsupported:
    "目前組合的文字模型不支援讀圖，未讀取這張圖的內容。請到模型庫換一個具備視覺能力的文字模型。",
  auth: "文字模型驗證失敗，未讀取這張圖的內容。請到模型庫檢查 API key。",
  quota: "文字模型達到配額或速率限制，未讀取這張圖的內容。稍後把用途重設為「視覺參考」即可重試。",
  timeout: "讀取這張圖的內容逾時，已略過。稍後把用途重設為「視覺參考」即可重試。",
  empty: "模型沒有交出可用的內容描述，已略過。這張圖仍可作為視覺參考使用。",
  failed: "讀取這張圖的內容時失敗，已略過。這張圖仍可作為視覺參考使用。",
};

function describeFailure(source: SourceAsset): string | undefined {
  const code = source.metadata.imageDescriptionFailure;
  if (!code) return undefined;
  return IMAGE_DESCRIPTION_FAILURES[code] ?? IMAGE_DESCRIPTION_FAILURES.failed;
}

/**
 * 生成用途的**唯一**清單：下拉選單的選項、選單下方的說明、來源詳情的那一格全部從這裡長出來。
 *
 * 舊版是兩份：`sourceUsageLabel()` 一份 map、下拉選單裡每個 `<option>` 各寫一次同樣的字。
 * enum 多一個值時只有這個 `Record` 會逼你補上（少一個鍵就編譯失敗），`<option>` 漏掉則不會有
 * 任何東西變紅——結果是「這個用途存在、後端也吃得下，但畫面上選不到」。**型別必須留成
 * `Record<SourceAsset["usage"], …>`**：換成陣列就沒有那道編譯期檢查了，而它正是這份合併的
 * 主要價值。順序＝這裡的宣告順序（字串鍵的 `Object.entries` 依插入序），也就是下拉的順序。
 *
 * `hint` 講的是**選了會發生什麼事**，措辭上有兩條紀律：
 *
 * ① **不承諾程式做不到的事**。合約給生圖模型的是**要求**，不是保證——沒有任何合成路徑會把
 *    圖貼上去，而且同一張圖在編輯／抹字模式下的合約是「background context only… do not
 *    embed it」。`direct-asset` 因此寫成「請 AI 原樣重畫」而不是「會原樣出現」，並帶上合約
 *    真正說的那半句（`inside a framed panel`，對 logo 而言正是最關鍵的資訊）。
 * ② **不鏡射伺服器組態**（CLAUDE.md 那條）。會不會讀圖還取決於整條開關、有沒有文字模型、
 *    模型支不支援讀圖——前端一律不猜；只講**使用者自己在這張卡片上控制得到**的那個條件，
 *    也就是上方那個「允許 AI 使用」的勾選。
 *
 * 對照的程式碼：
 *  - 內容依據／大綱參考：進 `buildOutlineCatalog()` 與 FTS，正文片段餵進大綱 prompt。
 *  - 大綱參考另外整份進 `buildOutlineReference()`，而它**只吃 `extractedText`**——圖片標成
 *    大綱參考永遠不會有文字（`shouldDescribeImageSource()` 只跑 `visual-reference`），使用者
 *    沒有任何路徑讓它生效，所以要直接說該丟哪種檔。
 *  - 視覺參考：`sourceAttachesReferenceImage()` 為真 ⇒ 附給生圖模型，合約角色是
 *    content reference（"it may inform subject matter"）；PNG／JPEG **且**已勾選允許讀取時，
 *    才另外跑一次讀圖描述（`shouldDescribeImageSource()`）。
 *  - 風格參考：合約角色 style（"take its palette, composition rhythm, typography treatment,
 *    spacing, and finish only"）——明文只取風格、不取內容。
 *  - 直接素材：合約角色 direct-asset（"reproduce this image faithfully inside a framed panel
 *    on the slide"）。
 *  - 不參與生成：三條讀取路徑（大綱、檢索、附圖）都在第一關就把它濾掉。
 */
const SOURCE_USAGE_DETAIL: Record<SourceAsset["usage"], { label: string; hint: string }> = {
  content: {
    label: "內容依據",
    hint: "AI 會讀它的文字，用來寫大綱與每一頁的內容。",
  },
  "outline-reference": {
    label: "大綱參考",
    hint: "AI 會照這份檔案的章節與編排決定每頁主題，內容再用其他來源補充；它同時也算內容依據。只讀得到文字，請用 Word、Markdown、PDF 這類有文字的檔（圖片不會生效）。",
  },
  "visual-reference": {
    label: "視覺參考",
    hint: "這張圖會附給生圖模型當作畫面內容的依據（圖表、示意圖）。若已勾選允許 AI 使用，也會先試著讀出圖裡的文字。",
  },
  "style-reference": {
    label: "風格參考",
    hint: "這張圖只影響畫面風格（配色、排版、字體處理），不提供內容。",
  },
  "direct-asset": {
    label: "直接素材",
    hint: "生成這一頁時會要求 AI 把這張圖原樣重畫在畫面上的一個框裡（例如 logo、產品照）；成品由 AI 繪製，不保證與原圖完全一致。",
  },
  "exclude-from-generation": {
    label: "不參與生成",
    hint: "AI 不會讀取，也不會用在任何一頁。",
  },
};

const SOURCE_USAGE_OPTIONS = Object.entries(SOURCE_USAGE_DETAIL).map(([value, detail]) => ({
  value: value as SourceAsset["usage"],
  ...detail,
}));

function sourceUsageLabel(source: SourceAsset): string {
  return SOURCE_USAGE_DETAIL[source.usage].label;
}

/**
 * 這份大綱參考標了等於沒標的兩種形狀，回一句講得出下一步的話。
 *
 * 沒有這一行的話，兩種狀態在畫面上與「一切正常」長得一模一樣，使用者只會在拿到成品後回報
 * 「它沒照我的大綱走」：
 *  - 沒有可讀文字：`buildOutlineReference()` 跳過它。最常見的是把大綱拍成照片或掃描成無
 *    文字層的 PDF——圖片標成大綱參考永遠不會有文字（讀圖描述只跑 `visual-reference`）。
 *  - 未允許 AI 讀取：它在伺服器的 `eligibleSources` 就被濾掉，連 `outline_reference_empty`
 *    那行 log 都不會有（那個計數只數濾完之後的），所以畫面是唯一講得出這件事的地方。
 *
 * 判斷**只用前端手上這份 payload**，不鏡射任何伺服器組態（同 `canDescribe()` 的紀律）：
 * 這兩個條件都是使用者自己在這張卡片上看得到、也改得動的。
 *
 * 先問文字再問勾選：兩個都不成立時，補勾「允許 AI 使用」也不會讓一份沒有文字的檔生效，
 * 先指向勾選等於叫使用者去做一件解決不了問題的事。
 */
function outlineReferenceIssue(source: SourceAsset): string | undefined {
  if (source.usage !== "outline-reference") return undefined;
  if (!source.extractedText.trim())
    return "這份大綱參考沒有可讀文字，不會影響生成。請改用 Word、Markdown 或有文字層的 PDF。";
  if (!source.allowModelAccess)
    return "未勾選允許 AI 使用，這份大綱參考不會被讀取，也不會影響生成。";
  return undefined;
}

function sourceSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 ** 2) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
}

function SourcePreviewDialog({
  projectId,
  source,
  sources,
  terms,
  onClose,
}: {
  projectId: string;
  source: SourceAsset;
  /** 同專案的所有來源：判斷「分析是不是卡住了」要看整批還有幾張在排隊。 */
  sources: readonly SourceAsset[];
  terms: readonly string[];
  onClose: () => void;
}) {
  const imageSource = source.mediaType.startsWith("image/");
  const summary = sourceSummary(source);
  const failureText = describeFailure(source);
  const assetUrl = projectAssetUrl(projectId, source.assetPath);
  // 只 highlight 全文；簡介是壓縮空白後的另一份文字，兩邊都標會讓視線分散。
  const segments = highlightSegments(source.extractedText, terms);
  const firstHit = segments.findIndex((segment) => segment.hit);
  const firstHitRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogA11y(dialogRef, true);
  const dismiss = useBackdropDismiss(onClose);
  useEffect(() => {
    firstHitRef.current?.scrollIntoView?.({ block: "center" });
  }, [source.id]);
  // 四個對話框一律 portal 到 body：它們在 React tree 上是來源面板的後代，而來源面板整塊
  // 會被側邊欄收合（`.inspector-collapsed`）以 `display: none` 藏起來——祖先一旦 none，
  // `position: fixed` 的後代也跟著消失。收合鈕就在對話框背後，鍵盤走到它按下去就會讓
  // 填到一半的對話框整個不見——這正是四個對話框都掛上 `useDialogA11y` 的原因（focus trap
  // 讓 Tab 走不出去，關閉後焦點還原回觸發的按鈕）。
  return createPortal(
    <div
      className="source-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`預覽來源：${source.name}`}
      {...dismiss}
    >
      <section
        className={`source-preview-dialog ${imageSource ? "image" : "text"}`}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">SOURCE DETAIL · {sourceTypeLabel(source)}</span>
            <h2>{source.name}</h2>
          </div>
          <button type="button" aria-label="關閉來源預覽" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="source-preview-content">
          <section className="source-preview-intro">
            <h3>簡介</h3>
            <dl>
              <div>
                <dt>格式</dt>
                <dd>{sourceTypeLabel(source)}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{sourceSize(source.sizeBytes)}</dd>
              </div>
              <div>
                <dt>生成用途</dt>
                <dd>{sourceUsageLabel(source)}</dd>
              </div>
              <div>
                <dt>AI 使用</dt>
                <dd>{source.allowModelAccess ? "已允許" : "未允許"}</dd>
              </div>
              {source.metadata.imageDescriptionModel && (
                // 描述是模型衍生物：產生它的模型要看得到，否則「可查證」只成立在
                // project.json 裡，使用者無從判斷這段內容是誰寫的。
                <div>
                  <dt>內容描述模型</dt>
                  <dd>{source.metadata.imageDescriptionModel}</dd>
                </div>
              )}
            </dl>
            {/*
              失敗說明要 role="alert"：輪詢會在對話框開著的時候把這一段換上來（分析是背景
              工作），沒有 live region 的話，讀屏使用者停在原本那句「AI 正在讀取…」上，
              永遠等不到「其實失敗了」。
            */}
            {failureText && (
              <p className="source-describe-failed" role="alert">
                ⚠ {failureText}
              </p>
            )}
            <p>
              {imageSource
                ? isDescribing(source)
                  ? parsingExpired(source, sources)
                    ? "這張圖的內容分析可能已中斷（伺服器重新啟動時會自動收尾）。把用途重設為「視覺參考」即可重試。"
                    : "AI 正在讀取這張圖片的內容，完成後即可被搜尋並在生成大綱時引用。"
                  : // 有描述時直接顯示描述本身（開頭那句聲明已標明它是模型產生的，不是原文）。
                    summary || "此圖片可作為生成時的視覺參考或直接素材。"
                : summary || "尚未擷取到可預覽的文字內容。"}
            </p>
          </section>
          <section className="source-preview-full">
            <h3>{imageSource ? "完整圖片" : "全文"}</h3>
            {terms.length > 0 && firstHit < 0 && (
              <p className="source-preview-nohit">
                關鍵字符合{imageSource ? "檔名" : "檔名或網址"}，全文中未出現。
              </p>
            )}
            <div className="source-preview-body">
              {imageSource ? (
                <img src={assetUrl} alt={source.name} />
              ) : summary ? (
                <pre>
                  {segments.map((segment, index) =>
                    segment.hit ? (
                      <mark key={index} ref={index === firstHit ? firstHitRef : null}>
                        {segment.text}
                      </mark>
                    ) : (
                      <Fragment key={index}>{segment.text}</Fragment>
                    ),
                  )}
                </pre>
              ) : (
                <div className="source-preview-empty">這個檔案沒有可顯示的文字內容。</div>
              )}
            </div>
          </section>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function WebSourceDialog({
  onCancel,
  onBusyChange,
  onSearch,
  onSave,
}: {
  onCancel: () => void;
  /** 讓外層的 Escape 鏈知道請求還在跑；理由與 UrlSourceDialog 的同名 prop 相同。 */
  onBusyChange: (busy: boolean) => void;
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
  const dialogRef = useRef<HTMLElement>(null);
  useDialogA11y(dialogRef, true);
  const busy = searching || saving;
  // 只回報「儲存中」：搜尋還沒寫入任何東西，中途關掉不會留下半份工作，Escape 照樣可以關。
  // cleanup 一定要把旗標放掉——成功路徑是 onSave 先關掉對話框、`finally` 才跑，少了它
  // 外層會永遠停在忙碌狀態，之後每一個對話框的 Escape 與遮罩點擊都被鎖死。
  useEffect(() => {
    onBusyChange(saving);
    return () => onBusyChange(false);
  }, [saving, onBusyChange]);
  const search = async () => {
    const keyword = query.trim();
    if (keyword.length < 2) return;
    setSearching(true);
    setLocalError(undefined);
    try {
      const found = await onSearch(keyword);
      const unique = [...new Map(found.map((result) => [result.url, result])).values()];
      setResults(unique);
      setSelectedUrls(new Set(unique.map((result) => result.url)));
      setSearched(true);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "搜尋失敗");
    } finally {
      setSearching(false);
    }
  };
  const selected = results.filter((result) => selectedUrls.has(result.url));
  const dismiss = useBackdropDismiss(onCancel, !busy);
  // portal 到 body，理由同 SourcePreviewDialog。
  return createPortal(
    <div
      className="web-source-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="搜尋並加入資料"
      {...dismiss}
    >
      <section
        className="web-source-dialog"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">ADD WEB SOURCES</span>
            <h2>加入搜尋資料</h2>
            <p>先搜尋並確認結果；加入後會擷取網頁全文、建立索引並存回目前專案。</p>
          </div>
          <button type="button" aria-label="關閉搜尋資料" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <form
          className="web-source-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label>
            搜尋關鍵字
            <input
              aria-label="搜尋關鍵字"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：Grok Build agent development advantages"
            />
          </label>
          <button className="primary" disabled={busy || query.trim().length < 2}>
            {searching ? "正在搜尋網路…" : "搜尋"}
          </button>
        </form>
        {/* 搜尋／儲存失敗時焦點還在按鈕上，沒有 role="alert" 就沒有任何東西會把它讀出來。 */}
        {localError && (
          <div className="web-source-error" role="alert">
            {localError}
          </div>
        )}
        <div className="web-search-results">
          {!searched && !searching && (
            <div className="web-search-empty">輸入關鍵字後搜尋，這一步不會直接寫入來源。</div>
          )}
          {searched && results.length === 0 && (
            <div className="web-search-empty">找不到可加入的搜尋結果，請換一組關鍵字。</div>
          )}
          {results.map((result) => (
            <label
              className={`web-search-result ${selectedUrls.has(result.url) ? "selected" : ""}`}
              key={result.url}
            >
              <input
                type="checkbox"
                checked={selectedUrls.has(result.url)}
                onChange={(event) =>
                  setSelectedUrls((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(result.url);
                    else next.delete(result.url);
                    return next;
                  })
                }
              />
              <span>
                <strong>{result.title}</strong>
                <small>{result.url}</small>
                <p>{result.summary}</p>
              </span>
            </label>
          ))}
        </div>
        <footer>
          <span>
            已選 {selected.length} / {results.length} 筆
          </span>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || selected.length === 0}
            onClick={() => {
              setSaving(true);
              setLocalError(undefined);
              void onSave(selected)
                .catch((reason: unknown) =>
                  setLocalError(reason instanceof Error ? reason.message : "加入搜尋資料失敗"),
                )
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "正在擷取全文並儲存…" : `加入所選來源（${selected.length}）`}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/**
 * 伺服器錯誤代碼 → 使用者看得懂的原因。沒對到的代碼原樣顯示，總比吞掉好。
 *
 * 每一條對應的**使用者動作**都不一樣：限流要等一分鐘再按一次、逾時可以重試、hash 路由要
 * 改貼別的網址、上限要先刪來源。全部收斂成「該站阻擋自動擷取」等於叫人去做錯的事。
 */
const URL_FAILURE_REASONS: Record<string, string> = {
  WEB_SOURCE_URL_INVALID: "網址格式不正確",
  WEB_SOURCE_URL_UNSUPPORTED: "只支援 http／https 網址",
  WEB_SOURCE_URL_PRIVATE: "指向本機或內網位址，已阻擋",
  WEB_SOURCE_CONTENT_UNVERIFIED: "抓不到網頁正文（可能需要登入、或該站阻擋自動擷取）",
  WEB_SOURCE_HASH_ROUTE_UNSUPPORTED:
    "網址的 # 之後是頁面路徑（單頁應用），伺服器只拿得到首頁；請改貼該頁的實際網址",
  // 貼上網址的擷取完全外包給外部 render 服務，所以沒啟用＝整個功能不能用，而不是
  // 「這一頁比較特別」。訊息要讓使用者知道重試沒有意義，該去找的是部署設定。
  WEB_SOURCE_RENDER_UNAVAILABLE: "伺服器未啟用外部 render 服務，目前無法用貼上網址加入來源",
  WEB_SOURCE_TIMEOUT: "連線逾時，稍後再試一次",
  WEB_SOURCE_TOO_LARGE: "網頁內容過大，已略過",
  WEB_SOURCE_BATCH_TIMEOUT: "整批擷取已用完時間預算，這一筆還沒輪到；請分批再試",
  WEB_RENDER_RATE_LIMITED: "外部 render 服務目前限流，約一分鐘後再試一次",
  WEB_RENDER_TIMEOUT: "外部 render 服務逾時，稍後再試一次",
  WEB_RENDER_EMPTY: "外部 render 服務沒有取得任何正文",
  WEB_RENDER_TOO_LARGE: "外部 render 服務回傳的內容過大，已略過",
  WEB_RENDER_URL_MISMATCH: "外部 render 服務回傳的是另一個網址的內容，已拒收",
  // 這兩條都是 render 服務的 `Warning:`，但下一步相反：目標站擋人的話重試一百次也一樣，
  // 頁面沒載完則是重試就可能成功。分不開就會讓人在錯的那一邊耗著。
  WEB_RENDER_TARGET_ERROR:
    "目標網站拒絕了 render 服務的請求（多半擋自動擷取）；重試無效，請改貼其他網址或自行複製內容",
  WEB_RENDER_INCOMPLETE: "這一頁還沒載完就被 render 服務回報了，內容可能不完整，已拒收；請再試一次",
  WEB_RENDER_WARNING: "外部 render 服務回報這個網址擷取有問題",
  WEB_RENDER_FAILED: "外部 render 服務失敗，稍後再試一次",
  // 兩種上限分開：份數滿了是「刪幾份」，容量滿了是「刪大的那幾份」——下一步不同，所以
  // 不能共用一句。**份數與容量的實際數字不寫在這裡**：那是伺服器訊息帶回來的唯一真相，
  // 抄一份到前端就是第二份真相，改上限時必定漂掉（舊版硬編的「100 份」就是這樣過期的）。
  SOURCE_COUNT_LIMIT: "專案來源份數已達上限，請先刪掉一些來源再加入",
  SOURCE_SIZE_LIMIT: "專案來源總容量已達上限，請先刪掉一些較大的來源再加入",
};

function urlFailureReason(reason: string): string {
  return URL_FAILURE_REASONS[reason] ?? reason;
}

/**
 * 一行一個網址；空行與前後空白忽略，重複的只留一筆。
 *
 * 分隔符含空白與逗號：從文件、聊天訊息或試算表複製過來的網址常常是空白或逗號分隔的，
 * 只切換行會把整段變成一條必定失敗的「網址」。
 */
function parsePastedUrls(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

function UrlSourceDialog({
  onCancel,
  onBusyChange,
  onSubmit,
}: {
  onCancel: () => void;
  /** 讓外層知道請求還在跑：Escape 與其他關閉路徑都要跟著鎖住。 */
  onBusyChange: (busy: boolean) => void;
  onSubmit: (urls: string[]) => Promise<{ failures: UrlSourceFailure[] }>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusyState] = useState(false);
  const setBusy = (next: boolean) => {
    setBusyState(next);
    onBusyChange(next);
  };
  const [failures, setFailures] = useState<UrlSourceFailure[]>([]);
  const [localError, setLocalError] = useState<string>();
  const dialogRef = useRef<HTMLFormElement>(null);
  useDialogA11y(dialogRef, true);
  const urls = parsePastedUrls(value);
  const tooMany = urls.length > URL_SOURCE_BATCH_LIMIT;
  const dismiss = useBackdropDismiss(onCancel, !busy);
  // portal 到 body，理由同 SourcePreviewDialog。
  return createPortal(
    <div
      className="text-source-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="貼上網址"
      {...dismiss}
    >
      <form
        className="text-source-dialog url-source-dialog"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!urls.length || tooMany || busy) return;
          setBusy(true);
          setLocalError(undefined);
          setFailures([]);
          void onSubmit(urls)
            .then((result) => {
              setFailures(result.failures);
              // 全部成功才關閉；有失敗就留著讓使用者看清楚是哪幾筆。
              if (!result.failures.length) onCancel();
              else setValue(result.failures.map((failure) => failure.url).join("\n"));
            })
            .catch((reason: unknown) => {
              setLocalError(reason instanceof Error ? reason.message : "加入網址來源失敗");
              const listed = (reason as { failures?: UrlSourceFailure[] })?.failures;
              setFailures(Array.isArray(listed) ? listed : []);
            })
            .finally(() => setBusy(false));
        }}
      >
        <header>
          <div>
            <span className="section-label">PASTE URL SOURCE</span>
            <h2>貼上網址</h2>
            <p>
              一行一個網址（最多 {URL_SOURCE_BATCH_LIMIT} 筆）。系統會擷取網頁正文、建立索引並存回
              目前專案；抓不到正文的網址不會加入，也不會用網頁摘要充數。
            </p>
          </div>
          <button type="button" aria-label="關閉貼上網址" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          網址清單
          <textarea
            aria-label="網址清單"
            autoFocus
            rows={8}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={"https://example.com/article\nhttps://example.com/report"}
          />
        </label>
        <small>
          {urls.length} 個網址{tooMany ? ` · 超過上限 ${URL_SOURCE_BATCH_LIMIT} 筆` : ""} ·
          動態網頁（需要 JavaScript 才顯示內容的網站）會改由外部 render 服務取得正文，
          該網址與其內容會送往第三方處理。
        </small>
        {/* 整批失敗的那一句與逐筆清單同時出現；沒有 role="alert" 兩者都不會被讀出來。 */}
        {localError && (
          <div className="web-source-error" role="alert">
            {localError}
          </div>
        )}
        {failures.length > 0 && (
          <ul className="url-source-failures">
            {/* 同一個無效網址貼兩次就會回兩筆一模一樣的 failure，url 不是唯一鍵。 */}
            {failures.map((failure, index) => (
              <li key={`${failure.url}#${index}`}>
                <b>{failure.url}</b>
                <span>{urlFailureReason(failure.reason)}</span>
              </li>
            ))}
          </ul>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={busy || !urls.length || tooMany}>
            {busy ? "正在擷取網頁正文…" : `加入網址來源（${urls.length}）`}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function TextSourceDialog({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, text: string) => void;
}) {
  const [name, setName] = useState("貼上文字.md");
  const [content, setContent] = useState("");
  const dialogRef = useRef<HTMLFormElement>(null);
  useDialogA11y(dialogRef, true);
  const dismiss = useBackdropDismiss(onCancel, !busy);
  const normalizedName = /\.(?:md|txt)$/i.test(name.trim())
    ? name.trim()
    : `${name.trim() || "貼上文字"}.md`;
  // portal 到 body，理由同 SourcePreviewDialog。
  return createPortal(
    <div
      className="text-source-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="輸入文字來源"
      {...dismiss}
    >
      <form
        className="text-source-dialog"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (content.trim()) onSubmit(normalizedName, content.trim());
        }}
      >
        <header>
          <div>
            <span className="section-label">PASTE TEXT SOURCE</span>
            <h2>輸入文字來源</h2>
            <p>貼上的內容會存成專案來源、切成文字區塊並加入檢索。</p>
          </div>
          <button type="button" aria-label="關閉輸入文字" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          來源名稱
          <input
            aria-label="文字來源名稱"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：訪談筆記.md"
          />
        </label>
        <label>
          文字內容
          <textarea
            aria-label="文字來源內容"
            autoFocus
            rows={14}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="在這裡貼上研究資料、訪談逐字稿、會議筆記或其他文字…"
          />
        </label>
        <small>
          {content.length.toLocaleString("zh-TW")} 字元 · 將儲存為 {normalizedName}
        </small>
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={busy || !content.trim()}>
            {busy ? "正在建立來源…" : "加入文字來源"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

/**
 * 專案素材（sources）管理面板：上傳檔案／輸入文字／從網路加入資料，以及來源清單的
 * 搜尋、預覽、AI 存取開關、生成用途與刪除。自管上傳 busy 與三個對話框狀態，透過
 * onProject 回報更新後的專案。編輯器側欄與建立流程「上傳素材」步驟共用此元件。
 *
 * 來源搜尋純在前端比對已載入的 project.sources（全文／檔名／來源網址），不呼叫後端；
 * 命中的來源在預覽對話框裡會 highlight 全文中的關鍵字。
 */
export function SourcePanel({
  project,
  onProject,
  onError,
}: {
  project: PresentationProject;
  onProject: (project: PresentationProject) => void;
  onError: (message: string) => void;
}) {
  const [sourcePreview, setSourcePreview] = useState<SourceAsset>();
  const [showWebSourceSearch, setShowWebSourceSearch] = useState(false);
  // 「加入所選來源」按下去之後 addWebSources 還在跑，這時關掉對話框只是把畫面收掉：來源
  // 照樣落地、setQuery("") 照樣執行，使用者卻以為自己取消了。
  const [webSourceBusy, setWebSourceBusy] = useState(false);
  const [showUrlSource, setShowUrlSource] = useState(false);
  // 擷取中途按 Esc 會關掉對話框、丟掉失敗清單，而請求還在跑（相鄰的貼上文字有守衛）。
  const [urlSourceBusy, setUrlSourceBusy] = useState(false);
  const [showTextSource, setShowTextSource] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [query, setQuery] = useState("");
  /**
   * 正在送出請求的來源 id。
   *
   * 用集合而不是單一 id：使用者可以在等待期間去點另一張卡片，兩筆請求本來就會併行，
   * 用單一 id 記錄會讓先回來的那一筆把另一筆的忙碌狀態抹掉。
   */
  const [pendingSourceIds, setPendingSourceIds] = useState<ReadonlySet<string>>(new Set());

  const terms = searchTerms(query);
  // 新增來源後清空搜尋，否則新來源若不符合目前關鍵字會「加了卻沒出現」。
  const visibleSources = terms.length
    ? project.sources.filter((source) => matchSource(source, terms))
    : project.sources;

  /**
   * Escape 由上往下逐層關閉；忙碌中的那一層擋住，但**事件仍然吃掉**。
   *
   * 兩個守衛寫成巢狀 if 而不是 `showX && !busy`：寫成 `&&` 時，忙碌中的分支會落空、整條
   * 鏈繼續往下掉到「清空搜尋關鍵字」那一支——擷取網址擷取到一半按 Esc，對話框沒關（正確），
   * 卻無聲清掉了背後的搜尋框，整份來源清單在對話框後面跳掉。有對話框開著時，Escape 的
   * 對象只可能是最上層那一個，不會是它背後的搜尋框。
   *
   * 同一條理由對**別的元件**開的對話框一樣成立，而上面那四個 state 看不到它們：這條鏈是全域
   * 的第四條 window keydown listener，而 `SourcePanel`（`panel === "sources"`）與 header 齒輪
   * 打開的系統設定對話框住在同一個 shell 裡、可以同時存在。實測：搜尋框打了「營收」把 175 份
   * 來源縮到 3 張卡，從齒輪開啟系統設定再按 Esc——對話框關掉了（正確），背後的搜尋框卻被無聲
   * 清空、清單彈回全部 175 份。所以最後那一支要多問一次 `modalDialogOpen()`；自己那四個對話框
   * 開著時它本來就到不了這一支，行為完全不變。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sourcePreview) setSourcePreview(undefined);
      else if (showWebSourceSearch) {
        if (!webSourceBusy) setShowWebSourceSearch(false);
      } else if (showUrlSource) {
        if (!urlSourceBusy) setShowUrlSource(false);
      } else if (showTextSource) {
        if (!uploadBusy) setShowTextSource(false);
      } else if (query && !modalDialogOpen()) setQuery("");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    sourcePreview,
    showWebSourceSearch,
    webSourceBusy,
    showUrlSource,
    urlSourceBusy,
    showTextSource,
    uploadBusy,
    query,
  ]);

  /**
   * 卡片上的單筆操作。`action` 只用在**沒有** Error 可讀的那條路徑上。
   *
   * 舊的 fallback 是一句「操作失敗」：任何非 Error 的拒絕（例如網路層丟出的字串）都會
   * 落到它，而使用者手上只剩「有東西壞了」，連是勾選、改用途還是刪除都分不出來。
   */
  const run = async (
    source: SourceAsset,
    action: string,
    operation: () => Promise<PresentationProject>,
  ) => {
    setPendingSourceIds((current) => new Set(current).add(source.id));
    try {
      onProject(await operation());
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : `${action}失敗（伺服器沒有回報原因）`);
    } finally {
      setPendingSourceIds((current) => {
        const next = new Set(current);
        next.delete(source.id);
        return next;
      });
    }
  };

  /**
   * 改生成用途。改成「視覺參考」時可以順便補跑一次 AI 內容描述。
   *
   * 這裡刻意分成「問」與「看結果」兩段：要不要問，只看前端手上這份 payload 判斷得了的
   * 條件；至於伺服器到底會不會跑（開關關掉、沒設文字模型、模型不可用），前端無從得知，
   * 所以**不預測**，改看回應——這筆來源沒有變成 `parsing` 就代表什麼都沒發生，直說。
   * 少了這一段，確認框會在那些配置下承諾一件不會發生的事。
   *
   * 這條路可能觸發視覺模型（消耗配額、要等好幾秒），所以整段都要記進 `pendingSourceIds`：
   * 沒有忙碌狀態時，使用者在下拉選單改完用途後畫面一動也不動，只能再改一次。
   */
  const changeUsage = async (source: SourceAsset, usage: SourceAsset["usage"]) => {
    const requested =
      canDescribe(source, usage) &&
      confirm(
        `要順便讓 AI 讀出「${source.name}」的內容嗎？\n\n若目前的模型設定支援讀圖，會呼叫一次視覺模型（消耗配額）；讀完之後這張圖的內容才搜尋得到，也才會被大綱引用。\n\n按「取消」只改用途，不呼叫模型。`,
      );
    setPendingSourceIds((current) => new Set(current).add(source.id));
    try {
      const updated = await api.updateSource(project.id, source.id, {
        usage,
        ...(requested ? { describeImage: true } : {}),
      });
      onProject(updated);
      if (requested && updated.sources.find((item) => item.id === source.id)?.status !== "parsing")
        onError("目前的模型設定不會讀圖，已只更改用途（沒有呼叫模型，也沒有消耗配額）。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "更改生成用途失敗（伺服器沒有回報原因）");
    } finally {
      setPendingSourceIds((current) => {
        const next = new Set(current);
        next.delete(source.id);
        return next;
      });
    }
  };

  const uploadSourceFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploadBusy(true);
    try {
      const results = await Promise.allSettled(
        files.map((file) => api.uploadSource(project.id, file)),
      );
      onProject(await api.getProject(project.id));
      setQuery("");
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length)
        throw new Error(`${files.length - failed.length} 個檔案已上傳，${failed.length} 個失敗`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "來源上傳失敗");
    } finally {
      setUploadBusy(false);
    }
  };

  return (
    <>
      <div className="source-add-actions">
        <label className={`upload-source ${uploadBusy ? "disabled" : ""}`}>
          ＋ {uploadBusy ? "正在上傳來源…" : "上傳來源檔案"}
          {/*
            視覺上的「正在上傳來源…」就在左邊，但那是靜態文字，讀屏使用者不會被告知。
            另開一個 .visually-hidden 的 live region 而不是直接把上面那段包成 role="status"：
            包起來會讓 label 的可及名稱被切成兩段，且回到閒置時會播報「上傳來源檔案」
            這種聽起來像「又要你上傳一次」的內容。這裡只在有事發生時才有字。
          */}
          <span className="visually-hidden" role="status">
            {uploadBusy ? "正在上傳來源檔案，請稍候。" : ""}
          </span>
          <span>可多選 · PDF · PPTX · DOCX · MD · TXT · PNG · JPG</span>
          <input
            aria-label="上傳來源檔案"
            type="file"
            multiple
            disabled={uploadBusy}
            accept=".pdf,.pptx,.docx,.md,.txt,.png,.jpg,.jpeg"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadSourceFiles(files);
            }}
          />
        </label>
        <button
          className="add-text-source"
          disabled={uploadBusy}
          onClick={() => setShowTextSource(true)}
        >
          ＋ 輸入文字<span>貼上文字 · 自動建立索引</span>
        </button>
        <button
          className="add-web-source"
          disabled={uploadBusy}
          onClick={() => setShowWebSourceSearch(true)}
        >
          ＋ 從網路加入資料<span>輸入關鍵字 · 確認後儲存全文</span>
        </button>
        <button
          className="add-url-source"
          disabled={uploadBusy}
          onClick={() => setShowUrlSource(true)}
        >
          ＋ 貼上網址<span>一行一個 · 擷取正文後存入</span>
        </button>
      </div>
      {project.sources.length > 0 && (
        <div className="source-search">
          <label>
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="搜尋來源"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋來源內容、檔名或網址"
            />
          </label>
          {query && (
            <button type="button" aria-label="清除搜尋關鍵字" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>
      )}
      {terms.length > 0 && visibleSources.length > 0 && (
        <p className="source-search-count">
          {visibleSources.length} / {project.sources.length} 份來源符合
        </p>
      )}
      {project.sources.length === 0 && (
        <div className="source-empty">
          <b>尚無來源</b>
          <span>上傳文字、文件或圖片，生成時即可引用。</span>
        </div>
      )}
      {terms.length > 0 && visibleSources.length === 0 && (
        <div className="source-empty">
          <b>找不到符合的來源</b>
          <span>沒有來源包含「{query.trim()}」。</span>
          <button type="button" className="source-search-clear" onClick={() => setQuery("")}>
            清除搜尋
          </button>
        </div>
      )}
      <div className="source-list">
        {visibleSources.map((source) => {
          const imageSource = source.mediaType.startsWith("image/");
          const summary = sourceSummary(source);
          const failureText = describeFailure(source);
          const assetUrl = projectAssetUrl(project.id, source.assetPath);
          const pending = pendingSourceIds.has(source.id);
          return (
            <article key={source.id} className="source-card">
              <header className="source-card-header">
                <label className="source-access-toggle" title="允許 AI 在生成時讀取此來源">
                  {/*
                    送出期間鎖住：這顆勾選直接打 API，沒有 disabled 的話連點三下就排出三筆
                    請求，最後落地的是先送出、後回來的那一筆——畫面上的勾選狀態與伺服器相反。
                  */}
                  <input
                    aria-label={`允許 AI 使用 ${source.name}`}
                    type="checkbox"
                    checked={source.allowModelAccess}
                    disabled={pending}
                    onChange={(event) =>
                      void run(source, "更改 AI 使用權限", () =>
                        api.updateSource(project.id, source.id, {
                          allowModelAccess: event.target.checked,
                        }),
                      )
                    }
                  />
                </label>
                <div>
                  <strong title={source.name}>{source.name}</strong>
                  {/*
                    這一行是整張卡片唯一會自己變的文字（上傳完成、AI 讀圖完成、逾時改口、
                    以及上面那些單筆操作），所以 live region 掛在它身上：既不必新增元素，
                    也剛好涵蓋「分析中 → N 個文字區塊」這個唯一有意義的完成通知。

                    role 一律掛著，**不改成「只在分析中才掛」**：live region 必須在內容變化
                    **之前**就存在於 DOM 裡才會被可靠地播報，掛的時機跟著文字一起出現等於把
                    唯一重要的那個通知（分析完成）變成不確定行為。專案上限 200 份來源就是最多
                    200 個 polite region，這是已知代價——但 polite region 在文字沒變時不會做任何
                    事，換來的可靠性值這個價。
                  */}
                  <small role="status">
                    {sourceSize(source.sizeBytes)} ·{" "}
                    {pending
                      ? "更新中…"
                      : isDescribing(source)
                        ? parsingLabel(source, project.sources)
                        : `${source.chunks.length} 個文字區塊`}
                  </small>
                  {/*
                    **不可**是 `role="alert"`：它渲染的是 `metadata.imageDescriptionFailure`
                    這個**持久狀態**，不是剛發生的事件，而 assertive region 一插入 DOM 就會播報
                    並打斷讀屏正在念的東西。一個綁錯組合的專案可以有 12 張圖同時帶著這個旗標，
                    切到來源分頁時 `SourcePanel` 掛載＝12 個 alert 同時插入，螢幕閱讀器排隊念 12 次
                    「⚠ AI 未讀取圖片內容」，而且每次回到這個分頁都重演一次。
                    連 role 都不給：這段文字就在卡片裡，瀏覽模式讀得到，而上面那個 status region
                    的文字會在同一時刻一起變（分析中 → N 個文字區塊），已經有一次通知。
                    真正事件驅動的那一個保留 `role="alert"`——`SourcePreviewDialog` 裡對話框開著時
                    背景輪詢把「AI 正在讀取…」換成失敗訊息，那才是「剛剛發生了一件事」。
                  */}
                  {failureText && (
                    <small className="source-describe-failed" title={failureText}>
                      ⚠ AI 未讀取圖片內容
                    </small>
                  )}
                </div>
                <span className="source-kind">{sourceTypeLabel(source)}</span>
              </header>
              <button
                type="button"
                className={`source-preview-trigger ${imageSource ? "image" : "text"}`}
                aria-label={`預覽 ${source.name}`}
                onClick={() => setSourcePreview(source)}
              >
                {imageSource ? (
                  <img src={assetUrl} alt="" />
                ) : (
                  <p>{summary || "尚未擷取到可預覽的文字內容"}</p>
                )}
                <span>
                  查看來源詳情 <b>→</b>
                </span>
              </button>
              <label className="source-usage">
                生成用途
                <select
                  aria-label={`${source.name} 的生成用途`}
                  // 說明綁在 select 上，讀屏才會在念完選項後接著念「選了會發生什麼事」。
                  // 說明本身放在 label 外面：`<label>` 是 grid（標題 ｜ 下拉），塞進去會
                  // 落在第三格、擠掉下拉的寬度。
                  aria-describedby={`source-usage-hint-${source.id}`}
                  value={source.usage}
                  disabled={pending}
                  onChange={(event) =>
                    // 改成「視覺參考」時可以順便補跑內容描述，但那會呼叫模型、消耗配額——
                    // 使用者只是在下拉選單裡改個用途，靜默地花掉配額不誠實，所以先問（見
                    // changeUsage：問完之後以回應為準，不預測伺服器會不會跑）。
                    void changeUsage(source, event.target.value as typeof source.usage)
                  }
                >
                  {SOURCE_USAGE_OPTIONS.map((option) => (
                    // `<option>` 只放標籤：說明塞進來會把下拉撐到整個面板寬。
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {/*
                目前選到的那一項的說明。**不是** live region：它跟著使用者自己的操作變，
                讀屏在焦點還在 select 上時會照 aria-describedby 念出新值，再加一個 status
                只會念兩次。
              */}
              <p className="source-usage-hint" id={`source-usage-hint-${source.id}`}>
                {SOURCE_USAGE_DETAIL[source.usage].hint}
              </p>
              {/*
                「標了大綱參考卻不會生效」。形狀比照 `metadata.imageDescriptionFailure` 那條
                （同一個 --warning 色、同樣不給 role）：它渲染的是**持久狀態**而不是剛發生的
                事件，assertive region 一插入 DOM 就會打斷讀屏正在念的東西，而一個專案可以有
                十幾份這樣的來源。這段文字就在卡片裡，瀏覽模式讀得到。
              */}
              {outlineReferenceIssue(source) && (
                <p className="source-usage-warning">⚠ {outlineReferenceIssue(source)}</p>
              )}
              <div className="source-card-actions">
                {/* 確認之後刪除仍要跑一趟伺服器；沒有 disabled 的話按第二次會對已刪除的
                    id 再送一次，回來的是一句看不懂的 404。 */}
                <button
                  className="danger"
                  disabled={pending}
                  onClick={() => {
                    if (confirm("刪除來源？既有版本的來源快照仍會保留。"))
                      void run(source, "刪除來源", () =>
                        api.deleteSource(project.id, source.id, true),
                      );
                  }}
                >
                  {pending ? "處理中…" : "刪除來源"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {sourcePreview && (
        <SourcePreviewDialog
          projectId={project.id}
          // 清單裡的那一份才是最新的（輪詢會換掉 project）；sourcePreview 是開啟當下的快照，
          // 拿它顯示會讓對話框開著時看不到分析完成。
          source={project.sources.find((item) => item.id === sourcePreview.id) ?? sourcePreview}
          sources={project.sources}
          terms={terms}
          onClose={() => setSourcePreview(undefined)}
        />
      )}
      {showWebSourceSearch && (
        <WebSourceDialog
          onCancel={() => setShowWebSourceSearch(false)}
          onBusyChange={setWebSourceBusy}
          onSearch={(query) => api.searchWebSources(project.id, query)}
          onSave={async (sources) => {
            onProject(await api.addWebSources(project.id, sources));
            setShowWebSourceSearch(false);
            setQuery("");
          }}
        />
      )}
      {showUrlSource && (
        <UrlSourceDialog
          onCancel={() => setShowUrlSource(false)}
          onBusyChange={setUrlSourceBusy}
          onSubmit={async (urls) => {
            const result = await api.addUrlSources(project.id, urls);
            onProject(result.project);
            setQuery("");
            return { failures: result.failures };
          }}
        />
      )}
      {showTextSource && (
        <TextSourceDialog
          busy={uploadBusy}
          onCancel={() => setShowTextSource(false)}
          onSubmit={(name, text) => {
            setUploadBusy(true);
            const file = new File([text], name, {
              type: name.toLowerCase().endsWith(".txt") ? "text/plain" : "text/markdown",
            });
            void api
              .uploadSource(project.id, file)
              .then((updated) => {
                onProject(updated);
                setShowTextSource(false);
                setQuery("");
              })
              .catch((reason: unknown) =>
                onError(reason instanceof Error ? reason.message : "建立文字來源失敗"),
              )
              .finally(() => setUploadBusy(false));
          }}
        />
      )}
    </>
  );
}

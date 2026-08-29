import { useEffect, useState, type ReactNode } from "react";
import type {
  ConnectionProtocol,
  ImageModelProfile,
  ImageOptionField,
  ImageOptionSetView,
  ImageOptionValues,
  ModelCapability,
  ModelCombination,
  ModelConnection,
  ModelEntry,
  ModelLibrary as ModelLibraryData,
  OpenAiImageApi,
  ProviderKind,
} from "@slide-maker/core";
import { api } from "./api.js";
import { LibraryHeader } from "./LibraryHeader.js";

const CAPABILITY_LABEL: Record<ModelCapability, string> = {
  image: "影像",
  text: "文字",
  search: "搜尋",
};
const KIND_LABEL: Record<ProviderKind, string> = {
  mock: "Mock",
  openai: "OpenAI 相容",
  gemini: "Gemini 原生",
  local: "本機（OpenCV）",
};
const PROTOCOL_LABEL: Record<ConnectionProtocol, string> = {
  openai: "OpenAI 相容",
  gemini: "Gemini 原生",
};
const CAPABILITIES: ModelCapability[] = ["image", "text", "search"];
const KINDS: ProviderKind[] = ["mock", "openai", "gemini", "local"];
const PROTOCOLS: ConnectionProtocol[] = ["openai", "gemini"];
const OPENAI_IMAGE_APIS: OpenAiImageApi[] = ["images", "chat", "openrouter-image"];

/** 需要連線的 provider kind（HTTP 端點兩家）；mock／local 在本機跑，沒有連線概念。 */
function needsConnection(kind: ProviderKind): kind is ConnectionProtocol {
  return kind === "openai" || kind === "gemini";
}

/** 只列協定與 entry kind 相符的連線：Gemini entry 指到 OpenAI 端點必然跑不起來。 */
function connectionsFor(library: ModelLibraryData, kind: ProviderKind): ModelConnection[] {
  return needsConnection(kind)
    ? library.connections.filter((connection) => connection.protocol === kind)
    : [];
}

function modelsByCapability(library: ModelLibraryData, capability: ModelCapability): ModelEntry[] {
  return library.models.filter((entry) => entry.capability === capability);
}

// ── 影像參數 ────────────────────────────────────────────────────────────────────
//
// 「這個模型可調什麼」由 provider 宣告（`GET /api/model-library/image-options`），這裡只負責
// 渲染、存值與 dirty 比較——**框架不認得任何一個欄位 id 的語意**，所以加一家新模型時這個檔案
// 一行都不用改。前端也不自己算那份清單：算得出來的前提是知道每一家吃什麼欄位，而那份知識
// 住在 provider 套件裡，鏡射一份必然漂移。

/** dirty 比較與 useRowAction 的 key。物件 key 順序不穩，所以排序後再序列化。 */
function imageProfileKey(profile: ImageModelProfile | undefined): string {
  const values = Object.entries(profile?.options ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    values,
    profile?.maxReferenceImages ?? null,
    profile?.promptMaxBytes ?? null,
    profile?.maxConcurrency ?? null,
  ]);
}

interface ImageProfileForm {
  values: ImageOptionValues;
  setValue: (id: string, value: string | number | undefined) => void;
  maxRefs: string;
  setMaxRefs: (value: string) => void;
  promptMax: string;
  setPromptMax: (value: string) => void;
  concurrency: string;
  setConcurrency: (value: string) => void;
  /** 目前欄位組出來的設定；全部留白時是 undefined（＝這個 entry 不存影像參數）。 */
  profile: ImageModelProfile | undefined;
  key: string;
  errors: { maxRefs?: string; promptMax?: string; concurrency?: string };
}

function positiveIntError(raw: string, label: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return `${label}只接受數字（正整數）；留空則沿用預設。`;
  return Number(value) > 0 ? undefined : `${label}需大於 0；留空則沿用預設。`;
}

function useImageProfileForm(initial?: ImageModelProfile): ImageProfileForm {
  const [values, setValues] = useState<ImageOptionValues>(initial?.options ?? {});
  const [maxRefs, setMaxRefs] = useState(
    initial?.maxReferenceImages !== undefined ? String(initial.maxReferenceImages) : "",
  );
  const [promptMax, setPromptMax] = useState(
    initial?.promptMaxBytes !== undefined ? String(initial.promptMaxBytes) : "",
  );
  const [concurrency, setConcurrency] = useState(
    initial?.maxConcurrency !== undefined ? String(initial.maxConcurrency) : "",
  );

  const errors: ImageProfileForm["errors"] = {};
  const maxRefsError = positiveIntError(maxRefs, "參考圖上限");
  if (maxRefsError) errors.maxRefs = maxRefsError;
  const promptMaxError = positiveIntError(promptMax, "prompt 上限");
  if (promptMaxError) errors.promptMax = promptMaxError;
  const concurrencyError = positiveIntError(concurrency, "並行生成數");
  if (concurrencyError) errors.concurrency = concurrencyError;
  // 上界與 jobs.ts 的 providerLimit() 對齊：那裡對超出範圍是丟例外，整批生成會在排程時就死。
  else if (concurrency.trim() && Number(concurrency) > 32)
    errors.concurrency = "並行生成數最多 32；再高只會撞上端點限流，整批一起失敗。";

  const maxReferenceImages = maxRefs.trim() ? Number(maxRefs) : undefined;
  const promptMaxBytes = promptMax.trim() ? Number(promptMax) : undefined;
  const maxConcurrency = concurrency.trim() ? Number(concurrency) : undefined;
  const hasValues = Object.keys(values).length > 0;
  const profile: ImageModelProfile | undefined =
    !hasValues &&
    maxReferenceImages === undefined &&
    promptMaxBytes === undefined &&
    maxConcurrency === undefined
      ? undefined
      : {
          ...(hasValues ? { options: values } : {}),
          ...(maxReferenceImages !== undefined ? { maxReferenceImages } : {}),
          ...(promptMaxBytes !== undefined ? { promptMaxBytes } : {}),
          ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
        };

  return {
    values,
    // 選回「依模型預設」時要把 key 整個拿掉，而不是存一個空字串——伺服器會拿它去比對
    // provider 宣告的選項，空字串不在任何一份清單裡。
    setValue: (id, value) =>
      setValues((current) => {
        if (value === undefined || value === "") {
          const { [id]: _removed, ...rest } = current;
          return rest;
        }
        return { ...current, [id]: value };
      }),
    maxRefs,
    setMaxRefs,
    promptMax,
    setPromptMax,
    concurrency,
    setConcurrency,
    profile,
    key: imageProfileKey(profile),
    errors,
  };
}

function ImageOptionInput({ field, form }: { field: ImageOptionField; form: ImageProfileForm }) {
  const current = form.values[field.id];
  if (field.kind === "select")
    return (
      <label className="model-library-option-field">
        <span>{field.label}</span>
        <select
          aria-label={field.label}
          title={field.hint ?? ""}
          value={typeof current === "string" ? current : ""}
          onChange={(event) => form.setValue(field.id, event.target.value)}
        >
          <option value="">{field.unsetLabel}</option>
          {field.choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label className="model-library-option-field">
      <span>{field.label}</span>
      <input
        aria-label={field.label}
        title={field.hint ?? ""}
        inputMode="numeric"
        placeholder={field.placeholder}
        value={typeof current === "number" ? String(current) : ""}
        onChange={(event) => {
          const raw = event.target.value.trim();
          form.setValue(field.id, raw && /^\d+$/.test(raw) ? Number(raw) : undefined);
        }}
      />
    </label>
  );
}

function ImageProfileFields({
  form,
  optionSet,
}: {
  form: ImageProfileForm;
  optionSet: ImageOptionSetView | undefined;
}) {
  return (
    <div className="model-library-image-profile">
      <span className="model-library-image-profile-label">影像參數</span>
      {optionSet ? (
        optionSet.fields.map((field) => (
          <ImageOptionInput key={field.id} field={field} form={form} />
        ))
      ) : (
        // 認不出來的模型不給假選項：列一個端點不吃的值，使用者選了只會拿到不透明的 400。
        <span className="model-library-option-empty">
          這個模型沒有已知的可調項，一律依端點預設。
        </span>
      )}
      {/*
        這兩格與模型無關（每條 transport 都有這兩個概念），而且只有撞到端點限制時才會動，
        所以收進摺疊區，不佔平常的視線。
      */}
      <details className="model-library-advanced">
        <summary>進階</summary>
        <div className="model-library-advanced-body">
          <label className="model-library-option-field">
            <span>參考圖上限</span>
            <input
              aria-label="參考圖上限"
              inputMode="numeric"
              placeholder="留空沿用端點上限"
              value={form.maxRefs}
              onChange={(event) => form.setMaxRefs(event.target.value)}
            />
          </label>
          <label className="model-library-option-field">
            <span>prompt 上限 bytes</span>
            <input
              aria-label="prompt 上限"
              inputMode="numeric"
              placeholder="留空不限"
              value={form.promptMax}
              onChange={(event) => form.setPromptMax(event.target.value)}
            />
          </label>
          <label className="model-library-option-field">
            <span>並行生成數</span>
            <input
              aria-label="並行生成數"
              inputMode="numeric"
              placeholder="留空沿用系統設定"
              value={form.concurrency}
              onChange={(event) => form.setConcurrency(event.target.value)}
            />
          </label>
          {form.errors.maxRefs && <FieldError>{form.errors.maxRefs}</FieldError>}
          {form.errors.promptMax && <FieldError>{form.errors.promptMax}</FieldError>}
          {form.errors.concurrency && <FieldError>{form.errors.concurrency}</FieldError>}
        </div>
      </details>
    </div>
  );
}

/** 影像參數只對真的會打 HTTP 影像端點的 entry 有意義（mock／local 不打）。 */
function supportsImageProfile(capability: ModelCapability, kind: ProviderKind): boolean {
  return capability === "image" && needsConnection(kind);
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const SECTION_ICONS: Record<string, ReactNode> = {
  connections: (
    <Icon>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" x2="16" y1="12" y2="12" />
    </Icon>
  ),
  models: (
    <Icon>
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </Icon>
  ),
  combinations: (
    <Icon>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 12.18-9.17 4.16a2 2 0 0 1-1.66 0L2 12.18" />
      <path d="m22 17.18-9.17 4.16a2 2 0 0 1-1.66 0L2 17.18" />
    </Icon>
  ),
  system: (
    <Icon>
      <path d="M10 4.5V2M14 4.5V2M4.5 10H2M4.5 14H2M22 10h-2.5M22 14h-2.5M10 22v-2.5M14 22v-2.5" />
      <rect width="14" height="14" x="5" y="5" rx="3" />
    </Icon>
  ),
};

function SectionHeading({ icon, label, title }: { icon: string; label: string; title: string }) {
  return (
    <div className="dashboard-section-heading">
      <span className="model-library-section-icon" aria-hidden="true">
        {SECTION_ICONS[icon]}
      </span>
      <div>
        <span className="section-label">{label}</span>
        <h2>{title}</h2>
      </div>
    </div>
  );
}

export interface ConnectionModels {
  models: string[];
  status: "idle" | "loading" | "loaded" | "error";
  error?: string;
}

/** 只接受 http／https 的完整網址；其餘（相對路徑、缺協定、ws://）在執行期只會是 fetch 例外。 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

type ConnectionFieldErrors = {
  name?: string | undefined;
  baseUrl?: string | undefined;
  timeout?: string | undefined;
};

/** 新增與編輯連線共用的純欄位驗證；兩個入口必須回報完全相同的就地訊息。 */
function connectionFieldErrors(
  name: string,
  baseUrl: string,
  timeout: string,
): ConnectionFieldErrors {
  const errors: ConnectionFieldErrors = {};
  if (!name.trim()) errors.name = "請輸入名稱，之後在模型的「連線」下拉選單裡就是靠它指認。";
  const url = baseUrl.trim();
  if (!url) errors.baseUrl = "請輸入 base URL；留空的連線只會在生成時以 HTTP 錯誤失敗。";
  else if (!isHttpUrl(url))
    errors.baseUrl = "需要 http／https 開頭的完整網址，例如 http://localhost:8317/v1。";
  const timeoutRaw = timeout.trim();
  if (timeoutRaw) {
    if (!/^\d+$/.test(timeoutRaw))
      errors.timeout = "連線逾時只接受數字（正整數）；留空則沿用系統設定的模型逾時。";
    else if (Number(timeoutRaw) <= 0)
      errors.timeout = "連線逾時需大於 0；留空則沿用系統設定的模型逾時。";
  }
  return errors;
}

/**
 * 表單欄位旁的錯誤字。
 *
 * 沿用 `.model-library-conn-status.error`（連線測試失敗那行紅字）而不是另立 class：同一種
 * 「這裡出問題了」的紅字沒有理由有兩份樣式。橫向 flex 的 `.model-library-row` 裡要獨佔一列
 * 這件事由 styles.css 的 `.model-library-row > .model-library-conn-status`（`flex: 1 0 100%`）
 * 負責，直式容器（`.model-library-connection-row`、建立表單）本來就是一列一個。
 */
function FieldError({ children }: { children: string }) {
  return (
    <p className="model-library-conn-status error" role="alert">
      {children}
    </p>
  );
}

export function ModelLibrary({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [library, setLibrary] = useState<ModelLibraryData>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 連線 → 可用模型 id 清單快取（GET /models）。連線建立或選取時載入。
  const [connectionModels, setConnectionModels] = useState<Record<string, ConnectionModels>>({});
  // 每個影像模型可調什麼——由 provider 宣告、伺服器轉交。前端不自己算：算得出來的前提是
  // 知道每一家吃什麼欄位，那份知識住在 provider 套件裡，鏡射一份必然漂移。
  const [imageOptionSets, setImageOptionSets] = useState<Record<string, ImageOptionSetView>>({});

  const loadImageOptions = async (): Promise<void> => {
    try {
      const { options } = await api.imageOptions();
      // 形狀不符（舊版伺服器、代理回了別的東西）不該讓整個模型庫變成白畫面。
      setImageOptionSets(options ?? {});
    } catch {
      // 拿不到就當作沒有已知可調項：那一格會顯示「依端點預設」，不會擋住其他設定。
      setImageOptionSets({});
    }
  };

  const loadConnectionModels = async (connectionId: string): Promise<void> => {
    if (!connectionId) return;
    setConnectionModels((current) => ({
      ...current,
      [connectionId]: { models: current[connectionId]?.models ?? [], status: "loading" },
    }));
    try {
      const { models } = await api.connectionModels(connectionId);
      setConnectionModels((current) => ({
        ...current,
        [connectionId]: { models, status: "loaded" },
      }));
    } catch (reason) {
      setConnectionModels((current) => ({
        ...current,
        [connectionId]: {
          models: [],
          status: "error",
          error: reason instanceof Error ? reason.message : "載入模型清單失敗",
        },
      }));
    }
  };

  const loadLibrary = () => {
    setError(undefined);
    void api
      .modelLibrary()
      .then((value) => {
        setLibrary(value);
        // 建立完連線後即抓一次各連線的可用模型，讓下拉選單可用。
        for (const connection of value.connections) void loadConnectionModels(connection.id);
        void loadImageOptions();
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "載入模型庫失敗"),
      );
  };

  useEffect(loadLibrary, []);

  /**
   * 跑一次寫入並回報成敗。
   *
   * 回傳而不是只塞進頂端 toast，是為了讓每一列能**就地**顯示自己的失敗：模型庫是一頁四
   * 大區、可以捲很長的表單，第 3 個模型列儲存失敗時把訊息丟到畫面最上方，使用者根本不會
   * 把兩件事連起來。`action` 只用在沒有 Error 可讀的那條路徑——舊的 fallback 是一句
   * 「操作失敗」，零資訊、零下一步。
   *
   * 它**只**回報，不設任何全域錯誤狀態。舊版兩件事都做，於是一列儲存失敗會同時長出
   * `div[role=alert]`（頁底 toast）與 `p[role=alert]`（該列的 FieldError），字串一模一樣，
   * 螢幕閱讀器從兩個 alert region 把同一句話連讀兩遍。留下的是就地那一份——toast 講不出是
   * 哪一列，就地那份講得出，而這一頁沒有任何寫入失敗需要 toast。`error` 因此只剩一個用途：
   * 整頁載入失敗（那時畫面上根本沒有任何一列可以掛訊息，見下方的復原區塊）。
   *
   * 回傳 discriminated result 而不是「訊息字串或 undefined」：`if (failed) return;` 這種寫法
   * 把空訊息讀成成功，於是建立失敗了卻把使用者剛打好的欄位清掉。`api.ts` 的 `failureMessage()`
   * 現在保證非空，但成敗不該再依賴「訊息剛好不是空的」這種間接證據。順手也把空白訊息擋掉
   * ——`ok: false` 配一句空話同樣沒有下一步。
   */
  const run = async (task: () => Promise<ModelLibraryData>, action: string): Promise<RunResult> => {
    setBusy(true);
    try {
      setLibrary(await task());
      // 換模型或通道會換掉可調項；跟著重抓，否則那一格會停在上一個模型的選項。
      void loadImageOptions();
      return { ok: true };
    } catch (reason) {
      const message =
        (reason instanceof Error && reason.message.trim()) || `${action}失敗（伺服器沒有回報原因）`;
      return { ok: false, message };
    } finally {
      setBusy(false);
    }
  };

  if (!library)
    return (
      <main className="welcome dashboard library-mode">
        <LibraryHeader active="models" onNavigate={onNavigate} />
        <div className="dashboard-content">
          {/*
            載入失敗時整頁只剩一顆不可互動的 toast：沒有重試、沒有下一步，使用者只能重新
            整理瀏覽器。改成就地的復原區塊（role="alert" 讓它真的會被讀出來）。
          */}
          {error ? (
            <div className="model-library-empty" role="alert">
              <p>{error}</p>
              <button onClick={loadLibrary}>重新載入模型庫</button>
            </div>
          ) : (
            <p>載入中…</p>
          )}
        </div>
      </main>
    );

  return (
    <main className="welcome dashboard library-mode model-library">
      <LibraryHeader active="models" onNavigate={onNavigate} />
      {/*
        這裡刻意**沒有** ErrorToast：寫入失敗一律由出事的那一列自己就地顯示（見 `run`），
        再補一顆 toast 只會讓同一句話出現在兩個 alert region。整頁載入失敗走的是上面那塊
        帶「重新載入模型庫」的復原區塊，不是 toast。
      */}
      <div className="dashboard-content model-library-content">
        <ConnectionsSection
          library={library}
          busy={busy}
          run={run}
          connectionModels={connectionModels}
          onConnectionSaved={loadConnectionModels}
          onTestConnection={loadConnectionModels}
        />
        <ModelsSection
          library={library}
          busy={busy}
          run={run}
          connectionModels={connectionModels}
          onEnsureModels={loadConnectionModels}
          imageOptionSets={imageOptionSets}
        />
        <CombinationsSection library={library} busy={busy} run={run} />
        <SystemSection library={library} busy={busy} run={run} />
      </div>
    </main>
  );
}

/** 寫入的結果。成敗是明確的旗標，不是「訊息字串是不是空的」——見 `run` 的說明。 */
type RunResult = { ok: true } | { ok: false; message: string };

type RunFn = (task: () => Promise<ModelLibraryData>, action: string) => Promise<RunResult>;

/**
 * 一列（或一個建立表單）的「進行中 + 就地錯誤」狀態。
 *
 * 抽成 hook 而不是各處自己寫：整個模型庫沒有任何一顆按鈕會改文案，只有 `disabled={busy}`，
 * 使用者分不出「壞了」與「在跑」；而 `busy` 是**全頁共用**的，直接拿它改文案會讓每一列的
 * 儲存鈕同時寫著「儲存中…」。所以進行中狀態必須是每一列自己的。
 *
 * `resetKey` 是這一列目前欄位內容的快照，就地錯誤連同「它是對哪一份內容說的」一起記下來，
 * 於是使用者一改欄位它就自己消失。舊版只存訊息字串、只在下一次 `act` 才清，使用者一邊修
 * 欄位一邊看著上一次的「儲存失敗」掛在旁邊，看起來像剛才那次修正也失敗了（相鄰的
 * `fieldErrors` 每個 onChange 都清得掉，兩者行為不一致）。用快照而不是在二十幾個 onChange
 * 各補一行 `setRowError(undefined)`：漏掉任何一個，那一列就會留著過期訊息，而漏掉一個不會
 * 有任何東西提醒你——舊版留在介面上那顆從來沒人呼叫的 `setRowError` 就是這麼來的。
 */
function useRowAction(run: RunFn, resetKey: string) {
  const [pending, setPending] = useState<string>();
  const [stored, setStored] = useState<{ message: string; key: string }>();
  const rowError = stored?.key === resetKey ? stored?.message : undefined;
  /** 回傳成功與否，讓呼叫端能決定要不要清空表單——失敗時不該把使用者剛打好的欄位清掉。 */
  const act = async (kind: string, action: string, task: () => Promise<ModelLibraryData>) => {
    // 在按下去的那一刻取快照：送出期間使用者又改了欄位的話，這句話講的已經不是眼前那份內容。
    const key = resetKey;
    setPending(kind);
    setStored(undefined);
    const result = await run(task, action);
    setPending(undefined);
    if (!result.ok) setStored({ message: result.message, key });
    return result.ok;
  };
  return { pending, rowError, act };
}

function ConnectionsSection({
  library,
  busy,
  run,
  connectionModels,
  onConnectionSaved,
  onTestConnection,
}: {
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
  connectionModels: Record<string, ConnectionModels>;
  onConnectionSaved: (connectionId: string) => Promise<void>;
  onTestConnection: (connectionId: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [timeout, setTimeoutMs] = useState("");
  const [protocol, setProtocol] = useState<ConnectionProtocol>("openai");
  // 顯式帶上 `| undefined`：`exactOptionalPropertyTypes` 下，清掉單一欄位的錯誤
  // （`{ ...current, name: undefined }`）對純 optional 屬性是型別錯誤。
  const [fieldErrors, setFieldErrors] = useState<ConnectionFieldErrors>({});
  const { pending, rowError, act } = useRowAction(
    run,
    [name, baseUrl, apiKey, timeout, protocol].join("\0"),
  );
  /**
   * 送出前擋掉必填缺漏，訊息就顯示在出問題的那個欄位旁邊。
   *
   * 舊版只檢查 `!name.trim()`（而且是靠按鈕 disabled，使用者看不出少了什麼），base URL
   * 留空照樣建得起來——建出來的連線在畫面上一切正常，要等到某天生成或抽字時才變成一句
   * 難懂的 HTTP 錯誤，那時已經沒有人會把它連回「當初那個空欄位」。
   */
  const create = async () => {
    const errors = connectionFieldErrors(name, baseUrl, timeout);
    setFieldErrors(errors);
    if (errors.name || errors.baseUrl || errors.timeout) return;
    const before = new Set(library.connections.map((connection) => connection.id));
    const ok = await act("create", "新增連線", async () => {
      const next = await api.createConnection({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey,
        protocol,
        ...(timeout.trim() ? { timeoutMs: Number(timeout) } : {}),
      });
      // 建立完連線立刻打 /models，讓模型 entry 能用下拉選單挑模型。
      const created = next.connections.find((connection) => !before.has(connection.id));
      if (created) void onConnectionSaved(created.id);
      return next;
    });
    if (!ok) return; // 保留已填欄位讓使用者直接重試，而不是重打一次
    setName("");
    setBaseUrl("");
    setApiKey("");
    setTimeoutMs("");
    setProtocol("openai");
    setFieldErrors({});
  };
  return (
    <section className="dashboard-section model-library-section">
      <SectionHeading icon="connections" label="CONNECTIONS" title="連線（HTTP 模型端點）" />
      <p className="model-library-hint">
        供 OpenAI 相容／Gemini 原生模型引用的 base URL 與 API key。協定決定請求形狀，選錯了
        連線測試就會失敗。金鑰只寫不讀，顯示為佔位符。逾時留空則沿用系統設定的模型逾時。
      </p>
      <div className="model-library-list">
        {library.connections.length === 0 && <p className="model-library-empty">尚無連線。</p>}
        {library.connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            busy={busy}
            run={run}
            models={connectionModels[connection.id]}
            onTestConnection={onTestConnection}
            // 刪一條連線會讓引用它的模型 entry 立刻變成懸空 ref，所以確認文案必須講得出
            // 「會影響到誰」——這個數字現有資料結構就算得出來，沒有理由不講。
            dependents={library.models.filter((entry) => entry.connectionRef === connection.id)}
          />
        ))}
      </div>
      <div className="model-library-create">
        {/*
          用 .model-library-combo-field 包住需要驗證的欄位：它是既有的直式欄位容器
          （label 在上、控制項在下），錯誤字接在控制項下面才會落在「出問題的那個欄位旁邊」，
          而不是飛到頁頂的 toast。
        */}
        <div className="model-library-combo-field">
          <input
            aria-label="連線名稱"
            placeholder="名稱"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFieldErrors((current) => ({ ...current, name: undefined }));
            }}
          />
          {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
        </div>
        <select
          aria-label="協定"
          value={protocol}
          onChange={(event) => setProtocol(event.target.value as ConnectionProtocol)}
        >
          {PROTOCOLS.map((item) => (
            <option key={item} value={item}>
              {PROTOCOL_LABEL[item]}
            </option>
          ))}
        </select>
        <div className="model-library-combo-field">
          <input
            aria-label="Base URL"
            placeholder={
              protocol === "gemini"
                ? "https://generativelanguage.googleapis.com/v1beta"
                : "http://localhost:8317/v1"
            }
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setFieldErrors((current) => ({ ...current, baseUrl: undefined }));
            }}
          />
          {fieldErrors.baseUrl && <FieldError>{fieldErrors.baseUrl}</FieldError>}
        </div>
        <input
          aria-label="API Key"
          placeholder="API key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <div className="model-library-inline-wrap">
          <label className="model-library-inline-field">
            <span>逾時 ms</span>
            <input
              aria-label="連線逾時"
              inputMode="numeric"
              placeholder="留空沿用系統"
              value={timeout}
              onChange={(event) => {
                setTimeoutMs(event.target.value);
                setFieldErrors((current) => ({ ...current, timeout: undefined }));
              }}
            />
          </label>
          {fieldErrors.timeout && <FieldError>{fieldErrors.timeout}</FieldError>}
        </div>
        {/*
          刻意**不**在名稱空白時 disabled：按不下去的按鈕不會告訴任何人少了什麼，
          按得下去、然後在欄位旁指出缺漏才有下一步。
        */}
        <button className="primary" disabled={busy} onClick={create}>
          {pending === "create" ? "新增中…" : "新增連線"}
        </button>
      </div>
      {rowError && <FieldError>{rowError}</FieldError>}
    </section>
  );
}

function ConnectionRow({
  connection,
  busy,
  run,
  models,
  onTestConnection,
  dependents,
}: {
  connection: ModelConnection;
  busy: boolean;
  run: RunFn;
  models: ConnectionModels | undefined;
  onTestConnection: (connectionId: string) => Promise<void>;
  /** 引用這條連線的模型 entry：刪除確認要講得出會弄壞什麼。 */
  dependents: ModelEntry[];
}) {
  const [name, setName] = useState(connection.name);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [timeout, setTimeoutMs] = useState(
    connection.timeoutMs !== undefined ? String(connection.timeoutMs) : "",
  );
  const [protocol, setProtocol] = useState<ConnectionProtocol>(connection.protocol);
  const [testing, setTesting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ConnectionFieldErrors>({});
  const { pending, rowError, act } = useRowAction(
    run,
    [name, baseUrl, apiKey, timeout, protocol].join(" "),
  );
  /**
   * 與「新增連線」同一份必填檢查。
   *
   * 舊版只有建立那邊有：既有連線的 base URL 清空之後照樣存得下去，而後果一模一樣——連線在
   * 畫面上看起來正常，要到某天生成或抽字時才變成一句難懂的 HTTP 錯誤，那時沒有人會把它連回
   * 「當初把那個欄位清掉」。同一個陷阱只是換一個畫面出現。
   */
  const savedTimeout = connection.timeoutMs !== undefined ? String(connection.timeoutMs) : "";
  const dirty =
    name !== connection.name ||
    baseUrl !== connection.baseUrl ||
    protocol !== connection.protocol ||
    timeout !== savedTimeout ||
    apiKey !== "";
  const status = models?.status ?? "idle";
  const testLabel =
    testing || status === "loading"
      ? "測試中…"
      : status === "loaded"
        ? `測試連線（${models?.models.length ?? 0} 個模型）`
        : "測試連線";
  return (
    <div className="model-library-row model-library-connection-row">
      <div className="model-library-row-fields">
        <input
          aria-label="連線名稱"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setFieldErrors((current) => ({ ...current, name: undefined }));
          }}
        />
        <select
          aria-label="協定"
          value={protocol}
          onChange={(event) => setProtocol(event.target.value as ConnectionProtocol)}
        >
          {PROTOCOLS.map((item) => (
            <option key={item} value={item}>
              {PROTOCOL_LABEL[item]}
            </option>
          ))}
        </select>
        <input
          aria-label="Base URL"
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setFieldErrors((current) => ({ ...current, baseUrl: undefined }));
          }}
        />
        <input
          aria-label="API Key（留空沿用）"
          placeholder="••••••••（留空沿用）"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <label className="model-library-inline-field">
          <span>逾時 ms</span>
          <input
            aria-label="連線逾時"
            inputMode="numeric"
            placeholder="留空沿用系統"
            value={timeout}
            onChange={(event) => {
              setTimeoutMs(event.target.value);
              setFieldErrors((current) => ({ ...current, timeout: undefined }));
            }}
          />
        </label>
      </div>
      {/*
        這一列是 `flex-direction: column`（`.model-library-connection-row`），所以錯誤字接在
        欄位那一排底下就已經自己獨佔一列，不需要 `.model-library-combo-field` 那種包裝。
      */}
      {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
      {fieldErrors.baseUrl && <FieldError>{fieldErrors.baseUrl}</FieldError>}
      {fieldErrors.timeout && <FieldError>{fieldErrors.timeout}</FieldError>}
      <div className="model-library-row-actions">
        <button
          disabled={busy || !dirty}
          onClick={() => {
            const errors = connectionFieldErrors(name, baseUrl, timeout);
            setFieldErrors(errors);
            if (errors.name || errors.baseUrl || errors.timeout) return;
            void act("save", "儲存連線", async () => {
              const result = await api.updateConnection(connection.id, {
                name,
                baseUrl,
                protocol,
                timeoutMs: timeout.trim() ? Number(timeout) : null,
                ...(apiKey ? { apiKey } : {}),
              });
              setApiKey("");
              // 存檔後重新載入模型清單（base URL／key 可能已變）。
              void onTestConnection(connection.id);
              return result;
            });
          }}
        >
          {pending === "save" ? "儲存中…" : "儲存"}
        </button>
        <button
          disabled={busy || testing || status === "loading"}
          onClick={async () => {
            setTesting(true);
            try {
              await onTestConnection(connection.id);
            } finally {
              setTesting(false);
            }
          }}
        >
          {testLabel}
        </button>
        {/*
          刪一整條連線原本一鍵、無確認、無 undo，而後果是**延遲的**：引用它的模型 entry
          立刻變成懸空 ref，要到下一次生成或抽字才炸成難懂的 HTTP 404／500，那時已經沒有
          人會把它連回這一次點擊。刪一張投影片都要 confirm，這裡的輕重原本是反的。
        */}
        <button
          className="danger"
          disabled={busy}
          onClick={() => {
            const impact = dependents.length
              ? `目前有 ${dependents.length} 個模型正在使用它（${dependents.map((entry) => entry.name).join("、")}）。刪除後這些模型會指向一條不存在的連線，且不會有任何錯誤提示——要到下一次生成或抽字時才會失敗。\n\n`
              : "";
            if (confirm(`刪除連線「${connection.name}」？\n\n${impact}這個動作無法復原。`))
              void act("delete", "刪除連線", () => api.deleteConnection(connection.id));
          }}
        >
          {pending === "delete" ? "刪除中…" : "刪除"}
        </button>
      </div>
      {rowError && <FieldError>{rowError}</FieldError>}
      {status === "error" && (
        <p className="model-library-conn-status error">{models?.error ?? "測試連線失敗"}</p>
      )}
      {status === "loaded" && (
        <p className="model-library-conn-status">
          {models && models.models.length > 0
            ? `可用模型：${models.models.length} 個，已更新模型下拉選單。`
            : "端點未回報任何模型（下拉選單將可手動輸入）。"}
        </p>
      )}
    </div>
  );
}

function ModelsSection({
  library,
  busy,
  run,
  connectionModels,
  onEnsureModels,
  imageOptionSets,
}: {
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
  connectionModels: Record<string, ConnectionModels>;
  onEnsureModels: (connectionId: string) => Promise<void>;
  imageOptionSets: Record<string, ImageOptionSetView>;
}) {
  const [name, setName] = useState("");
  const [capability, setCapability] = useState<ModelCapability>("text");
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai");
  const [model, setModel] = useState("");
  const [connectionRef, setConnectionRef] = useState("");
  const [imageApi, setImageApi] = useState<OpenAiImageApi | "">("");
  const connections = connectionsFor(library, providerKind);
  const availableModels =
    needsConnection(providerKind) && connectionRef
      ? (connectionModels[connectionRef]?.models ?? [])
      : [];
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string | undefined;
    model?: string | undefined;
    connectionRef?: string | undefined;
  }>({});
  const { pending, rowError, act } = useRowAction(
    run,
    [name, capability, providerKind, model, connectionRef, imageApi].join(" "),
  );
  /**
   * 送出前擋掉會變成「懸空 entry」的組合，訊息顯示在缺漏的那個欄位旁邊。
   *
   * 舊版只檢查 `!name.trim()`：模型 id 可留空、`openai`／`gemini` 這兩種必須有連線的 kind
   * 也可以不選連線。建出來的 entry 在列表上看起來一切正常，直到某天生成或抽字時才變成
   * 難懂的 404／500——這正是把設定錯誤延遲到最遠處才爆的那一類。
   *
   * 只對 `needsConnection` 的兩種 kind 要求模型 id：codex 留空是**刻意**的（沿用 Codex CLI
   * 自身設定），mock／local 也不打 HTTP 端點。
   */
  const validate = () => {
    const next: {
      name?: string | undefined;
      model?: string | undefined;
      connectionRef?: string | undefined;
    } = {};
    if (!name.trim()) next.name = "請輸入名稱，組合的下拉選單裡就是靠它指認這個模型。";
    if (needsConnection(providerKind)) {
      if (!model.trim())
        next.model = "請填入端點上的模型 id；留空的 entry 只會在生成時以 HTTP 404 失敗。";
      if (!connectionRef)
        next.connectionRef = `${KIND_LABEL[providerKind]}模型一定要指定連線，否則不會有任何端點可打。`;
    }
    setFieldErrors(next);
    return !next.name && !next.model && !next.connectionRef;
  };
  const create = async () => {
    if (!validate()) return;
    const ok = await act("create", "新增模型", () =>
      api.createModel({
        name: name.trim(),
        capability,
        providerKind,
        model: model.trim(),
        ...(needsConnection(providerKind) && connectionRef ? { connectionRef } : {}),
        ...(providerKind === "openai" && capability === "image" && imageApi ? { imageApi } : {}),
      }),
    );
    if (!ok) return; // 保留已填欄位讓使用者直接重試
    setName("");
    setModel("");
    setImageApi("");
    setFieldErrors({});
  };
  return (
    <section className="dashboard-section model-library-section">
      <SectionHeading icon="models" label="MODELS" title="模型" />
      <p className="model-library-hint">
        每個模型服務單一能力（影像／文字／搜尋）。OpenAI 相容與 Gemini 原生模型需選擇同協定的連線。
        影像模型建好之後，該列會依它實際支援的項目顯示可調的影像參數。
      </p>
      <div className="model-library-groups">
        {CAPABILITIES.map((cap) => {
          const rows = modelsByCapability(library, cap);
          return (
            <div key={cap} className={`model-library-group cap-${cap}`}>
              <div className="model-library-group-head">
                <span className={`model-library-tag cap-${cap}`}>{CAPABILITY_LABEL[cap]}</span>
                <span className="model-library-group-count">{rows.length}</span>
              </div>
              <div className="model-library-list">
                {rows.length === 0 ? (
                  <p className="model-library-empty">尚無{CAPABILITY_LABEL[cap]}模型。</p>
                ) : (
                  rows.map((entry) => (
                    <ModelRow
                      key={entry.id}
                      entry={entry}
                      library={library}
                      busy={busy}
                      run={run}
                      connectionModels={connectionModels}
                      onEnsureModels={onEnsureModels}
                      optionSet={imageOptionSets[entry.id]}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="model-library-create">
        <div className="model-library-combo-field">
          <input
            aria-label="模型名稱"
            placeholder="名稱"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFieldErrors((current) => ({ ...current, name: undefined }));
            }}
          />
          {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
        </div>
        <select
          aria-label="能力"
          value={capability}
          onChange={(event) => setCapability(event.target.value as ModelCapability)}
        >
          {CAPABILITIES.map((item) => (
            <option key={item} value={item}>
              {CAPABILITY_LABEL[item]}
            </option>
          ))}
        </select>
        <select
          aria-label="Provider 種類"
          value={providerKind}
          onChange={(event) => {
            // 換 kind 會換掉可選連線集合（協定不同），沿用舊選擇會留下跨協定的懸空 ref。
            setProviderKind(event.target.value as ProviderKind);
            setConnectionRef("");
            // 必填條件跟著 kind 走（codex 不需要連線與 model id），舊的錯誤字留著會變成假警報。
            setFieldErrors({});
          }}
        >
          {KINDS.map((item) => (
            <option key={item} value={item}>
              {KIND_LABEL[item]}
            </option>
          ))}
        </select>
        <div className="model-library-combo-field">
          <select
            aria-label="連線"
            value={connectionRef}
            disabled={!needsConnection(providerKind)}
            onChange={(event) => {
              const next = event.target.value;
              setConnectionRef(next);
              setFieldErrors((current) => ({ ...current, connectionRef: undefined }));
              if (next && connectionModels[next]?.status === undefined) void onEnsureModels(next);
            }}
          >
            <option value="">（無連線）</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
          {fieldErrors.connectionRef && <FieldError>{fieldErrors.connectionRef}</FieldError>}
        </div>
        <div className="model-library-combo-field">
          {availableModels.length > 0 ? (
            <select
              aria-label="模型名"
              value={availableModels.includes(model) ? model : ""}
              onChange={(event) => {
                const next = event.target.value;
                // 選模型時把名稱一併帶入；只在名稱空白或仍等於上一次選的 model 時覆寫，
                // 不蓋掉使用者手打的名稱。
                if (next && (!name.trim() || name === model)) setName(next);
                setModel(next);
                setFieldErrors((current) => ({ ...current, model: undefined, name: undefined }));
              }}
            >
              <option value="">選擇模型…</option>
              {availableModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="模型名"
              placeholder={
                providerKind === "gemini"
                  ? "model（如 gemini-3.1-flash-image）"
                  : "model（如 gpt-image-2）"
              }
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setFieldErrors((current) => ({ ...current, model: undefined }));
              }}
            />
          )}
          {fieldErrors.model && <FieldError>{fieldErrors.model}</FieldError>}
        </div>
        {providerKind === "openai" && capability === "image" && (
          <select
            aria-label="影像 API"
            value={imageApi}
            onChange={(event) => setImageApi(event.target.value as OpenAiImageApi | "")}
          >
            <option value="">影像 API（預設 images）</option>
            {OPENAI_IMAGE_APIS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        )}
        {/* 同「新增連線」：不靠 disabled 擋，按下去之後在缺漏的欄位旁邊講清楚缺什麼。 */}
        <button className="primary" disabled={busy} onClick={create}>
          {pending === "create" ? "新增中…" : "新增模型"}
        </button>
      </div>
      {rowError && <FieldError>{rowError}</FieldError>}
    </section>
  );
}

function ModelRow({
  entry,
  library,
  busy,
  run,
  connectionModels,
  onEnsureModels,
  optionSet,
}: {
  entry: ModelEntry;
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
  connectionModels: Record<string, ConnectionModels>;
  onEnsureModels: (connectionId: string) => Promise<void>;
  /** 這個模型可調什麼；由伺服器依 provider 的宣告給出，沒有就代表沒有已知的可調項。 */
  optionSet: ImageOptionSetView | undefined;
}) {
  const [name, setName] = useState(entry.name);
  const [model, setModel] = useState(entry.model);
  const [connectionRef, setConnectionRef] = useState(entry.connectionRef ?? "");
  const [imageApi, setImageApi] = useState<OpenAiImageApi | "">(entry.imageApi ?? "");
  const imageProfile = useImageProfileForm(entry.imageProfile);
  const showImageProfile = supportsImageProfile(entry.capability, entry.providerKind);
  const { pending, rowError, act } = useRowAction(
    run,
    [name, model, connectionRef, imageApi, imageProfile.key].join(" "),
  );
  // 刪掉模型會讓引用它的組合欄位變成懸空 ref；確認文案要講得出是哪幾個組合。
  const usedBy = library.combinations.filter(
    (combination) =>
      combination.imageModelRef === entry.id ||
      combination.textModelRef === entry.id ||
      combination.searchModelRef === entry.id,
  );
  const dirty =
    name !== entry.name ||
    model !== entry.model ||
    connectionRef !== (entry.connectionRef ?? "") ||
    imageApi !== (entry.imageApi ?? "") ||
    (showImageProfile && imageProfile.key !== imageProfileKey(entry.imageProfile));
  const connections = connectionsFor(library, entry.providerKind);
  const availableModels =
    needsConnection(entry.providerKind) && connectionRef
      ? (connectionModels[connectionRef]?.models ?? [])
      : [];
  return (
    <div className="model-library-row">
      <span className="model-library-tag muted">{KIND_LABEL[entry.providerKind]}</span>
      <input aria-label="模型名稱" value={name} onChange={(event) => setName(event.target.value)} />
      {availableModels.length > 0 ? (
        <select
          aria-label="model"
          value={availableModels.includes(model) ? model : ""}
          onChange={(event) => setModel(event.target.value)}
        >
          <option value="">
            {model && !availableModels.includes(model) ? model : "選擇模型…"}
          </option>
          {availableModels.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label="model"
          placeholder="model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      )}
      <select
        aria-label="連線"
        value={connectionRef}
        disabled={!needsConnection(entry.providerKind)}
        onChange={(event) => {
          const next = event.target.value;
          setConnectionRef(next);
          if (next && connectionModels[next]?.status === undefined) void onEnsureModels(next);
        }}
      >
        <option value="">（無連線）</option>
        {connections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.name}
          </option>
        ))}
      </select>
      {entry.providerKind === "openai" && entry.capability === "image" && (
        <select
          aria-label="影像 API"
          value={imageApi}
          onChange={(event) => setImageApi(event.target.value as OpenAiImageApi | "")}
        >
          <option value="">影像 API（預設 images）</option>
          {OPENAI_IMAGE_APIS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      )}
      {showImageProfile && <ImageProfileFields form={imageProfile} optionSet={optionSet} />}
      <div className="model-library-row-actions">
        <button
          disabled={busy || !dirty}
          onClick={() => {
            // 欄位有誤時不送出：訊息已經顯示在出問題的那一格旁邊。
            if (showImageProfile && Object.keys(imageProfile.errors).length > 0) return;
            void act("save", "儲存模型", () =>
              api.updateModel(entry.id, {
                name,
                model,
                ...(needsConnection(entry.providerKind)
                  ? { connectionRef: connectionRef || undefined }
                  : {}),
                ...(entry.providerKind === "openai" && entry.capability === "image"
                  ? { imageApi: imageApi || undefined }
                  : {}),
                // 全部留白時送 null 明確清掉；送 undefined 的話 key 會在 JSON 裡消失，
                // PATCH 就變成「不動這個欄位」，使用者永遠清不掉已經設過的參數。
                ...(showImageProfile ? { imageProfile: imageProfile.profile ?? null } : {}),
              }),
            );
          }}
        >
          {pending === "save" ? "儲存中…" : "儲存"}
        </button>
        {/* 與刪連線同一條理由：後果延遲到下一次生成／抽字才出現，當下毫無提示。 */}
        <button
          className="danger"
          disabled={busy}
          onClick={() => {
            const impact = usedBy.length
              ? `目前有 ${usedBy.length} 個組合正在使用它（${usedBy.map((combination) => combination.name).join("、")}）。刪除後那些組合的對應欄位會變成空的，綁著它們的專案要到下一次生成或抽字時才會失敗。\n\n`
              : "";
            if (confirm(`刪除模型「${entry.name}」？\n\n${impact}這個動作無法復原。`))
              void act("delete", "刪除模型", () => api.deleteModel(entry.id));
          }}
        >
          {pending === "delete" ? "刪除中…" : "刪除"}
        </button>
      </div>
      {rowError && <FieldError>{rowError}</FieldError>}
    </div>
  );
}

function CombinationsSection({
  library,
  busy,
  run,
}: {
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
}) {
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const { pending, rowError, act } = useRowAction(run, name);
  const create = async () => {
    if (!name.trim()) {
      setNameError("請輸入名稱，專案的模型設定裡就是靠它挑選組合。");
      return;
    }
    const ok = await act("create", "新增組合", () => api.createCombination({ name: name.trim() }));
    if (!ok) return;
    setName("");
    setNameError(undefined);
  };
  return (
    <section className="dashboard-section model-library-section">
      <SectionHeading icon="combinations" label="COMBINATIONS" title="組合" />
      <p className="model-library-hint">
        一次挑三個模型（影像／文字／搜尋）組成具名組合，供專案綁定。標為預設者是未綁定專案的回退。
      </p>
      <div className="model-library-list">
        {library.combinations.length === 0 && <p className="model-library-empty">尚無組合。</p>}
        {library.combinations.map((combination) => (
          <CombinationRow
            key={combination.id}
            combination={combination}
            library={library}
            busy={busy}
            run={run}
          />
        ))}
      </div>
      <div className="model-library-create">
        <div className="model-library-combo-field">
          <input
            aria-label="組合名稱"
            placeholder="名稱"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
            }}
          />
          {nameError && <FieldError>{nameError}</FieldError>}
        </div>
        <button className="primary" disabled={busy} onClick={create}>
          {pending === "create" ? "新增中…" : "新增組合"}
        </button>
      </div>
      {rowError && <FieldError>{rowError}</FieldError>}
    </section>
  );
}

function CombinationRow({
  combination,
  library,
  busy,
  run,
}: {
  combination: ModelCombination;
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
}) {
  const [name, setName] = useState(combination.name);
  const [imageRef, setImageRef] = useState(combination.imageModelRef ?? "");
  const [textRef, setTextRef] = useState(combination.textModelRef ?? "");
  const [searchRef, setSearchRef] = useState(combination.searchModelRef ?? "");
  const { pending, rowError, act } = useRowAction(
    run,
    [name, imageRef, textRef, searchRef].join(" "),
  );
  const isDefault = library.defaultCombinationId === combination.id;
  const dirty =
    name !== combination.name ||
    imageRef !== (combination.imageModelRef ?? "") ||
    textRef !== (combination.textModelRef ?? "") ||
    searchRef !== (combination.searchModelRef ?? "");
  const capabilitySelect = (
    capability: ModelCapability,
    value: string,
    onChange: (value: string) => void,
  ) => (
    <label className="model-library-combo-field">
      {CAPABILITY_LABEL[capability]}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">（未設定）</option>
        {modelsByCapability(library, capability)
          // local kind（如 local-inpaint）是 fullSlideGeneration:false 的遮罩去字工具，
          // 綁進組合的影像模型必然在生成時失敗，故不列入組合下拉（server 端同步硬擋）。
          .filter((entry) => entry.providerKind !== "local")
          .map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <div className="model-library-combo">
      <div className="model-library-combo-head">
        <input
          aria-label="組合名稱"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {isDefault ? (
          <span className="model-library-tag">預設</span>
        ) : (
          <button
            disabled={busy}
            onClick={() =>
              void act("default", "設定預設組合", () => api.setDefaultCombination(combination.id))
            }
          >
            {pending === "default" ? "設定中…" : "設為預設"}
          </button>
        )}
      </div>
      <div className="model-library-combo-fields">
        {capabilitySelect("image", imageRef, setImageRef)}
        {capabilitySelect("text", textRef, setTextRef)}
        {capabilitySelect("search", searchRef, setSearchRef)}
      </div>
      <div className="model-library-row-actions">
        <button
          disabled={busy || !dirty}
          onClick={() =>
            void act("save", "儲存組合", () =>
              api.updateCombination(combination.id, {
                name,
                imageModelRef: imageRef || undefined,
                textModelRef: textRef || undefined,
                searchModelRef: searchRef || undefined,
              }),
            )
          }
        >
          {pending === "save" ? "儲存中…" : "儲存"}
        </button>
        {/*
          綁著這個組合的專案在哪裡，前端手上這份 payload 看不到，所以講不出數字——那就
          明講後果的**時機**：現在什麼都不會發生，要到下一次生成或抽字才失敗。
        */}
        <button
          className="danger"
          disabled={busy || isDefault}
          title={isDefault ? "預設組合不可刪除，請先改設其他預設" : undefined}
          onClick={() => {
            if (
              confirm(
                `刪除組合「${combination.name}」？\n\n綁定這個組合的專案不會立刻報錯，要到下一次生成或抽字時才會失敗（屆時要回到專案設定改綁別的組合）。\n\n這個動作無法復原。`,
              )
            )
              void act("delete", "刪除組合", () => api.deleteCombination(combination.id));
          }}
        >
          {pending === "delete" ? "刪除中…" : "刪除"}
        </button>
      </div>
      {rowError && <FieldError>{rowError}</FieldError>}
    </div>
  );
}

function SystemSection({
  library,
  busy,
  run,
}: {
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
}) {
  const [timeout, setTimeout] = useState(String(library.system.modelTimeoutMs ?? ""));
  const [concurrency, setConcurrency] = useState(String(library.system.imageConcurrency ?? ""));
  const [fieldErrors, setFieldErrors] = useState<{
    timeout?: string | undefined;
    concurrency?: string | undefined;
  }>({});
  const { pending, rowError, act } = useRowAction(run, [timeout, concurrency].join("\u0000"));
  /**
   * 兩個欄位都是 `inputMode="numeric"`（只是鍵盤提示，不擋任何輸入），舊版沒有任何前端
   * 驗證：打進 `abc` → `Number("abc")` 是 `NaN` → 照樣送出。留空是合法的（代表沿用伺服器
   * 預設），所以只在非空時檢查，而且要求整數：小數與 0 對逾時毫秒與併發上限都沒有意義。
   */
  const positiveInteger = (raw: string, label: string): string | undefined =>
    !raw.trim() || /^\d+$/.test(raw.trim())
      ? raw.trim() && Number(raw) <= 0
        ? `${label}需大於 0；留空則沿用伺服器預設。`
        : undefined
      : `${label}只接受數字（正整數）；留空則沿用伺服器預設。`;
  const save = async () => {
    const next: { timeout?: string | undefined; concurrency?: string | undefined } = {
      timeout: positiveInteger(timeout, "模型逾時"),
      concurrency: positiveInteger(concurrency, "影像並行數"),
    };
    // 上界與 jobs.ts 的 providerLimit() 對齊：那裡對超出範圍是丟例外，整批生成會在排程時就死。
    if (!next.concurrency && concurrency.trim() && Number(concurrency) > 32)
      next.concurrency = "影像並行數最多 32；再高只會撞上端點限流，整批一起失敗。";
    setFieldErrors(next);
    if (next.timeout || next.concurrency) return;
    await act("save", "儲存系統設定", () =>
      api.updateModelLibrarySystem({
        ...(timeout.trim() ? { modelTimeoutMs: Number(timeout) } : {}),
        ...(concurrency.trim() ? { imageConcurrency: Number(concurrency) } : {}),
      }),
    );
  };
  return (
    <section className="dashboard-section model-library-section">
      <SectionHeading icon="system" label="SYSTEM" title="系統設定" />
      <p className="model-library-hint">
        影響執行而非品質的維運旋鈕。OCR
        相關設定改動需重啟伺服器才生效。連線列若另外填了逾時、影像模型若另外填了並行數，都以那一列的為準。
      </p>
      <div className="model-library-create">
        <label className="model-library-combo-field">
          模型逾時 (ms)
          <input
            aria-label="模型逾時"
            inputMode="numeric"
            value={timeout}
            onChange={(event) => {
              setTimeout(event.target.value);
              setFieldErrors((current) => ({ ...current, timeout: undefined }));
            }}
          />
          {fieldErrors.timeout && <FieldError>{fieldErrors.timeout}</FieldError>}
        </label>
        <label className="model-library-combo-field">
          影像並行數
          <input
            aria-label="影像並行數"
            inputMode="numeric"
            placeholder="留空為 2"
            value={concurrency}
            onChange={(event) => {
              setConcurrency(event.target.value);
              setFieldErrors((current) => ({ ...current, concurrency: undefined }));
            }}
          />
          {fieldErrors.concurrency && <FieldError>{fieldErrors.concurrency}</FieldError>}
        </label>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {pending === "save" ? "儲存中…" : "儲存系統設定"}
        </button>
      </div>
      {rowError && <FieldError>{rowError}</FieldError>}
    </section>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import type {
  CodexReasoningEffort,
  ConnectionProtocol,
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
  codex: "Codex",
  openai: "OpenAI 相容",
  gemini: "Gemini 原生",
};
const PROTOCOL_LABEL: Record<ConnectionProtocol, string> = {
  openai: "OpenAI 相容",
  gemini: "Gemini 原生",
};
const CAPABILITIES: ModelCapability[] = ["image", "text", "search"];
const KINDS: ProviderKind[] = ["mock", "codex", "openai", "gemini"];
const PROTOCOLS: ConnectionProtocol[] = ["openai", "gemini"];
const REASONING_EFFORTS: CodexReasoningEffort[] = ["minimal", "low", "medium", "high"];
const OPENAI_IMAGE_APIS: OpenAiImageApi[] = ["images", "chat", "openrouter-image"];

/** 需要連線的 provider kind（HTTP 端點兩家）；mock／codex 在本機跑，沒有連線概念。 */
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

export function ModelLibrary({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [library, setLibrary] = useState<ModelLibraryData>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 連線 → 可用模型 id 清單快取（GET /models）。連線建立或選取時載入。
  const [connectionModels, setConnectionModels] = useState<Record<string, ConnectionModels>>({});

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

  useEffect(() => {
    void api
      .modelLibrary()
      .then((value) => {
        setLibrary(value);
        // 建立完連線後即抓一次各連線的可用模型，讓下拉選單可用。
        for (const connection of value.connections) void loadConnectionModels(connection.id);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "載入模型庫失敗"),
      );
  }, []);

  const run = async (task: () => Promise<ModelLibraryData>) => {
    setBusy(true);
    setError(undefined);
    try {
      setLibrary(await task());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失敗");
    } finally {
      setBusy(false);
    }
  };

  if (!library)
    return (
      <main className="welcome dashboard library-mode">
        <LibraryHeader active="models" onNavigate={onNavigate} />
        <div className="dashboard-content">
          {error ? <div className="toast error">{error}</div> : <p>載入中…</p>}
        </div>
      </main>
    );

  return (
    <main className="welcome dashboard library-mode model-library">
      <LibraryHeader active="models" onNavigate={onNavigate} />
      {error && (
        <button className="toast error" onClick={() => setError(undefined)}>
          {error} ×
        </button>
      )}
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
        />
        <CombinationsSection library={library} busy={busy} run={run} />
        <SystemSection library={library} busy={busy} run={run} />
      </div>
    </main>
  );
}

type RunFn = (task: () => Promise<ModelLibraryData>) => Promise<void>;

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
  const [protocol, setProtocol] = useState<ConnectionProtocol>("openai");
  const create = async () => {
    if (!name.trim()) return;
    const before = new Set(library.connections.map((connection) => connection.id));
    await run(async () => {
      const next = await api.createConnection({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey,
        protocol,
      });
      // 建立完連線立刻打 /models，讓模型 entry 能用下拉選單挑模型。
      const created = next.connections.find((connection) => !before.has(connection.id));
      if (created) void onConnectionSaved(created.id);
      return next;
    });
    setName("");
    setBaseUrl("");
    setApiKey("");
    setProtocol("openai");
  };
  return (
    <section className="dashboard-section model-library-section">
      <SectionHeading icon="connections" label="CONNECTIONS" title="連線（HTTP 模型端點）" />
      <p className="model-library-hint">
        供 OpenAI 相容／Gemini 原生模型引用的 base URL 與 API key。協定決定請求形狀，選錯了
        連線測試就會失敗。金鑰只寫不讀，顯示為佔位符。
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
          />
        ))}
      </div>
      <div className="model-library-create">
        <input
          aria-label="連線名稱"
          placeholder="名稱"
          value={name}
          onChange={(event) => setName(event.target.value)}
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
          placeholder={
            protocol === "gemini"
              ? "https://generativelanguage.googleapis.com/v1beta"
              : "http://localhost:8317/v1"
          }
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <input
          aria-label="API Key"
          placeholder="API key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()} onClick={create}>
          新增連線
        </button>
      </div>
    </section>
  );
}

function ConnectionRow({
  connection,
  busy,
  run,
  models,
  onTestConnection,
}: {
  connection: ModelConnection;
  busy: boolean;
  run: RunFn;
  models: ConnectionModels | undefined;
  onTestConnection: (connectionId: string) => Promise<void>;
}) {
  const [name, setName] = useState(connection.name);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<ConnectionProtocol>(connection.protocol);
  const [testing, setTesting] = useState(false);
  const dirty =
    name !== connection.name ||
    baseUrl !== connection.baseUrl ||
    protocol !== connection.protocol ||
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
          onChange={(event) => setName(event.target.value)}
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
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <input
          aria-label="API Key（留空沿用）"
          placeholder="••••••••（留空沿用）"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>
      <div className="model-library-row-actions">
        <button
          disabled={busy || !dirty}
          onClick={() =>
            run(async () => {
              const result = await api.updateConnection(connection.id, {
                name,
                baseUrl,
                protocol,
                ...(apiKey ? { apiKey } : {}),
              });
              setApiKey("");
              // 存檔後重新載入模型清單（base URL／key 可能已變）。
              void onTestConnection(connection.id);
              return result;
            })
          }
        >
          儲存
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
        <button
          className="danger"
          disabled={busy}
          onClick={() => run(() => api.deleteConnection(connection.id))}
        >
          刪除
        </button>
      </div>
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
}: {
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
  connectionModels: Record<string, ConnectionModels>;
  onEnsureModels: (connectionId: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [capability, setCapability] = useState<ModelCapability>("text");
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai");
  const [model, setModel] = useState("");
  const [connectionRef, setConnectionRef] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort | "">("");
  const [imageApi, setImageApi] = useState<OpenAiImageApi | "">("");
  const connections = connectionsFor(library, providerKind);
  const availableModels =
    needsConnection(providerKind) && connectionRef
      ? (connectionModels[connectionRef]?.models ?? [])
      : [];
  const create = async () => {
    if (!name.trim()) return;
    await run(() =>
      api.createModel({
        name: name.trim(),
        capability,
        providerKind,
        model: model.trim(),
        ...(needsConnection(providerKind) && connectionRef ? { connectionRef } : {}),
        ...(providerKind === "codex" && reasoningEffort ? { reasoningEffort } : {}),
        ...(providerKind === "openai" && capability === "image" && imageApi ? { imageApi } : {}),
      }),
    );
    setName("");
    setModel("");
    setReasoningEffort("");
    setImageApi("");
  };
  return (
    <section className="dashboard-section model-library-section">
      <SectionHeading icon="models" label="MODELS" title="模型" />
      <p className="model-library-hint">
        每個模型服務單一能力（影像／文字／搜尋）。OpenAI 相容與 Gemini 原生模型需選擇同協定的連線。
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
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="model-library-create">
        <input
          aria-label="模型名稱"
          placeholder="名稱"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
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
          }}
        >
          {KINDS.map((item) => (
            <option key={item} value={item}>
              {KIND_LABEL[item]}
            </option>
          ))}
        </select>
        <select
          aria-label="連線"
          value={connectionRef}
          disabled={!needsConnection(providerKind)}
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
              providerKind === "codex"
                ? "model（留空用 Codex 預設）"
                : providerKind === "gemini"
                  ? "model（如 gemini-3.1-flash-image）"
                  : "model（如 gpt-image-2）"
            }
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        )}
        {providerKind === "codex" && (
          <select
            aria-label="推理強度"
            value={reasoningEffort}
            onChange={(event) =>
              setReasoningEffort(event.target.value as CodexReasoningEffort | "")
            }
          >
            <option value="">推理強度（預設）</option>
            {REASONING_EFFORTS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        )}
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
        <button className="primary" disabled={busy || !name.trim()} onClick={create}>
          新增模型
        </button>
      </div>
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
}: {
  entry: ModelEntry;
  library: ModelLibraryData;
  busy: boolean;
  run: RunFn;
  connectionModels: Record<string, ConnectionModels>;
  onEnsureModels: (connectionId: string) => Promise<void>;
}) {
  const [name, setName] = useState(entry.name);
  const [model, setModel] = useState(entry.model);
  const [connectionRef, setConnectionRef] = useState(entry.connectionRef ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort | "">(
    entry.reasoningEffort ?? "",
  );
  const [imageApi, setImageApi] = useState<OpenAiImageApi | "">(entry.imageApi ?? "");
  const dirty =
    name !== entry.name ||
    model !== entry.model ||
    connectionRef !== (entry.connectionRef ?? "") ||
    reasoningEffort !== (entry.reasoningEffort ?? "") ||
    imageApi !== (entry.imageApi ?? "");
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
      {entry.providerKind === "codex" && (
        <select
          aria-label="推理強度"
          value={reasoningEffort}
          onChange={(event) => setReasoningEffort(event.target.value as CodexReasoningEffort | "")}
        >
          <option value="">推理強度（預設）</option>
          {REASONING_EFFORTS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      )}
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
      <div className="model-library-row-actions">
        <button
          disabled={busy || !dirty}
          onClick={() =>
            run(() =>
              api.updateModel(entry.id, {
                name,
                model,
                ...(needsConnection(entry.providerKind)
                  ? { connectionRef: connectionRef || undefined }
                  : {}),
                ...(entry.providerKind === "codex"
                  ? { reasoningEffort: reasoningEffort || undefined }
                  : {}),
                ...(entry.providerKind === "openai" && entry.capability === "image"
                  ? { imageApi: imageApi || undefined }
                  : {}),
              }),
            )
          }
        >
          儲存
        </button>
        <button
          className="danger"
          disabled={busy}
          onClick={() => run(() => api.deleteModel(entry.id))}
        >
          刪除
        </button>
      </div>
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
  const create = async () => {
    if (!name.trim()) return;
    await run(() => api.createCombination({ name: name.trim() }));
    setName("");
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
        <input
          aria-label="組合名稱"
          placeholder="名稱"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()} onClick={create}>
          新增組合
        </button>
      </div>
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
        {modelsByCapability(library, capability).map((entry) => (
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
            onClick={() => run(() => api.setDefaultCombination(combination.id))}
          >
            設為預設
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
            run(() =>
              api.updateCombination(combination.id, {
                name,
                imageModelRef: imageRef || undefined,
                textModelRef: textRef || undefined,
                searchModelRef: searchRef || undefined,
              }),
            )
          }
        >
          儲存
        </button>
        <button
          className="danger"
          disabled={busy || isDefault}
          title={isDefault ? "預設組合不可刪除，請先改設其他預設" : undefined}
          onClick={() => run(() => api.deleteCombination(combination.id))}
        >
          刪除
        </button>
      </div>
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
  const [timeout, setTimeout] = useState(String(library.system.codexTimeoutMs ?? ""));
  const [concurrency, setConcurrency] = useState(String(library.system.codexMaxConcurrency ?? ""));
  const save = () =>
    run(() =>
      api.updateModelLibrarySystem({
        ...(timeout.trim() ? { codexTimeoutMs: Number(timeout) } : {}),
        ...(concurrency.trim() ? { codexMaxConcurrency: Number(concurrency) } : {}),
      }),
    );
  return (
    <section className="dashboard-section model-library-section">
      <SectionHeading icon="system" label="SYSTEM" title="系統設定" />
      <p className="model-library-hint">
        影響執行而非品質的維運旋鈕。OCR 相關設定改動需重啟伺服器才生效。
      </p>
      <div className="model-library-create">
        <label className="model-library-combo-field">
          Codex Timeout (ms)
          <input
            aria-label="Codex Timeout"
            inputMode="numeric"
            value={timeout}
            onChange={(event) => setTimeout(event.target.value)}
          />
        </label>
        <label className="model-library-combo-field">
          Codex 最大併發
          <input
            aria-label="Codex 最大併發"
            inputMode="numeric"
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
          />
        </label>
        <button className="primary" disabled={busy} onClick={save}>
          儲存系統設定
        </button>
      </div>
    </section>
  );
}

import { useEffect, useState } from "react";
import type {
  CodexReasoningEffort,
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
};
const CAPABILITIES: ModelCapability[] = ["image", "text", "search"];
const KINDS: ProviderKind[] = ["mock", "codex", "openai"];
const REASONING_EFFORTS: CodexReasoningEffort[] = ["minimal", "low", "medium", "high"];
const OPENAI_IMAGE_APIS: OpenAiImageApi[] = ["images", "chat", "openrouter-image"];

function modelsByCapability(library: ModelLibraryData, capability: ModelCapability): ModelEntry[] {
  return library.models.filter((entry) => entry.capability === capability);
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
  const create = async () => {
    if (!name.trim()) return;
    const before = new Set(library.connections.map((connection) => connection.id));
    await run(async () => {
      const next = await api.createConnection({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey,
      });
      // 建立完連線立刻打 /models，讓模型 entry 能用下拉選單挑模型。
      const created = next.connections.find((connection) => !before.has(connection.id));
      if (created) void onConnectionSaved(created.id);
      return next;
    });
    setName("");
    setBaseUrl("");
    setApiKey("");
  };
  return (
    <section className="dashboard-section model-library-section">
      <div className="dashboard-section-heading">
        <div>
          <span className="section-label">CONNECTIONS</span>
          <h2>連線（OpenAI 相容端點）</h2>
        </div>
      </div>
      <p className="model-library-hint">
        供 OpenAI 相容模型引用的 base URL 與 API key。金鑰只寫不讀，顯示為佔位符。
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
        <input
          aria-label="Base URL"
          placeholder="http://localhost:8317/v1"
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
  const [testing, setTesting] = useState(false);
  const dirty = name !== connection.name || baseUrl !== connection.baseUrl || apiKey !== "";
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
  const availableModels =
    providerKind === "openai" && connectionRef
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
        ...(providerKind === "openai" && connectionRef ? { connectionRef } : {}),
        ...(providerKind === "codex" && reasoningEffort ? { reasoningEffort } : {}),
        ...(providerKind === "openai" && capability === "image" && imageApi
          ? { imageApi }
          : {}),
      }),
    );
    setName("");
    setModel("");
    setReasoningEffort("");
    setImageApi("");
  };
  return (
    <section className="dashboard-section model-library-section">
      <div className="dashboard-section-heading">
        <div>
          <span className="section-label">MODELS</span>
          <h2>模型</h2>
        </div>
      </div>
      <p className="model-library-hint">
        每個模型服務單一能力（影像／文字／搜尋）。OpenAI 相容模型需選擇連線。
      </p>
      <div className="model-library-list">
        {library.models.map((entry) => (
          <ModelRow
            key={entry.id}
            entry={entry}
            library={library}
            busy={busy}
            run={run}
            connectionModels={connectionModels}
            onEnsureModels={onEnsureModels}
          />
        ))}
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
          onChange={(event) => setProviderKind(event.target.value as ProviderKind)}
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
          disabled={providerKind !== "openai"}
          onChange={(event) => {
            const next = event.target.value;
            setConnectionRef(next);
            if (next && connectionModels[next]?.status === undefined) void onEnsureModels(next);
          }}
        >
          <option value="">（無連線）</option>
          {library.connections.map((connection) => (
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
            placeholder={providerKind === "codex" ? "model（留空用 Codex 預設）" : "model（如 gpt-image-2）"}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        )}
        {providerKind === "codex" && (
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
  const availableModels =
    entry.providerKind === "openai" && connectionRef
      ? (connectionModels[connectionRef]?.models ?? [])
      : [];
  return (
    <div className="model-library-row">
      <span className="model-library-tag">{CAPABILITY_LABEL[entry.capability]}</span>
      <span className="model-library-tag muted">{KIND_LABEL[entry.providerKind]}</span>
      <input aria-label="模型名稱" value={name} onChange={(event) => setName(event.target.value)} />
      {availableModels.length > 0 ? (
        <select
          aria-label="model"
          value={availableModels.includes(model) ? model : ""}
          onChange={(event) => setModel(event.target.value)}
        >
          <option value="">{model && !availableModels.includes(model) ? model : "選擇模型…"}</option>
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
        disabled={entry.providerKind !== "openai"}
        onChange={(event) => {
          const next = event.target.value;
          setConnectionRef(next);
          if (next && connectionModels[next]?.status === undefined) void onEnsureModels(next);
        }}
      >
        <option value="">（無連線）</option>
        {library.connections.map((connection) => (
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
                ...(entry.providerKind === "openai"
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
      <div className="dashboard-section-heading">
        <div>
          <span className="section-label">COMBINATIONS</span>
          <h2>組合</h2>
        </div>
      </div>
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
      <div className="dashboard-section-heading">
        <div>
          <span className="section-label">SYSTEM</span>
          <h2>系統設定</h2>
        </div>
      </div>
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

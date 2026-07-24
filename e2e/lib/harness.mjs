// 測試骨架：起/關 in-process server、隔離 dataRoot、artifacts 目錄、模型庫 seed，
// 以及 L0 的「零外部 HTTP」guard。
//
// 隔離原則：每次跑一個獨立的 SLIDE_MAKER_DATA_ROOT（`<repo>/.e2e-data/<runId>`），
// 絕不碰 `.slide-maker-data`／`.data`。artifacts 寫到 `<repo>/artifacts/e2e/<runId>/`。
import { once } from "node:events";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./deps.mjs";
import { createClient } from "./client.mjs";

const SCHEMA_VERSION = 1;

/** createApp 從 server 的建置產物載入（與現有 live 腳本同慣例）。 */
async function loadCreateApp() {
  const appPath = resolve(repoRoot, "apps/server/dist/app.js");
  if (!existsSync(appPath))
    throw new Error(
      `找不到 ${appPath}。請先在 worktree 執行 \`npx pnpm@10.13.1 build\` 建置全部套件。`,
    );
  return (await import(pathToFileURL(appPath).href)).createApp;
}

/**
 * 為隔離 dataRoot 寫一份 models.json，讓 createApp 直接載入而非用 env seed。
 *
 * needsLive:false → 只有 mock-image + local-inpaint，組合 `e2e-mock`（預設）。
 *   L0 全部走這條：零連線、零外部依賴。
 * needsLive:true → 另建 OpenAI 相容連線 + gpt-image-2／gpt-5.6-luna entries，組合 `e2e-gpt`。
 *   憑證來源優先序：
 *     (1) env SLIDE_MAKER_OPENAI_BASE_URL + SLIDE_MAKER_OPENAI_API_KEY
 *     (2) 讀 SLIDE_MAKER_E2E_SOURCE_LIBRARY ?? `<repo>/.slide-maker-data/models.json`，
 *         撈 protocol==="openai" 且 baseUrl 含 "8317" 的連線，複製其 baseUrl/apiKey。
 *   兩者皆無 → throw，訊息說明怎麼設。憑證**絕不**寫進 artifacts 或印到終端。
 */
export async function seedLibrary(dataRoot, { needsLive = false } = {}) {
  const now = new Date().toISOString();
  const models = [
    {
      id: "mock-image",
      name: "Mock 影像（確定性佔位）",
      capability: "image",
      providerKind: "mock",
      model: "mock",
    },
    {
      id: "local-inpaint",
      name: "OpenCV 抹字修補（本機）",
      capability: "image",
      providerKind: "local",
      model: "opencv-inpaint-telea",
    },
  ];
  const connections = [];
  const combinations = [{ id: "e2e-mock", name: "E2E Mock", imageModelRef: "mock-image" }];
  let defaultCombinationId = "e2e-mock";

  if (needsLive) {
    const credential = await resolveLiveCredential();
    const connectionId = "e2e-openai";
    connections.push({
      id: connectionId,
      name: "E2E OpenAI 相容端點",
      baseUrl: credential.baseUrl,
      apiKey: credential.apiKey,
      protocol: "openai",
      timeoutMs: 120000,
    });
    models.push(
      {
        id: "gpt-image-2",
        name: "E2E GPT Image",
        capability: "image",
        providerKind: "openai",
        model: "gpt-image-2",
        connectionRef: connectionId,
        imageApi: "images",
      },
      {
        id: "gpt-5.6-luna-text",
        name: "E2E GPT Text",
        capability: "text",
        providerKind: "openai",
        model: "gpt-5.6-luna",
        connectionRef: connectionId,
      },
      {
        id: "gpt-5.6-luna-search",
        name: "E2E GPT Search",
        capability: "search",
        providerKind: "openai",
        model: "gpt-5.6-luna",
        connectionRef: connectionId,
      },
    );
    combinations.push({
      id: "e2e-gpt",
      name: "E2E GPT",
      imageModelRef: "gpt-image-2",
      textModelRef: "gpt-5.6-luna-text",
      searchModelRef: "gpt-5.6-luna-search",
    });
    defaultCombinationId = "e2e-gpt";
  }

  const library = {
    schemaVersion: SCHEMA_VERSION,
    connections,
    models,
    combinations,
    defaultCombinationId,
    system: {},
    updatedAt: now,
  };
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, "models.json"), `${JSON.stringify(library, null, 2)}\n`, {
    mode: 0o600,
  });
  return library;
}

async function resolveLiveCredential() {
  const envBase = process.env.SLIDE_MAKER_OPENAI_BASE_URL;
  const envKey = process.env.SLIDE_MAKER_OPENAI_API_KEY;
  if (envBase && envKey) return { baseUrl: envBase, apiKey: envKey };

  const sourcePath =
    process.env.SLIDE_MAKER_E2E_SOURCE_LIBRARY ??
    resolve(repoRoot, ".slide-maker-data/models.json");
  try {
    const library = JSON.parse(await readFile(sourcePath, "utf8"));
    const connection = (library.connections ?? []).find(
      (c) => c.protocol === "openai" && typeof c.baseUrl === "string" && c.baseUrl.includes("8317"),
    );
    if (connection?.baseUrl && connection?.apiKey)
      return { baseUrl: connection.baseUrl, apiKey: connection.apiKey };
  } catch {
    // 落到下方的統一報錯。
  }
  throw new Error(
    "needsLive 需要 OpenAI 相容連線憑證。請設 SLIDE_MAKER_OPENAI_BASE_URL + SLIDE_MAKER_OPENAI_API_KEY，" +
      `或在 ${sourcePath} 準備一個 protocol=openai 且 baseUrl 含 8317 的連線（例如本機 CLIProxyAPI）。`,
  );
}

/**
 * 零外部 HTTP guard（L0 專用）：攔截 global fetch，只放行測試 server 的確切 origin
 * （127.0.0.1:<testPort>）。任何指向別處的請求（含本機 8317 的 gateway）都會 throw，
 * 藉此**證明** L0 全程零配額。回傳 restore 函式。
 */
function installFetchGuard(allowedOrigin) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = "";
    }
    if (origin !== allowedOrigin)
      return Promise.reject(
        new Error(
          `L0 zero-quota guard blocked an external fetch to ${origin || url}. ` +
            `Only ${allowedOrigin} (the in-process test server) is allowed in L0.`,
        ),
      );
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * 靜音 server 的結構化 INFO/WARNING log（`{severity,event,...}` 一行 JSON），讓終端
 * 報告不被 job phase 之類的雜訊淹沒。ERROR 一律保留以利診斷。設 E2E_VERBOSE=1 可停用。
 * 回傳 restore 函式。
 */
export function installLogFilter() {
  if (process.env.E2E_VERBOSE === "1") return () => {};
  // server 的結構化 log 有兩種形狀：core 的 emit（帶 severity）與 jobs 的 logPhase
  // （直接 console.log 一個帶 `event` 的 JSON、無 severity）。兩者都靜音，唯獨保留
  // severity==="ERROR"（真正的失敗線索）。
  const isNoisy = (args) => {
    if (args.length !== 1 || typeof args[0] !== "string") return false;
    if (!args[0].startsWith("{")) return false;
    try {
      const parsed = JSON.parse(args[0]);
      if (!parsed || typeof parsed !== "object" || !("event" in parsed)) return false;
      return parsed.severity !== "ERROR";
    } catch {
      return false;
    }
  };
  const log = console.log;
  const warn = console.warn;
  console.log = (...args) => {
    if (!isNoisy(args)) log(...args);
  };
  console.warn = (...args) => {
    if (!isNoisy(args)) warn(...args);
  };
  return () => {
    console.log = log;
    console.warn = warn;
  };
}

/**
 * 啟動一個隔離的 harness。
 * @param {{ runId: string, needsLive?: boolean, zeroQuota?: boolean, keepData?: boolean }} options
 */
export async function startHarness(options) {
  const { runId, needsLive = false, zeroQuota = true, keepData = false } = options;
  const dataRoot = resolve(repoRoot, ".e2e-data", runId);
  const artifactsDir = resolve(repoRoot, "artifacts", "e2e", runId);
  await rm(dataRoot, { recursive: true, force: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const library = await seedLibrary(dataRoot, { needsLive });

  const createApp = await loadCreateApp();
  const app = await createApp(dataRoot);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("E2E server did not bind a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = createClient(baseUrl);

  // guard 只在 boot 完成後裝上：createApp 本身若有 boot-time fetch 不受影響；
  // 之後所有 spec 期間的 fetch 都被檢查。
  const restoreFetch = zeroQuota ? installFetchGuard(baseUrl) : () => {};

  /** 把產物寫進 artifacts；回傳絕對路徑。 */
  async function writeArtifact(relativePath, bytes) {
    const target = join(artifactsDir, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, Buffer.from(bytes));
    return target;
  }

  async function close() {
    restoreFetch();
    await new Promise((r) => server.close(r));
    if (!keepData) await rm(dataRoot, { recursive: true, force: true });
  }

  return {
    runId,
    dataRoot,
    artifactsDir,
    baseUrl,
    client,
    library,
    needsLive,
    writeArtifact,
    close,
  };
}

/** 產生時間戳 runId（給 run.mjs 用）。 */
export function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

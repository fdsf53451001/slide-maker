// E2E UI server launcher.
//
// Boots the ALREADY-BUILT slide-maker server (apps/server/dist) against an
// isolated data root, with a mock-only image provider and zero API quota.
// Playwright's `webServer` block spawns this; it is intentionally standalone so
// this suite does not depend on any other agent's harness.
//
// Guarantees:
//   - never touches .slide-maker-data / .data (own SLIDE_MAKER_DATA_ROOT)
//   - NODE_ENV=test  → outline generation uses the deterministic local
//     fallback (createSlidesFromBrief) instead of calling Codex (no quota)
//   - no Codex / OpenAI / Gemini credentials in env → nothing hits the network
//   - SLIDE_MAKER_LOG_EGRESS_IP unset → no boot-time call to api.ipify.org
//
// Env in:
//   SLIDE_MAKER_E2E_PORT       port to listen on (default 4188)
//   SLIDE_MAKER_E2E_DATA_ROOT  data root (default .e2e-data/ui-<timestamp>)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const port = process.env.SLIDE_MAKER_E2E_PORT ?? "4188";
const dataRoot =
  process.env.SLIDE_MAKER_E2E_DATA_ROOT ?? resolve(repoRoot, ".e2e-data", `ui-${Date.now()}`);
// 比照 e2e/lib/harness.mjs 的 close() 清理模式：跑完刪除隔離 dataRoot；SLIDE_MAKER_E2E_KEEP_DATA
// 保留（除錯用）。
const keepData = process.env.SLIDE_MAKER_E2E_KEEP_DATA === "1";
const e2eDataRoot = resolve(repoRoot, ".e2e-data");

const serverEntry = resolve(repoRoot, "apps/server/dist/index.js");
const editorIndex = resolve(repoRoot, "apps/editor/dist/index.html");

function fail(message) {
  console.error(`\n[e2e/ui] ${message}\n`);
  process.exit(1);
}

if (!existsSync(serverEntry))
  fail(
    `Server build not found at ${serverEntry}.\n` +
      `Run: pnpm -r build   (or: pnpm --filter @slide-maker/server build)`,
  );

if (!existsSync(editorIndex))
  fail(
    `Editor build not found at ${editorIndex}.\n` + `Run: pnpm --filter @slide-maker/editor build`,
  );

mkdirSync(dataRoot, { recursive: true });

console.log(`[e2e/ui] data root: ${dataRoot}`);
console.log(`[e2e/ui] listening on http://127.0.0.1:${port}`);

const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: port,
    SLIDE_MAKER_DATA_ROOT: dataRoot,
    // Keep the FTS index on the same isolated root.
    SLIDE_MAKER_SEARCH_INDEX_PATH: resolve(dataRoot, "index", "sources.sqlite"),
    // Belt-and-braces: make sure no live provider or egress probe is active.
    SLIDE_MAKER_LOG_EGRESS_IP: "",
    SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX: "",
    SLIDE_MAKER_OPENAI_BASE_URL: "",
    SLIDE_MAKER_OPENAI_API_KEY: "",
  },
});

// 清掉本 run 的隔離 dataRoot。時機在 child（真正持有 dataRoot 檔案代碼的伺服器進程）
// **退出之後**才呼叫，確保不會刪到還在使用中的目錄；用同步 rmSync，好在 process.exit /
// process.kill 讓本進程死掉之前確實跑完（async rm 會與退出賽跑而漏刪）。冪等、可安全重入。
let cleaned = false;
function cleanupDataRoot() {
  if (cleaned) return;
  cleaned = true;
  if (keepData) return;
  // 安全護欄：只刪 `.e2e-data/` 底下的隔離目錄。若 SLIDE_MAKER_E2E_DATA_ROOT 被指到別處
  // （例如真實資料根），寧可留著也不誤刪——harness 的 dataRoot 天生就在 .e2e-data 內，
  // 這裡把同一條隔離保證補在「可由 env 覆寫」的入口上。
  const rel = relative(e2eDataRoot, dataRoot);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    // 清理是 best-effort：刪不掉不該把測試結果翻成失敗。
  }
}

const forward = (signal) => () => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code, signal) => {
  cleanupDataRoot();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
// spawn 本身失敗時不會有 exit 事件（child 沒起來，dataRoot 也沒人在用）：仍要清掉並收尾，
// 否則進程會卡住、隔離目錄殘留。
child.on("error", (error) => {
  cleanupDataRoot();
  fail(`failed to spawn server: ${error.message}`);
});

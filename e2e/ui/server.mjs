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
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const port = process.env.SLIDE_MAKER_E2E_PORT ?? "4188";
const dataRoot =
  process.env.SLIDE_MAKER_E2E_DATA_ROOT ?? resolve(repoRoot, ".e2e-data", `ui-${Date.now()}`);

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

const forward = (signal) => () => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

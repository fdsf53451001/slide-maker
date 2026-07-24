import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { chromium } from "@playwright/test";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../..");

// 固定高位 port，刻意避開正式 dev server（4173）與舊預設（4188）：port 必須跨
// 進程一致（Playwright 主進程與各 worker 會各自重新載入本 config），不能用
// Math.random() —— 那會讓 worker 算出與 webServer 不同的 port。防「重用指向真實
// 資料的外部 server」這件事由 reuseExistingServer:false 負責，不靠隨機化。
// 可用 SLIDE_MAKER_E2E_PORT 覆寫（並行多 run 時各自指定）。
const PORT = process.env.SLIDE_MAKER_E2E_PORT ?? "41873";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// A stable run id so failure artifacts (screenshot + trace) land in a
// predictable per-run folder.
const runId = process.env.SLIDE_MAKER_E2E_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const artifactsRoot = resolve(repoRoot, "artifacts", "e2e-ui");
const runArtifacts = resolve(artifactsRoot, runId);

// Fail fast with a readable message when the browser has not been downloaded,
// instead of the raw "Executable doesn't exist" deep in a worker.
const chromiumPath = chromium.executablePath();
if (!existsSync(chromiumPath)) {
  throw new Error(
    `\n[e2e/ui] Chromium is not installed for Playwright.\n` +
      `Expected browser at: ${chromiumPath}\n` +
      `Run:  npx playwright install chromium\n`,
  );
}

export default defineConfig({
  testDir: resolve(here, "specs"),
  outputDir: resolve(runArtifacts, "test-results"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Deliberately 0 — we want to surface flakiness, not paper over it.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: resolve(artifactsRoot, "html"), open: "never" }]],
  use: {
    baseURL: BASE_URL,
    // 1440x900 keeps the editor's fixed side columns from clipping the canvas
    // (the shell grid is 228px + minmax(600px,1fr) + 360px).
    viewport: { width: 1440, height: 900 },
    // Artifacts only when a test fails — retries:0 so this is the only capture.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ${resolve(here, "server.mjs")}`,
    url: `${BASE_URL}/api/health`,
    // 一律 false（連本機也不重用）：重用一個非本套件起的 server 可能指向真實
    // data root，破壞隔離。port 撞占時寧可失敗報錯，也不要靜默重用外部 server。
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      SLIDE_MAKER_E2E_PORT: PORT,
      SLIDE_MAKER_E2E_DATA_ROOT: resolve(repoRoot, ".e2e-data", `ui-${runId}`),
    },
  },
});

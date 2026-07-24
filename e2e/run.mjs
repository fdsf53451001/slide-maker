#!/usr/bin/env node
// E2E 進入點。用法：
//   node e2e/run.mjs --layers l0            只跑 L0（零配額）
//   node e2e/run.mjs --layers l0,l1 --yes   L0 + L1（L1/L2 會消耗配額，須 --yes）
//   node e2e/run.mjs --slides 4 --combination e2e-gpt   （L1/L2 參數）
//   node e2e/run.mjs --keep-data            保留隔離 dataRoot（預設跑完刪除）
//
// ⚠️ L1/L2 是 live 端對端測試，會消耗模型配額，**絕不可**進入 `pnpm check`。
// 預設 layer 涵蓋 L0+L1+L2，但 L1/L2 需顯式 `--yes`（或環境變數
// SLIDE_MAKER_E2E_LIVE=1）才會真的執行——避免無參數裸跑 `pnpm e2e` 手滑燒配額。
import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SkipSignal } from "./lib/assert.mjs";
import { installLogFilter, newRunId, startHarness } from "./lib/harness.mjs";
import { Report, heading } from "./lib/report.mjs";
import { repoRoot } from "./lib/deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    layers: ["l0", "l1", "l2"],
    slides: undefined,
    combination: undefined,
    keepData: false,
    confirmLive: false,
    only: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--layers")
      args.layers = argv[++i]
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((s) => s.toLowerCase());
    else if (arg === "--slides") args.slides = Number(argv[++i]);
    else if (arg === "--combination") args.combination = argv[++i];
    else if (arg === "--keep-data") args.keepData = true;
    else if (arg === "--yes" || arg === "-y") args.confirmLive = true;
    else if (arg === "--only") args.only = argv[++i].split(/[,\s]+/).filter(Boolean);
    else throw new Error(`未知參數：${arg}`);
  }
  return args;
}

async function discoverSpecs(layers, only) {
  const specDir = resolve(here, "specs");
  const files = (await readdir(specDir)).filter((f) => f.endsWith(".mjs")).sort();
  const specs = [];
  for (const file of files) {
    const module = await import(pathToFileURL(resolve(specDir, file)).href);
    if (!module.default || !module.layer) continue;
    if (!layers.includes(module.layer)) continue;
    const name = module.name ?? file.replace(/\.mjs$/, "");
    // --only 依 spec 名精準過濾（可逗號分隔多個），供上版前重跑單一路徑。
    if (only && !only.includes(name)) continue;
    specs.push({
      name,
      layer: module.layer,
      needsLive: module.needsLive ?? module.layer !== "l0",
      run: module.default,
    });
  }
  return specs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = newRunId();

  // Live 確認閘：要跑 L1/L2 但沒 --yes（也沒設 SLIDE_MAKER_E2E_LIVE=1）就停下，
  // 不執行任何燒配額的 spec。預設 layer 仍宣稱涵蓋三層，只是把「真的花錢」這一步
  // 收成顯式 opt-in，避免無參數裸跑手滑。
  const liveLayers = args.layers.filter((l) => l !== "l0");
  const liveConfirmed = args.confirmLive || process.env.SLIDE_MAKER_E2E_LIVE === "1";
  if (liveLayers.length && !liveConfirmed) {
    console.log(
      `⚠️  已選 layer 含 ${liveLayers.join(", ").toUpperCase()}，這些是 live 測試會消耗模型配額。`,
    );
    console.log("    預估：L1 ≈ 4 次文字/搜尋、L2 ≈ 影像頁數＋編輯＋抽字（3 頁約 6–8 次影像）。");
    console.log(
      "    確認執行請加 --yes（或設 SLIDE_MAKER_E2E_LIVE=1）；只跑零配額請用 `pnpm e2e:l0`。",
    );
    return 2;
  }

  const specs = await discoverSpecs(args.layers, args.only);
  const topArtifacts = resolve(repoRoot, "artifacts", "e2e", runId);

  console.log(`E2E run ${runId} — layers: ${args.layers.join(", ")} — ${specs.length} spec(s)`);
  if (args.layers.some((l) => l !== "l0")) console.log("⚠️  L1/L2 為 live 測試，將消耗模型配額。");

  if (!specs.length) {
    console.log("（沒有符合所選 layer 的 spec）");
    if (args.layers.some((l) => l !== "l0"))
      console.log("L1/L2 spec 由另一個 agent 接手實作，尚未就緒。");
    return 0;
  }

  const report = new Report();
  // 全域安裝一次 log filter：涵蓋 spec 結束後才 flush 的背景任務結構化 log。
  const restoreLog = installLogFilter();
  let currentLayer = "";
  for (const spec of specs) {
    if (spec.layer !== currentLayer) {
      currentLayer = spec.layer;
      heading(`Layer ${currentLayer.toUpperCase()}`);
    }
    const zeroQuota = spec.layer === "l0";
    const started = performance.now();
    let harness;
    try {
      harness = await startHarness({
        runId: `${runId}/${spec.name}`,
        needsLive: spec.needsLive,
        zeroQuota,
        keepData: args.keepData,
      });
      harness.options = { slides: args.slides, combination: args.combination };
      await spec.run(harness);
      report.record({ name: spec.name, status: "pass", durationMs: performance.now() - started });
    } catch (error) {
      if (error instanceof SkipSignal)
        report.record({
          name: spec.name,
          status: "skip",
          reason: error.message,
          durationMs: performance.now() - started,
        });
      else
        report.record({
          name: spec.name,
          status: "fail",
          error,
          durationMs: performance.now() - started,
        });
    } finally {
      if (harness) await harness.close().catch(() => undefined);
    }
  }

  restoreLog();
  // 各 spec 的 dataRoot 已於 close 移除；把空的 run 目錄一併清掉（--keep-data 時保留）。
  if (!args.keepData)
    await rm(resolve(repoRoot, ".e2e-data", runId), { recursive: true, force: true }).catch(
      () => undefined,
    );
  return report.summarize(topArtifacts);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("E2E runner crashed:", error);
    process.exit(1);
  });

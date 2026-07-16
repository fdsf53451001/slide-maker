import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../apps/server/dist/app.js";

if (process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX !== "1") {
  throw new Error("Set SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1 to run this quota-consuming E2E test");
}
if (!process.env.CODEX_HOME) throw new Error("Set CODEX_HOME to an isolated, authenticated Codex home");

const dataRoot = process.env.SLIDE_MAKER_DATA_ROOT;
if (!dataRoot) throw new Error("Set SLIDE_MAKER_DATA_ROOT to a dedicated E2E directory");
const outputRoot = resolve(process.env.SLIDE_MAKER_E2E_OUTPUT ?? "artifacts/grok-build-e2e");
const slideCount = Number(process.env.SLIDE_MAKER_E2E_SLIDE_COUNT ?? "4");
const resumeProjectId = process.env.SLIDE_MAKER_E2E_PROJECT_ID;
if (!Number.isSafeInteger(slideCount) || slideCount < 1 || slideCount > 20) {
  throw new Error("SLIDE_MAKER_E2E_SLIDE_COUNT must be an integer between 1 and 20");
}

const sourceText = `# Grok Build 官方資料（Web Search：live）

查詢日期：2026-07-14

## Grok Build CLI announcement
URL: https://x.ai/news/grok-build-cli
- Grok Build 是面向專業軟體工程工作的 coding agent 與 CLI。
- Plan mode 可讓使用者核准計畫、逐步評論或在執行前重寫計畫。
- 可在現有 terminal 與 tooling 中工作。
- Subagents 可平行處理工作。

## Grok Build documentation
URL: https://docs.x.ai/build/overview
- 支援互動式 TUI。
- 支援 headless scripts 與 bots。
- 支援 Agent Client Protocol（ACP）整合。
- 可使用瀏覽器登入或 XAI_API_KEY。

## Code planning use case
URL: https://x.ai/grok/use-cases/code-planning
- 可在修改程式前探索 repository、辨識相依程式碼並產出分階段計畫。
- Subagents 可協助研究、測試與審查。

## Grok Build 0.1
URL: https://x.ai/news/grok-build-0-1
- Grok Build 0.1 已透過 xAI API 進入 public beta。
`;

const slides = [
  {
    purpose: "建立 Grok Build 的核心定位",
    content: "Grok Build 的優勢\n從規劃到交付的專業 Coding Agent",
    narrative: "Grok Build 不只是回答程式問題，而是把規劃、執行與交付帶進真實開發工作流。",
    layoutHint: "16:9 深色技術感封面；大標題在左，右側是抽象終端與程式工作流；留白清楚。",
    dataBasis: ["https://x.ai/news/grok-build-cli", "https://docs.x.ai/build/overview"],
    imagePrompt: `Use case: productivity-visual
Asset type: 16:9 presentation slide
Primary request: Grok Build 優勢簡報封面，呈現 coding agent 在真實終端中從規劃走向交付
Scene/backdrop: 深黑到海軍藍的抽象技術背景，細緻終端網格與發光工作流節點
Style/medium: 高階科技產品發表簡報，極簡、精準、非科幻概念畫
Composition/framing: 左側清楚文字階層，右側單一抽象終端工作流視覺，寬闊留白
Color palette: 黑、深海軍藍、電光青，少量洋紅點綴
Text (verbatim): "Grok Build 的優勢" and "從規劃到交付的專業 Coding Agent"
Constraints: 所有文字逐字正確且只出現一次；繁體中文；可讀字級；無 logo；無浮水印；無多餘文字；1920×1080`,
  },
  {
    purpose: "說明 Plan mode 帶來的控制力",
    content: "先規劃，再動手\n探索程式庫｜檢查相依與風險｜核准後執行",
    narrative: "Plan mode 先探索 repository、辨識相依與風險；團隊可逐步評論、修改或核准計畫，再讓 agent 執行。",
    layoutHint: "16:9 三階段水平流程圖；視覺從探索、審查到核准執行；清楚箭頭與高對比標題。",
    dataBasis: ["https://x.ai/news/grok-build-cli", "https://x.ai/grok/use-cases/code-planning"],
    imagePrompt: `Use case: productivity-visual
Asset type: 16:9 presentation slide
Primary request: 以三階段流程圖解釋 Grok Build Plan mode 的優勢
Scene/backdrop: 深色乾淨簡報背景
Subject: 三個大型連續節點，由 repo 探索、相依風險審查到人工核准後執行
Style/medium: 現代企業技術簡報，向量感資訊圖，精準而克制
Composition/framing: 上方大標題；中央由左至右三階段流程；每階段只放一個短標籤
Color palette: 黑、深海軍藍、電光青，核准節點用柔和綠色
Text (verbatim): "先規劃，再動手", "探索程式庫", "檢查相依與風險", "核准後執行"
Constraints: 所有文字逐字正確且只出現一次；繁體中文；清楚箭頭；無 logo；無浮水印；無多餘文字；1920×1080`,
  },
  {
    purpose: "展示 Grok Build 的整合彈性",
    content: "一個 Agent，多種入口\n互動式 TUI｜Headless｜ACP",
    narrative: "同一套 agent 能力可用互動式 TUI 操作，也能放進 headless scripts、bots，或透過 ACP 串接其他工具。",
    layoutHint: "16:9 hub-and-spoke 架構圖；中央 Grok Build agent，連接 TUI、Headless、ACP 三個入口。",
    dataBasis: ["https://docs.x.ai/build/overview"],
    imagePrompt: `Use case: productivity-visual
Asset type: 16:9 presentation slide
Primary request: 展示同一個 Grok Build agent 透過三種入口融入工程系統
Scene/backdrop: 深色極簡技術簡報背景，低調網格
Subject: 中央發光 agent 核心，連接三個等權節點：互動式 TUI、Headless、ACP
Style/medium: 清晰架構資訊圖，高階產品簡報，非 UI 截圖
Composition/framing: 上方大標題；中央 hub-and-spoke；三節點空間平衡、連線清楚
Color palette: 黑、深海軍藍、電光青、少量洋紅
Text (verbatim): "一個 Agent，多種入口", "互動式 TUI", "Headless", "ACP"
Constraints: 所有文字逐字正確且只出現一次；繁體中文；無 logo；無浮水印；無多餘文字；1920×1080`,
  },
  {
    purpose: "總結 Subagents 的平行交付優勢",
    content: "平行協作，放大交付速度\n研究｜實作｜測試｜審查",
    narrative: "Subagents 可平行處理研究、實作、測試與審查。Grok Build 的優勢來自可控制、可整合、可平行的工程工作流。",
    layoutHint: "16:9 收束頁；中央主代理向四條平行工作流展開，再匯聚為交付成果；強烈但簡潔。",
    dataBasis: ["https://x.ai/news/grok-build-cli", "https://x.ai/grok/use-cases/code-planning"],
    imagePrompt: `Use case: productivity-visual
Asset type: 16:9 presentation slide
Primary request: 以四條平行工作流呈現 Grok Build subagents 放大交付速度
Scene/backdrop: 深色高階技術簡報背景
Subject: 中央 agent 將工作分派為研究、實作、測試、審查四條並行軌道，最後匯聚成完成的交付節點
Style/medium: 精準向量感流程資訊圖，現代、可信、簡潔
Composition/framing: 上方大標題；中央四軌平行流程；右端匯聚，形成清楚視覺結論
Color palette: 黑、深海軍藍、電光青，四軌使用克制的青紫色差
Text (verbatim): "平行協作，放大交付速度", "研究", "實作", "測試", "審查"
Constraints: 所有文字逐字正確且只出現一次；繁體中文；無 logo；無浮水印；無多餘文字；1920×1080`,
  },
];

const app = await createApp(dataRoot);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("E2E server did not bind a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${(await response.text()).slice(0, 800)}`);
  return response;
}

function validatePng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error("Generated asset is not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== 1920 || height !== 1080) throw new Error(`Unexpected PNG dimensions: ${width}x${height}`);
  return { width, height };
}

try {
  const readiness = await (await api("/api/providers/codex-image-spike/readiness")).json();
  if (readiness.status !== "ready_experimental") throw new Error(`Codex readiness is ${readiness.status}`);

  let project;
  if (resumeProjectId) {
    project = await (await api(`/api/projects/${resumeProjectId}`)).json();
  } else {
    project = await (await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        topic: "Grok Build 的優勢",
        name: `Grok Build 的優勢｜${slideCount} 頁 Web Search E2E`,
        brief: {
          audience: "軟體開發團隊與技術主管",
          purpose: "說明 Grok Build 在規劃、整合與平行協作上的工作流優勢",
          language: "zh-TW",
          desiredSlideCount: slideCount,
          tone: "專業、現代、技術導向",
          contentMode: "grounded",
          webSearchMode: "live",
        },
      }),
    })).json();
    if (project.workflowStage !== "requirements") throw new Error(`Unexpected initial workflow stage: ${project.workflowStage}`);
    if (project.brief.desiredSlideCount !== slideCount || project.brief.webSearchMode !== "live") {
      throw new Error(`The ${slideCount}-slide live Web Search brief was not persisted`);
    }
    project = await (await api(`/api/projects/${project.id}/outline`, {
      method: "POST",
      body: JSON.stringify({ replace: true }),
    })).json();
  }
  if (project.workflowStage !== "settings" || project.slides.length !== slideCount) {
    throw new Error(`Outline did not create the ${slideCount}-slide settings step: ${project.workflowStage}/${project.slides.length}`);
  }

  const source = project.sources.find((item) => item.metadata?.url);
  if (!source || source.status !== "indexed" || !source.metadata.url) throw new Error("Live Web Search source was not persisted");
  if (!project.outlineRationale) throw new Error("AI outline rationale was not persisted");

  const searchQuery = source.metadata.title ?? source.name;
  const searchResults = await (await api(`/api/projects/${project.id}/search?q=${encodeURIComponent(searchQuery)}`)).json();
  if (!searchResults.some((result) => result.sourceId === source.id)) throw new Error("Indexed Web Search source is not retrievable");

  const queuedJobs = await (await api(`/api/projects/${project.id}/generate`, {
    method: "POST",
    body: JSON.stringify({ providerId: "codex-image-spike", acceptUnknownReadiness: false }),
  })).json();
  if (queuedJobs.length !== slideCount) throw new Error(`Expected ${slideCount} queued jobs, received ${queuedJobs.length}`);

  const jobIds = new Set(queuedJobs.map((job) => job.id));
  const deadline = Date.now() + 35 * 60_000;
  let previousStatus = "";
  while (Date.now() < deadline) {
    project = await (await api(`/api/projects/${project.id}`)).json();
    const jobs = project.jobs.filter((job) => jobIds.has(job.id));
    const status = jobs.map((job) => `${job.status}:${job.phase ?? "-"}`).join("|");
    if (status !== previousStatus) {
      console.log(`[${new Date().toISOString()}] ${status}`);
      previousStatus = status;
    }
    if (jobs.some((job) => ["failed", "cancelled"].includes(job.status))) {
      const failures = jobs.filter((job) => job.status !== "completed").map((job) => `${job.id}:${job.errorCode ?? job.status}`);
      throw new Error(`Generation failed: ${failures.join(", ")}`);
    }
    if (jobs.length === slideCount && jobs.every((job) => job.status === "completed")) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  project = await (await api(`/api/projects/${project.id}`)).json();
  const jobs = project.jobs.filter((job) => jobIds.has(job.id));
  if (project.workflowStage !== "editing" || jobs.length !== slideCount || !jobs.every((job) => job.status === "completed")) {
    throw new Error(`E2E did not reach editing with ${slideCount} completed jobs: ${project.workflowStage}/${jobs.map((job) => job.status).join(",")}`);
  }

  await mkdir(outputRoot, { recursive: true });
  const assets = [];
  for (let index = 0; index < project.slides.length; index += 1) {
    const slide = project.slides[index];
    const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
    if (!version?.imagePath) throw new Error(`Slide ${index + 1} does not have a current generated asset`);
    if (!version.sources.length || !version.sources.every((citation) => citation.url)) throw new Error(`Slide ${index + 1} lost its Web Search citations`);
    const assetResponse = await api(`/api/projects/${project.id}/assets/${version.imagePath.replace(/^assets\//, "")}`);
    const bytes = new Uint8Array(await assetResponse.arrayBuffer());
    const dimensions = validatePng(bytes);
    const outputPath = resolve(outputRoot, `slide-${String(index + 1).padStart(2, "0")}.png`);
    await writeFile(outputPath, bytes);
    assets.push({ slide: index + 1, versionId: version.id, outputPath, bytes: bytes.length, ...dimensions });
  }

  const pptxBytes = new Uint8Array(await (await api(`/api/projects/${project.id}/export/pptx`)).arrayBuffer());
  if (pptxBytes[0] !== 0x50 || pptxBytes[1] !== 0x4b) throw new Error("PPTX export is not a ZIP-based Office document");
  const pptxPath = resolve(outputRoot, "grok-build-advantages.pptx");
  await writeFile(pptxPath, pptxBytes);

  const pdfBytes = new Uint8Array(await (await api(`/api/projects/${project.id}/export/pdf`)).arrayBuffer());
  if (new TextDecoder().decode(pdfBytes.subarray(0, 5)) !== "%PDF-") throw new Error("PDF export has an invalid signature");
  const pdfPath = resolve(outputRoot, "grok-build-advantages.pdf");
  await writeFile(pdfPath, pdfBytes);

  const pngZipBytes = new Uint8Array(await (await api(`/api/projects/${project.id}/export/png.zip`)).arrayBuffer());
  if (pngZipBytes[0] !== 0x50 || pngZipBytes[1] !== 0x4b) throw new Error("PNG ZIP export is not a ZIP document");
  const pngZipPath = resolve(outputRoot, "grok-build-advantages-png.zip");
  await writeFile(pngZipPath, pngZipBytes);

  const projectBytes = new Uint8Array(await (await api(`/api/projects/${project.id}/export/slide-project`)).arrayBuffer());
  if (projectBytes[0] !== 0x50 || projectBytes[1] !== 0x4b) throw new Error("Project export is not a ZIP bundle");
  const projectPath = resolve(outputRoot, "grok-build-advantages.slide-project");
  await writeFile(projectPath, projectBytes);

  console.log(JSON.stringify({
    ok: true,
    readiness: readiness.status,
    projectId: project.id,
    workflowStage: project.workflowStage,
    requestedSlides: project.brief.desiredSlideCount,
    generatedSlides: assets.length,
    webSearchMode: project.brief.webSearchMode,
    sourceId: source.id,
    sourceChunks: source.chunks.length,
    jobs: jobs.map((job) => ({ id: job.id, status: job.status, attempt: job.attempt })),
    assets,
    pptxPath,
    pptxBytes: pptxBytes.length,
    pdfPath,
    pdfBytes: pdfBytes.length,
    pngZipPath,
    pngZipBytes: pngZipBytes.length,
    projectPath,
    projectBytes: projectBytes.length,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

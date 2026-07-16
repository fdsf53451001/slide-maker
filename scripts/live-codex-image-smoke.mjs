import { once } from "node:events";
import { createApp } from "../apps/server/dist/app.js";

if (process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX !== "1") {
  throw new Error("Set SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1 to run this quota-consuming smoke test");
}
if (!process.env.CODEX_HOME) throw new Error("Set CODEX_HOME to an isolated, authenticated Codex home");

const dataRoot = process.env.SLIDE_MAKER_DATA_ROOT;
if (!dataRoot) throw new Error("Set SLIDE_MAKER_DATA_ROOT to a dedicated smoke-test directory");

const app = await createApp(dataRoot);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Smoke server did not bind a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${(await response.text()).slice(0, 500)}`);
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

  let project = await (await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ topic: "確認真實圖片生成", name: "Codex 單頁端到端測試" }),
  })).json();
  const slideId = project.slides[0].id;
  project = await (await api(`/api/projects/${project.id}/slides/${slideId}`, {
    method: "PATCH",
    body: JSON.stringify({
      purpose: "確認真實圖片生成",
      content: "圖片生成，端到端成功",
      narrative: "以單一強烈視覺確認 Slide Maker 到 Codex 圖片生成的完整流程。",
      layoutHint: "16:9 封面；標題置中；留白清楚。",
      dataBasis: [],
      imagePrompt: "深海軍藍背景、中央柔和橘色光暈、現代簡潔簡報封面。畫面唯一文字必須逐字為：圖片生成，端到端成功。不要標誌、不要浮水印。",
    }),
  })).json();

  const job = await (await api(`/api/projects/${project.id}/slides/${slideId}/generate`, {
    method: "POST",
    body: JSON.stringify({ providerId: "codex-image-spike", acceptUnknownReadiness: false }),
  })).json();

  const deadline = Date.now() + 15 * 60_000;
  let completedJob;
  while (Date.now() < deadline) {
    project = await (await api(`/api/projects/${project.id}`)).json();
    completedJob = project.jobs.find((candidate) => candidate.id === job.id);
    if (["completed", "failed", "cancelled"].includes(completedJob?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!completedJob || completedJob.status !== "completed") {
    throw new Error(`Image job ${completedJob?.status ?? "timed_out"}: ${completedJob?.errorCode ?? "NO_ERROR_CODE"}`);
  }

  const slide = project.slides.find((candidate) => candidate.id === slideId);
  const version = slide?.versions.find((candidate) => candidate.id === slide.currentVersionId);
  if (!version?.imagePath) throw new Error("Successful image job did not create a current slide asset");
  const assetResponse = await api(`/api/projects/${project.id}/assets/${version.imagePath.replace(/^assets\//, "")}`);
  const bytes = new Uint8Array(await assetResponse.arrayBuffer());
  const dimensions = validatePng(bytes);
  console.log(JSON.stringify({
    ok: true,
    readiness: readiness.status,
    projectId: project.id,
    slideId,
    jobId: job.id,
    versionId: version.id,
    assetPath: version.imagePath,
    bytes: bytes.length,
    ...dimensions,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

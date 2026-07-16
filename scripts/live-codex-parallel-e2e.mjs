import { once } from "node:events";
import { createApp } from "../apps/server/dist/app.js";

if (process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX !== "1" || !process.env.CODEX_HOME || !process.env.SLIDE_MAKER_DATA_ROOT) {
  throw new Error("Set SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1, CODEX_HOME and SLIDE_MAKER_DATA_ROOT");
}
const app = await createApp(process.env.SLIDE_MAKER_DATA_ROOT);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); if (!address || typeof address === "string") throw new Error("server bind failed");
const base = `http://127.0.0.1:${address.port}`;
const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`${response.status} ${path}: ${(await response.text()).slice(0, 500)}`);
  return response;
};

try {
  const providers = await (await api("/api/providers")).json();
  const codex = providers.find((item) => item.id === "codex-image-spike");
  if (codex?.maxConcurrency !== 2) throw new Error(`Expected tested concurrency 2, got ${codex?.maxConcurrency}`);
  let project = await (await api("/api/projects", { method: "POST", body: JSON.stringify({
    topic: "Codex 並行圖片生成驗證", brief: { desiredSlideCount: 2, webSearchMode: "disabled" },
  }) })).json();
  const specs = [
    { purpose: "並行驗證 A", content: "Parallel lane A", narrative: "獨立的藍色資料管線", layoutHint: "左至右單一路徑", imagePrompt: "Create a polished 16:9 slide titled Parallel A with a blue data pipeline, no logos.", sourceIds: [] },
    { purpose: "並行驗證 B", content: "Parallel lane B", narrative: "獨立的紫色驗證管線", layoutHint: "中央驗證節點", imagePrompt: "Create a polished 16:9 slide titled Parallel B with a purple verification pipeline, no logos.", sourceIds: [] },
  ];
  for (let index = 0; index < 2; index += 1) project = await (await api(`/api/projects/${project.id}/slides/${project.slides[index].id}`, { method: "PATCH", body: JSON.stringify(specs[index]) })).json();
  const started = Date.now();
  const queued = await (await api(`/api/projects/${project.id}/generate`, { method: "POST", body: JSON.stringify({ providerId: "codex-image-spike" }) })).json();
  if (queued.length !== 2) throw new Error("Expected two jobs");
  const ids = new Set(queued.map((job) => job.id)); let observedOverlap = false;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    project = await (await api(`/api/projects/${project.id}`)).json();
    const jobs = project.jobs.filter((job) => ids.has(job.id));
    if (jobs.filter((job) => job.status === "running").length === 2) observedOverlap = true;
    if (jobs.some((job) => ["failed", "cancelled"].includes(job.status))) throw new Error(`Parallel job failed: ${jobs.map((job) => job.errorCode).join(",")}`);
    if (jobs.length === 2 && jobs.every((job) => job.status === "completed")) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  const jobs = project.jobs.filter((job) => ids.has(job.id));
  if (!observedOverlap || !jobs.every((job) => job.status === "completed")) throw new Error("Codex jobs did not complete with observed overlap");
  for (const slide of project.slides) {
    const version = slide.versions.find((item) => item.id === slide.currentVersionId); if (!version) throw new Error("Missing parallel output");
    const bytes = new Uint8Array(await (await api(`/api/projects/${project.id}/assets/${version.imagePath.replace(/^assets\//, "")}`)).arrayBuffer());
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error("Parallel output is not PNG");
  }
  const intervals = jobs.map((job) => ({ startedAt: job.startedAt, finishedAt: job.finishedAt }));
  const overlapMs = Math.min(...intervals.map((item) => Date.parse(item.finishedAt))) - Math.max(...intervals.map((item) => Date.parse(item.startedAt)));
  if (overlapMs <= 0) throw new Error("Persisted job intervals do not overlap");
  console.log(JSON.stringify({ ok: true, projectId: project.id, elapsedMs: Date.now() - started, overlapMs, jobs: jobs.map((job) => ({ id: job.id, attempt: job.attempt, startedAt: job.startedAt, finishedAt: job.finishedAt })) }, null, 2));
} finally { await new Promise((resolvePromise) => server.close(resolvePromise)); }

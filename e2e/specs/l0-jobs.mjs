// L0：用 mock-image 跑生成任務，驗證 job 生命週期（queued→running→completed）、
// 取消、並行度上限、job 觀測欄位。零配額（mock provider 不打任何網路）。
import { assert, assertEq, assertHttpError } from "../lib/assert.mjs";

export const name = "l0-jobs";
export const layer = "l0";
export const needsLive = false;

async function loadProject(client, id) {
  return (await client.get(`/api/projects/${id}`)).body;
}

export default async function run({ client }) {
  // ── 生命週期 + 並行度 + 觀測欄位 ──────────────────────────────────────────
  const project = (
    await client.post("/api/projects", {
      json: { topic: "任務測試", brief: { desiredSlideCount: 5 } },
    })
  ).body;
  const projectId = project.id;

  // 不帶 providerId → 由組合 e2e-mock 解析出 mock-image。
  const queued = (await client.post(`/api/projects/${projectId}/generate`, { json: {} })).body;
  assertEq(queued.length, 5, "應排入 5 個任務");
  for (const job of queued) {
    assertEq(job.status, "queued", "初始 status=queued");
    assertEq(job.lifecycleVersion, 1, "lifecycleVersion=1");
    assertEq(job.phase, "queued", "初始 phase=queued");
    assert(job.progress && job.progress.total === 6, "progress.total=6");
  }
  const queuedIds = new Set(queued.map((j) => j.id));

  // mock-image maxConcurrency=2：整個生成過程中 running 數不得超過 2。
  const MOCK_MAX_CONCURRENCY = 2;
  let observedRunning = false;
  let peakRunning = 0;
  const deadline = Date.now() + 60_000;
  let current;
  while (Date.now() < deadline) {
    current = await loadProject(client, projectId);
    const jobs = current.jobs.filter((j) => queuedIds.has(j.id));
    const running = jobs.filter((j) => j.status === "running").length;
    if (running > 0) observedRunning = true;
    peakRunning = Math.max(peakRunning, running);
    if (jobs.every((j) => ["completed", "failed", "cancelled"].includes(j.status))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const finalJobs = current.jobs.filter((j) => queuedIds.has(j.id));
  assert(
    finalJobs.every((j) => j.status === "completed"),
    `全部任務應完成，實際 ${finalJobs.map((j) => j.status).join(",")}`,
  );
  assert(
    peakRunning <= MOCK_MAX_CONCURRENCY,
    `並行度不得超過 ${MOCK_MAX_CONCURRENCY}，實測峰值 ${peakRunning}`,
  );
  // 註：running 是瞬時狀態，快的 mock 有機會在兩次輪詢間跑完；觀測到即加分，未觀測不算失敗。
  if (!observedRunning)
    console.log("    (note) 未捕捉到 running 中間態（mock 太快），以完成態驗證生命週期");

  // 觀測欄位（完成態）。
  for (const job of finalJobs) {
    assertEq(job.phase, "completed", "完成 phase");
    assertEq(job.progress, { step: 6, total: 6 }, "完成 progress");
    assert(job.resultVersionId, "應有 resultVersionId");
    assert(job.startedAt && job.finishedAt && job.phaseUpdatedAt, "應有時間戳觀測欄位");
  }
  // 每頁的 currentVersion 指向任務結果。
  for (const slide of current.slides) {
    const job = finalJobs.find((j) => j.slideId === slide.id);
    assertEq(slide.currentVersionId, job.resultVersionId, "slide.currentVersionId=任務結果版本");
  }

  // ── 取消：新專案，enqueue 後立刻取消一個仍在佇列的任務 ─────────────────────
  const p2 = (
    await client.post("/api/projects", {
      json: { topic: "取消測試", brief: { desiredSlideCount: 6 } },
    })
  ).body;
  const queued2 = (await client.post(`/api/projects/${p2.id}/generate`, { json: {} })).body;
  // 6 個任務、並行度 2 → 立刻取消最後一個（幾乎必然仍在佇列）。
  const target = queued2[queued2.length - 1];
  const cancelled = (await client.post(`/api/projects/${p2.id}/jobs/${target.id}/cancel`)).body;
  assert(
    ["cancelled", "completed"].includes(cancelled.status),
    `取消回應應為 cancelled 或（極少數已完成）completed，實際 ${cancelled.status}`,
  );
  if (cancelled.status === "cancelled") {
    assertEq(cancelled.errorCode, "CANCELLED", "取消 errorCode");
    assertEq(cancelled.phase, "cancelled", "取消 phase");
  }
  // 取消不存在的任務 → 404。
  await assertHttpError(
    client.rawPost(`/api/projects/${p2.id}/jobs/00000000-0000-0000-0000-000000000000/cancel`),
    404,
  );

  // 收尾：等 p2 的任務全部進終態，避免背景工作在 harness 關閉/資料清除後才跑而報錯。
  const drainDeadline = Date.now() + 30_000;
  while (Date.now() < drainDeadline) {
    const state = await loadProject(client, p2.id);
    if (state.jobs.every((j) => ["completed", "failed", "cancelled"].includes(j.status))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
}

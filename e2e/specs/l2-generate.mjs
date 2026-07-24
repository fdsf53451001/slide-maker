// L2（影像層）：整份簡報影像生成。用 gpt-image-2 對一個「已有大綱」的專案生成全部頁。
// 大綱直接用 createProject 的決定性佔位頁（零文字配額），因此本 spec 的配額全在影像。
// 輪詢所有 job 到終態，驗證每頁都產生 version、imagePath 存在、且抓回的資產是 canvas 尺寸
// （1920×1080）PNG。生成的圖存進 artifacts。
//
// 預期 API 呼叫：影像 = 頁數（預設 3）。文字 0、搜尋 0。
import { assert, assertEq, assertPng } from "../lib/assert.mjs";
import { currentVersion, fetchAsset, loadProject } from "../lib/flows.mjs";

export const name = "l2-generate";
export const layer = "l2";
export const needsLive = true;

export default async function run({ client, options, writeArtifact }) {
  const combinationId = options?.combination ?? "e2e-gpt";
  const desired = options?.slides ?? 3;

  const created = (
    await client.post("/api/projects", {
      json: {
        topic: "城市綠地對居民健康的益處",
        brief: { desiredSlideCount: desired, webSearchMode: "disabled" },
      },
    })
  ).body;
  const projectId = created.id;
  assertEq(created.slides.length, desired, `建立時應有 ${desired} 頁佔位大綱`);

  await client.patch(`/api/projects/${projectId}/combination`, { json: { combinationId } });

  // ── 生成全部頁 ──────────────────────────────────────────────────────────────
  // 不帶 providerId → 由組合解析出 gpt-image-2。acceptUnknownReadiness 讓 readiness
  // 回 unknown（gateway 無法預檢時）也能繼續。
  const queued = (
    await client.post(`/api/projects/${projectId}/generate`, {
      json: { acceptUnknownReadiness: true },
    })
  ).body;
  assertEq(queued.length, desired, `應排入 ${desired} 個生成任務`);
  const queuedIds = new Set(queued.map((j) => j.id));

  // 輪詢至全部進終態（真實影像生成較慢，給 10 分鐘上限）。
  const deadline = Date.now() + 600_000;
  let project;
  while (Date.now() < deadline) {
    project = await loadProject(client, projectId);
    const jobs = project.jobs.filter((j) => queuedIds.has(j.id));
    if (jobs.length && jobs.every((j) => ["completed", "failed", "cancelled"].includes(j.status)))
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const finalJobs = project.jobs.filter((j) => queuedIds.has(j.id));
  assert(
    finalJobs.length === desired && finalJobs.every((j) => j.status === "completed"),
    `全部生成任務應完成，實際 ${finalJobs.map((j) => `${j.status}/${j.errorCode ?? "-"}`).join(",")}`,
  );

  // 每頁：currentVersion 指向任務結果，imagePath 存在，抓回是 canvas 尺寸 PNG。
  for (const [i, slide] of project.slides.entries()) {
    const version = currentVersion(slide);
    assert(version, `第 ${i} 頁應有 currentVersion`);
    assert(
      typeof version.imagePath === "string" && version.imagePath.length > 0,
      `第 ${i} 頁 version.imagePath 應存在`,
    );
    const bytes = await fetchAsset(client, projectId, version.imagePath);
    assertPng(bytes, { width: 1920, height: 1080 }, `第 ${i} 頁資產`);
    await writeArtifact(`slide-${String(i + 1).padStart(2, "0")}.png`, bytes);
  }
}

// L2（影像層）：單頁重生 + 局部遮罩編輯。先對一頁 gpt-image-2 生成一個 base version
// （影像 1），再以一張「中央不透明、四周透明」的遮罩走 POST /edit-image 做局部編輯
// （影像 1）。
//
// 關鍵斷言（見 CLAUDE.md 與記憶）：gpt-image-2 經 CLIProxyAPI 時 mask 欄位會被忽略，
// 模型不會遵守局部約束——所以**不**斷言模型只改遮罩內。真正可保證的是 server 的
// compositeMaskedEdit：以 dest-in 保留遮罩不透明處的模型輸出、透明處回退 base 原像素，
// 因此**遮罩外的像素與 base 逐像素相同**。這才是本 spec 斷言的對象。
//
// 預期 API 呼叫：影像 2（單頁生成 1 + 局部編輯 1）。文字 0、搜尋 0。
import { assert, assertBytesEqual, assertPng } from "../lib/assert.mjs";
import { sharp } from "../lib/deps.mjs";
import { makeMaskPng } from "../lib/fixtures.mjs";
import { currentVersion, fetchAsset, loadProject } from "../lib/flows.mjs";

export const name = "l2-regenerate-edit";
export const layer = "l2";
export const needsLive = true;

/** 抽取一塊區域的解碼後原始像素（RGBA），用於逐像素比對（避免 PNG 編碼差異）。 */
async function regionRaw(bytes, region) {
  return new Uint8Array(
    await sharp(Buffer.from(bytes)).ensureAlpha().extract(region).raw().toBuffer(),
  );
}

async function waitForJob(client, projectId, jobId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const project = await loadProject(client, projectId);
    const job = project.jobs.find((j) => j.id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return { job, project };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`job ${jobId} 未在時限內進入終態`);
}

export default async function run({ client, options, writeArtifact }) {
  const combinationId = options?.combination ?? "e2e-gpt";

  const created = (
    await client.post("/api/projects", {
      json: {
        topic: "深海熱泉的生態系",
        brief: { desiredSlideCount: 3, webSearchMode: "disabled" },
      },
    })
  ).body;
  const projectId = created.id;
  const slideId = created.slides[0].id;

  await client.patch(`/api/projects/${projectId}/combination`, { json: { combinationId } });

  // ── 單頁生成 base version ───────────────────────────────────────────────────
  const genJob = (
    await client.post(`/api/projects/${projectId}/slides/${slideId}/generate`, {
      json: { acceptUnknownReadiness: true },
    })
  ).body;
  const genDone = await waitForJob(client, projectId, genJob.id);
  assert(
    genDone.job.status === "completed",
    `單頁生成應完成，實際 ${genDone.job.status}/${genDone.job.errorCode ?? "-"}`,
  );
  const providerId = genDone.job.providerId; // 組合解析出的影像 provider（= gpt-image-2）
  const baseSlide = genDone.project.slides.find((s) => s.id === slideId);
  const baseVersion = currentVersion(baseSlide);
  assert(baseVersion, "生成後應有 base currentVersion");
  const baseBytes = await fetchAsset(client, projectId, baseVersion.imagePath);
  assertPng(baseBytes, { width: 1920, height: 1080 }, "base 資產");
  await writeArtifact("base.png", baseBytes);

  // ── 局部遮罩編輯 ────────────────────────────────────────────────────────────
  // 遮罩：中央 400×400 不透明（允許編輯），四周透明（受保護）。
  const maskRegion = { left: 760, top: 340, width: 400, height: 400 };
  const maskPng = await makeMaskPng(1920, 1080, maskRegion);
  const maskDataUrl = `data:image/png;base64,${Buffer.from(maskPng).toString("base64")}`;

  const editJob = (
    await client.post(`/api/projects/${projectId}/slides/${slideId}/edit-image`, {
      json: {
        providerId,
        instruction: "把中央區域換成一隻發光的深海管蟲，其餘畫面維持不變。",
        maskDataUrl,
        acceptUnknownReadiness: true,
      },
    })
  ).body;
  // job 的內部 operation 欄位是 "edit"（"edit-image" 只是端點 URL 名）。這個斷言若寫錯
  // 字串會在 await job 之前就提前 throw，導致 harness 清掉 dataRoot、而背景 edit job 稍後
  // 才去讀 base image → ENOENT。務必與 jobs 的 operation 型別一致。
  assert(editJob.operation === "edit", `任務 operation 應為 edit，實際 ${editJob.operation}`);
  const editDone = await waitForJob(client, projectId, editJob.id);
  assert(
    editDone.job.status === "completed",
    `局部編輯應完成，實際 ${editDone.job.status}/${editDone.job.errorCode ?? "-"}`,
  );

  const editedSlide = editDone.project.slides.find((s) => s.id === slideId);
  const editedVersion = currentVersion(editedSlide);
  assert(editedVersion && editedVersion.id !== baseVersion.id, "編輯應產生新的 currentVersion");
  const editedBytes = await fetchAsset(client, projectId, editedVersion.imagePath);
  assertPng(editedBytes, { width: 1920, height: 1080 }, "edited 資產");
  await writeArtifact("edited.png", editedBytes);

  // ── 核心斷言：遮罩外像素零差異 ──────────────────────────────────────────────
  // 取一塊完全落在遮罩透明區的角落（左上 300×300，與中央不透明方塊無交集）。
  const outside = { left: 0, top: 0, width: 300, height: 300 };
  assert(
    outside.left + outside.width <= maskRegion.left,
    "取樣區必須完全在遮罩不透明方塊之外（保護區）",
  );
  const baseOutside = await regionRaw(baseBytes, outside);
  const editedOutside = await regionRaw(editedBytes, outside);
  assertBytesEqual(baseOutside, editedOutside, "遮罩外區域應與 base 逐像素相同");
}

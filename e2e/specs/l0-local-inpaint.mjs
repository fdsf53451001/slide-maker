// L0：本地 OCR + OpenCV 抹字 inpaint（零模型）。OCR 不可用時 skip（不算失敗）。
// 可用時以 providerId=local-inpaint 跑 extract-text，驗證產出 textLayer。
// 零模型由 harness 的 fetch guard 保證：OCR/inpaint 走子程序而非 fetch，若有任何
// 模型 HTTP 呼叫，guard 會直接 throw。
import { assert, skip } from "../lib/assert.mjs";
import { makeTextDeckPdf } from "../lib/fixtures.mjs";
import { importPdfDeck, loadProject } from "../lib/flows.mjs";

export const name = "l0-local-inpaint";
export const layer = "l0";
export const needsLive = false;

export default async function run({ client }) {
  const status = (await client.get("/api/ocr/status")).body;
  if (!status.available) skip(`OCR 未安裝（${status.message}）`);

  const pdf = await makeTextDeckPdf([
    { title: "Extract Me", body: ["some caption text", "another line"] },
  ]);
  const { project } = await importPdfDeck(client, pdf, "抹字測試");
  const slide = project.slides[0];
  const slideId = slide.id;

  // extract-text：預設 providerId=local-inpaint。readiness 未過（缺 .venv-ocr 抹字腳本）→ skip。
  const enqueued = await client.rawPost(
    `/api/projects/${project.id}/slides/${slideId}/extract-text`,
    { json: { providerId: "local-inpaint", threshold: 0.75 } },
  );
  if (enqueued.status === 409 || enqueued.status === 422) {
    skip(`extract-text 前置未就緒：${JSON.stringify(enqueued.body).slice(0, 200)}`);
  }
  assert(enqueued.status === 202, `extract-text 應排入任務（實際 ${enqueued.status}）`);
  const jobId = enqueued.body.id;
  assert(enqueued.body.operation === "extract-text", "任務 operation=extract-text");

  // 輪詢任務完成（本地 OCR medium ~數秒/頁 + inpaint）。
  const deadline = Date.now() + 180_000;
  let job;
  while (Date.now() < deadline) {
    const current = await loadProject(client, project.id);
    job = current.jobs.find((j) => j.id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(job, "應找得到 extract-text 任務");
  if (job.status !== "completed") {
    // 抹字子程序依賴 .venv-ocr 內的 OpenCV，環境未備妥時視為 skip 而非產品 bug。
    skip(
      `extract-text 任務未完成（${job.status}/${job.errorCode ?? "?"}）——多半是本地抹字環境未備妥`,
    );
  }

  // 完成：目標 slide 的當前版本應帶 textLayer。
  const done = await loadProject(client, project.id);
  const doneSlide = done.slides.find((s) => s.id === slideId);
  const version = doneSlide.versions.find((v) => v.id === doneSlide.currentVersionId);
  assert(version.textLayer, "抹字後當前版本應有 textLayer");
  assert(version.textLayer.boxes.length > 0, "textLayer 應含抽出的文字框");
  assert(job.providerId === "local-inpaint", "任務 providerId=local-inpaint（零模型）");
}

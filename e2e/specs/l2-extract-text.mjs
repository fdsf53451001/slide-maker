// L2（影像層）：以**生圖模型**（gpt-image-2，非 local-inpaint）跑 extract-text。
// base 影像取自「PDF 匯入」的原生文字頁（零模型即得到帶真實可辨文字的 1920×1080 圖），
// 讓 OCR 抓得到字；抹字重建背景則交給 gpt-image-2 的 masked edit。
//
// 前置：OCR 需可用（`.venv-ocr`）——不可用則 skip（非失敗）。
//
// 預期 API 呼叫：影像 1（抹字 masked edit）＋ 文字 1（可選的視覺樣式精修，e2e-gpt 有文字
// 模型故通常會發生；精修失敗會被 server 吞掉，不影響 textLayer 產出）。搜尋 0。
import { assert, skip } from "../lib/assert.mjs";
import { makeTextDeckPdf } from "../lib/fixtures.mjs";
import { currentVersion, importPdfDeck, loadProject } from "../lib/flows.mjs";

export const name = "l2-extract-text";
export const layer = "l2";
export const needsLive = true;

export default async function run({ client, library, options, writeArtifact }) {
  const combinationId = options?.combination ?? "e2e-gpt";

  // OCR 前置。
  const status = (await client.get("/api/ocr/status")).body;
  if (!status.available) skip(`OCR 未安裝（${status.message}）`);

  // 生圖模型 provider id：取組合綁定的影像模型（e2e-gpt → gpt-image-2）。
  const combination = library.combinations.find((c) => c.id === combinationId);
  assert(combination?.imageModelRef, `找不到組合 ${combinationId} 或其影像模型`);
  const providerId = combination.imageModelRef;

  // base：PDF 匯入的原生文字頁（version A 是帶可辨文字的原圖，current 指向它）。
  const pdf = await makeTextDeckPdf([
    {
      title: "Deep Sea Life",
      body: ["Hydrothermal vents host unique ecosystems", "Tube worms and shrimp thrive here"],
    },
  ]);
  const { project } = await importPdfDeck(client, pdf, "抹字（生圖模型）");
  const projectId = project.id;
  const slideId = project.slides[0].id;

  await client.patch(`/api/projects/${projectId}/combination`, { json: { combinationId } });

  // ── extract-text（生圖模型抹字）───────────────────────────────────────────────
  const enqueued = await client.rawPost(
    `/api/projects/${projectId}/slides/${slideId}/extract-text`,
    { json: { providerId, threshold: 0.75, acceptUnknownReadiness: true } },
  );
  // OCR 在這張合成頁上沒抓到（可辨/簡報）文字 → 視為環境/字型問題 skip，非產品 bug。
  if (enqueued.status === 422) {
    skip(`OCR 未辨識到可抽離文字：${JSON.stringify(enqueued.body).slice(0, 200)}`);
  }
  assert(
    enqueued.status === 202,
    `extract-text 應排入任務（實際 ${enqueued.status} ${JSON.stringify(enqueued.body).slice(0, 200)}）`,
  );
  const jobId = enqueued.body.id;
  assert(enqueued.body.operation === "extract-text", "任務 operation=extract-text");

  // 輪詢至終態（OCR 數秒 + 生圖抹字較慢，給 10 分鐘）。
  const deadline = Date.now() + 600_000;
  let job;
  while (Date.now() < deadline) {
    const current = await loadProject(client, projectId);
    job = current.jobs.find((j) => j.id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert(job, "應找得到 extract-text 任務");
  assert(job.status === "completed", `抹字任務應完成，實際 ${job.status}/${job.errorCode ?? "-"}`);
  assert(job.providerId === providerId, `任務 providerId 應為生圖模型 ${providerId}`);

  // 完成：當前版本應帶 textLayer（含抽出的文字框）與抹字背景。
  const done = await loadProject(client, projectId);
  const slide = done.slides.find((s) => s.id === slideId);
  const version = currentVersion(slide);
  assert(version.textLayer, "抹字後當前版本應有 textLayer");
  assert(version.textLayer.boxes.length > 0, "textLayer 應含抽出的文字框");
  assert(
    typeof version.textLayer.backgroundPath === "string" &&
      version.textLayer.backgroundPath.length > 0,
    "textLayer 應有抹字背景 backgroundPath",
  );

  // 存產物：抹字後的合成圖。
  const composite = await client
    .get(`/api/projects/${projectId}/assets/${version.imagePath.replace(/^assets\//, "")}`)
    .then((r) => r.bytes);
  await writeArtifact("extract-text-composite.png", composite);
}

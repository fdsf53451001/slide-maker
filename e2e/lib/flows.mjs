// 跨 spec 共用的高階流程：PDF 匯入、抓資產。避免每個 spec 重抄一遍 inspect→import。
import { assert } from "./assert.mjs";

/**
 * 跑完 /pdf-deck/inspect → /pdf-deck/import，回傳 { project, report, inspection }。
 * `pages` 未給時匯入所有 acceptedPages。
 */
export async function importPdfDeck(client, pdfBytes, name, pages) {
  const inspection = (await client.post("/api/pdf-deck/inspect", { bytes: pdfBytes })).body;
  const selected = pages ?? inspection.acceptedPages;
  assert(selected.length > 0, "inspect 沒有回傳任何 acceptedPages");
  const query = `?name=${encodeURIComponent(name)}&pages=${selected.join(",")}`;
  const imported = (await client.post(`/api/pdf-deck/import${query}`, { bytes: pdfBytes })).body;
  return { project: imported.project, report: imported.report, inspection };
}

/** 取某 slide 的 currentVersion 物件。 */
export function currentVersion(slide) {
  return slide.versions.find((v) => v.id === slide.currentVersionId);
}

/** 抓某個資產的原始位元組（imagePath 形如 assets/<slideId>/<versionId>.png）。 */
export async function fetchAsset(client, projectId, imagePath) {
  const rel = imagePath.replace(/^assets\//, "");
  const result = await client.get(`/api/projects/${projectId}/assets/${rel}`);
  return result.bytes;
}

/** 重新讀取專案。 */
export async function loadProject(client, projectId) {
  return (await client.get(`/api/projects/${projectId}`)).body;
}

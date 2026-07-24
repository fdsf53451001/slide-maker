// L0：可編輯文字層編輯、版本切換、restore、版本刪除（含被引用/當前版本的邊界拒絕）。
import { assert, assertEq, assertHttpError } from "../lib/assert.mjs";
import { makeTextDeckPdf } from "../lib/fixtures.mjs";
import { importPdfDeck, loadProject } from "../lib/flows.mjs";

export const name = "l0-text-layer";
export const layer = "l0";
export const needsLive = false;

export default async function run({ client }) {
  const pdf = await makeTextDeckPdf([
    { title: "Editable", body: ["line one", "line two"] },
    { title: "Second", body: ["second"] },
  ]);
  const { project } = await importPdfDeck(client, pdf, "文字層測試");
  const projectId = project.id;
  const slide = project.slides[0];
  const slideId = slide.id;
  const versionA = slide.versions.find((v) => v.id === slide.currentVersionId);
  const versionB = slide.versions.find((v) => v.id !== versionA.id);
  assert(versionB.textLayer, "version B 應有 textLayer");
  assert(versionB.textLayer.boxes.length > 0, "textLayer 應有文字框");

  // ── 編輯文字層 ────────────────────────────────────────────────────────────
  const boxes = structuredClone(versionB.textLayer.boxes);
  boxes[0].text = "EDITED HEADING";
  let updated = (
    await client.put(
      `/api/projects/${projectId}/slides/${slideId}/versions/${versionB.id}/text-layer`,
      {
        json: { boxes },
      },
    )
  ).body;
  let slideNow = updated.slides.find((s) => s.id === slideId);
  let versionBNow = slideNow.versions.find((v) => v.id === versionB.id);
  assertEq(versionBNow.textLayer.boxes[0].text, "EDITED HEADING", "文字層第一框已更新");
  assertEq(
    versionBNow.textLayer.renderRevision,
    versionB.textLayer.renderRevision + 1,
    "renderRevision 遞增",
  );
  assertEq(versionBNow.imagePath, versionBNow.textLayer.compositePath, "imagePath 指向新合成圖");

  // ── 版本切換（activate）───────────────────────────────────────────────────
  updated = (
    await client.post(
      `/api/projects/${projectId}/slides/${slideId}/versions/${versionB.id}/activate`,
    )
  ).body;
  assertEq(
    updated.slides.find((s) => s.id === slideId).currentVersionId,
    versionB.id,
    "切到 version B",
  );

  // ── restore version A → 產生新版本並成為 current ──────────────────────────
  updated = (
    await client.post(
      `/api/projects/${projectId}/slides/${slideId}/versions/${versionA.id}/restore`,
    )
  ).body;
  slideNow = updated.slides.find((s) => s.id === slideId);
  assertEq(slideNow.versions.length, 3, "restore 後 3 個版本");
  const restoredId = slideNow.currentVersionId;
  assert(restoredId !== versionA.id && restoredId !== versionB.id, "restore 產生的是新版本 id");

  // ── 版本刪除：先把 current 切到 B，再刪掉 restore 出來的版本（可刪）──────────
  await client.post(
    `/api/projects/${projectId}/slides/${slideId}/versions/${versionB.id}/activate`,
  );
  updated = (
    await client.delete(`/api/projects/${projectId}/slides/${slideId}/versions/${restoredId}`)
  ).body;
  slideNow = updated.slides.find((s) => s.id === slideId);
  assertEq(slideNow.versions.length, 2, "刪除 restored 版本後剩 2 個");

  // ── 邊界：不能刪當前版本（VERSION_IN_USE）──────────────────────────────────
  await assertHttpError(
    client.rawDelete(`/api/projects/${projectId}/slides/${slideId}/versions/${versionB.id}`),
    409,
    "VERSION_IN_USE",
  );

  // ── 邊界：不能刪被 textLayer 引用的原圖 A（VERSION_REFERENCED_BY_TEXT_LAYER）─
  // 先確認 A 不是 current（現在 current=B），再刪 → 應被守門擋下。
  const check = await loadProject(client, projectId);
  const s = check.slides.find((x) => x.id === slideId);
  assert(s.currentVersionId === versionB.id, "當前應為 B");
  await assertHttpError(
    client.rawDelete(`/api/projects/${projectId}/slides/${slideId}/versions/${versionA.id}`),
    409,
    "VERSION_REFERENCED_BY_TEXT_LAYER",
  );
}

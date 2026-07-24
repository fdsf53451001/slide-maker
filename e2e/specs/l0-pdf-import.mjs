// L0：PDF 匯入簡報（零模型路徑）。驗證 totalPages/acceptedPages、非 16:9 頁被 skip、
// 每頁兩個 version（A 原圖無 textLayer、B textLayer.originalVersionId→A、currentVersionId→A）、
// assets/pdf-import/source.pdf 存在、canvas 1920×1080；掃描頁只產生 A；
// >150 頁與非 16:9 全滅的拒絕路徑。
import { assert, assertEq, assertHttpError, assertPdf, assertPng } from "../lib/assert.mjs";
import {
  makeManyPageDeckPdf,
  makeMixedDeckPdf,
  makeNon169Pdf,
  makeScannedDeckPdf,
} from "../lib/fixtures.mjs";
import { currentVersion, fetchAsset, importPdfDeck } from "../lib/flows.mjs";

export const name = "l0-pdf-import";
export const layer = "l0";
export const needsLive = false;

export default async function run({ client, writeArtifact }) {
  // ── 混比例：2×16:9 帶文字 + 1×4:3 ─────────────────────────────────────────
  const mixed = await makeMixedDeckPdf([
    { ratio: "16:9", title: "Cover", body: ["opening line"] },
    { ratio: "16:9", title: "Second", body: ["supporting line"] },
    { ratio: "4:3", title: "Odd one out" },
  ]);
  await writeArtifact("mixed-deck.pdf", mixed);

  const inspection = (await client.post("/api/pdf-deck/inspect", { bytes: mixed })).body;
  assertEq(inspection.totalPages, 3, "totalPages=3");
  assertEq(inspection.acceptedPages, [1, 2], "acceptedPages=[1,2]（4:3 被排除）");
  assertEq(inspection.skippedPages, [3], "skippedPages=[3]");
  assertEq(inspection.truncated, false, "未截斷");

  const { project, report } = await importPdfDeck(
    client,
    mixed,
    "混比例匯入",
    inspection.acceptedPages,
  );
  assertEq(project.slides.length, 2, "匯入 2 頁");
  assertEq(project.workflowStage, "settings", "匯入後停在 settings");
  assertEq(project.canvas, { width: 1920, height: 1080 }, "canvas 1920×1080");
  assertEq(report.importedPages, [1, 2], "report.importedPages");
  assertEq(report.skippedPages, [3], "report.skippedPages");

  // 每頁：version A（current，無 textLayer）+ version B（textLayer.originalVersionId→A）。
  for (const slide of project.slides) {
    assertEq(slide.versions.length, 2, `slide ${slide.order} 應有兩個 version`);
    const versionA = slide.versions.find((v) => v.id === slide.currentVersionId);
    assert(versionA, "currentVersionId 指向存在的 version");
    assert(!versionA.textLayer, "version A（current）無 textLayer");
    const versionB = slide.versions.find((v) => v.id !== versionA.id);
    assert(versionB.textLayer, "version B 有 textLayer");
    assertEq(
      versionB.textLayer.originalVersionId,
      versionA.id,
      "version B 的 textLayer.originalVersionId 指向 A",
    );
    // 原圖保真：A 的資產是 1920×1080 PNG。
    const bytes = await fetchAsset(client, project.id, versionA.imagePath);
    assertPng(bytes, { width: 1920, height: 1080 }, `slide ${slide.order} version A`);
  }

  // assets/pdf-import/source.pdf 保留。
  const sourcePdf = (await client.get(`/api/projects/${project.id}/assets/pdf-import/source.pdf`))
    .bytes;
  assertPdf(sourcePdf, "保留的 PDF 原檔");

  // ── 掃描頁（無文字層）→ 只有 version A ─────────────────────────────────────
  const scanned = await makeScannedDeckPdf(2);
  const scan = await importPdfDeck(client, scanned, "掃描頁匯入");
  assertEq(scan.project.slides.length, 2, "掃描頁匯入 2 頁");
  for (const slide of scan.project.slides) {
    assertEq(slide.versions.length, 1, "掃描頁只有一個 version");
    const only = currentVersion(slide);
    assert(!only.textLayer, "掃描頁 version 無 textLayer");
    assertEq(slide.currentVersionId, only.id, "currentVersionId 指向唯一 version");
  }

  // ── 拒絕路徑：非 16:9 全滅 ─────────────────────────────────────────────────
  const non169 = await makeNon169Pdf();
  await assertHttpError(
    client.rawPost("/api/pdf-deck/inspect", { bytes: non169 }),
    400,
    "PDF_ASPECT_UNSUPPORTED",
  );

  // ── 拒絕路徑：>150 頁 ─────────────────────────────────────────────────────
  const huge = await makeManyPageDeckPdf(151);
  const hugeInspection = (await client.post("/api/pdf-deck/inspect", { bytes: huge })).body;
  assertEq(hugeInspection.totalPages, 151, "totalPages=151");
  assertEq(hugeInspection.acceptedPages.length, 150, "acceptedPages 上限 150");
  assertEq(hugeInspection.truncated, true, "truncated=true");
  // 要求匯入 151 頁 → 選擇無效（超過上限）。
  const allPages = Array.from({ length: 151 }, (_, i) => i + 1).join(",");
  await assertHttpError(
    client.rawPost(
      `/api/pdf-deck/import?name=${encodeURIComponent("too many")}&pages=${allPages}`,
      {
        bytes: huge,
      },
    ),
    400,
    "PDF_PAGE_SELECTION_INVALID",
  );
}

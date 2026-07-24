// L0：對 PDF 匯入的專案匯出四種格式，驗證 chunked（無 Content-Length）、png.zip 無損且與
// 原圖 byte-identical（停在 A、頁碼關閉）、pptx/pdf 內嵌 JPEG、slide-project 可重新匯入。
import {
  assert,
  assertBytesEqual,
  assertJpeg,
  assertPdf,
  assertPng,
  assertZip,
  assertZipEntries,
  unzip,
} from "../lib/assert.mjs";
import { makeTextDeckPdf } from "../lib/fixtures.mjs";
import { currentVersion, fetchAsset, importPdfDeck } from "../lib/flows.mjs";

export const name = "l0-export";
export const layer = "l0";
export const needsLive = false;

/** 匯出並斷言 chunked（沒有 Content-Length header）。回傳 bytes。 */
async function exportFormat(client, projectId, format) {
  const result = await client.get(`/api/projects/${projectId}/export/${format}`);
  assert(
    result.headers.get("content-length") === null,
    `匯出 ${format} 應為 chunked（不得有 Content-Length），實際=${result.headers.get("content-length")}`,
  );
  return result.bytes;
}

/** 掃描 zip 內是否至少有一個 JPEG（SOI 0xFFD8）entry。 */
function hasJpegEntry(files) {
  return Object.values(files).some(
    (bytes) => bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8,
  );
}

export default async function run({ client, writeArtifact }) {
  const pdf = await makeTextDeckPdf([
    { title: "Alpha", body: ["first slide"] },
    { title: "Beta", body: ["second slide"] },
    { title: "Gamma", body: ["third slide"] },
  ]);
  const { project } = await importPdfDeck(client, pdf, "匯出測試");
  assert(project.slides.length === 3, "應匯入 3 頁");

  // 停在 version A 的原圖位元組（頁碼預設關閉）。
  const originals = [];
  for (const slide of [...project.slides].sort((a, b) => a.order - b.order))
    originals.push(await fetchAsset(client, project.id, currentVersion(slide).imagePath));

  // ── png.zip：無損 + 與原圖 byte-identical ─────────────────────────────────
  const pngZip = await exportFormat(client, project.id, "png.zip");
  await writeArtifact("export.png.zip", pngZip);
  assertZip(pngZip, "png.zip");
  const zipFiles = assertZipEntries(pngZip, ["001.png", "002.png", "003.png"], "png.zip");
  for (let i = 0; i < 3; i += 1) {
    const entry = zipFiles[`${String(i + 1).padStart(3, "0")}.png`];
    assertPng(entry, { width: 1920, height: 1080 }, `png.zip entry ${i + 1}`);
    assertBytesEqual(entry, originals[i], `png.zip entry ${i + 1} 與原圖`);
  }

  // ── pptx：ZIP 容器 + 內嵌 JPEG ────────────────────────────────────────────
  const pptx = await exportFormat(client, project.id, "pptx");
  await writeArtifact("export.pptx", pptx);
  assertZip(pptx, "pptx");
  const pptxFiles = unzip(pptx);
  assert(hasJpegEntry(pptxFiles), "pptx 內應嵌 JPEG 影像");
  // 找出 JPEG media 並驗簽章。
  const jpeg = Object.values(pptxFiles).find((b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8);
  assertJpeg(jpeg, "pptx media");

  // ── pdf：%PDF- + DCTDecode（JPEG 內嵌）─────────────────────────────────────
  const pdfOut = await exportFormat(client, project.id, "pdf");
  await writeArtifact("export.pdf", pdfOut);
  assertPdf(pdfOut, "pdf 匯出");
  const pdfText = new TextDecoder("latin1").decode(pdfOut);
  assert(pdfText.includes("DCTDecode"), "pdf 應以 DCTDecode（JPEG）內嵌整版圖");

  // ── slide-project：ZIP + 可重新匯入 ───────────────────────────────────────
  const bundle = await exportFormat(client, project.id, "slide-project");
  await writeArtifact("export.slide-project", bundle);
  assertZip(bundle, "slide-project");
  const bundleFiles = unzip(bundle);
  assert(bundleFiles["project.json"], "slide-project 應含 project.json");
  assert(
    Object.keys(bundleFiles).some((n) => n.startsWith("assets/")),
    "slide-project 應含 assets/",
  );
  const reimported = (await client.post("/api/projects/import", { bytes: bundle })).body;
  assert(reimported.id !== project.id, "重新匯入產生新專案 id");
  assert(reimported.slides.length === 3, "重新匯入保留 3 頁");
}

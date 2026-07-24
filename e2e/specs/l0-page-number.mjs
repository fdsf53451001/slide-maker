// L0：頁碼系統合成。開啟後匯出的 PNG 與原圖不再 byte-identical、頁碼像素落在
// pageNumberLayout() 算出的區域內、排除頁確實無頁碼、所有設定選項都有覆蓋。
// 斷言一律由 core 的 pageNumberLabel()/pageNumberLayout()/pageNumberValue() 推導預期值，
// 不寫死幾何或標籤。
import {
  assert,
  assertBytesDiffer,
  assertBytesEqual,
  assertEq,
  assertMatch,
  averageColor,
} from "../lib/assert.mjs";
import { core } from "../lib/deps.mjs";
import { makeTextDeckPdf } from "../lib/fixtures.mjs";
import { currentVersion, fetchAsset, importPdfDeck } from "../lib/flows.mjs";

export const name = "l0-page-number";
export const layer = "l0";
export const needsLive = false;

const CANVAS = { width: 1920, height: 1080 };

async function exportPngZip(client, projectId) {
  const result = await client.get(`/api/projects/${projectId}/export/png.zip`);
  const { unzip } = await import("../lib/assert.mjs");
  return unzip(result.bytes);
}

function entryFor(files, order) {
  return files[`${String(order + 1).padStart(3, "0")}.png`];
}

/** 一個區域是否明顯偏離純白（代表有東西被合成上去）。 */
function isNonWhite(color) {
  return 255 - color.r > 20 || 255 - color.g > 20 || 255 - color.b > 20;
}

export default async function run({ client, writeArtifact }) {
  const pdf = await makeTextDeckPdf([
    { title: "Cover", body: ["cover"] },
    { title: "Body A", body: ["body a"] },
    { title: "Body B", body: ["body b"] },
  ]);
  const { project } = await importPdfDeck(client, pdf, "頁碼測試");
  const projectId = project.id;
  const slideCount = project.slides.length;
  const orderedSlides = [...project.slides].sort((a, b) => a.order - b.order);

  // 原圖（頁碼關閉時）。
  const originals = [];
  for (const slide of orderedSlides)
    originals.push(await fetchAsset(client, projectId, currentVersion(slide).imagePath));

  // ── 開啟頁碼：distinct 顏色 + 背景色塊，位置右下、跳過封面 ──────────────────
  const settings = {
    enabled: true,
    position: "bottom-right",
    format: "number",
    startAt: 1,
    skipFirstSlide: true,
    fontSize: 40,
    color: "#ff3366",
    opacity: 1,
    background: { enabled: true, color: "#0033ff", opacity: 0.6 },
  };
  let updated = (await client.patch(`/api/projects/${projectId}/page-number`, { json: settings }))
    .body;
  // server 回填的 pageNumber 就是真相，用它餵 core。
  const effective = updated.pageNumber;

  let files = await exportPngZip(client, projectId);
  await writeArtifact("page-number-on.png.zip", await encodeZip(files));

  for (const slide of orderedSlides) {
    const order = slide.order;
    const label = core.pageNumberLabel(effective, order, slideCount);
    const entry = entryFor(files, order);
    if (label === undefined) {
      // 排除頁（封面）：無頁碼 → 與原圖 byte-identical。
      assertBytesEqual(entry, originals[order], `排除頁 order=${order} 應無頁碼`);
    } else {
      // 有頁碼：與原圖不同（resize + 重編碼），且 layout 區域非白。
      assertBytesDiffer(entry, originals[order], `頁碼頁 order=${order} 應與原圖不同`);
      const layout = core.pageNumberLayout(effective, CANVAS, label);
      const region = layout.chip ?? layout.text;
      const color = await averageColor(entry, region);
      assert(isNonWhite(color), `order=${order} 的頁碼區域應非白（實測 ${JSON.stringify(color)}）`);
    }
  }

  // ── 位置選項覆蓋：三個位置各自的 layout 區域都要出現合成物 ──────────────────
  for (const position of ["bottom-left", "bottom-center", "bottom-right"]) {
    updated = (await client.patch(`/api/projects/${projectId}/page-number`, { json: { position } }))
      .body;
    files = await exportPngZip(client, projectId);
    const order = 1; // 非封面、必有頁碼
    const label = core.pageNumberLabel(updated.pageNumber, order, slideCount);
    const layout = core.pageNumberLayout(updated.pageNumber, CANVAS, label);
    const region = layout.chip ?? layout.text;
    const color = await averageColor(entryFor(files, order), region);
    assert(isNonWhite(color), `位置 ${position} 的頁碼區域應非白`);
  }

  // ── 格式選項覆蓋：標籤形狀由 core 決定 ─────────────────────────────────────
  const formatExpectations = {
    number: /^\d+$/,
    "number-total": /^\d+ \/ \d+$/,
    "zh-page": /^第 \d+ 頁$/,
  };
  for (const [format, shape] of Object.entries(formatExpectations)) {
    updated = (await client.patch(`/api/projects/${projectId}/page-number`, { json: { format } }))
      .body;
    const label = core.pageNumberLabel(updated.pageNumber, 1, slideCount);
    assertMatch(label, shape, `format=${format} 標籤形狀`);
  }

  // ── startAt 覆蓋：語意由 core.pageNumberValue 決定 ─────────────────────────
  updated = (
    await client.patch(`/api/projects/${projectId}/page-number`, {
      json: { format: "number", startAt: 5 },
    })
  ).body;
  // skipFirstSlide=true 時 order=1 是第一個有編號的頁 → 值應等於 startAt。
  assertEq(core.pageNumberValue(updated.pageNumber, 1), 5, "startAt=5 時 order=1 的頁碼值");
  assertEq(core.pageNumberLabel(updated.pageNumber, 0, slideCount), undefined, "封面仍不編號");

  // ── skipFirstSlide 覆蓋：關閉後封面也會被編號 ─────────────────────────────
  updated = (
    await client.patch(`/api/projects/${projectId}/page-number`, {
      json: { skipFirstSlide: false, startAt: 1 },
    })
  ).body;
  assert(
    core.pageNumberLabel(updated.pageNumber, 0, slideCount) !== undefined,
    "skipFirstSlide=false 後封面應有頁碼",
  );
  files = await exportPngZip(client, projectId);
  assertBytesDiffer(entryFor(files, 0), originals[0], "封面被編號後應與原圖不同");
}

// zip 重新編碼只為了把「開啟頁碼」的產物落進 artifacts；用 fflate 直接壓回。
async function encodeZip(files) {
  const { fflate } = await import("../lib/deps.mjs");
  return fflate.zipSync(files, { level: 6 });
}

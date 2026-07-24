// L0：專案生命週期（建立/列表/讀取/改名/brief/組合綁定/刪除）、投影片
// （新增/複製/刪除/reorder）、來源（txt/md/png 上傳 + PATCH/DELETE + /search 檢索）。
import { assert, assertEq, assertHttpError } from "../lib/assert.mjs";
import { makePng, makeText } from "../lib/fixtures.mjs";

export const name = "l0-project-crud";
export const layer = "l0";
export const needsLive = false;

export default async function run({ client }) {
  // ── 建立 ──────────────────────────────────────────────────────────────────
  const created = (
    await client.post("/api/projects", {
      json: { topic: "E2E 專案", brief: { desiredSlideCount: 4 } },
    })
  ).body;
  const projectId = created.id;
  assertEq(created.workflowStage, "requirements", "新專案在 requirements 階段");
  assertEq(created.slides.length, 4, "brief.desiredSlideCount=4 應產出 4 頁大綱");

  // ── 列表 / 讀取 ────────────────────────────────────────────────────────────
  const list = (await client.get("/api/projects")).body;
  assert(
    list.some((p) => p.id === projectId),
    "列表應含新專案",
  );
  const fetched = (await client.get(`/api/projects/${projectId}`)).body;
  assertEq(fetched.id, projectId, "讀取單一專案");

  // ── 改名 / brief / 組合綁定 ────────────────────────────────────────────────
  let project = (
    await client.patch(`/api/projects/${projectId}/name`, { json: { name: "改名後" } })
  ).body;
  assertEq(project.name, "改名後", "專案改名");
  project = (
    await client.patch(`/api/projects/${projectId}/brief`, { json: { audience: "工程團隊" } })
  ).body;
  assertEq(project.brief.audience, "工程團隊", "brief 更新");
  project = (
    await client.patch(`/api/projects/${projectId}/combination`, {
      json: { combinationId: "e2e-mock" },
    })
  ).body;
  assertEq(project.combinationId, "e2e-mock", "組合綁定");
  // 綁定不存在的組合 → 409 COMBINATION_NOT_FOUND。
  await assertHttpError(
    client.rawPatch(`/api/projects/${projectId}/combination`, { json: { combinationId: "nope" } }),
    409,
    "COMBINATION_NOT_FOUND",
  );

  // ── 投影片：新增 / 複製 / reorder / 刪除 ────────────────────────────────────
  const firstSlideId = project.slides[0].id;
  project = (
    await client.post(`/api/projects/${projectId}/slides`, {
      json: { purpose: "新增頁", afterSlideId: firstSlideId },
    })
  ).body;
  assertEq(project.slides.length, 5, "新增後 5 頁");
  assertEq(project.slides[1].purpose, "新增頁", "新頁插在第 1 頁之後");
  // order 連續。
  assertEq(
    project.slides.map((s) => s.order),
    [0, 1, 2, 3, 4],
    "order 連續",
  );

  const dup = (await client.post(`/api/projects/${projectId}/slides/${firstSlideId}/duplicate`))
    .body;
  assertEq(dup.slides.length, 6, "複製後 6 頁");

  // reorder：反轉。
  const ids = dup.slides.map((s) => s.id);
  const reversed = [...ids].reverse();
  project = (
    await client.post(`/api/projects/${projectId}/slides/reorder`, { json: { slideIds: reversed } })
  ).body;
  assertEq(
    project.slides.map((s) => s.id),
    reversed,
    "reorder 後順序反轉",
  );
  // reorder 缺 id → INVALID_SLIDE_ORDER。
  await assertHttpError(
    client.rawPost(`/api/projects/${projectId}/slides/reorder`, {
      json: { slideIds: reversed.slice(1) },
    }),
    409,
    "INVALID_SLIDE_ORDER",
  );

  const toDelete = project.slides[0].id;
  project = (await client.delete(`/api/projects/${projectId}/slides/${toDelete}`)).body;
  assertEq(project.slides.length, 5, "刪除後 5 頁");

  // ── 來源：上傳 txt / md / png ──────────────────────────────────────────────
  const txtBody = "The quick brown fox jumps over the lazy dog. Slidemaker retrieval test.";
  project = (
    await client.post(
      `/api/projects/${projectId}/sources?name=${encodeURIComponent("notes.txt")}&mediaType=${encodeURIComponent("text/plain")}`,
      { bytes: makeText(txtBody) },
    )
  ).body;
  const txtSource = project.sources.find((s) => s.name === "notes.txt");
  assert(txtSource, "txt 來源已建立");
  assertEq(txtSource.status, "indexed", "txt 來源 indexed");

  project = (
    await client.post(
      `/api/projects/${projectId}/sources?name=${encodeURIComponent("doc.md")}&mediaType=${encodeURIComponent("text/markdown")}`,
      { bytes: makeText("# Heading\n\nMarkdown source body for slidemaker.") },
    )
  ).body;
  assert(
    project.sources.some((s) => s.name === "doc.md"),
    "md 來源已建立",
  );

  project = (
    await client.post(
      `/api/projects/${projectId}/sources?name=${encodeURIComponent("pic.png")}&mediaType=${encodeURIComponent("image/png")}`,
      { bytes: await makePng(320, 180) },
    )
  ).body;
  const pngSource = project.sources.find((s) => s.name === "pic.png");
  assert(pngSource, "png 來源已建立");
  assertEq(pngSource.status, "indexed", "png 來源 indexed");

  // ── /search 檢索 ──────────────────────────────────────────────────────────
  const results = (await client.get(`/api/projects/${projectId}/search?q=quick`)).body;
  assert(Array.isArray(results) && results.length > 0, "檢索應有結果");
  assert(
    results.some((r) => r.sourceId === txtSource.id),
    "檢索命中 txt 來源",
  );

  // ── 來源 PATCH / DELETE ────────────────────────────────────────────────────
  project = (
    await client.patch(`/api/projects/${projectId}/sources/${txtSource.id}`, {
      json: { usage: "exclude-from-generation" },
    })
  ).body;
  assertEq(
    project.sources.find((s) => s.id === txtSource.id).usage,
    "exclude-from-generation",
    "來源 usage PATCH",
  );
  project = (await client.delete(`/api/projects/${projectId}/sources/${pngSource.id}`)).body;
  assert(!project.sources.some((s) => s.id === pngSource.id), "png 來源刪除");

  // ── 刪除專案 ──────────────────────────────────────────────────────────────
  await client.delete(`/api/projects/${projectId}`);
  await assertHttpError(client.rawGet(`/api/projects/${projectId}`), 404);
}

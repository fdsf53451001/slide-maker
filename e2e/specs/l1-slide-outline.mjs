// L1（文字層）：單頁大綱重生。用一個「已有大綱」的專案——`createProject` 在建立當下
// 就會用 brief 產出 N 頁決定性的佔位大綱（零模型），所以不必先跑整份 /outline 就有頁可改。
// 對中間那一頁呼叫 POST /slides/:id/outline，驗證「只有該頁 content 變、其他頁不動」。
//
// 預期 API 呼叫：文字 1（單頁重寫；伺服器對超長內容最多重試 3 次）。搜尋 0。
// 註：本 spec 不呼叫整份 /outline，故沒有額外的文字/搜尋配額。
import { assert, assertEq } from "../lib/assert.mjs";
import { makeText } from "../lib/fixtures.mjs";

export const name = "l1-slide-outline";
export const layer = "l1";
export const needsLive = true;

export default async function run({ client, options }) {
  const combinationId = options?.combination ?? "e2e-gpt";

  // 3 頁佔位大綱（createProject 直接由 brief 決定性產生）。
  const created = (
    await client.post("/api/projects", {
      json: {
        topic: "咖啡萃取的變因",
        brief: { desiredSlideCount: 3, webSearchMode: "disabled" },
      },
    })
  ).body;
  const projectId = created.id;
  assertEq(created.slides.length, 3, "建立時應有 3 頁佔位大綱");

  await client.patch(`/api/projects/${projectId}/combination`, { json: { combinationId } });

  // 上傳來源，讓單頁重生有內容可引用。
  await client.post(
    `/api/projects/${projectId}/sources?name=${encodeURIComponent("coffee.txt")}&mediaType=${encodeURIComponent("text/plain")}`,
    {
      bytes: makeText(
        [
          "咖啡萃取受水溫、研磨粗細、粉水比與萃取時間共同影響。",
          "水溫越高、研磨越細，萃取速度越快，過度萃取會帶出苦澀。",
          "常見的粉水比約在 1:15 到 1:17 之間，依沖煮方式調整。",
        ].join("\n"),
      ),
    },
  );

  // 重生前的基準快照（content 逐頁記下）。
  const before = (await client.get(`/api/projects/${projectId}`)).body;
  const target = before.slides[1];
  const beforeContent = before.slides.map((s) => s.content);

  // ── 單頁重生 ────────────────────────────────────────────────────────────────
  const project = (
    await client.post(`/api/projects/${projectId}/slides/${target.id}/outline`, { json: {} })
  ).body;

  const afterTarget = project.slides.find((s) => s.id === target.id);
  assert(afterTarget, "重生後仍應找得到目標頁");
  assertEq(afterTarget.purpose, target.purpose, "單頁重生不得更動頁面 purpose");
  assert(
    typeof afterTarget.content === "string" && afterTarget.content.trim().length > 0,
    "重生後 content 應為非空字串",
  );
  assert(afterTarget.content !== beforeContent[1], "目標頁 content 應已改變");

  // 其餘頁不得被更動。
  for (const slide of project.slides) {
    if (slide.id === target.id) continue;
    const original = before.slides.find((s) => s.id === slide.id);
    assert(original, "重生不得新增或刪除頁");
    assertEq(slide.content, original.content, `非目標頁 ${slide.order} 的 content 不得變動`);
  }
}

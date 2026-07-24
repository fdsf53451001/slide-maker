// L1（搜尋層）：網路搜尋候選來源。綁 e2e-gpt 組合後呼叫 POST /projects/:id/web-search，
// 驗證回傳候選來源的結構（url 是可讀的 http(s) 網址、title/summary 非空）。
//
// 預期 API 呼叫：搜尋 1（端點只呼叫一次 searchFor，無重試迴圈）。文字 0、影像 0。
//
// 關於「verified」語意（見 CLAUDE.md）：**本端點只回搜尋候選，不抓網頁正文**——
// 回傳的每筆是 webSearchResultSchema（url/title/summary），伺服器僅以 isReadableWebUrl
// 過濾掉不可抓取的網址，並未實際抓取驗證。真正的「抓取正文才算 verified」發生在
// materializeWebSources（POST /web-sources 與 /outline 的 verifiedResults）。因此這裡
// 斷言的是「候選結構 + 網址可讀」這層不變式，不對是否已抓取正文做斷言（那要打
// /web-sources，會另外消耗抓取預算）。
import { assert } from "../lib/assert.mjs";

export const name = "l1-web-search";
export const layer = "l1";
export const needsLive = true;

export default async function run({ client, options }) {
  const combinationId = options?.combination ?? "e2e-gpt";

  const created = (
    await client.post("/api/projects", {
      json: { topic: "James Webb 太空望遠鏡的科學發現", brief: { desiredSlideCount: 3 } },
    })
  ).body;
  const projectId = created.id;

  await client.patch(`/api/projects/${projectId}/combination`, { json: { combinationId } });

  // ── 網路搜尋 ────────────────────────────────────────────────────────────────
  const results = (
    await client.post(`/api/projects/${projectId}/web-search`, {
      json: { query: "James Webb Space Telescope discoveries", limit: 5 },
    })
  ).body;

  assert(Array.isArray(results), "web-search 應回傳陣列");
  // 搜尋可能因外部服務空手而回（罕見）；有結果時逐筆驗證候選結構。
  assert(results.length > 0, `web-search 應回傳至少一筆候選（實際 ${results.length}）`);
  assert(results.length <= 5, `回傳筆數不得超過 limit（實際 ${results.length}）`);

  for (const [i, item] of results.entries()) {
    assert(
      typeof item.url === "string" && /^https?:\/\//.test(item.url),
      `第 ${i} 筆 url 應為 http(s) 網址（實際 ${JSON.stringify(item.url)}）`,
    );
    assert(
      typeof item.title === "string" && item.title.trim().length > 0,
      `第 ${i} 筆 title 應為非空字串`,
    );
    assert(
      typeof item.summary === "string" && item.summary.trim().length > 0,
      `第 ${i} 筆 summary 應為非空字串`,
    );
  }
}

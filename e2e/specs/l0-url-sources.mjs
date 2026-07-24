// L0：貼上網址通道 POST /api/projects/:projectId/url-sources（body `{ urls: string[] }`，
// 1..10 筆）。
//
// 這條端點走 materializeWebSources。**重要的零配額前提**：只有「通過抓取前驗證」的網址才
// 會進 materialize→capture；而 capture 的 render fallback（預設 Jina）在 L0 harness 下**會真的
// 對外連線**（renderer 於 createApp 開機時就把當下的 `fetch` 存進閉包，早於 harness 安裝
// zero-quota guard，故繞過 guard——見本次 QA 報告的 finding）。因此本 spec **一律只送注定在
// 抓取前就失敗的網址**：這類批次的 accepted 為空，materialize 直接被略過，全程零對外 fetch，
// 既零配額又完全確定性。
//
// 覆蓋的合約邊界（皆不需外連即可定論）：
//   ① 輸入驗證（zod）→ 400 INVALID_REQUEST（空陣列、超過 10 筆、非字串、缺欄位、空白字串）。
//   ② hash routing 網址（**抓取前**判）→ WEB_SOURCE_HASH_ROUTE_UNSUPPORTED。
//   ③ 私有／非 http(s)／無法解析（**抓取前** SSRF 防線）→
//      WEB_SOURCE_URL_PRIVATE / WEB_SOURCE_URL_UNSUPPORTED / WEB_SOURCE_URL_INVALID。
//   ④ 全部失敗 → 400 URL_SOURCES_UNVERIFIED，逐筆失敗清單回報「使用者原本輸入的那一行」；
//      並驗 10 筆上限為**含**（10 筆通過 zod、逐筆回報）。
//
// 刻意留給 L1（needsLive）的：**真的抓到正文而加入來源**的成功路徑、擷取後 canonical 化的
// 去重，以及「materialize 路徑上的 asTyped 正規化→原輸入」對映——三者都必然涉及對外連線，
// L0 無法在不違反零配額的前提下驗證。此處不寫任何「假成功」的永真斷言。
import { assert, assertHttpError } from "../lib/assert.mjs";

export const name = "l0-url-sources";
export const layer = "l0";
export const needsLive = false;

const ENDPOINT = (projectId) => `/api/projects/${projectId}/url-sources`;

/** 送出一批「注定在抓取前失敗」的網址，斷言 400 URL_SOURCES_UNVERIFIED，回傳 failures 陣列。 */
async function postAllFail(client, projectId, urls) {
  const { body } = await assertHttpError(
    client.rawPost(ENDPOINT(projectId), { json: { urls } }),
    400,
    "URL_SOURCES_UNVERIFIED",
  );
  assert(Array.isArray(body.failures), "URL_SOURCES_UNVERIFIED 回應應帶 failures 陣列");
  return body.failures;
}

/** 斷言 failures 內恰有一筆 url === 使用者輸入的那一行，且 reason === 預期碼。 */
function assertFailure(failures, typedUrl, expectedReason) {
  const hit = failures.find((f) => f.url === typedUrl);
  assert(
    hit,
    `失敗清單應含使用者輸入的那一行 ${JSON.stringify(typedUrl)}（實際 ${JSON.stringify(
      failures.map((f) => f.url),
    )}）`,
  );
  assert(
    hit.reason === expectedReason,
    `${typedUrl} 的失敗碼應為 ${expectedReason}（實際 ${JSON.stringify(hit.reason)}）`,
  );
}

export default async function run({ client }) {
  const created = (
    await client.post("/api/projects", {
      json: { topic: "URL 來源通道 E2E", brief: { desiredSlideCount: 2 } },
    })
  ).body;
  const projectId = created.id;

  // ── ① 輸入驗證（zod）→ 400 INVALID_REQUEST ────────────────────────────────
  // urls 的 schema：z.array(z.string().trim().min(1).max(2000)).min(1).max(10)。
  // 這些在 body parse 階段就丟 ZodError，根本進不到 materialize，零對外 fetch。
  const invalidBodies = [
    { urls: [] }, // min(1)
    { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/p${i}`) }, // max(10)
    { urls: [123] }, // 元素非字串
    { urls: ["   "] }, // trim().min(1)
    { urls: "https://example.com/" }, // 非陣列
    {}, // 缺 urls
  ];
  for (const json of invalidBodies) {
    await assertHttpError(client.rawPost(ENDPOINT(projectId), { json }), 400, "INVALID_REQUEST");
  }

  // ── ② hash routing → WEB_SOURCE_HASH_ROUTE_UNSUPPORTED（抓取前判定）─────────
  // fragment 不會送到伺服器，抓回來的必然是首頁而非使用者要的那一頁，故明確判失敗。
  {
    const hashUrls = ["https://example.com/#/app", "https://example.com/#!/x"];
    const failures = await postAllFail(client, projectId, hashUrls);
    assert(
      failures.length === hashUrls.length,
      `hash 批次應逐筆回報失敗（預期 ${hashUrls.length}，實際 ${failures.length}）`,
    );
    for (const url of hashUrls) assertFailure(failures, url, "WEB_SOURCE_HASH_ROUTE_UNSUPPORTED");
  }

  // ── ③ 私有／非 http(s)／無法解析 → 對應失敗碼（抓取前 SSRF 防線）─────────────
  {
    const cases = [
      ["http://127.0.0.1/", "WEB_SOURCE_URL_PRIVATE"], // loopback
      ["http://10.0.0.1/", "WEB_SOURCE_URL_PRIVATE"], // 私有網段
      ["http://localhost/", "WEB_SOURCE_URL_PRIVATE"], // localhost 主機名
      ["ftp://x", "WEB_SOURCE_URL_UNSUPPORTED"], // 非 http(s) 協定
      ["not-a-valid-url", "WEB_SOURCE_URL_INVALID"], // new URL() 解析失敗
    ];
    const failures = await postAllFail(
      client,
      projectId,
      cases.map(([url]) => url),
    );
    assert(
      failures.length === cases.length,
      `私有/非法批次應逐筆回報失敗（預期 ${cases.length}，實際 ${failures.length}）`,
    );
    for (const [url, reason] of cases) assertFailure(failures, url, reason);
  }

  // ── ④ 10 筆上限為含；逐筆失敗回報「使用者輸入的那一行」──────────────────────
  // 抓取前失敗清單一律用 raw（使用者原輸入）回報，故此處直接驗到「回報原輸入」這條合約；
  // materialize 路徑上正規化網址反查原輸入（asTyped）需外連，留待 L1。
  {
    const tenPrivate = Array.from({ length: 10 }, (_, i) => `http://10.0.0.${i + 1}/`);
    const failures = await postAllFail(client, projectId, tenPrivate);
    assert(
      failures.length === 10,
      `10 筆（上限含）應通過 zod 並逐筆回報（實際 ${failures.length}）`,
    );
    for (const url of tenPrivate) assertFailure(failures, url, "WEB_SOURCE_URL_PRIVATE");
  }

  await client.delete(`/api/projects/${projectId}`);
}

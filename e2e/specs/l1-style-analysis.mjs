// L1（文字層）：風格參考圖分析。上傳 1 張 PNG 參考圖成 style-asset，再走
// POST /style-analysis（帶 e2e-gpt 組合）。驗證回傳的 designSystem 非空、且含「色票」段
// （renderDesignSystem 缺色票會直接丟 STYLE_ANALYSIS_INCOMPLETE，故成功回應即代表
// palette 有內容）。avoid 為字串陣列。
//
// 預期 API 呼叫：文字 1（風格分析是單次結構化輸出，伺服器端無重試迴圈）。
// 註：若組合無可用文字模型會回 STYLE_ANALYSIS_DISABLED——正常路徑（e2e-gpt 有
// 文字模型）不該遇到；遇到時視為環境/組合問題直接讓 client.post 丟出（帶 status+code）。
import { assert } from "../lib/assert.mjs";
import { makePng } from "../lib/fixtures.mjs";

export const name = "l1-style-analysis";
export const layer = "l1";
export const needsLive = true;

export default async function run({ client, options }) {
  const combinationId = options?.combination ?? "e2e-gpt";

  // 上傳一張 16:9 參考圖成 style-asset（/api/style-assets 走 raw body + query 參數）。
  const png = await makePng(1920, 1080, { r: 20, g: 40, b: 90 });
  const reference = (
    await client.post(
      `/api/style-assets?name=${encodeURIComponent("ref.png")}&mediaType=${encodeURIComponent("image/png")}`,
      { bytes: png },
    )
  ).body;
  assert(reference.id, "style-asset 應回傳含 id 的參考圖");

  // ── 風格分析 ────────────────────────────────────────────────────────────────
  const analysis = (
    await client.post("/api/style-analysis", {
      json: { referenceIds: [reference.id], combinationId },
    })
  ).body;

  // designSystem 是排版後的 markdown 字串；非空即代表模型交出了實質設計系統。
  assert(
    typeof analysis.designSystem === "string" && analysis.designSystem.trim().length > 0,
    "designSystem 應為非空字串",
  );
  // renderDesignSystem 一定會排入「## 色票」段（palette 空會先丟錯），故成功回應必含它。
  assert(
    analysis.designSystem.includes("色票"),
    `designSystem 應含色票段（palette 有內容）——實際開頭：${analysis.designSystem.slice(0, 120)}`,
  );
  assert(Array.isArray(analysis.avoid), "avoid 應為陣列");
}

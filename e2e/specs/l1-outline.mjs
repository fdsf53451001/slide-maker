// L1（文字層）：整份大綱生成。建專案 + brief + 綁 e2e-gpt 組合，上傳一份 txt 來源，
// 呼叫 POST /outline，驗證回傳大綱的「結構與不變式」——不對模型自由文字做脆弱比對。
//
// 預期 API 呼叫：文字 1（內容超長時最多重寫 3 次）。搜尋 0——本 spec 刻意把
// brief.webSearchMode 設為 "disabled"，讓 gatherWebSources 直接回 [] 省下搜尋配額；
// 大綱因此只吃上傳的 txt 來源。這是 L1 最省的一支（單一文字呼叫）。
import { assert, assertEq } from "../lib/assert.mjs";
import { makeText } from "../lib/fixtures.mjs";

export const name = "l1-outline";
export const layer = "l1";
export const needsLive = true;

export default async function run({ client, options }) {
  const combinationId = options?.combination ?? "e2e-gpt";
  const desired = options?.slides ?? 3;

  // 建專案：真實可搜尋主題，但把搜尋關掉（走純上傳來源）。
  const created = (
    await client.post("/api/projects", {
      json: {
        topic: "太陽能板的運作原理與效率",
        brief: { desiredSlideCount: desired, webSearchMode: "disabled" },
      },
    })
  ).body;
  const projectId = created.id;
  assertEq(created.workflowStage, "requirements", "新專案在 requirements 階段");

  // 綁定 live 組合（e2e-gpt：影像 gpt-image-2、文字/搜尋 gpt-5.6-luna）。
  await client.patch(`/api/projects/${projectId}/combination`, { json: { combinationId } });

  // 上傳一份 txt 來源，讓大綱有可引用的內容、且 sourceIds 有東西可連。
  const sourceBody = [
    "太陽能板由許多光伏電池（photovoltaic cell）組成，主要材料是矽。",
    "當陽光照射到電池，光子把電子從矽原子中激發出來，形成電流，這稱為光電效應。",
    "商用單晶矽面板的轉換效率約在 20% 到 23% 之間，實驗室紀錄更高。",
    "面板效率會隨溫度上升而下降，因此散熱與安裝角度會影響實際發電量。",
    "逆變器負責把面板產生的直流電轉換成家庭與電網使用的交流電。",
  ].join("\n");
  await client.post(
    `/api/projects/${projectId}/sources?name=${encodeURIComponent("solar.txt")}&mediaType=${encodeURIComponent("text/plain")}`,
    { bytes: makeText(sourceBody) },
  );

  // ── 生成大綱 ────────────────────────────────────────────────────────────────
  const project = (await client.post(`/api/projects/${projectId}/outline`, { json: {} })).body;

  // 頁數落在伺服器允許區間 [desired-2, desired+2]（且 ≥1）。
  const min = Math.max(1, desired - 2);
  const max = desired + 2;
  const count = project.slides.length;
  assert(count >= min && count <= max, `大綱頁數應落在 [${min}, ${max}]，實際 ${count}`);

  // 每頁的結構不變式：purpose / content / narrative / layoutHint 皆為非空字串。
  for (const [i, slide] of project.slides.entries()) {
    for (const field of ["purpose", "content", "narrative", "layoutHint"]) {
      assert(
        typeof slide[field] === "string" && slide[field].trim().length > 0,
        `第 ${i} 頁的 ${field} 應為非空字串`,
      );
    }
    assert(Array.isArray(slide.sourceIds), `第 ${i} 頁 sourceIds 應為陣列`);
  }

  // 至少一頁把 sourceIds 連到上傳的來源（webSearchMode=disabled 時來源只有這一份 txt）。
  const uploaded = project.sources.find((s) => s.name === "solar.txt");
  assert(uploaded, "上傳的 txt 來源應仍在專案內");
  const linked = project.slides.some((s) => s.sourceIds.includes(uploaded.id));
  assert(linked, "應至少有一頁的 sourceIds 連到上傳來源");

  // 生成後工作流階段推進到 settings。
  assertEq(project.workflowStage, "settings", "大綱生成後 workflowStage=settings");
}

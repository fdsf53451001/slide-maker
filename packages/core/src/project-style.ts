import type { PresentationProject } from "./schemas.js";

/**
 * 專案本地風格 fork 的 id。
 *
 * **凡是把「只屬於這個專案」的東西寫進 `styleSnapshot` 的路徑，都必須先 fork 成這個 id。**
 * 理由不是命名整潔而是保命：`refreshStyleForGeneration()` 在每次生成前拿
 * `styles.get(styleSnapshot.id)` 比對版本，版本一不同就 `structuredClone(latest)` 整包蓋掉。
 * 風格庫裡沒有這個 id，那道同步因此查不到、也就蓋不掉。
 *
 * 留在庫裡的 id（例如 `ai-free-design`）只是「目前兩邊版本號剛好相同」在擋著，而那是巧合：
 * 使用者到風格庫改一次 `avoid` 就 version+1，下一次生成時專案專屬的那份設計系統會**靜默
 * 消失**——而且那時 `POST /outline` 已被 `OUTLINE_HAS_GENERATED_VERSIONS` 擋住，沒有復原
 * 路徑，前端也還顯示著 `styleDirection: {applied:true}`。
 *
 * 名字裡的 `pdf-` 是歷史包袱（第一個用它的是 PDF 匯入的分析頁），現在參考圖分析與
 * 「AI 自由設計」的風格決議共用同一個。**字串不可改**：既有專案的 `project.json` 存著它。
 *
 * 住在 `packages/core` 而不是伺服器，是因為編輯器也要認得它：風格庫頁的「AI 產生」區就是
 * 「`styleSnapshot.id` 等於這個 id」的專案清單。前端自己抄一份 `` `pdf-style-${id}` `` 不會有
 * 任何測試發現它過期——`SOURCES 175/100` 正是這樣來的。
 */
export function projectStyleId(projectId: string): string {
  return `pdf-style-${projectId}`;
}

/**
 * 這份專案用的是它自己 fork 出來的風格（AI 產生、風格庫查不到），而不是庫裡的某個風格。
 *
 * 兩端都要問同一個問題：伺服器據此判定「這批參考圖是專案自己建的、換掉之後可以刪」
 * （`ownedStyleReferences`），編輯器據此列出風格庫頁的「AI 產生」區。
 */
export function isProjectLocalStyle(project: PresentationProject): boolean {
  return project.styleSnapshot.id === projectStyleId(project.id);
}

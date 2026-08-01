/**
 * 設計系統 markdown 的段落標題。
 *
 * **這是伺服器的排版端（`apps/server/src/style-analysis.ts` 的 `renderDesignSystem()`）與
 * 影像合約（`image-contract.ts`）之間唯一的一份真相。** 合約裡有一句話的形狀是「凡是
 * **不在**『每頁自由決定』底下的都是不可協商的」——那句話要成立，合約引用的標題就必須
 * 逐字等於排版端印出來的那一個。兩邊各寫一份字串的話，改標題之後合約會指著一個不存在的
 * 段落，於是**整份設計系統都退化成可自由發揮**，而且完全靜默：圖照樣生得出來，只是又回到
 * 一頁黑一頁白。這與 `SOURCE_COUNT_LIMIT` 那批常數住在 core 是同一條理由，只是這裡的
 * 「兩端」是排版端與 prompt 端而非前後端。
 *
 * 標題是中文而合約是英文，這是刻意的：合約要引用的是**字面**，翻譯過去就對不上了。
 */
export const DESIGN_SYSTEM_SECTIONS = {
  rationale: "設計思路",
  invariants: "不可協商：每一頁都必須相同",
  pageTypeRules: "依頁型：這一頁是哪一種就套哪一段",
  freeChoices: "每頁自由決定：鼓勵各頁不同",
} as const;

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

/**
 * 整份簡報的明暗登記。**必須是列舉而不是散文**：這是「一黑一白」的直接解藥，而一句
 * 「以深色為主、局部可用淺色」在 prompt 裡讀起來完全合法，等於什麼都沒鎖。
 */
export const TONAL_REGISTERS = ["dark", "light"] as const;
export type TonalRegister = (typeof TONAL_REGISTERS)[number];

export const TONAL_REGISTER_LABELS: Record<TonalRegister, string> = {
  dark: "深色",
  light: "淺色",
};

/**
 * 明暗登記在設計系統 markdown 裡的那一行。
 *
 * 與段落標題住在同一個檔案是同一條理由，只是這裡的兩端是**伺服器的排版端**
 * （`style-analysis.ts` 的 `renderDesignSystem()`，唯一的 writer）與**編輯器**（風格庫頁
 * 「AI 產生」區那顆深色／淺色 chip，唯一的 reader）。兩邊各寫一份字串的話，改一個字之後
 * 前端只會安靜地不再顯示 chip——沒有測試會紅，而畫面上「這份風格沒鎖明暗」與「有鎖但前端
 * 讀不到」長得一模一樣，正是這個功能最不該搞混的兩件事。
 *
 * 括號裡的英文列舉是給機器讀的那一半（中文標籤是給人讀的），**不可拿掉**：
 * `designSystemTonalRegister()` 認的就是它。
 */
export function tonalRegisterBullet(register: TonalRegister): string {
  return `- 明暗登記：${TONAL_REGISTER_LABELS[register]}（${register}）。整份簡報維持這一個登記——段落頁可以更深、封面可以滿版影像，但沒有任何一頁翻到另一邊。`;
}

const TONAL_REGISTER_PATTERN = /^-\s*明暗登記：[^\n]*?（(dark|light)）/m;

/**
 * 從設計系統 markdown 讀回明暗登記；讀不到就回 `undefined`。
 *
 * `undefined` 的語意是「這份設計系統沒有這道鎖」，**不是**「預設深色」：舊格式的設計系統
 * （這個欄位存在之前分析出來的）就是沒有它，而猜一邊等於對使用者宣告一件伺服器從沒說過
 * 的事——猜錯的那一半會把淺色簡報標成深色。
 */
export function designSystemTonalRegister(designSystem: string): TonalRegister | undefined {
  return TONAL_REGISTER_PATTERN.exec(designSystem)?.[1] as TonalRegister | undefined;
}

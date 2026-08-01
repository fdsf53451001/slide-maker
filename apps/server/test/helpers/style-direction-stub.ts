import { STYLE_DIRECTION_PROMPT } from "../../src/style-direction.js";

/**
 * 「AI 自由設計」的風格決議會在兩階段大綱之後**再呼叫一次**文字模型（見
 * `src/style-direction.ts`）。這一組 helper 讓「不是在驗風格」的大綱測試把那一次認出來
 * 並給它一份合法的回覆，而不必各自抄一份 prompt 開頭字串——那正是會過期的第二份真相。
 *
 * 認得出來之後就**不要**把它記進那些測試的 `prompts` 陣列：它們是用「第幾次呼叫」來決定
 * 要回什麼、也用陣列長度斷言呼叫次數的，混進第三種 prompt 會讓每一條斷言都要心算偏移量。
 * 風格決議自己的行為由 `test/style-direction.test.ts` 專門驗。
 */
export function isStyleDirectionPrompt(prompt: string): boolean {
  return prompt.startsWith(STYLE_DIRECTION_PROMPT);
}

/** 一份最小但**合法**（過得了 `renderDesignSystem`）的三軌設計系統回覆。 */
export const STYLE_DIRECTION_REPLY = {
  designRationale: "以單一強調色與大量留白建立層級",
  invariants: {
    tonalRegister: "dark",
    background: "#101418；允許 ±5% 明度的鄰近面板",
    palette: [{ hex: "#101418", usage: "全域底色，約佔畫面 80%" }],
    typography: "無襯線，標題 96px/700，內文 32px/400",
    spacing: "左右邊距 8%，基準間距 24px",
    componentGeometry: "圓角 8px，1px 細線",
    imageTreatment: "照片去飽和 20%",
    illustrationIdiom: "扁平向量、2px 等寬輪廓",
  },
  pageTypeRules: [{ kind: "content", rules: "標題列加細線，內容置左" }],
  freeChoices: ["構圖骨架", "插圖畫什麼"],
  avoid: ["漸層"],
};

import type { RoundTripSpec } from "./text-roundtrip.js";

/**
 * 程式合成的多框假投影片：大標、副標、三張卡片標題、三段卡片內文、底部長句。
 *
 * 版面刻意模仿實機上會跑版的那一頁（1920×1080、卡片三欄），並讓各層級的字級
 * 落在字級聚類的容差之外（22 → 26 → 30 → 34 → 76，相鄰比值皆 > 1.12），
 * 這樣「聚類把同層級貼齊」與「不同層級不得互相污染」兩件事可以分開驗證。
 * 沒有任何像素期望值：所有真值都由渲染本身推導。
 */
export const FAKE_PAGE: readonly RoundTripSpec[] = [
  { text: "AI-Ready API Security", fontSize: 76, x: 120, y: 90 },
  { text: "從盤點到治理的四個步驟", fontSize: 34, x: 120, y: 220 },
  { text: "MCP / Tool Allow-list", fontSize: 30, x: 140, y: 380 },
  { text: "身分與最小權限", fontSize: 30, x: 700, y: 380 },
  { text: "稽核軌跡與可追溯", fontSize: 30, x: 1260, y: 380 },
  { text: "只開放必要工具，並以白名單控管呼叫範圍", fontSize: 22, x: 140, y: 450 },
  { text: "每個代理都有獨立身分與最短授權期限", fontSize: 22, x: 700, y: 450 },
  { text: "所有工具呼叫留存可追溯的稽核軌跡", fontSize: 22, x: 1260, y: 450 },
  {
    text: "本頁彙整了本季度所有跨部門專案的進度、風險與後續行動項目與負責人",
    fontSize: 26,
    x: 120,
    y: 900,
  },
];

/** 卡片版式常見的置中／靠右標題：框比文字寬，錨點不在框左緣。 */
export const ALIGNED_PAGE: readonly RoundTripSpec[] = [
  { text: "Quarterly Security Review", fontSize: 64, x: 200, y: 120, align: "center", slack: 420 },
  { text: "資料最小化與遮蔽", fontSize: 28, x: 200, y: 320, align: "right", slack: 260 },
  { text: "Appendix / 附錄", fontSize: 20, x: 200, y: 520, align: "center", slack: 180 },
];

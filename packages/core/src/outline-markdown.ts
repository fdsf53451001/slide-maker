import { safeProjectFilename } from "./download-filename.js";
import type { SlideSpec } from "./schemas.js";

/**
 * 大綱的 Markdown 產生器。
 *
 * **為什麼住在 core**：這份 md 有兩個來源不同的下載點。編輯器匯出面板下載的是伺服器上那一
 * 份，走匯出端點；精靈 STEP 4 那顆下載的是使用者**手上還沒送回伺服器的草稿**（就地改的
 * purpose／content／敘事要按下「確認設定並生成」才 PATCH 回去），只能在瀏覽器裡就地產生。
 * 兩邊各寫一份格式化就是第二份真相——使用者先從精靈抓一份、生成完再從匯出面板抓一份，兩份
 * 長得不一樣時沒有任何測試會發現。
 */

/**
 * 沒有任何頁面時的正文。
 *
 * 只有 `# 專案名`、後面空無一物的檔案看起來像下載壞掉（使用者會重按幾次），所以明說一句。
 * 精靈那顆按鈕在 0 頁時根本不出現，走得到這裡的只有匯出端點。
 */
const EMPTY_DECK_NOTE = "（這份簡報目前沒有任何頁面。）";

/**
 * 隱藏頁的註記。放在標題**下方**當一行正文，**不可以**寫進 `##` 那一行。
 *
 * 這份 md 的設計意圖之一是原樣回丟成「大綱參考」來源，而 `buildOutlineReference()` 是把正文
 * 逐字塞進 prompt 的。註記若留在標題行，模型讀到的頁標題就字面上是「第三季營收（隱藏頁）」
 * ——而 `hidden` 根本不是大綱 schema 的欄位，模型**沒有任何方式**把一頁設成隱藏，它唯一做得
 * 到的就是把那幾個字照抄進標題。同一份 prompt 又要求它 follow its section order、every topic
 * must survive，於是新專案穩定地長出一頁真的叫「第三季營收（隱藏頁）」的投影片。
 *
 * 移到正文之後它仍可能被讀成內容，但它是一句完整的、講「原簡報狀態」的話，不會被當成標題的
 * 一部分照抄。措辭刻意寫全「不放映、不進 pptx／pdf」，沒開過編輯器的人也讀得懂它在講什麼。
 */
const HIDDEN_NOTE = "（這一頁在原簡報中設為隱藏：不放映，也不會進 pptx／pdf。）";

/** 敘事在 blockquote 裡的前綴。 */
const NARRATIVE_PREFIX = "講述：";

/**
 * 放進標題行（`#`／`##`）的一段文字：所有空白摺成單一空格。
 *
 * 與 `outlineReferenceHeader()` 裡那個 `\s+` 摺疊同一個道理。專案名稱（`z.string().min(1)`）
 * 與 purpose（`z.string()`）的 schema 都收得下換行，而 Markdown 的區塊邊界是「行」：一個叫
 * `年報\n\n## 1. 我自己編的一頁` 的專案名會在檔案裡長出一頁不存在的投影片，而這份 md 的設計
 * 意圖之一正是原樣回丟成「大綱參考」來源再讀一次。
 *
 * `#` **沒有**被跳脫。這是已知的小失真，不是「不必處理」：行首的 `#` 確實已被上面的摺疊解決
 * （摺完就不會再有第二個行首），但 CommonMark §4.2 的 ATX 標題還有 optional closing
 * sequence——行尾一串前面帶空白的 `#` 會被當成收尾記號吃掉。實測 `purpose = "###"` 產出
 * `## 1. ###`，渲染成 `<h2>1.</h2>`，**purpose 整個消失**；`"重點 #"` 尾巴那個 `#` 也會不見。
 * 發生機率低、後果限於少掉幾個裝飾字元，不值得為它把使用者寫的 `#` 全部改寫成 `\#`。
 */
function headingText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 整段包成 blockquote。
 *
 * 逐行加 `>` 而不是只在第一行加：narrative 是 textarea，換行是合法輸入，而 blockquote 的
 * lazy continuation 遇到空行就結束——只加第一行的話，多段的敘事會有一半掉出引用區、變成
 * 與 content 同層的正文。
 */
function blockquote(value: string): string {
  return value
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * 整份大綱的 Markdown。
 *
 * 刻意**不放 `layoutHint`**：它是給影像模型的版面指示，而這份 md 要能原樣回丟成「大綱參考」
 * 來源（`buildOutlineReference()` 吃的就是來源的 `extractedText`）。版面指示混進正文，再匯入
 * 時會被當成投影片要講的內容。敘事則放進 blockquote 並加「講述：」前綴，理由同上——它要與
 * 正文在視覺與結構上都分得開。兩者都空的欄位整行不出現，不留空的佔位。
 *
 * `content` **原樣保留**（只 trim 頭尾空白）：它本來就是 markdown，條列與表格就是使用者要的
 * 編排，改寫使用者的 markdown 是更壞的交換。代價是這份檔的結構在 content 面前沒有任何防線，
 * 而且不只「多一個看起來像頁標題的東西」這麼輕微——同一個取捨有兩端：
 * - content 裡自己有一行 `## …` 時，再匯入會與頁面標題無從區分（多出一頁不存在的投影片）。
 * - 最壞情況是**沒有收尾的程式碼圍欄**：某一頁的 content 留了一個單獨的三反引號，它之後
 *   **每一頁**的 `##` 標題與內容都會被吃進同一個 code block。回丟成大綱參考時模型讀到的是
 *   「這份大綱只有一頁，內容是一大塊程式碼」——後面幾十頁靜默消失。
 * 兩者接受的理由是同一個：保住使用者的表格與條列，比防這種自造的歧義重要。
 *
 * 序號用 `order + 1` 且**不扣掉隱藏頁**，與 `exportSlideFilename()` 同一條慣例：檔名／序號對
 * 的是專案裡的實際頁序，扣掉隱藏頁是頁碼（chrome）才有的規則。
 *
 * 檔尾固定一個換行：純文字檔的通則，也讓「把幾份大綱接起來」不會把兩個標題黏成一行。
 */
export function outlineMarkdown(deck: { name: string; slides: readonly SlideSpec[] }): string {
  const blocks: string[] = [`# ${headingText(deck.name)}`];
  // 依 order 排序而不是相信陣列順序：伺服器端的 `currentVersions()` 也是這樣做的，而精靈那
  // 條路傳進來的是本地草稿，排序按鈕改的是 id 順序、`order` 由伺服器回填。
  const slides = [...deck.slides].sort((a, b) => a.order - b.order);
  if (!slides.length) blocks.push(EMPTY_DECK_NOTE);
  for (const slide of slides) {
    // purpose 是空的就只留編號，不補「（未命名）」這類佔位字：它會在回丟成大綱參考時變成
    // 一個模型看得見的頁面標題，而那並不是使用者寫的。
    const purpose = headingText(slide.purpose);
    blocks.push(`## ${slide.order + 1}.${purpose ? ` ${purpose}` : ""}`);
    // 隱藏註記排在 content 之前：先講這一頁的狀態，再讀它的內容。
    if (slide.hidden) blocks.push(HIDDEN_NOTE);
    const content = slide.content.trim();
    if (content) blocks.push(content);
    const narrative = slide.narrative.trim();
    if (narrative) blocks.push(blockquote(`${NARRATIVE_PREFIX}${narrative}`));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** 大綱 md 的下載檔名：`<專案>.outline.md`。 */
export function outlineMarkdownFilename(name: string): string {
  return `${safeProjectFilename(name)}.outline.md`;
}

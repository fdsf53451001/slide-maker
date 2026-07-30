// 「最近更新」面板的資料來源：repo 根目錄的 CHANGE.md，在**建置時**以 `?raw` 內嵌進 bundle。
// 刻意不開 API 端點、也不 runtime fetch——更新紀錄是隨版本走的靜態內容，多一條網路路徑
// 只會多一種「面板打不開」的失敗方式。代價是 Dockerfile 的建置層必須 COPY CHANGE.md。
import changelogMarkdown from "../../../CHANGE.md?raw";

/** 一則更新。`title` 只在項目寫成 `- **標題**：說明` 時才有。 */
export type ChangelogEntry = { title?: string; body: string };
/** 一天的更新。`date` 維持 `YYYY-MM-DD` 原字串，顯示時才用 `formatChangelogDate` 轉。 */
export type ChangelogDay = { date: string; entries: ChangelogEntry[] };

const HEADING = /^#{1,6}\s/;
const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const BULLET = /^-\s+(.*)$/;
/** `**標題**：說明`。冒號用全形，半形一併收下（打字習慣差異不該讓標題消失）。 */
const TITLED_ENTRY = /^\*\*(.+?)\*\*[：:]\s*(.*)$/;

/**
 * 去掉行內 markdown 記號後輸出純文字：顯示層不跑 markdown 渲染器，也不引入新依賴。
 *
 * 三條都是**成對**比對而非把記號整批刪掉：CHANGE.md 裡有 `` `**` `` 這種「把 markdown
 * 記號當內容講」的句子，blanket 刪除會把它從句子裡挖掉，變成讀不懂的半句話。
 */
function stripInlineMarkup(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * 接續行。中文的軟換行不可補空白（markdown 慣例補空白是給 ASCII 分詞用的），
 * 所以只有接縫兩側都是 ASCII 可見字元時才補一個空格。
 */
function joinContinuation(head: string, tail: string): string {
  if (!head) return tail;
  const isAscii = (char: string) => /[\x20-\x7e]/.test(char);
  const left = head.slice(-1);
  const right = tail.slice(0, 1);
  return isAscii(left) && isAscii(right) ? `${head} ${tail}` : `${head}${tail}`;
}

function toEntry(raw: string): ChangelogEntry | undefined {
  const titled = TITLED_ENTRY.exec(raw);
  if (titled) {
    const title = stripInlineMarkup(titled[1] ?? "");
    const body = stripInlineMarkup(titled[2] ?? "");
    // 標題與說明都在才拆兩段；只寫了其中一半時退回純文字項目，不留一個空的 body。
    if (title && body) return { title, body };
    const text = title || body;
    return text ? { body: text } : undefined;
  }
  const body = stripInlineMarkup(raw);
  return body ? { body } : undefined;
}

/**
 * 解析 CHANGE.md。契約寫在該檔開頭：`## YYYY-MM-DD` 一級一天（新的在上）、
 * 每則更新是一個 `- ` 項目。
 *
 * 邊界處理：
 * - 日期以外的標題與其底下的段落（給維護者看的前言）整段忽略。
 * - 非 `- ` 開頭的非空行是續行，接到前一則後面；空行結束該則。
 * - 一則都沒有的日期段落略過（不顯示一個空的日期標題）。
 * - **不重新排序**，維持檔案順序；日期新舊由 `changelog.test.ts` 的守門測試釘住。
 */
export function parseChangelog(markdown: string): ChangelogDay[] {
  const days: ChangelogDay[] = [];
  let current: ChangelogDay | undefined;
  let buffer: string | undefined;

  const flushEntry = () => {
    if (buffer === undefined) return;
    const raw = buffer;
    buffer = undefined;
    if (!current) return;
    const entry = toEntry(raw);
    if (entry) current.entries.push(entry);
  };
  const flushDay = () => {
    flushEntry();
    if (current && current.entries.length > 0) days.push(current);
    current = undefined;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const text = line.trim();
    if (HEADING.test(text)) {
      flushDay();
      const date = DATE_HEADING.exec(text)?.[1];
      if (date) current = { date, entries: [] };
      continue;
    }
    if (!text) {
      flushEntry();
      continue;
    }
    const bullet = BULLET.exec(text)?.[1];
    if (bullet !== undefined) {
      flushEntry();
      buffer = bullet;
      continue;
    }
    if (buffer !== undefined) buffer = joinContinuation(buffer, text);
  }
  flushDay();
  return days;
}

/**
 * 內嵌的 CHANGE.md 原文。匯出它是為了讓守門測試把閘門建在**原始字串**上：
 * 只對 `changelogDays` 斷言等於自我證明——`parseChangelog` 會靜默丟掉格式壞掉的日期段落
 * （`### 2026-07-30`、`## 2026/07/30`、只有敘述沒有項目的一天），對「已經被丟掉的東西」
 * 再怎麼斷言都不會紅，而那正是使用者會遇到的災情（整天從面板上消失）。
 */
export const changelogSource: string = changelogMarkdown;

/** 內嵌的 CHANGE.md 解析結果，整個 app 共用這一份（模組載入時解析一次）。 */
export const changelogDays: ChangelogDay[] = parseChangelog(changelogMarkdown);

/** `"2026-07-29"` → `"2026年7月29日"`。認不得的字串原樣回傳，不讓面板炸掉。 */
export function formatChangelogDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  if (!year || !month || !day) return date;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

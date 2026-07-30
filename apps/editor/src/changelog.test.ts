// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  changelogDays,
  changelogSource,
  formatChangelogDate,
  parseChangelog,
} from "./changelog.js";

/**
 * 兩組測試，職責不同：
 * ① fixture 組釘住 parser 的邊界處理；
 * ② 真實 `changelogDays` 那組是**守門測試**——CHANGE.md 是人手維護的，格式契約
 *    （一級一天、新的在上、每天都有項目）壞掉時要在 `pnpm check` 就紅，而不是等到
 *    使用者打開面板才看到空白或亂序。
 */

const FIXTURE = `# 更新紀錄

這段是給維護者看的前言，不該出現在面板上。

- 前言裡的項目也不算數，因為它不屬於任何日期。

## 格式說明

這個非日期標題底下的段落一樣忽略。

## 2026-07-29

- **主畫面新增「最近更新」**：右上角可以打開更新紀錄。
- 沒有粗體標題的純句子也收得下。
- **續行也要接住**：說明第一段，
  第二段接在同一則後面。

## 2026-07-28

（這一天只有敘述、沒有項目，整段略過。）

## 2026-07-27

- **記號要去掉**：像 \`程式碼\` 與 **粗體** 都輸出成純文字。
`;

describe("parseChangelog", () => {
  const days = parseChangelog(FIXTURE);

  it("只收 `## YYYY-MM-DD` 段落，前言與非日期標題一律忽略", () => {
    expect(days.map((day) => day.date)).toEqual(["2026-07-29", "2026-07-27"]);
    const bodies = days.flatMap((day) => day.entries.map((entry) => entry.body));
    expect(bodies.some((body) => body.includes("前言裡的項目"))).toBe(false);
  });

  it("`- **標題**：說明` 拆成 title 與 body", () => {
    expect(days[0]?.entries[0]).toEqual({
      title: "主畫面新增「最近更新」",
      body: "右上角可以打開更新紀錄。",
    });
  });

  it("沒有粗體標題時省略 title、整行當 body", () => {
    const entry = days[0]?.entries[1];
    expect(entry?.body).toBe("沒有粗體標題的純句子也收得下。");
    expect(entry && "title" in entry).toBe(false);
  });

  it("續行接到前一則後面（中文接縫不補空白）", () => {
    expect(days[0]?.entries[2]).toEqual({
      title: "續行也要接住",
      body: "說明第一段，第二段接在同一則後面。",
    });
  });

  it("沒有項目的日期段落略過", () => {
    expect(days.some((day) => day.date === "2026-07-28")).toBe(false);
  });

  it("去掉 ** 與行內反引號後輸出純文字", () => {
    expect(days[1]?.entries[0]).toEqual({
      title: "記號要去掉",
      body: "像 程式碼 與 粗體 都輸出成純文字。",
    });
  });

  it("不重新排序，維持檔案順序", () => {
    const ascending = parseChangelog("## 2026-01-01\n\n- 舊的\n\n## 2026-02-02\n\n- 新的\n");
    expect(ascending.map((day) => day.date)).toEqual(["2026-01-01", "2026-02-02"]);
  });

  it("空字串回空陣列", () => {
    expect(parseChangelog("")).toEqual([]);
  });
});

describe("formatChangelogDate", () => {
  it("轉成繁中日期並去掉補零", () => {
    expect(formatChangelogDate("2026-07-29")).toBe("2026年7月29日");
    expect(formatChangelogDate("2026-01-05")).toBe("2026年1月5日");
  });

  it("認不得的字串原樣回傳", () => {
    expect(formatChangelogDate("尚未定案")).toBe("尚未定案");
  });
});

/**
 * 守門測試的閘門一律建在 `changelogSource`（原文字串）上，不是建在 `changelogDays` 上。
 *
 * 理由：`parseChangelog` 對格式壞掉的日期段落是**靜默丟棄**——`### 2026-07-30`、
 * `## 2026/07/30`、`## 2026-7-30`、只有敘述沒有 `- ` 項目的一天，通通不會 throw，只會讓
 * 那一天從面板上消失。對「活下來的那些」斷言 `entries.length > 0` 是自我證明：已經被丟掉
 * 的日子不在陣列裡，測試對它是空語句，五種手誤有三種完全不紅。
 *
 * 所以下面這幾條都自己掃原文的行，再與 parser 的產物對帳。
 */
const SOURCE_LINES = changelogSource.split(/\r?\n/).map((line) => line.trim());
const HEADING_LINE = /^#{1,6}\s+(.*)$/;
const DATE_HEADING_LINE = /^##\s+\d{4}-\d{2}-\d{2}$/;
/** 「看起來是想寫日期」：層級或分隔符寫錯的手誤也落在這裡，才擋得到。 */
const LOOKS_LIKE_DATE = /\d{4}\s*[-/]/;

/** 原文裡每一則項目的**原始文字**（含續行），與 parser 各走各的。 */
function sourceEntries(): { date: string; raw: string }[] {
  const entries: { date: string; raw: string }[] = [];
  let date: string | undefined;
  let buffer: string | undefined;
  const flush = () => {
    if (buffer !== undefined && date) entries.push({ date, raw: buffer });
    buffer = undefined;
  };
  for (const line of SOURCE_LINES) {
    if (HEADING_LINE.test(line)) {
      flush();
      date = DATE_HEADING_LINE.test(line) ? line.replace(/^##\s+/, "") : undefined;
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    // `*` 開頭也收：parser 只認 `-`，兩邊的數量對不上正是要抓的手誤。
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      buffer = bullet[1] ?? "";
      continue;
    }
    if (buffer !== undefined) buffer += line;
  }
  flush();
  return entries;
}

describe("真實的 CHANGE.md", () => {
  it("解析得出內容，而且每天都有項目", () => {
    expect(changelogDays.length).toBeGreaterThan(0);
    for (const day of changelogDays) expect(day.entries.length).toBeGreaterThan(0);
  });

  it("每個像日期的標題都必須正好是 `## YYYY-MM-DD`（擋 ### 與 2026/07/30、2026-7-30）", () => {
    const suspicious = SOURCE_LINES.filter((line) => {
      const heading = HEADING_LINE.exec(line);
      if (!heading) return false;
      return LOOKS_LIKE_DATE.test(heading[1] ?? "");
    }).filter((line) => !DATE_HEADING_LINE.test(line));
    expect(suspicious).toEqual([]);
  });

  it("原文裡的每一個日期段落都要出現在面板上（擋「只寫敘述、沒有項目」的一天）", () => {
    const sourceDates = SOURCE_LINES.filter((line) => DATE_HEADING_LINE.test(line)).map((line) =>
      line.replace(/^##\s+/, ""),
    );
    expect(changelogDays.map((day) => day.date)).toEqual(sourceDates);
  });

  it("原文裡的項目數與面板上的則數相同（擋 `*` 開頭與任何被靜默丟掉的項目）", () => {
    const parsed = changelogDays.flatMap((day) => day.entries).length;
    expect(sourceEntries().length).toBe(parsed);
  });

  it("粗體記號不得落單（`- **標題沒關起來：說明` 會把字面的 ** 印給使用者）", () => {
    // 比對的是**原文**而不是 parser 產物：CHANGE.md 有一則刻意把 `**` 當內容講（用行內
    // 反引號包起來），它解析後的正文本來就含字面的 `**`，拿產物去驗會誤判那一則。
    // 先把行內程式碼整段拿掉，剩下的 `**` 必須成雙。
    const unpaired = sourceEntries().filter(({ raw }) => {
      const withoutCode = raw.replace(/`[^`]*`/g, "");
      return ((withoutCode.match(/\*\*/g) ?? []).length & 1) === 1;
    });
    expect(unpaired).toEqual([]);
  });

  it("日期一律是 YYYY-MM-DD", () => {
    for (const day of changelogDays) expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("日期由新到舊嚴格遞減（不得重複、不得倒插）", () => {
    const dates = changelogDays.map((day) => day.date);
    for (let index = 1; index < dates.length; index += 1) {
      const previous = dates[index - 1] ?? "";
      const current = dates[index] ?? "";
      expect(previous > current).toBe(true);
    }
  });

  it("每則更新都有內容", () => {
    for (const day of changelogDays)
      for (const entry of day.entries) expect(entry.body.trim().length).toBeGreaterThan(0);
  });
});

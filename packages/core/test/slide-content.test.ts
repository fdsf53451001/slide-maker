import { describe, expect, it } from "vitest";
import {
  normalizeInlineMarkup,
  normalizePlainTextMarkup,
  parseSlideContentBlocks,
  type SlideContentBlock,
} from "../src/index.js";

describe("parseSlideContentBlocks", () => {
  it("turns ATX headings into levelled heading blocks", () => {
    expect(parseSlideContentBlocks("# 一\n## 二\n###### 六")).toEqual([
      { type: "heading", level: 1, text: "一" },
      { type: "heading", level: 2, text: "二" },
      { type: "heading", level: 6, text: "六" },
    ]);
  });

  it("accepts a heading without a space before CJK, which models emit constantly", () => {
    expect(parseSlideContentBlocks("###三大挑戰")).toEqual([
      { type: "heading", level: 3, text: "三大挑戰" },
    ]);
    // 但 `#1` 是可見文字（編號、標籤），不能被當成標題把 # 吃掉。
    expect(parseSlideContentBlocks("#1 產品線")).toEqual([
      { type: "paragraph", text: "#1 產品線" },
    ]);
  });

  it("drops the closing hashes of a closed ATX heading", () => {
    expect(parseSlideContentBlocks("## 標題 ##")).toEqual([
      { type: "heading", level: 2, text: "標題" },
    ]);
  });

  it("merges consecutive bullet markers into one block", () => {
    const blocks = parseSlideContentBlocks("- 甲\n* 乙\n+ 丙");
    expect(blocks).toEqual([{ type: "bullets", items: ["甲", "乙", "丙"] }]);
  });

  it("keeps nested bullets in the same block and records their depth", () => {
    const blocks = parseSlideContentBlocks("- 頂層\n  - 子項\n    - 孫項\n- 回到頂層");
    expect(blocks).toEqual([
      {
        type: "bullets",
        items: ["頂層", "子項", "孫項", "回到頂層"],
        levels: [0, 1, 2, 0],
      },
    ]);
  });

  it("omits levels entirely for a flat list", () => {
    const [block] = parseSlideContentBlocks("- 甲\n- 乙");
    expect(block).not.toHaveProperty("levels");
  });

  it("treats 4-space indentation as one level, same as 2-space", () => {
    const blocks = parseSlideContentBlocks("- 頂層\n    - 子項");
    expect(blocks).toEqual([{ type: "bullets", items: ["頂層", "子項"], levels: [0, 1] }]);
  });

  it("keeps ordered lists ordered without leaving the numbering characters in the text", () => {
    expect(parseSlideContentBlocks("1. 盤點\n2) 導入\n3. 複盤")).toEqual([
      { type: "steps", items: ["盤點", "導入", "複盤"] },
    ]);
  });

  it("splits an ordered list from an unordered one instead of merging them", () => {
    expect(parseSlideContentBlocks("- 甲\n1. 乙")).toEqual([
      { type: "bullets", items: ["甲"] },
      { type: "steps", items: ["乙"] },
    ]);
  });

  it("parses a pipe table into arrays and discards the separator row", () => {
    const content = [
      "| 指標 | 導入前 | 導入後 |",
      "| --- | --- | --- |",
      "| 交付 | 14 天 | 3 天 |",
    ].join("\n");
    expect(parseSlideContentBlocks(content)).toEqual([
      {
        type: "table",
        header: ["指標", "導入前", "導入後"],
        rows: [["交付", "14 天", "3 天"]],
      },
    ]);
  });

  it("accepts alignment and pipe-less separator variants", () => {
    const aligned = ["| A | B |", "|:---:|---:|", "| 1 | 2 |"].join("\n");
    expect(parseSlideContentBlocks(aligned)).toEqual([
      { type: "table", header: ["A", "B"], rows: [["1", "2"]] },
    ]);
    const bare = ["A | B", "--- | ---", "1 | 2"].join("\n");
    expect(parseSlideContentBlocks(bare)).toEqual([
      { type: "table", header: ["A", "B"], rows: [["1", "2"]] },
    ]);
  });

  it("pads ragged rows with empty strings instead of dropping cells", () => {
    const content = ["| A | B | C |", "| --- | --- | --- |", "| 1 |", "| 1 | 2 | 3 | 4 |"].join(
      "\n",
    );
    expect(parseSlideContentBlocks(content)).toEqual([
      {
        type: "table",
        header: ["A", "B", "C", ""],
        rows: [
          ["1", "", "", ""],
          ["1", "2", "3", "4"],
        ],
      },
    ]);
  });

  it("keeps a header-only table as a table with no body rows", () => {
    expect(parseSlideContentBlocks("| A | B |\n| --- | --- |")).toEqual([
      { type: "table", header: ["A", "B"], rows: [] },
    ]);
  });

  it("keeps genuinely empty cells blank", () => {
    const content = ["| A | B |", "| --- | --- |", "|  | 2 |"].join("\n");
    expect(parseSlideContentBlocks(content)).toEqual([
      { type: "table", header: ["A", "B"], rows: [["", "2"]] },
    ]);
  });

  it("groups blank-line separated prose into paragraphs", () => {
    expect(parseSlideContentBlocks("第一段第一行\n第一段第二行\n\n第二段")).toEqual([
      { type: "paragraph", text: "第一段第一行\n第一段第二行" },
      { type: "paragraph", text: "第二段" },
    ]);
  });

  it("turns blockquotes into quote blocks without the marker", () => {
    expect(parseSlideContentBlocks("> 引用第一行\n> 引用第二行")).toEqual([
      { type: "quote", text: "引用第一行\n引用第二行" },
    ]);
  });

  it("drops thematic breaks rather than emitting them as dashes", () => {
    expect(parseSlideContentBlocks("甲\n\n---\n\n乙")).toEqual([
      { type: "paragraph", text: "甲" },
      { type: "paragraph", text: "乙" },
    ]);
  });

  it("keeps a fenced code block as a codeBlock, with the fence removed and no duplicated copy", () => {
    // 內容重複出現在 text 與 code 兩個欄位時，模型有把同一段畫兩次的風險。
    expect(parseSlideContentBlocks("```ts\nconst a = 1;\nconst b = 2;\n```")).toEqual([
      { type: "codeBlock", text: "const a = 1;\nconst b = 2;" },
    ]);
  });

  it("never lets an unclosed fence swallow the rest of the slide", () => {
    const blocks = parseSlideContentBlocks("```ts\n### 標題\n- 條列\n\n重點句");
    expect(blocks).toEqual([
      { type: "paragraph", text: "```ts", unparsed: true },
      { type: "heading", level: 3, text: "標題" },
      { type: "bullets", items: ["條列"] },
      { type: "paragraph", text: "重點句" },
    ]);
  });
});

describe("inline markup normalization", () => {
  it("strips bold and italic markers and collects the emphasized words", () => {
    expect(parseSlideContentBlocks("**交付時間**下降，*成本*持平，__品質__持平")).toEqual([
      {
        type: "paragraph",
        text: "交付時間下降，成本持平，品質持平",
        emphasis: ["交付時間", "成本", "品質"],
      },
    ]);
  });

  it("deduplicates emphasis and never emits an empty emphasis array", () => {
    const [block] = parseSlideContentBlocks("- **甲** 與 **甲**\n- 乙");
    expect(block).toEqual({ type: "bullets", items: ["甲 與 甲", "乙"], emphasis: ["甲"] });
    const [plain] = parseSlideContentBlocks("沒有強調");
    expect(plain).not.toHaveProperty("emphasis");
  });

  it("keeps inline code text but separates it from emphasis", () => {
    expect(parseSlideContentBlocks("執行 `pnpm check` 即可")).toEqual([
      { type: "paragraph", text: "執行 pnpm check 即可", code: ["pnpm check"] },
    ]);
  });

  it("keeps only the label of a markdown link", () => {
    expect(parseSlideContentBlocks("見 [官方文件](https://example.com/docs) 說明")).toEqual([
      { type: "paragraph", text: "見 官方文件 說明" },
    ]);
    expect(normalizeInlineMarkup("![圖說](https://example.com/a.png)")).toBe("圖說");
  });

  it("restores escaped markers as literal characters", () => {
    expect(normalizeInlineMarkup("成本 \\* 數量 \\| 單位 \\# 一")).toBe("成本 * 數量 | 單位 # 一");
  });

  it("leaves lone markers that are real punctuation alone", () => {
    // flanking 規則：開頭標記後接空白就不是強調，否則兩個乘號會憑空消失。
    expect(normalizeInlineMarkup("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(normalizeInlineMarkup("snake_case_name")).toBe("snake_case_name");
    // 沒有收尾的標記是作者真的想寫的字元。
    expect(normalizeInlineMarkup("a `b")).toBe("a `b");
    expect(normalizeInlineMarkup("50% * 2")).toBe("50% * 2");
  });

  it("handles bold-italic without leaving a stray marker behind", () => {
    expect(normalizeInlineMarkup("***重點***")).toBe("重點");
  });

  it("normalizes inline markup inside table cells and list items", () => {
    const content = [
      "| **指標** | `cmd` |",
      "| --- | --- |",
      "| [連結](https://a.example) | 值 |",
    ].join("\n");
    expect(parseSlideContentBlocks(content)).toEqual([
      {
        type: "table",
        header: ["指標", "cmd"],
        rows: [["連結", "值"]],
        emphasis: ["指標"],
        code: ["cmd"],
      },
    ]);
  });
});

describe("robustness", () => {
  it("returns an empty array for empty or whitespace-only content", () => {
    expect(parseSlideContentBlocks("")).toEqual([]);
    expect(parseSlideContentBlocks("   \n\n\t")).toEqual([]);
  });

  it("falls back to a paragraph for anything it cannot classify", () => {
    const odd = "<<< 這不是任何 markdown 結構 >>>";
    expect(parseSlideContentBlocks(odd)).toEqual([{ type: "paragraph", text: odd }]);
  });

  it("loses no visible text from a mixed, partly malformed document", () => {
    const content = [
      "### 成果 **摘要**",
      "",
      "- 交付 14 天 → 3 天",
      "  - 其中 QA 佔 2 天",
      "1. 盤點",
      "",
      "| 指標 | 值 |",
      "| --- | --- |",
      "| 成本 | -18% |",
      "",
      "> 引用一句",
      "",
      "尾段 [連結](https://a.example) 與 `code`，還有 2 * 3。",
    ].join("\n");
    const blocks = parseSlideContentBlocks(content);
    const flat = blocks
      .flatMap((block) => {
        if (block.type === "table") return [...block.header, ...block.rows.flat()];
        if ("items" in block) return block.items;
        return [block.text];
      })
      .join(" ");
    for (const fragment of [
      "成果",
      "摘要",
      "交付 14 天 → 3 天",
      "其中 QA 佔 2 天",
      "盤點",
      "指標",
      "成本",
      "-18%",
      "引用一句",
      "連結",
      "code",
      "2 * 3",
    ])
      expect(flat).toContain(fragment);
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "bullets",
      "steps",
      "table",
      "quote",
      "paragraph",
    ]);
  });

  it("never throws on adversarial marker soup", () => {
    for (const content of ["***", "|", "|||", "#", "> ", "- ", "```", "[", "![](", "**", "___"])
      expect(() => parseSlideContentBlocks(content)).not.toThrow();
  });
});

/**
 * 真實大綱輸出語料。這幾段刻意做成「模型真的會吐出來」的樣子：中英混排、全形標點、句中
 * 粗體、多層條列、五欄六列的數字表格，以及一堆長得像標記但其實是內容的字元。
 */
const OUTLINE_CORPUS: Record<string, string> = {
  混排大綱: [
    "### 導入成果 **摘要**",
    "",
    "**交付時間**下降 79%，整體成本 -18%；QA 佔比 2/5，回滾時間 < 30 秒。",
    "",
    "- 前置作業 *自動化*（含 `pnpm check`）",
    "  - CI 佈署改用 blue/green，the **critical path** shrank to 3 days",
    "    - 例外：hotfix 走 fast-lane",
    "- 佈署改用 `pnpm deploy`",
    "",
    "1. 盤點現況",
    "2) 導入工具",
    "3. 複盤與擴散",
  ].join("\n"),
  寬表格: [
    "| 指標 | 2023 | 2024 | 2025E | 年複合成長 |",
    "| --- | ---: | :---: | ---: | --- |",
    "| 營收（億元） | 12.4 | 18.9 | 27.5 | +49% |",
    "| 毛利率 | 38.2% | 41.0% | 43.5% | +2.7pp |",
    "| 客戶數 | 120 | 210 | 350 | +71% |",
    "| NPS | 32 | 41 | 48 | — |",
    "| 流失率 | 8.1% | 6.4% | 4.9% | -1.6pp |",
    "| 人均產值 | 210 萬 | 265 萬 | 320 萬 | +23% |",
  ].join("\n"),
  字面標記字元: [
    "成本估算：2 * 3 * 4 = 24，折扣後約 50% * 2。",
    "",
    "設定檔放在 C:\\path\\* 或 /etc/app/*.conf，變數名為 snake_case_name。",
    "",
    "決策樹：A | B | C 三選一，門檻 >50% 的使用者同意。",
  ].join("\n"),
  引用與分隔線: [
    "> 「**品質**不是檢查出來的，是設計出來的。」",
    "> —— 品保部",
    "",
    "---",
    "",
    "延伸閱讀 [官方文件](https://example.com/docs) 與 ![流程圖](https://a.example/x.png)。",
  ].join("\n"),
  句中強調: [
    "我們在 **Q3** 完成 __三件事__：*降本*、***提速***、加固。",
    "毛利率**成長 2.7pp**，客訴**下降 31%**；NPS 持平。",
  ].join("\n"),
};

function renderedText(blocks: SlideContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "table") return [...block.header, ...block.rows.flat()];
      if ("items" in block) return block.items;
      return [block.text];
    })
    .join("\n");
}

/**
 * 把原文化簡成「解析後仍必須看得見的詞元」：拿掉純版面語法（程式碼圍欄、分隔線、表格分隔
 * 列、行首的 #／>／條列與編號標記）與連結網址，剩下的用標記字元切成詞元。`-` 與 `+` 刻意
 * 不當切點，`-18%` 少掉正負號就是改了數字語意，必須被抓到。
 */
function visibleTokens(source: string): string[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^[ \t]*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(trimmed)) continue;
    if (trimmed.includes("-") && /^[|\s:-]+$/.test(trimmed)) continue;
    kept.push(
      line
        .replace(/^ {0,3}#{1,6}#*(?:[ \t]+|(?![0-9A-Za-z#]))/, "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .replace(/^ {0,3}>[ \t]?/, "")
        .replace(/^[ \t]*[-*+][ \t]+/, "")
        .replace(/^[ \t]*\d{1,9}[.)][ \t]+/, "")
        .replace(/!\[/g, "[")
        .replace(/\]\([^)]*\)/g, "]"),
    );
  }
  return kept
    .join("\n")
    .split(/[*_`|[\]()\\~\s]+/)
    .filter((token) => token.length > 0);
}

describe("不變式：解析不得遺失任何可見文字", () => {
  for (const [name, source] of Object.entries(OUTLINE_CORPUS)) {
    it(`保留 ${name} 的每一個可見詞元`, () => {
      const rendered = renderedText(parseSlideContentBlocks(source));
      const lost = visibleTokens(source).filter((token) => !rendered.includes(token));
      // 把 rendered 一起放進斷言：失敗時直接看得到模型會拿到什麼，不必再重跑一次。
      expect({ lost, rendered }).toEqual({ lost: [], rendered });
    });
  }

  it("整份語料串起來仍然不掉字", () => {
    const source = Object.values(OUTLINE_CORPUS).join("\n\n");
    const rendered = renderedText(parseSlideContentBlocks(source));
    expect(visibleTokens(source).filter((token) => !rendered.includes(token))).toEqual([]);
  });

  it("詞元檢查本身抓得到遺失——否則這條不變式是空的", () => {
    const source = "**交付時間**下降 79%";
    const rendered = "下降 79%";
    expect(visibleTokens(source).filter((token) => !rendered.includes(token))).toEqual([
      "交付時間",
    ]);
  });
});

describe("真實大綱語料的結構", () => {
  it("五欄六列的數字表格逐格保留，分隔列與對齊語法不進 blocks", () => {
    const blocks = parseSlideContentBlocks(OUTLINE_CORPUS.寬表格!);
    expect(blocks).toEqual([
      {
        type: "table",
        header: ["指標", "2023", "2024", "2025E", "年複合成長"],
        rows: [
          ["營收（億元）", "12.4", "18.9", "27.5", "+49%"],
          ["毛利率", "38.2%", "41.0%", "43.5%", "+2.7pp"],
          ["客戶數", "120", "210", "350", "+71%"],
          ["NPS", "32", "41", "48", "—"],
          ["流失率", "8.1%", "6.4%", "4.9%", "-1.6pp"],
          ["人均產值", "210 萬", "265 萬", "320 萬", "+23%"],
        ],
      },
    ]);
  });

  it("中英混排大綱切成標題、段落、三層條列與步驟", () => {
    const blocks = parseSlideContentBlocks(OUTLINE_CORPUS.混排大綱!);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "bullets", "steps"]);
    const [, paragraph, bullets] = blocks;
    expect(paragraph).toEqual({
      type: "paragraph",
      text: "交付時間下降 79%，整體成本 -18%；QA 佔比 2/5，回滾時間 < 30 秒。",
      emphasis: ["交付時間"],
    });
    expect(bullets).toMatchObject({
      levels: [0, 1, 2, 0],
      emphasis: ["自動化", "critical path"],
      code: ["pnpm check", "pnpm deploy"],
    });
  });

  it("句中粗體只留文字，全形標點與括號原封不動", () => {
    expect(parseSlideContentBlocks("重點是**「品質」與（成本）**的平衡。")).toEqual([
      {
        type: "paragraph",
        text: "重點是「品質」與（成本）的平衡。",
        emphasis: ["「品質」與（成本）"],
      },
    ]);
    expect(parseSlideContentBlocks("毛利率**成長 2.7pp**，客訴**下降 31%**；NPS 持平。")).toEqual([
      {
        type: "paragraph",
        text: "毛利率成長 2.7pp，客訴下降 31%；NPS 持平。",
        emphasis: ["成長 2.7pp", "下降 31%"],
      },
    ]);
  });
});

describe("長得像標記、其實是內容的字元", () => {
  it("句中的管線符號沒有分隔列作陪，就不是表格", () => {
    expect(parseSlideContentBlocks("決策樹：A | B | C 三選一。")).toEqual([
      { type: "paragraph", text: "決策樹：A | B | C 三選一。" },
    ]);
  });

  it("乘號與百分比旁的星號一個都不能少", () => {
    expect(parseSlideContentBlocks("成本估算：2 * 3 * 4 = 24，折扣後約 50% * 2。")).toEqual([
      { type: "paragraph", text: "成本估算：2 * 3 * 4 = 24，折扣後約 50% * 2。" },
    ]);
    expect(normalizeInlineMarkup("50%*2 沒有空白")).toBe("50%*2 沒有空白");
    expect(normalizeInlineMarkup("5 ** 3 冪次")).toBe("5 ** 3 冪次");
  });

  it("路徑裡的萬用字元留下來，只有 markdown 逃脫用的反斜線消失", () => {
    // `\*` 在 markdown 就是「字面星號」的寫法，反斜線本來就不該畫上投影片。
    expect(normalizeInlineMarkup("設定檔放在 C:\\path\\* 或 /etc/app/*.conf")).toBe(
      "設定檔放在 C:\\path* 或 /etc/app/*.conf",
    );
    expect(normalizeInlineMarkup("變數名為 snake_case_name")).toBe("變數名為 snake_case_name");
  });

  it("大於號接數字是比較運算子，不是引用標記", () => {
    // `>50%` 被當引用會把 `>` 吃掉，「超過一半」就變成「正好一半」——改動數字語意，
    // 比留下一個標記字元嚴重得多。
    expect(parseSlideContentBlocks(">50% 的使用者同意")).toEqual([
      { type: "paragraph", text: ">50% 的使用者同意" },
    ]);
    expect(parseSlideContentBlocks(">= 90 分通過")).toEqual([
      { type: "paragraph", text: ">= 90 分通過" },
    ]);
    expect(parseSlideContentBlocks("> 這才是引用")).toEqual([
      { type: "quote", text: "這才是引用" },
    ]);
    expect(parseSlideContentBlocks(">「這也是引用」")).toEqual([
      { type: "quote", text: "「這也是引用」" },
    ]);
  });
});

describe("無空白標題不得把井號漏進文字", () => {
  it("兩個以上的井號直接接 ASCII 也是標題，層級不能被回溯改掉", () => {
    // 貪婪的 #{1,6} 一旦回溯成較短的井號串，多出來的 `#` 就會被推進標題文字裡：層級變錯，
    // 而且一個 `#` 會被畫上投影片，正是這支解析器要根除的東西。
    expect(parseSlideContentBlocks("###Roadmap")).toEqual([
      { type: "heading", level: 3, text: "Roadmap" },
    ]);
    expect(parseSlideContentBlocks("##Q3 目標")).toEqual([
      { type: "heading", level: 2, text: "Q3 目標" },
    ]);
  });

  it("七個以上的井號收斂成 h6，不留下多的井號", () => {
    expect(parseSlideContentBlocks("####### 七個井號")).toEqual([
      { type: "heading", level: 6, text: "七個井號" },
    ]);
  });

  it("單一井號接 ASCII 仍是可見文字，不是標題", () => {
    expect(parseSlideContentBlocks("#1 產品線")).toEqual([
      { type: "paragraph", text: "#1 產品線" },
    ]);
    expect(parseSlideContentBlocks("#hashtag")).toEqual([{ type: "paragraph", text: "#hashtag" }]);
  });
});

/**
 * 以下鎖住的是「已知會退化、但不掉字」的行為。留著是為了讓日後任何改動都在 diff 裡現形，
 * 不是宣告這些結果是理想解。
 */
describe("已知限制（僅記錄現況）", () => {
  it("有序清單被縮排子條列打斷後會分成兩個 steps 區塊", () => {
    expect(parseSlideContentBlocks("1. 甲\n   - 子項\n2. 乙").map((block) => block.type)).toEqual([
      "steps",
      "bullets",
      "steps",
    ]);
  });

  it("表格後面沒空行、又剛好帶管線的句子會被吸成一列", () => {
    const content = ["| A | B |", "| --- | --- |", "| 1 | 2 |", "這句話有 | 管線但不是表格"].join(
      "\n",
    );
    expect(parseSlideContentBlocks(content)).toEqual([
      {
        type: "table",
        header: ["A", "B"],
        rows: [
          ["1", "2"],
          ["這句話有", "管線但不是表格"],
        ],
      },
    ]);
  });

  it("setext 標題的等號底線留在文字裡", () => {
    expect(parseSlideContentBlocks("年度回顧\n===")).toEqual([
      { type: "paragraph", text: "年度回顧\n===" },
    ]);
  });

  it("跨行的粗體收不了尾，標記字元原樣留著（但會被標成 unparsed）", () => {
    expect(parseSlideContentBlocks("**開頭在這行\n結尾在下一行**")).toEqual([
      { type: "paragraph", text: "**開頭在這行\n結尾在下一行**", unparsed: true },
    ]);
  });
});

describe("星號當乘號時不得吃掉數字", () => {
  // emphasis 是「刪改畫面上的數字」的路徑：合約自己要求每個數字都得already出現在
  // slide.content 裡，解析器卻先把 3*4*5 變成 345，等於製造出來源沒有的數字。
  it("沒有空白的乘式一個字元都不變", () => {
    expect(parseSlideContentBlocks("3*4*5 公尺")).toEqual([
      { type: "paragraph", text: "3*4*5 公尺" },
    ]);
    expect(parseSlideContentBlocks("價格 5*2=10，共 10*3=30")).toEqual([
      { type: "paragraph", text: "價格 5*2=10，共 10*3=30" },
    ]);
    expect(normalizeInlineMarkup("解析度 1920*1080")).toBe("解析度 1920*1080");
    // 兩個星號的冪次寫法同樣不能把兩個數字黏起來。
    expect(normalizeInlineMarkup("2**10 和 3**4")).toBe("2**10 和 3**4");
    expect(normalizeInlineMarkup("欄寬 w*h*d")).toBe("欄寬 w*h*d");
  });

  it("真正的粗體與斜體不受影響", () => {
    expect(parseSlideContentBlocks("**12.4M** 使用者，*成長* 三倍")).toEqual([
      {
        type: "paragraph",
        text: "12.4M 使用者，成長 三倍",
        emphasis: ["12.4M", "成長"],
      },
    ]);
    expect(parseSlideContentBlocks("毛利率**成長 2.7pp**，客訴**下降 31%**")).toEqual([
      {
        type: "paragraph",
        text: "毛利率成長 2.7pp，客訴下降 31%",
        emphasis: ["成長 2.7pp", "下降 31%"],
      },
    ]);
  });
});

describe("有序清單的序號語意", () => {
  it("年份加句號不是清單序號，數字必須留在文字裡", () => {
    expect(parseSlideContentBlocks("2025. 年度回顧")).toEqual([
      { type: "paragraph", text: "2025. 年度回顧" },
    ]);
  });

  it("從中間開始編號時帶上 start，模型才不會重編成 1", () => {
    expect(parseSlideContentBlocks("5. 第五步\n6. 第六步")).toEqual([
      { type: "steps", items: ["第五步", "第六步"], start: 5 },
    ]);
    // 從 1 開始是預設值，不必多送一個欄位。
    expect(parseSlideContentBlocks("1. 甲\n2. 乙")).toEqual([
      { type: "steps", items: ["甲", "乙"] },
    ]);
  });

  it("序號不連續就不是清單，原文連同編號退回段落", () => {
    expect(parseSlideContentBlocks("7. 甲\n3. 乙")).toEqual([
      { type: "paragraph", text: "7. 甲\n3. 乙" },
    ]);
  });
});

describe("殘留 markup 要標記出來，而不是默許畫上投影片", () => {
  it("缺分隔列的 pipe 表格仍解析成表格", () => {
    // outlineBrevityInstruction 鼓勵模型用 pipe table 卻沒提分隔列，這是必然出現的輸入。
    expect(parseSlideContentBlocks("| 指標 | 值 |\n| 營收 | 12 |")).toEqual([
      { type: "table", header: ["指標", "值"], rows: [["營收", "12"]] },
    ]);
  });

  it("未收尾的粗體留著字元，但掛上 unparsed 讓合約下令詮釋它", () => {
    expect(parseSlideContentBlocks("**重點一未收尾")).toEqual([
      { type: "paragraph", text: "**重點一未收尾", unparsed: true },
    ]);
    expect(parseSlideContentBlocks("指令是 `pnpm check 忘了收尾")).toEqual([
      { type: "paragraph", text: "指令是 `pnpm check 忘了收尾", unparsed: true },
    ]);
  });

  it("單獨一個當標點用的符號不算殘留 markup", () => {
    // 這些字元是內容本身，掛上 unparsed 等於叫模型別畫，數字語意就沒了。
    for (const text of ["成本 2 * 3 = 6", "決策樹：A | B | C", "區間 3-5 天", ">50% 同意"])
      expect(parseSlideContentBlocks(text)[0]).not.toHaveProperty("unparsed");
  });
});

describe("表格判定不得凌駕標題與條列", () => {
  it("標題行裡的管線不會讓 ## 變成表頭第一格", () => {
    const content = ["## 產品 | 定位", "|---|---|", "| a | b |"].join("\n");
    expect(parseSlideContentBlocks(content)).toEqual([
      { type: "heading", level: 2, text: "產品 | 定位" },
      { type: "table", header: ["a", "b"], rows: [] },
    ]);
  });

  it("沒被表格用到的分隔列是純語法，不畫出來", () => {
    expect(parseSlideContentBlocks("結論如下\n\n|---|---|")).toEqual([
      { type: "paragraph", text: "結論如下" },
    ]);
  });

  it("條列與引用裡的管線同樣不會被表格搶走", () => {
    expect(parseSlideContentBlocks("- 甲 | 乙\n| --- | --- |")).toEqual([
      { type: "bullets", items: ["甲 | 乙"] },
    ]);
  });
});

describe("全形管線表格", () => {
  it("整行以全形管線起訖時視為表格語法", () => {
    const content = ["｜ 指標 ｜ 值 ｜", "｜ --- ｜ --- ｜", "｜ 成本 ｜ -18% ｜"].join("\n");
    expect(parseSlideContentBlocks(content)).toEqual([
      { type: "table", header: ["指標", "值"], rows: [["成本", "-18%"]] },
    ]);
  });

  it("句子中間的全形管線是標點，原樣保留", () => {
    expect(parseSlideContentBlocks("決策樹：A ｜ B ｜ C 三選一。")).toEqual([
      { type: "paragraph", text: "決策樹：A ｜ B ｜ C 三選一。" },
    ]);
  });
});

describe("emphasis 是不帶位置的詞表，短數字詞元要丟掉", () => {
  it("純數字的強調詞不進 emphasis，文字本身照留", () => {
    // 留下 "1" 會讓模型把 `11 項`、`1 天` 裡的 1 全部加粗。
    expect(parseSlideContentBlocks("**1** 名第一，共 11 項，1 天完成")).toEqual([
      { type: "paragraph", text: "1 名第一，共 11 項，1 天完成" },
    ]);
  });

  it("帶字母或漢字的強調詞照常保留", () => {
    const [block] = parseSlideContentBlocks("**Q3** 與 **甲** 都要");
    expect(block).toMatchObject({ emphasis: ["Q3", "甲"] });
  });
});

describe("敘述欄位的行級 markup 也要剝掉", () => {
  it("normalizePlainTextMarkup 去掉標題、條列與表格語法但不掉字", () => {
    const narrative = ["### 講者重點", "- 先講 **成本**", "| A | B |", "| 1 | 2 |"].join("\n");
    const normalized = normalizePlainTextMarkup(narrative);
    for (const marker of ["#", "*", "|"]) expect(normalized).not.toContain(marker);
    for (const fragment of ["講者重點", "先講 成本", "A", "B", "1", "2"])
      expect(normalized).toContain(fragment);
  });

  it("純文字與空字串原樣返回", () => {
    expect(normalizePlainTextMarkup("由問題走向解法")).toBe("由問題走向解法");
    expect(normalizePlainTextMarkup("")).toBe("");
    expect(normalizePlainTextMarkup("   ")).toBe("   ");
  });

  it("整段都是版面語法時回空字串，而不是把語法送回去", () => {
    // dataBasis 是逐條正規化的，分隔列會單獨成為一條——原樣回傳等於把 `| --- |` 送進 prompt。
    expect(normalizePlainTextMarkup("| --- | --- |")).toBe("");
    expect(normalizePlainTextMarkup("---")).toBe("");
  });
});

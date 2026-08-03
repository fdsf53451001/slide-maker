import { describe, expect, it } from "vitest";
import {
  outlineMarkdown,
  outlineMarkdownFilename,
  safeProjectFilename,
  slideSpecSchema,
  type SlideSpec,
} from "../src/index.js";

/**
 * 大綱 Markdown 的格式合約。
 *
 * 這份 md 有兩個來源不同的下載點（伺服器匯出端點、精靈裡的本地草稿），設計意圖之一是
 * **原樣回丟成「大綱參考」來源再讀一次**，所以「檔案裡有什麼」與「檔案裡不准有什麼」
 * 同樣重要：多一行 `## …` 就是多一頁不存在的投影片。
 */

/** schema 的 default 補齊其餘欄位，測試只寫這一條在意的那幾格。 */
function slide(fields: Partial<SlideSpec> & { id: string; order: number }): SlideSpec {
  return slideSpecSchema.parse(fields);
}

describe("outlineMarkdown 的輸出結構", () => {
  it("專案名是 h1、每頁是 `## <序號>. <purpose>`，content 原樣、敘事進 blockquote", () => {
    const markdown = outlineMarkdown({
      name: "年度回顧",
      slides: [
        slide({
          id: "a",
          order: 0,
          purpose: "開場",
          content: "- 一\n- 二",
          narrative: "先講背景。",
          layoutHint: "左圖右文",
        }),
        slide({
          id: "b",
          order: 1,
          purpose: "數據",
          content: "| 季 | 營收 |\n| - | - |\n| Q1 | 100 |",
          narrative: "帶出成長。",
          layoutHint: "全幅表格",
        }),
      ],
    });

    expect(markdown).toBe(
      [
        "# 年度回顧",
        "",
        "## 1. 開場",
        "",
        "- 一",
        "- 二",
        "",
        "> 講述：先講背景。",
        "",
        "## 2. 數據",
        "",
        "| 季 | 營收 |",
        "| - | - |",
        "| Q1 | 100 |",
        "",
        "> 講述：帶出成長。",
        "",
      ].join("\n"),
    );
  });

  /*
   * `layoutHint` 缺席是**刻意的**，不是忘了接。它是給影像模型的版面指示；這份 md 要能回丟成
   * 「大綱參考」來源，版面指示混進正文再匯入時會被當成投影片要講的內容。
   */
  it("layoutHint 一個字都不出現", () => {
    const markdown = outlineMarkdown({
      name: "版面指示不外流",
      slides: [
        slide({
          id: "a",
          order: 0,
          purpose: "封面",
          content: "標題頁",
          layoutHint: "置中大標配滿版底圖",
        }),
      ],
    });

    expect(markdown).not.toContain("置中大標配滿版底圖");
    expect(markdown).not.toContain("構圖");
  });

  it("其他非大綱欄位（imagePrompt／dataBasis／sourceIds）也不出現", () => {
    const markdown = outlineMarkdown({
      name: "只留大綱欄位",
      slides: [
        slide({
          id: "a",
          order: 0,
          purpose: "封面",
          content: "標題頁",
          imagePrompt: "cinematic wide shot of a city",
          dataBasis: ["主計總處 2026 年報"],
          sourceIds: ["source-1"],
          pinnedSourceIds: ["source-1"],
        }),
      ],
    });

    expect(markdown).not.toContain("cinematic");
    expect(markdown).not.toContain("主計總處");
    expect(markdown).not.toContain("source-1");
  });

  it("檔尾固定一個換行，且不是兩個", () => {
    const markdown = outlineMarkdown({
      name: "檔尾",
      slides: [slide({ id: "a", order: 0, purpose: "唯一一頁", content: "內容" })],
    });

    expect(markdown.endsWith("內容\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });

  it("依 order 排序而不是相信陣列順序", () => {
    const markdown = outlineMarkdown({
      name: "亂序輸入",
      slides: [
        slide({ id: "c", order: 2, purpose: "第三" }),
        slide({ id: "a", order: 0, purpose: "第一" }),
        slide({ id: "b", order: 1, purpose: "第二" }),
      ],
    });

    expect(markdown.match(/^## .*$/gm)).toEqual(["## 1. 第一", "## 2. 第二", "## 3. 第三"]);
  });

  it("序號取自 `order` 欄位本身，不是排序後的陣列位置", () => {
    // `order + 1` 與 `exportSlideFilename()`（`001.png`／`005.png`）是同一條慣例：對的是
    // 專案裡的實際頁序。排序後重新編號會讓兩份成品裡的同一頁對不上號。
    const markdown = outlineMarkdown({
      name: "序號來源",
      slides: [
        slide({ id: "a", order: 0, purpose: "第一" }),
        slide({ id: "b", order: 4, purpose: "第五" }),
      ],
    });

    expect(markdown.match(/^## .*$/gm)).toEqual(["## 1. 第一", "## 5. 第五"]);
  });
});

describe("隱藏頁照樣收錄", () => {
  /*
   * `hidden` 的語意是「這一頁不上場」而不是「不要這一頁的內容」，`png.zip`／`slide-project`
   * 也都收錄它，而大綱是內容文件。序號用 `order + 1` **不扣掉隱藏頁**：那是頁碼（chrome）
   * 才有的規則，這裡對的是專案裡的實際頁序（與 `exportSlideFilename()` 同一條慣例）。
   */
  it("隱藏頁有標註，序號仍是 order + 1（後面的頁不會遞補上來）", () => {
    const markdown = outlineMarkdown({
      name: "含隱藏頁",
      slides: [
        slide({ id: "a", order: 0, purpose: "上場" }),
        slide({ id: "b", order: 1, purpose: "備用", hidden: true }),
        slide({ id: "c", order: 2, purpose: "結尾" }),
      ],
    });

    expect(markdown.match(/^## .*$/gm)).toEqual(["## 1. 上場", "## 2. 備用", "## 3. 結尾"]);
    expect(markdown).toContain("## 2. 備用\n\n（這一頁在原簡報中設為隱藏");
  });

  /*
   * 註記**不可以**寫在 `##` 那一行。這份 md 要能原樣回丟成「大綱參考」，而
   * `buildOutlineReference()` 是逐字塞進 prompt 的：註記留在標題行時，模型讀到的頁標題字面
   * 上就是「備用（隱藏頁）」，而 `hidden` 不是大綱 schema 的欄位——模型沒有任何方式把一頁
   * 設成隱藏，它唯一做得到的就是把那幾個字照抄進標題，於是新專案長出一頁真的叫
   * 「備用（隱藏頁）」的投影片。
   */
  it("註記落在正文而不是標題行（否則回丟成大綱參考時會變成頁標題的一部分）", () => {
    const markdown = outlineMarkdown({
      name: "註記位置",
      slides: [slide({ id: "a", order: 0, purpose: "備用", hidden: true, content: "內文" })],
    });

    const headings = markdown.match(/^## .*$/gm)!;
    expect(headings).toEqual(["## 1. 備用"]);
    // 標題行乾淨：一個「隱藏」都不在上面。
    for (const heading of headings) expect(heading).not.toMatch(/隱藏/);
    // 而註記確實在檔案裡、自成一行、講的是原簡報的狀態。
    const noteLine = markdown.split("\n").find((line) => line.includes("隱藏"))!;
    expect(noteLine).toBe("（這一頁在原簡報中設為隱藏：不放映，也不會進 pptx／pdf。）");
  });

  it("隱藏頁的 content 與敘事一併收錄（它不是被排除，只是被標註）", () => {
    const markdown = outlineMarkdown({
      name: "隱藏頁內容",
      slides: [
        slide({
          id: "a",
          order: 0,
          purpose: "備用",
          content: "這段內容仍然要出現",
          narrative: "這段敘事仍然要出現",
          hidden: true,
        }),
      ],
    });

    expect(markdown).toContain("這段內容仍然要出現");
    expect(markdown).toContain("> 講述：這段敘事仍然要出現");
  });

  it("全部頁面都隱藏時仍是一份完整的大綱，不是空檔", () => {
    const markdown = outlineMarkdown({
      name: "全部隱藏",
      slides: [
        slide({ id: "a", order: 0, purpose: "一", content: "內容一", hidden: true }),
        slide({ id: "b", order: 1, purpose: "二", content: "內容二", hidden: true }),
      ],
    });

    expect(markdown.match(/^## .*$/gm)).toEqual(["## 1. 一", "## 2. 二"]);
    expect(markdown).toContain("內容一");
    expect(markdown).toContain("內容二");
    // 兩頁各自帶一份註記（不是整份檔案共用一句）。
    expect(markdown.split("（這一頁在原簡報中設為隱藏").length - 1).toBe(2);
  });
});

describe("空欄位與空專案", () => {
  it("purpose 是空的就只留編號，不補「（未命名）」這類佔位字", () => {
    const markdown = outlineMarkdown({
      name: "空目的",
      slides: [slide({ id: "a", order: 0, purpose: "", content: "有內容" })],
    });

    // 佔位字會在回丟成大綱參考時變成一個模型看得見的頁面標題，而那並不是使用者寫的。
    expect(markdown).toBe("# 空目的\n\n## 1.\n\n有內容\n");
  });

  it("purpose 只有空白字元時同樣只留編號（不留一個尾隨空格）", () => {
    const markdown = outlineMarkdown({
      name: "空白目的",
      slides: [slide({ id: "a", order: 0, purpose: "   \n  ", content: "有內容" })],
    });

    expect(markdown).toBe("# 空白目的\n\n## 1.\n\n有內容\n");
  });

  it("purpose 空但頁面隱藏時，標題只剩編號、註記自成一行", () => {
    const markdown = outlineMarkdown({
      name: "空目的隱藏頁",
      slides: [slide({ id: "a", order: 0, purpose: "", hidden: true })],
    });

    expect(markdown).toBe(
      "# 空目的隱藏頁\n\n## 1.\n\n（這一頁在原簡報中設為隱藏：不放映，也不會進 pptx／pdf。）\n",
    );
  });

  it("content 空就整行不出現，不留空的佔位", () => {
    const markdown = outlineMarkdown({
      name: "空內容",
      slides: [
        slide({ id: "a", order: 0, purpose: "只有敘事", content: "  \n ", narrative: "講" }),
      ],
    });

    expect(markdown).toBe("# 空內容\n\n## 1. 只有敘事\n\n> 講述：講\n");
  });

  it("敘事空就沒有 blockquote，也沒有孤零零的「講述：」", () => {
    const markdown = outlineMarkdown({
      name: "空敘事",
      slides: [slide({ id: "a", order: 0, purpose: "只有內容", content: "內容", narrative: " " })],
    });

    expect(markdown).toBe("# 空敘事\n\n## 1. 只有內容\n\n內容\n");
    expect(markdown).not.toContain("講述");
  });

  it("三個欄位全空的頁面只剩一行編號", () => {
    const markdown = outlineMarkdown({
      name: "全空頁",
      slides: [slide({ id: "a", order: 0 }), slide({ id: "b", order: 1, purpose: "後面還有一頁" })],
    });

    expect(markdown).toBe("# 全空頁\n\n## 1.\n\n## 2. 後面還有一頁\n");
  });

  it("沒有任何頁面時明說一句，而不是只有一行標題", () => {
    // 只有 `# 專案名`、後面空無一物的檔案看起來像下載壞掉，使用者會重按幾次。
    const markdown = outlineMarkdown({ name: "空簡報", slides: [] });

    expect(markdown).toBe("# 空簡報\n\n（這份簡報目前沒有任何頁面。）\n");
  });
});

describe("標題行不得偽造出不存在的頁面", () => {
  /*
   * 專案名稱與 purpose 的 schema 都收得下換行，而 Markdown 的區塊邊界是「行」。這份 md 的
   * 設計意圖之一是原樣回丟成大綱參考來源再讀一次——名稱裡的一個換行就能長出一頁投影片。
   */
  it("專案名稱裡的換行＋`## …` 不會變成一個獨立的頁標題", () => {
    const markdown = outlineMarkdown({
      name: "年報\n## 我是偽造的一頁",
      slides: [slide({ id: "a", order: 0, purpose: "真正的第一頁" })],
    });

    // 檔案裡的 `##` 標題**只有**真正的那一頁。
    expect(markdown.match(/^## .*$/gm)).toEqual(["## 1. 真正的第一頁"]);
    // h1 也只有一行，而且偽造的那段被摺回同一行。
    expect(markdown.match(/^# .*$/gm)).toEqual(["# 年報 ## 我是偽造的一頁"]);
  });

  it("purpose 裡的換行＋`# …` 同樣被摺回同一行", () => {
    const markdown = outlineMarkdown({
      name: "偽造頁標題",
      slides: [
        slide({ id: "a", order: 0, purpose: "真標題\n\n# 假的 h1\n## 假的 h2" }),
        slide({ id: "b", order: 1, purpose: "第二頁" }),
      ],
    });

    expect(markdown.match(/^#{1,6} .*$/gm)).toEqual([
      "# 偽造頁標題",
      "## 1. 真標題 # 假的 h1 ## 假的 h2",
      "## 2. 第二頁",
    ]);
  });

  it("純空白的專案名稱不會產生一行只有 `#` 的標題", () => {
    const markdown = outlineMarkdown({ name: "  \n  ", slides: [] });

    expect(markdown.startsWith("# \n")).toBe(true);
    expect(markdown).not.toContain("#  ");
  });

  /*
   * content 的 `## …` **刻意**原樣保留：它本來就是 markdown，條列與表格就是使用者要的編排。
   * 代價（再匯入時與頁面標題無從區分）是已知且被接受的，這一條把它釘成「刻意」而不是漏網。
   */
  it("content 裡的 `## …` 原樣保留（保住排版優先於防這種自造歧義）", () => {
    const markdown = outlineMarkdown({
      name: "內容有標題",
      slides: [slide({ id: "a", order: 0, purpose: "章節", content: "## 使用者自己寫的小標" })],
    });

    expect(markdown).toContain("\n## 使用者自己寫的小標\n");
  });
});

describe("多段敘事的 blockquote", () => {
  /*
   * narrative 是 textarea，換行是合法輸入。blockquote 的 lazy continuation 遇到**空行**就
   * 結束——只加第一行的話，多段敘事會有一半掉出引用區、變成與 content 同層的正文。
   */
  it("每一行都有 `>` 前綴，空行是單獨一個 `>`", () => {
    const markdown = outlineMarkdown({
      name: "多段敘事",
      slides: [
        slide({
          id: "a",
          order: 0,
          purpose: "講稿",
          narrative: "第一段。\n\n第二段。\n第三段。",
        }),
      ],
    });

    expect(markdown).toBe(
      [
        "# 多段敘事",
        "",
        "## 1. 講稿",
        "",
        "> 講述：第一段。",
        ">",
        "> 第二段。",
        "> 第三段。",
        "",
      ].join("\n"),
    );
  });

  it("敘事的每一行都在引用區內：沒有任何一行是裸的正文", () => {
    const narrative = "起。\n\n承。\n\n轉。\n\n合。";
    const markdown = outlineMarkdown({
      name: "四段",
      slides: [slide({ id: "a", order: 0, purpose: "講稿", narrative })],
    });

    const body = markdown.split("## 1. 講稿\n\n")[1]!.trimEnd();
    for (const line of body.split("\n")) expect(line.startsWith(">")).toBe(true);
  });

  it("空白行（只有空格）也收成 `>`，不會留下 `> ` 的尾隨空白", () => {
    const markdown = outlineMarkdown({
      name: "空白行",
      slides: [slide({ id: "a", order: 0, purpose: "講稿", narrative: "上。\n   \n下。" })],
    });

    expect(markdown).toContain("> 講述：上。\n>\n> 下。");
    expect(markdown).not.toContain("> \n");
  });
});

describe("safeProjectFilename／outlineMarkdownFilename", () => {
  it("檔名是 `<洗過的專案名>.outline.md`", () => {
    expect(outlineMarkdownFilename("Q3 產品回顧")).toBe("Q3-產品回顧.outline.md");
  });

  it("中日韓字與數字原樣留著，其餘連續字元收成一個 `-`", () => {
    expect(safeProjectFilename("年度 報告 2026")).toBe("年度-報告-2026");
    expect(safeProjectFilename("a   b")).toBe("a-b");
    expect(safeProjectFilename("a!!!@@@b")).toBe("a-b");
  });

  it("`.`、`_`、`-` 是允許字元，不會被洗掉", () => {
    expect(safeProjectFilename("v1.2_final-draft")).toBe("v1.2_final-draft");
  });

  it("路徑分隔字元一律洗成 `-`（不是取最後一段）", () => {
    // 舊版用 node 的 `basename()`，core 是前端也要 bundle 的套件，不能相依 node:path。
    // 差別只在 `a/b` 從 `b` 變成 `a-b`，而這是下載檔名、不是磁碟路徑。
    expect(safeProjectFilename("a/b")).toBe("a-b");
    expect(safeProjectFilename("a\\b")).toBe("a-b");
    expect(outlineMarkdownFilename("../../etc/passwd")).not.toContain("/");
  });

  /*
   * 拿掉 `basename()` 引進的**迴歸**，不是既有行為：`./設計` 洗完是 `.-設計`，而 `.` 開頭
   * 的檔案在 macOS／Linux 上是隱藏檔——使用者下載完在資料夾裡根本看不到它。舊版經過
   * `basename()` 得到的是 `設計`。
   */
  it("開頭的點一律剝掉（`.` 開頭在 macOS／Linux 上是看不見的隱藏檔）", () => {
    expect(safeProjectFilename("./設計")).toBe("設計");
    expect(safeProjectFilename(".hidden")).toBe("hidden");
    expect(safeProjectFilename("../../etc/passwd")).toBe("etc-passwd");
    expect(outlineMarkdownFilename("./設計")).toBe("設計.outline.md");
    // 只剝開頭：中間與結尾的點是正常的檔名字元（版號、副檔名都靠它）。
    expect(safeProjectFilename("v1.2_final-draft")).toBe("v1.2_final-draft");
  });

  it("頭尾的 `-` 一律去掉", () => {
    expect(safeProjectFilename("  邊界  ")).toBe("邊界");
    expect(safeProjectFilename("---邊界---")).toBe("邊界");
  });

  it("洗光了就退回 `presentation`（不能產生一個叫 `.outline.md` 的隱藏檔）", () => {
    expect(safeProjectFilename("!!!")).toBe("presentation");
    expect(safeProjectFilename("")).toBe("presentation");
    expect(outlineMarkdownFilename("///")).toBe("presentation.outline.md");
  });

  it("換行同樣不會留在檔名裡", () => {
    expect(outlineMarkdownFilename("年報\n## 我是偽造的一頁")).toBe(
      "年報-我是偽造的一頁.outline.md",
    );
  });
});

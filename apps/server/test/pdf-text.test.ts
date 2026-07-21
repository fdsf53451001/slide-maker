import { describe, expect, it } from "vitest";
import {
  extractTitle,
  mergeFragmentsIntoLines,
  mergeFragmentsIntoRuns,
  mergeLinesIntoBlocks,
  orderBlocksForReading,
  pageContent,
  repeatedBlockKeys,
  type PdfTextFragment,
} from "../src/pdf-text.js";

function fragment(
  text: string,
  x: number,
  baseline: number,
  fontSize: number,
  width = text.length * fontSize * 0.5,
): PdfTextFragment {
  return { text, x, baseline, width, fontSize, fontName: "f1" };
}

describe("mergeFragmentsIntoLines", () => {
  it("joins fragments on the same baseline and inserts a space at word gaps", () => {
    const lines = mergeFragmentsIntoLines([
      fragment("Revenue", 100, 200, 20, 70),
      fragment("up", 178, 200, 20, 20),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("Revenue up");
  });

  it("does not insert a space between adjacent CJK fragments", () => {
    const lines = mergeFragmentsIntoLines([
      fragment("營收", 100, 200, 20, 40),
      fragment("成長", 148, 200, 20, 40),
    ]);
    expect(lines[0]?.text).toBe("營收成長");
  });

  it("splits two columns on the same baseline into separate lines", () => {
    const lines = mergeFragmentsIntoLines([
      fragment("left column", 100, 200, 20, 110),
      fragment("right column", 600, 200, 20, 120),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["left column", "right column"]);
  });

  it("drops whitespace-only fragments", () => {
    expect(mergeFragmentsIntoLines([fragment("  ", 0, 10, 12)])).toEqual([]);
  });
});

/**
 * 這些案例全部取自真實簡報 PDF 的實測座標。共通結構是：`mergeFragmentsIntoLines`
 * 為了 `content` 的閱讀順序，刻意把整條視覺行併成一段（下面每個案例都附了對照斷言，
 * 那個行為不能回歸）；但一個 `EditableTextBox` 只有一組字級／字重／字族與一個 x，
 * 拿那條行去畫文字層必然失真，所以文字層改用 run。
 */
describe("mergeFragmentsIntoRuns", () => {
  const styled = (fontName: string) => (name: string) => (name === fontName ? "a" : "b");
  const uniform = () => "same";

  it("splits a mixed-size line so the small run keeps its own size and stays on the page", () => {
    // 「陳惠菁」64.1px 粗體 + 「玉山商業銀行資訊處資深主任工程師」48px 常規，同一條基線。
    const fragments = [
      { ...fragment("陳惠菁", 835, 350, 64.1, 192), fontName: "bold" },
      { ...fragment("玉山商業銀行資訊處資深主任工程師", 1059, 350, 48, 795), fontName: "body" },
    ];
    // 併成一條行時字級取 max：19 個字用 64.1px 畫要 1200px 以上，從 x=835 起畫必然出界。
    const merged = mergeFragmentsIntoLines(fragments);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.fontSize).toBe(64.1);
    expect(835 + merged[0]!.text.length * 64.1).toBeGreaterThan(1920);

    const runs = mergeFragmentsIntoRuns(fragments, styled("bold"));
    expect(runs.map((run) => run.text)).toEqual(["陳惠菁", "玉山商業銀行資訊處資深主任工程師"]);
    expect(runs.map((run) => run.fontSize)).toEqual([64.1, 48]);
    expect(runs.map((run) => run.x)).toEqual([835, 1059]);
    for (const run of runs)
      expect(run.x + run.text.length * run.fontSize).toBeLessThanOrEqual(1920);
  });

  it("splits at a gap too wide to be a space so later text keeps its position", () => {
    // 「內建NLU*」與「意圖模型…」之間空著上標「註1」的 35px；併成一行只會補一個空白，
    // 後面整段就左移約 25px，撞上獨立定位的上標框。
    const fragments = [
      fragment("內建NLU*", 435, 812, 36, 166),
      fragment("意圖模型、Flow固定流程與RAG", 636, 812, 36, 509),
    ];
    expect(mergeFragmentsIntoLines(fragments)).toHaveLength(1);

    const runs = mergeFragmentsIntoRuns(fragments, uniform);
    expect(runs.map((run) => run.text)).toEqual(["內建NLU*", "意圖模型、Flow固定流程與RAG"]);
    expect(runs.map((run) => run.x)).toEqual([435, 636]);
  });

  it("splits a smaller inline run even when it is flush against the text before it", () => {
    // 註標與本文同字型同字重（樣式鍵一模一樣）、同一條基線、中間沒有空隙——
    // 只有字級不同。併起來的話 24px 的註標會被 36px 畫，寬度多出 50%。
    const runs = mergeFragmentsIntoRuns(
      [fragment("RAG", 1100, 812, 36, 100), fragment("註2", 1200, 812, 24, 39)],
      uniform,
    );
    expect(runs.map((run) => run.text)).toEqual(["RAG", "註2"]);
    expect(runs.map((run) => run.fontSize)).toEqual([36, 24]);
  });

  it("keeps a lowered same-size subscript out of the main run", () => {
    // 下標的基線落在主行下方；`mergeFragmentsIntoLines` 的 0.4 字級容差收得下它，
    // 併進去就會被拉回主行基線畫。
    const fragments = [fragment("H", 100, 800, 24, 18), fragment("2", 118, 806, 24, 14)];
    expect(mergeFragmentsIntoLines(fragments)).toHaveLength(1);

    const runs = mergeFragmentsIntoRuns(fragments, uniform);
    expect(runs.map((run) => run.text)).toEqual(["H", "2"]);
    expect(runs.map((run) => run.baseline)).toEqual([800, 806]);
  });

  it("splits where the rendered style changes even without a gap", () => {
    const runs = mergeFragmentsIntoRuns(
      [
        { ...fragment("1.", 131, 320, 40, 42), fontName: "bold" },
        { ...fragment("技術選型", 173, 320, 40, 160), fontName: "body" },
      ],
      styled("bold"),
    );
    expect(runs.map((run) => run.text)).toEqual(["1.", "技術選型"]);
  });

  it("still joins one continuous run, including its word spaces", () => {
    const runs = mergeFragmentsIntoRuns(
      [fragment("Revenue", 100, 200, 20, 70), fragment("up", 178, 200, 20, 20)],
      uniform,
    );
    expect(runs.map((run) => run.text)).toEqual(["Revenue up"]);
  });

  it("joins two subsets of the same face — the style key decides, not the font name", () => {
    const runs = mergeFragmentsIntoRuns(
      [
        { ...fragment("營收", 100, 200, 20, 40), fontName: "ABCDEF+Sans" },
        { ...fragment("成長", 140, 200, 20, 40), fontName: "GHIJKL+Sans" },
      ],
      uniform,
    );
    expect(runs.map((run) => run.text)).toEqual(["營收成長"]);
  });
});

describe("mergeLinesIntoBlocks", () => {
  it("merges consecutive body lines into one paragraph block", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        fragment("first line", 100, 200, 20, 200),
        fragment("second line", 100, 224, 20, 200),
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("first line\nsecond line");
  });

  /**
   * 多欄版面的行是依基線交錯進來的（左欄第一行、中欄第一行、右欄第一行、左欄第二行 …），
   * 所以續行不能只跟「上一個塊」比對——那樣同一欄的續行永遠接不上，整段會碎成一行一塊，
   * 之後不管怎麼排順序都補不回來。續行要接到還開著的塊裡水平重疊得上的那一個。
   */
  it("merges a wrapped paragraph whose continuation arrives after other columns' lines", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        fragment("程式開發、科學與資安能力", 164, 486, 25.9, 396),
        fragment("以大約半價成本提供", 756, 486, 25.9, 389),
        fragment("全面突破。", 164, 521, 25.9, 130),
        fragment("GPT-5.5 等級效能", 756, 521, 25.9, 396),
      ]),
    );
    expect(blocks.map((block) => block.text)).toEqual([
      "程式開發、科學與資安能力\n全面突破。",
      "以大約半價成本提供\nGPT-5.5 等級效能",
    ]);
  });

  it("keeps a large heading separate from the body below it", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        fragment("Heading", 100, 100, 48, 300),
        fragment("body copy", 100, 200, 18, 200),
      ]),
    );
    expect(blocks.map((block) => block.text)).toEqual(["Heading", "body copy"]);
  });
});

describe("orderBlocksForReading", () => {
  it("reads the left column fully before the right column", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        fragment("L1", 100, 200, 20, 200),
        fragment("R1", 1000, 205, 20, 200),
        fragment("L2", 100, 400, 20, 200),
        fragment("R2", 1000, 405, 20, 200),
      ]),
    );
    const ordered = orderBlocksForReading(blocks, 1920);
    expect(ordered.map((block) => block.text)).toEqual(["L1", "L2", "R1", "R2"]);
  });

  /**
   * 68/32 的「主文 + 側欄」：主文寬度佔 62%，用固定的「> 60% 就算跨欄」門檻判定會
   * 把主文全部當成跨欄塊，欄位偵測整組失效並退回純 y 排序 —— 主文與側欄逐行交錯。
   */
  it("separates an uneven main column and sidebar instead of interleaving them", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        fragment("main one", 100, 200, 20, 1200),
        fragment("side one", 1420, 260, 20, 400),
        fragment("main two", 100, 400, 20, 1200),
        fragment("side two", 1420, 460, 20, 400),
      ]),
    );
    expect(orderBlocksForReading(blocks, 1920).map((block) => block.text)).toEqual([
      "main one",
      "main two",
      "side one",
      "side two",
    ]);
  });

  /**
   * 表格不能做欄位切分：左右兩群重排之後「標籤 ↔ 數字」的對應關係會整個消失，
   * 而錯配的數字會原樣送進生圖模型。
   */
  it("keeps a table row-major instead of shredding it into columns", () => {
    const cell = (text: string, x: number, baseline: number) =>
      fragment(text, x, baseline, 20, 120);
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        cell("Region", 200, 200),
        cell("Q1", 800, 200),
        cell("Q2", 1400, 200),
        cell("APAC", 200, 300),
        cell("120", 800, 300),
        cell("140", 1400, 300),
        cell("EMEA", 200, 400),
        cell("90", 800, 400),
        cell("95", 1400, 400),
      ]),
    );
    expect(orderBlocksForReading(blocks, 1920).map((block) => block.text)).toEqual([
      "Region",
      "Q1",
      "Q2",
      "APAC",
      "120",
      "140",
      "EMEA",
      "90",
      "95",
    ]);
  });

  it("keeps a full-width block in document position and orders single-column pages top-down", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        fragment("wide title", 100, 100, 40, 1700),
        fragment("L1", 100, 300, 20, 200),
        fragment("R1", 1000, 305, 20, 200),
        fragment("L2", 100, 500, 20, 200),
        fragment("R2", 1000, 505, 20, 200),
      ]),
    );
    expect(orderBlocksForReading(blocks, 1920).map((block) => block.text)).toEqual([
      "wide title",
      "L1",
      "L2",
      "R1",
      "R2",
    ]);
  });
});

/**
 * 以下的固定資料全部抄自一份真實 Keynote 匯出 PDF（960×540、7 頁、646 個 text item，
 * 縮放到 1920×1080 畫布）的實測座標，包含它真正的碎片化方式：項目符號自成一個 item、
 * 段落被硬斷成多行、而且多欄版面的行是**依基線交錯**送出來的。
 *
 * 理想化的合成資料（每欄一次給完、不含項目符號）測不出這些缺陷 —— 上一輪 232 個單元測試
 * 全綠，真實檔案的 `content` 卻整個交錯錯亂。
 */
describe("real deck geometry", () => {
  /** 塊的 y 是 `baseline - fontSize * 0.85`；實測資料記的是 y，這裡換回基線。 */
  const at = (text: string, x: number, top: number, fontSize: number, width: number) =>
    fragment(text, x, top + fontSize * 0.85, fontSize, width);

  const contentOf = (fragments: PdfTextFragment[]) =>
    pageContent(
      orderBlocksForReading(mergeLinesIntoBlocks(mergeFragmentsIntoLines(fragments)), 1920),
    );

  /** 三欄卡片：欄距 196px，置中大標只橫跨 582–1338（碰不到第 1、3 欄）。 */
  const threeColumnCards = (): PdfTextFragment[] => {
    const columns = [
      { bullet: 176, text: 230, name: 305, body: 164 },
      { bullet: 768, text: 822, name: 897, body: 756 },
      { bullet: 1360, text: 1414, name: 1489, body: 1348 },
    ] as const;
    const names = ["GPT-5.6-sol", "GPT-5.6-terra", "GPT-5.6-luna"];
    const tiers = ["旗艦", "均衡", "高性價比"];
    const descriptions = [
      ["OpenAI 最強推理與 Agent 模型，", "程式開發、科學與資安能力全面突", "破。"],
      ["專為日常工作打造的均衡型模型，", "以大約半價成本提供 GPT-5.5 等級", "效能"],
      ["系列中速度最快、成本最低的模型，", "專為大規模高流量工作負載而打造"],
    ];
    const bullets = [
      ["旗艦級推理模型", "長脈絡思考能力", "多 Agent 協作架構"],
      ["GPT-5.5 級效能表現", "進階推理與工具調用能力"],
      ["最低成本定價層級"],
    ];
    const fragments: PdfTextFragment[] = [
      at("三大層級：依需求選擇最適層級", 582, 85, 54, 757),
      at("GPT-5.6 APIs · General Available", 751, 176, 28.1, 417),
    ];
    for (const [index, column] of columns.entries()) {
      fragments.push(at(names[index]!, column.name, 321, 34.1, 200));
      fragments.push(at(tiers[index]!, column.name, 381, 25, tiers[index]!.length * 25));
      for (const [line, text] of descriptions[index]!.entries())
        fragments.push(at(text, column.body, 464 + line * 35, 25.9, text.length * 13.4));
      for (const [line, text] of bullets[index]!.entries()) {
        fragments.push(at("•", column.bullet, 636 + line * 42, 25, 11));
        fragments.push(at(text, column.text, 636 + line * 42, 25, text.length * 12.5));
      }
    }
    return fragments;
  };

  it("reads three-column cards column by column instead of shredding them row by row", () => {
    const content = contentOf(threeColumnCards());
    // 每張卡片的描述句必須連續且完整，不與別張卡片交錯。
    expect(content).toContain(
      "OpenAI 最強推理與 Agent 模型，\n程式開發、科學與資安能力全面突\n破。",
    );
    expect(content).toContain(
      "專為日常工作打造的均衡型模型，\n以大約半價成本提供 GPT-5.5 等級\n效能",
    );
    expect(content.indexOf("GPT-5.6-sol")).toBeLessThan(content.indexOf("GPT-5.6-terra"));
    expect(content.indexOf("多 Agent 協作架構")).toBeLessThan(content.indexOf("GPT-5.6-terra"));
    expect(content.indexOf("GPT-5.6-terra")).toBeLessThan(content.indexOf("GPT-5.6-luna"));
    // 置中大標只橫跨中間那一欄的 x 範圍，仍必須排在最前面而不是掉進第 2 欄。
    expect(content.startsWith("三大層級：依需求選擇最適層級")).toBe(true);
  });

  it("folds a lone bullet glyph into the item beside it and keeps each column's list together", () => {
    const columns = [
      { bullet: 164, text: 218, heading: 219 },
      { bullet: 756, text: 810, heading: 811 },
      { bullet: 1348, text: 1402, heading: 1403 },
    ] as const;
    const headings = ["典型使用場景", "關鍵能力", "Foundry 部署優勢"];
    // 真實資料裡三欄的項目高度不同、續行縮排回文字左緣，所以行是交錯進來的。
    const items = [
      [
        { top: 370, text: "前沿程式開發與長脈絡 Agent", wrap: "工作流程" },
        { top: 457, text: "網路安全與科學研究等高階推理", wrap: "場景" },
        { top: 543, text: "複雜多步驟專業工作流程處理" },
      ],
      [
        { top: 370, text: "三大層級選擇：Sol（旗艦級）、", wrap: "Terra（均衡型）、Luna（高性" },
        { top: 490, text: "全新 Max／Ultra 推理模式，支", wrap: "援平行 Agent 協作" },
      ],
      [
        { top: 370, text: "OpenAI 歷來最強模型" },
        { top: 423, text: "卓越的效能與成本效益" },
      ],
    ];
    const fragments: PdfTextFragment[] = [
      at("使用場景、關鍵能力與 Foundry 部署優勢", 459, 85, 54, 1002),
    ];
    for (const [index, column] of columns.entries()) {
      fragments.push(at(headings[index]!, column.heading, 258, 31.9, 200));
      for (const item of items[index]!) {
        fragments.push(at("•", column.bullet, item.top, 25.7, 11));
        fragments.push(at(item.text, column.text, item.top, 25.7, item.text.length * 12.9));
        if (item.wrap)
          fragments.push(at(item.wrap, column.text, item.top + 34, 25.7, item.wrap.length * 12.9));
      }
    }
    const blocks = mergeLinesIntoBlocks(mergeFragmentsIntoLines(fragments));
    // 每一欄整條列表要讀完才輪到下一欄的標題，項目符號不單獨成塊。
    expect(orderBlocksForReading(blocks, 1920).map((block) => block.text)).toEqual([
      "使用場景、關鍵能力與 Foundry 部署優勢",
      "典型使用場景",
      "• 前沿程式開發與長脈絡 Agent\n工作流程",
      "• 網路安全與科學研究等高階推理\n場景",
      "• 複雜多步驟專業工作流程處理",
      "關鍵能力",
      "• 三大層級選擇：Sol（旗艦級）、\nTerra（均衡型）、Luna（高性",
      "• 全新 Max／Ultra 推理模式，支\n援平行 Agent 協作",
      "Foundry 部署優勢",
      "• OpenAI 歷來最強模型",
      "• 卓越的效能與成本效益",
    ]);
    expect(
      contentOf(fragments)
        .split("\n")
        .some((line) => line.trim() === "•"),
    ).toBe(false);
  });

  /**
   * 表格與多欄卡片的列結構長得一模一樣（都是「N 欄 × 幾列、x 對齊」），
   * 差別在儲存格會不會換行。這一頁的置中大標同樣只橫跨中間欄位，
   * 舊版的單一分隔線偵測在這裡整組失效。
   */
  it("keeps a real table row-major so labels stay next to their numbers", () => {
    const rows = [
      ["面向", "隨用隨付（Standard / PayGo）", "預配輸送量（PTU）"],
      ["計費單位", "每 token（$/1M tokens）", "每 PTU 每小時（$/PTU/hr）"],
      ["成本行為", "隨用量變動、無需承諾", "固定產能成本、可預測；保留享折扣"],
      [
        "定價依模型",
        "是：Sol $5/$30、Terra $2.50/$15、Luna $1/$6",
        "否：與模型無關，同一 PTU 池共用",
      ],
      ["延遲表現", "隨整體負載波動", "專屬產能，延遲穩定可預測"],
    ];
    const fragments: PdfTextFragment[] = [
      at("PTU vs 隨用隨付：如何比價與選型", 542, 85, 54, 836),
      at("沒有單一贏家 — 取決於流量型態、延遲需求與成本可預測性", 587, 176, 28.1, 745),
    ];
    for (const [index, row] of rows.entries()) {
      const top = index === 0 ? 256 : 329 + (index - 1) * 74;
      const size = index === 0 ? 27.1 : 25.7;
      fragments.push(at(row[0]!, index === 0 ? 214 : 117, top, size, row[0]!.length * 13));
      fragments.push(at(row[1]!, index === 0 ? 547 : 398, top, 24.7, row[1]!.length * 12));
      fragments.push(at(row[2]!, index === 0 ? 1339 : 1118, top, 24.7, row[2]!.length * 12));
    }
    const blocks = mergeLinesIntoBlocks(mergeFragmentsIntoLines(fragments));
    expect(orderBlocksForReading(blocks, 1920).map((block) => block.text)).toEqual([
      "PTU vs 隨用隨付：如何比價與選型",
      "沒有單一贏家 — 取決於流量型態、延遲需求與成本可預測性",
      ...rows.flat(),
    ]);
  });

  /** 四欄特寫列：欄標題一列、內文一列，內文在欄內硬斷成三行。 */
  it("keeps each of four feature columns contiguous", () => {
    const columns = [
      { heading: { text: "前沿推理", x: 230, width: 132 }, body: { x: 152, width: 288 } },
      { heading: { text: "長脈絡工作流程", x: 623, width: 232 }, body: { x: 602, width: 275 } },
      { heading: { text: "分層的成本與速度", x: 1049, width: 265 }, body: { x: 1042, width: 278 } },
      { heading: { text: "穩健的安全體系", x: 1507, width: 232 }, body: { x: 1508, width: 230 } },
    ] as const;
    const bodies = [
      ["全新 Max 模式提供更強大", "的推理能力，Ultra 則可透", "過多個子代理平行協作"],
      ["大規模上下文整合與工具", "協作流程"],
      ["Sol / Terra / Luna 依需求", "平衡推理深度與成本"],
      ["結合 Azure 治理合規"],
    ];
    const fragments: PdfTextFragment[] = [
      at("GPT-5.6 — OpenAI 迄今最強大的模型家族", 418, 183, 55.9, 1084),
    ];
    for (const [index, column] of columns.entries()) {
      fragments.push(at(column.heading.text, column.heading.x, 663, 33.1, column.heading.width));
      for (const [line, text] of bodies[index]!.entries())
        fragments.push(at(text, column.body.x, 735 + line * 33, 25, column.body.width));
    }
    const blocks = mergeLinesIntoBlocks(mergeFragmentsIntoLines(fragments));
    expect(orderBlocksForReading(blocks, 1920).map((block) => block.text)).toEqual([
      "GPT-5.6 — OpenAI 迄今最強大的模型家族",
      "前沿推理",
      "全新 Max 模式提供更強大\n的推理能力，Ultra 則可透\n過多個子代理平行協作",
      "長脈絡工作流程",
      "大規模上下文整合與工具\n協作流程",
      "分層的成本與速度",
      "Sol / Terra / Luna 依需求\n平衡推理深度與成本",
      "穩健的安全體系",
      "結合 Azure 治理合規",
    ]);
  });

  /** `·` 也當項目符號，但左右都有文字的行內分隔號不是——封面頁尾就長這樣。 */
  it("leaves an inline separator alone instead of treating it as a bullet", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        at("截至 2026.07.11 產品更新", 108, 700, 25.9, 301),
        at("·", 461, 700, 25.9, 6),
        at("GCR SMB GTM", 519, 700, 25.9, 180),
      ]),
    );
    expect(blocks.map((block) => block.text)).toEqual([
      "截至 2026.07.11 產品更新",
      "·",
      "GCR SMB GTM",
    ]);
  });
});

describe("extractTitle", () => {
  const blocksFor = (fragments: PdfTextFragment[]) =>
    mergeLinesIntoBlocks(mergeFragmentsIntoLines(fragments));

  it("takes the largest block on the page", () => {
    const blocks = blocksFor([
      fragment("Quarterly Review", 100, 150, 48, 500),
      fragment("supporting detail", 100, 400, 18, 300),
      fragment("another detail", 100, 440, 18, 300),
    ]);
    expect(extractTitle(blocks)).toBe("Quarterly Review");
  });

  it("prefers the topmost block when font sizes tie", () => {
    const blocks = blocksFor([
      fragment("upper", 100, 120, 48, 300),
      fragment("lower", 900, 600, 48, 300),
      fragment("body", 100, 800, 16, 200),
    ]);
    expect(extractTitle(blocks)).toBe("upper");
  });

  it("returns empty when every block shares the same font size", () => {
    const blocks = blocksFor([
      fragment("bullet one", 100, 200, 20, 300),
      fragment("bullet two", 900, 400, 20, 300),
      fragment("bullet three", 100, 600, 20, 300),
    ]);
    expect(extractTitle(blocks)).toBe("");
  });

  /**
   * 字級一致性規則（「全頁字級一樣 = 沒有標題」）只該套用在條列頁、圖表頁那種
   * 密集頁上。封面本來就只有一兩塊字、字級當然一致，被這條規則吃掉的話標題會空白，
   * 而 `pickAnalysisSlides` 又固定把第 1 頁當封面送分析，兩邊訊號會對不起來。
   */
  it("takes the single large heading on a cover page", () => {
    expect(extractTitle(blocksFor([fragment("Annual Report 2026", 100, 300, 72, 900)]))).toBe(
      "Annual Report 2026",
    );
  });

  it("still finds the title when a cover heading and its subtitle share a font size", () => {
    const blocks = blocksFor([
      fragment("Annual Report", 100, 300, 60, 700),
      fragment("Prepared by the finance team", 100, 600, 60, 900),
    ]);
    expect(extractTitle(blocks)).toBe("Annual Report");
  });

  it("ignores page numbers and cross-page headers", () => {
    const page = (title: string, pageNumber: number) =>
      blocksFor([
        // 頁首橫幅比標題還大，靠跨頁重複比對才排除得掉。
        fragment("ACME CONFIDENTIAL", 100, 60, 40, 400),
        fragment(String(pageNumber), 1800, 60, 40, 40),
        fragment(title, 100, 300, 36, 400),
        fragment("body copy", 100, 600, 14, 300),
        fragment("more body copy", 100, 620, 14, 300),
      ]);
    const pages = [page("Real Title", 12), page("Second Title", 13), page("Third Title", 14)];
    const repeated = repeatedBlockKeys(pages);
    expect(repeated.has("acme confidential")).toBe(true);
    expect(extractTitle(pages[0]!, repeated)).toBe("Real Title");
  });

  it("returns empty rather than guessing when nothing qualifies", () => {
    expect(extractTitle([])).toBe("");
  });
});

describe("repeatedBlockKeys", () => {
  it("treats text repeated on three or more pages as boilerplate", () => {
    const page = (extra: string) =>
      mergeLinesIntoBlocks(
        mergeFragmentsIntoLines([
          fragment("ACME Inc.", 100, 60, 12, 100),
          fragment(extra, 100, 300, 30, 300),
        ]),
      );
    const repeated = repeatedBlockKeys([page("one"), page("two"), page("three")]);
    expect([...repeated]).toEqual(["acme inc."]);
  });

  /** 兩頁的 deck 也要比對得出樣板，否則頁首橫幅會變成兩頁共同的標題。 */
  it("drops the threshold to two pages on a two-page selection", () => {
    const page = (extra: string) =>
      mergeLinesIntoBlocks(
        mergeFragmentsIntoLines([
          fragment("ACME CONFIDENTIAL", 100, 60, 30, 300),
          fragment(extra, 100, 300, 28, 300),
        ]),
      );
    expect([...repeatedBlockKeys([page("First"), page("Second")])]).toEqual(["acme confidential"]);
  });

  /** 單頁沒有「跨頁」可言：一頁的內容不該被自己認成樣板。 */
  it("never treats anything on a single page as boilerplate", () => {
    const page = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([fragment("ACME CONFIDENTIAL", 100, 60, 30, 300)]),
    );
    expect([...repeatedBlockKeys([page])]).toEqual([]);
  });

  it("normalizes digits so page numbers match across pages", () => {
    const page = (number: string) =>
      mergeLinesIntoBlocks(mergeFragmentsIntoLines([fragment(`Page ${number}`, 100, 60, 12, 60)]));
    expect([...repeatedBlockKeys([page("1"), page("2"), page("3")])]).toEqual(["page #"]);
  });
});

describe("pageContent", () => {
  it("joins blocks in reading order with a blank line between them", () => {
    const blocks = mergeLinesIntoBlocks(
      mergeFragmentsIntoLines([
        fragment("Title", 100, 100, 40, 300),
        fragment("body", 100, 300, 16, 200),
      ]),
    );
    expect(pageContent(orderBlocksForReading(blocks, 1920))).toBe("Title\n\nbody");
  });
});

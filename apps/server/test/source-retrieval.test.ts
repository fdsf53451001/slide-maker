import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceAsset } from "@slide-maker/core";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteFtsRetriever, ftsTerms } from "../src/retriever.js";
import { knownSourceContext } from "../src/source-context.js";

function source(name: string, texts: readonly string[]): SourceAsset {
  const id = randomUUID();
  return {
    id,
    name,
    mediaType: "text/markdown",
    usage: "content",
    allowModelAccess: true,
    status: "indexed",
    assetPath: `assets/${id}.md`,
    sizeBytes: 1,
    extractedText: texts.join("\n"),
    chunks: texts.map((text, index) => ({
      id: `${id}-${index}`,
      text,
      locator: `chunk:${index + 1}`,
    })),
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function retrieverFor(projectId: string, sources: readonly SourceAsset[]): SqliteFtsRetriever {
  const retriever = new SqliteFtsRetriever(
    join(mkdtempSync(join(tmpdir(), "slide-maker-fts-")), "sources.sqlite"),
  );
  retriever.index(projectId, sources);
  return retriever;
}

describe("FTS 查詢詞拆解", () => {
  it("中文按 3-gram 展開：trigram 索引查不到短於 3 字元的詞", () => {
    expect(ftsTerms("電動車市場")).toEqual(["電動車", "動車市", "車市場"]);
  });

  it("英數維持整詞", () => {
    expect(ftsTerms("GLM5.2 analysis")).toEqual(["GLM5.2", "analysis"]);
  });

  it("短於 3 字元的詞略過而不是白白放進查詢", () => {
    expect(ftsTerms("AI 的 x")).toEqual([]);
  });

  it("中英數混排在同一個 token 內也一路 3-gram 展開，英數不會被整段吞掉", () => {
    // 「電動車AI分析」是使用者實際會打的形式（沒有空白）。若因為含中文就整串當一個詞，
    // trigram 索引再次 0 命中；若因為含英數就整串保留，同樣只剩死路一條。
    expect(ftsTerms("電動車AI分析")).toEqual(["電動車", "動車A", "車AI", "AI分", "I分析"]);
  });

  it("重複的 3-gram 去重：OR 運算式的長度直接決定送進 SQLite 的查詢大小", () => {
    expect(ftsTerms("電動電動電動")).toEqual(["電動電", "動電動"]);
  });

  it("空字串回傳空陣列：search 得靠這個短路，空的 MATCH 運算式在 FTS5 是語法錯誤", () => {
    expect(ftsTerms("")).toEqual([]);
    expect(ftsTerms("   \t\n ")).toEqual([]);
  });
});

describe("查詢字串的惡意／畸形輸入", () => {
  const projectId = "project-fuzz";
  // /api/projects/:id/search 的 q 是使用者直接輸入的；詞若沒被當成 phrase 妥善引號化，
  // FTS5 會把 NEAR、OR、* 當成運算子而丟出語法錯誤，整個搜尋端點就變成 500。
  const hostile = [
    "",
    "   ",
    "NEAR(alpha beta)",
    "alpha OR beta AND",
    "prefix*",
    '他說"你好嗎"朋友',
    '"""',
    "!!!",
    "。。。。",
    "台北", // 短於 3 字元的中文
    "電動車市場銷量".repeat(70), // 接近 q 的 500 字上限
  ];

  it("畸形與含 FTS5 運算子的查詢一律當成一般詞，不會讓檢索丟例外", () => {
    const sources = [source("電動車年報", ["台灣電動車市場銷量分析"])];
    const retriever = retrieverFor(projectId, sources);
    for (const query of hostile)
      expect(() => retriever.search(projectId, query, 10), query).not.toThrow();
  });

  it("查詢無有效詞彙時回空陣列，呼叫端才走得到既有的回退路徑", () => {
    const sources = [source("電動車年報", ["台灣電動車市場銷量分析"])];
    const retriever = retrieverFor(projectId, sources);
    expect(retriever.search(projectId, "  ", 10)).toEqual([]);
    expect(retriever.search(projectId, "台北", 10)).toEqual([]);
  });
});

describe("中文全文檢索", () => {
  const projectId = "project-1";

  it("中文查詢命中：舊版把整串當 phrase 並以 AND 串接，實測命中 0 列", () => {
    const sources = [
      source("電動車年報", ["2025 年台灣電動車市場銷量分析"]),
      source("電池報告", ["磷酸鐵鋰電池每度成本趨勢"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const hits = retriever.search(projectId, "台灣電動車市場分析", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.sourceName).toBe("電動車年報");
  });

  it("OR 語意讓跨來源的查詢兩邊都撈得到，而不是一無所獲", () => {
    const sources = [
      source("電動車年報", ["台灣電動車市場銷量"]),
      source("電池報告", ["磷酸鐵鋰電池成本"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const names = new Set(
      retriever.search(projectId, "電動車 磷酸鐵鋰", 10).map((chunk) => chunk.sourceName),
    );
    expect(names).toEqual(new Set(["電動車年報", "電池報告"]));
  });
});

describe("來源上下文配額", () => {
  const projectId = "project-2";

  it("大來源不會吃光名額：每份來源都拿得到保底", () => {
    const big = source(
      "大檔案",
      Array.from({ length: 60 }, (_, index) => `2025 台灣電動車市場銷量分析第 ${index} 段`),
    );
    const sources = [
      big,
      source("充電樁調查", ["全台充電樁佈建數量與分布"]),
      source("電池成本報告", ["磷酸鐵鋰電池每度成本趨勢"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "台灣電動車市場分析", 12);
    const represented = new Set(context.map((chunk) => chunk.id));
    expect(represented).toEqual(new Set(sources.map((item) => item.id)));
    expect(context.length).toBeLessThanOrEqual(12);
  });

  it("一塊都沒命中的來源仍會帶進 prompt，而不是整份消失", () => {
    const sources = [
      source("電動車年報", ["台灣電動車市場銷量分析"]),
      source("無關文件", ["完全不相干的內容"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10);
    expect(new Set(context.map((chunk) => chunk.id))).toEqual(
      new Set(sources.map((item) => item.id)),
    );
  });

  it("排除不可存取與標記為不參與生成的來源", () => {
    const usable = source("可用", ["台灣電動車市場銷量分析"]);
    const blocked = { ...source("不可存取", ["台灣電動車市場另一份"]), allowModelAccess: false };
    const excluded = {
      ...source("排除生成", ["台灣電動車市場第三份"]),
      usage: "exclude-from-generation" as const,
    };
    const sources = [usable, blocked, excluded];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10);
    expect(new Set(context.map((chunk) => chunk.id))).toEqual(new Set([usable.id]));
  });

  it("保底發完後剩餘名額按相關度補給重點來源，而不是就此停手", () => {
    // 保底只保證「每份來源都在場」，不保證重點來源拿得夠。少了第二階段，limit 會有一大截
    // 用不到——12 個名額只發出 6 塊，模型手上的資料等於平白少了一半。
    const focus = source(
      "電動車年報",
      Array.from({ length: 12 }, (_, index) => `台灣電動車市場銷量分析第 ${index} 節`),
    );
    const aside = source("充電樁調查", ["台灣電動車市場的充電樁佈建"]);
    const sources = [focus, aside];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10);

    expect(context).toHaveLength(10);
    // 保底階段 quota = floor(10 / 2) = 5，focus 拿 5、aside 拿 1，其餘 4 個名額靠第二階段補。
    expect(context.filter((chunk) => chunk.id === focus.id)).toHaveLength(9);
    expect(context.filter((chunk) => chunk.id === aside.id)).toHaveLength(1);
  });

  it("來源數多於名額時截斷到 limit，且留下的是相關度最高的來源", () => {
    // 名額不夠時一定要有人落榜；落榜的必須是最不相關的那幾份，而不是碰巧排在陣列前面的。
    // 同時這是唯一會讓保底總量超過 limit 的情境——沒有最終截斷，prompt 預算就會被灌爆。
    const noise = Array.from({ length: 17 }, (_, index) =>
      source(`無關文件 ${index}`, [`完全不相干的內部行政公告第 ${index} 號`]),
    );
    const relevant = [
      source("電動車年報", ["台灣電動車市場銷量分析"]),
      source("電動車政策", ["台灣電動車市場的補助政策"]),
      source("電動車展望", ["台灣電動車市場未來展望"]),
    ];
    // 相關的刻意排在最後：若少了依相關度排序，截斷會先留下前面那些無關來源。
    const sources = [...noise, ...relevant];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "台灣電動車市場", 3);

    expect(context).toHaveLength(3);
    expect(new Set(context.map((chunk) => chunk.id))).toEqual(
      new Set(relevant.map((item) => item.id)),
    );
  });

  it("limit 為 1 時只留最相關的那一塊，而不是回傳每份來源的保底", () => {
    // quota 的下限是 1，來源有幾份保底就會發幾塊；沒有最終截斷的話 limit=1 會回傳 3 塊。
    const sources = [
      source("無關文件", ["完全不相干的內容"]),
      source("電動車年報", ["台灣電動車市場銷量分析"]),
      source("另一份無關", ["也完全不相干"]),
    ];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "台灣電動車市場", 1);

    expect(context).toHaveLength(1);
    expect(context[0]?.name).toBe("電動車年報");
  });

  it("沒有文字的來源（圖片）不會產生空片段占掉名額", () => {
    // 圖片來源的 chunks 是空的，保底階段的回退切片會切出空陣列。若沒處理好會塞進 undefined
    // 或空字串片段，模型讀到一筆沒有內容的來源只會困惑。
    const image: SourceAsset = {
      ...source("封面圖", []),
      chunks: [],
      extractedText: "",
      mediaType: "image/png",
      usage: "visual-reference",
    };
    const text = source("電動車年報", ["台灣電動車市場銷量分析"]);
    const sources = [image, text];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10);

    expect(context.map((chunk) => chunk.name)).toEqual(["電動車年報"]);
    expect(context.every((chunk) => chunk.text.length > 0)).toBe(true);
  });

  it("單一片段截斷在 1600 字：一份超長來源不得吃掉整個 prompt 預算", () => {
    const huge = source("超長文件", ["台灣電動車市場銷量分析".repeat(500)]);
    const retriever = retrieverFor(projectId, [huge]);
    const context = knownSourceContext(retriever, projectId, [huge], "電動車市場", 10);

    expect(context).toHaveLength(1);
    expect(context[0]?.text).toHaveLength(1_600);
  });

  it("來源清單為空時回空陣列，不會因為 quota 除以 0 而爆掉", () => {
    const retriever = retrieverFor(projectId, []);
    expect(knownSourceContext(retriever, projectId, [], "電動車市場", 10)).toEqual([]);
  });
});

describe("使用者指定來源的名額分配", () => {
  const projectId = "project-pinned";

  /** 每份來源都有足夠多的片段，才問得出「名額怎麼分」而不是「片段夠不夠」。 */
  function bulk(name: string, count: number): SourceAsset {
    return source(
      name,
      Array.from(
        { length: count },
        (_, index) => `台灣電動車市場銷量分析｜${name}｜第 ${index} 段`,
      ),
    );
  }

  it("指定的來源拿七成名額，其餘三成留給沒指定的來源", () => {
    const pinnedOne = bulk("電動車年報", 30);
    const pinnedTwo = bulk("充電樁調查", 30);
    const otherOne = bulk("電池成本報告", 30);
    const otherTwo = bulk("政策白皮書", 30);
    const sources = [pinnedOne, pinnedTwo, otherOne, otherTwo];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 20, [
      pinnedOne.id,
      pinnedTwo.id,
    ]);

    expect(context).toHaveLength(20);
    const fromPinned = context.filter(
      (chunk) => chunk.id === pinnedOne.id || chunk.id === pinnedTwo.id,
    );
    // 兩側份數相同時，2.3 倍的每份權重正好還原成七比三：
    // 指定的每份 round(20 × 2.3 / 6.6) = 7，未指定的每份 round(20 × 1 / 6.6) = 3。
    expect(fromPinned).toHaveLength(14);
    expect(context.filter((chunk) => chunk.id === otherOne.id)).toHaveLength(3);
    expect(context.filter((chunk) => chunk.id === otherTwo.id)).toHaveLength(3);
  });

  it("只指定 1 份、另有 30 份沒指定時，31 份來源全部都進得了 prompt", () => {
    // 把七成整包給「指定的那一側」的話：pinnedBudget = round(40 × 0.7) = 28 全歸那 1 份，
    // 剩 12 個名額分不完 30 份來源，有 18 份連一塊都拿不到——正是 eeddf9d 修掉的症狀。
    // 權重套在每份來源上就不會這樣：每份先保底 1 塊，指定的那份再多拿。
    const pinnedSource = bulk("使用者指定", 30);
    const others = Array.from({ length: 30 }, (_, index) => bulk(`其他來源 ${index}`, 30));
    const sources = [pinnedSource, ...others];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 40, [
      pinnedSource.id,
    ]);

    expect(context).toHaveLength(40);
    // 31 份來源一份都不能缺席。
    expect(new Set(context.map((chunk) => chunk.id)).size).toBe(31);
    const pinnedChunks = context.filter((chunk) => chunk.id === pinnedSource.id).length;
    const mostFromOthers = Math.max(
      ...others.map((item) => context.filter((chunk) => chunk.id === item.id).length),
    );
    // 指定的那份明顯多拿：保底 1 + 加權配額，再加上剩餘名額優先補給它。
    expect(pinnedChunks).toBe(10);
    expect(mostFromOthers).toBe(1);
  });

  it("沒指定任何來源時分配邏輯完全不變（既有專案的行為基準）", () => {
    const sources = [bulk("電動車年報", 30), bulk("充電樁調查", 30), bulk("電池成本報告", 30)];
    const retriever = retrieverFor(projectId, sources);
    const baseline = knownSourceContext(retriever, projectId, sources, "電動車市場", 15);
    const withEmptyPins = knownSourceContext(retriever, projectId, sources, "電動車市場", 15, []);

    expect(withEmptyPins).toEqual(baseline);
  });

  it("配額都發完後剩下的名額先補給指定的來源，而不是給相關度最高的那一份", () => {
    // 有來源填不滿自己的配額（這裡是只有一塊的那份）就會空出名額。那些名額該往哪裡去，
    // 決定了「指定」在最後一輪還算不算數；純按相關度補的話，指定的優勢到這裡就消失了。
    const pinnedSource = bulk("使用者指定", 20);
    const rival = source(
      "相關度更高",
      Array.from({ length: 20 }, (_, index) => `台灣電動車市場銷量分析第 ${index} 節`),
    );
    const tiny = source("只有一塊", ["台灣電動車市場銷量分析的單一段落"]);
    const sources = [pinnedSource, rival, tiny];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(
      retriever,
      projectId,
      sources,
      "台灣電動車市場銷量分析",
      10,
      [pinnedSource.id],
    );

    expect(context).toHaveLength(10);
    // 配額是 5 / 2 / 2，只有一塊的那份用不完，空出的 2 個名額補給指定的來源。
    expect(context.filter((chunk) => chunk.id === pinnedSource.id)).toHaveLength(7);
    expect(context.filter((chunk) => chunk.id === rival.id)).toHaveLength(2);
    expect(context.filter((chunk) => chunk.id === tiny.id)).toHaveLength(1);
  });

  it("名額不夠時先淘汰沒指定的來源，指定的即使相關度較低也留得下來", () => {
    // 保底那一輪是照順序發的，發完就沒了。順序若只看相關度，使用者指定的冷門來源會被
    // 兩份熱門來源擠掉——明明是他自己說「這一頁要用這份」。
    const pinnedSource = source("冷門指定", ["電動車的一般介紹"]);
    const hotOne = source(
      "熱門甲",
      Array.from({ length: 5 }, (_, index) => `台灣電動車市場銷量分析第 ${index} 節`),
    );
    const hotTwo = source(
      "熱門乙",
      Array.from({ length: 5 }, (_, index) => `台灣電動車市場銷量趨勢第 ${index} 節`),
    );
    const sources = [hotOne, hotTwo, pinnedSource];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "台灣電動車市場銷量分析", 2, [
      pinnedSource.id,
    ]);

    expect(context.map((chunk) => chunk.name)).toEqual(["冷門指定", "熱門甲"]);
  });

  it("加權配額總和超出 limit 時，仍然每份來源都拿得到保底", () => {
    // 1 份指定 + 9 份未指定、limit 10：四捨五入後配額是 2 + 9×1 = 11，比 limit 還多。
    // 若直接照配額發，前面的人會把名額吃完，排最後的那份來源一塊都拿不到、整份從 prompt 消失。
    // 先發保底再補配額就不會——這一輪不是裝飾。
    const pinnedSource = bulk("使用者指定", 20);
    const others = Array.from({ length: 9 }, (_, index) => bulk(`其他來源 ${index}`, 20));
    const sources = [pinnedSource, ...others];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10, [
      pinnedSource.id,
    ]);

    expect(context).toHaveLength(10);
    expect(new Set(context.map((chunk) => chunk.id)).size).toBe(10);
    for (const item of sources)
      expect(context.filter((chunk) => chunk.id === item.id)).toHaveLength(1);
  });

  it("指定的份數逼近 limit 時每份仍至少拿到一塊，總數不超過 limit", () => {
    // 10 份來源搶 10 個名額：加權配額全被壓到下限 1，保底那一輪就發完了。
    // 沒有下限的話，加權算出來不足一塊的來源會直接掛零。
    const pinnedSources = Array.from({ length: 9 }, (_, index) => bulk(`指定來源 ${index}`, 4));
    const other = bulk("未指定來源", 20);
    const sources = [...pinnedSources, other];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(
      retriever,
      projectId,
      sources,
      "電動車市場",
      10,
      pinnedSources.map((item) => item.id),
    );

    expect(context).toHaveLength(10);
    for (const pinnedSource of pinnedSources)
      expect(context.filter((chunk) => chunk.id === pinnedSource.id)).toHaveLength(1);
    // 指定的 9 份先各拿 1 塊，最後 1 個名額才輪到未指定的來源。
    expect(context.filter((chunk) => chunk.id === other.id)).toHaveLength(1);
  });

  it("指定的份數多於 limit 時只留最相關的那幾份，不會超額", () => {
    const relevant = source("電動車年報", ["台灣電動車市場銷量分析"]);
    const noise = Array.from({ length: 5 }, (_, index) =>
      source(`無關指定 ${index}`, [`完全不相干的內部行政公告第 ${index} 號`]),
    );
    const sources = [...noise, relevant];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(
      retriever,
      projectId,
      sources,
      "台灣電動車市場",
      2,
      sources.map((item) => item.id),
    );

    expect(context).toHaveLength(2);
    expect(context.map((chunk) => chunk.name)).toContain("電動車年報");
  });

  it("指定的來源片段不足時名額不會被浪費，仍舊填滿 limit", () => {
    // 指定的那份只有一塊，加權配額分到的名額用不完。剩下的要真的發下去——否則 prompt
    // 明明還有一半預算沒用，模型手上的資料卻平白少一截。
    const pinnedSource = source("短來源", ["台灣電動車市場的一句話"]);
    const relevant = bulk("充電樁調查", 30);
    const unrelated = source(
      "行政公告",
      Array.from({ length: 6 }, (_, index) => `完全不相干的內部行政公告第 ${index} 號`),
    );
    const sources = [pinnedSource, relevant, unrelated];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10, [
      pinnedSource.id,
    ]);

    expect(context).toHaveLength(10);
    // 指定的那份只拿得到它僅有的一塊，其餘名額回到相關度補位那一輪。
    expect(context.filter((chunk) => chunk.id === pinnedSource.id)).toHaveLength(1);
    // 一塊都沒命中的來源仍拿得到加權配額 round(10 × 1 / 4.3) = 2。
    expect(context.filter((chunk) => chunk.id === unrelated.id)).toHaveLength(2);
    expect(context.filter((chunk) => chunk.id === relevant.id)).toHaveLength(7);
  });

  it("已刪除或不可存取的指定 id 不會白白占掉加權後的名額", () => {
    const blocked = { ...bulk("不可存取", 30), allowModelAccess: false };
    const usable = bulk("電動車年報", 30);
    const another = bulk("充電樁調查", 30);
    const sources = [blocked, usable, another];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10, [
      blocked.id,
      "不存在的來源 id",
    ]);
    const baseline = knownSourceContext(retriever, projectId, sources, "電動車市場", 10);

    // 指定的 id 全部無效，等同沒有指定。
    expect(context).toEqual(baseline);
    expect(context.some((chunk) => chunk.id === blocked.id)).toBe(false);
  });

  it("全部來源都被指定時等同一般分配：權重一致，沒有人被優待也沒有人被餓死", () => {
    const first = bulk("電動車年報", 30);
    const second = bulk("充電樁調查", 30);
    const sources = [first, second];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 10, [
      first.id,
      second.id,
    ]);

    expect(context).toHaveLength(10);
    expect(new Set(context.map((chunk) => chunk.id))).toEqual(new Set([first.id, second.id]));
  });

  it("limit 為 1 時唯一的名額給指定的來源，而不是給相關度最高的那一份", () => {
    // 名額只有一個時七成與三成無法並存，總得有人拿到。指定是使用者明確的要求，
    // 相關度只是估計值，所以名額歸指定的來源；記下這個取捨，之後才看得出是不是被改掉了。
    const pinnedSource = source("使用者指定", ["電動車市場的一小段補充"]);
    const mostRelevant = bulk("最相關但沒指定", 30);
    const sources = [mostRelevant, pinnedSource];
    const retriever = retrieverFor(projectId, sources);
    const context = knownSourceContext(retriever, projectId, sources, "電動車市場", 1, [
      pinnedSource.id,
    ]);

    expect(context).toHaveLength(1);
    expect(context[0]?.id).toBe(pinnedSource.id);
  });
});

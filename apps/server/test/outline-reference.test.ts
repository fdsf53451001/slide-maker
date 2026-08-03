import { describe, expect, it } from "vitest";
import { sourceAttachesReferenceImage, type SourceAsset } from "@slide-maker/core";
import {
  buildOutlineCatalog,
  buildOutlineReference,
  isOutlineReferenceSource,
  OUTLINE_REFERENCE_CHAR_BUDGET,
  OUTLINE_SLIDE_IMAGE_REF_LIMIT,
  withinSlideImageLimit,
} from "../src/outline-sources.js";

/**
 * 「大綱參考」這個用途的組裝規則。
 *
 * 這一組釘的每一條錯了都是**靜默**的：`buildOutlineReference()` 不會 throw，大綱照樣生得
 * 出來，只是模型手上那份結構指令少了一段、或多吃掉一份 prompt 空間。使用者能觀察到的只有
 * 「它沒完全照我的大綱走」，而那句話在伺服器端完全對不到證據。
 */

const source = (overrides: Partial<SourceAsset> & { id: string }): SourceAsset => ({
  name: `${overrides.id}.md`,
  mediaType: "text/markdown",
  usage: "outline-reference",
  allowModelAccess: true,
  status: "indexed",
  assetPath: `assets/${overrides.id}.md`,
  sizeBytes: 1024,
  extractedText: "",
  chunks: [],
  metadata: {},
  createdAt: "2026-08-03T00:00:00.000Z",
  ...overrides,
});

describe("buildOutlineReference 的組裝", () => {
  it("多份依專案順序串接，每份帶檔名小標", () => {
    const reference = buildOutlineReference([
      source({ id: "a", name: "第一部分.md", extractedText: "## 開場\n市場規模" }),
      // 中間夾一份一般內容來源：它有正文、也允許讀取，但沒有被標成大綱參考。
      source({ id: "mid", usage: "content", extractedText: "這段是一般內容依據的正文。" }),
      source({ id: "b", name: "第二部分.docx", extractedText: "## 結論\n三個建議" }),
    ])!;

    expect(reference.includedCount).toBe(2);
    expect(reference.truncatedCount).toBe(0);
    // 專案順序＝使用者拆檔的章節順序，不可依 id、名稱或長度重排。
    expect(reference.text.indexOf("第一部分.md")).toBeLessThan(
      reference.text.indexOf("第二部分.docx"),
    );
    expect(reference.text).toContain("## 開場");
    expect(reference.text).toContain("## 結論");
    // 沒被標記的來源一個字都不進這一段（它走的是目錄與檢索那條路）。
    expect(reference.text).not.toContain("這段是一般內容依據的正文。");
    // 小標刻意不是 markdown 標題：使用者的大綱本來就滿是 `#`，用同一個記號當分隔，模型會
    // 把檔名讀成一個章節，然後生出一頁叫「第一部分.md」的投影片。
    for (const line of reference.text.split("\n").filter((item) => item.includes("第一部分.md")))
      expect(line.trimStart().startsWith("#")).toBe(false);
    // 兩份之間看得出是兩份，不是接成一整段。
    expect(reference.text).toContain("\n\n");
  });

  it("記到的字元數就是真的送出去的字元數", () => {
    // 只記正文的話，「預算 30000」在十份大綱的專案會悄悄變成 30000 加十份檔名與分隔線，
    // 而 log 那一行報的數字會與實際送進 prompt 的長度對不起來。
    const reference = buildOutlineReference([
      source({ id: "a", name: "大綱一.md", extractedText: "第一份的內容。" }),
      source({ id: "b", name: "大綱二.md", extractedText: "第二份的內容。" }),
      source({ id: "c", name: "大綱三.md", extractedText: "第三份的內容。" }),
    ])!;

    expect(reference.includedChars).toBe(reference.text.length);
    // 正向對照：小標與分隔線確實佔了字元，否則上面那一行可以靠「兩邊都只算正文」矇混過關。
    expect(reference.includedChars).toBeGreaterThan(
      "第一份的內容。第二份的內容。第三份的內容。".length,
    );
  });

  it("extractedText 是空的（或只有空白）就跳過，不留下一個空的小標", () => {
    const reference = buildOutlineReference([
      // 最常見的形狀：使用者把一張沒跑過內容描述的圖標成大綱參考。
      source({ id: "img", name: "手寫大綱.jpg", mediaType: "image/jpeg", extractedText: "" }),
      source({ id: "blank", name: "空白.md", extractedText: "  \n\n \t " }),
      source({ id: "real", name: "真的大綱.md", extractedText: "## 章節一" }),
    ])!;

    expect(reference.includedCount).toBe(1);
    // 空的那兩份不算截斷（它們沒有內容可以被切掉），但**必須各自被數到** `emptyCount`：
    // 實際情境是 `outline-part1.docx` ＋ `outline-part2.jpg`（後半段拍成照片，而讀圖描述
    // 只跑 `visual-reference`，那張圖永遠不會有文字）——一半的大綱毫無作用，而
    // `includedCount` 是 1、`truncatedCount` 是 0，不數這一個就沒有任何欄位講得出這件事。
    expect(reference.truncatedCount).toBe(0);
    expect(reference.emptyCount).toBe(2);
    expect(reference.text).not.toContain("手寫大綱.jpg");
    expect(reference.text).not.toContain("空白.md");
    expect(reference.text).toContain("真的大綱.md");
  });

  it("一份有效內容都沒有時回 undefined，而不是一段空字串", () => {
    // `undefined` 是呼叫端唯一分辨得出「標了但等於沒標」的訊號：回空字串的話，
    // `outlineReference ? …` 對空字串也是 falsy，但 `includedCount: 0` 的物件不是——
    // 那幾行指令會被加進 prompt，指著一個空欄位。
    expect(
      buildOutlineReference([
        source({ id: "img", mediaType: "image/png", extractedText: "" }),
        source({ id: "blank", extractedText: "\n  \n" }),
      ]),
    ).toBeUndefined();
    // 一份都沒標記時同理。
    expect(
      buildOutlineReference([
        source({ id: "a", usage: "content", extractedText: "一般正文。" }),
        source({ id: "b", usage: "visual-reference", extractedText: "圖片描述。" }),
      ]),
    ).toBeUndefined();
    expect(buildOutlineReference([])).toBeUndefined();
  });

  it("超出預算時截斷，實際輸出一個字都不超過預算", () => {
    // 無句末也無換行的長字串：`truncateAtBoundary()` 找不到邊界就硬切在上限，用它才量得出
    // 「預算到底被用到哪裡」，換成有標點的文字會提早幾個字收手而讓下面的等式不成立。
    const body = "綱".repeat(OUTLINE_REFERENCE_CHAR_BUDGET + 10_000);
    const reference = buildOutlineReference([
      source({ id: "long", name: "長大綱.md", extractedText: body }),
    ])!;

    expect(reference.includedCount).toBe(1);
    expect(reference.truncatedCount).toBe(1);
    expect(reference.includedChars).toBe(reference.text.length);
    expect(reference.text.length).toBe(OUTLINE_REFERENCE_CHAR_BUDGET);
    // 這一行是重點：預算是**輸出**的上限，不是「正文的上限，小標另計」。
    expect(reference.text.length).toBeLessThanOrEqual(OUTLINE_REFERENCE_CHAR_BUDGET);
    expect(reference.text).toContain("長大綱.md");
  });

  it("排在後面、一個字都塞不下的那一份也算截斷", () => {
    // 「這一份的結構沒有全部到位」對模型而言是同一件事：分成兩個計數只會讓那行 log 更難讀，
    // 但**完全不計**會讓「使用者上傳了三份大綱、只有第一份進得去」在 log 裡看起來一切正常。
    const reference = buildOutlineReference([
      source({
        id: "first",
        name: "吃光預算.md",
        extractedText: "綱".repeat(OUTLINE_REFERENCE_CHAR_BUDGET + 1_000),
      }),
      source({ id: "second", name: "完全塞不下.md", extractedText: "## 第二份的章節" }),
    ])!;

    expect(reference.includedCount).toBe(1);
    expect(reference.truncatedCount).toBe(2);
    expect(reference.text).not.toContain("完全塞不下.md");
    expect(reference.text).not.toContain("第二份的章節");
    expect(reference.text.length).toBeLessThanOrEqual(OUTLINE_REFERENCE_CHAR_BUDGET);
    expect(reference.includedChars).toBe(reference.text.length);
  });

  it("isOutlineReferenceSource 只認這一個 usage", () => {
    // 呼叫端要數「使用者到底標了幾份」時也用它；各寫一次 `usage === "outline-reference"`
    // 就是第二份真相。
    expect(isOutlineReferenceSource(source({ id: "a" }))).toBe(true);
    for (const usage of [
      "content",
      "visual-reference",
      "style-reference",
      "direct-asset",
      "exclude-from-generation",
    ] as const)
      expect(isOutlineReferenceSource(source({ id: usage, usage }))).toBe(false);
  });
});

describe("大綱參考同時仍是一般內容來源", () => {
  it("目錄照樣列出它，kind 是 text", () => {
    // 多標一個用途只是額外把整份餵進來當結構指令，不是把它從內容池裡拿走：目錄少了它，
    // 模型就沒有 ref 可以放進 sourceRefs，使用者自己寫的那份大綱反而變成引用不到的來源。
    const catalog = buildOutlineCatalog([
      source({ id: "outline", name: "我的大綱.md", extractedText: "## 章節一\n重點說明。" }),
      source({ id: "plain", usage: "content", name: "資料.md", extractedText: "一般正文。" }),
    ]);

    expect(catalog.entries.map((entry) => entry.name)).toEqual(["我的大綱.md", "資料.md"]);
    expect(catalog.entries[0]!.kind).toBe("text");
    expect(catalog.entries[0]!.summary).toContain("章節一");
    expect(catalog.idByRef.get("S1")).toBe("outline");
  });
});

describe("大綱參考不是畫面素材", () => {
  it("sourceAttachesReferenceImage 對它是 false", () => {
    expect(sourceAttachesReferenceImage("outline-reference")).toBe(false);
    // 正向對照：這個 predicate 不是恆假。
    expect(sourceAttachesReferenceImage("visual-reference")).toBe(true);
  });

  it("標成大綱參考的圖被選進 sourceIds 時不佔每頁的影像額度", () => {
    // 使用者把大綱拍成照片或存成 PDF 丟進來時，那張圖對「這一頁要長什麼樣」沒有貢獻，
    // 卻會吃掉 3 張額度、把真正要附的圖表擠掉——而被擠掉這件事在畫面上完全看不出來。
    const images = [
      source({ id: "outline-img", mediaType: "image/png", name: "大綱照片.png" }),
      ...Array.from({ length: OUTLINE_SLIDE_IMAGE_REF_LIMIT }, (_, index) =>
        source({
          id: `chart-${index}`,
          usage: "visual-reference",
          mediaType: "image/png",
          name: `圖表${index}.png`,
        }),
      ),
    ];
    const byId = new Map(images.map((item) => [item.id, item]));

    const limited = withinSlideImageLimit(
      images.map((item) => item.id),
      byId,
    );

    // 大綱那張排在最前面：算進額度的話，最後一張真正的圖表會被砍掉。
    expect(limited.droppedImageSourceIds).toEqual([]);
    expect(limited.ids).toEqual(images.map((item) => item.id));

    // 正向對照：同一組來源只要把大綱那張改標成視覺參考，就真的會有一張被砍——上面那一行
    // 才不是「這個上限根本沒生效」矇混過關。
    const asVisual = new Map(byId);
    asVisual.set("outline-img", { ...images[0]!, usage: "visual-reference" });
    expect(
      withinSlideImageLimit(
        images.map((item) => item.id),
        asVisual,
      ).droppedImageSourceIds,
    ).toEqual([`chart-${OUTLINE_SLIDE_IMAGE_REF_LIMIT - 1}`]);
  });
});

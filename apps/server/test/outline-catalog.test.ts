import { describe, expect, it } from "vitest";
import type { SourceAsset } from "@slide-maker/core";
import { IMAGE_DESCRIPTION_NOTICE, imageDescriptionFields } from "../src/image-description.js";
import {
  buildOutlineCatalog,
  imageSummaryNotice,
  OUTLINE_CATALOG_CHAR_BUDGET,
  OUTLINE_CATALOG_SUMMARY_CHARS,
} from "../src/outline-sources.js";
import { truncateAtBoundary } from "../src/sources.js";

/**
 * 階段 1 目錄條目的密度。
 *
 * 這裡釘的不只是「功能對」，還有「每個字都在幫模型選源」——實測線上那份 108 來源的專案，
 * 每一份圖片來源的摘要開頭都是同一句 61 字元的出處聲明（150 份 = 9150 字元 = 15% 的目錄
 * 預算），剩下的還常常硬切在表格列中間。錯了不會有任何測試變紅：模型照樣挑得出來源，
 * 只是挑得比較差，而那件事在伺服器端完全看不出來。
 */

const source = (overrides: Partial<SourceAsset> & { id: string }): SourceAsset => ({
  name: `${overrides.id}.md`,
  mediaType: "text/markdown",
  usage: "content",
  allowModelAccess: true,
  status: "indexed",
  assetPath: `assets/${overrides.id}.md`,
  sizeBytes: 1024,
  extractedText: "",
  chunks: [],
  metadata: {},
  createdAt: "2026-07-29T00:00:00.000Z",
  ...overrides,
});

const describedImage = (id: string, withStoredSummary: boolean): SourceAsset => {
  const fields = imageDescriptionFields(id, {
    title: `2025 深夜食堂評分表（${id}）`,
    summary: "長條圖與表格並列，比較 12 家店的 Google 評分與評論數，並標出前三名。",
    fullText: [
      "圖表類型：橫向長條圖 ＋ 表格。X 軸：Google 評分（1–5）。Y 軸：店名。",
      ...Array.from(
        { length: 12 },
        (_, row) =>
          `| ${row + 1} | 職人丼深夜食堂 信義店 | ${(4.1 + row * 0.03).toFixed(2)} | ${120 + row * 7} 則 |`,
      ),
      "資料來源：Google Maps，擷取於 2025-11-02。",
    ].join("\n"),
  })!;
  return source({
    id,
    name: `SEC02_深夜食堂評分_${id}.jpg`,
    mediaType: "image/jpeg",
    usage: "visual-reference",
    extractedText: fields.extractedText,
    chunks: fields.chunks,
    metadata: withStoredSummary ? { summary: fields.summary } : {},
  });
};

describe("目錄條目的出處聲明", () => {
  it("條目本身不帶逐份重複的聲明，改由 prompt 講一次集體聲明", () => {
    const catalog = buildOutlineCatalog([describedImage("img-1", true)]);
    expect(catalog.entries[0]!.summary).not.toContain(IMAGE_DESCRIPTION_NOTICE);
    // 語意不可消失：集體聲明要涵蓋「視覺模型讀圖產生／非原始文字／僅供檢索定位／
    // 引用數據以圖片為準」四件事。
    const notice = imageSummaryNotice();
    expect(notice).toMatch(/vision model/i);
    expect(notice).toMatch(/not the original text/i);
    expect(notice).toMatch(/find and place/i);
    expect(notice).toMatch(/unverified|the picture itself is the authority/i);
  });

  it("剝除容忍前後空白，剝不掉時安靜沿用原字串", () => {
    const padded = buildOutlineCatalog([
      source({
        id: "a",
        extractedText: `\n\n  ${IMAGE_DESCRIPTION_NOTICE}\n\n實際內容從這裡開始。`,
      }),
    ]);
    expect(padded.entries[0]!.summary).toBe("實際內容從這裡開始。");

    // 不是圖片描述、或聲明的格式變了：不 throw、不砍字，原樣沿用。
    const plain = buildOutlineCatalog([source({ id: "b", extractedText: "一般檔案的正文。" })]);
    expect(plain.entries[0]!.summary).toBe("一般檔案的正文。");
    const variant = buildOutlineCatalog([
      source({ id: "c", extractedText: "［AI 圖片描述］改過的聲明句。實際內容。" }),
    ]);
    expect(variant.entries[0]!.summary).toBe("［AI 圖片描述］改過的聲明句。實際內容。");
  });
});

describe("目錄條目的摘要組法", () => {
  it("有 metadata.summary 就優先用它，再補正文補到接近上限", () => {
    // 用一個正文裡沒有的字串，才驗得出「優先讀 metadata.summary」而不是碰巧一樣。
    const stored = "【結構化摘要】這是寫回時存下的標題與一句話。";
    const entry = buildOutlineCatalog([
      source({
        id: "img",
        usage: "visual-reference",
        mediaType: "image/png",
        metadata: { summary: stored },
        extractedText: `${IMAGE_DESCRIPTION_NOTICE}\n\n正文段落一。\n正文段落二。\n${"正文段落三。".repeat(60)}`,
      }),
    ]).entries[0]!;

    expect(entry.summary.startsWith(stored)).toBe(true);
    // 100 字元的摘要略少，所以後面要接正文——只放摘要等於把省下來的預算浪費掉。
    expect(entry.summary).toContain("正文段落一。");
    expect(entry.summary.length).toBeGreaterThan(stored.length + 100);
    expect(entry.summary.length).toBeLessThanOrEqual(OUTLINE_CATALOG_SUMMARY_CHARS);
  });

  it("摘要含空行或 markdown 標題時，去重照樣成立", () => {
    // vision 的指令就是「two or three sentences」，回成兩段、或前面掛個 markdown 標題，
    // 完全在正常範圍。兩邊正規化不對稱時 `startsWith` 直接 false，整段標題＋摘要會重複，
    // 而且 240 字的額度有一半在講同一句話。
    for (const stored of ["第一句。\n\n第二句。", "## 小節\n\n說明文字。"]) {
      const entry = buildOutlineCatalog([
        source({
          id: "img",
          usage: "visual-reference",
          mediaType: "image/png",
          metadata: { summary: stored },
          extractedText: `${IMAGE_DESCRIPTION_NOTICE}\n\n${stored}\n\n${"補進來的正文。".repeat(40)}`,
        }),
      ]).entries[0]!;
      const head = stored.split("\n").filter(Boolean)[0]!;
      expect(entry.summary.split(head)).toHaveLength(2);
      expect(entry.summary).toContain("補進來的正文。");
    }
  });

  it("補正文時扣掉與摘要重複的開頭，同一句話不在同一個條目裡出現兩次", () => {
    // 圖片描述的 metadata.summary 就是正文的前兩段，直接接上去會整段重複。
    const image = describedImage("img-2", true);
    const entry = buildOutlineCatalog([image]).entries[0]!;
    const title = "2025 深夜食堂評分表（img-2）";
    expect(entry.summary.split(title)).toHaveLength(2);
    // 扣掉重複之後補進來的是真正有選源價值的部分（軸標籤與表格）。
    expect(entry.summary).toContain("X 軸");
  });

  it("沒有 metadata.summary 的舊資料仍走 fallback，且前綴已剝除", () => {
    // 既有專案的圖片來源都沒有這個欄位，而回填要嘛寫 migration、要嘛重跑 vision 燒配額。
    // fallback 因此必須永遠留著，品質也要接近有摘要的那條路。
    const legacy = buildOutlineCatalog([describedImage("img-3", false)]).entries[0]!;
    const modern = buildOutlineCatalog([describedImage("img-3", true)]).entries[0]!;
    expect(legacy.summary).not.toContain(IMAGE_DESCRIPTION_NOTICE);
    expect(legacy.summary).toContain("2025 深夜食堂評分表");
    expect(legacy.summary).toContain("X 軸");
    expect(Math.abs(legacy.summary.length - modern.summary.length)).toBeLessThan(40);
  });

  it("補正文切在段落或表格列的邊界，不硬切在一列中間", () => {
    const entry = buildOutlineCatalog([describedImage("img-4", true)]).entries[0]!;
    const lines = entry.summary.split("\n");
    // 每一行表格列都是完整的（以 `|` 收尾），不會停在 `| 職人丼深夜食堂 信義店 ` 這種位置。
    for (const line of lines.filter((item) => item.startsWith("|")))
      expect(line.trimEnd().endsWith("|")).toBe(true);
  });

  it("truncateAtBoundary 找不到邊界時才硬切，且從不超出上限", () => {
    expect(truncateAtBoundary("短字串", 100)).toBe("短字串");
    expect(truncateAtBoundary("一二三四五六七八九十", 5)).toBe("一二三四五");
    expect(truncateAtBoundary("第一段。第二段。第三段。", 9)).toBe("第一段。第二段。");
    expect(truncateAtBoundary("第一行\n第二行\n第三行", 9)).toBe("第一行\n第二行");
    expect(truncateAtBoundary("任何東西", 0)).toBe("");
  });

  it("小數點、副檔名與網域不算句末——切在那裡會產生一句數字是錯的完整句子", () => {
    // 硬切看得出殘缺；`12.` 看起來是完整的一句話，而它說的是假的。這比硬切更難察覺，
    // 也正是 truncateAtBoundary 的 docstring 自己要防的東西。
    expect(truncateAtBoundary("Revenue grew to 12.5 billion USD in the fiscal year", 30)).not.toBe(
      "Revenue grew to 12.",
    );
    expect(truncateAtBoundary("Revenue grew to 12.5 billion USD in the fiscal year", 30)).toContain(
      "12.5",
    );
    expect(truncateAtBoundary("Sources: annual-report-2025.pdf and the appendix", 40)).toContain(
      "annual-report-2025.pdf",
    );
    // 40 字放不下整個網域，硬切是對的——重點是不能停在 `data.` 假裝那是一句完整的話。
    expect(
      truncateAtBoundary("See the dataset published at data.example.com for raw", 40),
    ).not.toBe("See the dataset published at data.");
    expect(
      truncateAtBoundary("See the dataset published at data.example.com for raw", 50),
    ).toContain("data.example.com");
    // 後接空白的句點仍然算句末，英文正文照樣切得漂亮。
    expect(truncateAtBoundary("First sentence. Second sentence. Third", 20)).toBe(
      "First sentence.",
    );
    // 全形標點不需要後接空白（CJK 本來就不空格）。
    expect(truncateAtBoundary("第一句。第二句。第三句", 9)).toBe("第一句。第二句。");
  });

  it("切點不劈開 surrogate pair", () => {
    // 末尾留半個 code unit 是亂碼字，模型看到的是 U+FFFD，而且 cost 照算。
    const emoji = "圖表說明🎯🎯🎯🎯🎯";
    const cut = truncateAtBoundary(emoji, 9);
    expect(cut.endsWith("\ud83c")).toBe(false);
    expect([...cut].every((char) => char.codePointAt(0)! < 0xd800 || char.length === 2)).toBe(true);
  });
});

describe("目錄的字元預算", () => {
  it("預算用完時跳過放不下的條目並記數，而不是就地停止", () => {
    // 這條路以前沒有任何測試走得到：`droppedCount` 一直是 0，等於那段程式碼從沒被驗證過。
    // 檔名特別長的來源（實際案例：掃描器輸出的長檔名）就足以把預算吃光。
    const longName = "超長檔名".repeat(2_000);
    const sources = [
      ...Array.from({ length: 30 }, (_, index) =>
        source({ id: `fat-${index}`, name: `${longName}-${index}.pdf`, extractedText: "正文。" }),
      ),
      source({ id: "tail", name: "短檔名.md", extractedText: "排在最後但塞得下。" }),
    ];

    const catalog = buildOutlineCatalog(sources);

    expect(catalog.droppedCount).toBeGreaterThan(0);
    expect(catalog.entries.length).toBe(sources.length - catalog.droppedCount);
    // **跳過而不是就地停止**：被丟掉的是塞不下的那幾份，後面塞得下的短條目照樣收。
    expect(catalog.entries.map((entry) => entry.name)).toContain("短檔名.md");
    // ref 連號且與 idByRef 對得上——中間跳過的來源不會在編號上留洞。
    expect(catalog.entries.map((entry) => entry.ref)).toEqual(
      catalog.entries.map((_entry, index) => `S${index + 1}`),
    );
    for (const entry of catalog.entries) expect(catalog.idByRef.has(entry.ref)).toBe(true);
  });
});

describe("目錄的整體密度", () => {
  it("150 份來源的目錄明顯低於預算，且一份都沒被丟掉", () => {
    // 線上那份專案的形狀：100 張圖 ＋ 50 份網頁／檔案。改動前每份 400 字元、圖片來源逐份
    // 帶 61 字元的聲明；改動後每份 240 字元、聲明整區共用一次。
    const sources = [
      ...Array.from({ length: 100 }, (_, index) => describedImage(`img-${index}`, true)),
      ...Array.from({ length: 50 }, (_, index) =>
        source({
          id: `web-${index}`,
          name: `台灣電動車年報-${index}.md`,
          metadata: { url: `https://example.com/report-${index}` },
          extractedText: `二〇二五年掛牌數為五萬八千輛。${"各縣市充電樁佈建密度的逐項說明。".repeat(40)}`,
        }),
      ),
    ];

    const catalog = buildOutlineCatalog(sources);

    expect(catalog.entries).toHaveLength(150);
    expect(catalog.droppedCount).toBe(0);
    const total = JSON.stringify(catalog.entries).length;
    // **絕對數字，不是「預算的某個百分比」**：拿被測的常數當上界等於自我指涉——把
    // OUTLINE_CATALOG_SUMMARY_CHARS 改回 400（同一批來源會漲到約 72000 字元）時，
    // 「小於預算的 85%」照樣是綠的。這一行的職責就是讓那個回退變紅。
    expect(total).toBeLessThan(52_000);
    // 一份聲明都不重複。
    expect(
      catalog.entries.filter((entry) => entry.summary.includes(IMAGE_DESCRIPTION_NOTICE)),
    ).toHaveLength(0);
    // 密度不是靠「少寫」換來的：每份仍然用滿接近 240 的額度。
    const average =
      catalog.entries.reduce((sum, entry) => sum + entry.summary.length, 0) /
      catalog.entries.length;
    // 同上：上界寫死 240，常數被改大時這一行才會紅。
    expect(average).toBeGreaterThan(190);
    expect(average).toBeLessThanOrEqual(240);
  });
});

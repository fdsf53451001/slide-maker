import { describe, expect, it } from "vitest";
import { ingestSource, searchSources } from "../src/sources.js";
import {
  cjkCMapPdf,
  cjkTrackingPdf,
  COLUMN_LABELS,
  HANGUL_THREE,
  KANA_THREE,
  scriptBoundaryPdf,
  SEARCH_PHRASE,
  THREE_CJK,
  TWO_CJK,
} from "./helpers/raw-pdf.js";

const PDF = { mediaType: "application/pdf", allowModelAccess: true } as const;

async function ingestPdf(name: string, bytes: Uint8Array) {
  return ingestSource({ name, ...PDF }, bytes, `assets/${name}`);
}

/**
 * `untrackCjk` 的兩個判準——「連續 ≥3 個 token」與「每個 token 都是單一 CJK 字元」——
 * 在既有測資上都量不到，因為那份 fixture 的中文標題有**六個**字、而且整組測資裡沒有
 * 半個非漢字的 CJK 字元。實測（把突變套進 `apps/server/src/sources.ts` 再跑完整套件）：
 * 門檻改成 ≥2、≥4、≥6 三種，1137 條測試全部照樣通過。
 */
describe("CJK 去字距的門檻與書寫系統邊界", () => {
  it("恰好三個單一漢字會併回去，恰好兩個不會", async () => {
    const source = await ingestPdf("boundary.pdf", scriptBoundaryPdf());
    const lines = source.extractedText.split("\n");
    // 下界：三個就是門檻本身。改成「≥4 才併」時這一條會紅。
    expect(lines[0]).toBe(THREE_CJK);
    // 上界：兩個單字之間的空白**留著**。中文有大量單字詞（`寒 假`／`兩 會`），放寬成
    // ≥2 會把同一儲存格裡相鄰的兩個單字欄位併成原文沒有的詞——實測某中文財報的目錄
    // 因此多出 `目頁`、投影片多出 `數果`。改成「≥2 就併」時這一條會紅。
    expect(lines[1]).toBe([...TWO_CJK].join(" "));
  });

  it("諺文保留空白，假名照樣併回去", async () => {
    const source = await ingestPdf("boundary.pdf", scriptBoundaryPdf());
    const lines = source.extractedText.split("\n");
    // 韓文用空白分詞，`가 나 다` 有可能真的是三個詞，一律不動。字元類把諺文
    // （AC00–D7AF）排除在外就是為了這件事，但整組測資原本一個諺文字都沒有——
    // 範圍端點寫成字面字元時，NFC 會把 U+F900 換成 U+8C48、使該條範圍靜默擴張成
    // 8C48–FAFF 而吞掉諺文，那個版本在既有測試下**全綠**。
    expect(lines[2]).toBe([...HANGUL_THREE].join(" "));
    // 反面：假名（3040–30FF）在字元類裡，日文同樣不靠空白分詞，要併。
    expect(lines[3]).toBe(KANA_THREE);
  });
});

/**
 * 這條修法的**目的**不是讓抽出來的字串好看，而是讓 `searchSources()` 撈得到——
 * 大綱階段挑得到這份來源、引用得到這一段，全靠子字串比對。上面那些逐行斷言證明
 * 字串對了，但沒有任何一條走到真正的入口（`ingestSource` → `chunkSourceText` →
 * `searchSources`），而 chunk 是另外切的：切塊視窗、`trim()`、前綴都可能讓「文字對了
 * 但搜尋仍撈不到」。
 */
describe("中文 PDF 端到端：抽取 → 切塊 → 搜尋", () => {
  it("加寬字距的中文標題，整個詞搜得到", async () => {
    // 用 fixture 丙而不是乙：乙的第二行是「同樣的字、字距 0」的對照組，那個詞在同一份
    // 文件裡本來就有一份正常的副本，於是拿掉 `untrackCjk` 之後這條**照樣綠**（實測過）。
    // `SEARCH_PHRASE` 只以加寬字距的形式存在，才問得出「修法有沒有讓它搜得到」。
    const source = await ingestPdf("report.pdf", scriptBoundaryPdf());
    const hits = searchSources([source], SEARCH_PHRASE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain(SEARCH_PHRASE);
  });

  it("預先定義 CJK CMap 的中文，整個詞搜得到", async () => {
    const source = await ingestPdf("manual.pdf", cjkCMapPdf());
    const hits = searchSources([source], "中文測試");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("跨儲存格的三個單字標籤不會被併成一個搜得到的假詞", async () => {
    // 逐儲存格套用的意義在搜尋端才看得出來：`北中南` 這個詞原文並不存在，
    // 改成「對整頁組好的文字套一次」時它會變成搜得到的字串。
    const source = await ingestPdf("roadmap.pdf", cjkTrackingPdf());
    expect(searchSources([source], COLUMN_LABELS)).toHaveLength(0);
  });
});

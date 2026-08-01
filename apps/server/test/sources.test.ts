import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { ingestSource } from "../src/sources.js";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function wordCell(text: string): string {
  return `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
}
function wordRow(cells: readonly string[]): string {
  return `<w:tr>${cells.map(wordCell).join("")}</w:tr>`;
}
async function ingestDocx(body: string) {
  return ingestSource(
    { name: "doc.docx", mediaType: DOCX_TYPE, allowModelAccess: true },
    zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
      ),
    }),
    "assets/doc.docx",
  );
}

describe("OOXML 表格結構", () => {
  it("把 docx 表格還原成 markdown pipe table 而不是一行一格的流水帳", async () => {
    const source = await ingestDocx(
      `<w:p><w:r><w:t>2025 電動車銷量表</w:t></w:r></w:p>
       <w:tbl>
         ${wordRow(["車型", "銷量", "成長率"])}
         ${wordRow(["Model Y", "12000", "15%"])}
         ${wordRow(["Ioniq 5", "8000", "7%"])}
       </w:tbl>
       <w:p><w:r><w:t>資料來源：交通部</w:t></w:r></w:p>`,
    );
    // 逐行比對而非 toContain：列界線全毀時三列會併成一列九欄，
    // 而「| 車型 | 銷量 | 成長率 |」「| Model Y | 12000 | 15% |」仍是那一長列的子字串，
    // 用 toContain 檢查等於完全驗不到欄列關係——正是這次要修的東西。
    expect(source.extractedText.split("\n").filter((line) => line.startsWith("|"))).toEqual([
      "| 車型 | 銷量 | 成長率 |",
      "| --- | --- | --- |",
      "| Model Y | 12000 | 15% |",
      "| Ioniq 5 | 8000 | 7% |",
    ]);
    // 表格外的段落仍是一般文字，不該被吸進表格。
    expect(source.extractedText.startsWith("2025 電動車銷量表")).toBe(true);
    expect(source.extractedText.trimEnd().endsWith("資料來源：交通部")).toBe(true);
  });

  it("欄數不齊的列補空白對齊：合併儲存格在 markdown 無法表達，但欄數必須一致", async () => {
    const source = await ingestDocx(
      `<w:tbl>${wordRow(["季度", "北區", "南區"])}${wordRow(["Q1", "100"])}</w:tbl>`,
    );
    expect(source.extractedText).toContain("| Q1 | 100 |  |");
    const widths = source.extractedText
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|").length);
    expect(new Set(widths).size).toBe(1);
  });

  it("欄寬取最寬的列而不是表頭：合併的表頭儲存格會讓表頭比內容列窄", async () => {
    // 上一個案例的表頭剛好最寬，用表頭寬度也會通過。真正會出事的是表頭被合併成一格、
    // 內容列反而較寬的表——照表頭裁切會把每一列尾端的資料整欄砍掉。
    const source = await ingestDocx(
      `<w:tbl>${wordRow(["2025 年度銷量"])}${wordRow(["Model Y", "12000", "15%"])}</w:tbl>`,
    );
    expect(source.extractedText.split("\n").filter((line) => line.startsWith("|"))).toEqual([
      "| 2025 年度銷量 |  |  |",
      "| --- | --- | --- |",
      "| Model Y | 12000 | 15% |",
    ]);
  });

  it("空的 <w:tbl>（常見的排版用表格）不留下空殼 pipe table", async () => {
    // 排版用的空表格若輸出成「|  |」，模型會把它當成一張真的表並試著解讀。
    const source = await ingestDocx(
      `<w:p><w:r><w:t>前言</w:t></w:r></w:p><w:tbl></w:tbl><w:p><w:r><w:t>結語</w:t></w:r></w:p>`,
    );
    expect(source.extractedText).toBe("前言\n\n結語");
  });

  it("只有表頭沒有內容列時仍輸出合法的 markdown 表格骨架", async () => {
    // 少了分隔列，下游會把它當成一行普通文字；保留骨架才看得出「這張表是空的」。
    const source = await ingestDocx(`<w:tbl>${wordRow(["車型", "銷量"])}</w:tbl>`);
    expect(source.extractedText).toBe("| 車型 | 銷量 |\n| --- | --- |");
  });

  it("儲存格內的多段與 <w:br> 壓成一行：裸換行會把一列劈成兩列並錯開後面所有欄", async () => {
    const multiParagraph = `<w:tc><w:p><w:r><w:t>一月</w:t></w:r></w:p><w:p><w:r><w:t>二月</w:t></w:r></w:p></w:tc>`;
    const withBreak = `<w:tc><w:p><w:r><w:t>北區</w:t><w:br/><w:t>南區</w:t></w:r></w:p></w:tc>`;
    const source = await ingestDocx(
      `<w:tbl>${wordRow(["期間", "區域"])}<w:tr>${multiParagraph}${withBreak}</w:tr></w:tbl>`,
    );
    expect(source.extractedText.split("\n").filter((line) => line.startsWith("|"))).toEqual([
      "| 期間 | 區域 |",
      "| --- | --- |",
      "| 一月 二月 | 北區 南區 |",
    ]);
  });

  it("空儲存格保留位置：直接丟掉會讓後面的值整排往前移一欄", async () => {
    const source = await ingestDocx(
      `<w:tbl>${wordRow(["季度", "北區", "南區"])}${wordRow(["Q1", "", "300"])}</w:tbl>`,
    );
    expect(source.extractedText).toContain("| Q1 |  | 300 |");
  });

  it("儲存格內的管線字元要 escape，否則會被當成欄界把表格撐開", async () => {
    const source = await ingestDocx(
      `<w:tbl>${wordRow(["語法", "說明"])}${wordRow(["a|b", "管線"])}</w:tbl>`,
    );
    expect(source.extractedText).toContain("| a\\|b | 管線 |");
  });

  it("巢狀表格不得把內部哨兵字元漏進 extractedText", async () => {
    // 哨兵是用來標記結構界線的不可見控制字元（U+0001..U+0005）。巢狀 <w:tbl> 會讓表格
    // 的開始／結束標記在非貪婪配對下錯位，一個留在外層儲存格裡、一個流到表格外。
    // 版面錯亂是已知取捨，控制字元外洩不是：它會一路汙染 prompt、FTS chunk 與編輯器 UI，
    // 而且完全看不見，只會表現成模型讀到奇怪內容或前端渲染出詭異字元。
    const inner = `<w:tbl>${wordRow(["內層A", "內層B"])}</w:tbl>`;
    const outerRow = `<w:tr><w:tc><w:p><w:r><w:t>外層</w:t></w:r></w:p>${inner}</w:tc>${wordCell("右")}</w:tr>`;
    const source = await ingestDocx(
      `<w:p><w:r><w:t>前言</w:t></w:r></w:p><w:tbl>${outerRow}</w:tbl><w:p><w:r><w:t>結語</w:t></w:r></w:p>`,
    );
    expect(source.extractedText).not.toMatch(/[\u0001-\u0005]/);
    // chunk 是餵給檢索與 prompt 的實際文字，一併確認沒有夾帶。
    expect(source.chunks.every((chunk) => !/[\u0001-\u0005]/.test(chunk.text))).toBe(true);
    // 內容本身仍要留著，不能為了清哨兵把整段文字一起丟掉。
    expect(source.extractedText).toContain("前言");
    expect(source.extractedText).toContain("內層A");
    expect(source.extractedText).toContain("結語");
  });

  it("pptx 表格走同一條路徑", async () => {
    const cell = (text: string) =>
      `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
    const row = (cells: readonly string[]) => `<a:tr>${cells.map(cell).join("")}</a:tr>`;
    const slide = `<?xml version="1.0"?><p:sld><p:cSld><a:tbl>${row(["項目", "值"])}${row(["延遲", "12ms"])}</a:tbl></p:cSld></p:sld>`;
    const source = await ingestSource(
      { name: "deck.pptx", mediaType: PPTX_TYPE, allowModelAccess: true },
      zipSync({ "ppt/slides/slide1.xml": strToU8(slide) }),
      "assets/deck.pptx",
    );
    expect(source.extractedText).toContain("| 項目 | 值 |");
    expect(source.extractedText).toContain("| 延遲 | 12ms |");
  });
});

const A_CELL = (text: string) =>
  `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const A_ROW = (cells: readonly string[]) => `<a:tr>${cells.map(A_CELL).join("")}</a:tr>`;

async function ingestPptx(files: Record<string, string>) {
  return ingestSource(
    { name: "deck.pptx", mediaType: PPTX_TYPE, allowModelAccess: true },
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
    "assets/deck.pptx",
  );
}

describe("只採納 <a:t>／<w:t>，元素的機器識別碼不得漏出", () => {
  it("pptx 表格的 tableStyleId GUID 不會黏在第一個儲存格前面", async () => {
    // PowerPoint 建的表格一律有 <a:tableStyleId>，內容是 GUID 而不是屬性，所以「剝掉標籤、
    // 其餘留下」的作法會把它留在第一格前面。實測形狀：
    //   | {5C22544A-7EE6-4342-B048-85BDC9FD1C3A}部門 | 營收 | 年增率 |
    // 它會一路汙染 extractedText、FTS chunk、大綱目錄摘要與來源詳情 UI。
    const slide =
      `<?xml version="1.0"?><p:sld><p:cSld>` +
      `<a:tbl><a:tblPr firstRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>` +
      `${A_ROW(["部門", "營收"])}${A_ROW(["雲端", "128.4"])}</a:tbl></p:cSld></p:sld>`;
    const source = await ingestPptx({ "ppt/slides/slide1.xml": slide });
    // 逐行相等而非 not.toContain(GUID)：GUID 換一個值就漏掉的斷言等於沒釘住，
    // 而第一格的內容必須「正好是」表頭本身。
    expect(source.extractedText.split("\n").filter((line) => line.startsWith("|"))).toEqual([
      "| 部門 | 營收 |",
      "| --- | --- |",
      "| 雲端 | 128.4 |",
    ]);
    expect(source.extractedText).not.toMatch(/[{}]/);
  });

  it("docx 的 <w:instrText> 欄位指令不會被當成正文", async () => {
    // 同一類問題在 docx 側的形狀：欄位指令的內容是給 Word 執行的，顯示結果本來就
    // 另外存在 <w:t> 裡，收下它等於把 `HYPERLINK "https://…"` 存成使用者寫的字。
    const source = await ingestDocx(
      `<w:p><w:r><w:instrText> HYPERLINK "https://example.com/secret" </w:instrText></w:r>` +
        `<w:r><w:t>年報下載</w:t></w:r></w:p>`,
    );
    expect(source.extractedText).toBe("年報下載");
  });

  it("&amp; 最後才還原：&amp;quot; 應保持字面而不是變成引號", async () => {
    // 還原順序若把 &amp; 排在 &quot; 之前，`&amp;quot;` 會先變成 `&quot;` 再被換成 `"`,
    // 使用者寫的字面 escape 於是被解讀了兩次。
    const source = await ingestDocx(
      `<w:p><w:r><w:t>&amp;quot; 與 &amp;lt; 是字面</w:t></w:r></w:p>`,
    );
    expect(source.extractedText).toBe("&quot; 與 &lt; 是字面");
  });

  it("<a:br/> 仍然換行，且儲存格內不會把上下兩行黏成一個詞", async () => {
    // 換行改走哨兵之後的回歸守衛：控制字元不在 \s 裡，cellText 少一條 replaceAll
    // 就會得到「上行下行」。
    const slide =
      `<?xml version="1.0"?><p:sld><p:cSld>` +
      `<a:tbl>${A_ROW(["欄"])}` +
      `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>上行</a:t></a:r><a:br/><a:r><a:t>下行</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
      `</a:tbl>` +
      `<p:sp><p:txBody><a:p><a:r><a:t>段首</a:t></a:r><a:br/><a:r><a:t>段尾</a:t></a:r></a:p></p:txBody></p:sp>` +
      `</p:cSld></p:sld>`;
    const source = await ingestPptx({ "ppt/slides/slide1.xml": slide });
    expect(source.extractedText).toContain("| 上行 下行 |");
    expect(source.extractedText).toContain("段首\n段尾");
  });
});

describe("pptx 備忘稿", () => {
  const NOTES = (text: string) =>
    `<?xml version="1.0"?><p:notes><p:cSld><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:cSld></p:notes>`;
  const SLIDE = (text: string) =>
    `<?xml version="1.0"?><p:sld><p:cSld><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:cSld></p:sld>`;
  const RELS = (target: string) =>
    `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="${target}"/></Relationships>`;

  it("備忘稿接在該頁之後並標記出處", async () => {
    const source = await ingestPptx({
      "ppt/slides/slide1.xml": SLIDE("雲端成長 31%"),
      "ppt/slides/_rels/slide1.xml.rels": RELS("../notesSlides/notesSlide1.xml"),
      "ppt/notesSlides/notesSlide1.xml": NOTES("這頁要強調毛利改善，不要念數字"),
    });
    // 標記是必要的：備忘稿是講者要說的話，不標的話大綱模型會把「不要念數字」這種
    // 給講者的指示當成投影片上印著的內容。
    expect(source.extractedText).toBe("雲端成長 31%\n［備忘稿］這頁要強調毛利改善，不要念數字");
  });

  it("對應靠 rels 而不是檔名編號——第 2 頁的備忘稿可以叫 notesSlide1", async () => {
    // 備忘稿只有加過的頁才有，編號因此不連續。用 slideN → notesSlideN 硬湊的話，
    // 這個（很常見的）情況會把備忘稿掛到錯的頁上。
    const source = await ingestPptx({
      "ppt/slides/slide1.xml": SLIDE("第一頁"),
      "ppt/slides/slide2.xml": SLIDE("第二頁"),
      "ppt/slides/_rels/slide2.xml.rels": RELS("../notesSlides/notesSlide1.xml"),
      "ppt/notesSlides/notesSlide1.xml": NOTES("只有第二頁有備忘稿"),
    });
    const [first, second] = source.extractedText.split("\n\n");
    expect(first).toBe("第一頁");
    expect(second).toBe("第二頁\n［備忘稿］只有第二頁有備忘稿");
  });

  it("Target 寫在 Type 前面也抓得到——XML 不保證屬性順序", async () => {
    // 寫死 `Type="…" Target="…"` 的話，換一個產生器就靜默抽不到備忘稿，
    // 而失敗形狀是「少了一段文字」不是報錯，不會有人發現。
    const source = await ingestPptx({
      "ppt/slides/slide1.xml": SLIDE("內容"),
      "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Target="../notesSlides/notesSlide1.xml" Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"/></Relationships>`,
      "ppt/notesSlides/notesSlide1.xml": NOTES("順序反過來也要讀到"),
    });
    expect(source.extractedText).toBe("內容\n［備忘稿］順序反過來也要讀到");
  });

  it("沒有備忘稿時輸出不變", async () => {
    const source = await ingestPptx({
      "ppt/slides/slide1.xml": SLIDE("只有內容"),
      "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    });
    expect(source.extractedText).toBe("只有內容");
  });

  it("rels 指到不存在的檔案時略過，不整份失敗", async () => {
    const source = await ingestPptx({
      "ppt/slides/slide1.xml": SLIDE("內容還在"),
      "ppt/slides/_rels/slide1.xml.rels": RELS("../notesSlides/notesSlide9.xml"),
    });
    expect(source.extractedText).toBe("內容還在");
  });

  it("整頁只有備忘稿（空白頁加註）時仍收得到", async () => {
    const source = await ingestPptx({
      "ppt/slides/slide1.xml": `<?xml version="1.0"?><p:sld><p:cSld/></p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": RELS("../notesSlides/notesSlide1.xml"),
      "ppt/notesSlides/notesSlide1.xml": NOTES("這頁是過場，口頭帶過"),
    });
    expect(source.extractedText).toBe("［備忘稿］這頁是過場，口頭帶過");
  });
});

describe("PDF 文字抽取", () => {
  async function pdfWithTable() {
    const document = await PDFDocument.create();
    const page = document.addPage([420, 220]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("2025 Sales Report", { x: 50, y: 190, size: 14, font });
    const rows = [
      ["Item", "Qty", "Rate"],
      ["Model Y", "12000", "15%"],
      ["A", "1", "-"],
    ];
    const columns = [50, 220, 330];
    rows.forEach((row, rowIndex) =>
      row.forEach((cell, columnIndex) =>
        page.drawText(cell, { x: columns[columnIndex]!, y: 150 - rowIndex * 30, size: 11, font }),
      ),
    );
    page.drawText("Source: Ministry of Transport", { x: 50, y: 20, size: 10, font });
    return new Uint8Array(await document.save());
  }

  it("依座標還原欄列，並保住單字元儲存格", async () => {
    const source = await ingestSource(
      { name: "sales.pdf", mediaType: "application/pdf", allowModelAccess: true },
      await pdfWithTable(),
      "assets/sales.pdf",
    );
    expect(source.extractedText).toContain("| Item | Qty | Rate |");
    expect(source.extractedText).toContain("| Model Y | 12000 | 15% |");
    // 舊版以 regex 抓 (…){2,}Tj，單字元儲存格會整個消失，表格於是缺格。
    expect(source.extractedText).toContain("| A | 1 | - |");
  });

  it("整行只有一段文字時不會被包成表格", async () => {
    // 只涵蓋 width 為 1 的情況。名稱曾寫成「單欄文字不會被誤判成表格」，那句話宣稱的是
    // 底下那條已知限制擋得住雙欄排版——它擋不住。
    const source = await ingestSource(
      { name: "sales.pdf", mediaType: "application/pdf", allowModelAccess: true },
      await pdfWithTable(),
      "assets/sales.pdf",
    );
    expect(source.extractedText).toContain("2025 Sales Report");
    expect(source.extractedText).not.toContain("| 2025 Sales Report |");
    expect(source.extractedText).toContain("Source: Ministry of Transport");
  });

  it("已知限制：雙欄排版的散文仍會被誤判成表格", async () => {
    // 這裡固化的是「目前的行為」而不是「想要的行為」。純文字幾何分不出「短儲存格的表」
    // 與「長文字的欄」，收緊條件會把長文字的真表格降級成散文——那是先前修掉的失敗模式，
    // 而且手上沒有 PDF 語料可以衡量取捨。真正的判別訊號是框線（getOperatorList 的繪製
    // 指令），改用它時這個測試就該跟著改成「雙欄散文維持散文」。
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([500, 220]);
    const left = ["Electric vehicle sales", "grew steadily in 2025", "across every region"];
    const right = ["Charging infrastructure", "lagged behind demand", "in rural districts"];
    left.forEach((line, index) =>
      page.drawText(line, { x: 40, y: 170 - index * 30, size: 11, font }),
    );
    right.forEach((line, index) =>
      page.drawText(line, { x: 280, y: 170 - index * 30, size: 11, font }),
    );

    const source = await ingestSource(
      { name: "twocol.pdf", mediaType: "application/pdf", allowModelAccess: true },
      new Uint8Array(await document.save()),
      "assets/twocol.pdf",
    );
    // 左右兩欄不相干的句子被配成同一列，模型會讀出根本不存在的對應關係。
    expect(source.extractedText).toContain("| Electric vehicle sales | Charging infrastructure |");
  });

  it("PDF 儲存格內的管線字元同樣要 escape：規格表常出現 A|B 這種寫法", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([420, 160]);
    const rows = [
      ["Mode", "Note"],
      ["A|B", "dual"],
    ];
    rows.forEach((row, rowIndex) =>
      row.forEach((cell, columnIndex) =>
        page.drawText(cell, { x: 50 + columnIndex * 180, y: 110 - rowIndex * 30, size: 11, font }),
      ),
    );

    const source = await ingestSource(
      { name: "spec.pdf", mediaType: "application/pdf", allowModelAccess: true },
      new Uint8Array(await document.save()),
      "assets/spec.pdf",
    );
    expect(source.extractedText).toContain("| A\\|B | dual |");
  });

  it("多頁依序串接，中間沒有文字的頁不留下空段落", async () => {
    // 掃描件與含插圖的報告常有整頁無文字；空頁若輸出成空段落，chunk 切割會在那裡斷開，
    // 後段內容於是被推進沒人會撈到的 chunk。
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const first = document.addPage([400, 200]);
    first.drawText("Page one heading", { x: 40, y: 150, size: 12, font });
    document.addPage([400, 200]);
    const third = document.addPage([400, 200]);
    third.drawText("Page three tail", { x: 40, y: 150, size: 12, font });

    const source = await ingestSource(
      { name: "multi.pdf", mediaType: "application/pdf", allowModelAccess: true },
      new Uint8Array(await document.save()),
      "assets/multi.pdf",
    );
    expect(source.extractedText).toBe("Page one heading\n\nPage three tail");
  });

  it("旋轉過的頁面仍還原得出欄列：座標得先正規化，否則整張表會被讀成一欄", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([400, 300]);
    page.setRotation(degrees(90));
    const rows = [
      ["Item", "Qty"],
      ["Bolt", "12"],
      ["Nut", "34"],
    ];
    rows.forEach((row, rowIndex) =>
      row.forEach((cell, columnIndex) =>
        page.drawText(cell, { x: 40 + columnIndex * 150, y: 220 - rowIndex * 30, size: 11, font }),
      ),
    );

    const source = await ingestSource(
      { name: "rotated.pdf", mediaType: "application/pdf", allowModelAccess: true },
      new Uint8Array(await document.save()),
      "assets/rotated.pdf",
    );
    expect(source.extractedText.split("\n").filter((line) => line.startsWith("|"))).toEqual([
      "| Item | Qty |",
      "| --- | --- |",
      "| Bolt | 12 |",
      "| Nut | 34 |",
    ]);
  });

  it("完全沒有文字的 PDF 以空字串收場，而不是讓整份上傳失敗", async () => {
    // 純掃描 PDF 沒有文字層是常態。這裡丟錯的話使用者連檔案都存不進專案，
    // 之後想補 OCR 也沒得補。
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    const source = await ingestSource(
      { name: "scan.pdf", mediaType: "application/pdf", allowModelAccess: true },
      new Uint8Array(await document.save()),
      "assets/scan.pdf",
    );
    expect(source.extractedText).toBe("");
    expect(source.chunks).toEqual([]);
  });

  it("非 PDF 內容以具名錯誤碼拒絕", async () => {
    await expect(
      ingestSource(
        { name: "fake.pdf", mediaType: "application/pdf", allowModelAccess: true },
        strToU8("not a pdf at all"),
        "assets/fake.pdf",
      ),
    ).rejects.toThrow("SOURCE_PDF_INVALID");
  });
});

describe("純文字來源", () => {
  it("markdown 表格原樣保留（不經過 OOXML 組裝）", async () => {
    const markdown = "# 標題\n\n| 車型 | 銷量 |\n|---|---|\n| Model Y | 12000 |\n";
    const source = await ingestSource(
      { name: "note.md", mediaType: "text/markdown", allowModelAccess: true },
      strToU8(markdown),
      "assets/note.md",
    );
    expect(source.extractedText).toBe(markdown.trim());
  });
});

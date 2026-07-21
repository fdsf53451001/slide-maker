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

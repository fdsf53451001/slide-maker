import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
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
    expect(source.extractedText).toContain("| 車型 | 銷量 | 成長率 |");
    expect(source.extractedText).toContain("| Model Y | 12000 | 15% |");
    expect(source.extractedText).toContain("| Ioniq 5 | 8000 | 7% |");
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

  it("儲存格內的管線字元要 escape，否則會被當成欄界把表格撐開", async () => {
    const source = await ingestDocx(
      `<w:tbl>${wordRow(["語法", "說明"])}${wordRow(["a|b", "管線"])}</w:tbl>`,
    );
    expect(source.extractedText).toContain("| a\\|b | 管線 |");
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

  it("單欄文字不會被誤判成表格", async () => {
    const source = await ingestSource(
      { name: "sales.pdf", mediaType: "application/pdf", allowModelAccess: true },
      await pdfWithTable(),
      "assets/sales.pdf",
    );
    expect(source.extractedText).toContain("2025 Sales Report");
    expect(source.extractedText).not.toContain("| 2025 Sales Report |");
    expect(source.extractedText).toContain("Source: Ministry of Transport");
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

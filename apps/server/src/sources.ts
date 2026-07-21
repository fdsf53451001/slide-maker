import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { createSourceInputSchema, type SourceAsset } from "@slide-maker/core";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const TEXT_TYPES = new Set(["text/plain", "text/markdown"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const TYPE_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

// OOXML 的結構界線在剝掉標籤後就消失了，所以先換成哨兵字元，剝完再據以組裝。
// 直接把 </w:tc>、</w:tr> 連同其他標籤一起刪掉，等於把表格壓成一行一格的流水帳，
// 欄列關係全失——下游只能猜哪幾格是同一列，表格於是缺欄缺列。
const PARAGRAPH = "\u0001";
const CELL_END = "\u0002";
const ROW_END = "\u0003";
const TABLE_START = "\u0004";
const TABLE_END = "\u0005";

/** 儲存格內文：多段壓成一行，裸管線 escape 以免破壞 markdown 欄位。 */
function cellText(value: string): string {
  return value.replaceAll(PARAGRAPH, " ").replace(/\s+/g, " ").replaceAll("|", "\\|").trim();
}

/** 表格外的一般文字：段落界還原成換行，殘留的表格標記丟棄。 */
function flowText(value: string): string {
  return value
    .replaceAll(PARAGRAPH, "\n")
    .replaceAll(CELL_END, "")
    .replaceAll(ROW_END, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * 把標記過的表格區塊組成 markdown pipe table。
 *
 * 欄數以最寬的列為準，較窄的列補空格：合併儲存格（w:gridSpan）在 markdown 無法表達，
 * 補空格至少讓每列欄數一致——欄數不齊的表格下游無法驗證，模型也會誤讀對應關係。
 */
function pipeTable(block: string): string {
  const rows = block
    .split(ROW_END)
    // 每格都以 CELL_END 收尾，故 split 後的尾巴必為空字串，去掉。
    .map((row) => row.split(CELL_END).slice(0, -1).map(cellText))
    .filter((cells) => cells.length > 0 && cells.some(Boolean));
  if (!rows.length) return "";
  const [header, ...body] = rows;
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: readonly string[]) =>
    `| ${[...cells, ...Array(Math.max(0, width - cells.length)).fill("")].join(" | ")} |`;
  return [line(header!), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

function xmlText(xml: string): string {
  const marked = xml
    // 哨兵是內部標記；合法 XML 不含這些控制字元，仍先清掉以免組裝時誤判。
    .replace(/[\u0001-\u0005]/g, "")
    .replace(/<(?:a|w):br\s*\/?\s*>/g, "\n")
    .replace(/<(?:a|w):tbl(?=[\s>])[^>]*>/g, TABLE_START)
    .replace(/<\/(?:a|w):tbl>/g, TABLE_END)
    .replace(/<\/(?:a|w):p>/g, PARAGRAPH)
    .replace(/<\/(?:a|w):tc>/g, CELL_END)
    .replace(/<\/(?:a|w):tr>/g, ROW_END)
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
  // 非貪婪配對：巢狀表格（罕見）會被切在內層的結束標記上，結果不理想但不會壞掉。
  const assembled = marked.replace(
    new RegExp(`${TABLE_START}([\\s\\S]*?)${TABLE_END}`, "g"),
    (_match, block: string) => `\n\n${pipeTable(block)}\n\n`,
  );
  return flowText(assembled)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseOffice(bytes: Uint8Array, kind: "docx" | "pptx"): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("SOURCE_ARCHIVE_INVALID");
  }
  const names =
    kind === "docx"
      ? ["word/document.xml"]
      : Object.keys(files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parts = names
    .map((name) => files[name])
    .filter((value): value is Uint8Array => !!value)
    .map((value) => xmlText(strFromU8(value)));
  if (!parts.some(Boolean)) throw new Error("SOURCE_TEXT_NOT_FOUND");
  return parts.join("\n\n");
}

/** pdf.js 的文字片段：transform[4]／[5] 是它在頁面座標系的 x／y。 */
interface PdfGlyph {
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
}

function isGlyph(item: unknown): item is PdfGlyph {
  return (
    !!item && typeof item === "object" && "str" in item && "transform" in item && "width" in item
  );
}

/**
 * 把一頁的文字片段依座標還原成文字，能認出表格就輸出 markdown pipe table。
 *
 * PDF 沒有「段落」或「儲存格」的概念，只有一堆帶座標的文字片段，所以版面得從幾何反推：
 * y 相近的是同一列，列內 x 的顯著空隙就是欄界。少了這步，一張表會被讀成一長串沒有
 * 行列關係的字。
 */
function layoutPdfPage(items: readonly unknown[]): string {
  const glyphs = items.filter(isGlyph).filter((glyph) => glyph.str.trim());
  if (!glyphs.length) return "";
  const lineHeight =
    glyphs.map((glyph) => glyph.height).sort((left, right) => left - right)[
      Math.floor(glyphs.length / 2)
    ] || 10;

  // 依 y 分列（PDF 原點在左下，故 y 大的在上）。容差取字高一半：太大會併掉相鄰行，
  // 太小會讓同列裡輕微偏移的片段各自成列。
  const lines: PdfGlyph[][] = [];
  for (const glyph of [...glyphs].sort(
    (left, right) => (right.transform[5] ?? 0) - (left.transform[5] ?? 0),
  )) {
    const y = glyph.transform[5] ?? 0;
    const current = lines.at(-1);
    const currentY = current?.[0]?.transform[5] ?? 0;
    if (current && Math.abs(currentY - y) <= lineHeight * 0.5) current.push(glyph);
    else lines.push([glyph]);
  }

  // 列內依 x 排序後合併：緊鄰的片段屬於同一個詞／儲存格，顯著空隙才是欄界。
  const rows = lines.map((line) => {
    const sorted = [...line].sort(
      (left, right) => (left.transform[4] ?? 0) - (right.transform[4] ?? 0),
    );
    const cells: string[] = [];
    let buffer = "";
    let end = Number.NEGATIVE_INFINITY;
    for (const glyph of sorted) {
      const x = glyph.transform[4] ?? 0;
      const gap = x - end;
      if (!buffer) buffer = glyph.str;
      else if (gap > lineHeight * 1.2) {
        cells.push(buffer.trim());
        buffer = glyph.str;
      } else buffer += gap > lineHeight * 0.25 ? ` ${glyph.str}` : glyph.str;
      end = x + glyph.width;
    }
    if (buffer.trim()) cells.push(buffer.trim());
    return cells;
  });

  // 連續且欄數一致（≥2 欄、≥2 列）的區塊視為表格。條件放寬會把雙欄排版誤判成表格，
  // 那比讀成散文更糟——欄位會被錯誤配對。
  const output: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const width = rows[index]!.length;
    let end = index;
    while (end + 1 < rows.length && rows[end + 1]!.length === width) end += 1;
    if (width >= 2 && end > index) {
      const block = rows.slice(index, end + 1);
      const line = (cells: readonly string[]) =>
        `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
      output.push(
        [line(block[0]!), `|${" --- |".repeat(width)}`, ...block.slice(1).map(line)].join("\n"),
      );
      index = end;
    } else output.push(rows[index]!.join(" "));
  }
  return output.join("\n");
}

/**
 * 以 pdf.js 抽取 PDF 文字。
 *
 * 舊版對整檔以 latin1 做 regex 撈 `(…)Tj`，三個問題疊在一起：中文全成亂碼、`{2,}` 把
 * 單字元儲存格整個丟掉、換行被壓成空格使欄列關係歸零——而且壓縮過的文字流根本抓不到。
 * pdf.js 會正確解碼並給出每段文字的座標，版面才有機會還原。
 */
async function parsePdf(bytes: Uint8Array): Promise<string> {
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-")))
    throw new Error("SOURCE_PDF_INVALID");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let document;
  try {
    // pdf.js 會接管（transfer）傳入的 buffer，故複製一份避免呼叫端的 bytes 被清空。
    document = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
  } catch {
    throw new Error("SOURCE_PDF_INVALID");
  }
  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(layoutPdfPage(content.items));
    }
    return pages.filter(Boolean).join("\n\n").trim();
  } finally {
    await document.destroy();
  }
}

export function safeFilename(name: string): string {
  const value = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f/\\:]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return (value || "source").slice(0, 180);
}

export function detectSourceMediaType(name: string, declared: string, bytes: Uint8Array): string {
  const expected = TYPE_BY_EXTENSION[extname(name).toLowerCase()];
  if (!expected) throw new Error("SOURCE_TYPE_UNSUPPORTED");
  if (
    declared &&
    declared !== "application/octet-stream" &&
    declared !== expected &&
    !(expected === "text/markdown" && declared === "text/plain")
  )
    throw new Error("SOURCE_MEDIA_TYPE_MISMATCH");
  if (
    expected === "image/png" &&
    !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("SOURCE_CONTENT_INVALID");
  if (
    expected === "image/jpeg" &&
    !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)
  )
    throw new Error("SOURCE_CONTENT_INVALID");
  if (
    (expected.endsWith("document") || expected.endsWith("presentation")) &&
    !(bytes[0] === 0x50 && bytes[1] === 0x4b)
  )
    throw new Error("SOURCE_CONTENT_INVALID");
  return expected;
}

function chunks(sourceId: string, text: string): SourceAsset["chunks"] {
  const result: SourceAsset["chunks"] = [];
  for (let start = 0, index = 0; start < text.length; start += 1200, index += 1) {
    const value = text.slice(start, start + 1600).trim();
    if (!value) continue;
    result.push({
      id: createHash("sha256").update(`${sourceId}:${index}:${value}`).digest("hex").slice(0, 24),
      text: value,
      locator: `chunk:${index + 1}`,
    });
  }
  return result;
}

// PDF 文字抽取（pdf.js）是非同步的，故 ingest 整體為 async。
export async function ingestSource(
  input: unknown,
  bytes: Uint8Array,
  assetPath: string,
  now = new Date().toISOString(),
): Promise<SourceAsset> {
  const parsed = createSourceInputSchema.parse(input);
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error("SOURCE_SIZE_INVALID");
  const mediaType = detectSourceMediaType(parsed.name, parsed.mediaType, bytes);
  let extractedText = "";
  if (TEXT_TYPES.has(mediaType))
    extractedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  else if (mediaType === "application/pdf") extractedText = await parsePdf(bytes);
  else if (mediaType.endsWith("wordprocessingml.document"))
    extractedText = parseOffice(bytes, "docx");
  else if (mediaType.endsWith("presentationml.presentation"))
    extractedText = parseOffice(bytes, "pptx");
  const id = randomUUID();
  return {
    id,
    name: parsed.name,
    mediaType,
    usage: parsed.usage ?? (IMAGE_TYPES.has(mediaType) ? "visual-reference" : "content"),
    allowModelAccess: parsed.allowModelAccess,
    status: "indexed",
    assetPath,
    sizeBytes: bytes.length,
    extractedText,
    chunks: chunks(id, extractedText),
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function searchSources(sources: readonly SourceAsset[], query: string, limit = 20) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return sources
    .flatMap((source) =>
      source.chunks.map((chunk) => {
        const haystack = `${source.name} ${chunk.text}`.toLocaleLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { sourceId: source.id, sourceName: source.name, ...chunk, score };
      }),
    )
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

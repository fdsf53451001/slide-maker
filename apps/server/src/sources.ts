import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import {
  createSourceInputSchema,
  MAX_UPLOAD_BYTES,
  SOURCE_COUNT_LIMIT,
  SOURCE_TOTAL_BYTES_LIMIT,
  type SourceAsset,
} from "@slide-maker/core";

const MAX_SOURCE_BYTES = MAX_UPLOAD_BYTES;
const TEXT_TYPES = new Set(["text/plain", "text/markdown"]);
/** 可上傳的圖片 media type。圖片描述那條路也認這一份，不另立第二份清單。 */
export const SOURCE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);
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
// 換行也走哨兵、不直接插一個裸的 "\n"：文字改成只從 <a:t>／<w:t> 採納之後，掃描器得
// 分得出「<a:br/> 產生的換行」與「XML 排版用的換行」，而裸的 "\n" 兩者長得一模一樣。
const LINE_BREAK = "\u0006";

/** 儲存格內文：多段壓成一行，裸管線 escape 以免破壞 markdown 欄位。 */
function cellText(value: string): string {
  return (
    value
      .replaceAll(PARAGRAPH, " ")
      // 控制字元不在 \s 裡，少了這行 <a:br/> 會把上下兩行黏成一個詞。
      .replaceAll(LINE_BREAK, " ")
      .replace(/\s+/g, " ")
      .replaceAll("|", "\\|")
      .trim()
  );
}

/**
 * 表格外的一般文字：段落界還原成換行，殘留的表格標記丟棄。
 *
 * 巢狀表格的哨兵一定要在這裡清掉。非貪婪配對會停在內層的結束標記，於是內層的
 * TABLE_START 留在外層儲存格裡、外層的 TABLE_END 流到表格外——兩者都是不可見控制字元，
 * 漏出去會一路汙染 extractedText、FTS chunk 與編輯器 UI。xmlText 是對「組裝完的整份文字」
 * 呼叫 flowText，所以這一步同時涵蓋表格內外，是唯一收得乾淨的位置。
 */
function flowText(value: string): string {
  return value
    .replaceAll(PARAGRAPH, "\n")
    .replaceAll(LINE_BREAK, "\n")
    .replaceAll(CELL_END, "")
    .replaceAll(ROW_END, "")
    .replaceAll(TABLE_START, "")
    .replaceAll(TABLE_END, "")
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

function unescapeXml(value: string): string {
  return (
    value
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      // &amp; 必須最後換，否則 `&amp;lt;` 會先變成 `&lt;` 再被上面那幾條換成 `<`。
      .replaceAll("&amp;", "&")
  );
}

/**
 * 文字執行段（`<a:t>`／`<w:t>`）與哨兵，依文件順序。
 *
 * `<a:tbl`、`<a:tblPr>`、`<a:tableStyleId>` 都以 `<a:t` 開頭，所以 `t` 之後必須緊接 `>`
 * 或屬性的空白才算命中。
 */
const TEXT_RUN_OR_SENTINEL = /<(?:a|w):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:a|w):t>|([\u0001-\u0006])/g;

/**
 * 從 OOXML 片段抽出人看得懂的文字。
 *
 * **只採納 `<a:t>`／`<w:t>` 的內容**，不是「把標籤刪掉、其餘留下」。後者會把元素的文字
 * 內容一併留下，而 OOXML 有不少元素的內容是機器識別碼——`<a:tableStyleId>` 存的是
 * `{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}` 這種 GUID，PowerPoint 建的表格一律有它，
 * 於是每一份含表格的 pptx 都會在第一個儲存格前面黏上一串 GUID，一路汙染 extractedText、
 * FTS chunk、大綱目錄摘要與來源詳情 UI。docx 側的同類是 `<w:instrText>`（欄位指令，
 * 例如 `HYPERLINK "https://…"`），它的顯示結果本來就另存在 `<w:t>` 裡。
 *
 * 白名單而非黑名單：逐一列舉「要排除誰」永遠追不完下一個版本新增的元素，而「文字只會
 * 出現在 t 元素裡」是 OOXML 的結構事實。
 */
function xmlText(xml: string): string {
  const marked = xml
    // 哨兵是內部標記；合法 XML 不含這些控制字元，仍先清掉以免組裝時誤判。
    .replace(/[\u0001-\u0006]/g, "")
    .replace(/<(?:a|w):br\s*\/?\s*>/g, LINE_BREAK)
    .replace(/<(?:a|w):tbl(?=[\s>])[^>]*>/g, TABLE_START)
    .replace(/<\/(?:a|w):tbl>/g, TABLE_END)
    .replace(/<\/(?:a|w):p>/g, PARAGRAPH)
    .replace(/<\/(?:a|w):tc>/g, CELL_END)
    .replace(/<\/(?:a|w):tr>/g, ROW_END);
  let collected = "";
  // matchAll 而不是 exec 迴圈：模組層的 /g regex 帶著可變的 lastIndex，中途 throw 就會
  // 污染下一次呼叫。matchAll 內部自己複製一份，沒有這個狀態。
  for (const match of marked.matchAll(TEXT_RUN_OR_SENTINEL))
    // 逐段 unescape 而不是對整份字串做：先 unescape 的話，正文裡的 `&lt;a:t&gt;` 會變成
    // 真的標籤而被掃描器當成文字段。
    collected += match[1] === undefined ? (match[2] ?? "") : unescapeXml(match[1]);
  // 非貪婪配對：巢狀表格（罕見）會被切在內層的結束標記上，結果不理想但不會壞掉。
  const assembled = collected.replace(
    new RegExp(`${TABLE_START}([\\s\\S]*?)${TABLE_END}`, "g"),
    (_match, block: string) => `\n\n${pipeTable(block)}\n\n`,
  );
  return flowText(assembled)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 這張投影片的備忘稿檔名，沒有就回 undefined。 */
function notesSlideName(files: Record<string, Uint8Array>, slideName: string): string | undefined {
  // 檔名不能用「slideN → notesSlideN」硬湊：備忘稿只有加過的頁才有，編號因此不連續，
  // 第 5 頁的備忘稿完全可能存成 notesSlide2.xml。關聯只在 rels 裡。
  const rels = files[slideName.replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels"];
  if (!rels) return undefined;
  // 逐個 <Relationship> 掃、兩個屬性分開抓，**不可**寫成 `Type="…" Target="…"` 一條龍：
  // XML 不保證屬性順序，寫死順序等於「換一個產生器就靜默抽不到備忘稿」，而且失敗形狀
  // 是少了一段文字、不是報錯。
  for (const [element] of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    if (!/Type="[^"]*\/notesSlide"/.test(element)) continue;
    const target = /Target="([^"]+)"/.exec(element)?.[1];
    if (!target) continue;
    // Target 相對於 ppt/slides/（`../notesSlides/notesSlide1.xml`）；規範也允許以 `/`
    // 開頭的套件絕對路徑，兩種都收。
    const resolved = target.startsWith("/") ? target.slice(1) : target.replace(/^\.\.\//, "ppt/");
    if (resolved in files) return resolved;
  }
  return undefined;
}

/**
 * 備忘稿在抽出來的文字裡的標記。
 *
 * 一定要標：備忘稿是講者要說的話，跟印在投影片上的字語意不同，混在一起會讓大綱模型
 * 把「不要念數字」這種給講者的指示當成投影片內容。
 */
const NOTES_LABEL = "［備忘稿］";

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
    .filter((name) => !!files[name])
    .map((name) => {
      const body = xmlText(strFromU8(files[name]!));
      if (kind !== "pptx") return body;
      const notesName = notesSlideName(files, name);
      const notes = notesName ? xmlText(strFromU8(files[notesName]!)) : "";
      // 接在該頁後面而不是集中到檔尾：備忘稿與投影片內容要落在同一個 chunk 視窗裡，
      // 分開的話 FTS 撈到備忘稿也對不回是哪一頁。
      if (!notes) return body;
      return body ? `${body}\n${NOTES_LABEL}${notes}` : `${NOTES_LABEL}${notes}`;
    });
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

  // 連續且欄數一致（≥2 欄、≥2 列）的區塊視為表格。
  //
  // 已知限制：這條件擋不住雙欄排版。一頁兩欄的散文，每一行都會因為欄間留白被切成 2 格、
  // 欄數又剛好一致，於是被輸出成 pipe table，在左右兩欄不相干的句子之間硬造出對應關係。
  // 沒有修，是因為單靠文字幾何分不出「短儲存格的表」與「長文字的欄」——收緊條件（限制
  // 儲存格長度之類）會反過來把長文字的真表格降級成散文，那正是先前修掉的失敗模式，而且
  // 手上沒有 PDF 語料可以衡量取捨。真正的判別訊號是表格的框線：pdf.js 的 getOperatorList()
  // 拿得到繪製指令，有框線才是表——那是另一個題目，不在這次的範圍內。
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

/**
 * 單一來源的正文字數上限（圖片走 `image-description.ts` 自己的 20000）。
 *
 * 截的是**抽取出來的文字**，不是上傳的檔案：`extractedText` 與由它切出來的 `chunks` 都住在
 * `project.json` 裡，而 chunks 因為視窗重疊還比正文多三成。沒有這道上限時，`SOURCE_TOTAL_BYTES_LIMIT`
 * （2 GiB 的**檔案**）換算成記憶體是無界的——200 份文字型 PDF 就足以讓每一次 updateProject
 * 的峰值超過 2Gi 的實例。
 *
 * 400000 字約等於 200–300 頁密排文字，是「一份簡報用得上的單一來源」的合理上界；200 份都
 * 頂到上限時，專案的文字量約 80 M 字元、`project.json` 約 190 MB、峰值約 560 MB，還留得下
 * sharp 與 OCR 的空間。**截斷會讓超出的部分連 FTS 都檢索不到**（chunks 由同一份文字切出），
 * 這是刻意的取捨：與其讓整台機器 OOM 掉所有人的請求，不如讓一份特別大的來源只索引前 400000
 * 字，而且 `metadata.textTruncated` 會把這件事寫在來源上，不是靜默發生。
 */
export const MAX_SOURCE_TEXT_CHARS = 400_000;

/** 一塊的最大字數。`source-context.ts` 餵進 prompt 前也以同一個數字截斷。 */
export const SOURCE_CHUNK_CHARS = 1600;
const SOURCE_CHUNK_STRIDE = 1200;

/**
 * 份數與容量的上限**住在 `@slide-maker/core`**（見那裡的說明）：編輯器要用同一組數字顯示
 * 「175/200」，前端自己抄一份就是第二份真相。這裡只放伺服器側的判斷與訊息。
 *
 * **2 GiB 說的是上傳的位元組，不是記憶體。**兩者的關聯要靠 {@link MAX_SOURCE_TEXT_CHARS}
 * 才成立：`extractedText` 與 `chunks` 都內嵌在 `project.json` 裡，而每次 `updateProject` 是
 * readFile → JSON.parse → parseProject → structuredClone → JSON.stringify，峰值約檔案的三倍。
 * Cloud Run 的實例正好也是 2Gi（`infra/main.tf`），所以「200 份各 10 MB 的 PDF」若不限制
 * 抽出來的文字量，光是讀寫專案就能打掉整台機器——同一台機器上「第二個 PaddleOCR 就 OOM」
 * 是已經踩過的坑。
 *
 * 200 份則要與 `OUTLINE_CATALOG_CHAR_BUDGET` 一起看：目錄要裝得下這麼多份，模型才選得到
 * 最後那幾份。
 */

/** 位元組 → 人看得懂的字串。錯誤訊息要讓使用者知道自己離上限多遠。 */
export function formatSourceBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 整數就不補小數點：「2 GB」比「2.00 GB」好讀，而 1.97 GB 需要那兩位才看得出離上限多近。
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} ${units[unit]}`;
}

/**
 * 專案來源的兩種上限各自的錯誤。
 *
 * **兩個碼刻意分開**：份數滿了要使用者刪幾份、容量滿了要刪「大的那幾份」，兩者的下一步
 * 不同，混成一個 `SOURCE_PROJECT_LIMIT` 的話使用者不知道自己撞到哪一條。訊息帶實際數字，
 * 前端只負責顯示——把「100 份」寫在前端字串裡就是第二份真相，改上限時必定漂掉。
 */
export class SourceLimitError extends Error {
  constructor(
    readonly code: "SOURCE_COUNT_LIMIT" | "SOURCE_SIZE_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "SourceLimitError";
  }
}

/** 再收 `incomingBytes` 這麼多會不會超過上限；沒超過回 `undefined`。 */
export function sourceCapacityError(
  sources: readonly { sizeBytes: number }[],
  incomingBytes: number,
): SourceLimitError | undefined {
  if (sources.length >= SOURCE_COUNT_LIMIT)
    return new SourceLimitError(
      "SOURCE_COUNT_LIMIT",
      `專案來源已達 ${SOURCE_COUNT_LIMIT} 份上限（目前 ${sources.length} 份），請先刪掉一些來源再試。`,
    );
  const used = sources.reduce((sum, source) => sum + source.sizeBytes, 0);
  if (used + incomingBytes > SOURCE_TOTAL_BYTES_LIMIT)
    return new SourceLimitError(
      "SOURCE_SIZE_LIMIT",
      `專案來源總容量已達 ${formatSourceBytes(SOURCE_TOTAL_BYTES_LIMIT)} 上限（目前 ${formatSourceBytes(used)}），請先刪掉一些較大的來源再試。`,
    );
  return undefined;
}

/** 同 {@link sourceCapacityError}，但直接丟出來（寫入端點用）。 */
export function assertSourceCapacity(
  sources: readonly { sizeBytes: number }[],
  incomingBytes: number,
): void {
  const error = sourceCapacityError(sources, incomingBytes);
  if (error) throw error;
}

/**
 * 截到 `limit` 字以內，但切在**看得懂的邊界**上：先找換行（段落／表格列），再找句末標點，
 * 兩者都沒有才硬切。
 *
 * 硬切的代價不是「少幾個字」而是「多一句假話」：實測大綱目錄把一份餐廳評比表切在
 * `… | 職人丼深夜食堂 信義店 ` 這種位置，模型看到的是一列殘缺的表格，既判斷不了這份來源
 * 講什麼，還可能把半行當成完整資料引用。
 *
 * 邊界只在後 60% 的範圍內找：太靠前的換行會讓截出來的東西短到失去選源價值，那時寧可硬切。
 */
/**
 * 視窗內最後一個「真的是句末」的標點位置，找不到回 -1。
 *
 * 全形標點無條件算數；ASCII 的 `.`／`!`／`?`／`;` **必須後接空白或視窗結尾**。裸的句點會
 * 把小數點、副檔名與網域當成句末，切出「語法完整但數字是錯的」句子——實測
 * `Revenue grew to 12.5 billion` 切成 `Revenue grew to 12.`、`annual-report-2025.pdf` 切成
 * `annual-report-2025.`、`data.example.com` 切成 `data.`。那比硬切**更難察覺**：硬切看得出
 * 殘缺，`12.` 看起來是一句完整的話，而它說的是假的。
 */
function lastSentenceEnd(window: string): number {
  const pattern = /[。！？；]|[.!?;](?=\s|$)/g;
  let last = -1;
  for (let match = pattern.exec(window); match; match = pattern.exec(window)) last = match.index;
  return last;
}

/** 切在 `limit`，但不把 surrogate pair 劈成兩半（末尾留半個 code unit 是亂碼字）。 */
function sliceWholeChars(text: string, limit: number): string {
  const window = text.slice(0, limit);
  const last = window.charCodeAt(window.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? window.slice(0, -1) : window;
}

export function truncateAtBoundary(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const window = sliceWholeChars(text, limit);
  const floor = Math.floor(limit * 0.4);
  const newline = window.lastIndexOf("\n");
  if (newline >= floor) return window.slice(0, newline).trimEnd();
  const sentence = lastSentenceEnd(window);
  if (sentence >= floor) return window.slice(0, sentence + 1);
  return window.trimEnd();
}

/**
 * 切塊：1200 字步長、1600 字視窗（刻意重疊，句子被切斷時兩塊各留一半仍檢索得到）。
 *
 * `locatorPrefix` 讓非原文的衍生內容（如圖片描述）在 locator 上就看得出出處——引用時
 * 顯示的是這個字串，寫死 `chunk:` 會讓模型衍生的描述看起來跟原文的第幾段沒有兩樣。
 *
 * `textPrefix` 由這裡而不是呼叫端貼上，因為視窗大小必須把它算進去：`source-context.ts`
 * 在送進 prompt 前會 `slice(0, 1600)`，呼叫端自己在事後加前綴的話，每一塊都會超出上限，
 * 被截掉的正好是尾巴那幾個字。
 */
export function chunkSourceText(
  sourceId: string,
  text: string,
  options: { locatorPrefix?: string; textPrefix?: string } = {},
): SourceAsset["chunks"] {
  const locatorPrefix = options.locatorPrefix ?? "chunk";
  const textPrefix = options.textPrefix ?? "";
  const window = SOURCE_CHUNK_CHARS - textPrefix.length;
  const stride = Math.min(SOURCE_CHUNK_STRIDE, window);
  if (window < 1) throw new Error("Chunk text prefix is longer than the chunk window");
  const result: SourceAsset["chunks"] = [];
  for (let start = 0, index = 0; start < text.length; start += stride, index += 1) {
    const value = text.slice(start, start + window).trim();
    if (!value) continue;
    result.push({
      id: createHash("sha256").update(`${sourceId}:${index}:${value}`).digest("hex").slice(0, 24),
      text: `${textPrefix}${value}`,
      locator: `${locatorPrefix}:${index + 1}`,
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
  // 切在合理邊界而不是硬切：截斷點會出現在目錄摘要與最後一塊 chunk 裡。
  const truncated = extractedText.length > MAX_SOURCE_TEXT_CHARS;
  const storedText = truncated
    ? truncateAtBoundary(extractedText, MAX_SOURCE_TEXT_CHARS)
    : extractedText;
  return {
    id,
    name: parsed.name,
    mediaType,
    usage: parsed.usage ?? (SOURCE_IMAGE_TYPES.has(mediaType) ? "visual-reference" : "content"),
    allowModelAccess: parsed.allowModelAccess,
    status: "indexed",
    assetPath,
    sizeBytes: bytes.length,
    extractedText: storedText,
    chunks: chunkSourceText(id, storedText),
    // 截斷不能靜默：使用者看到「這份 PDF 的後半段找不到」時，這個旗標是唯一的解釋。
    metadata: truncated ? { textTruncated: "true", textChars: String(extractedText.length) } : {},
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

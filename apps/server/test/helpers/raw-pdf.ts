/**
 * 手工組原始 PDF 位元組的產生器（測試專用，純 Node，不新增任何相依）。
 *
 * `sources.test.ts` 的慣例是「測試裡現組 PDF bytes、不放二進位 fixture」（見
 * `pdfWithTable()`），這裡沿用同一條線，只是換掉工具：pdf-lib 造不出這兩份 fixture 要
 * 的形狀——它只吃**內嵌**字型（本檔要的是「非內嵌、靠預先定義 CJK CMap 解碼」的 Type0
 * 字型），也沒有暴露字元間距運算子 `Tc`。改放二進位 fixture 則要把一份 CJK 字型（數 MB）
 * 搬進 repo。
 *
 * 兩份 fixture 都**不含任何字型二進位**、各自不到 2 KB：這兩個失效都發生在文字抽取
 * （`getTextContent()`）這一層，只要 pdf.js 解得出 Unicode 就夠，字形畫不畫得出來無關。
 */

/** PDF 物件的內容；stream 物件用 {@link streamObject} 先組好。 */
type PdfObject = string | Uint8Array;

/**
 * 依序把物件寫成 body，補上 xref 表與 trailer；物件編號即為它在陣列裡的位置 + 1。
 *
 * xref 的位移量必須逐位元組正確（pdf.js 讀不到合法的 xref 就會走重建路徑，那條路
 * 對這兩份刻意精簡的 fixture 不保證還原得出同一份物件圖），所以偏移量由實際寫出去的
 * 長度累加而來，不是估的。
 */
function buildPdf(objects: readonly PdfObject[]): Uint8Array {
  const header = Buffer.from("%PDF-1.4\n");
  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let length = header.length;
  for (const [index, body] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      typeof body === "string" ? Buffer.from(body) : Buffer.from(body),
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(chunk);
    length += chunk.length;
  }
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}` +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(parts));
}

/** 未壓縮的 stream 物件（`/Length` 依實際位元組數算，不是字元數）。 */
function streamObject(body: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n`),
      Buffer.from(body),
      Buffer.from("\nendstream"),
    ]),
  );
}

/** 一個字的 UTF-16 碼位，寫成內容流裡的 4 位十六進位字串。 */
function hexCodePoint(char: string): string {
  return (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0");
}

/**
 * fixture 甲：非內嵌 CIDFontType0 ＋ 預先定義的 CJK CMap（`/Encoding /UniCNS-UCS2-H`）。
 *
 * 這正是 Acrobat Distiller 搭配系統中文字型輸出的形狀：字型本身不在檔案裡，字碼要靠
 * pdf.js 隨套件附帶的 cmaps 目錄才解得開。少了 `cMapUrl`／`cMapPacked` 時 pdf.js 的
 * translateFont 直接失敗，這一行中文抽出來是空字串。
 *
 * 第二行刻意放一段 Helvetica 的 ASCII：**這個失效不會拋錯、也不會讓別的文字消失**，
 * 所以測試必須同時釘住「中文回來了」與「英文本來就在」，否則改壞了照樣綠。
 */
export function cjkCMapPdf(): Uint8Array {
  const hex = [..."中文測試"].map(hexCodePoint).join("");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R /F2 8 0 R >> >> /Contents 4 0 R >>",
    streamObject(
      `BT /F1 24 Tf 72 700 Td <${hex}> Tj ET\nBT /F2 12 Tf 72 660 Td (ASCII stays readable) Tj ET\n`,
    ),
    "<< /Type /Font /Subtype /Type0 /BaseFont /MSung-Light /Encoding /UniCNS-UCS2-H " +
      "/DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSung-Light " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (CNS1) /Supplement 4 >> " +
      "/FontDescriptor 7 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /MSung-Light /Flags 4 /FontBBox [0 -200 1000 900] " +
      "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

/** 這份 fixture 裡中文標題的六個字（測試的期望值由它推導，不另外寫死一份）。 */
export const TRACKING_HEADING = "產品發展藍圖";
/**
 * 同一列上三個**各自成欄**的單字中文標籤（投影片上的區域欄位就長這樣）。
 *
 * 它們之間的空白是 `layoutPdfPage` 依幾何切出儲存格之後、由 `rows.join(" ")` 補的分隔符，
 * 不是字距。逐儲存格套用時三個標籤各自是一格、規則看不到那個空白；改成「對整頁組好的
 * 文字套一次」就會把它們併成 `北中南` 這個原文沒有的假詞——這是唯一分得出兩種套用位置的
 * 形狀，少了它，per-cell 與 whole-page 兩種寫法在所有 fixture 上的輸出完全相同。
 */
export const COLUMN_LABELS = "北中南";

/**
 * fixture 乙：加寬字距（`Tc`）的中文標題，共六行、每行釘一件事。
 *
 * 走 `Identity-H` ＋ `ToUnicode` 而**不是**預先定義 CMap，是為了讓這份 fixture 與甲互不
 * 耦合：字距那條規則就算在 cmaps 完全沒設好的環境也該成立，兩個測試同時紅才代表真的有
 * 兩個問題。
 *
 * 字距取 24pt 的 40%（`9.6 Tc`），刻意落在 pdf.js 的 `[0.102em, 0.6em]` 區間內——低於
 * 下界它不會插空白（等於拿沒有加寬字距的中文當測資，改壞了也綠），高於上界它會判成
 * 換欄。各行：①加寬字距的中文標題；②同樣的字、字距 0（對照）；③兩個**多字詞**隔
 * 10pt，那是真的詞界／欄界，空白必須留著；④拉丁字母的加寬字距，不看字元種類的做法會
 * 在這裡把 `S A L E` 併成 `SALE`；⑤一般英文句子，原樣；⑥三個各自成欄的單字標籤，
 * 見 {@link COLUMN_LABELS}。
 */
export function cjkTrackingPdf(): Uint8Array {
  const glyphs = [...TRACKING_HEADING, ...COLUMN_LABELS];
  // 字碼從 1 起跳（0 在 Identity-H 是 .notdef），ToUnicode 再一對一映回真正的 Unicode。
  const code = (index: number) => String(index + 1).padStart(4, "0");
  const toUnicode =
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" +
    "/CMapName /A def /CMapType 2 def\n" +
    "1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
    `${glyphs.length} beginbfchar\n` +
    glyphs.map((char, index) => `<${code(index)}> <${hexCodePoint(char)}>`).join("\n") +
    "\nendbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end";
  const all = [...TRACKING_HEADING].map((_, index) => code(index)).join("");
  const first2 = glyphs
    .slice(0, 2)
    .map((_, index) => code(index))
    .join("");
  const next2 = glyphs
    .slice(2, 4)
    .map((_, index) => code(index + 2))
    .join("");
  // 第三行的第二個詞起點 = 左邊界 + 兩個字寬（DW 1000 → 每字 24pt）+ 10pt 的詞間空隙。
  // 10pt 大於 `lineHeight * 0.25`（插空白）卻小於 `lineHeight * 1.2`（換欄），所以它會
  // 落在同一個儲存格裡、中間帶一個空白——正是規則不該動的那種空白。
  const secondWordX = 72 + 2 * 24 + 10;
  // 三個標籤各隔 100pt，遠大於 `lineHeight * 1.2`（換欄門檻，此頁為 28.8pt），
  // 所以 `layoutPdfPage` 會把它們切成三個儲存格。
  const labelX = (index: number) => 72 + index * 100;
  const content =
    `BT /F1 24 Tf 9.6 Tc 72 700 Td <${all}> Tj ET\n` +
    `BT /F1 24 Tf 0 Tc 72 640 Td <${all}> Tj ET\n` +
    `BT /F1 24 Tf 0 Tc 72 580 Td <${first2}> Tj ET\n` +
    `BT /F1 24 Tf 0 Tc ${secondWordX} 580 Td <${next2}> Tj ET\n` +
    "BT /F2 24 Tf 9.6 Tc 72 520 Td (SALE) Tj ET\n" +
    "BT /F2 12 Tf 0 Tc 72 460 Td (roadmap for product development) Tj ET\n" +
    [...COLUMN_LABELS]
      .map(
        (_, index) =>
          `BT /F1 24 Tf 0 Tc ${labelX(index)} 400 Td ` +
          `<${code([...TRACKING_HEADING].length + index)}> Tj ET\n`,
      )
      .join("");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R /F2 9 0 R >> >> /Contents 4 0 R >>",
    streamObject(content),
    "<< /Type /Font /Subtype /Type0 /BaseFont /Noto /Encoding /Identity-H " +
      "/DescendantFonts [6 0 R] /ToUnicode 8 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Noto " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
      "/FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Identity >>",
    "<< /Type /FontDescriptor /FontName /Noto /Flags 4 /FontBBox [0 -200 1000 900] " +
      "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>",
    streamObject(toUnicode),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

/**
 * fixture 丙的四行內容：門檻邊界與書寫系統邊界，每行都是**單獨一個儲存格**。
 *
 * 前兩個是「恰好三個」與「恰好兩個」單一漢字：`untrackCjk` 的門檻是「連續 ≥3 個 token」，
 * 兩端都得釘住——放寬成 ≥2 會讓 `TWO_CJK` 併成假詞，收緊成 ≥4／≥6 則讓 `THREE_CJK`
 * 不再併，而既有 fixture 的標題有六個字，上述四種改法在它身上**全部都還是綠的**。
 * 後兩個是諺文與平假名：字元類刻意含假名、刻意不含諺文，但整組測資原本沒有半個
 * 非漢字的字，那兩條範圍等於沒有測到。
 */
export const THREE_CJK = "甲乙丙";
export const TWO_CJK = "丁戊";
export const HANGUL_THREE = "가나다";
export const KANA_THREE = "あいう";
/**
 * 端到端搜尋測試要找的詞，**只**以加寬字距的形式出現在這份 fixture 裡。
 *
 * 不能拿 fixture 乙的 {@link TRACKING_HEADING} 來做這件事：那份的第二行是「同樣六個字、
 * 字距 0」的對照組，等於同一個詞在同一份文件裡另外有一份本來就正常的副本，於是
 * `searchSources()` 在**沒有** `untrackCjk` 的情況下照樣命中——測試恆綠、驗不到東西。
 */
export const SEARCH_PHRASE = "營業收入淨額";

/**
 * fixture 丙：五行各自加寬字距（`9.6 Tc`＝24pt 的 40%），每行一個儲存格。
 *
 * 與 fixture 乙同樣走 Identity-H ＋ ToUnicode，但**刻意另開一份**而不是往乙加行：乙的
 * 斷言是依 `lines[0..5]` 的序號寫的，插行會把它們整批推移，等於改寫別人的測試。
 *
 * 字距一律用 `Tc` 而不是自己算座標下 `Td`：pdf.js 的 `getTextContent()` 會因為推進量
 * 超過 `TRACKING_SPACE_FACTOR`（0.102em）**自己**把空白塞進 `item.str`，整行仍是同一個
 * item、同一個儲存格——那正是真實中文標題的失效形狀，也是這條規則唯一該作用的地方。
 */
export function scriptBoundaryPdf(): Uint8Array {
  const glyphs = [...THREE_CJK, ...TWO_CJK, ...HANGUL_THREE, ...KANA_THREE, ...SEARCH_PHRASE];
  const code = (index: number) => String(index + 1).padStart(4, "0");
  const toUnicode =
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" +
    "/CMapName /A def /CMapType 2 def\n" +
    "1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
    `${glyphs.length} beginbfchar\n` +
    glyphs.map((char, index) => `<${code(index)}> <${hexCodePoint(char)}>`).join("\n") +
    "\nendbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end";
  // 各段文字在 glyphs 陣列裡的起點，用來算各自的字碼。
  const runs = [THREE_CJK, TWO_CJK, HANGUL_THREE, KANA_THREE, SEARCH_PHRASE];
  let cursor = 0;
  const content = runs
    .map((run, line) => {
      const hex = [...run].map((_, index) => code(cursor + index)).join("");
      cursor += [...run].length;
      // 每行間隔 60pt，遠大於分列容差（`lineHeight * 0.5` = 12pt）。
      return `BT /F1 24 Tf 9.6 Tc 72 ${700 - line * 60} Td <${hex}> Tj ET\n`;
    })
    .join("");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject(content),
    "<< /Type /Font /Subtype /Type0 /BaseFont /Noto /Encoding /Identity-H " +
      "/DescendantFonts [6 0 R] /ToUnicode 8 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Noto " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
      "/FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Identity >>",
    "<< /Type /FontDescriptor /FontName /Noto /Flags 4 /FontBBox [0 -200 1000 900] " +
      "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>",
    streamObject(toUnicode),
  ]);
}

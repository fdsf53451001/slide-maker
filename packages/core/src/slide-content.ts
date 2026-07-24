/**
 * 把大綱端的 markdown `slide.content` 解析成結構化 blocks，專供影像 prompt 使用。
 *
 * 影像模型會把 `###`、`**`、`|` 當成字面文字畫到投影片上——「別畫出這些符號」這種軟性
 * prompt 指令擋不住不夠聽話的模型。根本解是不要把標記字元送進 prompt：先在這裡解析成
 * 結構（標題層級、條列、步驟、表格、強調詞），模型看不到符號就不可能畫出來。
 *
 * 硬要求：解析器不得吃掉任何可見文字，也絕不 throw。認不出來的一律退回 paragraph 並掛上
 * `unparsed`——內容遺失比留下標記嚴重得多，而那個旗標讓合約有辦法對「殘留的標記」單獨
 * 下令（詮釋它，不要畫它），不必把「可以畫標點」的許可擴大到所有符號。唯一會被丟棄的是
 * 純版面語法（表格分隔列、分隔線、程式碼圍欄），那些本來就不是可見文案。
 *
 * 大綱端仍然輸出 markdown（見 image-contract.ts 的 outlineBrevityInstruction），轉換只
 * 發生在影像 prompt 這一層；編輯器、匯出、text layer 讀到的 content 仍是原始字串。
 */

export interface SlideContentInline {
  /** 作者標記為粗體／斜體的詞。影像端要以字重、色彩、字級呈現，不得補回符號。 */
  emphasis?: string[];
  /**
   * 行內 code 與識別字。刻意與 emphasis 分開存：兩者的視覺處理不同（等寬字或色塊 vs
   * 加粗變色），併成一欄會讓模型把識別字當成一般強調詞加粗。
   */
  code?: string[];
  /**
   * 這個 block 的文字裡仍留著解析器消化不掉的 markup（未收尾的 `**`、孤立的反引號、
   * 跨行的粗體…）。合約據此對它下「把殘留符號當格式詮釋，不要畫出來」的指令；沒有這個
   * 旗標，合約就只能在「一律不准畫符號」與「殘留符號都是標點、可以畫」之間二選一，
   * 前者會吃掉乘號與破折號，後者會讓 `**` 被畫上投影片。
   */
  unparsed?: true;
}

export interface SlideContentHeading extends SlideContentInline {
  type: "heading";
  /** 1–6，對應 `#` 的數量：數字越小層級越高。 */
  level: number;
  text: string;
}

export interface SlideContentParagraph extends SlideContentInline {
  type: "paragraph";
  text: string;
}

export interface SlideContentQuote extends SlideContentInline {
  type: "quote";
  text: string;
}

/** 圍欄程式碼區塊：整段逐字保留（含換行），視覺上走等寬區塊而非一般內文。 */
export interface SlideContentCodeBlock extends SlideContentInline {
  type: "codeBlock";
  text: string;
}

export interface SlideContentList extends SlideContentInline {
  /** `bullets` 為無序清單，`steps` 為有序清單（序號已移除，順序由陣列本身承載）。 */
  type: "bullets" | "steps";
  items: string[];
  /**
   * 與 `items` 等長的巢狀深度（0 為頂層）。全部為 0 時整個欄位省略，讓最常見的平面
   * 清單維持乾淨的 `items: string[]`。
   */
  levels?: number[];
  /**
   * steps 專用：可見編號的起始值，省略時從 1 開始。少了它，`5. 第五步 / 6. 第六步`
   * 這種接續前一頁的清單會被模型重新編成 1./2.，等於改掉投影片上的數字。
   */
  start?: number;
}

export interface SlideContentTable extends SlideContentInline {
  type: "table";
  header: string[];
  rows: string[][];
}

export type SlideContentBlock =
  | SlideContentHeading
  | SlideContentParagraph
  | SlideContentQuote
  | SlideContentCodeBlock
  | SlideContentList
  | SlideContentTable;

const ESCAPABLE = new Set([..."\\`*_{}[]()#+-.!|>~"]);

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

/**
 * `_` 與 `*` 的 intraword 規則刻意只認 ASCII：那條規則存在的理由是 `snake_case_name`、
 * `3*4*5` 不該變成強調，而中文沒有詞間分隔，`，__品質__持平` 兩側必然是漢字，用 `\p{L}`
 * 判斷會讓所有中文的 `__粗體__`、`*斜體*` 都失效。
 */
function isAsciiWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[0-9A-Za-z_]/.test(character);
}

function runLength(input: string, start: number, character: string): number {
  let length = 0;
  while (input[start + length] === character) length += 1;
  return length;
}

/**
 * 夾在兩個 ASCII 文字字元正中間的星號一律當字面字元，不當強調標記。
 *
 * 少了這條，`3*4*5 公尺` 會變成 `345 公尺`、`2**10 和 3**4` 會變成 `210 和 34`——憑空
 * 刪改數字，直接違反合約自己的 FACTUAL GROUNDING。真正的粗體／斜體開頭一定接在行首、
 * 空白、CJK 或標點之後（`**12.4M**`、`毛利率**成長 2.7pp**` 都成立），不會卡在 ASCII 詞中間。
 */
function isInertAsterisk(input: string, index: number, run: number): boolean {
  return isAsciiWordCharacter(input[index - 1]) && isAsciiWordCharacter(input[index + run]);
}

/** 行內 code 的結束圍欄長度必須與開頭完全相同（CommonMark 規則）。 */
function findCodeCloser(input: string, from: number, length: number): number {
  for (let index = from; index < input.length; index += 1) {
    if (input[index] !== "`") continue;
    const run = runLength(input, index, "`");
    if (run === length) return index;
    index += run - 1;
  }
  return -1;
}

/**
 * 找強調標記的收尾。收尾前一個字元不得是空白，`_` 的收尾後一個字元不得是 ASCII 文字
 * 字元，`*` 不得夾在兩個 ASCII 文字字元之間——少了這些 flanking 規則，`2 * 3 * 4` 與
 * `3*4*5` 會被當成強調，讓乘號憑空消失、數字被黏在一起。
 */
function findEmphasisCloser(input: string, from: number, marker: string, length: number): number {
  for (let index = from; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
      continue;
    }
    if (input[index] !== marker) continue;
    const run = runLength(input, index, marker);
    if (run >= length && !isWhitespace(input[index - 1])) {
      const intraword =
        marker === "_"
          ? isAsciiWordCharacter(input[index + run])
          : isInertAsterisk(input, index, run);
      if (!intraword) return index;
    }
    index += run - 1;
  }
  return -1;
}

function matchLink(input: string, start: number): { label: string; end: number } | null {
  if (input[start] !== "[") return null;
  let depth = 0;
  let close = -1;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0 || input[close + 1] !== "(") return null;
  let parens = 0;
  let end = -1;
  for (let index = close + 1; index < input.length; index += 1) {
    const character = input[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") parens += 1;
    else if (character === ")") {
      parens -= 1;
      if (parens === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return null;
  return { label: input.slice(start + 1, close), end: end + 1 };
}

function scanInline(input: string, emphasis: string[], code: string[]): string {
  let output = "";
  let index = 0;
  while (index < input.length) {
    const character = input[index]!;
    if (character === "\\") {
      const next = input[index + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        output += next;
        index += 2;
        continue;
      }
      output += character;
      index += 1;
      continue;
    }
    if (character === "`") {
      const run = runLength(input, index, "`");
      const closer = findCodeCloser(input, index + run, run);
      if (closer >= 0) {
        const inner = input.slice(index + run, closer).trim();
        output += inner;
        if (inner) code.push(inner);
        index = closer + run;
        continue;
      }
      // 沒有收尾的反引號是作者真的想寫的字元，原樣留著而不是吞掉。
      output += "`".repeat(run);
      index += run;
      continue;
    }
    if (
      (character === "!" || character === "[") &&
      input[character === "!" ? index + 1 : index] === "["
    ) {
      const link = matchLink(input, character === "!" ? index + 1 : index);
      if (link) {
        output += scanInline(link.label, emphasis, code);
        index = link.end;
        continue;
      }
    }
    if (character === "*" || character === "_") {
      const run = runLength(input, index, character);
      const markerLength = Math.min(run, 3);
      const intraword =
        character === "_"
          ? isAsciiWordCharacter(input[index - 1])
          : isInertAsterisk(input, index, run);
      const opensCleanly = !isWhitespace(input[index + markerLength]) && !intraword;
      if (opensCleanly) {
        const closer = findEmphasisCloser(input, index + markerLength, character, markerLength);
        if (closer > index + markerLength - 1 && closer > index) {
          const rendered = scanInline(input.slice(index + markerLength, closer), emphasis, code);
          const trimmed = rendered.trim();
          if (trimmed) emphasis.push(trimmed);
          output += rendered;
          index = closer + markerLength;
          continue;
        }
      }
      output += character;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * 去掉行內標記只留文字。給「只可能夾帶行內標記」的短欄位用（purpose、layoutHint、
 * imagePrompt）；會整段夾帶行級 markup 的敘述欄位請用 {@link normalizePlainTextMarkup}。
 */
export function normalizeInlineMarkup(raw: string): string {
  if (!raw) return raw;
  try {
    return scanInline(raw, [], []);
  } catch {
    return raw;
  }
}

/**
 * 走完整的 block 解析再攤平回純文字，供 narrative／dataBasis 這類「不直接畫上去但模型
 * 仍看得到」的敘述欄位使用：它們不需要結構，但 `### 講者重點`、`| A | B |` 這種行級
 * markup 一樣會被模型搬上畫布，只做行內正規化擋不住。
 */
export function normalizePlainTextMarkup(raw: string): string {
  if (!raw || !raw.trim()) return raw;
  try {
    const blocks = parseSlideContentBlocks(raw);
    // 解析後沒有任何 block，代表整段都是純版面語法（分隔列、分隔線）——那本來就不是
    // 可見文字，回空字串而不是把語法原樣送回去。
    if (blocks.length === 0) return "";
    return blocks.map(blockPlainText).join("\n");
  } catch {
    return normalizeInlineMarkup(raw);
  }
}

function blockPlainText(block: SlideContentBlock): string {
  if (block.type === "table")
    // 攤平成純文字時不能用管線接欄位，那正是要移除的字元。
    return [block.header, ...block.rows].map((row) => row.join(" · ")).join("\n");
  // `"items" in block` 而非比對 type：SlideContentList 的 type 本身是聯集，逐一比對
  // 無法讓 TS 把它從剩下的聯集裡排除。
  if ("items" in block) return block.items.join("\n");
  return block.text;
}

/**
 * 短又不含任何字母的強調詞（`**1**`、`**5%**`）一律丟掉。
 *
 * emphasis 是不帶位置的詞表，模型只能靠字串比對回推要加粗哪裡：留下 "1" 會讓同段的
 * `11 項`、`1 天` 全部跟著變粗，等於在畫面上改寫數字的視覺語意。丟掉只損失一次字重。
 */
function isPositionallyUnsafe(value: string): boolean {
  return value.length <= 2 && !/\p{L}/u.test(value);
}

function unique(values: string[], dropUnsafe: boolean): string[] {
  const cleaned = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !(dropUnsafe && isPositionallyUnsafe(value)));
  return [...new Set(cleaned)];
}

/**
 * 解析後仍留在文字裡的標記痕跡。單獨一個 `*` 或 `-` 是普通標點（乘號、破折號），成串的
 * `**`／`__`／反引號／`~~` 則必然是沒收掉的 markup——只有後者需要掛 `unparsed`。
 */
const RESIDUAL_MARKUP = /\*{2,}|_{2,}|`|~{2,}/;

interface InlineCollector {
  take(raw: string): string;
  extras(): SlideContentInline;
}

function createCollector(): InlineCollector {
  const emphasis: string[] = [];
  const code: string[] = [];
  let residual = false;
  return {
    take(raw) {
      const text = scanInline(raw, emphasis, code);
      if (RESIDUAL_MARKUP.test(text)) residual = true;
      return text;
    },
    extras() {
      const uniqueEmphasis = unique(emphasis, true);
      const uniqueCode = unique(code, false);
      return {
        ...(uniqueEmphasis.length ? { emphasis: uniqueEmphasis } : {}),
        ...(uniqueCode.length ? { code: uniqueCode } : {}),
        ...(residual ? { unparsed: true as const } : {}),
      };
    },
  };
}

/**
 * `#*` 吸掉第七個以後的井號、`(?![0-9A-Za-z#])` 讓 `###三大挑戰` 這種無空白 CJK 標題成立，
 * `(?<=#{2})` 讓 `##Q3 目標` 這種無空白且首字為 ASCII 的標題也成立。少了後兩者，貪婪的
 * `#{1,6}` 會回溯成較短的井號串，把多出來的 `#` 推進標題文字裡——層級變錯，而且一個 `#`
 * 字元會被畫上投影片，正好是這支解析器要根除的東西。單一 `#` 仍要求空白或非 ASCII 起頭，
 * 否則 `#1 產品線`、`#hashtag` 這類可見文字會被吃掉一個字元。
 */
const HEADING = /^ {0,3}(#{1,6})#*(?:[ \t]+|(?![0-9A-Za-z#])|(?<=#{2}))(.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
/**
 * 序號上限兩位數：`2025. 年度回顧` 是「年份＋句號」的可見文字，被當成有序清單就會把 2025
 * 整個吃掉。一頁投影片的字數預算只有 300 單位左右，不可能出現第 100 項，所以「三位數以上
 * 不是清單序號」這條界線在真實內容裡沒有代價。
 */
const ORDERED = /^([ \t]*)(\d{1,2})[.)][ \t]+(.*)$/;
/**
 * `>` 後面接數字或 `=` 的不是引用而是比較運算子：`>50%` 當成引用會把 `>` 吃掉，讓「超過
 * 一半」變成「正好一半」——這是改動數字語意，比留下一個標記字元嚴重得多。真正的引用一律
 * 是 `> 文字` 或 `>「文字」`，不會以數字或等號開頭。
 */
const QUOTE = /^ {0,3}>(?![=0-9])[ \t]?(.*)$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function indentWidth(indent: string): number {
  return indent.replace(/\t/g, "    ").length;
}

/** 縮排寬度轉巢狀深度：用堆疊而非固定除法，2 空格與 4 空格縮排都得到同一組深度。 */
function nestingLevels(indents: number[]): number[] {
  const stack: number[] = [];
  return indents.map((indent) => {
    while (stack.length > 0 && indent < stack[stack.length - 1]!) stack.pop();
    if (stack.length === 0 || indent > stack[stack.length - 1]!) stack.push(indent);
    return stack.length - 1;
  });
}

/**
 * 全形管線畫的表格轉成半形再解析。CJK 大綱模型輸出 `｜ 指標 ｜ 值 ｜` 是常見情境，認不出來
 * 就會整段退回段落，管線與分隔列全部被畫上投影片。只在「整行像表格列」時才換，句子裡當標點
 * 用的全形管線不受影響；全形破折號 `－` 一併換掉（分隔列常見），但半形／全形的 em dash 不換
 * ——`—` 是真的會出現在儲存格裡的值。
 */
function normalizeFullWidthTableSyntax(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("｜") || !trimmed.endsWith("｜")) return line;
  return line.replace(/｜/g, "|").replace(/－/g, "-");
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === "\\" && trimmed[index + 1] === "|") {
      // 逃脫的管線是儲存格內容，交給行內解析還原成 `|`。
      current += "\\|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current);
  if (trimmed.startsWith("|")) cells.shift();
  if (cells.length > 0 && trimmed.endsWith("|") && !trimmed.endsWith("\\|")) cells.pop();
  return cells.map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  if (!/^[|\s:-]+$/.test(trimmed)) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * 前後都有管線包住、至少兩欄的一行——就算沒有 `|---|` 分隔列也當表格列。
 *
 * outlineBrevityInstruction 鼓勵模型用 pipe table 卻從沒提過分隔列，所以「缺分隔列的表格」
 * 是必然會出現的輸入；認不出來就會退回段落，管線原封不動被畫上投影片。句中當標點用的管線
 * （`決策樹：A | B | C`）不以管線起訖，不受影響。
 */
function isDelimitedTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  if (isTableSeparator(trimmed)) return false;
  const cells = splitTableRow(trimmed);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

/** 收尾圍欄：整行只有同一種圍欄字元，且不短於開頭的圍欄。 */
function findFenceClose(lines: string[], from: number, marker: string): number {
  const character = marker[0]!;
  for (let index = from; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.length < marker.length) continue;
    if (trimmed.startsWith(character.repeat(marker.length)) && new Set(trimmed).size === 1)
      return index;
  }
  return -1;
}

interface PendingList {
  type: "bullets" | "steps";
  items: string[];
  indents: number[];
  /** 有序清單的原始序號，用來判斷它到底是不是清單，以及可見編號要從幾開始。 */
  numbers: number[];
  /** 原始行（含序號），有序清單被判定為誤判時要原樣退回段落。 */
  raws: string[];
  collector: InlineCollector;
}

export function parseSlideContentBlocks(content: string): SlideContentBlock[] {
  if (typeof content !== "string" || content.trim().length === 0) return [];
  try {
    return parseBlocks(content);
  } catch {
    // 絕不 throw：解析器出乎意料地失敗時，整段原文仍要抵達模型（標記交給 unparsed 說明）。
    return [{ type: "paragraph", text: content, unparsed: true }];
  }
}

function parseBlocks(content: string): SlideContentBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n").map(normalizeFullWidthTableSyntax);
  const blocks: SlideContentBlock[] = [];

  let paragraph: string[] = [];
  let quote: string[] = [];
  // 放在 holder 物件裡而不是裸的 let：清單狀態同時被下面的 flush/append 閉包與主迴圈
  // 讀寫，裸變數會讓 TS 的控制流分析看不到閉包裡的賦值，在迴圈中把它窄化成 never。
  const pending: { list: PendingList | null } = { list: null };

  const pushTextBlock = (type: "paragraph" | "quote", sourceLines: string[]): void => {
    if (sourceLines.length === 0) return;
    const collector = createCollector();
    const text = sourceLines.map((line) => collector.take(line.trim())).join("\n");
    if (text.trim().length > 0) blocks.push({ type, text, ...collector.extras() });
  };

  const flushParagraph = (): void => {
    const lines = paragraph;
    paragraph = [];
    pushTextBlock("paragraph", lines);
  };

  const flushQuote = (): void => {
    const lines = quote;
    quote = [];
    pushTextBlock("quote", lines);
  };

  const flushList = (): void => {
    const current = pending.list;
    pending.list = null;
    if (!current || current.items.length === 0) return;
    const start = current.numbers[0];
    const consecutive =
      start !== undefined && current.numbers.every((value, offset) => value === start + offset);
    if (current.type === "steps" && !consecutive) {
      // 序號不連續就不是一份清單（`7. 甲` 後面接 `3. 乙`）。照 steps 送出去，模型會依
      // 「順序由陣列承載」重新編號成 1./2.，畫面上的數字就被改掉了——原文退回段落最安全。
      pushTextBlock("paragraph", current.raws);
      return;
    }
    const levels = nestingLevels(current.indents);
    blocks.push({
      type: current.type,
      items: current.items,
      ...(levels.some((level) => level > 0) ? { levels } : {}),
      ...(current.type === "steps" && start !== undefined && start !== 1 ? { start } : {}),
      ...current.collector.extras(),
    });
  };

  const flushAll = (): void => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  const appendListItem = (
    type: "bullets" | "steps",
    indent: string,
    raw: string,
    line: string,
    number?: number,
  ): void => {
    flushParagraph();
    flushQuote();
    if (pending.list && pending.list.type !== type) flushList();
    const current = (pending.list ??= {
      type,
      items: [],
      indents: [],
      numbers: [],
      raws: [],
      collector: createCollector(),
    });
    current.items.push(current.collector.take(raw.trim()));
    current.indents.push(indentWidth(indent));
    current.raws.push(line.trim());
    if (number !== undefined) current.numbers.push(number);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const close = findFenceClose(lines, index + 1, marker);
      // 沒有收尾的圍欄不能把整頁剩下的內容全吞成程式碼：這一行照一般文字處理即可。
      if (close >= 0) {
        flushAll();
        const text = lines
          .slice(index + 1, close)
          .join("\n")
          .replace(/\s+$/, "");
        if (text.trim().length > 0) blocks.push({ type: "codeBlock", text });
        index = close;
        continue;
      }
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    // 分隔線是純版面語法，且必須擋在條列規則前面，否則 `- - -` 會被當成一個項目。
    if (THEMATIC_BREAK.test(line)) {
      flushAll();
      continue;
    }

    // 標題／引用／條列一律先判定，再輪到表格：`## 產品 | 定位` 後面接分隔列時，若讓表格
    // 先手，`##` 就會變成表頭第一格的字面文字被畫上投影片。
    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const collector = createCollector();
      const text = collector.take(heading[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim());
      if (text.trim().length > 0)
        blocks.push({
          type: "heading",
          level: heading[1]!.length,
          text,
          ...collector.extras(),
        });
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]!);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      appendListItem("bullets", bullet[1]!, bullet[2]!, line);
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      appendListItem("steps", ordered[1]!, ordered[3]!, line, Number(ordered[2]!));
      continue;
    }

    // 沒被表格吃掉的分隔列（例如表頭那行其實是標題）是純語法，丟掉而不是畫出來。
    if (isTableSeparator(line)) {
      flushAll();
      continue;
    }

    const next = lines[index + 1];
    const headerWithSeparator = line.includes("|") && next !== undefined && isTableSeparator(next);
    if (headerWithSeparator || isDelimitedTableRow(line)) {
      flushAll();
      const collector = createCollector();
      const header = splitTableRow(line).map((cell) => collector.take(cell));
      const rows: string[][] = [];
      index += headerWithSeparator ? 2 : 1;
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (candidate.trim().length === 0 || !candidate.includes("|")) break;
        if (isTableSeparator(candidate)) {
          index += 1;
          continue;
        }
        rows.push(splitTableRow(candidate).map((cell) => collector.take(cell)));
        index += 1;
      }
      index -= 1;
      const width = Math.max(header.length, ...rows.map((row) => row.length), 1);
      const pad = (row: string[]): string[] =>
        Array.from({ length: width }, (_, column) => row[column] ?? "");
      blocks.push({
        type: "table",
        header: pad(header),
        rows: rows.map(pad),
        ...collector.extras(),
      });
      continue;
    }

    const openList = pending.list;
    if (openList && openList.items.length > 0) {
      // markdown 的 lazy continuation：清單項目的折行仍屬於該項目。
      const last = openList.items.length - 1;
      openList.items[last] = `${openList.items[last]!}\n${openList.collector.take(line.trim())}`;
      openList.raws[openList.raws.length - 1] =
        `${openList.raws[openList.raws.length - 1]!}\n${line.trim()}`;
      continue;
    }
    if (quote.length > 0) {
      quote.push(line);
      continue;
    }
    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

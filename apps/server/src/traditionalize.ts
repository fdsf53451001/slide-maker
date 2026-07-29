import { logWarn } from "@slide-maker/core";
import type { EditableTextBox } from "@slide-maker/core";
import * as OpenCC from "opencc-js/core";
import * as Locale from "opencc-js/preset/cn2t";

/**
 * 把 OCR 誤讀出的簡體字轉成繁體。
 *
 * PaddleOCR 的中文模型是簡體語料訓練出來的，讀繁體投影片時會零星吐出簡體字形
 * （`营收`、`驱动`、`成长`）。這些字接著被寫進可編輯文字層、再以系統字型重繪回圖上，
 * 所以不修的話畫面上就會出現簡繁混排。
 *
 * ## 判準：詞級轉換，但只採納「原字元是簡體專屬字」的位置
 *
 * **不可**直接整段套 OpenCC——實測（opencc-js 1.4.1）：
 *
 * - `台積電` → `臺積電`
 * - `台北101` → `臺北101`
 * - `一台機器` → `一臺機器`
 * - `鄰里` → `鄰裡`
 *
 * 抽出來的文字會被重新渲染回投影片圖上，把原本**正確的繁體**改成另一個字形＝畫面上
 * 可見的錯誤，而且使用者難以察覺（字還在、只是變了一個）。所以轉換結果只在「原本那個
 * 字元本來就是簡體專屬字形」的位置採納，其餘一律還原成原字。
 *
 * 詞級（而非逐字）轉換仍是必要的：`头发` → `頭髮`、`长发` → `長髮` 對上 `发展` → `發展`
 * 這種一簡對多繁的消歧，只有帶上下文的詞典命中得了；逐字轉 `发` 只會固定給 `發`。
 *
 * ## 兩條鏈：輸出用完整鏈，閘門只認 STCharacters
 *
 * 這是這個模組最違反直覺、也最容易被「簡化」掉的一點。
 *
 * 產出用的 `outputConverter` 是 `ConverterFactory(from.cn, to.tw)`＝簡→繁（STPhrases ＋
 * STCharacters）再套台灣字形（TWVariants）。**但判斷「這個位置該不該替換」的
 * `gateConverter` 只掛 `from.cn`**，因為 TWVariants 的**左欄全部是繁體字**：
 * `祕 秘`、`喫 吃`、`峯 峰`、`污 汙`、`癡 痴`、`覈 核`、`脣 唇`、`爲 為`、`裏 裡`、`麪 麵`…
 * 共 38 條。閘門若問「完整鏈有沒有改變這個單字」，這 38 個**原本就正確的繁體字**會全部
 * 被判成「可轉」，於是 `污染防治與貪污`→`汙染防治與貪汙`、`祕書處`→`秘書處`、
 * `純喫茶`→`純吃茶`、`王建峯`→`王建峰` 這些字會被默默改掉並重繪回圖上——正是這道閘門
 * 存在的理由。
 *
 * 異體正規化（`裏`→`裡`、`麪`→`麵`、`爲`→`為`、`羣`→`群`）即使看起來像改善，也一律不做：
 * 那不是這道閘門的職責，而同一批裡的 `祕`→`秘`、`喫`→`吃` 是改壞的。行為要可預測。
 */

/**
 * 豁免清單（機械推導）：這些字形在繁體中本來就是合法正字，不可替換（共 172 字）。
 *
 * 來源與判準：取自上游 OpenCC（`BYVoid/OpenCC`）repo 的 `data/dictionary/STCharacters.txt`，
 * 挑出「該簡體字形的繁體候選列表**包含它自己**」的字——例如 `台→臺 檯 颱 台`、
 * `里→裏 里 哩`、`面→面 麪`、`后→後 后`、`干→幹 乾 干 榦`。候選包含自己，代表這個
 * 字形在繁體語境下本身就是一個正字，拿詞級規則去動它就有把對的改成錯的風險。
 *
 * **這份推導在本 repo 內重現不了**：opencc-js 打包時每個 key 只留第一候選，多候選列表
 * 已經被丟掉。要重新產生就得回上游那個檔案，逐行看 `key\tcand1 cand2 …` 裡有沒有 key
 * 自己。
 *
 * 符合此判準的共 203 字，再扣掉 31 個「現代繁體實際不用、只存在於罕見古義或姓氏以外
 * 用法」的字形，讓它們照常轉換：
 * 㐹万价党厂叶吣帘广愿挂据极柜确硷种筑耇胜腊腌膻苹荐虫蚝蜡蝎跖适
 * 剩 172 字。
 *
 * **已知代價**（刻意的取捨）：`干杯`／`后台`／`里程碑`／`面条`／`制造`／`云计算` 這類
 * 「簡體用法、但字形在繁體中合法」的詞不會被修（`面条` 只會變成 `面條`）。漏修只是維持
 * 現狀——那個字本來就是 OCR 讀到的樣子；誤改卻會把**已經正確**的繁體改壞，而且難以
 * 察覺。兩種錯不對等。
 */
const EXEMPT_DERIVED =
  "丑丰了于云亘仆仇仿伙余佛佣俊修借僵克具冢冬准凌几凶出划刮制千升卜占卷厘只台吁吃合吊同后向呆周咨咸咽哄唇喂噪回困坐坯堤夫夸奸姜娘它家尸局岩岳巨布席干幸庵弦彩征御志念恤愈戚扇才扎托扣折抵拐拿挨挽捆捍搜斗斤斫旋昆暗曲札朱朴杆杠杯杰松板果栗核梁棱檗欲沈沾泛注浚涂涌淀游溪漓澄焰熏狸玩琅璇症皂矩私秋穗筱糊系累胄背胡致舍芸苔范蒙蔑藤表谷豆象辟郁酸采里雇雕面";

/**
 * 豁免清單（人工補充）：上面那條機械判準漏掉的三個字。
 *
 * 它們在繁體中同樣是合法正字，只是 STCharacters 的候選列表**不含自己**，機械推導收不到：
 *
 * - `坏`：陶坏／鋼坏／拉坏機（機械判準下會被改成 `陶壞`）。49k 詞語料裡出現 17 次，是
 *   漏網字裡最高頻的。
 * - `么`：老么（會被改成 `老麼`）。
 * - `无`：藉藉无名（會被改成 `無`）。
 *
 * 刻意與 {@link EXEMPT_DERIVED} 分開列：混進去會讓下一個人以為這三個也是自動推出來的，
 * 重跑推導卻生不出它們。
 */
const EXEMPT_MANUAL = "坏么无";

const EXEMPT = new Set(Array.from(`${EXEMPT_DERIVED}${EXEMPT_MANUAL}`));

/**
 * 閘門的顯式白名單：`着`。
 *
 * `着` 只出現在 TWVariants（`着 著`），STCharacters 沒有它，所以收窄後的閘門判它「不可轉」。
 * 但 `着` 在簡體是常用字（穿着、接着、着急），台灣繁體不用這個字形——這是唯一值得從
 * TWVariants 撈回來的一個。
 *
 * **一定要是逐字白名單，不能讓整個 TWVariants 左欄漏過來**：白名單是可稽核的（看一眼就
 * 知道總共放行了哪幾個字），放行整條鏈則等於把 `祕`／`喫`／`峯`／`污` 那 37 個繁體正字
 * 一起放進來改壞。要再加字就往這裡加，並在測試裡補一條。
 */
const GATE_ALLOWLIST = new Set(["着"]);

/**
 * 含有假名的文字框整框跳過。
 *
 * OCR 讀日文投影片時，簡→繁會把新字体漢字改成傳統字形（`国際会議`→`國際會議`），更糟的是
 * 只改到一半的混種字（`体験版のご案内`→`體験版のご案內`、`社会保険`→`社會保険`），比原文
 * 更難讀。假名是零誤判訊號：出現平假名或片假名就一定不是中文投影片，跳過不會影響任何
 * 中文專案。
 *
 * **已知限制**：沒有假名的純漢字日文（`株式会社`、`国際会議`、人名地名）偵測不到，仍然
 * 會被轉。那是無解的歧義——同一串字在中文語境下確實應該轉繁。
 */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * 建 Trie 要吃掉 400KB 字典，每個文字框重建一次是純浪費——整個程序各只建一次。
 *
 * 兩條都用 legacy 的 `ConverterFactory(...dictGroups)` 而不是 `Locale.configs.s2tw`：後者
 * 除了 conversionChain 還帶 normalizationChain 與 segmentation，會在轉換前多做一次與這個
 * 功能無關的 Unicode 正規化；而且閘門那條鏈（只掛 from.cn）本來就不是任何一個具名 config，
 * 兩條必須以同樣的方式組出來才比得起來。
 */
let outputConverter: ((text: string) => string) | undefined;
let gateConverter: ((text: string) => string) | undefined;

/** 產出用的完整鏈：簡→繁（STPhrases＋STCharacters）＋台灣字形（TWVariants）。 */
function getOutputConverter(): (text: string) => string {
  if (!outputConverter) {
    const from = Locale.from.cn;
    const to = Locale.to.tw;
    if (!from || !to) throw new Error("OPENCC_PRESET_MISSING");
    outputConverter = OpenCC.ConverterFactory(from, to);
  }
  return outputConverter;
}

/** 閘門用的窄鏈：**只有** from.cn，不含 TWVariants（理由見模組註解）。 */
function getGateConverter(): (text: string) => string {
  if (!gateConverter) {
    const from = Locale.from.cn;
    if (!from) throw new Error("OPENCC_PRESET_MISSING");
    gateConverter = OpenCC.ConverterFactory(from);
  }
  return gateConverter;
}

/** 單字元判定結果的 memo：一頁投影片裡同一個字會重複出現幾十次。 */
const convertibleCache = new Map<string, boolean>();

/**
 * 這個字元是不是「簡體專屬字」＝值得替換的位置。
 *
 * 對單一字元呼叫**閘門鏈**：單字元輸入只可能命中字元級字典（詞級條目至少兩個字），
 * 所以這裡量到的正是「這個字形本身在簡→繁字典裡有對應」。
 */
function isConvertible(character: string): boolean {
  const cached = convertibleCache.get(character);
  if (cached !== undefined) return cached;
  const result =
    GATE_ALLOWLIST.has(character) ||
    (!EXEMPT.has(character) && getGateConverter()(character) !== character);
  convertibleCache.set(character, result);
  return result;
}

/** 逐字元轉換：只動可轉字元，其餘原樣。長度必然與輸入相同。 */
function convertPerCharacter(characters: readonly string[]): { text: string; changed: number } {
  let changed = 0;
  const convert = getOutputConverter();
  const output = characters.map((character) => {
    if (!isConvertible(character)) return character;
    const replacement = convert(character);
    if (replacement !== character) changed += 1;
    return replacement;
  });
  return { text: output.join(""), changed };
}

/**
 * 把一段文字裡的簡體專屬字轉成繁體。
 *
 * @returns `text` 為轉換後文字，`changed` 為實際被替換掉的字元數（以 code point 計）。
 */
export function traditionalizeText(text: string): { text: string; changed: number } {
  // `Array.from` 而不是 `text.split("")`：以 code point 拆才不會把 surrogate pair
  // （emoji、罕用字）拆成兩個孤兒 unit，逐位置比對時整段位移。
  const characters = Array.from(text);
  // 快路徑：整段沒有任何可轉字元（純繁體、純英數、空字串）就原樣回傳——OCR 抽出來的
  // 多數框都落在這裡。省下的是整串的 trie pass 與結果的 `Array.from`；逐字元的閘門判定
  // 該跑還是會跑（每個還沒 memo 的字元各跑一次單字轉換）。
  if (!characters.some((character) => isConvertible(character))) return { text, changed: 0 };
  const converted = Array.from(getOutputConverter()(text));
  if (converted.length !== characters.length) {
    /*
     * 詞級規則改變了字數（一對多／多對一條目），逐位置比對已經對不上了。
     *
     * 這時退回逐字元轉換：拿不到詞級消歧，但至少「只動簡體專屬字」這條不變量還在。
     * 只記長度數字——OCR 正文一個字都不進 log。
     */
    logWarn("ocr_traditionalize_length_mismatch", {
      inputLength: characters.length,
      convertedLength: converted.length,
    });
    return convertPerCharacter(characters);
  }
  let changed = 0;
  const output = characters.map((character, index) => {
    if (!isConvertible(character)) return character;
    const replacement = converted[index] ?? character;
    if (replacement !== character) changed += 1;
    return replacement;
  });
  return { text: output.join(""), changed };
}

/** 這個文字框是不是日文（含假名）——含假名就整框不轉，見 {@link KANA}。 */
export function containsKana(text: string): boolean {
  return KANA.test(text);
}

/**
 * 對整批 OCR 文字框逐框套用 {@link traditionalizeText}，含假名的框整框跳過。
 *
 * 沒有任何字被改動時回傳原本的框物件（不複製），呼叫端因此可以直接比對參照。
 */
export function traditionalizeBoxes(boxes: readonly EditableTextBox[]): {
  boxes: EditableTextBox[];
  changedBoxes: number;
  changedChars: number;
} {
  let changedBoxes = 0;
  let changedChars = 0;
  const next = boxes.map((box) => {
    if (containsKana(box.text)) return box;
    const { text, changed } = traditionalizeText(box.text);
    if (!changed) return box;
    changedBoxes += 1;
    changedChars += changed;
    return { ...box, text };
  });
  return { boxes: next, changedBoxes, changedChars };
}

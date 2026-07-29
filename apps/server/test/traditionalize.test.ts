import type { EditableTextBox } from "@slide-maker/core";
import * as Locale from "opencc-js/preset/cn2t";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containsKana, traditionalizeBoxes, traditionalizeText } from "../src/traditionalize.js";

/**
 * OCR 抽字的簡→繁轉換。
 *
 * 這一組測試的重心**不在「有沒有轉」而在「有沒有多轉」**：抽出來的文字會被重新渲染回
 * 投影片圖上，把原本正確的繁體改成另一個字形（`台積電`→`臺積電`）是使用者難以察覺的
 * 可見錯誤，比漏轉嚴重得多。所以豁免那一組是主力斷言。
 */

function box(overrides: Partial<EditableTextBox>): EditableTextBox {
  return {
    id: overrides.id ?? "box",
    text: "文字",
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    fontFamily: "Arial",
    fontSize: 30,
    fontWeight: 400,
    color: "#ffffff",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    rotation: 0,
    confidence: 0.9,
    role: "presentation",
    ...overrides,
  };
}

const convert = (text: string) => traditionalizeText(text).text;

describe("traditionalizeText 的轉換", () => {
  it("把簡體專屬字轉成繁體", () => {
    expect(convert("这是简体")).toBe("這是簡體");
    expect(convert("2024年Q3营收成长 15%")).toBe("2024年Q3營收成長 15%");
    expect(convert("开发者体验")).toBe("開發者體驗");
    expect(convert("关键绩效指标")).toBe("關鍵績效指標");
  });

  it("詞級消歧：`头发` 的 `发` 給 `髮` 而不是 `發`", () => {
    // 逐字轉只會固定給 `發`（字元級字典的第一候選）。這正是要整段餵給 converter、
    // 而不是逐字轉的理由。
    expect(convert("头发很长")).toBe("頭髮很長");
    expect(convert("长发及腰")).toBe("長髮及腰");
    // 同一個 `发` 在別的詞裡仍然是 `發`。
    expect(convert("发展")).toBe("發展");
  });

  it("不做詞彙替換（s2tw 而非 s2twp）", () => {
    // 「數據」不得變「資料」、「軟體」不得變「軟件」：只換字形，不換用詞。
    expect(convert("数据分析")).toBe("數據分析");
    expect(convert("软件工程")).toBe("軟件工程");
  });

  it("白名單的 `着` 仍然轉成 `著`（唯一從 TWVariants 撈回來的字）", () => {
    // `着` 只在 TWVariants 裡，收窄後的閘門判它不可轉；靠 GATE_ALLOWLIST 顯式放行。
    // 它在簡體是常用字（穿着、接着、着急），台灣繁體不用這個字形。
    expect(convert("着急")).toBe("著急");
    expect(convert("正在着手")).toBe("正在著手");
    expect(convert("穿着整齐")).toBe("穿著整齊");
    expect(traditionalizeText("着急").changed).toBe(1);
  });

  it("EXEMPT 的人工補充三字：`坏`／`么`／`无` 不動", () => {
    // 這三個在 STCharacters 的候選列表不含自己，機械判準收不到，靠 EXEMPT_MANUAL 補。
    expect(convert("陶坏成型")).toBe("陶坏成型");
    expect(convert("鋼坏")).toBe("鋼坏");
    expect(convert("老么")).toBe("老么");
    expect(convert("藉藉无名")).toBe("藉藉无名");
    expect(traditionalizeText("陶坏").changed).toBe(0);
  });

  it("被 EXEMPT 擋下的位置不採納轉換：`制` 在繁體中本來就合法", () => {
    /*
     * 這一條刻意記錄**已知代價**。完整鏈對 `智能制造` 會給 `智能製造`，但 `制` 的繁體
     * 候選列表包含它自己（`制→製 制`），屬於「這個字形在繁體中本來就是正字」那一類，
     * 所以判準把它擋在替換之外——`制度`／`體制`／`控制` 的 `制` 不會被改成 `製`。
     * 代價是 `制造` 這種簡體用法不會被修：漏修只是維持 OCR 讀到的樣子，誤改卻會把
     * 已經正確的繁體改壞。
     */
    expect(convert("AI 驱动的智能制造")).toBe("AI 驅動的智能制造");
    expect(convert("控制流程")).toBe("控制流程");
    // 同一類的高頻漏修：`云` 在繁體中是「說」（人云亦云），所以 `云计算` 只修得到 `计算`。
    expect(convert("云计算平台")).toBe("云計算平台");
  });
});

/**
 * 閘門只掛 `from.cn`（STPhrases＋STCharacters），**不含 TWVariants**。
 *
 * TWVariants 的左欄全部是繁體正字，閘門若問「完整 s2tw 鏈有沒有改變這個單字」，這一整批
 * 都會被判成可轉，於是 `祕書處`→`秘書處`、`純喫茶`→`純吃茶`、`王建峯`→`王建峰`、
 * `貪污`→`貪汙` 被默默改掉並重繪回投影片圖上。
 *
 * 這一組直接讀字典而不是手挑句子：opencc-js 升版動到 TWVariants 時會紅在這裡，而不是等到
 * 某個使用者的名字被改掉才發現。
 */
describe("TWVariants 左欄（繁體正字）一律不動", () => {
  /** `Locale.to.tw` 裡所有單字元條目的 key。 */
  const twVariantKeys = (): string[] => {
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        for (const entry of node.split("|")) {
          const key = entry.split(" ")[0];
          if (key && Array.from(key).length === 1) keys.add(key);
        }
        return;
      }
      if (Array.isArray(node)) for (const child of node) walk(child);
    };
    walk(Locale.to.tw);
    return [...keys];
  };

  it("字典本身的規模有被釘住（升版動到它就會紅）", () => {
    expect(twVariantKeys()).toHaveLength(38);
  });

  it("每一個 key（`着` 除外）都是恆等變換", () => {
    const moved = twVariantKeys()
      .filter((key) => key !== "着")
      .filter((key) => traditionalizeText(key).changed !== 0);
    // 失敗時直接把被改掉的字列出來，不必回頭猜是哪幾個。
    expect(moved.join("")).toBe("");
  });

  it("實際回報過的誤改案例", () => {
    for (const text of [
      "污染防治與貪污",
      "祕書處",
      "癡呆症",
      "王建峯",
      "純喫茶",
      "覈准",
      "嘴脣",
      "泄漏",
      "因爲",
      "裏面",
      "麪包",
      "羣組",
    ]) {
      const result = traditionalizeText(text);
      expect(result.text).toBe(text);
      expect(result.changed).toBe(0);
    }
  });
});

describe("含假名的文字框整框跳過", () => {
  const textOf = (text: string) => traditionalizeBoxes([box({ text })]).boxes[0]!.text;

  it("平假名／片假名出現就整框不轉", () => {
    // 沒有這道閘門會產生比原文更難讀的半轉換混種字。
    expect(textOf("体験版のご案内")).toBe("体験版のご案内");
    expect(textOf("社会保険の手続き")).toBe("社会保険の手続き");
    expect(textOf("株式会社ソニー")).toBe("株式会社ソニー");
    expect(traditionalizeBoxes([box({ text: "体験版のご案内" })]).changedBoxes).toBe(0);
  });

  it("已知限制：沒有假名的純漢字日文仍然會被轉", () => {
    // 同一串字在中文語境下確實應該轉繁，這是無解的歧義——記錄行為而不是假裝修好了。
    expect(textOf("国際会議")).toBe("國際會議");
    expect(containsKana("国際会議")).toBe(false);
  });

  it("中文投影片不受影響（假名是零誤判訊號）", () => {
    expect(containsKana("2024年Q3营收成长 15%")).toBe(false);
    expect(textOf("2024年Q3营收成长 15%")).toBe("2024年Q3營收成長 15%");
  });
});

describe("traditionalizeText 的豁免（不得誤改）", () => {
  /**
   * 這些字形在繁體中本來就是合法正字，整段套 OpenCC 會把它們改掉：
   * `台積電` → `臺積電`、`台北101` → `臺北101`、`一台機器` → `一臺機器`、`鄰里` → `鄰裡`。
   */
  it.each([
    "台積電",
    "台北101",
    "一台機器",
    "電視台",
    "公里",
    "皇后",
    "表格",
    "山谷",
    "鄰里",
    "表面",
  ])("%s 一字不動", (text) => {
    const result = traditionalizeText(text);
    expect(result.text).toBe(text);
    expect(result.changed).toBe(0);
  });

  it("純繁體輸入是恆等變換", () => {
    for (const text of [
      "線上服務 / 雲端運算",
      "關鍵績效指標",
      "計畫書",
      "第三季營收成長率",
      "裡面 麵包 著急",
    ]) {
      const result = traditionalizeText(text);
      expect(result.text).toBe(text);
      expect(result.changed).toBe(0);
    }
  });

  it("非中文與空白不動", () => {
    for (const text of [
      "",
      "   ",
      "\n\t ",
      "Hello, world! 123 45%",
      "Q3 EBITDA +12.5%",
      "🚀 emoji 😀 混排",
      "—「」（）：；",
    ]) {
      const result = traditionalizeText(text);
      expect(result.text).toBe(text);
      expect(result.changed).toBe(0);
    }
  });

  it("surrogate pair 不會讓逐位置比對整段位移", () => {
    // emoji 是 2 個 UTF-16 unit、1 個 code point。用 `split("")` 拆就會從這裡開始錯位，
    // 後面的簡體字會被還原成前一個字。
    expect(convert("🚀营收🚀成长🚀")).toBe("🚀營收🚀成長🚀");
    expect(convert("𠀀这是简体𠀀")).toBe("𠀀這是簡體𠀀");
  });
});

describe("traditionalizeText 的計數與冪等", () => {
  it("changed 是實際被替換掉的字元數", () => {
    // 这→這、简→簡、体→體，`是` 不動。
    expect(traditionalizeText("这是简体").changed).toBe(3);
    // 营→營、长→長，數字、英文、`年`、`收`、`成` 都不動。
    expect(traditionalizeText("2024年Q3营收成长 15%").changed).toBe(2);
    // 头→頭、发→髮、长→長。
    expect(traditionalizeText("头发很长").changed).toBe(3);
    expect(traditionalizeText("已經是繁體了").changed).toBe(0);
  });

  it("轉兩次與轉一次結果相同", () => {
    for (const text of ["这是简体", "头发很长", "开发者体验", "台積電", "面条", "数据分析"]) {
      const once = traditionalizeText(text);
      const twice = traditionalizeText(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.changed).toBe(0);
    }
  });
});

describe("traditionalizeBoxes", () => {
  it("逐框轉換並累加計數，沒改到的框保留原本的物件參照", () => {
    const untouched = box({ id: "b2", text: "台積電營收" });
    const boxes = [
      box({ id: "b1", text: "这是简体" }),
      untouched,
      box({ id: "b3", text: "头发很长" }),
    ];
    const result = traditionalizeBoxes(boxes);
    expect(result.boxes.map((entry) => entry.text)).toEqual(["這是簡體", "台積電營收", "頭髮很長"]);
    expect(result.changedBoxes).toBe(2);
    expect(result.changedChars).toBe(6);
    // 沒被改到的框原封不動（連參照都一樣）。
    expect(result.boxes[1]).toBe(untouched);
    // 幾何與樣式一律不動。
    expect(result.boxes[0]).toMatchObject({ id: "b1", x: 0, y: 0, width: 100, fontSize: 30 });
  });

  it("空陣列與全繁體輸入都回 0", () => {
    expect(traditionalizeBoxes([])).toEqual({ boxes: [], changedBoxes: 0, changedChars: 0 });
    const clean = [box({ id: "b1", text: "第三季營收" })];
    expect(traditionalizeBoxes(clean)).toMatchObject({ changedBoxes: 0, changedChars: 0 });
  });
});

describe("長度不一致的退路", () => {
  afterEach(() => {
    vi.doUnmock("opencc-js/core");
    vi.resetModules();
  });

  /**
   * 現行 s2tw 字典裡沒有任何一條會改變字數的規則（整份 cn2t 掃過為 0 筆），所以這條分支
   * 在正式字典上不可達——它防的是升級 opencc-js 之後多出一對多條目。用替身把那個情況做
   * 出來：逐位置比對已經對不上，退回逐字元轉換，「只動簡體專屬字」這條不變量必須還在。
   */
  it("詞級規則改變字數時退回逐字元轉換，並只記長度數字", async () => {
    vi.resetModules();
    vi.doMock("opencc-js/core", async () => {
      const actual = await vi.importActual<typeof import("opencc-js/core")>("opencc-js/core");
      return {
        ...actual,
        ConverterFactory: (...args: Parameters<typeof actual.ConverterFactory>) => {
          const inner = actual.ConverterFactory(...args);
          // 只有整段（多字元）輸入才灌水，單字元判定仍走真實字典——那正是這條退路
          // 還能保住不變量的前提。
          return (text: string) => (Array.from(text).length > 1 ? `${inner(text)}※` : inner(text));
        },
      };
    });
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const { traditionalizeText: mocked } = await import("../src/traditionalize.js");

    const result = mocked("这是简体台積電");
    // 逐字元轉：`这`/`简`/`体` 換掉，`台` 仍被豁免擋住，多出來的 `※` 沒有進到結果裡。
    expect(result.text).toBe("這是簡體台積電");
    expect(result.changed).toBe(3);

    const logged = warnings.filter((line) => line.includes("ocr_traditionalize_length_mismatch"));
    expect(logged).toHaveLength(1);
    const payload = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({ inputLength: 7, convertedLength: 8, severity: "WARNING" });
    // 正文一字不進 log。
    expect(logged[0]).not.toContain("这");
    expect(logged[0]).not.toContain("這");
    expect(logged[0]).not.toContain("台積電");
  });
});

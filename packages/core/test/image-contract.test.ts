import { describe, expect, it } from "vitest";
import {
  buildImageGenerationContract,
  DESIGN_SYSTEM_SECTIONS,
  imageGenerationInput,
  informationDensityInstruction,
  outlineBrevityInstruction,
  outlineContentAcceptCeiling,
  outlineContentCharBudget,
  outlineContentLength,
  outlineDataFidelityInstruction,
  outlineDeckOverflowRetryInstruction,
  outlineOverflowRetryInstruction,
  outlineStructureInstruction,
  serializeImageGenerationInput,
  type ImageGenerationRequest,
} from "../src/index.js";

function request(): ImageGenerationRequest {
  return {
    projectId: "project-secret-id",
    slide: {
      id: "slide-1",
      order: 0,
      purpose: "解釋代理式 AI",
      content: "標題、三項證據與結論",
      narrative: "由問題走向解法",
      layoutHint: "左文右圖",
      dataBasis: ["採用率 80%"],
      imagePrompt: "明亮企業攝影",
      sourceIds: ["source-1"],
      pinnedSourceIds: [],
      outlineDirty: false,
      hidden: false,
      versions: [],
    },
    style: {
      schemaVersion: 1,
      id: "style-1",
      version: 1,
      name: "清爽風",
      description: "大量白色留白",
      system: false,
      density: "high",
      imageDirection: "模組化資訊卡",
      avoid: ["深色漸層"],
      promptTemplate: "以 {subject} 為主體",
      designSystem: "",
      referenceImages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    width: 1920,
    height: 1080,
    references: [
      { path: "/trusted/style.png", mediaType: "image/png", role: "style", name: "Style A" },
      {
        path: "/trusted/panel.png",
        mediaType: "image/png",
        role: "direct-asset",
        name: "Source panel",
      },
    ],
    model: "image-model",
    parameters: {},
  };
}

describe("outlineContentLength", () => {
  it("counts CJK as one unit and Latin as half", () => {
    expect(outlineContentLength("一二三四五")).toBe(5);
    expect(outlineContentLength("abcdefghij")).toBe(5);
    expect(outlineContentLength("0123456789")).toBe(5);
  });

  it("ignores whitespace entirely", () => {
    expect(outlineContentLength(" 一 二\n三\t")).toBe(3);
    expect(outlineContentLength("a b\nc d")).toBe(2);
  });

  it("counts full-width punctuation as a full unit", () => {
    expect(outlineContentLength("一、二。")).toBe(4);
  });

  it("stops over-charging technical slides for their English terms", () => {
    // 舊算法把每個字母當一個中文字，扣掉空白仍是 11；實寬 5.5，四捨五入為 6。
    expect(outlineContentLength("Kimi Code CLI")).toBe(6);
    // 第 8 頁實測：舊算法 247（逼近 270 上限），改後落回舒適區。
    const slide8 = `${"中".repeat(118)}${"a".repeat(97)}${"、".repeat(32)}`;
    expect(outlineContentLength(slide8)).toBe(199);
  });
});

describe("outline overflow retry", () => {
  it("tells the model its measured length and how much to cut, not just that it was too long", () => {
    // 只說「太長了」時，三次重試常犯同一個錯，最後以 CONTENT_TOO_LONG 收場。
    // 這是模型唯一拿得到真實長度的地方——首次指令刻意不談硬上限。
    const { soft, hard } = outlineContentCharBudget("high");
    const instruction = outlineOverflowRetryInstruction("high", hard + 42);
    expect(instruction).toContain(String(hard + 42));
    expect(instruction).toContain(`target of roughly ${soft}`);
    expect(instruction).toContain("Cut at least 42 units");
  });

  it("asks the model to trim the previous draft instead of generating a fresh one", () => {
    // 「重寫一次並寫短一點」沒有受詞：模型手上只剩與第一輪相同的輸入，於是三輪落在
    // 同一個長度。指令必須指向呼叫端附上的 previousAttempt，砍的對象才存在。
    const instruction = outlineOverflowRetryInstruction("high", 400);
    expect(instruction).toMatch(/previousAttempt/);
    expect(instruction).toMatch(/Revise that draft instead of starting over/);
    expect(instruction).toMatch(/keep its structure and its decisions about what to cover/);
    expect(instruction).toMatch(/out of that draft/);
    expect(instruction).toMatch(/do not set it aside and write the slide again/);
  });

  it("protects purpose-required source data rather than a particular format", () => {
    const instruction = outlineOverflowRetryInstruction("high", 400);
    expect(instruction).toMatch(/complete source dataset that this slide's page purpose requires/);
    expect(instruction).toMatch(/table, bullets, chart labels, or another structure/);
    expect(instruction).toMatch(/Do not protect or sacrifice content merely because/);
    expect(instruction).toMatch(/partial view/);
  });

  it("never asks for a non-positive cut when the overflow rounds to zero", () => {
    const instruction = outlineOverflowRetryInstruction(
      "high",
      outlineContentCharBudget("high").hard + 0.4,
    );
    expect(instruction).toContain("Cut at least 1 units");
  });

  it("does not restate the counting rules that brevity already owns", () => {
    // 兩處各寫一套計費規則正是先前 whitespace/表格計法不一致的來源。
    const instruction = outlineOverflowRetryInstruction("high", 500);
    expect(instruction).not.toMatch(/counts as 0\.5/);
    expect(instruction).not.toMatch(/full-width units:/);
  });
});

describe("deck outline overflow retry", () => {
  it("points at the complete previous outline, not just the slides that ran over", () => {
    // runStructured 是單次無狀態呼叫：「其餘頁維持上次那樣」若那些頁不在 prompt 裡，
    // 就與「砍掉上次那份稿子」少了受詞是同一個失敗模式。
    const instruction = outlineDeckOverflowRetryInstruction("high");
    expect(instruction).toMatch(/complete outline is supplied as previousAttempt/);
    expect(instruction).toMatch(/one entry per slide/);
    expect(instruction).toMatch(/in the order you returned them/);
    expect(instruction).toMatch(/Reproduce every entry marked "overflow": false exactly as/);
    expect(instruction).toMatch(/Revise only the entries marked "overflow": true/);
  });

  it("makes each slide carry its own numbers instead of baking one into the sentence", () => {
    // 兩頁分別超 +100 與 +5 時，共用一個數字等於要求第二頁砍 100。
    const instruction = outlineDeckOverflowRetryInstruction("high");
    expect(instruction).toMatch(/apply each entry's own cutUnits to that entry only/);
    expect(instruction).toMatch(/never carry one slide's number over to another/);
    expect(instruction).not.toMatch(/Cut at least \d+ units/);
  });

  it("identifies slides by list position, not by an order field the prompt never established", () => {
    // prompt 從未建立過 order 這個欄位的存在與基準（0-based？1-based？），而重試允許回傳
    // 不同頁數——用它指認頁面會指到別頁。順序改由陣列本身承載。
    const instruction = outlineDeckOverflowRetryInstruction("high");
    expect(instruction).toMatch(/listed in the order you returned them/);
    expect(instruction).not.toMatch(/its order|"order"|order field|identified by its/);
  });

  it("states the soft target but never the hard limit", () => {
    const { soft, hard } = outlineContentCharBudget("high");
    const instruction = outlineDeckOverflowRetryInstruction("high");
    expect(instruction).toContain(`target of roughly ${soft}`);
    expect(instruction).not.toContain(String(hard));
  });

  it("carries the structural fields the instruction tells the model to keep", () => {
    const instruction = outlineDeckOverflowRetryInstruction("high");
    expect(instruction).toMatch(/content, narrative, layoutHint, and the sources you cited/);
    expect(instruction).toMatch(/keep its structure, its decisions about what to cover/);
  });
});

describe("outline content accept ceiling", () => {
  it("is a fixed multiple of the hard limit, defined next to the budget", () => {
    // 降級採用完全無上限時，hard 只剩「觸發重試」的作用；實測有一頁 556 單位讀不了。
    for (const density of ["low", "medium", "high"] as const)
      expect(outlineContentAcceptCeiling(density)).toBe(outlineContentCharBudget(density).hard * 2);
  });

  it("stays above the hard limit for every density", () => {
    for (const density of ["low", "medium", "high"] as const)
      expect(outlineContentAcceptCeiling(density)).toBeGreaterThan(
        outlineContentCharBudget(density).hard,
      );
  });
});

describe("density and length instructions", () => {
  // app.ts 的大綱 prompt 把這兩條指令放在相鄰兩行，各自寫字數就會互相打架。
  const densities = ["low", "medium", "high"] as const;

  it("keeps character counts out of the density instruction", () => {
    for (const density of densities)
      expect(informationDensityInstruction(density)).not.toMatch(
        /\d+\s*-\s*\d+\s+Traditional Chinese characters/,
      );
  });

  it("never tells the model that density overrides the character budget", () => {
    // 這句原本寫 "rather than hitting a fixed character or unit count"，等於叫模型
    // 無視字數上限，是 CODEX_OUTLINE_CONTENT_TOO_LONG 反覆發生的主因。
    for (const density of densities) {
      const instruction = informationDensityInstruction(density);
      expect(instruction).not.toMatch(/fixed character/);
      expect(instruction).not.toMatch(/rather than hitting a fixed character or unit count/);
    }
    expect(informationDensityInstruction("high")).toContain("never overrides it");
  });

  it("gives the model only the soft target, never the hard ceiling", () => {
    // 硬上限是伺服器端的驗證門檻。模型無法用這套自訂單位準確心算自己的輸出（重試指令
    // 得回報實測值正是因為如此），告訴它「超過就整頁作廢」只會換來自保式的少寫：
    // 實測 51 頁 high 密度平均僅 185 單位，連軟目標都差 23%。
    for (const density of densities) {
      const { soft, hard } = outlineContentCharBudget(density);
      const brevity = outlineBrevityInstruction(density);
      expect(brevity).toContain(String(soft));
      expect(brevity).not.toContain(String(hard));
      expect(brevity).not.toMatch(/ceiling|must never exceed|rejected/);
      expect(informationDensityInstruction(density)).not.toContain(String(soft));
    }
  });

  it("keeps structure preferences out of the length instruction", () => {
    for (const density of densities) {
      const brevity = outlineBrevityInstruction(density);
      expect(brevity).not.toMatch(/prefer a markdown pipe table/);
      expect(brevity).not.toMatch(/same budget carries far more information/);
      expect(brevity).not.toMatch(/columns and \d+ body rows/);
    }
  });

  it("tells the model not to count precisely, because it cannot", () => {
    // 這套自訂單位模型算不準，硬要它算只會換來自保式的少寫。長度由伺服器測量、
    // 超標時由 outlineOverflowRetryInstruction 帶著實測值要求重寫。
    const brevity = outlineBrevityInstruction("high");
    expect(brevity).toMatch(/do not need to count precisely/);
    expect(brevity).toMatch(/the system measures the result/);
    // 下限方向仍要說：寫太少會讓模型為了填版面而編造內容。
    expect(brevity).toMatch(/too thin/);
    expect(brevity).toMatch(/padding with filler/);
  });
});

describe("outline structure instruction", () => {
  it("treats tables and other structures as neutral choices", () => {
    const instruction = outlineStructureInstruction();
    expect(instruction).toMatch(/all neutral options/);
    expect(instruction).toMatch(/none is preferred or discouraged/);
    expect(instruction).toMatch(/stable rows and columns/);
    expect(instruction).toMatch(/reading across individual cells/);
    expect(instruction).toMatch(/choosing a table on those semantic grounds/);
    expect(instruction).not.toMatch(/prefer a markdown pipe table/);
    expect(instruction).not.toMatch(/table only|only use a table/i);
  });

  it("forbids inventing a schema or values just to complete a pattern", () => {
    const instruction = outlineStructureInstruction();
    expect(instruction).toMatch(/Never invent values, categories, row labels, columns/);
    expect(instruction).toMatch(/layoutHint consistent with the chosen content structure/);
  });

  it("keeps a chosen table readable without imposing a fixed row-column template", () => {
    const instruction = outlineStructureInstruction();
    expect(instruction).toMatch(/projector-legible with concise cell values/);
    expect(instruction).toMatch(/another structure that faithfully preserves/);
    expect(instruction).toMatch(/explicitly label the displayed data as a partial view/);
    expect(instruction).not.toMatch(/\d+\s+columns|\d+\s+body rows/);
  });
});

describe("table syntax is layout, not copy", () => {
  const table = [
    "| 指標 | 導入前 | 導入後 |",
    "| --- | --- | --- |",
    "| 交付時間 | 14 天 | 3 天 |",
  ].join("\n");

  it("charges only for what the cells actually say", () => {
    // 影像合約明文禁止把 | 與 --- 畫到投影片上，它們與空白同性質。
    const cellsOnly = "指標 導入前 導入後 交付時間 14 天 3 天";
    expect(outlineContentLength(table)).toBe(outlineContentLength(cellsOnly));
  });

  it("charges nothing for the skeleton of even a wide table", () => {
    // 骨架照字面計費時，5 欄 6 列要 28 單位——等於 high 密度 soft→hard 的 30 單位
    // 緩衝幾乎全部，模型一改用表格就會撞上 CONTENT_TOO_LONG。
    const cells = Array.from({ length: 6 }, () => ["甲", "乙", "丙", "丁", "戊"]);
    const wide = [
      `| ${["a", "b", "c", "d", "e"].join(" | ")} |`,
      `| ${["---", "---", "---", "---", "---"].join(" | ")} |`,
      ...cells.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
    const withoutSkeleton = ["abcde", ...cells.map((row) => row.join(""))].join(" ");
    expect(outlineContentLength(wide)).toBe(outlineContentLength(withoutSkeleton));
  });

  it("does not let a stray dash or colon erase a whole line of real copy", () => {
    // 分隔列的判斷若太寬鬆，「成本 - 效益」這種正常文案會被整行當成版面語法抹掉。
    // 破折號本身是可見字元，仍照 0.5 計費。
    expect(outlineContentLength("成本 - 效益分析：三個面向")).toBe(12);
    expect(outlineContentLength("結論：導入後三項指標同步改善")).toBe(14);
    expect(outlineContentLength("A|B")).toBe(1);
  });

  it("announces the table exemption so the model can count itself", () => {
    expect(outlineBrevityInstruction("high")).toContain("nor table syntax");
  });
});

describe("shared image-generation contract", () => {
  it("carries the full slide/style contract and labelled reference semantics", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("Information density requirement: HIGH");
    expect(prompt).toContain("slide.content field is the authoritative visible copy");
    expect(prompt).toContain("DIRECT-ASSET FIDELITY CONTRACT");
    expect(prompt).toContain('role=style; name="Style A"');
    expect(prompt).toContain('role=direct-asset; name="Source panel"');
    // 官方 multi-image 慣例：每張圖都要有角色描述與互動說明，不能只給標籤。
    expect(prompt).toContain("Style reference — take its palette");
    expect(prompt).toContain("Direct asset — reproduce this image faithfully");
    expect(prompt).toContain('"layoutHint": "左文右圖"');
    expect(prompt).toContain('"description": "大量白色留白"');
    expect(prompt).toContain('"promptTemplate": "以 {subject} 為主體"');
  });

  it("leaves the contract untouched for styles that were never analyzed", () => {
    const prompt = buildImageGenerationContract(request());
    // designSystem 為空的舊風格必須完全走原本那條路，含 equal-influence 那句。
    expect(prompt).toContain("All STYLE references have equal influence");
    expect(prompt).not.toContain("DESIGN SYSTEM AUTHORITY");
    expect(prompt).not.toContain("PAGE TYPE:");
    expect(prompt).not.toContain("COMPOSITION IS YOURS");
    // 這三句是**舊行為本身**，不是順手保留的措辭：沒有設計系統時參考圖是唯一的視覺語言
    // 來源，沒有東西可以接手構圖。拿掉「composition rhythm」等於讓那些專案連版面節奏都
    // 失去依據，而它們並沒有得到任何補償。
    expect(prompt).toContain(
      "Style reference — take its palette, composition rhythm, typography treatment, spacing, and finish only.",
    );
    expect(prompt).toContain(
      "Match its background language, composition rhythm, whitespace, alignment, component geometry, image treatment, contrast, accent-color distribution, and overall finish while adapting the layout to this slide's content.",
    );
    expect(prompt).toContain(
      "Within visual decisions, style overrides slide.imagePrompt and generic model defaults.",
    );
  });

  it("splits invariants, page-type rules, and texture once a design system exists", () => {
    const input = request();
    input.style.designSystem = "## 色票\n- #F7F5F0 — 內頁畫布底色";
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("DESIGN SYSTEM AUTHORITY");
    // invariant 歸文字：這正是四張參考圖互相矛盾、需要裁決的部分。
    expect(prompt).toContain("INVARIANTS — these are identical on every slide of this deck");
    expect(prompt).toContain("Never average these against a reference image");
    // 質感歸圖：文字載不動的部分不能被文字的沉默抹掉。
    expect(prompt).toContain("Texture properties follow the STYLE references");
    // equal influence 會讓模型把裁決結果重新平均回去，必須消失。
    expect(prompt).not.toContain("All STYLE references have equal influence");
    expect(prompt).toContain('"designSystem": "## 色票');
  });

  it("makes an alternating deck illegal and names the illustration idiom", () => {
    // 使用者實測回報的第二個症狀：「一長串一黑一白」。舊版把「哪個色成為背景」列為
    // variant，等於明文授權逐頁翻背景，而合約這一端一個字都沒有在鎖它。
    const input = request();
    input.style.designSystem = "## 色票\n- #0B1F3A — 底色";
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("If this deck is dark, every slide is dark");
    expect(prompt).toContain("no slide crosses from dark to light or back");
    // 混語彙是同一個病的另一個維度，而且改動前沒有任何一個欄位在管它。
    expect(prompt).toContain("illustration idiom");
  });

  it("authorizes composition instead of only demanding obedience", () => {
    // 舊合約通篇在講服從（grid／margins／alignment 全劃進 designSystem 權威），從來沒有
    // 一句授權「構圖是你的」——一致性寫滿、自由度零授權，卻因缺共用基準而反而不一致。
    const input = request();
    input.style.designSystem = "## 色票\n- #0B1F3A — 底色";
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("COMPOSITION IS YOURS");
    expect(prompt).toContain("it should not look like a copy of the other slides");
    expect(prompt).toContain("has failed this contract, not satisfied it");
    // 破格逃生口：invariant 上單頁沒有票，自由軸上 imagePrompt 說了算。兩句必須都在——
    // 只留一句的話不是鎖不住 invariant、就是使用者永遠沒辦法在某一頁破格。
    expect(prompt).toContain("On the invariants above, a single slide has no vote");
    expect(prompt).toContain(
      "slide.imagePrompt is the author speaking about this specific slide, and it outranks",
    );
    // 同一份 prompt 裡不能既要求照抄參考圖的版面節奏，又把構圖交還給模型。
    expect(prompt).not.toContain("composition rhythm");
    expect(prompt).toContain(
      "Style reference — take its palette, typography treatment, spacing, and finish only.",
    );
  });

  it("never states one quantity on both tracks", () => {
    /*
     * 「一條給選項的規則等於沒有規則」在這份合約裡的具體形狀：同一個量既被寫成 invariant、
     * 又被列進自由軸。已知有三個會踩到——①強調色面積（invariant 的 palette vs 自由軸的
     * accent）②文案佔比（**第一行**的資訊密度指令已經給了 50-65% 這種數字）③間距（invariant
     * 的基準單位 vs 自由軸的留白鬆緊）。三個都要收斂成「額度／單位固定，落點與倍數自由」。
     */
    const input = request();
    input.style.designSystem = "## 色票\n- #0B1F3A — 底色";
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("Allocate about 50-65% of the canvas to readable copy");
    expect(prompt).not.toContain("the ratio of copy to visual");
    expect(prompt).toContain(
      "how the copy and the supporting visual are arranged relative to each other",
    );
    expect(prompt).toContain(
      "how much of the canvas goes to copy is fixed by the information-density requirement",
    );
    expect(prompt).toContain("Three quantities are not yours");
  });

  it("scopes the area budget and margins to content pages, since covers may go full-bleed", () => {
    // 合約自己在下一句就說「a cover may be full-bleed imagery」，骨架選項裡也列著
    // `full-bleed`。不限定的話，這兩條 invariant 三行之後就被同一份 prompt 授權打破。
    const input = request();
    input.style.designSystem = "## 色票\n- #0B1F3A — 底色";
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("roughly how much of a normal content page each colour is allowed");
    expect(prompt).toContain("the outer page margins a normal content page uses");
    expect(prompt).toContain(
      "The colour area budget and the page margins above describe a normal content page.",
    );
    // 但那個差異必須由頁型規則承載，不是單頁自行決定。
    expect(prompt).toContain("it is never a licence for a content page to do the same");
  });

  it("keeps pageType out of the JSON wherever no rule reads it", () => {
    /*
     * `PAGE TYPE` 那條規則是 generate-only 且掛在 designSystem 底下，所以只有那一格會讀
     * `slide.pageType`。少任何一個條件都會讓「沒有 designSystem 時整份合約逐字元相同」只對
     * **規則行**成立——序列化出去的 JSON 仍多一個鍵，而那份 JSON 就是 prompt 的另一半。
     */
    const withSystem = request();
    withSystem.slide.pageType = "cover";
    withSystem.style.designSystem = "## 色票\n- #0B1F3A — 底色";
    expect(buildImageGenerationContract(withSystem)).toContain('"pageType": "cover"');

    const noSystem = request();
    noSystem.slide.pageType = "cover";
    expect(buildImageGenerationContract(noSystem)).not.toContain("pageType");

    for (const edit of [
      { instruction: "Make the accent warmer", baseImageIndex: 0 },
      { instruction: "Remove masked text", baseImageIndex: 0, purpose: "text-removal" as const },
    ]) {
      const editing = request();
      editing.slide.pageType = "cover";
      editing.style.designSystem = "## 色票\n- #0B1F3A — 底色";
      editing.edit = edit;
      expect(buildImageGenerationContract(editing), edit.purpose ?? "edit").not.toContain(
        "pageType",
      );
    }
  });

  it("treats a legacy flat design system as invariant, and arbitrates its tonal register", () => {
    /*
     * 舊專案存的 designSystem 是加入三軌之前排出來的純 markdown，沒有「每頁自由決定」那個
     * 段落。合約若寫成「只有 invariants 段落才算數」，那些設計系統會整份退化成可自由發揮
     * ——而且完全靜默（圖照樣生得出來，只是又回到一黑一白）。
     *
     * 而且**沒有回填路徑**：`shouldResolveStyleDirection()` 只要 designSystem 非空就整條
     * 跳過，使用者不主動重新分析就永遠停在舊格式。這種資料常在色票裡同時寫著一個深色封面
     * 底與一個淺色內頁底（下面的 fixture 就是實測到的那個形狀），於是「If this deck is
     * dark, every slide is dark」在它們身上沒有受詞。所以要多送一條**可決定的**裁決規則
     * ——不可寫成「自己推一個」，單次無狀態呼叫下每一頁會推出不同答案。
     */
    const legacy = request();
    legacy.style.designSystem =
      "## 設計思路\n以留白建立層級\n## 色票\n- #005C6E — 封面頁深藍綠色背景底色\n- #F7F5F0 — 內頁底色";
    const flat = buildImageGenerationContract(legacy);
    expect(flat).toContain("每頁自由決定：鼓勵各頁不同");
    expect(flat).toContain("A design system written without that section is invariant throughout");
    expect(flat).toContain("written in an older format that does not state the tonal register");
    expect(flat).toContain("the deck's register is the one its normal content pages use");
    expect(flat).toContain("Do not pick a register per slide");

    // 三軌格式自己就寫明了登記，這條裁決規則對它是多餘的雜訊。**這一半才是鑑別力所在**：
    // 舊版只斷言了對任何非空 designSystem 都會送的句子，換成三軌系統照樣通過＝沒驗到東西。
    const sectioned = request();
    sectioned.style.designSystem = `## ${DESIGN_SYSTEM_SECTIONS.invariants}\n- 明暗登記：深色（dark）`;
    const modern = buildImageGenerationContract(sectioned);
    expect(modern).not.toContain("written in an older format");
    expect(modern).not.toContain("Do not pick a register per slide");
  });

  it("follows slide.pageType when the outline stated it, and only guesses otherwise", () => {
    const stated = request();
    stated.style.designSystem = "## 頁型規則\n- 封面：主色滿版";
    stated.slide.pageType = "cover";
    const withPageType = buildImageGenerationContract(stated);
    expect(withPageType).toContain("slide.pageType states whether this slide is a cover");
    expect(withPageType).toContain("do not re-derive it from slide.purpose or slide.content");
    expect(withPageType).toContain('"pageType": "cover"');

    // 舊專案的頁面沒有這個欄位：指著一個不存在的欄位只會讓模型無所適從，所以退回舊措辭。
    const legacy = request();
    legacy.style.designSystem = "## 頁型規則\n- 封面：主色滿版";
    const guessed = buildImageGenerationContract(legacy);
    expect(guessed).toContain("decide from slide.purpose and slide.content");
    expect(guessed).not.toContain('"pageType"');
    // 參考圖沒涵蓋的頁型要由系統推導，不能退回通用簡報長相。
    expect(guessed).toContain("derive that page from the rest of the system");
  });

  it("keeps the design system out of edits, which must preserve the current look", () => {
    const input = request();
    input.style.designSystem = "## 色票\n- #F7F5F0 — 內頁畫布底色";
    input.edit = { instruction: "Make the accent colour warmer", baseImageIndex: 0 };
    expect(buildImageGenerationContract(input)).not.toContain("DESIGN SYSTEM AUTHORITY");
  });

  it("forbids fabricated figures and verification claims on generated slides", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("FACTUAL GROUNDING CONTRACT");
    expect(prompt).toContain("must already appear in slide.content");
    expect(prompt).toContain("Never add wording that asserts measurement");
    // 沒有數據時要畫不帶刻度的視覺，而不是編一個看起來合理的數字。
    expect(prompt).toContain("leave axes, ticks, and values unlabelled");
  });

  it("forbids the model from drawing deck chrome the system composites itself", () => {
    // 頁碼由 exporters／編輯器合成；模型再畫一組就會出現兩個頁碼，而且數字還不一樣。
    // 禁令必須無條件成立（沒有參考圖時也在），不能只掛在 references 區塊裡。
    const prompt = buildImageGenerationContract({ ...request(), references: [] });
    expect(prompt).toContain("DECK CHROME IS NOT YOURS TO DRAW");
    expect(prompt).toContain("never render page numbers, slide numbers");
    expect(prompt).toContain("running header or footer");
    expect(prompt).toContain("composited onto the slide by the system after generation");
  });

  it("keeps deck chrome banned on edits too, but not on text removal", () => {
    const edit = request();
    edit.edit = { instruction: "Make the accent colour warmer", baseImageIndex: 0 };
    expect(buildImageGenerationContract(edit)).toContain("DECK CHROME IS NOT YOURS TO DRAW");
    const removal = request();
    removal.edit = {
      instruction: "Remove masked text",
      purpose: "text-removal",
      baseImageIndex: 0,
    };
    // 抹字任務整段共用區塊都不送，這條也一樣——那裡的規則是「什麼都別畫」。
    expect(buildImageGenerationContract(removal)).not.toContain("DECK CHROME IS NOT YOURS TO DRAW");
  });

  it("blocks style references from leaking their own copy, figures, and branding", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("Do not reproduce what those references say");
    expect(prompt).toContain("no chart values");
    expect(prompt).toContain("no footnotes");
    // 這次外洩的具體形態：參考圖的 KPI 數字被當成內容搬到輸出上。
    expect(prompt).toContain("Reproduce the treatment; discard the words and values entirely");
    // gemini 那次自行加上的 "© Moonshot AI" 也屬於這條。
    expect(prompt).toContain("Add no copyright lines");
  });

  it("keeps the grounding contract on edits, which can also repaint figures", () => {
    const input = request();
    input.edit = { instruction: "Make the accent colour warmer", baseImageIndex: 0 };
    expect(buildImageGenerationContract(input)).toContain("FACTUAL GROUNDING CONTRACT");
  });

  it("describes slide.content as typed blocks and how each type reads visually", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("slide.content is a list of typed blocks under slide.content.blocks");
    for (const type of ["heading", "paragraph", "quote", "bullets", "steps", "table"])
      expect(prompt).toContain(type);
    // 有序清單的順序由陣列承載，序號字元已被拿掉，模型不能期待在文字裡看到它們。
    expect(prompt).toMatch(/never by numbering characters in the text/);
    // emphasis／code 是指向既有文字的索引，不是要模型再加一份文案。
    expect(prompt).toContain("A block's emphasis array lists words");
    expect(prompt).toContain("never by drawing marks around them");
    expect(prompt).toContain("A block's code array lists inline code");
    expect(prompt).toMatch(/Neither array is extra copy to add/);
  });

  it("separates a lone punctuation symbol from leftover markup instead of licensing both", () => {
    // 早期版本寫成「殘留在文字裡的符號都是字面標點」，等於授權模型把未收尾的 `**`
    // 畫上投影片；反過來一律禁畫又會吃掉乘號與破折號。兩者必須分開講。
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("never draw the raw #, *, -, backtick, or pipe characters");
    expect(prompt).toMatch(/One symbol standing alone between words/);
    expect(prompt).toMatch(/ordinary punctuation of the copy and stays exactly as written/);
    expect(prompt).toMatch(/A run of two or more such symbols/);
    expect(prompt).toMatch(/leftover markup: read them as formatting and leave them undrawn/);
    // 禁令必須覆蓋所有 untrusted slide 欄位，不只 slide.content。
    expect(prompt).toMatch(/every untrusted slide field, not just slide.content/);
  });

  it("tells the model what an unparsed block means", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("A block marked unparsed: true");
    expect(prompt).toMatch(/treat every markup-looking sequence as formatting to interpret/);
    expect(prompt).toMatch(/draw none of those characters/);
  });

  it("explains steps.start and codeBlock, which change what gets drawn", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toMatch(/when it carries start, its visible numbering begins at that value/);
    expect(prompt).toMatch(/codeBlock \(a verbatim listing/);
  });

  it("softens emphasis into first-occurrence, since the array carries no position", () => {
    // emphasis 只有詞、沒有位置：要求「全部出現處都加粗」會讓 11 裡的 1 也變粗。
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toMatch(/Emphasizing the first occurrence of each listed word is enough/);
    expect(prompt).toMatch(/never emphasize a fragment that merely sits inside a longer word/);
  });

  it("renders table blocks as tables built from header and rows", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("A table block in slide.content is a real table");
    expect(prompt).toContain("header holds the header-row cells and rows holds the body rows");
    expect(prompt).toContain("Render it as a designed table with aligned columns");
    // 表格被壓縮或攤平回條列，等於把大綱好不容易結構化的資訊又丟掉一次。
    expect(prompt).toContain("never flatten the table back into bullets or prose");
    expect(prompt).toMatch(/no pipes or dashed separator row exist to draw/);
  });

  it("makes decoration yield to a table that will not fit, not the other way round", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toMatch(/keep the table and reduce what surrounds it/);
  });

  it("keeps the table contract out of edits, which must preserve the current image", () => {
    const input = request();
    input.edit = { instruction: "Remove masked text", purpose: "text-removal", baseImageIndex: 0 };
    expect(buildImageGenerationContract(input)).not.toContain(
      "A table block in slide.content is a real table",
    );
  });

  it("sets a canvas-relative type floor and forbids shrinking to fit", () => {
    const prompt = buildImageGenerationContract(request());
    // 1080 高 → 標題 59px、內文 28px、最小字 22px。
    expect(prompt).toContain("TYPOGRAPHY FLOOR");
    expect(prompt).toContain("render the headline at 59px or larger");
    expect(prompt).toContain("body copy at 28px or larger");
    expect(prompt).toContain("smaller than 22px");
    expect(prompt).toContain("Never shrink type below the floor");
  });

  it("scales the type floor with the canvas instead of hard-coding 1080p", () => {
    const input = request();
    input.width = 3840;
    input.height = 2160;
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("3840x2160 canvas");
    expect(prompt).toContain("render the headline at 119px or larger");
    expect(prompt).toContain("body copy at 56px or larger");
  });

  it("keeps provider and persistence metadata out of the model input", () => {
    const input = imageGenerationInput(request());
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("project-secret-id");
    expect(serialized).not.toContain("source-1");
    expect(serialized).not.toContain("versions");
    expect(serialized).not.toContain("/trusted/style.png");
  });

  it("uses the text-removal contract without asking the model to repaint content", () => {
    const input = request();
    input.edit = {
      instruction: "Remove masked text",
      baseImageIndex: 0,
      maskImageIndex: 1,
      purpose: "text-removal",
    };
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("TEXT REMOVAL CONTRACT");
    expect(prompt).toContain("Do not re-render text from slide.content");
    expect(prompt).not.toContain("Information density requirement");
    expect(prompt).not.toContain("slide.content field is the authoritative visible copy");
    // 文字移除不渲染任何字，接地合約在此無意義且會與「不要重畫文字」相衝。
    expect(prompt).not.toContain("FACTUAL GROUNDING CONTRACT");
  });
});

describe("markdown 標記不得進入影像 prompt", () => {
  const markdown = [
    "### 導入成果",
    "",
    "**交付時間**下降 79%，整體成本 -18%。",
    "",
    "- 前置作業 *自動化*",
    "- 佈署改用 `pnpm deploy`",
    "",
    "| 指標 | 導入前 | 導入後 |",
    "| --- | --- | --- |",
    "| 交付時間 | 14 天 | 3 天 |",
  ].join("\n");

  function withMarkdown(): ImageGenerationRequest {
    const input = request();
    input.slide.content = markdown;
    return input;
  }

  function slideOf(input: ImageGenerationRequest): Record<string, unknown> {
    return (imageGenerationInput(input) as { slide: Record<string, unknown> }).slide;
  }

  it("送出的是結構化 blocks，序列化後看不到任何標記字元", () => {
    // 根因：Gemini 影像模型會把 ### 與 ** 當字面文字畫上投影片，prompt 指令擋不住。
    // 標記字元不進 prompt，模型就不可能畫出來。
    const serialized = serializeImageGenerationInput(withMarkdown());
    expect(serialized).not.toContain("###");
    expect(serialized).not.toContain("**");
    const content = JSON.stringify(slideOf(withMarkdown()).content);
    for (const marker of ["#", "*", "`", "|"]) expect(content).not.toContain(marker);
  });

  it("不附上原始 markdown 字串——附了就等於把標記又送回去", () => {
    const content = slideOf(withMarkdown()).content;
    expect(content).toEqual({ blocks: expect.any(Array) });
  });

  it("解析不吃掉任何可見文字", () => {
    const serialized = serializeImageGenerationInput(withMarkdown());
    for (const fragment of [
      "導入成果",
      "交付時間",
      "79%",
      "-18%",
      "前置作業",
      "自動化",
      "pnpm deploy",
      "導入前",
      "導入後",
      "14 天",
      "3 天",
    ])
      expect(serialized).toContain(fragment);
  });

  it("表格成為 header/rows 陣列，強調詞另外列出", () => {
    const blocks = (slideOf(withMarkdown()).content as { blocks: unknown[] }).blocks;
    expect(blocks).toEqual([
      { type: "heading", level: 3, text: "導入成果" },
      {
        type: "paragraph",
        text: "交付時間下降 79%，整體成本 -18%。",
        emphasis: ["交付時間"],
      },
      {
        type: "bullets",
        items: ["前置作業 自動化", "佈署改用 pnpm deploy"],
        emphasis: ["自動化"],
        code: ["pnpm deploy"],
      },
      {
        type: "table",
        header: ["指標", "導入前", "導入後"],
        rows: [["交付時間", "14 天", "3 天"]],
      },
    ]);
  });

  it("narrative 與 dataBasis 只去標記、型別不變", () => {
    // 這兩欄不直接畫上投影片，但模型仍會把裡面的強調字搬上畫布。
    const input = request();
    input.slide.narrative = "重點是**成本**與 `latency` 的取捨";
    input.slide.dataBasis = ["**採用率** 80%", "延遲 *下降* 一半"];
    const slide = slideOf(input);
    expect(slide.narrative).toBe("重點是成本與 latency 的取捨");
    expect(slide.dataBasis).toEqual(["採用率 80%", "延遲 下降 一半"]);
  });

  it("narrative 與 dataBasis 的行級 markup 也不進 prompt", () => {
    // 只做行內正規化時，`### 講者重點`、`| A | B |` 會原樣抵達模型並被搬上畫布。
    const input = request();
    input.slide.narrative = "### 講者重點\n- 先講成本\n- 再講交期";
    input.slide.dataBasis = ["| 指標 | 值 |", "| --- | --- |", "1. 來源 A"];
    const slide = slideOf(input);
    for (const value of [slide.narrative as string, ...(slide.dataBasis as string[])])
      for (const marker of ["#", "|", "- "]) expect(value).not.toContain(marker);
    expect(slide.narrative).toContain("講者重點");
    expect(slide.narrative).toContain("先講成本");
    expect((slide.dataBasis as string[]).join(" ")).toContain("來源 A");
  });

  it("purpose、layoutHint、imagePrompt 的行內標記一併剝掉", () => {
    const input = request();
    input.slide.purpose = "解釋 **代理式 AI**";
    input.slide.layoutHint = "左文右圖，*圖佔六成*";
    input.slide.imagePrompt = "明亮 `企業` 攝影";
    const slide = slideOf(input);
    expect(slide.purpose).toBe("解釋 代理式 AI");
    expect(slide.layoutHint).toBe("左文右圖，圖佔六成");
    expect(slide.imagePrompt).toBe("明亮 企業 攝影");
  });

  it("空 content 送出空陣列而不是空字串", () => {
    const input = request();
    input.slide.content = "";
    expect(slideOf(input).content).toEqual({ blocks: [] });
  });
});

/**
 * 端對端：影像 provider 真正送出去的字串就是 serializeImageGenerationInput() 的輸出，
 * 所以這裡直接對那個字串把關，而不是只看 blocks 結構。
 */
describe("序列化後的影像輸入不得帶著 markdown 語法", () => {
  const realisticOutline = [
    "### 導入成果 **摘要**",
    "",
    "**交付時間**下降 79%，整體成本 -18%；QA 佔比 2/5。",
    "",
    "- 前置作業 *自動化*（含 `pnpm check`）",
    "  - CI 佈署改用 blue/green，the **critical path** shrank to 3 days",
    "",
    "1. 盤點現況",
    "2) 導入工具",
    "",
    "| 指標 | 2023 | 2024 | 2025E | 年複合成長 |",
    "| --- | ---: | :---: | ---: | --- |",
    "| 營收（億元） | 12.4 | 18.9 | 27.5 | +49% |",
    "| 毛利率 | 38.2% | 41.0% | 43.5% | +2.7pp |",
    "| 客戶數 | 120 | 210 | 350 | +71% |",
    "| NPS | 32 | 41 | 48 | — |",
    "| 流失率 | 8.1% | 6.4% | 4.9% | -1.6pp |",
    "| 人均產值 | 210 萬 | 265 萬 | 320 萬 | +23% |",
  ].join("\n");

  function outlineInput(): ImageGenerationRequest {
    const input = request();
    input.slide.content = realisticOutline;
    input.slide.narrative = "重點是**成本**與 `latency` 的取捨";
    input.slide.dataBasis = ["**採用率** 80%", "來源：`ops-dashboard`"];
    return input;
  }

  function contentJson(input: ImageGenerationRequest): string {
    const slide = (imageGenerationInput(input) as { slide: { content: unknown } }).slide;
    return JSON.stringify(slide.content);
  }

  it("content 區段一個標記字元都不剩", () => {
    const content = contentJson(outlineInput());
    for (const marker of ["#", "*", "`", "|", "_"]) expect(content).not.toContain(marker);
    // 表格語法整列都不該出現，包含對齊冒號那一版。
    expect(content).not.toContain("---");
    expect(content).not.toContain(":---:");
  });

  it("整份序列化字串看不到 ###、** 與 pipe 表格語法", () => {
    const serialized = serializeImageGenerationInput(outlineInput());
    for (const marker of ["###", "**", "| ---", "---:", "```"])
      expect(serialized).not.toContain(marker);
  });

  it("每一段可見文字都還在序列化結果裡", () => {
    const serialized = serializeImageGenerationInput(outlineInput());
    for (const fragment of [
      "導入成果",
      "摘要",
      "交付時間",
      "79%",
      "-18%",
      "QA 佔比 2/5",
      "前置作業",
      "自動化",
      "pnpm check",
      "blue/green",
      "critical path",
      "盤點現況",
      "導入工具",
      "指標",
      "2025E",
      "年複合成長",
      "營收（億元）",
      "27.5",
      "+49%",
      "+2.7pp",
      "-1.6pp",
      "人均產值",
      "320 萬",
      "採用率",
      "latency",
      "ops-dashboard",
    ])
      expect(serialized).toContain(fragment);
  });

  it("五欄六列的表格原封不動送到 blocks，沒有被壓縮或攤平", () => {
    const blocks = (
      imageGenerationInput(outlineInput()) as { slide: { content: { blocks: unknown[] } } }
    ).slide.content.blocks;
    const table = blocks.find(
      (block): block is { type: "table"; header: string[]; rows: string[][] } =>
        (block as { type: string }).type === "table",
    );
    expect(table?.header).toHaveLength(5);
    expect(table?.rows).toHaveLength(6);
    expect(table?.rows.every((row) => row.length === 5)).toBe(true);
    expect(table?.rows[5]).toEqual(["人均產值", "210 萬", "265 萬", "320 萬", "+23%"]);
  });

  it("原文的字面星號與管線句子照樣送達，不被誤判成語法", () => {
    const input = request();
    input.slide.content = "成本 2 * 3 * 4 = 24；決策樹 A | B | C 三選一。";
    const serialized = serializeImageGenerationInput(input);
    expect(serialized).toContain("成本 2 * 3 * 4 = 24；決策樹 A | B | C 三選一。");
  });
});

describe("頁面目的需要完整資料時，完整性優先於自己的歸納", () => {
  const densities = ["low", "medium", "high"] as const;

  it("只在本頁目的需要完整資料集時，空間不足先砍評論", () => {
    // 實測一頁複盤：來源給了七場戰績，產出只留四列，省下的額度拿去寫診斷與行動建議，
    // 而砍掉的三場全是敗仗。模型的預設偏好是「洞察優於原始資料」，得明確反轉過來。
    const instruction = outlineDataFidelityInstruction();
    expect(instruction).toMatch(/page purpose specifically requires/);
    expect(instruction).toMatch(/presenting that required data in full outranks/);
    expect(instruction).toMatch(/cut your own commentary before dropping a required data item/);
    expect(instruction).toMatch(/never quietly present a filtered subset/);
    expect(instruction).toMatch(/Do not force a complete dataset onto a slide/);
  });

  it("要求保留實際數值而不是改寫成趨勢描述", () => {
    // 「延遲明顯上升」讀者無從查證，「2ms → 1479ms → 14,363ms」才可以。
    expect(outlineDataFidelityInstruction()).toMatch(/Keep required actual figures/);
  });

  it("不重述長度規則與表格渲染要求，避免兩處指令打架", () => {
    // 這個 codebase 有過同一份 prompt 裡兩條指令互相矛盾的紀錄（916f47）。
    const instruction = outlineDataFidelityInstruction();
    expect(instruction).not.toMatch(/full-width units|counts as 0\.5/);
    expect(instruction).not.toMatch(/pipe table|columns and \d+ body rows/);
    for (const density of densities)
      expect(instruction).not.toContain(String(outlineContentCharBudget(density).soft));
  });
});

import { describe, expect, it } from "vitest";
import {
  buildImageGenerationContract,
  imageGenerationInput,
  informationDensityInstruction,
  outlineBrevityInstruction,
  outlineContentCharBudget,
  outlineContentLength,
  outlineOverflowRetryInstruction,
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
  it("tells the model how far over it went, not just the ceiling", () => {
    // 只說「不可超過 270」時，三次重試常犯同一個錯，最後以 CONTENT_TOO_LONG 收場。
    const instruction = outlineOverflowRetryInstruction("high", 312);
    expect(instruction).toContain("312");
    expect(instruction).toContain("42 over the 270 ceiling");
    expect(instruction).toContain("Cut at least 42 units");
  });

  it("never asks for a non-positive cut when the overflow rounds to zero", () => {
    const instruction = outlineOverflowRetryInstruction("high", 270.4);
    expect(instruction).toContain("Cut at least 1 units");
  });

  it("does not restate the counting rules that brevity already owns", () => {
    // 兩處各寫一套計費規則正是先前 whitespace/表格計法不一致的來源。
    const instruction = outlineOverflowRetryInstruction("high", 300);
    expect(instruction).not.toMatch(/counts as 0\.5/);
    expect(instruction).toContain("exactly as defined above");
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

  it("states the character budget in exactly one place", () => {
    for (const density of densities) {
      const { soft, hard } = outlineContentCharBudget(density);
      const brevity = outlineBrevityInstruction(density);
      expect(brevity).toContain(String(soft));
      expect(brevity).toContain(String(hard));
      expect(informationDensityInstruction(density)).not.toContain(String(soft));
    }
  });

  // 實測 63 頁既有大綱：0 頁使用表格，high 密度平均僅寫到 182/270 單位。
  // 原因是結構選單只列了標題／要點／句子／段落，模型沒有表格這個選項可選。
  it("offers a table as a structural option for the content field", () => {
    for (const density of densities) {
      const brevity = outlineBrevityInstruction(density);
      expect(brevity).toMatch(/markdown table/);
      // 比較／前後對照／多指標的頁面應優先用表格，否則同樣字數承載的資訊會少得多。
      expect(brevity).toMatch(/prefer a markdown pipe table/);
    }
  });

  // 建議的表格尺寸若放不進該密度的字數預算，就是一條註定被硬上限打回的矛盾指令。
  it("suggests a table size that actually fits the density's budget", () => {
    const tableWidth = (columns: number, rows: number) => {
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      const text = [
        line(Array.from({ length: columns }, (_, i) => `指標名${i}`)),
        line(Array.from({ length: columns }, () => "---")),
        ...Array.from({ length: rows }, () =>
          line(Array.from({ length: columns }, () => "項目值")),
        ),
      ].join("\n");
      return outlineContentLength(text);
    };
    // low 密度不能沿用 5×6：即使骨架免計費仍要 108 單位，硬上限只有 115，
    // 塞完表格就沒有空間放標題與結論了。
    expect(tableWidth(5, 6)).toBeGreaterThan(outlineContentCharBudget("low").hard - 30);
    const suggested = { low: [4, 3], medium: [5, 6], high: [5, 6] } as const;
    for (const density of densities) {
      const [columns, rows] = suggested[density];
      expect(outlineBrevityInstruction(density)).toContain(
        `about ${columns} columns and ${rows} body rows`,
      );
      // 留 30 單位給標題與結論，表格仍須放得下。
      expect(tableWidth(columns, rows)).toBeLessThanOrEqual(
        outlineContentCharBudget(density).hard - 30,
      );
    }
  });

  it("gives the soft target direction without pushing the model into the ceiling", () => {
    // 措辭太弱模型只寫到 182/270；太強又會頂到 270 被 CONTENT_TOO_LONG 打回。
    // 兩邊都要說：寫太少是問題，但拿不準時要靠向 soft 而非 hard。
    const brevity = outlineBrevityInstruction("high");
    expect(brevity).toMatch(/too thin/);
    expect(brevity).toMatch(/land nearer 240 than 270/);
    expect(brevity).toContain("hard ceiling");
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
  });

  it("splits structural and texture authority once a design system exists", () => {
    const input = request();
    input.style.designSystem = "## 色票\n- #F7F5F0 — 內頁畫布底色";
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("DESIGN SYSTEM AUTHORITY");
    // 結構屬性歸文字：這正是四張參考圖互相矛盾、需要裁決的部分。
    expect(prompt).toContain("Structural properties follow style.designSystem");
    expect(prompt).toContain("Never average these against a reference image");
    // 質感歸圖：文字載不動的部分不能被文字的沉默抹掉。
    expect(prompt).toContain("Texture properties follow the STYLE references");
    // equal influence 會讓模型把裁決結果重新平均回去，必須消失。
    expect(prompt).not.toContain("All STYLE references have equal influence");
    expect(prompt).toContain('"designSystem": "## 色票');
  });

  it("makes the model resolve page type itself, since no field carries it", () => {
    const input = request();
    input.style.designSystem = "## 頁型規則\n- 封面：主色滿版";
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("decide from slide.purpose and slide.content");
    // 參考圖沒涵蓋的頁型要由系統推導，不能退回通用簡報長相。
    expect(prompt).toContain("derive that page from the rest of the system");
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

  it("renders pipe tables as tables instead of drawing their syntax", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("pipe tables");
    expect(prompt).toContain("never draw the raw #, *, -, backtick, or pipe characters");
    expect(prompt).toContain("render it as a designed table with aligned columns");
    // 表格被壓縮或攤平回條列，等於把大綱好不容易結構化的資訊又丟掉一次。
    expect(prompt).toContain("never flatten the table back into bullets or prose");
    expect(prompt).toMatch(/separator row of dashes is layout syntax/);
  });

  it("makes decoration yield to a table that will not fit, not the other way round", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toMatch(/keep the table and reduce what surrounds it/);
  });

  it("keeps the table contract out of edits, which must preserve the current image", () => {
    const input = request();
    input.edit = { instruction: "Remove masked text", purpose: "text-removal", baseImageIndex: 0 };
    expect(buildImageGenerationContract(input)).not.toContain("pipe tables");
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

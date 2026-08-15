import { describe, expect, it } from "vitest";
import { buildImageGenerationContract, type ImageGenerationRequest } from "../src/index.js";

const BAN = "DECK CHROME IS NOT YOURS TO DRAW";

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    projectId: "project-1",
    slide: {
      id: "slide-1",
      order: 3,
      purpose: "解釋代理式 AI",
      content: "標題、三項證據與結論",
      narrative: "由問題走向解法",
      layoutHint: "左文右圖",
      dataBasis: ["採用率 80%"],
      imagePrompt: "明亮企業攝影",
      sourceIds: [],
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
    references: [],
    model: "image-model",
    parameters: {},
    ...overrides,
  };
}

describe("頁碼是系統合成物，模型不得自己畫", () => {
  it("在每一種非抹字的通道組合下都存在，且只出現一次", () => {
    // 三條圖片通道共用這份合約，只要有一種組合漏掉禁令，那條通道就會畫出第二個頁碼。
    const cases: Record<string, ImageGenerationRequest> = {
      "全新生成、無參考圖": request(),
      "全新生成、有風格參考圖": request({
        references: [
          { path: "/trusted/style.png", mediaType: "image/png", role: "style", name: "Style A" },
        ],
      }),
      "全新生成、有 design system": request({
        style: { ...request().style, designSystem: "背景一律純白，標題 96px" },
      }),
      "一般 edit（無遮罩）": request({
        edit: { instruction: "把主色調換暖一點", baseImageIndex: 0 },
      }),
      "一般 edit（有遮罩）": request({
        edit: { instruction: "只改右側面板", baseImageIndex: 0, maskImageIndex: 1 },
      }),
    };
    for (const [name, input] of Object.entries(cases)) {
      const prompt = buildImageGenerationContract(input);
      expect(prompt, name).toContain(BAN);
      expect(prompt.split(BAN).length - 1, `${name} 只該出現一次`).toBe(1);
    }
  });

  it("禁令涵蓋頁碼、頁首頁尾、日期與版權行四類 deck chrome", () => {
    const line = buildImageGenerationContract(request())
      .split("\n")
      .find((candidate) => candidate.includes(BAN))!;
    expect(line).toContain("page numbers");
    expect(line).toContain("slide numbers");
    expect(line).toContain("running header or footer");
    expect(line).toContain("date");
    expect(line).toContain("copyright line");
    // 說明「為什麼」而不只是「不准」：模型照著理由推廣到沒列舉到的 chrome 上。
    expect(line).toContain("composited onto the slide by the system after generation");
  });

  it("抹字任務不送這條——那裡的規則是什麼都別畫", () => {
    for (const maskImageIndex of [undefined, 1]) {
      const removal = request({
        edit: {
          instruction: "Remove masked text",
          purpose: "text-removal",
          baseImageIndex: 0,
          ...(maskImageIndex === undefined ? {} : { maskImageIndex }),
        },
      });
      const prompt = buildImageGenerationContract(removal);
      expect(prompt).not.toContain(BAN);
      // 抹字合約本身仍要求不得新增任何文字，頁碼因此一樣不會被畫回來。
      expect(prompt).toContain("Do not add new text, logos, or decorations anywhere on the slide.");
    }
  });

  it("凌駕 style contract：designSystem 寫了頁碼也不算繪製指示", () => {
    // 實證（本機風格「玉山ithome」）：AI 風格分析把來源 deck 的頁碼當成設計規格寫進四個
    // 欄位，而 designSystem 在同一份合約裡被宣告為 authoritative，權威高於上面那條禁令，
    // 模型於是照畫——本專案的頁碼是事後合成的，畫面上因此出現第二個。
    const prompt = buildImageGenerationContract(
      request({
        style: {
          ...request().style,
          designSystem: [
            "## 色票",
            "- #666666 — 頁尾註解說明文字、頁碼、次要數據時間區間標示",
            "## 字型",
            "頁尾備註與頁碼為 10pt-12pt Regular",
            "## 版面系統",
            "左下放註解，右下放頁碼",
            "## 頁型規則",
            "- 內頁：頁底有邊緣藍綠色線條、頁碼與備註說明",
          ].join("\n"),
        },
      }),
    );
    const override = prompt
      .split("\n")
      .find((line) => line.includes("This rule outranks the style contract"));
    expect(override, "缺了這句，designSystem 的權威會壓過頁碼禁令").toBeDefined();
    // 兩個來源都要點名：只擋 designSystem 的話，風格參考圖上看得到的頁碼仍會被照抄。
    expect(override).toContain("style.designSystem");
    expect(override).toContain("STYLE reference image");
    // 「不要畫」不等於「這一段別聽」：designSystem 其餘部分仍是權威，而 chrome 佔用的
    // 邊距是真實的版面幾何，砍掉它會讓內頁整個長歪。
    expect(override).toContain("Follow the rest of that system");
    expect(override).toContain("reserved edge space");
    // 標題仍只出現一次（新句子是同一條規則的後續行，不是第二條同名規則）。
    expect(prompt.split(BAN).length - 1).toBe(1);
  });

  it("禁令是無條件的，不依附在參考圖區塊上", () => {
    // 參考圖區塊裡另有一條「Add no ... page numbers ... of your own」，但它只在有參考圖
    // 時才送，而且只在 edit 之外。沒有參考圖的新生成必須仍有獨立的禁令。
    const bare = buildImageGenerationContract(request({ references: [] }));
    expect(bare).not.toContain("Attached images are reference inputs");
    expect(bare).toContain(BAN);
  });
});

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

  it("禁令是無條件的，不依附在參考圖區塊上", () => {
    // 參考圖區塊裡另有一條「Add no ... page numbers ... of your own」，但它只在有參考圖
    // 時才送，而且只在 edit 之外。沒有參考圖的新生成必須仍有獨立的禁令。
    const bare = buildImageGenerationContract(request({ references: [] }));
    expect(bare).not.toContain("Attached images are reference inputs");
    expect(bare).toContain(BAN);
  });
});

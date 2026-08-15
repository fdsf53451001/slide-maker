import { describe, expect, it } from "vitest";
import {
  buildImageGenerationContract,
  type ContractMode,
  type ImageGenerationRequest,
} from "../src/index.js";

/**
 * 「上一頁當作框架範本」的合約措辭。
 *
 * 每頁都是單次無狀態生成，同一份簡報已生成的其他頁一張都不會附上，跨頁一致性全靠
 * designSystem 的文字描述重現——實測兩頁的標頭樣式因此不一致。附上前一頁之後，措辭要同時
 * 站住三件互相拉扯的事：對齊框架、但**不是要複製**、而且權威仍是 designSystem。
 *
 * 「沒有範本可附時合約逐字元不變」不在這裡斷言，那是 contract-modes.test.ts 的快照在管
 * （CASES 刻意沒有加 deck-frame 情境，所以那份快照對這個功能是一根不會動的釘子）。做法：
 * 先做完任務 A、更新快照，再做任務 B 並確認快照**沒有第二次變動**——實測 B 前後的
 * `contract-modes.test.ts.snap` 檔案 sha256 相同。
 */
function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    projectId: "project-1",
    slide: {
      id: "slide-2",
      order: 1,
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
      designSystem: "## 色票\n- #F7F5F0 — 內頁畫布底色",
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

const DECK_FRAME: ImageGenerationRequest["references"][number] = {
  path: "/trusted/previous.png",
  mediaType: "image/png",
  role: "deck-frame",
  name: "Previous slide in this deck",
};
const STYLE: ImageGenerationRequest["references"][number] = {
  path: "/trusted/style.png",
  mediaType: "image/png",
  role: "style",
  name: "Style A",
};

/** 附了範本的請求，依模式組出 jobs.ts 會有的形狀。 */
function withDeckFrame(mode: ContractMode): ImageGenerationRequest {
  if (mode === "generate") return request({ references: [STYLE, DECK_FRAME] });
  return request({
    references: [
      { path: "/trusted/base.png", mediaType: "image/png", role: "base", name: "Current slide" },
      STYLE,
      DECK_FRAME,
    ],
    edit: {
      instruction: "把右側卡片換成藍色",
      baseImageIndex: 0,
      ...(mode === "text-removal" ? { purpose: "text-removal" as const } : {}),
    },
  });
}

describe("上一頁當作框架範本", () => {
  const prompt = buildImageGenerationContract(withDeckFrame("generate"));

  it("角色與名稱照實列在附圖清單上", () => {
    expect(prompt).toContain('Image 2: role=deck-frame; name="Previous slide in this deck".');
  });

  it("要對齊的是可重複的框架，不是這一頁的內容", () => {
    expect(prompt).toContain("the previous slide of this same deck, already generated");
    expect(prompt).toContain("neighbouring pages read as one deck");
    for (const frame of [
      "the position and height of the title band",
      "type sizes and colour treatment",
      "margins and alignment",
      "rules, dividers, and colour blocks",
      "overall level of finish",
    ])
      expect(prompt, frame).toContain(frame);
  });

  it("明講它是範本、不是要複製的目標", () => {
    // 使用者原話：「範本那個我會傾向用上一頁生成的，但要記得他只是範本，不用完全一樣」。
    // 只說「保持一致」時，模型會連版面一起抄，這一頁的內容被硬塞進上一頁的格子裡。
    expect(prompt).toContain("It is a template, not a target to copy");
    expect(prompt).toContain("lay out the content area for what this slide actually says");
    expect(prompt).toContain("it does not need to look like that page");
  });

  it("它的內容一個字都不得帶進輸出", () => {
    // 生成模式另有一條總則，但那條逐字列舉了 STYLE 與 CONTENT 兩種角色，涵蓋不到這個
    // 新角色，所以說明必須自帶這一句。
    expect(prompt).toContain("Nothing in it is content for this slide");
    expect(prompt).toContain(
      "its words, headings, numbers, chart values, labels, and pictured subjects must never appear",
    );
  });

  it("頁型不同時走 designSystem 的頁型規則，只沿用跨頁共通的部分", () => {
    expect(prompt).toContain("a cover or a section divider");
    expect(prompt).toContain("follow the page-type rules in style.designSystem");
    expect(prompt).toContain("only what that system holds in common across every page");
  });

  it("舊圖上畫了頁碼是錯的，不得跟著畫", () => {
    // 任務 A 修好之前產出的圖上真的有頁碼；跟著畫等於把已修好的 bug 手動複製回來。
    expect(prompt).toContain("If it shows a page number, a footer, or a date, that image is wrong");
    expect(prompt).toContain("the deck chrome rule above still holds");
    // 順序也要對：範本說明必須排在頁碼禁令**之後**，「above」才指得到東西。
    const ban = prompt.indexOf("DECK CHROME IS NOT YOURS TO DRAW");
    expect(ban).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("the deck chrome rule above still holds")).toBeGreaterThan(ban);
  });

  it("與 designSystem 衝突時以 designSystem 為準", () => {
    // 反過來的話，上一頁的偶發偏差會沿著整份 deck 一頁一頁放大。
    expect(prompt).toContain("Where it disagrees with style.designSystem, style.designSystem wins");
    expect(prompt).toContain("one execution of that system, not a new authority");
  });

  it("沒附範本時整份合約完全不提它", () => {
    const bare = buildImageGenerationContract(request({ references: [STYLE] }));
    expect(bare).not.toContain("deck-frame");
    expect(bare).not.toContain("Deck frame reference");
    expect(bare).not.toContain("It is a template, not a target to copy");
  });

  it("編輯與抹字模式沿用中性的補充說明，不含任何框架祈使句", () => {
    // jobs.ts 只在 generate 附範本，這兩格今天不可達；填生成版措辭的話，「對齊它的標題帶
    // 與邊距」會落在「不要重排這張投影片」正下方。
    const edit = buildImageGenerationContract(withDeckFrame("edit"));
    expect(edit).toContain(
      "Supplemental reference carried over from when this slide was first generated",
    );
    expect(edit).not.toContain("Deck frame reference");
    expect(edit).not.toContain("It is a template, not a target to copy");
    expect(edit).not.toContain("neighbouring pages read as one deck");

    const removal = buildImageGenerationContract(withDeckFrame("text-removal"));
    expect(removal).toContain("Nothing from it is to appear in your output.");
    expect(removal).not.toContain("Deck frame reference");
    expect(removal).not.toContain("neighbouring pages read as one deck");
  });
});

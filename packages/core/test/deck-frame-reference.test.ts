import { describe, expect, it } from "vitest";
import {
  buildImageGenerationContract,
  imageContractLines,
  type ContractMode,
  type ImageGenerationRequest,
} from "../src/index.js";

/**
 * 「上一頁當作框架範本」的合約措辭。
 *
 * 每頁都是單次無狀態生成，同一份簡報已生成的其他頁一張都不會附上，跨頁一致性全靠
 * designSystem 的文字描述重現——實測兩頁的標頭樣式因此不一致。附上前一頁之後，措辭要同時
 * 站住四件互相拉扯的事：對齊框架、**但不是要複製**、權威不是它、以及舊圖上的頁碼要忽略但
 * 不能因此否定整張圖。**位置也是規則的一部分**（見下方的排序測試）。
 *
 * 「沒有範本可附時合約逐字元不變」不在這裡斷言，那是 contract-modes.test.ts 的快照在管
 * （CASES 刻意沒有加 deck-frame 情境，所以那份快照對這個功能是一根不會動的釘子）。做法：
 * 先做完頁碼那一半、更新快照，再加這個功能並確認快照**沒有第二次變動**——實測前後的
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
function withDeckFrame(mode: ContractMode, designSystem = true): ImageGenerationRequest {
  const base = request();
  if (!designSystem) base.style.designSystem = "";
  if (mode === "generate") return { ...base, references: [STYLE, DECK_FRAME] };
  return {
    ...base,
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
  };
}

describe("上一頁當作框架範本", () => {
  const prompt = buildImageGenerationContract(withDeckFrame("generate"));
  const lines = imageContractLines(withDeckFrame("generate"));

  it("是獨立規則區塊，不是塞進附圖清單的一行", () => {
    // 篇幅本身就是權重訊號：旁邊的 STYLE／CONTENT 說明各只有一句，把整段規則壓進附圖清單
    // 那一行等於宣告「這張圖最重要」，而最關鍵的「它只是範本」會落在一千字元之後。
    expect(prompt).toContain("DECK FRAME REFERENCE:");
    const listLine = lines.find((line) => line.startsWith("Image 2: role=deck-frame"))!;
    expect(listLine).toContain('name="Previous slide in this deck"');
    expect(listLine).toContain("Follow the DECK FRAME REFERENCE rules above");
    // 那一行只是指路，不得自己承載規則。
    expect(listLine).not.toContain("the position and height of the title band");
    expect(listLine.length).toBeLessThan(400);
  });

  it("排在 designSystem 權威與頁碼禁令之後、附圖清單之前", () => {
    // 對齊句要求的正是 title band 位置、字級、margins、alignment，而 DESIGN SYSTEM AUTHORITY
    // 明文寫著 Never average these against a reference image——兩者的關係必須在同一個視野內
    // 消解。而範本區塊裡的「the deck chrome rule above」也只有排在禁令之後才指得到東西。
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
    const frame = at("DECK FRAME REFERENCE:");
    expect(frame).toBeGreaterThan(at("DESIGN SYSTEM AUTHORITY:"));
    expect(frame).toBeGreaterThan(at("DECK CHROME IS NOT YOURS TO DRAW"));
    expect(frame).toBeLessThan(at("Attached images are reference inputs"));
  });

  it("先講從屬關係，才講要對齊什麼", () => {
    // 順序是規則的一部分：先「對齊、列舉五類」再補一句「其實只是範本」的話，模型讀到的是
    // 一條強祈使句加一個遲來的但書。
    const block = lines.slice(lines.findIndex((line) => line.includes("DECK FRAME REFERENCE:")));
    const subordination = block.findIndex((line) => line.includes("It is a template"));
    const alignment = block.findIndex((line) => line.includes("align this slide with the frame"));
    expect(subordination).toBeGreaterThanOrEqual(0);
    expect(alignment).toBeGreaterThan(subordination);
  });

  it("要對齊的是可重複的框架，不是這一頁的內容", () => {
    expect(prompt).toContain("the previous slide of this same deck, already generated");
    expect(prompt).toContain("neighbouring pages read as parts of one presentation");
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
    expect(prompt).toContain("it does not need to resemble that page");
  });

  it("它的內容一個字都不得帶進輸出", () => {
    // 生成模式另有一條總則，但那條逐字列舉了 STYLE 與 CONTENT 兩種角色，涵蓋不到這個
    // 新角色，所以規則區塊必須自帶這一句。
    expect(prompt).toContain("Nothing in it is content for this slide");
    expect(prompt).toContain(
      "its words, headings, numbers, chart values, labels, and pictured subjects must never appear",
    );
  });

  it("舊圖上的頁碼要忽略，但不因此否定整張圖", () => {
    // 頁碼禁令修好之前生成的頁上都可能有模型自畫的頁碼，所以這句在現存專案是常態觸發。
    // 寫成「that image is wrong」等於在對齊指令正下方說「我剛叫你對齊的那張圖是錯的」，
    // 最可能的後果是把對齊指令一起削弱。
    expect(prompt).toContain("Ignore any page number, footer, or date it shows");
    expect(prompt).toContain("the deck chrome rule above still holds");
    expect(prompt).toContain("Everything else about that image still stands");
    expect(prompt).not.toContain("that image is wrong");
  });

  describe("權威永遠有人扛", () => {
    it("有 designSystem 時以 designSystem 為準", () => {
      // 反過來的話，上一頁的偶發偏差會沿著整份 deck 一頁一頁放大。
      expect(prompt).toContain("style.designSystem stays the authority");
      expect(prompt).toContain("one execution of it, not a second specification");
      // 與 DESIGN SYSTEM AUTHORITY 的「不得與參考圖折衷」就地對帳，不留給模型自己推。
      expect(prompt).toContain("never to average structural decisions against a reference image");
    });

    it("沒有 designSystem 時退到 STYLE 參考圖，範本不會遞補成最高權威", () => {
      // `hasDesignSystem()` 是活的分支：沒跑過 AI 分析的風格 designSystem 是空字串，整段
      // DESIGN SYSTEM AUTHORITY 不會送出（本機 9 份風格有 8 份是這樣）。把裁決權交給一個
      // 空欄位等於沒有裁決，範本事實上就變成最高權威。
      const bare = buildImageGenerationContract(withDeckFrame("generate", false));
      expect(bare).not.toContain("DESIGN SYSTEM AUTHORITY");
      expect(bare).not.toContain("style.designSystem stays the authority");
      expect(bare).toContain("the STYLE references remain the authority on how it looks");
      expect(bare).toContain("Where the two disagree, follow the STYLE references");
      // 同一份 prompt 裡還有一句「All STYLE references have equal influence … not a master
      // template」，兩者的關係必須就地講明，否則模型收到的是兩條對撞的話。
      expect(bare).toContain("All STYLE references have equal influence");
      expect(bare).toContain("This image is not one of them and never becomes a master template");
      // 頁型規則也不能指向空欄位。
      expect(bare).toContain("decide the rest from slide.purpose and slide.content");
      expect(bare).not.toContain("follow the page-type rules in style.designSystem");
    });
  });

  it("沒附範本時整份合約完全不提它", () => {
    const bare = buildImageGenerationContract(request({ references: [STYLE] }));
    expect(bare).not.toContain("deck-frame");
    expect(bare).not.toContain("DECK FRAME REFERENCE");
    expect(bare).not.toContain("It is a template, not a target to copy");
  });

  it("編輯與抹字模式沿用中性的補充說明，整個規則區塊都不送", () => {
    // jobs.ts 只在 generate 附範本，這兩格今天不可達；填生成版措辭的話，「對齊它的標題帶
    // 與邊距」會落在「不要重排這張投影片」正下方。
    for (const mode of ["edit", "text-removal"] as const) {
      const modePrompt = buildImageGenerationContract(withDeckFrame(mode));
      expect(modePrompt, mode).not.toContain("DECK FRAME REFERENCE");
      expect(modePrompt, mode).not.toContain("It is a template, not a target to copy");
      expect(modePrompt, mode).not.toContain("align this slide with the frame");
      expect(modePrompt, mode).toContain(
        mode === "edit"
          ? "Supplemental reference carried over from when this slide was first generated"
          : "Nothing from it is to appear in your output.",
      );
    }
  });
});

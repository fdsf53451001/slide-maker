import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "@slide-maker/core";
import {
  parseChatCompletionsUsage,
  parseImagesApiUsage,
  parseOpenRouterUsage,
} from "@slide-maker/provider-openai";
import { parseGeminiUsage } from "../src/usage.js";

/**
 * 四種 wire 形狀 × 四個解析器的**完整交叉矩陣**。
 *
 * 這一份跨了兩個套件（provider-gemini 相依 provider-openai），刻意放在能同時 import 到
 * 四個解析器的地方——各套件自己的 `usage.test.ts` 只驗得到「自己那幾個」，而這個功能最可能
 * 出的錯是**跨套件的 DRY 合併**：有人看到四個長得像的函式，就把它們併成一個「先試
 * prompt_tokens、再試 input_tokens、再試 promptTokenCount」的萬用解析器。那種實作會讓每個
 * 套件自己的測試全綠，卻讓「這個模型的用量到底是哪個端點回的」永遠分不出來。
 *
 * 矩陣釘住兩條性質：
 *  ① 每個形狀只有**自己的**解析器讀得出完整的 input＋output（外加該形狀專屬的欄位）。
 *  ② **誤接一律整筆不採信**（`{ reported: false }`）。每個解析器都先做形狀判別：chat 要
 *    `prompt_tokens`／`completion_tokens`／`cost` 至少一個，images 要 `input_tokens`／
 *    `output_tokens` 至少一個。少了這道判別，OpenAI 家族唯一同名的 `total_tokens` 會被
 *    撿走，產出 `{ totalTokens: 241, reported: true }`——那看起來像「gateway 只回了部分
 *    欄位」，比整筆解不出來更難察覺，所以**判別不過時不可退而求其次去撿 total**。
 *
 * (a) 與 (c) 現在是**同一個解析器**（`parseOpenRouterUsage` 是 `parseChatCompletionsUsage`
 * 的別名）：OpenRouter 就是另一個 base URL 的 `/chat/completions`，`cost` 只是多回的一個
 * optional 欄位，而它被設成文字／搜尋模型時走的正是 chat 那條——只在影像那條讀 cost 會
 * 讓文字那一大塊的金額無聲消失。
 */

/** (a) CLI2Proxy `/chat/completions` 實測回應。 */
const CHAT = {
  usage: {
    prompt_tokens: 303,
    completion_tokens: 13,
    total_tokens: 316,
    prompt_tokens_details: { cached_tokens: 0, cached_creation_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
};

/** (b) CLI2Proxy `/images/generations` 實測回應。欄位名與 (a) 完全不同。 */
const IMAGES = {
  usage: {
    input_tokens: 12,
    input_tokens_details: { image_tokens: 0, text_tokens: 12 },
    output_tokens: 229,
    output_tokens_details: { image_tokens: 229, text_tokens: 0 },
    total_tokens: 241,
  },
};

/** (c) OpenRouter `/images` 實測回應。欄位名同 (a)，但多一個 `cost`。 */
const OPENROUTER = {
  usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost: 0.04 },
};

/** (d) Gemini 原生 `:generateContent` 實測回應。連容器名都不同（usageMetadata）。 */
const GEMINI = {
  usageMetadata: {
    promptTokenCount: 1_234,
    candidatesTokenCount: 567,
    thoughtsTokenCount: 890,
    totalTokenCount: 2_691,
  },
};

const PARSERS = {
  chat: parseChatCompletionsUsage,
  images: parseImagesApiUsage,
  openrouter: parseOpenRouterUsage,
  gemini: parseGeminiUsage,
} as const;

const FIXTURES = { CHAT, IMAGES, OPENROUTER, GEMINI } as const;

describe("四份 fixture 本身就必須互相區分", () => {
  /**
   * 共用一份假資料等於沒測：把 (b) 錯接成 (a) 的實作也會全綠。這條測試釘住的是**測試資料
   * 本身**——四份 payload 的欄位名不得退化成同一組。
   */
  it("四個形狀的欄位名兩兩不同（沒有任何兩份是同一組鍵）", () => {
    const keys = Object.entries(FIXTURES).map(([name, fixture]) => {
      const container = "usage" in fixture ? fixture.usage : fixture.usageMetadata;
      return [name, new Set(Object.keys(container))] as const;
    });
    for (const [leftName, left] of keys)
      for (const [rightName, right] of keys) {
        if (leftName === rightName) continue;
        const identical = left.size === right.size && [...left].every((key) => right.has(key));
        expect(identical, `${leftName} 與 ${rightName} 用了同一組欄位名`).toBe(false);
      }
    // OpenAI 家族三份之間唯一的交集就是 total_tokens；多一個交集就代表 fixture 被改鈍了。
    const chatKeys = new Set(Object.keys(CHAT.usage));
    const imageKeys = new Set(Object.keys(IMAGES.usage));
    expect([...chatKeys].filter((key) => imageKeys.has(key))).toEqual(["total_tokens"]);
    // Gemini 與 OpenAI 家族連容器都不同：零交集。
    expect(Object.keys(GEMINI.usageMetadata).some((key) => chatKeys.has(key))).toBe(false);
  });
});

describe("交叉矩陣：每個形狀只有自己的解析器讀得完整", () => {
  const expected: Record<keyof typeof PARSERS, Record<keyof typeof FIXTURES, ProviderUsage>> = {
    chat: {
      CHAT: {
        inputTokens: 303,
        outputTokens: 13,
        totalTokens: 316,
        cachedTokens: 0,
        reasoningTokens: 0,
        reported: true,
      },
      // 誤接：形狀判別擋下，整筆不採信（連同名的 total 都不撿）。
      IMAGES: { reported: false },
      // (c) 就是 (a)：token 與 cost 一起讀得到。
      OPENROUTER: {
        inputTokens: 0,
        outputTokens: 4175,
        totalTokens: 4175,
        reported: true,
        cost: { amount: 0.04, unit: "openrouter-credit" },
      },
      GEMINI: { reported: false },
    },
    images: {
      CHAT: { reported: false },
      IMAGES: {
        inputTokens: 12,
        outputTokens: 229,
        totalTokens: 241,
        imageTokens: 229,
        reported: true,
      },
      OPENROUTER: { reported: false },
      GEMINI: { reported: false },
    },
    openrouter: {
      // OpenRouter 的解析器是 (a) 的超集：沒有 cost 的 chat 回應照樣讀得對。
      CHAT: {
        inputTokens: 303,
        outputTokens: 13,
        totalTokens: 316,
        cachedTokens: 0,
        reasoningTokens: 0,
        reported: true,
      },
      IMAGES: { reported: false },
      OPENROUTER: {
        inputTokens: 0,
        outputTokens: 4175,
        totalTokens: 4175,
        reported: true,
        cost: { amount: 0.04, unit: "openrouter-credit" },
      },
      GEMINI: { reported: false },
    },
    gemini: {
      CHAT: { reported: false },
      IMAGES: { reported: false },
      OPENROUTER: { reported: false },
      GEMINI: {
        inputTokens: 1_234,
        outputTokens: 567,
        reasoningTokens: 890,
        totalTokens: 2_691,
        reported: true,
      },
    },
  };

  for (const parserName of Object.keys(PARSERS) as (keyof typeof PARSERS)[])
    for (const fixtureName of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])
      it(`${parserName} 解析器 × ${fixtureName} 形狀`, () => {
        expect(PARSERS[parserName](FIXTURES[fixtureName])).toEqual(
          expected[parserName][fixtureName],
        );
      });
});

describe("誤接一定看得出來", () => {
  /**
   * 這是整個矩陣的重點：合併解析器之後，誤接會產出一份**看起來很正常**的紀錄，沒有任何人
   * 察覺得到。所以規則寫成一句可檢查的話——「不是自己的形狀，就絕不可能同時讀出 input 與
   * output」。
   */
  const owner: Record<keyof typeof FIXTURES, (keyof typeof PARSERS)[]> = {
    CHAT: ["chat", "openrouter"],
    IMAGES: ["images"],
    OPENROUTER: ["chat", "openrouter"],
    GEMINI: ["gemini"],
  };

  it("非該形狀的解析器永遠讀不出「input 與 output 同時存在」", () => {
    for (const fixtureName of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])
      for (const parserName of Object.keys(PARSERS) as (keyof typeof PARSERS)[]) {
        if (owner[fixtureName].includes(parserName)) continue;
        const usage = PARSERS[parserName](FIXTURES[fixtureName]);
        const complete = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
        expect(complete, `${parserName} 不該讀得懂 ${fixtureName}`).toBe(false);
      }
  });

  it("imageTokens 只有 images 形狀讀得到，cost 只有 chat 家族的解析器讀 OpenRouter 形狀時讀得到", () => {
    for (const [parserName, parse] of Object.entries(PARSERS)) {
      for (const [fixtureName, fixture] of Object.entries(FIXTURES)) {
        const usage = parse(fixture);
        expect(
          usage.imageTokens !== undefined,
          `${parserName} × ${fixtureName} 的 imageTokens`,
        ).toBe(parserName === "images" && fixtureName === "IMAGES");
        expect(usage.cost !== undefined, `${parserName} × ${fixtureName} 的 cost`).toBe(
          ["chat", "openrouter"].includes(parserName) && fixtureName === "OPENROUTER",
        );
      }
    }
  });

  /**
   * 上面的矩陣是逐格比對，容易在改動時被「順手改成新的期望值」。這一條把規則寫成一句
   * 不依賴任何數字的話：**不是自己的形狀，就一個欄位都不採信**。
   */
  it("非該形狀的解析器一律回 { reported: false }", () => {
    for (const fixtureName of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])
      for (const parserName of Object.keys(PARSERS) as (keyof typeof PARSERS)[]) {
        if (owner[fixtureName].includes(parserName)) continue;
        expect(
          PARSERS[parserName](FIXTURES[fixtureName]),
          `${parserName} 不該讀得懂 ${fixtureName}`,
        ).toEqual({ reported: false });
      }
  });
});

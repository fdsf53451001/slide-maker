import { mkdtemp, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { afterEach, describe, expect, it } from "vitest";
import { SafeProviderError, type ImageGenerationRequest } from "@slide-maker/core";
import {
  type OpenAiClientConfig,
  OpenAiCompatibleImageProvider,
  OpenAiStructuredTextProvider,
  OpenAiWebSearchProvider,
} from "../src/index.js";

/**
 * 用量**接線**的補強：`usage.test.ts` 驗解析器、`openai.test.ts` 驗 images 與 openrouter
 * 兩條通道，這裡補上沒被碰到的 chat 影像通道與 `/images/edits`，外加兩件只有在 transport
 * 層才看得見的事——「gateway 不回 usage」與「provider 自己重試時前幾輪的用量去哪了」。
 */

interface Captured {
  path: string;
  body: unknown;
}

interface FakeServer {
  config: OpenAiClientConfig;
  requests: Captured[];
  server: Server;
}

async function startFake(
  responder: (captured: Captured) => { status: number; json: unknown },
): Promise<FakeServer> {
  const requests: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (part: Buffer) => chunks.push(part));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const captured: Captured = { path: request.url ?? "", body };
      requests.push(captured);
      const result = responder(captured);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    requests,
    config: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", timeoutMs: 5_000 },
  };
}

let active: FakeServer | undefined;
afterEach(async () => {
  if (active) {
    active.server.closeAllConnections();
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
  }
  active = undefined;
});

/**
 * 以 resvg 畫出測試用 PNG。與 `openai.test.ts` 同一個做法：這些通道會真的去解圖、正規化成
 * canvas 尺寸，所以素材必須是真的 raster，不能是手工拼的 PNG 結構。
 */
function realPng(width = 64, height = 36): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#123456"/></svg>`;
  return Buffer.from(new Resvg(svg).render().asPng());
}

/** resvg 與 canvas 正規化在冷跑時可以慢一個數量級（見 openai.test.ts 的同名註解）。 */
const RASTER_TIMEOUT_MS = 30_000;

function imageRequest(): ImageGenerationRequest {
  return {
    projectId: "p1",
    slide: {
      purpose: "封面",
      content: "AI 簡報",
      narrative: "由問題走向結論",
      layoutHint: "左文右圖",
      dataBasis: [],
      imagePrompt: "藍色抽象背景",
    },
    style: {
      name: "現代",
      description: "明亮留白",
      density: "high",
      imageDirection: "簡潔",
      avoid: [],
      promptTemplate: "",
      designSystem: "",
    },
    width: 64,
    height: 36,
    references: [],
    model: "ignored",
    parameters: {},
  } as unknown as ImageGenerationRequest;
}

describe("chat 影像通道的用量", () => {
  /**
   * chat 通道送的是 `/chat/completions`，所以吃的是形狀 (a)。它與 images 通道在同一個
   * provider 底下、只差一個 `apiShape`，接錯的機率最高，而症狀（整條靜默 reported:false）
   * 從 UI 完全看不出來。
   */
  it(
    "apiShape:chat 帶回 prompt/completion_tokens 與 reasoning",
    async () => {
      const dataUrl = `data:image/png;base64,${realPng().toString("base64")}`;
      active = await startFake(() => ({
        status: 200,
        json: {
          choices: [{ message: { images: [{ image_url: { url: dataUrl } }] } }],
          usage: {
            prompt_tokens: 303,
            completion_tokens: 13,
            total_tokens: 316,
            prompt_tokens_details: { cached_tokens: 0, cached_creation_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 7 },
          },
        },
      }));
      const provider = new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gemini-3.1-flash-image",
        apiShape: "chat",
      });
      const image = await provider.generate(imageRequest());
      expect(active.requests[0]!.path).toBe("/v1/chat/completions");
      expect(image.usage).toEqual({
        inputTokens: 303,
        outputTokens: 13,
        totalTokens: 316,
        cachedTokens: 0,
        reasoningTokens: 7,
        reported: true,
      });
    },
    RASTER_TIMEOUT_MS,
  );
});

describe("images 端點的編輯通道", () => {
  /**
   * 遮罩編輯走 `/images/edits`，與生成是**不同的請求函式**。用量在那條路上一樣要帶回來，
   * 否則「重畫某一塊」這種最常被連按好幾次的操作，成本會整批消失在統計裡。
   */
  it(
    "/images/edits 也帶回 input/output_tokens 與輸出側 image_tokens",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "slide-maker-usage-transport-"));
      const referencePath = join(directory, "base.png");
      await writeFile(referencePath, realPng());
      const b64 = realPng().toString("base64");
      active = await startFake(() => ({
        status: 200,
        json: {
          data: [{ b64_json: b64 }],
          usage: {
            input_tokens: 12,
            input_tokens_details: { image_tokens: 0, text_tokens: 12 },
            output_tokens: 229,
            output_tokens_details: { image_tokens: 229, text_tokens: 0 },
            total_tokens: 241,
          },
        },
      }));
      const provider = new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gpt-image-2",
      });
      const image = await provider.generate({
        ...imageRequest(),
        references: [{ path: referencePath, mediaType: "image/png", role: "base", name: "Base" }],
        edit: { instruction: "Remove text", baseImageIndex: 0, purpose: "text-removal" },
      } as unknown as ImageGenerationRequest);
      expect(active.requests[0]!.path).toBe("/v1/images/edits");
      expect(image.usage).toEqual({
        inputTokens: 12,
        outputTokens: 229,
        totalTokens: 241,
        imageTokens: 229,
        reported: true,
      });
    },
    RASTER_TIMEOUT_MS,
  );

  /**
   * gateway 根本不回 usage 時必須是 `reported:false`，**不是一堆 0**：把「這條通道沒回報」
   * 記成 0 之後，統計會顯示一個看似精確、實際上系統性低估的數字，而使用者無從察覺。
   */
  it(
    "gateway 不回 usage 時是 reported:false 而不是 0",
    async () => {
      const b64 = realPng().toString("base64");
      active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
      const provider = new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gpt-image-2",
      });
      const image = await provider.generate(imageRequest());
      expect(image.usage).toEqual({ reported: false });
      expect(image.usage?.inputTokens).toBeUndefined();
      expect(image.usage?.totalTokens).toBeUndefined();
    },
    RASTER_TIMEOUT_MS,
  );
});

describe("provider 內部重試的用量", () => {
  /**
   * `OpenAiStructuredTextProvider.runStructured` 對「回了非 JSON」這類暫時性失敗，自己在
   * 內部最多重試 3 次。每一次都是一個真的 HTTP 請求、都燒掉整份長 prompt 的 token（模型
   * 回了東西，只是不是合法 JSON——輸出 token 照算），所以**每一輪都要併進回傳的 usage**。
   *
   * 這與 `app.ts` 逐輪記帳的理由是同一條，只是低了一層：那裡的註解寫「只記最後一輪會把
   * 成本低估到三分之一」，而這裡正是同一個三分之一。兩層疊起來，一次「重生成大綱」最多
   * 可以是 9 個真實請求——帳本必須看得到全部，`requests` 則讓「重跑了幾次」問得出來。
   */
  it("內部重試 3 次：三輪的用量全部累加，requests 回報真實請求數", async () => {
    let call = 0;
    active = await startFake(() => {
      call += 1;
      const usage = {
        prompt_tokens: 100 * call,
        completion_tokens: 10 * call,
        total_tokens: 110 * call,
      };
      // 前兩次回非 JSON（實測的暫時性失敗形狀），第三次才回合法 JSON。
      const content = call < 3 ? "sorry, I cannot" : '{"ok":true}';
      return { status: 200, json: { choices: [{ message: { content } }], usage } };
    });
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gemini" });
    const result = await provider.runStructured({ prompt: "hi", outputSchema: {} });

    expect(result.value).toEqual({ ok: true });
    // 真的送出去三次請求，三次都燒了 token。
    expect(active.requests).toHaveLength(3);
    // 100+200+300 / 10+20+30 / 110+220+330——一輪都不能少。
    expect(result.usage).toEqual({
      inputTokens: 600,
      outputTokens: 60,
      totalTokens: 660,
      reported: true,
    });
    expect(result.requests).toBe(3);
  });

  /**
   * 三輪**都**失敗時 token 一樣全燒掉了，而這是最貴的情況。用量必須跟著錯誤走
   * （`SafeProviderError.usage`），否則帳本上只剩一筆 `reported:false`——與「這個 gateway
   * 不回報用量」長得一模一樣。
   */
  it("三輪都失敗時，累加的用量掛在丟出來的 SafeProviderError 上", async () => {
    let call = 0;
    active = await startFake(() => {
      call += 1;
      return {
        status: 200,
        json: {
          choices: [{ message: { content: "sorry, I cannot" } }],
          usage: { prompt_tokens: 100 * call, completion_tokens: 10 * call },
        },
      };
    });
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gemini" });
    const error = await provider
      .runStructured({ prompt: "hi", outputSchema: {} })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(active.requests).toHaveLength(3);
    expect(error).toBeInstanceOf(SafeProviderError);
    const safe = error as SafeProviderError;
    expect(safe.code).toBe("OPENAI_RESPONSE_INVALID");
    expect(safe.usage).toEqual({ inputTokens: 600, outputTokens: 60, reported: true });
    expect(safe.requests).toBe(3);
  });

  /**
   * 連不上時**沒有**用量可言：一個 byte 都沒送到模型。這條與上一條合起來才釘得住
   * 「usage 是真的從 payload 來的」——只看上一條的話，把 usage 亂編一個常數也會通過。
   */
  it("HTTP 層就失敗時不編造用量（錯誤上沒有 usage）", async () => {
    active = await startFake(() => ({ status: 500, json: { error: "boom" } }));
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gemini" });
    const error = await provider
      .runStructured({ prompt: "hi", outputSchema: {} })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SafeProviderError);
    expect((error as SafeProviderError).usage).toBeUndefined();
    // 但「打過一次」仍然是事實。
    expect((error as SafeProviderError).requests).toBe(1);
  });
});

describe("往返成功之後才失敗的路徑", () => {
  /**
   * 搜尋回了一整包東西、卻沒有一筆通得過驗證：token 全燒光、產出是零，而使用者的直覺
   * 反應是再按一次。這是整個功能裡最值得記的一種失敗，usage 必須跟著錯誤走。
   */
  it("OPENAI_WEB_SEARCH_EMPTY 帶著這次的用量", async () => {
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [{ message: { content: '{"results":[]}' } }],
        usage: { prompt_tokens: 4_000, completion_tokens: 900, total_tokens: 4_900 },
      },
    }));
    const provider = new OpenAiWebSearchProvider({ config: active.config, model: "gpt-5-search" });
    const error = await provider
      .search("電動車", 5, "zh-TW")
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SafeProviderError);
    expect((error as SafeProviderError).code).toBe("OPENAI_WEB_SEARCH_EMPTY");
    expect((error as SafeProviderError).usage).toEqual({
      inputTokens: 4_000,
      outputTokens: 900,
      totalTokens: 4_900,
      reported: true,
    });
  });

  /**
   * 影像通道的同一件事：模型不支援圖片輸出時會回一段文字，往返照樣完成、照樣扣款。
   */
  it(
    "OPENAI_IMAGE_MISSING 帶著這次的用量",
    async () => {
      active = await startFake(() => ({
        status: 200,
        json: {
          data: [{}],
          usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
        },
      }));
      const provider = new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gpt-image-2",
      });
      const error = await provider
        .generate(imageRequest())
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(SafeProviderError);
      expect((error as SafeProviderError).code).toBe("OPENAI_IMAGE_MISSING");
      expect((error as SafeProviderError).usage).toEqual({
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        reported: true,
      });
    },
    RASTER_TIMEOUT_MS,
  );
});

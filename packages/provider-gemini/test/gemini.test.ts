import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeProviderError, type ImageGenerationRequest } from "@slide-maker/core";
import {
  type GeminiClientConfig,
  GeminiImageProvider,
  GeminiStructuredTextProvider,
  GeminiWebSearchProvider,
  listGeminiModelIds,
} from "../src/index.js";

// ---- mock fetch harness ------------------------------------------------------
// 全程以 mock fetch 驅動，一律不打真實網路。搜尋 provider 的重導向解析會對 grounding
// 給的網址發請求，而那條路徑上的 SSRF 檢查會擋掉 127.0.0.1，故無法用本機 fake server。

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockReply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const config: GeminiClientConfig = {
  baseUrl: "https://gemini.test/v1beta",
  apiKey: "test-key",
  timeoutMs: 5_000,
};

const originalFetch = globalThis.fetch;
let captured: Captured[] = [];

function mockFetch(handler: (call: Captured) => MockReply): Captured[] {
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown;
    try {
      body = raw ? (JSON.parse(raw) as unknown) : undefined;
    } catch {
      body = raw;
    }
    const call: Captured = {
      url: input instanceof URL ? input.toString() : String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    };
    captured.push(call);
    const reply = handler(call);
    return new Response(reply.json === undefined ? "" : JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- fixtures ----------------------------------------------------------------

/** 可被 resvg 解碼的 8x8 PNG。 */
const REAL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
/** 可被 resvg 解碼的最小 JPEG——原生端點回的就是 JPEG 而非 PNG。 */
const REAL_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function imageRequest(): ImageGenerationRequest {
  return {
    projectId: "p1",
    slide: {
      purpose: "封面",
      content: "AI 簡報",
      narrative: "由問題走向結論",
      layoutHint: "左文右圖",
      dataBasis: ["採用率 80%"],
      imagePrompt: "藍色抽象背景",
    },
    style: {
      name: "現代",
      description: "明亮留白",
      density: "high",
      imageDirection: "簡潔",
      avoid: ["雜亂"],
      promptTemplate: "以 {subject} 為主體",
      designSystem: "",
    },
    width: 1920,
    height: 1080,
    references: [],
    model: "ignored",
    parameters: { seed: 1 },
  } as unknown as ImageGenerationRequest;
}

/** 從 PNG 的 IHDR 讀出寬高，驗證正規化結果確實是 canvas 尺寸。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function writeReference(name: string): Promise<string> {
  const path = join(tmpdir(), `gemini-${name}-${process.pid}.png`);
  await writeFile(path, Buffer.from(REAL_PNG, "base64"));
  return path;
}

type Part = { text?: string; inlineData?: { mimeType: string; data: string } };

function requestParts(call: Captured): Part[] {
  const body = call.body as { contents: { parts: Part[] }[] };
  return body.contents[0]!.parts;
}

// ---- image -------------------------------------------------------------------

describe("GeminiImageProvider", () => {
  it("posts to models/{model}:generateContent with the api-key header and image modality", async () => {
    const calls = mockFetch(() => ({
      json: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: REAL_JPEG } }] } },
        ],
      },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const image = await provider.generate(imageRequest());
    expect(image.mediaType).toBe("image/png");
    expect(image.extension).toBe("png");
    expect(image.model).toBe("gemini-3.1-flash-image");
    expect(image.parameters.transport).toBe("gemini-generate-content");
    // JPEG（且比例不同）必須正規化成 canvas 尺寸的 PNG。
    expect(pngSize(image.bytes)).toEqual({ width: 1920, height: 1080 });

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(
      "https://gemini.test/v1beta/models/gemini-3.1-flash-image:generateContent",
    );
    expect(call.headers["x-goog-api-key"]).toBe("test-key");
    expect(call.headers).not.toHaveProperty("authorization");
    const body = call.body as {
      generationConfig: { responseModalities: string[]; imageConfig?: { aspectRatio: string } };
    };
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
    expect(body.generationConfig.imageConfig?.aspectRatio).toBe("16:9");
    const prompt = requestParts(call)[0]!.text ?? "";
    expect(prompt).toContain("slide.content field is the authoritative visible copy");
    expect(prompt).toContain('"layoutHint": "左文右圖"');
    expect(prompt).toContain("UNTRUSTED_PRESENTATION_JSON");
  });

  it("appends references as inlineData parts in manifest order after the contract text", async () => {
    const refPath = await writeReference("ref");
    const calls = mockFetch(() => ({
      json: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: "image/png", data: REAL_PNG } }] } },
        ],
      },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await provider.generate({
      ...imageRequest(),
      references: [
        { path: refPath, mediaType: "image/png", role: "style" as const, name: "Style A" },
        { path: refPath, mediaType: "image/png", role: "direct-asset" as const, name: "Panel" },
      ],
    });
    const parts = requestParts(calls[0]!);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.text).toBeTypeOf("string");
    expect(parts[1]!.inlineData).toEqual({ mimeType: "image/png", data: REAL_PNG });
    expect(parts[2]!.inlineData).toEqual({ mimeType: "image/png", data: REAL_PNG });
    // 合約中的 Image N 編號必須與 inlineData 的附加順序一致。
    const prompt = parts[0]!.text ?? "";
    expect(prompt).toContain('Image 1: role=style; name="Style A"');
    expect(prompt).toContain('Image 2: role=direct-asset; name="Panel"');
    expect(prompt).toContain("DIRECT-ASSET FIDELITY CONTRACT");
  });

  it("treats a mask as one more reference image and keeps the text-removal contract", async () => {
    const refPath = await writeReference("mask");
    const calls = mockFetch(() => ({
      json: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: "image/png", data: REAL_PNG } }] } },
        ],
      },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await provider.generate({
      ...imageRequest(),
      references: [
        { path: refPath, mediaType: "image/png", role: "content" as const, name: "Current slide" },
        { path: refPath, mediaType: "image/png", role: "content" as const, name: "Mask" },
        { path: refPath, mediaType: "image/png", role: "style" as const, name: "Style A" },
      ],
      edit: {
        instruction: "Remove text",
        baseImageIndex: 0,
        maskImageIndex: 1,
        purpose: "text-removal" as const,
      },
    });
    const parts = requestParts(calls[0]!);
    expect(parts.filter((part) => part.inlineData)).toHaveLength(3);
    const prompt = parts[0]!.text ?? "";
    expect(prompt).toContain("TEXT REMOVAL CONTRACT");
    expect(prompt).toContain("Image 2 is the mask");
    expect(prompt).toContain("Do not re-render text from slide.content");
  });

  it("reads the image from a part that also carries thoughtSignature", async () => {
    mockFetch(() => ({
      json: {
        candidates: [
          {
            content: {
              parts: [
                { text: "思考中…", thoughtSignature: "sig-a" },
                {
                  inlineData: { mimeType: "image/jpeg", data: REAL_JPEG },
                  thoughtSignature: "sig-b",
                },
              ],
            },
          },
        ],
      },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const image = await provider.generate(imageRequest());
    expect(pngSize(image.bytes)).toEqual({ width: 1920, height: 1080 });
  });

  it("rejects a response without inline image data", async () => {
    mockFetch(() => ({
      json: { candidates: [{ content: { parts: [{ text: "抱歉，我無法生成。" }] } }] },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.6-flash" });
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "GEMINI_IMAGE_MISSING",
    });
  });

  it("maps HTTP 401 to an auth error without leaking the response body", async () => {
    mockFetch(() => ({ status: 401, json: { error: { message: "API key sk-secret invalid" } } }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const error = await provider.generate(imageRequest()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SafeProviderError);
    expect((error as SafeProviderError).code).toBe("GEMINI_AUTH_REQUIRED");
    expect((error as SafeProviderError).safeMessage).not.toContain("sk-secret");
  });

  it("maps HTTP 429 to a usage-limit error", async () => {
    mockFetch(() => ({ status: 429, json: { error: { message: "quota" } } }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "GEMINI_USAGE_LIMIT",
    });
  });

  it("is unavailable without configuration", () => {
    const provider = new GeminiImageProvider({
      config: { baseUrl: "", apiKey: "", timeoutMs: 1_000 },
      model: "",
    });
    expect(provider.availability.status).toBe("unavailable");
    expect(provider.capabilities.maskedEditing).toBe(true);
    expect(provider.capabilities.multipleReferenceImages).toBe(true);
  });
});

// ---- structured text ---------------------------------------------------------

describe("GeminiStructuredTextProvider", () => {
  it("requests JSON mime type without responseSchema and parses concatenated text parts", async () => {
    const calls = mockFetch(() => ({
      json: {
        candidates: [
          {
            content: {
              parts: [{ text: '{"ok":true,', thoughtSignature: "sig" }, { text: '"items":[1,2]}' }],
            },
          },
        ],
      },
    }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    const result = await provider.runStructured({
      prompt: "hi",
      outputSchema: { type: "object", additionalProperties: false },
    });
    expect(result).toEqual({ ok: true, items: [1, 2] });

    const call = calls[0]!;
    expect(call.url).toBe("https://gemini.test/v1beta/models/gemini-3.6-flash:generateContent");
    const body = call.body as {
      systemInstruction: { parts: { text: string }[] };
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    // responseSchema 只吃 OpenAPI subset，硬塞完整 JSON Schema 會 400，故一律不送。
    expect(body.generationConfig).not.toHaveProperty("responseSchema");
    expect(body.systemInstruction.parts[0]!.text).toContain("JSON_SCHEMA");
    expect(body.systemInstruction.parts[0]!.text).toContain("additionalProperties");
  });

  it("parses JSON wrapped in a markdown fence", async () => {
    mockFetch(() => ({
      json: { candidates: [{ content: { parts: [{ text: '```json\n{ "value": 42 }\n```' }] } }] },
    }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    expect(await provider.runStructured({ prompt: "hi", outputSchema: {} })).toEqual({ value: 42 });
  });

  it("retries a candidate that carries no text part and eventually succeeds", async () => {
    let attempt = 0;
    const calls = mockFetch(() => {
      attempt += 1;
      return attempt < 3
        ? { json: { candidates: [{ content: { parts: [{ thoughtSignature: "sig" }] } }] } }
        : { json: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] } };
    });
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    expect(await provider.runStructured({ prompt: "hi", outputSchema: {} })).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("rejects a non-JSON payload with a Gemini-coded SafeProviderError", async () => {
    mockFetch(() => ({
      json: { candidates: [{ content: { parts: [{ text: "這是我的分析…" }] } }] },
    }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    await expect(provider.runStructured({ prompt: "hi", outputSchema: {} })).rejects.toMatchObject({
      code: "GEMINI_RESPONSE_INVALID",
    });
  });
});

// ---- web search --------------------------------------------------------------

const REDIRECT_PREFIX = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

function groundedPayload(): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: "高鐵票價調整。台積電法說會。" }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: `${REDIRECT_PREFIX}AAA`, title: "udn.com" } },
            { web: { uri: `${REDIRECT_PREFIX}BBB`, title: "cna.com.tw" } },
            { web: { uri: `${REDIRECT_PREFIX}CCC`, title: "example.gov" } },
          ],
          groundingSupports: [
            { segment: { text: "高鐵票價調整。" }, groundingChunkIndices: [0, 1] },
            { segment: { text: "台積電法說會。" }, groundingChunkIndices: [0] },
          ],
        },
      },
    ],
  };
}

describe("GeminiWebSearchProvider", () => {
  it("sends the googleSearch tool without structured output and resolves redirect URLs", async () => {
    const calls = mockFetch((call) => {
      if (call.url.startsWith(REDIRECT_PREFIX)) {
        const target = call.url.endsWith("AAA")
          ? "https://udn.com/news/story/7266/9487252"
          : "https://www.cna.com.tw/news/aipl/202607220001.aspx";
        return { status: 302, headers: { location: target } };
      }
      return { json: groundedPayload() };
    });
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("高鐵 票價", 8, "zh-TW");

    const body = calls[0]!.body as {
      tools: { googleSearch: object }[];
      generationConfig?: unknown;
    };
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    // tools 與 responseMimeType 不可並用，故完全不送 generationConfig。
    expect(body.generationConfig).toBeUndefined();

    // groundingChunkIndices 是多對一：「高鐵票價調整。」同時被 chunk 0 與 1 支撐，
    // 不代表這句話出自其中任何一頁，故降級為加前綴的補充，專屬段落優先。
    expect(results).toEqual([
      {
        url: "https://udn.com/news/story/7266/9487252",
        title: "udn.com",
        summary: "台積電法說會。\n（多來源共同支撐）高鐵票價調整。",
      },
      {
        url: "https://www.cna.com.tw/news/aipl/202607220001.aspx",
        title: "cna.com.tw",
        summary: "（多來源共同支撐）高鐵票價調整。",
      },
    ]);
    // 第三筆沒有任何 support 段落 → 組不出 summary → 捨棄，不以網域名充數。
    expect(results.some((result) => result.title === "example.gov")).toBe(false);
    // 只對留下來的候選解重導向，未被引用的 chunk 不發請求。
    expect(calls.filter((call) => call.url.startsWith(REDIRECT_PREFIX))).toHaveLength(2);
  });

  it("falls back to the original uri when the redirect cannot be resolved", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 200, json: {} }
        : {
            json: {
              candidates: [
                {
                  groundingMetadata: {
                    groundingChunks: [{ web: { uri: `${REDIRECT_PREFIX}AAA`, title: "udn.com" } }],
                    groundingSupports: [
                      { segment: { text: "被支撐的段落。" }, groundingChunkIndices: [0] },
                    ],
                  },
                },
              ],
            },
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("query", 8, "zh-TW");
    expect(results[0]!.url).toBe(`${REDIRECT_PREFIX}AAA`);
  });

  it("drops a redirect target that resolves to a private address or a download file", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? {
            status: 302,
            headers: {
              location: call.url.endsWith("AAA")
                ? "http://127.0.0.1:8080/internal"
                : "https://example.com/report.pdf",
            },
          }
        : {
            json: {
              candidates: [
                {
                  groundingMetadata: {
                    groundingChunks: [
                      { web: { uri: `${REDIRECT_PREFIX}AAA`, title: "internal" } },
                      { web: { uri: `${REDIRECT_PREFIX}BBB`, title: "example.com" } },
                    ],
                    groundingSupports: [
                      { segment: { text: "段落。" }, groundingChunkIndices: [0, 1] },
                    ],
                  },
                },
              ],
            },
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("query", 8, "zh-TW");
    // 私有位址解析失敗 → 退回原重導向網址（下游 captureWebPage 仍會自行做安全檢查）；
    // PDF 目標則被 readableWebResult 濾掉。
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe(`${REDIRECT_PREFIX}AAA`);
  });

  it("honours the requested limit", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: `https://example.com/${call.url.slice(-3)}` } }
        : { json: groundedPayload() },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    expect(await provider.search("query", 1, "zh-TW")).toHaveLength(1);
  });

  it("throws GEMINI_WEB_SEARCH_EMPTY when no chunk can be grounded", async () => {
    mockFetch(() => ({
      json: {
        candidates: [
          {
            content: { parts: [{ text: "沒有找到資料。" }] },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: `${REDIRECT_PREFIX}AAA`, title: "udn.com" } }],
              groundingSupports: [],
            },
          },
        ],
      },
    }));
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    await expect(provider.search("query", 8, "zh-TW")).rejects.toMatchObject({
      code: "GEMINI_WEB_SEARCH_EMPTY",
    });
  });

  it("is unavailable without configuration", () => {
    const provider = new GeminiWebSearchProvider({
      config: { baseUrl: "", apiKey: "", timeoutMs: 1_000 },
      model: "",
    });
    expect(provider.availability.status).toBe("unavailable");
  });
});

// ---- ListModels --------------------------------------------------------------

describe("listGeminiModelIds", () => {
  it("strips the models/ prefix and keeps only generateContent-capable models", async () => {
    const calls = mockFetch(() => ({
      json: {
        models: [
          { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/imagen-4.0", supportedGenerationMethods: ["predict"] },
          { name: "models/veo-3", supportedGenerationMethods: ["predictLongRunning"] },
          {
            name: "models/gemini-3.1-flash-image",
            supportedGenerationMethods: ["generateContent"],
          },
          { name: "models/gemini-unknown-methods" },
        ],
      },
    }));
    expect(await listGeminiModelIds(config)).toEqual([
      "gemini-3.1-flash-image",
      "gemini-3.6-flash",
      "gemini-unknown-methods",
    ]);
    expect(calls[0]!.url).toBe("https://gemini.test/v1beta/models?pageSize=200");
    expect(calls[0]!.method).toBe("GET");
  });

  it("maps a transport failure to a Gemini-coded SafeProviderError", async () => {
    mockFetch(() => ({ status: 500, json: { error: { message: "internal" } } }));
    await expect(listGeminiModelIds(config)).rejects.toMatchObject({
      code: "GEMINI_REQUEST_FAILED",
    });
  });
});

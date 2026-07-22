import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SafeProviderError, type ImageGenerationRequest } from "@slide-maker/core";
import {
  type GeminiClientConfig,
  GeminiImageProvider,
  GeminiStructuredTextProvider,
  GeminiWebSearchProvider,
  listGeminiModelIds,
} from "../src/index.js";

/*
 * 邊界與錯誤路徑測試（gemini.test.ts 蓋的是主要 happy path）。
 * 全程 mock fetch，任何一個 case 都不打真實網路。
 */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | null | undefined;
}

interface MockReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** 永不 resolve，直到 request 的 signal 中止才 reject——用來測 abort 與逾時。 */
  hang?: boolean;
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
      signal: init?.signal,
    };
    captured.push(call);
    const reply = handler(call);
    if (reply.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        // 真實 fetch 在 signal 中止時會 reject signal.reason（AbortError／TimeoutError）。
        if (signal.aborted) reject(signal.reason as Error);
        signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
    }
    const payload =
      reply.text !== undefined
        ? reply.text
        : reply.json === undefined
          ? ""
          : JSON.stringify(reply.json);
    return new Response(payload, {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const REAL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
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

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

type Part = { text?: string; inlineData?: { mimeType: string; data: string } };

function requestParts(call: Captured): Part[] {
  const body = call.body as { contents: { parts: Part[] }[] };
  return body.contents[0]!.parts;
}

const imageReply = () => ({
  json: {
    candidates: [
      { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: REAL_JPEG } }] } },
    ],
  },
});

/*
 * 每張參考圖必須是「內容互異」的檔案，否則順序錯位在斷言上看不出來——
 * gemini.test.ts 的順序測試三張圖用的是同一個檔案，換位也照樣通過。
 */
let workdir = "";
const distinctRefs: { path: string; base64: string }[] = [];

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "gemini-edge-"));
  const png = Buffer.from(REAL_PNG, "base64");
  for (let index = 0; index < 3; index += 1) {
    // 在 PNG 尾端補一段互異的 bytes：檔案仍以 PNG magic bytes 開頭，
    // 但 base64 完全不同，足以辨認順序。
    const bytes = Buffer.concat([png, Buffer.from(`ref-${index}`.repeat(4), "utf8")]);
    const path = join(workdir, `ref-${index}.png`);
    await writeFile(path, bytes);
    distinctRefs.push({ path, base64: bytes.toString("base64") });
  }
});

function reference(index: number, role: string, name: string) {
  return {
    path: distinctRefs[index]!.path,
    mediaType: "image/png",
    role,
    name,
  } as unknown as ImageGenerationRequest["references"][number];
}

// ---- 參考圖順序與 Image N 對齊 ------------------------------------------------

describe("reference ordering", () => {
  it("keeps byte-distinct references in manifest order so Image N indexes the right part", async () => {
    const calls = mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await provider.generate({
      ...imageRequest(),
      references: [
        reference(0, "content", "Base slide"),
        reference(1, "content", "Mask"),
        reference(2, "style", "Style A"),
      ],
      edit: {
        instruction: "Remove text",
        baseImageIndex: 0,
        maskImageIndex: 1,
        purpose: "text-removal",
      } as unknown as NonNullable<ImageGenerationRequest["edit"]>,
    });
    const parts = requestParts(calls[0]!);
    // parts[0] 是合約文字，parts[N] 對應 references[N-1]，也就是合約裡的 Image N。
    expect(parts[1]!.inlineData!.data).toBe(distinctRefs[0]!.base64);
    // 遮罩（references[1]）不再是原檔 bytes——會先攤平成不透明黑底的 canvas 尺寸 PNG，
    // 以 canvas 尺寸確認 parts[2] 正是被攤平的那張，順序沒有錯位。
    expect(parts[2]!.inlineData!.data).not.toBe(distinctRefs[1]!.base64);
    expect(pngSize(new Uint8Array(Buffer.from(parts[2]!.inlineData!.data, "base64")))).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(parts[3]!.inlineData!.data).toBe(distinctRefs[2]!.base64);
    const prompt = parts[0]!.text ?? "";
    // 合約說「Image 1 是待編輯的底圖、Image 2 是遮罩」，附加順序必須真的這樣排；
    // 錯位會讓模型把遮罩當成底圖去重繪。
    expect(prompt).toContain("Image 1 is the current slide to edit");
    expect(prompt).toContain("Image 2 is the mask");
  });

  it("rejects an edit whose baseImageIndex points past the reference list", async () => {
    mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await expect(
      provider.generate({
        ...imageRequest(),
        references: [reference(0, "content", "Base slide")],
        edit: {
          instruction: "x",
          baseImageIndex: 3,
          purpose: "refine",
        } as unknown as NonNullable<ImageGenerationRequest["edit"]>,
      }),
    ).rejects.toMatchObject({ code: "GEMINI_IMAGE_BASE_MISSING" });
  });

  it("rejects an edit whose maskImageIndex points past the reference list", async () => {
    mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await expect(
      provider.generate({
        ...imageRequest(),
        references: [reference(0, "content", "Base slide")],
        edit: {
          instruction: "x",
          baseImageIndex: 0,
          maskImageIndex: 5,
          purpose: "text-removal",
        } as unknown as NonNullable<ImageGenerationRequest["edit"]>,
      }),
    ).rejects.toMatchObject({ code: "GEMINI_IMAGE_MASK_MISSING" });
  });

  it("refuses more references than the transport limit instead of silently dropping them", async () => {
    const calls = mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await expect(
      provider.generate({
        ...imageRequest(),
        references: Array.from({ length: 9 }, (_, index) =>
          reference(index % 3, "style", `S${index}`),
        ),
      }),
    ).rejects.toMatchObject({ code: "GEMINI_IMAGE_REFERENCES_LIMIT" });
    expect(calls).toHaveLength(0);
  });
});

// ---- part 解析：thoughtSignature 與混合 part ---------------------------------

describe("part parsing", () => {
  it("skips text and empty inlineData parts and takes the first real image", async () => {
    mockFetch(() => ({
      json: {
        candidates: [
          {
            content: {
              parts: [
                { text: "先說明一下…", thoughtSignature: "sig-a" },
                { inlineData: { mimeType: "image/png", data: "" } },
                { inlineData: { mimeType: "image/jpeg", data: REAL_JPEG }, thoughtSignature: "b" },
                { inlineData: { mimeType: "image/png", data: REAL_PNG } },
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

  it("survives a null entry in parts instead of throwing a raw TypeError", async () => {
    // JSON 沒有型別保證：null part 會讓 `part.inlineData` 丟 TypeError，那不是
    // SafeProviderError，一路冒到 express 就是 500。
    mockFetch(() => ({
      json: {
        candidates: [
          {
            content: {
              parts: [null, "字串", { inlineData: { mimeType: "image/jpeg", data: REAL_JPEG } }],
            },
          },
        ],
      },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    expect(pngSize((await provider.generate(imageRequest())).bytes)).toEqual({
      width: 1920,
      height: 1080,
    });

    mockFetch(() => ({
      json: { candidates: [{ content: { parts: [null, { text: "{}" }] } }] },
    }));
    const text = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    expect(await text.runStructured({ prompt: "hi", outputSchema: {} })).toEqual({});
  });

  it("ignores candidates beyond the first and an absent content object", async () => {
    mockFetch(() => ({
      json: {
        candidates: [
          { finishReason: "SAFETY" },
          { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: REAL_JPEG } }] } },
        ],
      },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "GEMINI_IMAGE_MISSING",
    });
  });

  it("concatenates only text keys when a candidate mixes text and inlineData", async () => {
    mockFetch(() => ({
      json: {
        candidates: [
          {
            content: {
              parts: [
                { text: '{"a":1,', thoughtSignature: "sig" },
                { inlineData: { mimeType: "image/png", data: REAL_PNG } },
                { text: '"b":2}' },
              ],
            },
          },
        ],
      },
    }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    expect(await provider.runStructured({ prompt: "hi", outputSchema: {} })).toEqual({
      a: 1,
      b: 2,
    });
  });
});

// ---- 影像正規化尺寸 -----------------------------------------------------------

describe("image normalisation", () => {
  it("normalises a JPEG to exactly the requested canvas, not the model's own size", async () => {
    mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const image = await provider.generate({ ...imageRequest(), width: 1280, height: 720 });
    expect(pngSize(image.bytes)).toEqual({ width: 1280, height: 720 });
    expect(image.mediaType).toBe("image/png");
    // PNG magic bytes：確定真的換了容器，不是把 JPEG 原封不動貼上 png mediaType。
    expect(Array.from(image.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("normalises whichever mime type the model declares (png as well as jpeg)", async () => {
    // 2026-07-22 實測：gemini-2.5-flash-image 回 image/png，其餘三個影像模型回
    // image/jpeg。寫死任一種都會在另一種上壞掉，故一律讀 inlineData.mimeType。
    for (const [mimeType, data] of [
      ["image/png", REAL_PNG],
      ["image/jpeg", REAL_JPEG],
    ] as const) {
      mockFetch(() => ({
        json: { candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] },
      }));
      const provider = new GeminiImageProvider({ config, model: "gemini-2.5-flash-image" });
      const image = await provider.generate(imageRequest());
      expect(pngSize(image.bytes)).toEqual({ width: 1920, height: 1080 });
      expect(image.mediaType).toBe("image/png");
    }
  });

  it("omits imageConfig when the canvas is not 16:9", async () => {
    const calls = mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    await provider.generate({ ...imageRequest(), width: 1080, height: 1080 });
    const body = calls[0]!.body as { generationConfig: { imageConfig?: unknown } };
    expect(body.generationConfig.imageConfig).toBeUndefined();
  });

  it("reports an unsupported inline mime type as a Gemini error, never an OPENAI_ code", async () => {
    mockFetch(() => ({
      json: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: "image/gif", data: REAL_PNG } }] } },
        ],
      },
    }));
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const error = (await provider
      .generate(imageRequest())
      .catch((reason: unknown) => reason)) as SafeProviderError;
    expect(error).toBeInstanceOf(SafeProviderError);
    expect(error.code).toBe("GEMINI_IMAGE_INVALID");
    expect(error.code.startsWith("OPENAI_")).toBe(false);
  });

  it("reports an unreadable reference file as a Gemini error, never an OPENAI_ code", async () => {
    const bad = join(workdir, "not-an-image.png");
    await writeFile(bad, "plain text, no magic bytes");
    mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const error = (await provider
      .generate({
        ...imageRequest(),
        references: [
          {
            path: bad,
            mediaType: "image/png",
            role: "style",
            name: "bad",
          } as unknown as ImageGenerationRequest["references"][number],
        ],
      })
      .catch((reason: unknown) => reason)) as SafeProviderError;
    expect(error).toBeInstanceOf(SafeProviderError);
    expect(error.code).toBe("GEMINI_IMAGE_INPUT_INVALID");
  });

  it("does not leak the file path when the reference cannot be opened at all", async () => {
    // `open(…, O_NOFOLLOW)` 失敗丟的是原生 fs 錯誤，message 帶完整路徑；那不是
    // SafeProviderError，原樣往上丟等於把伺服器路徑寫進 API 回應。
    const missing = join(workdir, "no-such-dir", "ghost.png");
    mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const error = (await provider
      .generate({
        ...imageRequest(),
        references: [
          {
            path: missing,
            mediaType: "image/png",
            role: "style",
            name: "ghost",
          } as unknown as ImageGenerationRequest["references"][number],
        ],
      })
      .catch((reason: unknown) => reason)) as SafeProviderError;
    expect(error).toBeInstanceOf(SafeProviderError);
    expect(error.code).toBe("GEMINI_IMAGE_INPUT_INVALID");
    expect(error.message).not.toContain(workdir);
    expect(error.safeMessage).not.toContain(workdir);
  });
});

// ---- 傳輸層錯誤分類 -----------------------------------------------------------

describe("transport error classification", () => {
  it("maps 403 to auth required", async () => {
    mockFetch(() => ({ status: 403, json: { error: { message: "PERMISSION_DENIED for key" } } }));
    await expect(listGeminiModelIds(config)).rejects.toMatchObject({
      code: "GEMINI_AUTH_REQUIRED",
    });
  });

  it("maps a request timeout to GEMINI_TIMEOUT", async () => {
    mockFetch(() => ({ hang: true }));
    const error = (await listGeminiModelIds({ ...config, timeoutMs: 30 }).catch(
      (reason: unknown) => reason,
    )) as SafeProviderError;
    expect(error).toBeInstanceOf(SafeProviderError);
    expect(error.code).toBe("GEMINI_TIMEOUT");
  });

  it("rejects an over-sized response declared by content-length", async () => {
    mockFetch(() => ({
      json: { models: [] },
      headers: { "content-length": String(64 * 1024 * 1024) },
    }));
    await expect(listGeminiModelIds(config)).rejects.toMatchObject({
      code: "GEMINI_RESPONSE_TOO_LARGE",
    });
  });

  it("rejects a 200 body that is not JSON", async () => {
    mockFetch(() => ({ text: "<html>gateway</html>" }));
    await expect(listGeminiModelIds(config)).rejects.toMatchObject({
      code: "GEMINI_RESPONSE_INVALID",
    });
  });

  it("never lets an OPENAI_ prefixed code escape on any gemini path", async () => {
    for (const reply of [
      { status: 401, json: { error: {} } },
      { status: 500, json: { error: {} } },
      { text: "not json" },
    ] as MockReply[]) {
      mockFetch(() => reply);
      const error = (await listGeminiModelIds(config).catch(
        (reason: unknown) => reason,
      )) as SafeProviderError;
      expect(error).toBeInstanceOf(SafeProviderError);
      expect(error.code.startsWith("GEMINI_")).toBe(true);
    }
  });

  it("returns an empty list rather than throwing when ListModels omits the models key", async () => {
    mockFetch(() => ({ json: {} }));
    expect(await listGeminiModelIds(config)).toEqual([]);
  });

  it("strips a models/ prefix from the configured model name and url-encodes it", async () => {
    const calls = mockFetch(imageReply);
    const provider = new GeminiImageProvider({ config, model: " models/gemini-3.1-flash-image " });
    await provider.generate(imageRequest());
    expect(calls[0]!.url).toBe(
      "https://gemini.test/v1beta/models/gemini-3.1-flash-image:generateContent",
    );
  });

  it("classifies a preflight 401 as auth_required and a hung endpoint as timeout", async () => {
    mockFetch(() => ({ status: 401, json: {} }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    expect(await provider.preflight()).toEqual({ status: "auth_required" });

    mockFetch(() => ({ hang: true }));
    const slow = new GeminiStructuredTextProvider({
      config: { ...config, timeoutMs: 30 },
      model: "gemini-3.6-flash",
    });
    expect(await slow.preflight()).toEqual({ status: "timeout" });
  });
});

// ---- abort ------------------------------------------------------------------

describe("cancellation", () => {
  it("aborts an in-flight image request when the caller's signal fires", async () => {
    mockFetch(() => ({ hang: true }));
    const controller = new AbortController();
    const provider = new GeminiImageProvider({ config, model: "gemini-3.1-flash-image" });
    const pending = provider.generate(imageRequest(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = (await pending.catch((reason: unknown) => reason)) as Error;
    expect(error.name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(SafeProviderError);
  });

  it("aborts an in-flight structured text request without burning the retry budget", async () => {
    const calls = mockFetch(() => ({ hang: true }));
    const controller = new AbortController();
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    const pending = provider.runStructured({
      prompt: "hi",
      outputSchema: {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const error = (await pending.catch((reason: unknown) => reason)) as Error;
    expect(error.name).toBe("AbortError");
    // 取消不是暫時性錯誤：不得重試。
    expect(calls).toHaveLength(1);
  });

  it("aborts an in-flight search request", async () => {
    mockFetch(() => ({ hang: true }));
    const controller = new AbortController();
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const pending = provider.search("q", 3, "zh-TW", controller.signal);
    setTimeout(() => controller.abort(), 10);
    const error = (await pending.catch((reason: unknown) => reason)) as Error;
    expect(error.name).toBe("AbortError");
  });
});

// ---- structured text 重試策略 --------------------------------------------------

describe("structured text retry policy", () => {
  it("gives up after exactly three attempts when every response is unparseable", async () => {
    const calls = mockFetch(() => ({
      json: { candidates: [{ content: { parts: [{ text: "純文字，不是 JSON" }] } }] },
    }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    await expect(provider.runStructured({ prompt: "hi", outputSchema: {} })).rejects.toMatchObject({
      code: "GEMINI_RESPONSE_INVALID",
    });
    expect(calls).toHaveLength(3);
  });

  it("does not retry a non-transient transport failure", async () => {
    const calls = mockFetch(() => ({ status: 429, json: { error: {} } }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    await expect(provider.runStructured({ prompt: "hi", outputSchema: {} })).rejects.toMatchObject({
      code: "GEMINI_USAGE_LIMIT",
    });
    expect(calls).toHaveLength(1);
  });

  it("sends imagePaths as inlineData parts after the prompt", async () => {
    const calls = mockFetch(() => ({
      json: { candidates: [{ content: { parts: [{ text: "{}" }] } }] },
    }));
    const provider = new GeminiStructuredTextProvider({ config, model: "gemini-3.6-flash" });
    await provider.runStructured({
      prompt: "describe",
      outputSchema: {},
      imagePaths: [distinctRefs[1]!.path, distinctRefs[2]!.path],
    });
    const parts = requestParts(calls[0]!);
    expect(parts[0]!.text).toBe("describe");
    expect(parts[1]!.inlineData!.data).toBe(distinctRefs[1]!.base64);
    expect(parts[2]!.inlineData!.data).toBe(distinctRefs[2]!.base64);
  });
});

// ---- grounding 聚合與重導向 ----------------------------------------------------

const REDIRECT_PREFIX = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

function grounded(chunks: unknown[], supports: unknown[]): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: "briefing" }] },
        groundingMetadata: { groundingChunks: chunks, groundingSupports: supports },
      },
    ],
  };
}

describe("grounding aggregation", () => {
  it("de-duplicates a segment that supports the same chunk twice", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "https://udn.com/a" } }
        : {
            json: grounded(
              [{ web: { uri: `${REDIRECT_PREFIX}A`, title: "udn.com" } }],
              [
                { segment: { text: "同一段。" }, groundingChunkIndices: [0] },
                { segment: { text: "同一段。" }, groundingChunkIndices: [0] },
                { segment: { text: "另一段。" }, groundingChunkIndices: [0] },
              ],
            ),
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results[0]!.summary).toBe("同一段。\n另一段。");
  });

  it("truncates an aggregated summary to the 4000-char schema ceiling", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "https://udn.com/a" } }
        : {
            json: grounded(
              [{ web: { uri: `${REDIRECT_PREFIX}A`, title: "udn.com" } }],
              Array.from({ length: 20 }, (_, index) => ({
                segment: { text: `${index}`.padEnd(500, "字") },
                groundingChunkIndices: [0],
              })),
            ),
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    // 沒有截斷就會撞上 webSearchResultSchema 的 max(4000)，整筆被 safeParse 丟掉。
    expect(results).toHaveLength(1);
    expect(results[0]!.summary.length).toBeLessThanOrEqual(4_000);
    expect(results[0]!.summary.length).toBeGreaterThan(3_900);
  });

  it("ignores support indices that point at no chunk and chunks with a blank title", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: `https://example.com/${call.url.slice(-1)}` } }
        : {
            json: grounded(
              [
                { web: { uri: `${REDIRECT_PREFIX}A` } },
                { web: { uri: `${REDIRECT_PREFIX}B`, title: "example.com" } },
              ],
              [
                { segment: { text: "段落。" }, groundingChunkIndices: [0, 1, 7, -1, "x"] },
                { segment: {}, groundingChunkIndices: [1] },
                { groundingChunkIndices: [1] },
              ],
            ),
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    // 第一筆沒有 title → 過不了 schema(min 1) → 捨棄，而不是整批爆掉。
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("example.com");
  });

  it("returns exactly `limit` results and bounds how many redirects it resolves", async () => {
    const chunks = Array.from({ length: 5 }, (_, index) => ({
      web: { uri: `${REDIRECT_PREFIX}${index}`, title: `site${index}.com` },
    }));
    const supports = chunks.map((_, index) => ({
      segment: { text: `段落 ${index}。` },
      groundingChunkIndices: [index],
    }));
    const calls = mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: `https://site.example/${call.url.slice(-1)}` } }
        : { json: grounded(chunks, supports) },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    expect(await provider.search("q", 2, "zh-TW")).toHaveLength(2);
    // 重導向改成一次併發解完（序列化 × 上游重試會累積成數百秒），所以解析數不再等於
    // limit：上限是 limit 的兩倍，留餘裕給「解開後其實是同一頁」而被去重掉的候選。
    expect(calls.filter((call) => call.url.startsWith(REDIRECT_PREFIX))).toHaveLength(4);
  });

  it("collapses chunks that resolve to the same page and merges their summaries", async () => {
    // 同一篇文章被兩段引用 → 兩個 chunk、兩個中繼網址，解開後是同一個真實網址。
    const chunks = [
      { web: { uri: `${REDIRECT_PREFIX}A`, title: "udn.com" } },
      { web: { uri: `${REDIRECT_PREFIX}B`, title: "udn.com" } },
      { web: { uri: `${REDIRECT_PREFIX}C`, title: "cna.com.tw" } },
    ];
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? {
            status: 302,
            headers: {
              location: call.url.endsWith("C")
                ? "https://cna.com.tw/story/2"
                : "https://udn.com/story/1",
            },
          }
        : {
            json: grounded(chunks, [
              { segment: { text: "第一段。" }, groundingChunkIndices: [0] },
              { segment: { text: "第二段。" }, groundingChunkIndices: [1] },
              { segment: { text: "第三段。" }, groundingChunkIndices: [2] },
            ]),
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results.map((result) => result.url)).toEqual([
      "https://udn.com/story/1",
      "https://cna.com.tw/story/2",
    ]);
    // 重複頁面的摘要併入同一筆，而不是變成兩筆一模一樣的來源。
    expect(results[0]!.summary).toBe("第一段。\n第二段。");
  });

  it("drops a chunk whose uri is itself unsafe instead of passing it downstream", async () => {
    // 起點就不是可對外請求的網址：退回原 uri 會讓下游 captureWebPage 直接 throw
    // （safePublicUrl 在 try 之外），整個大綱生成回 500，所以這一筆必須整個捨棄。
    for (const uri of ["file:///etc/passwd", "http://169.254.169.254/latest/meta-data/"]) {
      const calls = mockFetch(() => ({
        json: grounded(
          [{ web: { uri, title: "evil" } }],
          [{ segment: { text: "段落。" }, groundingChunkIndices: [0] }],
        ),
      }));
      const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
      await expect(provider.search("q", 5, "zh-TW")).rejects.toMatchObject({
        code: "GEMINI_WEB_SEARCH_EMPTY",
      });
      // 也不該對它發任何請求：generateContent 一次就是全部。
      expect(calls).toHaveLength(1);
    }
  });

  it("keeps a safe chunk when a sibling chunk is unsafe", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "https://ok.example/a" } }
        : {
            json: grounded(
              [
                { web: { uri: "http://10.0.0.1/internal", title: "internal" } },
                { web: { uri: `${REDIRECT_PREFIX}A`, title: "ok.example" } },
              ],
              [
                { segment: { text: "內網段落。" }, groundingChunkIndices: [0] },
                { segment: { text: "公開段落。" }, groundingChunkIndices: [1] },
              ],
            ),
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results.map((result) => result.url)).toEqual(["https://ok.example/a"]);
  });

  it("marks a segment that supports several chunks as shared, not as each page's own summary", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: `https://site-${call.url.slice(-1)}.example/x` } }
        : {
            json: grounded(
              [
                { web: { uri: `${REDIRECT_PREFIX}A`, title: "a.example" } },
                { web: { uri: `${REDIRECT_PREFIX}B`, title: "b.example" } },
              ],
              [
                { segment: { text: "兩家都支撐的話。" }, groundingChunkIndices: [0, 1] },
                { segment: { text: "只有 A 支撐的話。" }, groundingChunkIndices: [0] },
              ],
            ),
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results[0]!.summary).toBe("只有 A 支撐的話。\n（多來源共同支撐）兩家都支撐的話。");
    expect(results[1]!.summary).toBe("（多來源共同支撐）兩家都支撐的話。");
  });

  it("uses HEAD so a 200 redirect target never streams a body", async () => {
    const calls = mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "https://udn.com/a" } }
        : {
            json: grounded(
              [{ web: { uri: `${REDIRECT_PREFIX}A`, title: "udn.com" } }],
              [{ segment: { text: "段落。" }, groundingChunkIndices: [0] }],
            ),
          },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    await provider.search("q", 5, "zh-TW");
    expect(calls.find((call) => call.url.startsWith(REDIRECT_PREFIX))!.method).toBe("HEAD");
  });

  it("throws the empty error instead of returning nothing when grounding metadata is absent", async () => {
    mockFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: "沒有引用。" }] } }] } }));
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    await expect(provider.search("q", 5, "zh-TW")).rejects.toMatchObject({
      code: "GEMINI_WEB_SEARCH_EMPTY",
    });
  });
});

describe("redirect resolution", () => {
  const singleChunk = () =>
    grounded(
      [{ web: { uri: `${REDIRECT_PREFIX}A`, title: "udn.com" } }],
      [{ segment: { text: "段落。" }, groundingChunkIndices: [0] }],
    );

  it("resolves a 302 to its absolute location", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "https://udn.com/news/story/7266/9487252" } }
        : { json: singleChunk() },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results[0]!.url).toBe("https://udn.com/news/story/7266/9487252");
  });

  it("resolves a relative location against the redirect origin", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "/real/article" } }
        : { json: singleChunk() },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results[0]!.url).toBe("https://vertexaisearch.cloud.google.com/real/article");
  });

  it("keeps the original uri when a 3xx carries no location header", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX) ? { status: 302 } : { json: singleChunk() },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results[0]!.url).toBe(`${REDIRECT_PREFIX}A`);
  });

  it("refuses a non-http(s) redirect target and keeps the original uri", async () => {
    mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "file:///etc/passwd" } }
        : { json: singleChunk() },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results[0]!.url).toBe(`${REDIRECT_PREFIX}A`);
  });

  it("refuses a redirect target on a private network and keeps the original uri", async () => {
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/admin",
      "http://[::1]:9000/",
      "http://internal.local/secret",
    ]) {
      mockFetch((call) =>
        call.url.startsWith(REDIRECT_PREFIX)
          ? { status: 302, headers: { location: target } }
          : { json: singleChunk() },
      );
      const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
      const results = await provider.search("q", 5, "zh-TW");
      expect(results[0]!.url).toBe(`${REDIRECT_PREFIX}A`);
    }
  });

  it("follows at most one hop, so a self-referential redirect cannot loop", async () => {
    const calls = mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX) || call.url.startsWith("https://loop.example")
        ? { status: 302, headers: { location: "https://loop.example/next" } }
        : { json: singleChunk() },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    const results = await provider.search("q", 5, "zh-TW");
    expect(results[0]!.url).toBe("https://loop.example/next");
    // generateContent 一次 + redirect 一次；不得對 loop.example 再發第二次。
    expect(calls).toHaveLength(2);
  });

  it("does not follow the redirect automatically (manual mode) and does not send the api key", async () => {
    const calls = mockFetch((call) =>
      call.url.startsWith(REDIRECT_PREFIX)
        ? { status: 302, headers: { location: "https://udn.com/a" } }
        : { json: singleChunk() },
    );
    const provider = new GeminiWebSearchProvider({ config, model: "gemini-3.6-flash" });
    await provider.search("q", 5, "zh-TW");
    const redirectCall = calls.find((call) => call.url.startsWith(REDIRECT_PREFIX))!;
    // grounding 網址是第三方端點：絕不可把 AI Studio 金鑰一起送出去。
    expect(redirectCall.headers).not.toHaveProperty("x-goog-api-key");
  });
});

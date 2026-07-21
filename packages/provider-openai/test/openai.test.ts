import { writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeProviderError, type ImageGenerationRequest } from "@slide-maker/core";
import {
  type OpenAiClientConfig,
  OpenAiCompatibleImageProvider,
  OpenAiStructuredTextProvider,
  OpenAiWebSearchProvider,
} from "../src/index.js";

// ---- minimal valid PNG builder (structure only; not real pixels) --------------

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

function png(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])),
    chunk("IEND", new Uint8Array()),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---- fake OpenAI-compatible server -------------------------------------------

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

interface FakeServer {
  config: OpenAiClientConfig;
  requests: Captured[];
  server: Server;
}

type Responder = (captured: Captured) => { status: number; json: unknown };

async function startFake(responder: Responder): Promise<FakeServer> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (part: Buffer) => chunks.push(part));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const captured: Captured = { method: req.method ?? "", path: req.url ?? "", body };
      requests.push(captured);
      const result = responder(captured);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.json));
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

describe("OpenAiCompatibleImageProvider", () => {
  it("posts to /images/generations and returns a validated canvas PNG", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-1",
    });
    const image = await provider.generate(imageRequest());
    expect(image.mediaType).toBe("image/png");
    expect(image.extension).toBe("png");
    expect(image.model).toBe("gpt-image-1");
    expect(image.parameters.transport).toBe("openai-images");
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    const call = active.requests[0]!;
    expect(call.path).toBe("/v1/images/generations");
    expect((call.body as { response_format?: string }).response_format).toBe("b64_json");
    expect((call.body as { model?: string }).model).toBe("gpt-image-1");
    const prompt = (call.body as { prompt?: string }).prompt ?? "";
    expect(prompt).toContain("左文右圖");
    expect(prompt).toContain("明亮留白");
    expect(prompt).toContain("以 {subject} 為主體");
    expect(prompt).toContain("UNTRUSTED_PRESENTATION_JSON");
  });

  it("is unavailable without configuration", () => {
    const provider = new OpenAiCompatibleImageProvider({
      config: { baseUrl: "", apiKey: "", timeoutMs: 1_000 },
      model: "",
    });
    expect(provider.availability.status).toBe("unavailable");
  });

  it("generates via chat completions (Gemini) and normalizes message.images to canvas PNG", async () => {
    // real 8x8 PNG so resvg can decode + re-render to the canvas size
    const realPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              images: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${realPng}` } },
              ],
            },
          },
        ],
      },
    }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gemini-3.1-flash-image",
      apiShape: "chat",
    });
    const image = await provider.generate(imageRequest());
    expect(image.mediaType).toBe("image/png");
    expect(image.parameters.transport).toBe("openai-chat");
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    expect(active.requests[0]!.path).toBe("/v1/chat/completions");
  });

  it("chat shape sends the Codex-baseline contract and labelled references", async () => {
    const realPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
    const refPath = join(tmpdir(), `openai-ref-${process.pid}.png`);
    await writeFile(refPath, Buffer.from(realPng, "base64"));
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              images: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${realPng}` } },
              ],
            },
          },
        ],
      },
    }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gemini-3.1-flash-image",
      apiShape: "chat",
    });
    expect(provider.capabilities.referenceImages).toBe(true);
    expect(provider.capabilities.multipleReferenceImages).toBe(true);
    const request = {
      ...imageRequest(),
      references: [
        { path: refPath, mediaType: "image/png", role: "style" as const, name: "Style A" },
        {
          path: refPath,
          mediaType: "image/png",
          role: "direct-asset" as const,
          name: "Source panel",
        },
      ],
    };
    await provider.generate(request);
    const body = active.requests[0]!.body as { messages: { content: unknown[] }[] };
    const parts = body.messages[0]!.content as { type: string; text?: string }[];
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(2);
    const prompt = parts[0]!.text ?? "";
    expect(prompt).toContain("slide.content field is the authoritative visible copy");
    expect(prompt).toContain('role=style; name="Style A"');
    expect(prompt).toContain('role=direct-asset; name="Source panel"');
    expect(prompt).toContain("DIRECT-ASSET FIDELITY CONTRACT");
    expect(prompt).toContain('"layoutHint": "左文右圖"');
    expect(prompt).toContain('"description": "明亮留白"');
    expect(prompt).toContain('"promptTemplate": "以 {subject} 為主體"');
  });

  it("chat edits attach base, mask, and supplemental references in manifest order", async () => {
    const realPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
    const refPath = join(tmpdir(), `openai-edit-ref-${process.pid}.png`);
    await writeFile(refPath, Buffer.from(realPng, "base64"));
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              images: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${realPng}` } },
              ],
            },
          },
        ],
      },
    }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-5.6-terra",
      apiShape: "chat",
    });
    await provider.generate({
      ...imageRequest(),
      references: [
        { path: refPath, mediaType: "image/png", role: "content", name: "Current slide" },
        { path: refPath, mediaType: "image/png", role: "content", name: "Mask" },
        { path: refPath, mediaType: "image/png", role: "style", name: "Style A" },
      ],
      edit: {
        instruction: "Remove text",
        baseImageIndex: 0,
        maskImageIndex: 1,
        purpose: "text-removal",
      },
    });
    const body = active.requests[0]!.body as { messages: { content: unknown[] }[] };
    const parts = body.messages[0]!.content as { type: string; text?: string }[];
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(3);
    expect(parts[0]!.text).toContain("TEXT REMOVAL CONTRACT");
    expect(parts[0]!.text).toContain('role=style; name="Style A"');
    expect(parts[0]!.text).toContain("Do not re-render text from slide.content");
  });

  it("images shape reaches /images/edits with intrinsic base and mask inputs", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    const refPath = join(tmpdir(), `openai-native-edit-${process.pid}.png`);
    await writeFile(refPath, Buffer.from(b64, "base64"));
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
      apiShape: "images",
    });
    await provider.generate({
      ...imageRequest(),
      references: [
        { path: refPath, mediaType: "image/png", role: "content", name: "Current slide" },
        { path: refPath, mediaType: "image/png", role: "content", name: "Mask" },
      ],
      edit: { instruction: "Change the circle to green", baseImageIndex: 0, maskImageIndex: 1 },
    });
    expect(active.requests[0]!.path).toBe("/v1/images/edits");
    expect(String(active.requests[0]!.body)).toContain("This is an image editing task");
  });

  it("images shape declares reference-image support (via /images/edits image[])", () => {
    const provider = new OpenAiCompatibleImageProvider({
      config: { baseUrl: "http://x", apiKey: "k", timeoutMs: 1_000 },
      model: "gpt-image-2",
    });
    expect(provider.capabilities.referenceImages).toBe(true);
    expect(provider.capabilities.multipleReferenceImages).toBe(true);
  });

  it("images shape routes reference-image generation through /images/edits image[]", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    const refPath = join(tmpdir(), `openai-images-ref-${process.pid}.png`);
    await writeFile(refPath, Buffer.from(b64, "base64"));
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
      apiShape: "images",
    });
    const image = await provider.generate({
      ...imageRequest(),
      references: [
        { path: refPath, mediaType: "image/png", role: "style", name: "Style A" },
        { path: refPath, mediaType: "image/png", role: "style", name: "Style B" },
      ],
    });
    expect(image.parameters.transport).toBe("openai-images");
    // 有參考圖的生成走 /images/edits + image[] 陣列（gpt-image 官方參考圖生成用法）。
    expect(active.requests[0]!.path).toBe("/v1/images/edits");
    const body = String(active.requests[0]!.body);
    expect(body).toContain('name="image[]"');
  });

  it("images shape without references still uses /images/generations", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
      apiShape: "images",
    });
    await provider.generate(imageRequest());
    expect(active.requests[0]!.path).toBe("/v1/images/generations");
  });

  it("openrouter shape posts to /images with data[].b64_json and normalizes to canvas PNG", async () => {
    // OpenRouter 影像端點回 jpeg；provider 應轉成 canvas 尺寸 PNG。
    const jpegB64 =
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    active = await startFake(() => ({
      status: 200,
      json: { data: [{ b64_json: jpegB64, media_type: "image/jpeg" }] },
    }));
    const provider = new OpenAiCompatibleImageProvider({
      config: { ...active.config, baseUrl: `${active.config.baseUrl}/images` },
      model: "x-ai/grok-imagine-image-quality",
      apiShape: "openrouter-image",
    });
    const image = await provider.generate(imageRequest());
    expect(image.mediaType).toBe("image/png");
    expect(image.parameters.transport).toBe("openrouter-image");
    expect(image.parameters.size).toBeUndefined();
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    const call = active.requests[0]!;
    expect(call.path).toBe("/v1/images");
    expect((call.body as { model?: string }).model).toBe("x-ai/grok-imagine-image-quality");
    // 無參考圖時不帶 input_references。
    expect(call.body).not.toHaveProperty("input_references");
    const prompt = (call.body as { prompt?: string }).prompt ?? "";
    expect(prompt).toContain("UNTRUSTED_PRESENTATION_JSON");
  });

  it("openrouter shape sends references through input_references (image_url data URLs)", async () => {
    const realPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
    const refPath = join(tmpdir(), `openrouter-ref-${process.pid}.png`);
    await writeFile(refPath, Buffer.from(realPng, "base64"));
    // 回應圖走 canvas 尺寸 PNG，避免觸發 normalizePngToCanvas 的最小尺寸限制。
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    active = await startFake(() => ({
      status: 200,
      json: { data: [{ b64_json: b64, media_type: "image/png" }] },
    }));
    const provider = new OpenAiCompatibleImageProvider({
      config: { ...active.config, baseUrl: `${active.config.baseUrl}/images` },
      model: "x-ai/grok-imagine-image-quality",
      apiShape: "openrouter-image",
    });
    await provider.generate({
      ...imageRequest(),
      references: [
        { path: refPath, mediaType: "image/png", role: "style" as const, name: "Style A" },
        { path: refPath, mediaType: "image/png", role: "direct-asset" as const, name: "Panel" },
      ],
    });
    const body = active.requests[0]!.body as {
      input_references?: { type: string; image_url: { url: string } }[];
    };
    expect(body.input_references).toHaveLength(2);
    expect(body.input_references![0]!.type).toBe("image_url");
    expect(body.input_references![0]!.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("openrouter shape maps HTTP 429 to a usage-limit SafeProviderError", async () => {
    active = await startFake(() => ({ status: 429, json: { error: "rate limited" } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: { ...active.config, baseUrl: `${active.config.baseUrl}/images` },
      model: "x-ai/grok-imagine-image-quality",
      apiShape: "openrouter-image",
    });
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "OPENAI_USAGE_LIMIT",
    });
  });

  it("maps HTTP 401 to an auth SafeProviderError without leaking the body", async () => {
    active = await startFake(() => ({ status: 401, json: { error: "secret detail" } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-1",
    });
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "OPENAI_AUTH_REQUIRED",
    });
    await expect(provider.generate(imageRequest())).rejects.toBeInstanceOf(SafeProviderError);
  });

  it("preflight reports ready when /models responds", async () => {
    active = await startFake(() => ({ status: 200, json: { data: [] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-1",
    });
    expect(await provider.preflight()).toEqual({ status: "ready" });
  });
});

describe("OpenAiStructuredTextProvider", () => {
  it("requests json_schema output and returns the parsed object", async () => {
    active = await startFake(() => ({
      status: 200,
      json: { choices: [{ message: { content: JSON.stringify({ ok: true, items: [1, 2] }) } }] },
    }));
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gpt-5" });
    const result = await provider.runStructured({
      prompt: "hi",
      outputSchema: { type: "object" },
    });
    expect(result).toEqual({ ok: true, items: [1, 2] });
    const call = active.requests[0]!;
    expect(call.path).toBe("/v1/chat/completions");
    const body = call.body as { response_format?: { type?: string }; messages?: unknown[] };
    expect(body.response_format?.type).toBe("json_schema");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("parses JSON wrapped in a ```json markdown fence (non-strict gateways)", async () => {
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [{ message: { content: '```json\n{ "value": 42 }\n```' } }],
      },
    }));
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gemini" });
    expect(await provider.runStructured({ prompt: "hi", outputSchema: {} })).toEqual({ value: 42 });
  });

  it("retries transient non-JSON responses and eventually succeeds", async () => {
    let call = 0;
    active = await startFake(() => {
      call += 1;
      const content = call < 3 ? "sorry, here is my analysis..." : JSON.stringify({ ok: true });
      return { status: 200, json: { choices: [{ message: { content } }] } };
    });
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gemini" });
    expect(await provider.runStructured({ prompt: "hi", outputSchema: {} })).toEqual({ ok: true });
    expect(active.requests.length).toBe(3);
  });

  it("rejects a non-JSON content payload with a SafeProviderError", async () => {
    active = await startFake(() => ({
      status: 200,
      json: { choices: [{ message: { content: "not json" } }] },
    }));
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gpt-5" });
    await expect(provider.runStructured({ prompt: "hi", outputSchema: {} })).rejects.toBeInstanceOf(
      SafeProviderError,
    );
  });
});

describe("OpenAiWebSearchProvider", () => {
  it("parses results and drops non-HTML download links", async () => {
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [
                  { url: "https://example.com/a", title: "A", summary: "sa" },
                  { url: "https://example.com/report.pdf", title: "B", summary: "sb" },
                ],
              }),
            },
          },
        ],
      },
    }));
    const provider = new OpenAiWebSearchProvider({ config: active.config, model: "gpt-5-search" });
    const results = await provider.search("query", 8, "zh-TW");
    expect(results).toEqual([{ url: "https://example.com/a", title: "A", summary: "sa" }]);
    const body = active.requests[0]!.body as { tools?: { type?: string }[] };
    expect(body.tools?.[0]?.type).toBe("web_search");
  });

  it("uses CLIProxyAPI google_search for Gemini and accepts a top-level result array", async () => {
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify([
                { url: "https://example.com/gemini", title: "Gemini", summary: "grounded" },
              ]),
            },
          },
        ],
      },
    }));
    const provider = new OpenAiWebSearchProvider({
      config: active.config,
      model: "gemini-3-flash-agent",
    });

    await expect(provider.search("query", 8, "zh-TW")).resolves.toEqual([
      { url: "https://example.com/gemini", title: "Gemini", summary: "grounded" },
    ]);
    const body = active.requests[0]!.body as {
      tools?: { google_search?: object }[];
      tool_choice?: unknown;
    };
    expect(body.tools?.[0]?.google_search).toEqual({});
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("rejects a search response without valid result rows", async () => {
    active = await startFake(() => ({
      status: 200,
      json: { choices: [{ message: { content: JSON.stringify({ results: [] }) } }] },
    }));
    const provider = new OpenAiWebSearchProvider({ config: active.config, model: "gemini" });
    await expect(provider.search("query", 8, "zh-TW")).rejects.toMatchObject({
      code: "OPENAI_WEB_SEARCH_EMPTY",
    });
  });

  it("is unavailable without configuration", () => {
    const provider = new OpenAiWebSearchProvider({
      config: { baseUrl: "", apiKey: "", timeoutMs: 1_000 },
      model: "",
    });
    expect(provider.availability.status).toBe("unavailable");
  });
});

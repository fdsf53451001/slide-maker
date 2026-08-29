import { rm, symlink, writeFile } from "node:fs/promises";
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
  extractOpenRouterImage,
  flattenMaskToBlack,
  maskAwareDataUrl,
  IMAGE_OPTION_SETS,
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

// ---- resvg 像素工具（遮罩攤平測試用） -----------------------------------------

/**
 * 會真的光柵化影像的測試專用上限。
 *
 * 這一檔有十條測試會經過 resvg（畫測試素材、解 PNG 像素）與 provider 的 canvas PNG 正規化，
 * 暖跑是 167–724ms，但**冷跑會慢一個數量級**：實測最慢的兩條各要 6.4 秒，越過 vitest 預設的
 * 5000ms 而變紅，再跑一次又全綠。原生模組初始化與檔案快取都冷的時候（CI、剛開機、久沒跑
 * 這個套件）就會踩到。放寬的只有這十條，其餘測試維持預設上限——它們全都是 0–3ms 的純邏輯，
 * 一旦真的卡住，5 秒就該讓它紅。
 */
const RASTER_TIMEOUT_MS = 30_000;

/** 以 resvg 畫出測試用 PNG（不畫底色就是透明底）。 */
function renderSvgPng(inner: string, width: number, height: number): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${inner}</svg>`;
  return new Uint8Array(new Resvg(svg).render().asPng());
}

/** 從 IHDR 讀 PNG 寬高。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** 測試目錄沒有 PNG decoder：把 PNG 用 resvg 再 render 一次取 RGBA 像素。 */
function decodePixels(png: Uint8Array): { pixels: Buffer; width: number; height: number } {
  const { width, height } = pngSize(png);
  const dataUri = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="${dataUri}" width="${width}" height="${height}"/></svg>`;
  return { pixels: new Resvg(svg).render().pixels, width, height };
}

function pixelAt(image: { pixels: Buffer; width: number }, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.pixels.subarray(offset, offset + 4)];
}

/**
 * 解析 multipart/form-data 的原始 bytes。
 *
 * 逐 part 掃描 boundary，只在 header 區段上比對欄位名（不掃整份 body——二進位內容裡
 * 出現 `name="..."` 的 bytes 會誤判成欄位），part 內容保留原 bytes（不經 utf8）。
 * `order` 是有序的 `name::filename` 序列：append 的先後正是這次改動的重點，用無序的
 * Map 斷言會讓兩張圖對調也照樣通過。
 */
function parseMultipart(raw: Buffer): {
  files: Map<string, Uint8Array>;
  order: string[];
  fieldNames: string[];
} {
  const text = raw.toString("latin1");
  const files = new Map<string, Uint8Array>();
  const order: string[] = [];
  const fieldNames: string[] = [];
  const boundaryMatch = /^--([^\r\n]+)\r\n/.exec(text);
  const marker = boundaryMatch?.[1];
  if (marker === undefined) return { files, order, fieldNames };
  const boundary = `--${marker}`;
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(boundary, cursor);
    if (start === -1) break;
    const headerStart = start + boundary.length;
    if (text.startsWith("--", headerStart)) break; // 結尾 boundary
    const headerEnd = text.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;
    const header = text.slice(headerStart, headerEnd);
    const bodyStart = headerEnd + 4;
    const bodyEnd = text.indexOf(`\r\n${boundary}`, bodyStart);
    if (bodyEnd === -1) break;
    const name = /name="([^"]*)"/.exec(header)?.[1];
    const filename = /filename="([^"]*)"/.exec(header)?.[1];
    if (name !== undefined) {
      fieldNames.push(name);
      if (filename !== undefined) {
        const key = `${name}::${filename}`;
        order.push(key);
        files.set(key, raw.subarray(bodyStart, bodyEnd));
      }
    }
    cursor = bodyEnd;
  }
  return { files, order, fieldNames };
}

// ---- fake OpenAI-compatible server -------------------------------------------

interface Captured {
  method: string;
  path: string;
  body: unknown;
  /** 原始請求 bytes，保留給 multipart 測試逐 part 取回二進位（body 的 utf8 會毀掉 PNG）。 */
  rawBuffer: Buffer;
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
      const rawBuffer = Buffer.concat(chunks);
      const raw = rawBuffer.toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const captured: Captured = { method: req.method ?? "", path: req.url ?? "", body, rawBuffer };
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
    expect((call.body as { size?: string }).size).toBe("1536x1024");
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

  it(
    "generates via chat completions (Gemini) and normalizes message.images to canvas PNG",
    async () => {
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
    },
    RASTER_TIMEOUT_MS,
  );

  it(
    "chat shape sends the Codex-baseline contract and labelled references",
    async () => {
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
    },
    RASTER_TIMEOUT_MS,
  );

  it(
    "chat shape sends image_config only for gemini models",
    async () => {
      const realPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
      const reply = () => ({
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
      });

      // gemini：CLIProxyAPI 的 translator 認得這個頂層欄位，會翻成原生
      // generationConfig.imageConfig。少了 image_size 模型只回 1376×768（放大 1.40×）。
      active = await startFake(reply);
      await new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gemini-3.1-flash-image",
        apiShape: "chat",
      }).generate(imageRequest());
      const geminiBody = active.requests[0]!.body as {
        image_config?: { image_size?: string; aspect_ratio?: string };
      };
      expect(geminiBody.image_config?.image_size).toBe("2K");
      expect(geminiBody.image_config?.aspect_ratio).toBe("16:9");
      active.server.closeAllConnections();
      await new Promise<void>((resolve) => active!.server.close(() => resolve()));

      // 非 gemini：其他路由沒有對應翻譯，嚴格的 OpenAI 端點還可能拒絕未知欄位，
      // 所以這個欄位一個字都不能出現。
      active = await startFake(reply);
      await new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gpt-image-2",
        apiShape: "chat",
      }).generate(imageRequest());
      const gptBody = active.requests[0]!.body as Record<string, unknown>;
      expect(gptBody).not.toHaveProperty("image_config");
    },
    RASTER_TIMEOUT_MS,
  );

  it(
    "chat edits attach base, mask, and supplemental references in manifest order",
    async () => {
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
          { path: refPath, mediaType: "image/png", role: "base", name: "Current slide" },
          { path: refPath, mediaType: "image/png", role: "mask", name: "Mask" },
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
    },
    RASTER_TIMEOUT_MS,
  );

  it(
    "chat masked edits flatten the transparent mask; the base image stays as-is",
    async () => {
      const realPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
      const basePath = join(tmpdir(), `openai-flat-base-${process.pid}.png`);
      await writeFile(basePath, Buffer.from(realPng, "base64"));
      // 遮罩：白色矩形＋全透明底（textMask() 的形狀），直接送會被視覺模型攤成全白而隱形。
      const maskBytes = renderSvgPng(
        '<rect x="480" y="270" width="960" height="540" fill="white"/>',
        1920,
        1080,
      );
      const maskPath = join(tmpdir(), `openai-flat-mask-${process.pid}.png`);
      await writeFile(maskPath, Buffer.from(maskBytes));
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
      await provider.generate({
        ...imageRequest(),
        references: [
          { path: basePath, mediaType: "image/png", role: "base", name: "Current slide" },
          { path: maskPath, mediaType: "image/png", role: "mask", name: "Mask" },
        ],
        edit: {
          instruction: "Remove text",
          baseImageIndex: 0,
          maskImageIndex: 1,
          purpose: "text-removal",
        },
      });
      const body = active.requests[0]!.body as { messages: { content: unknown[] }[] };
      const parts = body.messages[0]!.content as { type: string; image_url?: { url: string } }[];
      const images = parts.filter((part) => part.type === "image_url");
      // base 圖不受影響：仍是原檔 bytes。
      expect(images[0]!.image_url!.url).toBe(`data:image/png;base64,${realPng}`);
      // 遮罩那張已攤平：非原檔 bytes，且透明處變不透明黑、白框仍是白。
      const maskUrl = images[1]!.image_url!.url;
      expect(maskUrl).toMatch(/^data:image\/png;base64,/);
      expect(maskUrl).not.toBe(
        `data:image/png;base64,${Buffer.from(maskBytes).toString("base64")}`,
      );
      const flattened = new Uint8Array(
        Buffer.from(maskUrl.slice("data:image/png;base64,".length), "base64"),
      );
      const image = decodePixels(flattened);
      expect(image.width).toBe(1920);
      expect(image.height).toBe(1080);
      expect(pixelAt(image, 5, 5)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(image, 960, 540)).toEqual([255, 255, 255, 255]);
    },
    RASTER_TIMEOUT_MS,
  );

  it(
    "images shape sends base and a flattened mask through image[], not the mask field",
    async () => {
      // gpt 走 /images/edits 時，官方 `mask` 欄位模型讀不到（實測對這條 gateway 也無約束
      // 力），合約的「Image 2 is a locator ... Read it」因此形同虛設。base 與攤平後的 mask
      // 都放進 image[]（模型可讀），順序對齊合約 Image 1 / Image 2；不再送 `mask` 欄位。
      const b64 = Buffer.from(png(1920, 1080)).toString("base64");
      const basePath = join(tmpdir(), `openai-native-edit-base-${process.pid}.png`);
      await writeFile(basePath, Buffer.from(b64, "base64"));
      // 遮罩：白框＋透明底（textMask 的形狀），送出前必須攤成不透明黑底白框。
      const maskBytes = renderSvgPng(
        '<rect x="480" y="270" width="960" height="540" fill="white"/>',
        1920,
        1080,
      );
      const maskPath = join(tmpdir(), `openai-native-edit-mask-${process.pid}.png`);
      await writeFile(maskPath, Buffer.from(maskBytes));
      active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
      const provider = new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gpt-image-2",
        apiShape: "images",
      });
      await provider.generate({
        ...imageRequest(),
        references: [
          { path: basePath, mediaType: "image/png", role: "base", name: "Current slide" },
          { path: maskPath, mediaType: "image/png", role: "mask", name: "Mask" },
        ],
        edit: { instruction: "Change the circle to green", baseImageIndex: 0, maskImageIndex: 1 },
      });
      const captured = active.requests[0]!;
      expect(captured.path).toBe("/v1/images/edits");
      expect(String(captured.body)).toContain("This is an image editing task");
      const { files, order, fieldNames } = parseMultipart(captured.rawBuffer);
      // 順序即合約的 Image 1 / Image 2；沒有獨立的 mask 欄位。
      expect(order).toEqual(["image[]::image.png", "image[]::mask.png"]);
      expect(fieldNames).not.toContain("mask");
      const baseSent = files.get("image[]::image.png")!;
      const maskSent = files.get("image[]::mask.png")!;
      // base 原樣送出。
      expect(Buffer.from(baseSent).equals(Buffer.from(b64, "base64"))).toBe(true);
      // 遮罩已攤平：非原檔 bytes，透明處變不透明黑、白框仍是白，尺寸為 canvas。
      expect(Buffer.from(maskSent).equals(Buffer.from(maskBytes))).toBe(false);
      const image = decodePixels(new Uint8Array(maskSent));
      expect(image.width).toBe(1920);
      expect(image.height).toBe(1080);
      expect(pixelAt(image, 5, 5)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(image, 960, 540)).toEqual([255, 255, 255, 255]);
    },
    RASTER_TIMEOUT_MS,
  );

  it(
    "images shape attaches every reference in manifest order, so Image N stays aligned",
    async () => {
      // 合約會把 request.references 逐筆列成 Image N。只送 base+mask 的話，有風格參考圖的
      // 專案 prompt 會說「Image 3: role=style」卻沒有第三張圖，編號從那裡起全部錯位。
      const b64 = Buffer.from(png(1920, 1080)).toString("base64");
      const refPath = join(tmpdir(), `openai-edit-order-${process.pid}.png`);
      await writeFile(refPath, Buffer.from(b64, "base64"));
      const maskBytes = renderSvgPng(
        '<rect x="480" y="270" width="960" height="540" fill="white"/>',
        1920,
        1080,
      );
      const maskPath = join(tmpdir(), `openai-edit-order-mask-${process.pid}.png`);
      await writeFile(maskPath, Buffer.from(maskBytes));
      active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
      const provider = new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gpt-image-2",
        apiShape: "images",
      });
      await provider.generate({
        ...imageRequest(),
        // jobs.ts 實際組出的形狀：base、mask，接著才是補充參考圖。
        references: [
          { path: refPath, mediaType: "image/png", role: "base", name: "Current slide" },
          { path: maskPath, mediaType: "image/png", role: "mask", name: "Mask" },
          { path: refPath, mediaType: "image/png", role: "style", name: "Style A" },
          { path: refPath, mediaType: "image/png", role: "direct-asset", name: "Panel" },
        ],
        edit: { instruction: "Change the circle to green", baseImageIndex: 0, maskImageIndex: 1 },
      });
      const { order, fieldNames } = parseMultipart(active.requests[0]!.rawBuffer);
      expect(order).toEqual([
        "image[]::image.png",
        "image[]::mask.png",
        "image[]::reference-2.png",
        "image[]::reference-3.png",
      ]);
      expect(fieldNames.filter((name) => name === "image[]")).toHaveLength(4);
      // 合約列到 Image 4，附圖就必須有 4 張。
      expect(String(active.requests[0]!.body)).toContain(
        'Image 4: role=direct-asset; name="Panel"',
      );
    },
    RASTER_TIMEOUT_MS,
  );

  it("images shape rejects more references than the endpoint's image[] limit", async () => {
    const refPath = join(tmpdir(), `openai-edit-limit-${process.pid}.png`);
    await writeFile(refPath, Buffer.from(png(1920, 1080)));
    active = await startFake(() => ({ status: 200, json: { data: [] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
      apiShape: "images",
    });
    await expect(
      provider.generate({
        ...imageRequest(),
        references: Array.from({ length: 17 }, () => ({
          path: refPath,
          mediaType: "image/png",
          role: "style" as const,
          name: "Style",
        })),
      }),
    ).rejects.toMatchObject({ code: "OPENAI_IMAGE_REFERENCES_LIMIT" });
    expect(active.requests).toHaveLength(0);
  });

  it("images shape declares reference-image support (via /images/edits image[])", () => {
    const provider = new OpenAiCompatibleImageProvider({
      config: { baseUrl: "http://x", apiKey: "k", timeoutMs: 1_000 },
      model: "gpt-image-2",
    });
    expect(provider.capabilities.referenceImages).toBe(true);
    expect(provider.capabilities.multipleReferenceImages).toBe(true);
    // 宣告的上限必須是「這個實例真的會走的那條 transport」的上限：images 是 16、
    // chat／openrouter 是 8。宣告錯了，jobs.ts 會依一個不存在的上限截斷。
    expect(provider.capabilities.maxReferenceImages).toBe(16);
    expect(
      new OpenAiCompatibleImageProvider({
        config: { baseUrl: "http://x", apiKey: "k", timeoutMs: 1_000 },
        model: "gemini-3.1-flash-image",
        apiShape: "chat",
      }).capabilities.maxReferenceImages,
    ).toBe(8);
    expect(
      new OpenAiCompatibleImageProvider({
        config: { baseUrl: "http://x", apiKey: "k", timeoutMs: 1_000 },
        model: "openrouter/model",
        apiShape: "openrouter-image",
      }).capabilities.maxReferenceImages,
    ).toBe(8);
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

  // ---- 可調項由 provider 宣告、使用者選值 ----------------------------------------
  //
  // 「這個模型可調什麼」是 provider 的 option set 說了算（`image-options.ts`），框架只負責
  // 把選到的值交回去翻譯。所以這幾條驗的是兩件事：選了值真的落到 request body 上、以及
  // 沒有 option set 的模型退回 transport 預設而不是憑空送一個欄位。

  it("a Grok Imagine model turns the chosen resolution into aspect_ratio + resolution", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      // 同一個模型在不同 gateway 上寫法不同，比對前會先剝掉 vendor 前綴。
      model: "x-ai/grok-imagine-image-2.0",
      // 這裡要測的是尺寸欄位。這個 option set 同時宣告了 8000 bytes 的 prompt 上限（端點的
      // 硬限制，見 image-options.ts 的實測），而本專案的合約超過它——不覆寫的話請求會在送出
      // 前就被擋下，測不到 body。那件事由下一條測試單獨釘住。
      profile: { options: { resolution: "1k" }, promptMaxBytes: 99_999 },
    });
    const image = await provider.generate(imageRequest());
    const body = active.requests[0]!.body as {
      size?: string;
      aspect_ratio?: string;
      resolution?: string;
    };
    // 這條端點不吃 size——送它正是 2026-08-28 那次生成失敗的直接原因。
    expect(body.size).toBeUndefined();
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("1k");
    // 產物 metadata 帶著實際送出的尺寸參數，之後查「這張是用什麼設定生的」才有依據。
    expect(image.parameters.resolution).toBe("1k");
    expect(image.parameters.size).toBeUndefined();
  });

  /**
   * 2026-08-30 實測：這個端點的 prompt 硬上限是 8000，而本專案的影像合約光是規則段就 8376
   * 字元／8412 bytes，完整 prompt 9533 字元／9921 bytes——即使簡報內容是空的也塞不下。
   *
   * 截斷不是解法：把完整 prompt 硬切到 8000 送出去，切點落在規則段中間，`UNTRUSTED_
   * PRESENTATION_JSON` 之後那 1445 bytes 的簡報資料整段沒送出去，模型於是自己編了一個題目
   * （實測拿回一張 "Hybrid Cloud Adoption" 的投影片，與餵進去的內容毫無關係）。圖畫得漂亮、
   * 也「成功」回傳，是最難察覺的一種失效。所以這裡要的是**在送出前明確失敗**。
   */
  it("a Grok Imagine model refuses this project's contract prompt before sending", async () => {
    active = await startFake(() => ({ status: 200, json: {} }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "grok-imagine-image-2.0",
    });
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "OPENAI_IMAGE_PROMPT_TOO_LONG",
    });
    expect(active.requests).toHaveLength(0);
  });

  it("a Gemini chat model turns the chosen imageSize into image_config", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    const dataUrl = `data:image/png;base64,${b64}`;
    active = await startFake(() => ({
      status: 200,
      json: { choices: [{ message: { images: [{ image_url: { url: dataUrl } }] } }] },
    }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gemini-3.1-flash-image",
      apiShape: "chat",
      profile: { options: { imageSize: "4k" } },
    });
    await provider.generate(imageRequest());
    const body = active.requests[0]!.body as {
      image_config?: { image_size?: string; aspect_ratio?: string };
    };
    // 檔位存小寫、由 transport 寫成該端點的字面（Gemini 系吃大寫）。
    expect(body.image_config?.image_size).toBe("4K");
    expect(body.image_config?.aspect_ratio).toBe("16:9");
  });

  it("a model with no option set sends no sizing field at all", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "vendor/unrecognised-image-model",
      // 認不出來的模型沒有可調項，存下來的值也不該被憑空當成某一家的欄位送出去。
      profile: { options: { resolution: "4k" } },
    });
    await provider.generate(imageRequest());
    const body = active.requests[0]!.body as {
      size?: string;
      aspect_ratio?: string;
      resolution?: string;
    };
    // 這裡曾經無條件送 size:"1536x1024"。那個值只是**剛好** OpenAI 吃——別家未必認得這個
    // 字串，送過去就是一個不透明的 400。不送才是把決定權交回端點自己的預設。
    expect(body.size).toBeUndefined();
    expect(body.aspect_ratio).toBeUndefined();
    expect(body.resolution).toBeUndefined();
  });

  it("a gpt-image model still sends its own default size, from its option set", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: b64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
    });
    await provider.generate(imageRequest());
    // 不送的話這條端點回 1024×1024 方形，cover 到 16:9 會吃掉左右兩側——所以 gpt-image 的
    // 預設住在它自己的 option set（`resolve({})`）裡，而不是所有 images 模型共用的那一層。
    expect((active.requests[0]!.body as { size?: string }).size).toBe("1536x1024");
  });

  it("a profile prompt budget fails the call without sending a request", async () => {
    active = await startFake(() => ({ status: 200, json: {} }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-1",
      profile: { promptMaxBytes: 200 },
    });
    // 截斷是更壞的交換：prompt 尾端依序是簡報內容、UNTRUSTED_PRESENTATION_JSON 隔離
    // 標記與注入防線，從尾端砍等於先砍掉安全邊界再送出半份資料。
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "OPENAI_IMAGE_PROMPT_TOO_LONG",
    });
    expect(active.requests).toHaveLength(0);
  });

  it("a profile reference limit only lowers the transport's hard ceiling", () => {
    const config: OpenAiClientConfig = {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
    };
    expect(
      new OpenAiCompatibleImageProvider({
        config,
        model: "gpt-image-1",
        profile: { maxReferenceImages: 4 },
      }).capabilities.maxReferenceImages,
    ).toBe(4);
    // 設得比端點自身的上限高只會換來 gateway 的不透明 400，而 jobs.ts 會以為還塞得下。
    expect(
      new OpenAiCompatibleImageProvider({
        config,
        model: "gpt-image-1",
        profile: { maxReferenceImages: 99 },
      }).capabilities.maxReferenceImages,
    ).toBe(16);
  });

  /**
   * 每一個宣告出來的選項都必須真的落到 request body 上。
   *
   * 這是整個機制唯一會靜默失效的地方：option set 列了一個 transport 翻不出來的值，使用者
   * 選了、存了、UI 上看起來一切正常，送出時卻什麼都沒帶。所以逐一送一次真請求。
   */
  it("every choice an option set advertises actually reaches the request body", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    const dataUrl = `data:image/png;base64,${b64}`;
    /** 每個 option set 用哪個模型與通道才會被選中，以及它該在 body 上留下的欄位。 */
    const cases: ReadonlyArray<{
      setId: string;
      model: string;
      shape: "images" | "chat";
      field: string;
    }> = [
      {
        setId: "gemini-chat",
        model: "gemini-3.1-flash-image",
        shape: "chat",
        field: "image_config",
      },
      {
        setId: "grok-imagine",
        model: "grok-imagine-image-2.0",
        shape: "images",
        field: "resolution",
      },
      { setId: "gpt-image", model: "gpt-image-2", shape: "images", field: "size" },
    ];
    // 少宣告一個 set（或多一個沒有 case 的）都要讓這條測試停下來，否則新加的那組不會被驗到。
    expect(IMAGE_OPTION_SETS.map((set) => set.id).sort()).toEqual(
      cases.map((item) => item.setId).sort(),
    );

    for (const item of cases) {
      const set = IMAGE_OPTION_SETS.find((candidate) => candidate.id === item.setId)!;
      for (const field of set.fields) {
        if (field.kind !== "select") continue;
        for (const choice of field.choices) {
          const fake = await startFake((captured) =>
            captured.path.includes("/chat/completions")
              ? {
                  status: 200,
                  json: { choices: [{ message: { images: [{ image_url: { url: dataUrl } }] } }] },
                }
              : { status: 200, json: { data: [{ b64_json: b64 }] } },
          );
          try {
            const provider = new OpenAiCompatibleImageProvider({
              config: fake.config,
              model: item.model,
              apiShape: item.shape,
              // prompt 上限覆寫掉：這條測的是「宣告的選項有沒有落到 body 上」，而 Grok
              // Imagine 的 set 同時宣告了 8000 bytes 上限，會在送出前就把請求擋下。
              profile: { options: { [field.id]: choice.id }, promptMaxBytes: 99_999 },
            });
            await provider.generate(imageRequest());
            const body = fake.requests[0]!.body as Record<string, unknown>;
            expect(body[item.field], `${item.setId} / ${field.id} = ${choice.id}`).toBeDefined();
          } finally {
            fake.server.closeAllConnections();
            await new Promise<void>((resolve) => fake.server.close(() => resolve()));
          }
        }
      }
    }
  }, 60_000);

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

  it(
    "images shape normalizes a non-PNG (jpeg) gateway response to a canvas PNG",
    async () => {
      // gpt-image gateway 不保證回 PNG；回 jpeg 時應比照 chat／openrouter 走 rasterToCanvasPng
      // 轉成 canvas 尺寸 PNG，而非丟出標著「Codex」的裸 PNG 結構驗證錯誤。
      const jpegB64 =
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
      active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: jpegB64 }] } }));
      const provider = new OpenAiCompatibleImageProvider({
        config: active.config,
        model: "gpt-image-2",
        apiShape: "images",
      });
      const image = await provider.generate(imageRequest());
      expect(image.mediaType).toBe("image/png");
      expect(image.parameters.transport).toBe("openai-images");
      // 轉出來的確實是 canvas 尺寸的 PNG（IHDR 寬高 = 1920×1080），而非原封 jpeg。
      expect(pngSize(image.bytes)).toEqual({ width: 1920, height: 1080 });
      expect(active.requests[0]!.path).toBe("/v1/images/generations");
    },
    RASTER_TIMEOUT_MS,
  );

  it("images shape rejects an unrecognizable output format with a named SafeProviderError", async () => {
    // 認不得的 magic bytes（非 png/jpeg/webp）：丟具名、可分類的 SafeProviderError，
    // 不讓裸 Error（更不會標成別條通道的名字）冒到上層。
    const junkB64 = Buffer.from(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])).toString("base64");
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: junkB64 }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
      apiShape: "images",
    });
    await expect(provider.generate(imageRequest())).rejects.toBeInstanceOf(SafeProviderError);
    await expect(provider.generate(imageRequest())).rejects.toMatchObject({
      code: "OPENAI_IMAGE_INVALID",
    });
  });

  it("images shape does not follow a symlinked reference (O_NOFOLLOW)", async () => {
    const realPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
    const targetPath = join(tmpdir(), `openai-symlink-target-${process.pid}.png`);
    await writeFile(targetPath, Buffer.from(realPng, "base64"));
    const linkPath = join(tmpdir(), `openai-symlink-link-${process.pid}.png`);
    await rm(linkPath, { force: true });
    await symlink(targetPath, linkPath);
    active = await startFake(() => ({ status: 200, json: { data: [{ b64_json: realPng }] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
      apiShape: "images",
    });
    // symlink 指向合法 PNG：若被跟隨就會成功送出請求；O_NOFOLLOW 應讓讀取失敗、請求不發出。
    await expect(
      provider.generate({
        ...imageRequest(),
        references: [
          { path: linkPath, mediaType: "image/png", role: "style" as const, name: "Style" },
        ],
      }),
    ).rejects.toThrow();
    expect(active.requests).toHaveLength(0);
  });

  it("images shape rejects a reference whose bytes are not a supported image", async () => {
    const notImage = join(tmpdir(), `openai-not-image-${process.pid}.png`);
    await writeFile(notImage, Buffer.from("this is definitely not an image", "utf8"));
    active = await startFake(() => ({ status: 200, json: { data: [] } }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "gpt-image-2",
      apiShape: "images",
    });
    await expect(
      provider.generate({
        ...imageRequest(),
        references: [
          { path: notImage, mediaType: "image/png", role: "style" as const, name: "Style" },
        ],
      }),
    ).rejects.toMatchObject({ code: "OPENAI_IMAGE_INPUT_INVALID" });
    expect(active.requests).toHaveLength(0);
  });

  it(
    "openrouter shape posts to /images with data[].b64_json and normalizes to canvas PNG",
    async () => {
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
    },
    RASTER_TIMEOUT_MS,
  );

  it("openrouter extract prefers magic bytes over a lying media_type", () => {
    const webpB64 =
      "UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoIAAgAAUAmJaACdLoB+AADsAD+73bX/hV8bkLW//voB70A96Af4IAA";
    const extracted = extractOpenRouterImage({
      data: [{ b64_json: webpB64, media_type: "image/png" }],
    });
    expect(extracted.mediaType).toBe("image/webp");
  });

  it(
    "openrouter shape normalizes a webp response to a canvas PNG with visible pixels",
    async () => {
      const webpB64 =
        "UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoIAAgAAUAmJaACdLoB+AADsAD+73bX/hV8bkLW//voB70A96Af4IAA";
      active = await startFake(() => ({
        status: 200,
        json: { data: [{ b64_json: webpB64, media_type: "image/webp" }] },
      }));
      const provider = new OpenAiCompatibleImageProvider({
        config: { ...active.config, baseUrl: `${active.config.baseUrl}/images` },
        model: "meta/muse-image",
        apiShape: "openrouter-image",
      });
      const image = await provider.generate(imageRequest());
      expect(image.mediaType).toBe("image/png");
      expect(image.parameters.transport).toBe("openrouter-image");
      expect(pngSize(image.bytes)).toEqual({ width: 1920, height: 1080 });
      const pixel = pixelAt(decodePixels(image.bytes), 960, 540);
      expect(pixel[3] ?? 0).toBeGreaterThan(0);
      expect(pixel[0] ?? 0).toBeGreaterThan(pixel[1] ?? 0);
      expect(pixel[0] ?? 0).toBeGreaterThan(pixel[2] ?? 0);
    },
    RASTER_TIMEOUT_MS,
  );

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

  it(
    "openrouter masked edits flatten the transparent mask in input_references",
    async () => {
      const realPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGM8YKn9nwEPGCEKAMMnESErIVVKAAAAAElFTkSuQmCC";
      const basePath = join(tmpdir(), `openrouter-flat-base-${process.pid}.png`);
      await writeFile(basePath, Buffer.from(realPng, "base64"));
      const maskBytes = renderSvgPng(
        '<rect x="480" y="270" width="960" height="540" fill="white"/>',
        1920,
        1080,
      );
      const maskPath = join(tmpdir(), `openrouter-flat-mask-${process.pid}.png`);
      await writeFile(maskPath, Buffer.from(maskBytes));
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
          { path: basePath, mediaType: "image/png", role: "base", name: "Current slide" },
          { path: maskPath, mediaType: "image/png", role: "mask", name: "Mask" },
        ],
        edit: {
          instruction: "Remove text",
          baseImageIndex: 0,
          maskImageIndex: 1,
          purpose: "text-removal",
        },
      });
      const body = active.requests[0]!.body as {
        input_references?: { image_url: { url: string } }[];
      };
      // base 圖原樣；遮罩（input_references 是給模型「看」的視覺通道）攤平成黑底。
      expect(body.input_references![0]!.image_url.url).toBe(`data:image/png;base64,${realPng}`);
      const maskUrl = body.input_references![1]!.image_url.url;
      expect(maskUrl).toMatch(/^data:image\/png;base64,/);
      const flattened = new Uint8Array(
        Buffer.from(maskUrl.slice("data:image/png;base64,".length), "base64"),
      );
      const image = decodePixels(flattened);
      expect(image.width).toBe(1920);
      expect(image.height).toBe(1080);
      expect(pixelAt(image, 5, 5)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(image, 960, 540)).toEqual([255, 255, 255, 255]);
    },
    RASTER_TIMEOUT_MS,
  );

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

describe("flattenMaskToBlack", () => {
  it(
    "turns white-on-transparent into white-on-opaque-black at the canvas size",
    () => {
      const mask = renderSvgPng('<rect x="16" y="9" width="32" height="18" fill="white"/>', 64, 36);
      // 前提確認：原遮罩底確實是全透明。
      expect(pixelAt(decodePixels(mask), 0, 0)[3]).toBe(0);

      const flattened = flattenMaskToBlack(mask, "image/png", 64, 36);
      const image = decodePixels(flattened);
      expect(image.width).toBe(64);
      expect(image.height).toBe(36);
      // alpha 全不透明。
      const alphas = new Set<number>();
      for (let offset = 3; offset < image.pixels.length; offset += 4)
        alphas.add(image.pixels[offset]!);
      expect([...alphas]).toEqual([255]);
      // 原透明處為黑、原白框處為白。
      expect(pixelAt(image, 0, 0)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(image, 63, 35)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(image, 32, 18)).toEqual([255, 255, 255, 255]);
    },
    RASTER_TIMEOUT_MS,
  );

  it("rejects unsupported media types", () => {
    expect(() => flattenMaskToBlack(new Uint8Array([1, 2, 3]), "image/gif", 64, 36)).toThrow(
      SafeProviderError,
    );
  });
});

describe("maskAwareDataUrl", () => {
  // passthrough 分支不解析 data URL，內容故意用非影像字串也不會 throw。
  const url = "data:image/png;base64,not-really-parsed";

  it("passes the url through untouched when the request has no edit", () => {
    expect(maskAwareDataUrl(url, 0, imageRequest())).toBe(url);
  });

  it("passes the url through untouched when the edit has no maskImageIndex", () => {
    const request = {
      ...imageRequest(),
      edit: { instruction: "Refine layout", baseImageIndex: 0, purpose: "refine" },
    } as unknown as ImageGenerationRequest;
    expect(maskAwareDataUrl(url, 0, request)).toBe(url);
    expect(maskAwareDataUrl(url, 1, request)).toBe(url);
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
    expect(result.value).toEqual({ ok: true, items: [1, 2] });
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
    expect((await provider.runStructured({ prompt: "hi", outputSchema: {} })).value).toEqual({
      value: 42,
    });
  });

  it("retries transient non-JSON responses and eventually succeeds", async () => {
    let call = 0;
    active = await startFake(() => {
      call += 1;
      const content = call < 3 ? "sorry, here is my analysis..." : JSON.stringify({ ok: true });
      return { status: 200, json: { choices: [{ message: { content } }] } };
    });
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gemini" });
    expect((await provider.runStructured({ prompt: "hi", outputSchema: {} })).value).toEqual({
      ok: true,
    });
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
    const { results } = await provider.search("query", 8, "zh-TW");
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

    await expect(provider.search("query", 8, "zh-TW")).resolves.toMatchObject({
      results: [{ url: "https://example.com/gemini", title: "Gemini", summary: "grounded" }],
    });
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

/**
 * 用量的**接線**測試：解析器本身在 `usage.test.ts` 有各自的 fixture，這裡釘的是另一半
 * ——每條通道有沒有接上**自己那個**解析器。少了這一組，把三條都接成
 * `parseChatCompletionsUsage` 的實作會全綠，而 images 通道會在正式環境靜默落成
 * `reported:false`（症狀與 gateway 真的沒回報一模一樣）。
 */
describe("用量沿著每條通道傳到呼叫端", () => {
  it("images 通道帶回 input/output_tokens 與輸出側 image_tokens", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
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
    const image = await provider.generate(imageRequest());
    expect(image.usage).toEqual({
      inputTokens: 12,
      outputTokens: 229,
      totalTokens: 241,
      imageTokens: 229,
      reported: true,
    });
  });

  it("openrouter 通道帶回 cost", async () => {
    const b64 = Buffer.from(png(1920, 1080)).toString("base64");
    active = await startFake(() => ({
      status: 200,
      json: {
        data: [{ b64_json: b64, media_type: "image/png" }],
        usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost: 0.04 },
      },
    }));
    const provider = new OpenAiCompatibleImageProvider({
      config: active.config,
      model: "google/gemini-image",
      apiShape: "openrouter-image",
    });
    const image = await provider.generate(imageRequest());
    expect(image.usage).toEqual({
      inputTokens: 0,
      outputTokens: 4175,
      totalTokens: 4175,
      reported: true,
      cost: { amount: 0.04, unit: "openrouter-credit" },
    });
  });

  it("結構化文字帶回 chat 形狀的用量，且與內容出自同一份回應", async () => {
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 303,
          completion_tokens: 13,
          total_tokens: 316,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }));
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gpt-5" });
    const result = await provider.runStructured({ prompt: "hi", outputSchema: {} });
    expect(result.value).toEqual({ ok: true });
    expect(result.usage).toEqual({
      inputTokens: 303,
      outputTokens: 13,
      totalTokens: 316,
      cachedTokens: 0,
      reasoningTokens: 0,
      reported: true,
    });
  });

  it("gateway 完全沒回 usage 時是 reported:false，而不是一堆 0", async () => {
    active = await startFake(() => ({
      status: 200,
      json: { choices: [{ message: { content: '{"ok":true}' } }] },
    }));
    const provider = new OpenAiStructuredTextProvider({ config: active.config, model: "gpt-5" });
    expect((await provider.runStructured({ prompt: "hi", outputSchema: {} })).usage).toEqual({
      reported: false,
    });
  });

  it("網路搜尋也帶回用量", async () => {
    active = await startFake(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [{ url: "https://example.com/a", title: "A", summary: "sa" }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 },
      },
    }));
    const provider = new OpenAiWebSearchProvider({ config: active.config, model: "gpt-5-search" });
    const outcome = await provider.search("query", 8, "zh-TW");
    expect(outcome.results).toHaveLength(1);
    expect(outcome.usage).toEqual({
      inputTokens: 40,
      outputTokens: 60,
      totalTokens: 100,
      reported: true,
    });
  });
});

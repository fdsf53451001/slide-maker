import {
  attachProviderCallFacts,
  buildImageGenerationContract,
  SafeProviderError,
  type ImageGenerationRequest,
  type ProviderUsage,
  withProviderUsage,
} from "@slide-maker/core";
import { type OpenAiClientConfig, readImageAsDataUrl, requestJson } from "./http.js";
import { maskAwareDataUrl, parseDataUri, rasterToCanvasPng } from "./image-util.js";
import { parseChatCompletionsUsage } from "./usage.js";

type ChatImagePart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export const MAX_CHAT_REFERENCES = 8;

function chatPrompt(request: ImageGenerationRequest): string {
  return [
    request.edit
      ? "Edit the supplied 16:9 presentation slide and return exactly one raster image."
      : "Generate exactly one complete 16:9 presentation slide as a raster image.",
    "Return the image through the response image-output channel. Do not return SVG, HTML, Markdown, code, a data URI in text, or a textual description.",
    buildImageGenerationContract(request),
  ].join("\n");
}

/** Extract the image payload emitted by CLIProxyAPI-compatible Chat responses. */
export function extractChatImage(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices;
  const message = Array.isArray(choices)
    ? (choices[0] as { message?: { images?: unknown; content?: unknown } })?.message
    : undefined;
  const images = message?.images;
  if (Array.isArray(images)) {
    const first = images[0] as { image_url?: { url?: unknown } };
    if (typeof first?.image_url?.url === "string") return first.image_url.url;
  }
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const candidate = part as { image_url?: { url?: unknown } };
      if (typeof candidate?.image_url?.url === "string") return candidate.image_url.url;
    }
  }
  if (typeof content === "string") {
    const match = /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/i.exec(content);
    if (match) return match[0];
  }
  throw new SafeProviderError(
    "OPENAI_IMAGE_MISSING",
    "Chat 影像回應缺少 raster 圖片資料；請使用支援圖片輸出的模型。",
  );
}

/**
 * Gemini 專屬的 OpenRouter 風格 `image_config`，**只對 gemini 系模型送**。
 *
 * CLIProxyAPI 的 gemini chat translator 認得這個頂層欄位，會翻成原生的
 * `generationConfig.imageConfig.{aspectRatio,imageSize}`；其他路由（GPT tool image 等）沒有
 * 對應翻譯，而嚴格的 OpenAI 端點可能直接拒絕未知欄位，所以判斷方式比照 `web-search.ts`
 * 的 `searchTool()`——那裡也是同一個 translator 的同一種擴充。
 *
 * `imageSize:"2K"` 是畫質關鍵而非可選調校：2026-07-31 實測不送時模型只回 1376×768，
 * `rasterToCanvasPng` 得放大 1.40× 才填滿 1920×1080；送 `2K` 回 2752×1536，變成下採樣 0.70×。
 * 端到端跑真實投影片 fixture：銳利度（Laplacian 變異數）99.3 → 430.1，耗時 +17%、token +16%。
 * 與 `packages/provider-gemini` 的 `imageConfig()` 是同一個決定，兩條路都要送。
 */
function geminiImageConfig(
  model: string,
  width: number,
  height: number,
): { image_config: { image_size: string; aspect_ratio?: string } } | undefined {
  if (!/^gemini-/i.test(model)) return undefined;
  const sixteenByNine = height > 0 && Math.abs(width / height - 16 / 9) < 0.02;
  return {
    image_config: { image_size: "2K", ...(sixteenByNine ? { aspect_ratio: "16:9" } : {}) },
  };
}

function validateEditReferences(request: ImageGenerationRequest): void {
  if (!request.edit) return;
  if (!request.references[request.edit.baseImageIndex])
    throw new SafeProviderError("OPENAI_IMAGE_BASE_MISSING", "找不到要編輯的基底影像。");
  if (
    request.edit.maskImageIndex !== undefined &&
    !request.references[request.edit.maskImageIndex]
  ) {
    throw new SafeProviderError("OPENAI_IMAGE_MASK_MISSING", "找不到遮罩影像。");
  }
}

export async function generateViaChat(
  config: OpenAiClientConfig,
  model: string,
  request: ImageGenerationRequest,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; usage: ProviderUsage }> {
  if (request.references.length > MAX_CHAT_REFERENCES) {
    throw new SafeProviderError(
      "OPENAI_IMAGE_REFERENCES_LIMIT",
      `Chat 圖片生成每頁最多接受 ${MAX_CHAT_REFERENCES} 張參考圖。`,
    );
  }
  validateEditReferences(request);
  const parts: ChatImagePart[] = [{ type: "text", text: chatPrompt(request) }];
  for (const [index, reference] of request.references.entries()) {
    // 遮罩是「白框＋透明底」，視覺模型會把透明底攤成白色而看不到白框，
    // 故 masked edit 的遮罩那張先攤平成不透明黑底再送。
    parts.push({
      type: "image_url",
      image_url: {
        url: maskAwareDataUrl(await readImageAsDataUrl(reference.path), index, request),
      },
    });
  }
  const payload = await requestJson(config, {
    method: "POST",
    path: "/chat/completions",
    body: {
      model,
      ...(geminiImageConfig(model, request.width, request.height) ?? {}),
      messages: [{ role: "user", content: parts }],
    },
    ...(signal ? { signal } : {}),
  });
  // 這條走的是 /chat/completions，usage 形狀與文字／搜尋相同（見 usage.ts 的 (a)）。
  // 解圖失敗（模型不支援圖片輸出、回了純文字）也是往返成功之後才失敗，usage 要跟著錯誤走。
  const usage = parseChatCompletionsUsage(payload);
  const { mediaType, bytes } = withProviderUsage(usage, () =>
    parseDataUri(extractChatImage(payload)),
  );
  try {
    return {
      bytes: await rasterToCanvasPng(bytes, mediaType, request.width, request.height),
      usage,
    };
  } catch (error) {
    throw attachProviderCallFacts(error, { usage });
  }
}

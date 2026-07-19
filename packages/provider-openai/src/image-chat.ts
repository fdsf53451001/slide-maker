import {
  buildImageGenerationContract,
  SafeProviderError,
  type ImageGenerationRequest,
} from "@slide-maker/core";
import { type OpenAiClientConfig, readImageAsDataUrl, requestJson } from "./http.js";
import { parseDataUri, rasterToCanvasPng } from "./image-util.js";

type ChatImagePart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const MAX_CHAT_REFERENCES = 8;

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
): Promise<Uint8Array> {
  if (request.references.length > MAX_CHAT_REFERENCES) {
    throw new SafeProviderError(
      "OPENAI_IMAGE_REFERENCES_LIMIT",
      `Chat 圖片生成每頁最多接受 ${MAX_CHAT_REFERENCES} 張參考圖。`,
    );
  }
  validateEditReferences(request);
  const parts: ChatImagePart[] = [{ type: "text", text: chatPrompt(request) }];
  for (const reference of request.references) {
    parts.push({
      type: "image_url",
      image_url: { url: await readImageAsDataUrl(reference.path) },
    });
  }
  const payload = await requestJson(config, {
    method: "POST",
    path: "/chat/completions",
    body: { model, messages: [{ role: "user", content: parts }] },
    ...(signal ? { signal } : {}),
  });
  const { mediaType, bytes } = parseDataUri(extractChatImage(payload));
  return rasterToCanvasPng(bytes, mediaType, request.width, request.height);
}

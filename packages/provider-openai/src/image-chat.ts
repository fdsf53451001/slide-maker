import {
  aspectRatioLabel,
  attachProviderCallFacts,
  buildImageGenerationContract,
  type ImageModelProfile,
  SafeProviderError,
  type ImageGenerationRequest,
  type ProviderUsage,
  withProviderUsage,
} from "@slide-maker/core";
import { type OpenAiClientConfig, readImageAsDataUrl, requestJson } from "./http.js";
import { assertPromptBudget, referenceLimitFor } from "./image-profile.js";
import { maskAwareDataUrl, parseDataUri, rasterToCanvasPng } from "./image-util.js";
import { parseChatCompletionsUsage } from "./usage.js";

type ChatImagePart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

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
 * Gemini 系 chat translator 認得的 OpenRouter 風格頂層 `image_config`，會被翻成原生的
 * `generationConfig.imageConfig.{aspectRatio,imageSize}`。
 *
 * 送不送、送哪個檔位，一律由 profile 決定（預設值的推導與實測依據見
 * `image-profile.ts` 的 `defaultImageProfile()`）。其他路由（GPT tool image 等）沒有對應
 * 翻譯，而嚴格的 OpenAI 端點可能直接拒絕未知欄位，所以那些模型的 profile 是 `none`。
 *
 * `aspect_ratio` 與 `image_size` 分開判斷：解析度與比例無關，非 16:9 時仍要送
 * `image_size`。
 */
function imageConfigFields(
  profile: ImageModelProfile,
  request: ImageGenerationRequest,
): { image_config: { image_size: string; aspect_ratio?: string } } | undefined {
  const sizing = profile.sizing;
  // `size`／`aspect_ratio` 是 REST images 端點的講法，這條 chat 路徑上沒有對應欄位。
  if (sizing.mode !== "image_size") return undefined;
  const ratio = aspectRatioLabel(request.width, request.height);
  return {
    image_config: {
      image_size: sizing.resolution.toUpperCase(),
      ...(ratio ? { aspect_ratio: ratio } : {}),
    },
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
  profile: ImageModelProfile,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; usage: ProviderUsage }> {
  const limit = referenceLimitFor("chat", profile);
  if (request.references.length > limit) {
    throw new SafeProviderError(
      "OPENAI_IMAGE_REFERENCES_LIMIT",
      `Chat 圖片生成每頁最多接受 ${limit} 張參考圖。`,
    );
  }
  validateEditReferences(request);
  const prompt = chatPrompt(request);
  assertPromptBudget(prompt, profile);
  const parts: ChatImagePart[] = [{ type: "text", text: prompt }];
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
      ...(imageConfigFields(profile, request) ?? {}),
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

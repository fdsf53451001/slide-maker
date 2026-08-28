import {
  attachProviderCallFacts,
  buildImageGenerationContract,
  type ImageModelProfile,
  SafeProviderError,
  type ImageGenerationRequest,
  type ProviderUsage,
  withProviderUsage,
} from "@slide-maker/core";
import { normalizePngToCanvas, validatePngStructure } from "@slide-maker/core/png-canvas";
import {
  detectImageMediaType,
  type OpenAiClientConfig,
  readImageAsDataUrl,
  requestJson,
} from "./http.js";
import { assertPromptBudget, referenceLimitFor } from "./image-profile.js";
import { maskAwareDataUrl, parseDataUri, rasterToCanvasPng } from "./image-util.js";
import { parseOpenRouterUsage } from "./usage.js";

/**
 * OpenRouter 專用影像 transport。與 CLI2Proxy 的 images/chat adapter 並列為第三種形狀，
 * 差異僅在 transport 層（端點、參考圖帶法、回傳解碼），內容／風格／reference 規則仍共用
 * `buildImageGenerationContract` 的 Codex-baseline 合約。
 *
 * OpenRouter 影像 API 形狀（https://openrouter.ai/docs image-generation）：
 *  - 連線 baseUrl：OpenRouter 影像 API 根 `.../api/v1/images`；模型清單沿用 `GET /models`。
 *  - 生成端點：`POST {baseUrl}/`，避免模型清單與生成需要兩組不同的 connection URL。
 *  - 參考圖：JSON body 的 `input_references: [{ type:"image_url", image_url:{ url } }]`（可 data URL）。
 *  - 回傳：`data[0].b64_json`（媒體型別由 `data[0].media_type` 宣告，常見 image/jpeg 或 image/png）。
 */

interface OpenRouterReference {
  type: "image_url";
  image_url: { url: string };
}

function openRouterPrompt(request: ImageGenerationRequest): string {
  return [
    request.edit
      ? "Edit the supplied 16:9 presentation slide and return exactly one raster image."
      : "Generate exactly one complete 16:9 presentation slide as a raster image.",
    buildImageGenerationContract(request),
  ].join("\n");
}

/** 從 OpenRouter `/images` 回應取出第一張圖的 { mediaType, bytes }。 */
export function extractOpenRouterImage(payload: unknown): { mediaType: string; bytes: Uint8Array } {
  const data = (payload as { data?: unknown })?.data;
  const first = Array.isArray(data)
    ? (data[0] as { b64_json?: unknown; media_type?: unknown })
    : undefined;
  const b64 = typeof first?.b64_json === "string" ? first.b64_json : undefined;
  if (!b64)
    throw new SafeProviderError("OPENAI_IMAGE_MISSING", "OpenRouter 回應缺少 b64_json 圖片資料。");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.byteLength <= 0)
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "OpenRouter 圖片資料為空。");
  const declared = typeof first?.media_type === "string" ? first.media_type.toLowerCase() : "";
  const mediaType = detectImageMediaType(bytes) ?? (declared || "image/png");
  return { mediaType, bytes };
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

export async function generateViaOpenRouter(
  config: OpenAiClientConfig,
  model: string,
  request: ImageGenerationRequest,
  profile: ImageModelProfile,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; usage: ProviderUsage }> {
  const limit = referenceLimitFor("openrouter-image", profile);
  if (request.references.length > limit) {
    throw new SafeProviderError(
      "OPENAI_IMAGE_REFERENCES_LIMIT",
      `OpenRouter 圖片生成每頁最多接受 ${limit} 張參考圖。`,
    );
  }
  validateEditReferences(request);
  const prompt = openRouterPrompt(request);
  assertPromptBudget(prompt, profile);
  const inputReferences: OpenRouterReference[] = [];
  for (const [index, reference] of request.references.entries()) {
    // input_references 是給模型「看」的視覺通道（無 alpha 語意的 edit 端點），
    // 遮罩同 chat transport：先攤平成不透明黑底，否則透明底會被攤成全白而隱形。
    inputReferences.push({
      type: "image_url",
      image_url: {
        url: maskAwareDataUrl(await readImageAsDataUrl(reference.path), index, request),
      },
    });
  }
  const payload = await requestJson(config, {
    method: "POST",
    path: "/",
    body: {
      model,
      prompt,
      ...(inputReferences.length > 0 ? { input_references: inputReferences } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  // OpenRouter 的 images 端點雖然也叫 images，欄位名卻同 chat（prompt/completion_tokens）
  // 且多一個 `cost`——那就是 (a) 的形狀，`parseOpenRouterUsage` 只是同一個函式的別名。
  // 先解 usage 再解圖：解不出圖是往返成功之後才失敗的，token 已經燒掉了。
  const usage = parseOpenRouterUsage(payload);
  const { mediaType, bytes } = withProviderUsage(usage, () => extractOpenRouterImage(payload));
  try {
    if (mediaType === "image/png") {
      validatePngStructure(Buffer.from(bytes));
      return { bytes: normalizePngToCanvas(bytes, request.width, request.height), usage };
    }
    return {
      bytes: await rasterToCanvasPng(bytes, mediaType, request.width, request.height),
      usage,
    };
  } catch (error) {
    throw attachProviderCallFacts(error, { usage });
  }
}

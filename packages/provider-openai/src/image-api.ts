import {
  aspectRatioLabel,
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
  readImageBytes,
  requestJson,
} from "./http.js";
import { assertPromptBudget, referenceLimitFor } from "./image-profile.js";
import { flattenMaskToBlack, rasterToCanvasPng } from "./image-util.js";
import { parseImagesApiUsage } from "./usage.js";

function assertReferenceLimit(request: ImageGenerationRequest, limit: number): void {
  if (request.references.length > limit)
    throw new SafeProviderError(
      "OPENAI_IMAGE_REFERENCES_LIMIT",
      `Images API 圖片生成每頁最多接受 ${limit} 張參考圖。`,
    );
}

/**
 * 這條 REST 路徑上的尺寸欄位。`size` 是 gpt-image 系的像素字串，`aspect_ratio`＋
 * `resolution` 是 xAI Grok Imagine 的講法——同一個端點形狀、不同的欄位名，正是 profile
 * 存在的理由。`image_size`（Gemini 系 chat translator 的講法）在這條路上沒有對應欄位，
 * 與 `none` 一樣不送；模型庫寫入時會擋掉這種組合，這裡只是不假設它被擋住了。
 */
function sizingFields(
  profile: ImageModelProfile,
  request: ImageGenerationRequest,
): Record<string, string> {
  const sizing = profile.sizing;
  if (sizing.mode === "size") return { size: sizing.value };
  if (sizing.mode === "aspect_ratio") {
    const ratio = aspectRatioLabel(request.width, request.height);
    return { ...(ratio ? { aspect_ratio: ratio } : {}), resolution: sizing.resolution };
  }
  return {};
}

function imagesPrompt(request: ImageGenerationRequest): string {
  return [
    request.edit
      ? "Edit the supplied 16:9 presentation slide and return exactly one PNG."
      : "Generate exactly one complete 16:9 presentation slide as a PNG.",
    buildImageGenerationContract(request),
  ].join("\n");
}

function decodeB64Image(payload: unknown): Uint8Array {
  const data = (payload as { data?: unknown })?.data;
  const first = Array.isArray(data) ? (data[0] as { b64_json?: unknown }) : undefined;
  const b64 = typeof first?.b64_json === "string" ? first.b64_json : undefined;
  if (!b64)
    throw new SafeProviderError("OPENAI_IMAGE_MISSING", "Images API 回應缺少 b64_json 圖片資料。");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.byteLength <= 0)
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "Images API 圖片資料為空。");
  return bytes;
}

// 參考圖／base／mask 一律走 http.ts 的 `readImageBytes`（O_NOFOLLOW＋大小限制＋magic
// bytes 驗證），與 chat／openrouter 通道的 `readImageAsDataUrl` 同一條安全讀取路徑；不再用
// 裸 `readFile`（會跟隨 symlink、也不驗證檔案內容）。mediaType 取自檔案 magic bytes 而非
// 呼叫端宣告的值，更難被指向非影像的路徑騙過。
async function imageBlob(path: string): Promise<Blob> {
  const { mediaType, bytes } = await readImageBytes(path);
  return new Blob([bytes], { type: mediaType });
}

async function requestGeneration(
  config: OpenAiClientConfig,
  model: string,
  request: ImageGenerationRequest,
  profile: ImageModelProfile,
  signal?: AbortSignal,
): Promise<unknown> {
  const prompt = imagesPrompt(request);
  assertPromptBudget(prompt, profile);
  const fields = sizingFields(profile, request);
  // 有參考圖的「生成」走 /images/edits + image[] 陣列（gpt-image 用參考圖生成新圖的
  // 官方用法）；/images/generations 不吃輸入影像，故無參考圖時才走它。
  if (request.references.length > 0) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set("n", "1");
    form.set("response_format", "b64_json");
    for (const reference of request.references) {
      form.append("image[]", await imageBlob(reference.path), "image.png");
    }
    return requestJson(config, {
      method: "POST",
      path: "/images/edits",
      body: form,
      ...(signal ? { signal } : {}),
    });
  }
  return requestJson(config, {
    method: "POST",
    path: "/images/generations",
    body: {
      model,
      prompt,
      ...fields,
      n: 1,
      response_format: "b64_json",
    },
    ...(signal ? { signal } : {}),
  });
}

async function requestEdit(
  config: OpenAiClientConfig,
  model: string,
  request: ImageGenerationRequest,
  profile: ImageModelProfile,
  signal?: AbortSignal,
): Promise<unknown> {
  const edit = request.edit!;
  const base = request.references[edit.baseImageIndex];
  if (!base) throw new SafeProviderError("OPENAI_IMAGE_BASE_MISSING", "找不到要編輯的基底影像。");
  const prompt = imagesPrompt(request);
  assertPromptBudget(prompt, profile);
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  for (const [key, value] of Object.entries(sizingFields(profile, request))) form.set(key, value);
  form.set("n", "1");
  form.set("response_format", "b64_json");
  if (edit.maskImageIndex !== undefined && !request.references[edit.maskImageIndex])
    throw new SafeProviderError("OPENAI_IMAGE_MASK_MISSING", "找不到遮罩影像。");
  // 依 index 順序 attach **每一張** reference：合約會把 request.references 逐筆列成
  // Image N，只送 base+mask 的話，有風格參考圖的專案 prompt 會說「Image 3: role=style」
  // 卻沒有第三張圖，編號從那裡起全部錯位。
  //
  // mask 不放官方的 `mask` 欄位，改以攤平後的**可讀影像**放進 image[]：放 `mask` 欄位模型
  // 根本讀不到，合約的「Image 2 is a locator ... Read it to find that part」因此形同虛設；
  // 且官方 alpha 語意與本專案相反（官方透明＝可編輯，本專案白＝要改），送未翻轉的遮罩
  // 對嚴格端點等於「保留使用者選的區域、改掉其他全部」。空間保證由 server 端的
  // compositeMaskedEdit 承擔（那條不動）。
  for (const [index, reference] of request.references.entries()) {
    if (index === edit.maskImageIndex) {
      // 遮罩是「白框＋透明底」；視覺模型會把透明底攤成白色而看不到白框，故先攤成
      // 不透明黑底白框（與 chat／gemini 通道的 maskAwareDataUrl 同一處理）。mediaType 取自
      // 安全讀取判定的 magic bytes，不再信呼叫端宣告的值。
      const { mediaType, bytes } = await readImageBytes(reference.path);
      const flattened = flattenMaskToBlack(bytes, mediaType, request.width, request.height);
      // 攤平後的 bytes 型別是 Uint8Array<ArrayBufferLike>，BlobPart 要求
      // ArrayBufferView<ArrayBuffer>；這次複製只為滿足型別，不是語意需求。
      form.append(
        "image[]",
        new Blob([new Uint8Array(flattened)], { type: "image/png" }),
        "mask.png",
      );
      continue;
    }
    form.append(
      "image[]",
      await imageBlob(reference.path),
      index === edit.baseImageIndex ? "image.png" : `reference-${index}.png`,
    );
  }
  return requestJson(config, {
    method: "POST",
    path: "/images/edits",
    body: form,
    ...(signal ? { signal } : {}),
  });
}

export async function generateViaImagesApi(
  config: OpenAiClientConfig,
  model: string,
  request: ImageGenerationRequest,
  profile: ImageModelProfile,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; usage: ProviderUsage }> {
  assertReferenceLimit(request, referenceLimitFor("images", profile));
  const payload = request.edit
    ? await requestEdit(config, model, request, profile, signal)
    : await requestGeneration(config, model, request, profile, signal);
  // images 端點的 usage 欄位名與 /chat/completions **完全不同**（input_tokens 而非
  // prompt_tokens）；套錯解析器會讓整條影像通道靜默落成 reported:false。
  // 先解 usage 再解圖：解不出圖是往返成功之後才失敗的，token 已經燒掉了。
  const usage = parseImagesApiUsage(payload);
  const raw = withProviderUsage(usage, () => decodeB64Image(payload));
  // gateway 不保證回 PNG（實測 gpt-image gateway 會回 jpeg/webp）。比照 chat／openrouter
  // 通道：png 走結構驗證＋canvas 正規化；其餘 raster 走 rasterToCanvasPng 轉成 canvas PNG。
  // 認不得的格式丟具名 SafeProviderError，而非讓 validatePngStructure 以標著「Codex」的裸
  // Error 冒到上層（那訊息來自共用的 PNG 驗證，不指涉任何一條通道）。
  const mediaType = detectImageMediaType(raw);
  if (mediaType === "image/png") {
    validatePngStructure(Buffer.from(raw));
    return { bytes: normalizePngToCanvas(raw, request.width, request.height), usage };
  }
  if (mediaType)
    return {
      bytes: await rasterToCanvasPng(raw, mediaType, request.width, request.height),
      usage,
    };
  throw new SafeProviderError("OPENAI_IMAGE_INVALID", "Images API 回應的影像格式無法辨識。", {
    usage,
  });
}

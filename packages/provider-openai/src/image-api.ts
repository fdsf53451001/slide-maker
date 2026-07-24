import { readFile } from "node:fs/promises";
import {
  buildImageGenerationContract,
  SafeProviderError,
  type ImageGenerationRequest,
} from "@slide-maker/core";
import { normalizePngToCanvas, validatePngStructure } from "@slide-maker/provider-codex";
import { type OpenAiClientConfig, requestJson } from "./http.js";
import { flattenMaskToBlack } from "./image-util.js";

/**
 * `image[]` 的張數上限。
 *
 * 這條通道的限制與 chat／openrouter 的 8 張不同源：那兩條把影像 base64 內嵌進 JSON body，
 * 卡的是 token 與 body 大小；這條是 multipart file part，卡的是端點自身對 `image[]` 的
 * 張數上限（gpt-image 系列為 16）。沒有上限時，參考圖一多就只會拿到 gateway 的不透明
 * 400，錯誤訊息無法指向真正原因，故比照其他 transport 在送出前擋下。
 */
const MAX_IMAGES_REFERENCES = 16;

function assertReferenceLimit(request: ImageGenerationRequest): void {
  if (request.references.length > MAX_IMAGES_REFERENCES)
    throw new SafeProviderError(
      "OPENAI_IMAGE_REFERENCES_LIMIT",
      `Images API 圖片生成每頁最多接受 ${MAX_IMAGES_REFERENCES} 張參考圖。`,
    );
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

async function imageBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readFile(path);
  if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024)
    throw new SafeProviderError("OPENAI_IMAGE_INPUT_INVALID", "編輯輸入影像不合法或過大。");
  return new Uint8Array(bytes);
}

async function imageBlob(path: string, mediaType: string): Promise<Blob> {
  return new Blob([await imageBytes(path)], { type: mediaType || "image/png" });
}

async function requestGeneration(
  config: OpenAiClientConfig,
  model: string,
  request: ImageGenerationRequest,
  size: string,
  signal?: AbortSignal,
): Promise<unknown> {
  // 有參考圖的「生成」走 /images/edits + image[] 陣列（gpt-image 用參考圖生成新圖的
  // 官方用法）；/images/generations 不吃輸入影像，故無參考圖時才走它。
  if (request.references.length > 0) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", imagesPrompt(request));
    form.set("size", size);
    form.set("n", "1");
    form.set("response_format", "b64_json");
    for (const reference of request.references) {
      form.append("image[]", await imageBlob(reference.path, reference.mediaType), "image.png");
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
      prompt: imagesPrompt(request),
      size,
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
  size: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const edit = request.edit!;
  const base = request.references[edit.baseImageIndex];
  if (!base) throw new SafeProviderError("OPENAI_IMAGE_BASE_MISSING", "找不到要編輯的基底影像。");
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", imagesPrompt(request));
  form.set("size", size);
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
      // 不透明黑底白框（與 chat／gemini 通道的 maskAwareDataUrl 同一處理）。
      const flattened = flattenMaskToBlack(
        await imageBytes(reference.path),
        reference.mediaType || "image/png",
        request.width,
        request.height,
      );
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
      await imageBlob(reference.path, reference.mediaType),
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
  size: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertReferenceLimit(request);
  const payload = request.edit
    ? await requestEdit(config, model, request, size, signal)
    : await requestGeneration(config, model, request, size, signal);
  const raw = decodeB64Image(payload);
  validatePngStructure(Buffer.from(raw));
  return normalizePngToCanvas(raw, request.width, request.height);
}

import { readFile } from "node:fs/promises";
import {
  buildImageGenerationContract,
  SafeProviderError,
  type ImageGenerationRequest,
} from "@slide-maker/core";
import { normalizePngToCanvas, validatePngStructure } from "@slide-maker/provider-codex";
import { type OpenAiClientConfig, requestJson } from "./http.js";

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

async function imageBlob(path: string, mediaType: string): Promise<Blob> {
  const bytes = await readFile(path);
  if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024)
    throw new SafeProviderError("OPENAI_IMAGE_INPUT_INVALID", "編輯輸入影像不合法或過大。");
  return new Blob([new Uint8Array(bytes)], { type: mediaType || "image/png" });
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
  form.set("image", await imageBlob(base.path, base.mediaType), "image.png");
  if (edit.maskImageIndex !== undefined) {
    const mask = request.references[edit.maskImageIndex];
    if (!mask) throw new SafeProviderError("OPENAI_IMAGE_MASK_MISSING", "找不到遮罩影像。");
    form.set("mask", await imageBlob(mask.path, mask.mediaType), "mask.png");
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
  const payload = request.edit
    ? await requestEdit(config, model, request, size, signal)
    : await requestGeneration(config, model, request, size, signal);
  const raw = decodeB64Image(payload);
  validatePngStructure(Buffer.from(raw));
  return normalizePngToCanvas(raw, request.width, request.height);
}

import {
  type ProviderAvailability,
  type ProviderPreflightResult,
  SafeProviderError,
  type StructuredTextProvider,
  type StructuredTextRequest,
} from "@slide-maker/core";
import { parseDataUri, parseLooseJson, readImageAsDataUrl } from "@slide-maker/provider-openai";
import {
  candidateParts,
  generateContent,
  GEMINI_IMAGE_INPUT_FALLBACK,
  probeReady,
  rethrowAsGeminiError,
  type GeminiClientConfig,
} from "./http.js";

export interface GeminiStructuredTextOptions {
  config: GeminiClientConfig;
  model: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "gemini"。 */
  id?: string;
}

type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** 串接 candidate 內所有 text part；part 可能夾帶 thoughtSignature，只取 text 鍵。 */
function extractText(payload: unknown): string {
  const text = candidateParts(payload)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
  if (text.trim() === "") throw new SafeProviderError("GEMINI_TEXT_EMPTY", "Gemini 文字回應為空。");
  return text;
}

/** 對接 AI Studio 原生 `:generateContent` 的結構化文字生成。 */
export class GeminiStructuredTextProvider implements StructuredTextProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  readonly #options: GeminiStructuredTextOptions;

  constructor(options: GeminiStructuredTextOptions) {
    this.id = options.id ?? "gemini";
    this.#options = options;
    const configured = Boolean(options.config.baseUrl && options.config.apiKey && options.model);
    this.availability = configured
      ? { status: "available" }
      : { status: "unavailable", reason: "需設定 Gemini 連線的 base URL、API key 與模型名稱。" };
  }

  async preflight(): Promise<ProviderPreflightResult> {
    if (this.availability.status !== "available") return { status: "disabled" };
    return { status: await probeReady(this.#options.config) };
  }

  async runStructured(request: StructuredTextRequest): Promise<unknown> {
    if (this.availability.status !== "available")
      throw new SafeProviderError("GEMINI_TEXT_DISABLED", "Gemini 文字 provider 未設定。");
    const parts: ContentPart[] = [{ text: request.prompt }];
    for (const path of request.imagePaths ?? []) {
      try {
        const { mediaType, bytes } = parseDataUri(await readImageAsDataUrl(path));
        parts.push({
          inlineData: { mimeType: mediaType, data: Buffer.from(bytes).toString("base64") },
        });
      } catch (error) {
        rethrowAsGeminiError(error, GEMINI_IMAGE_INPUT_FALLBACK);
      }
    }

    // 只送 responseMimeType，不送 responseSchema：後者僅吃 OpenAPI subset（無
    // additionalProperties、$ref/oneOf 支援有限），把本專案的 outputSchema 硬塞進去
    // 會在 schema 稍複雜時直接 400。約束改由 system instruction 內嵌 schema 承擔。
    const system = [
      "You are a strict JSON generator. Output ONLY one JSON value that validates against this JSON Schema.",
      "No markdown code fences, no comments, no prose, no keys outside the schema.",
      "JSON_SCHEMA",
      JSON.stringify(request.outputSchema),
    ].join("\n");
    // 推理模型偶發回非 JSON／空內容（例如整個 candidate 只剩 thought part），
    // 故對「解析失敗」這類暫時性錯誤重試數次。
    const transient = new Set(["GEMINI_RESPONSE_INVALID", "GEMINI_TEXT_EMPTY"]);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const payload = await generateContent(
          this.#options.config,
          this.#options.model,
          {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts }],
            generationConfig: { responseMimeType: "application/json" },
          },
          request.signal,
        );
        return parseJsonContent(extractText(payload));
      } catch (error) {
        lastError = error;
        const code = error instanceof SafeProviderError ? error.code : undefined;
        if (attempt === 3 || !code || !transient.has(code)) throw error;
      }
    }
    throw lastError;
  }
}

/** 寬鬆解析（去 ```json 圍欄、擷取首個 JSON 值）；失敗改掛 Gemini 錯誤碼與訊息。 */
function parseJsonContent(content: string): unknown {
  try {
    return parseLooseJson(content);
  } catch {
    throw new SafeProviderError("GEMINI_RESPONSE_INVALID", "Gemini 回應不是合法 JSON。");
  }
}

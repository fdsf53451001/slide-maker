import {
  jsonOnlySystemPrompt,
  type ProviderAvailability,
  type ProviderPreflightResult,
  runStructuredWithRetry,
  SafeProviderError,
  type StructuredTextProvider,
  type StructuredTextRequest,
  type StructuredTextResult,
} from "@slide-maker/core";
import {
  type OpenAiClientConfig,
  parseLooseJson,
  probeReady,
  readImageAsDataUrl,
  requestJson,
} from "./http.js";
import { parseChatCompletionsUsage } from "./usage.js";

export interface OpenAiStructuredTextOptions {
  config: OpenAiClientConfig;
  model: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "openai"。 */
  id?: string;
}

type ChatContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/**
 * 值得重試的錯誤碼：瀏覽／推理模型（尤其 Gemini）偶發回非 JSON／空內容。
 *
 * `OPENAI_TEXT_INVALID` 目前全 repo 沒有任何地方丟，是殘留值。留著是因為刪掉它今天沒有
 * 任何可觀察差異，而這一輪的前提是行為零改變——要刪是另一個 commit 的事。
 */
const OPENAI_TRANSIENT_TEXT_CODES: ReadonlySet<string> = new Set([
  "OPENAI_RESPONSE_INVALID",
  "OPENAI_TEXT_EMPTY",
  "OPENAI_TEXT_INVALID",
]);

function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices;
  const first = Array.isArray(choices)
    ? (choices[0] as { message?: { content?: unknown } })
    : undefined;
  const content = first?.message?.content;
  if (typeof content !== "string" || content.trim() === "")
    throw new SafeProviderError("OPENAI_TEXT_EMPTY", "OpenAI 文字回應為空。");
  return content;
}

/** 對接 OpenAI-compatible /chat/completions 的結構化文字生成（json_schema 強制輸出）。 */
export class OpenAiStructuredTextProvider implements StructuredTextProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  readonly #options: OpenAiStructuredTextOptions;

  constructor(options: OpenAiStructuredTextOptions) {
    this.id = options.id ?? "openai";
    this.#options = options;
    const configured = Boolean(options.config.baseUrl && options.config.apiKey && options.model);
    this.availability = configured
      ? { status: "available" }
      : {
          status: "unavailable",
          reason:
            "需設定 SLIDE_MAKER_OPENAI_BASE_URL、SLIDE_MAKER_OPENAI_API_KEY 與 SLIDE_MAKER_OPENAI_TEXT_MODEL。",
        };
  }

  async preflight(): Promise<ProviderPreflightResult> {
    if (this.availability.status !== "available") return { status: "disabled" };
    return { status: await probeReady(this.#options.config) };
  }

  async runStructured(request: StructuredTextRequest): Promise<StructuredTextResult> {
    if (this.availability.status !== "available")
      throw new SafeProviderError("OPENAI_TEXT_DISABLED", "OpenAI 文字 provider 未設定。");
    const parts: ChatContentPart[] = [{ type: "text", text: request.prompt }];
    for (const path of request.imagePaths ?? [])
      parts.push({ type: "image_url", image_url: { url: await readImageAsDataUrl(path) } });

    // 許多 gateway/模型不嚴格遵守 json_schema，再用 system 訊息與內嵌 schema 強化 JSON-only 輸出。
    const system = jsonOnlySystemPrompt(request.outputSchema);

    // 重試輪數、逐輪用量累加與 requests 語意見 `runStructuredWithRetry` 的 doc comment。
    return runStructuredWithRetry({
      request: () =>
        requestJson(this.#options.config, {
          method: "POST",
          path: "/chat/completions",
          body: {
            model: this.#options.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: parts },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "structured_output",
                schema: request.outputSchema,
                strict: true,
              },
            },
          },
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      parseUsage: parseChatCompletionsUsage,
      parseValue: (payload) => parseLooseJson(extractContent(payload)),
      transientCodes: OPENAI_TRANSIENT_TEXT_CODES,
    });
  }
}

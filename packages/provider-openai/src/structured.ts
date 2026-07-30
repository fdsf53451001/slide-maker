import {
  attachProviderCallFacts,
  mergeUsage,
  type ProviderAvailability,
  type ProviderPreflightResult,
  type ProviderUsage,
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
    const system = [
      "You are a strict JSON generator. Output ONLY one JSON value that validates against this JSON Schema.",
      "No markdown code fences, no comments, no prose, no keys outside the schema.",
      "JSON_SCHEMA",
      JSON.stringify(request.outputSchema),
    ].join("\n");
    // 瀏覽／推理模型（尤其 Gemini）偶發回非 JSON／空內容，故對「解析失敗」這類暫時性錯誤重試數次。
    const transient = new Set([
      "OPENAI_RESPONSE_INVALID",
      "OPENAI_TEXT_EMPTY",
      "OPENAI_TEXT_INVALID",
    ]);
    /**
     * **每一輪（含失敗輪）的用量都要併進來，而且要在丟棄 payload 之前併。**
     *
     * 這個迴圈的每一輪都是一個真的請求、一份完整的長 prompt：模型回了東西、只是不是合法
     * JSON，輸出 token 照算。只回傳最後一輪等於把成本低估到三分之一，而且正好在重試跑滿的
     * 那些最貴的情況低估最多。應用層的 `OUTLINE_MAX_ATTEMPTS` 也是三輪，兩層相乘後一次
     * 「生成大綱」最壞是 9 個真實請求——帳本必須看得到全部。
     */
    let accumulated: ProviderUsage | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const payload = await requestJson(this.#options.config, {
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
        });
        // usage 與內容出自**同一份**已解析的 payload：先前只挑 `choices[0]` 而把它整個丟掉。
        // 併進 accumulator 的動作必須排在解析之前——`extractContent`／`parseLooseJson` 正是
        // 這條路上會 throw 的那兩個，排在它們之後就等於「失敗輪的用量照樣遺失」。
        accumulated = mergeUsage(accumulated, parseChatCompletionsUsage(payload));
        return {
          value: parseLooseJson(extractContent(payload)),
          usage: accumulated,
          requests: attempt,
        };
      } catch (error) {
        lastError = error;
        const code = error instanceof SafeProviderError ? error.code : undefined;
        if (attempt === 3 || !code || !transient.has(code))
          throw attachProviderCallFacts(error, {
            ...(accumulated === undefined ? {} : { usage: accumulated }),
            requests: attempt,
          });
      }
    }
    throw attachProviderCallFacts(lastError, {
      ...(accumulated === undefined ? {} : { usage: accumulated }),
      requests: 3,
    });
  }
}

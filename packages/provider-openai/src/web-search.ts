import {
  type ProviderAvailability,
  type ProviderPreflightResult,
  SafeProviderError,
  type WebSearchProvider,
  type WebSearchResult,
  webSearchResultSchema,
} from "@slide-maker/core";
import { type OpenAiClientConfig, parseLooseJson, probeReady, requestJson } from "./http.js";

export interface OpenAiWebSearchOptions {
  config: OpenAiClientConfig;
  /** 具 web_search 工具能力的模型名（未設時退回文字模型）。 */
  model: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "openai"。 */
  id?: string;
}

function readableWebResult(result: WebSearchResult): boolean {
  const pathname = new URL(result.url).pathname.toLowerCase();
  return !/\.(?:pdf|zip|docx?|pptx?|xlsx?)(?:$|\/)/.test(pathname);
}

function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices;
  const first = Array.isArray(choices)
    ? (choices[0] as { message?: { content?: unknown } })
    : undefined;
  const content = first?.message?.content;
  return typeof content === "string" ? content : "";
}

function searchTool(model: string): { type: "web_search" } | { google_search: object } {
  // CLIProxyAPI's Gemini/Antigravity OpenAI-chat translator recognizes the
  // Gemini extension shape and converts it to upstream `googleSearch`. A typed
  // OpenAI `web_search` tool is only passed through by Codex/OpenAI routes.
  return /^gemini-/i.test(model) ? { google_search: {} } : { type: "web_search" };
}

function resultRows(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { results?: unknown }).results)
  )
    return (parsed as { results: unknown[] }).results;
  return [];
}

/**
 * 以具 web_search 工具能力的 OpenAI-compatible 模型作為搜尋後端。
 * 能力視 gateway/模型而定，不保證普遍可用（availability 由設定推斷）。
 */
export class OpenAiWebSearchProvider implements WebSearchProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  readonly #options: OpenAiWebSearchOptions;

  constructor(options: OpenAiWebSearchOptions) {
    this.id = options.id ?? "openai";
    this.#options = options;
    const configured = Boolean(options.config.baseUrl && options.config.apiKey && options.model);
    this.availability = configured
      ? {
          status: "available",
          warning: "網路搜尋能力取決於所選模型/gateway 是否支援 web_search 工具。",
        }
      : {
          status: "unavailable",
          reason:
            "需設定 SLIDE_MAKER_OPENAI_BASE_URL、SLIDE_MAKER_OPENAI_API_KEY 與文字/搜尋模型。",
        };
  }

  async preflight(): Promise<ProviderPreflightResult> {
    if (this.availability.status !== "available") return { status: "disabled" };
    return { status: await probeReady(this.#options.config) };
  }

  async search(
    query: string,
    limit: number,
    language: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    if (this.availability.status !== "available")
      throw new SafeProviderError("OPENAI_WEB_SEARCH_DISABLED", "OpenAI 網路搜尋未設定。");
    const payload = await requestJson(this.#options.config, {
      method: "POST",
      path: "/chat/completions",
      body: {
        model: this.#options.model,
        tools: [searchTool(this.#options.model)],
        ...(/^gemini-/i.test(this.#options.model) ? {} : { tool_choice: "auto" }),
        // Gemini via CLIProxyAPI must receive `google_search`; sending the
        // OpenAI built-in type silently omits the native search tool.
        // Keep the prompt short and do not combine json_schema with search.
        // 下載檔（PDF 等）由 readableWebResult 事後過濾；搜尋結果一律視為 untrusted，由下游 prompt 約束。
        messages: [
          {
            role: "system",
            content:
              'Reply ONLY with JSON {"results":[{"url":"...","title":"...","summary":"..."}]}',
          },
          {
            role: "user",
            content: `Query: ${query}. Return up to ${limit} pages with url, title, and a short summary in ${language}.`,
          },
        ],
      },
      ...(signal ? { signal } : {}),
    });

    const rows = resultRows(parseLooseJson(extractContent(payload)));
    const results: WebSearchResult[] = [];
    for (const row of rows) {
      const candidate = webSearchResultSchema.safeParse(row);
      if (candidate.success && readableWebResult(candidate.data)) results.push(candidate.data);
    }
    if (results.length === 0)
      throw new SafeProviderError(
        "OPENAI_WEB_SEARCH_EMPTY",
        "Gemini 搜尋未回傳可驗證格式的網頁候選結果。",
      );
    return results.slice(0, limit);
  }
}

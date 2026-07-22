import {
  type ProviderAvailability,
  type ProviderPreflightResult,
  SafeProviderError,
  type WebSearchProvider,
  type WebSearchResult,
  webSearchResultSchema,
} from "@slide-maker/core";
import {
  assertPublicHttpUrl,
  isPublicHttpUrl,
  isReadableWebUrl,
} from "@slide-maker/core/url-safety";
import { generateContent, probeReady, type GeminiClientConfig } from "./http.js";

export interface GeminiWebSearchOptions {
  config: GeminiClientConfig;
  model: string;
  /** Registry id 覆寫（模型庫 entry id）。未設回退 "gemini"。 */
  id?: string;
}

const MAX_SUMMARY_CHARS = 4_000;
/** 單筆重導向只是讀一個 location header，不需要秒級以上的耐心。 */
const REDIRECT_TIMEOUT_MS = 4_000;
/** 全部重導向共用的總預算：逾時者退回原 uri，不讓搜尋整體卡住上游的重試迴圈。 */
const REDIRECT_BUDGET_MS = 15_000;
/** 多支撐段落的前綴，標示這段話同時被其他來源支撐、不專屬本頁。 */
const SHARED_SUPPORT_PREFIX = "（多來源共同支撐）";

interface GroundingChunk {
  web?: { uri?: unknown; title?: unknown };
}

interface GroundingSupport {
  segment?: { text?: unknown };
  groundingChunkIndices?: unknown;
}

function groundingMetadata(payload: unknown): {
  chunks: GroundingChunk[];
  supports: GroundingSupport[];
} {
  const candidates = (payload as { candidates?: unknown })?.candidates;
  const metadata = Array.isArray(candidates)
    ? (
        candidates[0] as {
          groundingMetadata?: { groundingChunks?: unknown; groundingSupports?: unknown };
        }
      )?.groundingMetadata
    : undefined;
  return {
    chunks: Array.isArray(metadata?.groundingChunks)
      ? (metadata.groundingChunks as GroundingChunk[])
      : [],
    supports: Array.isArray(metadata?.groundingSupports)
      ? (metadata.groundingSupports as GroundingSupport[])
      : [],
  };
}

/** 一個 chunk 的摘要素材：專屬（只支撐這一頁）與共享（同時支撐多頁）的段落分開存。 */
interface ChunkSupport {
  exclusive: string[];
  shared: string[];
}

/**
 * 把 groundingSupports 的被支撐段落聚合回各 chunk。
 *
 * grounding 回的 `web` 只有 uri 與網域名 title，完全沒有摘要，而 `WebSearchResult`
 * 需要 summary。唯一可用且非模型憑空生成的素材，就是「這段輸出由這幾個 chunk 支撐」
 * 的 segment 文字，故以 chunk index 反向聚合。
 *
 * **`groundingChunkIndices` 是多對一語意**：`[0,1]` 表示這段輸出同時由 chunk 0 與 1
 * 支撐，並不表示這段話的內容出自其中任何一頁。若把整段原文塞給每個 index，A 站的摘要
 * 就可能整句在講 B 站的內容，而這份 summary 會進 prompt 的 sourceCatalog 與編輯器的
 * 來源卡片。因此只有 `length === 1` 的專屬段落算得上這一頁的摘要，多重支撐段落降級為
 * 補充素材並加前綴標註，僅在沒有專屬段落時才拿來湊。
 */
function summariesByChunk(supports: GroundingSupport[]): Map<number, ChunkSupport> {
  const byChunk = new Map<number, ChunkSupport>();
  for (const support of supports) {
    const text = typeof support.segment?.text === "string" ? support.segment.text.trim() : "";
    if (!text) continue;
    const indices = support.groundingChunkIndices;
    if (!Array.isArray(indices)) continue;
    const valid = indices.filter(
      (index): index is number =>
        typeof index === "number" && Number.isInteger(index) && index >= 0,
    );
    const bucket: keyof ChunkSupport = valid.length === 1 ? "exclusive" : "shared";
    for (const index of valid) {
      const existing = byChunk.get(index) ?? { exclusive: [], shared: [] };
      if (!existing.exclusive.includes(text) && !existing.shared.includes(text))
        existing[bucket].push(text);
      byChunk.set(index, existing);
    }
  }
  return byChunk;
}

/** 專屬段落優先；多重支撐的段落加前綴標註為補充，避免被誤讀成本頁的原文摘要。 */
function summaryText(support: ChunkSupport | undefined): string {
  if (!support) return "";
  return [
    ...support.exclusive,
    ...support.shared.map((text) => `${SHARED_SUPPORT_PREFIX}${text}`),
  ].join("\n");
}

/**
 * 把 grounding 的 302 中繼網址解成真實網址。
 *
 * 中繼網址有時效性，而 `WebSearchResult.url` 會被寫進專案來源資料，過期後就再也抓不回
 * 正文。只發一次 manual redirect 的 HEAD 請求讀 `location`（HEAD 而非 GET：若中繼網址
 * 直接回 200，GET 會開始下載一份沒有上限的 body）。起點與終點都過與 web-capture 同一份
 * SSRF 檢查（拒非 http(s)、拒私有網段）。
 *
 * 回傳 `undefined` 專指**起點 uri 本身不合法**這一種情形——此時呼叫端必須整筆捨棄，
 * 不可退回原 uri：下游 `captureWebPage` 對這種網址是直接 throw（而非標記失敗），會讓
 * 整個大綱生成回 500，等於一筆爛候選毒死整次生成。網路層失敗（連不上、逾時、HEAD 不
 * 被支援、無 location）則退回原 uri，中繼網址本身仍可被下游追蹤，沒必要丟掉候選。
 */
async function resolveRedirect(uri: string, signal?: AbortSignal): Promise<string | undefined> {
  let start: URL;
  try {
    start = assertPublicHttpUrl(uri);
  } catch {
    return undefined;
  }
  let response: Response | undefined;
  try {
    const timeout = AbortSignal.timeout(REDIRECT_TIMEOUT_MS);
    response = await fetch(start, {
      method: "HEAD",
      redirect: "manual",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { "User-Agent": "SlideMaker/0.1 source-capture" },
    });
    if (response.status < 300 || response.status >= 400) return uri;
    const location = response.headers.get("location");
    if (!location) return uri;
    const target = assertPublicHttpUrl(new URL(location, start).toString()).toString();
    return target;
  } catch {
    return uri;
  } finally {
    void response?.body?.cancel().catch(() => undefined);
  }
}

/**
 * 以 AI Studio 原生 Google Search grounding 作為搜尋後端。
 *
 * 網址與標題直接讀 `groundingMetadata`，不要模型輸出 JSON 清單：uri 由 Google 提供而非
 * 模型生成，天生不會幻覺。也因此不可與 `responseMimeType: "application/json"` 並用
 * ——Google 不允許 tools 與結構化輸出同時指定。
 */
export class GeminiWebSearchProvider implements WebSearchProvider {
  readonly id: string;
  readonly availability: ProviderAvailability;
  readonly #options: GeminiWebSearchOptions;

  constructor(options: GeminiWebSearchOptions) {
    this.id = options.id ?? "gemini";
    this.#options = options;
    const configured = Boolean(options.config.baseUrl && options.config.apiKey && options.model);
    this.availability = configured
      ? {
          status: "available",
          warning: "網路搜尋能力取決於所選模型是否支援 Google Search grounding。",
        }
      : { status: "unavailable", reason: "需設定 Gemini 連線的 base URL、API key 與模型名稱。" };
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
      throw new SafeProviderError("GEMINI_WEB_SEARCH_DISABLED", "Gemini 網路搜尋未設定。");
    const payload = await generateContent(
      this.#options.config,
      this.#options.model,
      {
        // 搜尋結果一律視為 untrusted，由下游 prompt 約束；此處只求覆蓋足夠多的來源，
        // 因為只有被引用到的 chunk 才組得出 summary，沒被引用的候選會被捨棄。
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Search the web for: ${query}\nWrite a factual briefing in ${language} that cites at least ${limit} distinct web pages, giving each cited page its own sentence or paragraph of concrete detail.`,
              },
            ],
          },
        ],
        tools: [{ googleSearch: {} }],
      },
      signal,
    );

    const { chunks, supports } = groundingMetadata(payload);
    const summaries = summariesByChunk(supports);
    // 先篩再解：組不出 summary 的 chunk 直接捨棄（用網域名或空白填充等於把未驗證的
    // 空殼當成合格候選），剩下的才值得花一次網路請求解重導向。
    const candidates: { uri: string; title: string; lines: string[] }[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const uri = typeof chunk.web?.uri === "string" ? chunk.web.uri : "";
      const summary = summaryText(summaries.get(index));
      if (!uri || !summary.trim()) continue;
      candidates.push({
        uri,
        title: typeof chunk.web?.title === "string" ? chunk.web.title : "",
        lines: summary.split("\n"),
      });
    }

    // 重導向一次解完而非逐筆 await：上游對 search() 有重試迴圈（8 筆 × 5 次），序列化
    // 的單筆逾時會相乘成數百秒，而 server 呼叫 search() 時不一定傳得進 signal，中途無
    // 從取消。整批共用一個總預算，逾時者由 resolveRedirect 退回原 uri。
    // 取 limit 的兩倍：去重後同一頁的多個 chunk 只算一筆，需要餘裕才填得滿 limit。
    const budget = AbortSignal.timeout(REDIRECT_BUDGET_MS);
    const resolveSignal = signal ? AbortSignal.any([budget, signal]) : budget;
    const pending = candidates.slice(0, limit * 2);
    const resolved = await Promise.all(
      pending.map((candidate) => resolveRedirect(candidate.uri, resolveSignal)),
    );
    if (signal?.aborted) throw new DOMException("Gemini search cancelled", "AbortError");

    // grounding 常對同一頁回多個 chunk（不同 segment 引用同一來源），解開重導向後才看
    // 得出是同一個網址。以解析後的網址去重，並把同一頁的多段摘要併進同一筆；重複項不
    // 計入 limit，否則 limit=8 可能只換到兩三個不同來源，下游還會存出重複的 url。
    const byUrl = new Map<string, { url: string; title: string; lines: string[] }>();
    for (const [index, candidate] of pending.entries()) {
      const url = resolved[index];
      // 解析後的網址再過一次安全檢查：確保沒有任何路徑能產出下游會硬 throw 的網址。
      if (!url || !isPublicHttpUrl(url)) continue;
      const existing = byUrl.get(url);
      if (existing) {
        for (const line of candidate.lines)
          if (!existing.lines.includes(line)) existing.lines.push(line);
        // 同一頁的其中一個 chunk 可能沒帶 title，別讓它決定整筆的存亡（title 空字串
        // 過不了 schema 的 min(1)）。
        if (!existing.title) existing.title = candidate.title;
        continue;
      }
      if (byUrl.size >= limit) continue;
      byUrl.set(url, { url, title: candidate.title, lines: [...candidate.lines] });
    }

    const results: WebSearchResult[] = [];
    for (const entry of byUrl.values()) {
      const candidate = webSearchResultSchema.safeParse({
        url: entry.url,
        title: entry.title,
        summary: entry.lines.join("\n").slice(0, MAX_SUMMARY_CHARS),
      });
      // 副檔名預篩只在重導向解得開時才有意義：退回中繼網址時 pathname 是不透明的
      // `/grounding-api-redirect/…`，看不出附件型別，改由 captureWebPage 的 content-type
      // 檢查把關（非文字型別會停在 summary_only，不會進來源）。
      if (candidate.success && isReadableWebUrl(candidate.data.url)) results.push(candidate.data);
    }
    if (results.length === 0)
      throw new SafeProviderError(
        "GEMINI_WEB_SEARCH_EMPTY",
        "Gemini 搜尋未回傳可驗證的網頁候選結果。",
      );
    return results;
  }
}

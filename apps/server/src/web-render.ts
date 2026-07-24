/**
 * 動態網頁（SPA）的正文補抓：把「跑得動 JavaScript 的 render 服務」抽象成一個介面。
 *
 * `web-capture.ts` 是純 fetch + regex 剝標籤，對 client-side rendering 的站台只會拿到
 * 一個空的 `<div id="root">` 殼。這裡定義的 `HtmlRenderer` 是那條路的 fallback——**只是
 * fallback**：呼叫端（`captureWebPage`）必須先判定原生擷取拿到的是空殼才會用它。
 *
 * 介面化而非把 Jina 寫死在呼叫端，是因為這是「把使用者的網址與內容送去第三方」的決定，
 * 未來換成自架 headless browser、或依部署環境停用，都不該去動擷取邏輯本身。
 */

import { assertPublicHttpUrl } from "@slide-maker/core/url-safety";
import { DEFAULT_WEB_RENDER_TIMEOUT_MS, type WebRenderEngine } from "./config.js";
import { MAX_WEB_BYTES } from "./web-capture.js";

export interface HtmlRenderer {
  /** 供 `metadata.renderedBy` 記錄，讓來源可被查證是經哪個第三方渲染取得。 */
  readonly name: string;
  /** 回純文字／markdown 正文；失敗一律 throw（呼叫端負責吞掉並沿用原生結果）。 */
  render(url: URL): Promise<string>;
}

export interface HtmlRendererOptions {
  /** 未設走無金鑰模式（Jina 免費配額約 20 RPM）。 */
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  /** 測試注入用；預設就是全域 fetch。 */
  fetcher?: typeof fetch | undefined;
}

const JINA_READER_ENDPOINT = "https://r.jina.ai/";

/**
 * Jina Reader（`https://r.jina.ai/<原始網址>`）adapter。
 *
 * 網址是**原樣串接**在端點後面（含 query string），這是 Jina Reader 的介面約定；串接前
 * 先過一次 `assertPublicHttpUrl`，免得把 `file://`／內網位址交給第三方去解。
 */
export function createJinaRenderer({
  apiKey,
  timeoutMs = DEFAULT_WEB_RENDER_TIMEOUT_MS,
  fetcher = fetch,
}: HtmlRendererOptions = {}): HtmlRenderer {
  return {
    name: "jina",
    async render(url: URL): Promise<string> {
      const target = assertPublicHttpUrl(url.toString());
      const response = await fetcher(`${JINA_READER_ENDPOINT}${target.toString()}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "text/plain",
          "X-Return-Format": "markdown",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      });
      // 限流與其他 HTTP 失敗要分得開：429 是「等一下再試」，其餘是這一筆本身有問題。
      if (response.status === 429) throw new Error("WEB_RENDER_RATE_LIMITED");
      if (!response.ok) throw new Error(`WEB_RENDER_HTTP_${response.status}`);
      // 上限沿用 `captureWebPage` 的 `MAX_WEB_BYTES`：兩條路抓的是同一份網頁正文，
      // 各自定一個數字遲早會分歧。宣告值與實際位元組都檢查，前者只是省下白讀的成本。
      if (Number(response.headers.get("content-length") ?? "0") > MAX_WEB_BYTES)
        throw new Error("WEB_RENDER_TOO_LARGE");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_WEB_BYTES) throw new Error("WEB_RENDER_TOO_LARGE");
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
      if (!text) throw new Error("WEB_RENDER_EMPTY");
      return text;
    },
  };
}

/**
 * `SLIDE_MAKER_WEB_RENDER_ENGINE=none` 時用的 renderer：不發任何請求，一律失敗。
 *
 * 不用 `undefined` 表示「停用」，是因為「有沒有 renderer」在 `captureWebPage` 裡另有語意
 * ——傳了就代表呼叫端要的是**真正的正文**，補抓後仍是空殼不得冒充 `full`。停用第三方
 * 服務不該順帶把「空殼也算數」這個較鬆的標準偷渡回貼網址通道，兩件事必須分開。
 */
export const DISABLED_RENDERER: HtmlRenderer = {
  name: "none",
  render: () => Promise.reject(new Error("WEB_RENDER_DISABLED")),
};

/** 依設定選出 renderer；`none` 得到不發請求的停用版本。 */
export function createHtmlRenderer(
  engine: WebRenderEngine,
  options: HtmlRendererOptions = {},
): HtmlRenderer {
  return engine === "jina" ? createJinaRenderer(options) : DISABLED_RENDERER;
}

/**
 * 動態網頁（SPA）的正文補抓：把「跑得動 JavaScript 的 render 服務」抽象成一個介面。
 *
 * `web-capture.ts` 是純 fetch + regex 剝標籤，對 client-side rendering 的站台只會拿到
 * 一個空的 `<div id="root">` 殼。這裡定義的 `HtmlRenderer` 補的就是那一段。
 *
 * 呼叫端有**兩種**用法，由 `CapturePageOptions.renderOnly` 決定：搜尋擷取路徑根本不傳
 * renderer（那些網址是模型給的，使用者沒有逐筆同意外送）；「貼上網址」則完全外包給它，
 * 不做原生 fetch——原生擷取＋空殼啟發式看不出混合渲染頁只有一半有內容。
 *
 * 介面化而非把 Jina 寫死在呼叫端，是因為這是「把使用者的網址與內容送去第三方」的決定，
 * 未來換成自架 headless browser、或依部署環境停用，都不該去動擷取邏輯本身。
 */

import { assertPublicHttpUrl } from "@slide-maker/core/url-safety";
import { DEFAULT_WEB_RENDER_TIMEOUT_MS, type WebRenderEngine } from "./config.js";
import { readCappedBytes } from "./web-body.js";
import { MAX_WEB_BYTES } from "./web-capture.js";

/** render 服務回來的一頁：正文，外加它自己宣告的標題（沒有就空字串）。 */
export interface RenderedPage {
  /** 已剝掉服務自身前言的正文。 */
  text: string;
  /**
   * render 服務宣告的頁面標題。
   *
   * 與正文**彼此獨立**，這正是它的價值：`captureWebPage` 靠「剝掉獨立來源的標題後還剩不剩
   * 東西」判斷這頁到底有沒有正文，拿正文的第一行當標題再剝掉它是循環論證。
   */
  title: string;
}

export interface HtmlRenderer {
  /** 供 `metadata.renderedBy` 記錄，讓來源可被查證是經哪個第三方渲染取得。 */
  readonly name: string;
  /** 回正文與標題；失敗一律 throw（呼叫端負責吞掉並沿用原生結果）。 */
  render(url: URL): Promise<RenderedPage>;
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
 * Jina Reader 回應的前言與正文分隔線。
 *
 * 實測（2026-07-24，`curl -H 'Accept: text/plain' https://r.jina.ai/https://example.com/`）
 * 回應是這個形狀：
 *
 * ```
 * Title: Example Domain
 *
 * URL Source: https://example.com/
 *
 * Published Time: Tue, 21 Jul 2026 07:16:00 GMT
 *
 * Warning: This is a cached snapshot of the original page, ...
 *
 * Markdown Content:
 * # Example Domain
 * ```
 *
 * `X-Return-Format` 與 `X-Respond-With` 兩個 header 的輸出**完全相同**，都帶這段前言。
 * 不剝掉的話它會被當成正文餵進模型，標題還會被推導成字面上的 `Title: Example Domain`。
 */
const MARKDOWN_CONTENT_MARKER = /^Markdown Content:[ \t]*\r?$/m;

/** 前言的欄位行；值可以是空的（例如某些頁沒有 `Published Time`）。 */
const HEADER_FIELD = /^([A-Za-z][A-Za-z ]*?):[ \t]*(.*)$/;

/**
 * 拆開 Jina Reader 的前言與正文。
 *
 * 找不到 `Markdown Content:` 就把整份當正文——服務的輸出格式不是我們控制的，格式一改
 * 就整批擷取失敗，比偶爾多收幾行前言更糟。
 */
export function parseJinaReader(raw: string): { fields: Map<string, string>; body: string } {
  const marker = MARKDOWN_CONTENT_MARKER.exec(raw);
  if (!marker) return { fields: new Map(), body: raw.trim() };
  const fields = new Map<string, string>();
  for (const line of raw.slice(0, marker.index).split(/\r?\n/)) {
    const field = HEADER_FIELD.exec(line.trim());
    if (field) fields.set(field[1]!.trim().toLowerCase(), field[2]!.trim());
  }
  return { fields, body: raw.slice(marker.index + marker[0].length).trim() };
}

/**
 * 兩個網址指的是不是同一頁：協定、主機、路徑（忽略結尾斜線）要一致，query 則允許回報方
 * 比請求**少**幾個參數。
 *
 * query 不能逐字比。實測（2026-08-02，三個網址各打一次 r.jina.ai）Jina 回報的 `URL Source`
 * 是 canonical 化後的網址：功能性參數原樣保留（`?tab=tech`、`?q=slide`、`?page=2` 都在），
 * 但追蹤參數會被剝掉——請求 `?utm_source=test&page=2` 回來的是 `?page=2`。逐字比的結果是
 * 把「同一頁」判成 `WEB_RENDER_URL_MISMATCH`，而使用者從社群貼文或電子報複製的網址幾乎
 * 都帶 `utm_*`，等於那一整類網址全部加不進來。
 *
 * 判準是**子集**而不是「剝掉一份追蹤參數黑名單再比」：黑名單得跟著對方的 canonical 化規則
 * 走（今天是 `utm_*`，明天可能是 `fbclid`、`ref`），漏一個就是同一種靜默失敗。子集判準對
 * 「對方少剝了什麼」免疫。放寬的只有 query，protocol／host／path 仍逐字比，所以剝參數最多
 * 讓範圍變窄，不會變成另一個站或另一條路徑。
 *
 * 已知殘留風險：被剝掉的參數若正好決定內容（`?id=123` 沒了會變成列表頁），子集判準看不出來。
 * 實測未見 Jina 剝這類參數，而對照組（逐字比）的代價是整類網址失敗，取捨後接受。
 *
 * fragment 不比，因為它根本不會送到伺服器（見 `web-capture.ts` 的 `isHashRouteUrl`）。
 */
function sameTarget(requested: URL, reported: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(reported);
  } catch {
    return false;
  }
  const origin = (url: URL) => `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  if (origin(parsed) !== origin(requested)) return false;
  // 同一個 key 可以重複（`?tag=a&tag=b`），所以逐 (key, value) 對計數，不能用 Set。
  const asked = new Map<string, number>();
  for (const [key, value] of requested.searchParams)
    asked.set(`${key}=${value}`, (asked.get(`${key}=${value}`) ?? 0) + 1);
  for (const [key, value] of parsed.searchParams) {
    const count = asked.get(`${key}=${value}`) ?? 0;
    if (count === 0) return false;
    asked.set(`${key}=${value}`, count - 1);
  }
  return true;
}

/**
 * Jina Reader（`https://r.jina.ai/<原始網址>`）adapter。
 *
 * 網址是**原樣串接**在端點後面（含 query string），這是 Jina Reader 的介面約定；串接前
 * 先過一次 `assertPublicHttpUrl`，免得把 `file://`／內網位址交給第三方去解，並剝掉
 * userinfo——`https://user:pw@host/` 直接串上去等於把帳密寫進第三方的 URL path（會進對方
 * 的存取紀錄）。
 */
export function createJinaRenderer({
  apiKey,
  timeoutMs = DEFAULT_WEB_RENDER_TIMEOUT_MS,
  fetcher,
}: HtmlRendererOptions = {}): HtmlRenderer {
  return {
    name: "jina",
    async render(url: URL): Promise<RenderedPage> {
      // 沒注入 fetcher 時在**呼叫時**解析全域 fetch，而不是建構時就綁定 `= fetch`。
      // `createApp` 在開機時就建好 renderer，若此刻綁定，之後任何換掉 `globalThis.fetch`
      // 的機制都失效——最實際的後果是 E2E 的 L0 零配額 guard（在 createApp 之後才裝）攔不住
      // 這條 render fallback，一個合法網址就會真的打到 r.jina.ai。呼叫時解析與 `captureWebPage`
      // 的 fetch 處理一致。
      const doFetch = fetcher ?? globalThis.fetch;
      const target = assertPublicHttpUrl(url.toString());
      target.username = "";
      target.password = "";
      const response = await doFetch(`${JINA_READER_ENDPOINT}${target.toString()}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "text/plain",
          "X-Return-Format": "markdown",
          // 免費模式**預設回快取快照**（實測：回應帶 `Warning: This is a cached snapshot`）。
          // 使用者手貼一個網址的意思是「現在去抓這一頁」，拿舊快照等於沒做事，所以一律
          // opt-out。代價是變慢、更容易撞到 20 RPM——正確性優先。
          "x-no-cache": "true",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      });
      // 限流與其他 HTTP 失敗要分得開：429 是「等一下再試」，其餘是這一筆本身有問題。
      if (response.status === 429) throw new Error("WEB_RENDER_RATE_LIMITED");
      if (!response.ok) throw new Error(`WEB_RENDER_HTTP_${response.status}`);
      // 上限沿用 `captureWebPage` 的 `MAX_WEB_BYTES`：兩條路抓的是同一份網頁正文，
      // 各自定一個數字遲早會分歧。共用 reader 同時檢查宣告與實際位元組數。
      const bytes = await readCappedBytes(response, MAX_WEB_BYTES, "WEB_RENDER_TOO_LARGE");
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
      if (!raw) throw new Error("WEB_RENDER_EMPTY");
      const { fields, body } = parseJinaReader(raw);
      const reported = fields.get("url source");
      // Jina 抓的不是我們要的那一頁時，默默收下等於把別頁的內容存成這個網址的來源。
      // 比較是「同一頁」而非逐字相等（結尾斜線不算差異），寧可嚴一點：判錯會以
      // WEB_RENDER_URL_MISMATCH 呈現給使用者，收錯內容則完全看不出來。
      if (reported && !sameTarget(target, reported)) throw new Error("WEB_RENDER_URL_MISMATCH");
      // Jina 用 `Warning:` 回報自己的狀況。一律當成這一筆失敗（那行字不是正文，收下等於
      // 把錯誤訊息存成來源），但**要分得開**——實測到的兩種 warning 對使用者的意義完全不同：
      //
      // - `Target URL returned error 400: Bad Request`：目標站擋掉了 render 服務。重試沒有用，
      //   使用者得改貼別的網址或自己複製內容。
      // - `This page maybe not yet fully loaded, consider explicitly specify a timeout.`：Jina
      //   自己的載入品質警告，那一頁還在動。重試是有意義的下一步（`x-timeout: 20` 實測擋不掉
      //   這個 warning，所以只能分類、不能靠調參解決）。
      //
      // 收斂成一句「render 服務回報異常」會讓前者被無限重試、後者被當成沒救而放棄。
      const warning = fields.get("warning");
      if (warning !== undefined) {
        if (/target url returned error/i.test(warning)) throw new Error("WEB_RENDER_TARGET_ERROR");
        if (/not yet fully loaded/i.test(warning)) throw new Error("WEB_RENDER_INCOMPLETE");
        throw new Error("WEB_RENDER_WARNING");
      }
      if (!body) throw new Error("WEB_RENDER_EMPTY");
      return { text: body, title: fields.get("title") ?? "" };
    },
  };
}

/**
 * 依設定選出 renderer；`none` 得到 `undefined`（＝這條路不呼叫任何第三方）。
 *
 * 「要不要呼叫第三方」與「什麼算正文」是兩個正交的政策：後者由 `captureWebPage` 的
 * `requireBody` 表達，不再靠「有沒有傳 renderer」偷渡，所以停用時就真的不必傳東西進去。
 */
export function createHtmlRenderer(
  engine: WebRenderEngine,
  options: HtmlRendererOptions = {},
): HtmlRenderer | undefined {
  return engine === "jina" ? createJinaRenderer(options) : undefined;
}

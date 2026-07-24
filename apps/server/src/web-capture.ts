import type { WebSearchResult } from "@slide-maker/core";
import { assertPublicHttpUrl as safePublicUrl } from "@slide-maker/core/url-safety";
import type { HtmlRenderer } from "./web-render.js";

export type { WebSearchResult } from "@slide-maker/core";

export const MAX_WEB_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_CHARS = 120_000;
const MAX_REDIRECTS = 5;

/**
 * 正文短於這個字數就當空殼。
 *
 * 400 字元大約是一段導言的長度：真正有內容的文章頁不會低於它，而 SPA 空殼剝完標籤後
 * 通常只剩「Loading…」「請開啟 JavaScript」這種十來個字的殘骸。取這個值是為了讓
 * **沒有** SPA 標記、但同樣抓不到東西的頁（例如整頁由 iframe 或 web component 撐起來的）
 * 也能觸發 fallback。
 */
const EMPTY_SHELL_CHARS = 400;

/**
 * 有 SPA 標記時，正文短於這個字數就當空殼。
 *
 * 門檻放寬到 1200 是因為 SPA 常會 server-render 一段導覽列、頁尾或 SEO 摘要——剝完標籤
 * 有幾百字，卻不含任何真正的內文。1200 字元約等於一頁 A4 的中文字量，低於它而又掛著
 * SPA 標記，判成「只有殼」的誤判成本（多打一次 render 服務）遠低於漏判（來源整筆作廢）。
 */
const SPA_SHELL_CHARS = 1200;

/**
 * 主流前端框架掛載點的指紋。這是**啟發式**、不是精確判斷：命中只代表「這頁很可能靠
 * JavaScript 渲染」，是否 fallback 仍由字數決定。
 */
const SPA_MARKERS =
  /(__NEXT_DATA__|__NUXT__|__remixContext|data-reactroot|data-server-rendered|ng-version=|<div[^>]+id=["']?(?:root|app|__next|__nuxt)["']?[\s>])/i;

/**
 * 原生擷取拿到的是不是空殼（值得再花一次第三方 render 的成本）。
 *
 * 匯出是為了可測：這條判定同時決定「使用者要不要為此付出把網址送去第三方的代價」與
 * 「來源會不會白白作廢」，兩邊的誤判都要看得見。
 */
export function looksLikeEmptyShell(rawHtml: string, extractedText: string): boolean {
  const text = extractedText.trim();
  if (text.length < EMPTY_SHELL_CHARS) return true;
  return text.length < SPA_SHELL_CHARS && SPA_MARKERS.test(rawHtml);
}

/**
 * 從網頁本身推導標題，供「手貼網址」這種沒有搜尋標題可用的情境。
 *
 * HTML 走 `<title>`，markdown（render 服務的輸出）走第一個非空行並剝掉 heading 記號。
 */
export function documentTitle(rawHtml: string, body: string): string {
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml)?.[1];
  const titled = tag ? decodeEntities(tag).replace(/\s+/g, " ").trim() : "";
  if (titled) return titled.slice(0, 200);
  const heading = body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return heading
    ? heading
        .replace(/^#{1,6}\s*/, "")
        .trim()
        .slice(0, 200)
    : "";
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

export function readableHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|svg|noscript|template|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<\s*(h[1-6]|p|article|section|main|div|li|tr|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<\s*\/\s*(h[1-6]|p|article|section|main|div|li|tr|blockquote)\s*>/gi, "\n")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 抓取一個網址的正文。
 *
 * `renderer` 是**選用**的 fallback：不傳就完全維持原本的純 fetch 行為（既有的搜尋擷取
 * 路徑正是這樣呼叫，不得改變）。傳了也只在 `looksLikeEmptyShell()` 成立時才會用到，
 * 且 render 失敗一律吞掉、沿用原生結果——fallback 不該讓整筆擷取從「摘要」退化成 throw。
 *
 * 傳 renderer 另有一層語意：呼叫端宣告「我要的是真正的正文」。SPA 空殼剝完標籤常留下
 * `<title>` 那三五個字，舊有標準（非空即 `full`）會把它當成一份合格來源；補抓之後仍是
 * 空殼時，這裡改判 `summary_only`，讓「貼上網址」通道能據以拒收。沒傳 renderer 的呼叫
 * 不受影響。
 */
export async function captureWebPage(
  found: WebSearchResult,
  capturedAt = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
  renderer?: HtmlRenderer,
): Promise<{ text: string; metadata: Record<string, string> }> {
  let url = safePublicUrl(found.url);
  let body = "";
  let raw = "";
  let status = "summary_only";
  let renderedBy = "";
  let resolvedUrl = url.toString();
  try {
    const signal = AbortSignal.timeout(15_000);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      response = await fetcher(url, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "text/html,text/plain,text/markdown;q=0.9",
          "User-Agent": "SlideMaker/0.1 source-capture",
        },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("WEB_SOURCE_REDIRECT_INVALID");
      if (redirects === MAX_REDIRECTS) throw new Error("WEB_SOURCE_REDIRECT_LIMIT");
      url = safePublicUrl(new URL(location, url).toString());
      resolvedUrl = url.toString();
    }
    if (!response) throw new Error("WEB_SOURCE_EMPTY_RESPONSE");
    if (!response.ok) throw new Error(`WEB_SOURCE_HTTP_${response.status}`);
    if (response.url) resolvedUrl = safePublicUrl(response.url).toString();
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_WEB_BYTES) throw new Error("WEB_SOURCE_TOO_LARGE");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_WEB_BYTES) throw new Error("WEB_SOURCE_TOO_LARGE");
    const mediaType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (
      mediaType &&
      mediaType !== "text/html" &&
      mediaType !== "text/plain" &&
      mediaType !== "text/markdown"
    )
      throw new Error("WEB_SOURCE_MEDIA_UNSUPPORTED");
    raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    body = mediaType === "text/html" || /<html[\s>]/i.test(raw) ? readableHtml(raw) : raw.trim();
    body = body.slice(0, MAX_CAPTURE_CHARS).trim();
    if (body) status = "full";
  } catch {
    body = "";
  }
  // 只有「呼叫端明確給了 renderer」且「原生擷取確實是空殼」兩個條件同時成立才走第三方。
  // `url` 在重導向迴圈裡每一步都過 safePublicUrl，所以送出去的必然是驗過的公開網址。
  if (renderer && looksLikeEmptyShell(raw, body)) {
    try {
      const rendered = (await renderer.render(url)).slice(0, MAX_CAPTURE_CHARS).trim();
      if (rendered) {
        body = rendered;
        status = "full";
        renderedBy = renderer.name;
      }
    } catch {
      // render 失敗不影響原生結果：這裡是加分項，不是必要條件。
    }
    // 補抓後還是空殼：`<title>` 殘骸不是正文，不讓它以 full 的身分變成一份來源。
    // 第一個引數傳空字串是因為此刻只該看正文長度——原始 HTML 的 SPA 標記已經用過了。
    if (looksLikeEmptyShell("", body)) status = "summary_only";
  }
  // 搜尋路徑一律帶著 found.title，輸出與過去逐字相同；只有手貼網址（沒有標題可用）
  // 才會退到從網頁本身推導，再退到網址本身。
  const title = found.title.trim() || documentTitle(raw, body) || resolvedUrl;
  const text =
    status === "full"
      ? `# ${title}\n\nURL: ${resolvedUrl}\n\nCaptured: ${capturedAt}\n\n## 全文\n\n${body}\n`
      : `# ${title}\n\nURL: ${resolvedUrl}\n\nCaptured: ${capturedAt}\n\n## 未驗證搜尋摘要\n\n${found.summary}\n`;
  return {
    text,
    metadata: {
      url: resolvedUrl,
      title,
      summary: found.summary,
      capturedAt,
      contentStatus: status,
      ...(renderedBy ? { renderedBy } : {}),
    },
  };
}

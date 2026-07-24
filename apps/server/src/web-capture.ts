import type { WebSearchResult } from "@slide-maker/core";
import { assertPublicHttpUrl as safePublicUrl } from "@slide-maker/core/url-safety";
import type { HtmlRenderer } from "./web-render.js";

export type { WebSearchResult } from "@slide-maker/core";

export const MAX_WEB_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_CHARS = 120_000;
const MAX_REDIRECTS = 5;

/**
 * 剝掉標題後短於這個字數，就當「根本沒抓到東西」。
 *
 * 這是 **render 觸發條件**的下限，不是「這頁有沒有內容」的判準（後者見 `hasReadableBody`）。
 * 40 字元的意思是：任何語言都組不出一個完整句子，剩下的多半是「Loading…」「請開啟
 * JavaScript」這種殘骸。誤判的代價只是多打一次 render 服務，所以寧可寬一點；反過來把它
 * 拿去當驗收標準，就會拒收一則兩百字的公告——那是 CJK 頁面上非常常見的合法內容。
 */
const NO_BODY_CHARS = 40;

/**
 * 有 SPA 標記時，正文短於這個字數就值得補抓。
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

/** 疑似 hash routing 的 fragment：`#/docs/api`、`#!/page`。單純的錨點（`#section`）不算。 */
const HASH_ROUTE = /^#[!/]/;

/**
 * 這個網址的內容是不是藏在 fragment 裡（hash routing 單頁應用）。
 *
 * HTTP 規範上 fragment **不會送到伺服器**，所以不論原生 fetch 或第三方 render 服務，拿到的
 * 都是首頁而不是 `#/docs/api` 那一頁。抓得到、看起來也有正文，只是完全另一頁——使用者卻
 * 會看到「加入成功」。而 hash routing 正好高度集中在「需要 render fallback」的族群，靜默
 * 收下的機率不低，所以呼叫端必須明確判為失敗（`WEB_SOURCE_HASH_ROUTE_UNSUPPORTED`）。
 */
export function isHashRouteUrl(url: URL): boolean {
  return HASH_ROUTE.test(url.hash);
}

/**
 * 剝掉「與正文彼此獨立的標題」後，正文還剩下什麼。
 *
 * 獨立來源＝HTML 的 `<title>` 或 render 服務回報的 `Title:`，不含「正文第一行」——拿正文
 * 推導標題再回頭剝掉它是循環論證，一則單段落的短公告會被剝成空的。
 *
 * 比對是逐行完全相同（先剝掉 markdown 的 heading 記號並收斂空白），不是子字串：標題出現在
 * 內文句子裡不該讓那一行消失。
 */
export function bodyBeyondTitle(body: string, title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  const lines = body.split("\n").filter((line) => {
    const bare = line
      .trim()
      .replace(/^#{1,6}\s*/, "")
      .replace(/\s+/g, " ");
    return bare !== "" && (!normalized || bare !== normalized);
  });
  return lines.join("\n").trim();
}

/**
 * 這頁到底有沒有正文——「貼上網址」通道的**驗收標準**（`captureWebPage` 的 `requireBody`）。
 *
 * 刻意不是字數門檻：一則兩百字的公告、一頁定義、一則快訊都是合法內容，中文頁面尤其如此。
 * 標準是「剝掉獨立來源的標題之後仍有東西」，也就是排除掉「整頁只剩 `<title>` 殘骸」這種
 * 剝完標籤只留下標題的空殼。
 *
 * 已知取捨：render 服務把「Loading…」這類佔位字串當正文回來時，這裡會收下它（它不等於
 * 標題）。相對於「把真實但簡短的內容判成抓不到」，收下一份使用者在來源清單裡看得見、
 * 也刪得掉的短來源是比較小的錯。
 */
export function hasReadableBody(body: string, title: string): boolean {
  return bodyBeyondTitle(body, title).length > 0;
}

/**
 * 要不要為這一筆多花一次第三方 render——**只有這個用途**。
 *
 * 這是啟發式，決定的是成本（把使用者的網址與內容送去第三方）與延遲，不是「這頁有沒有
 * 內容」。驗收標準另外由 `hasReadableBody` 承擔：兩者曾經共用同一個 400 字元門檻，結果是
 * 合法的短頁面被回報成「該站阻擋自動擷取」，而使用者其實什麼都沒做錯。
 *
 * `title` 預設取 HTML 的 `<title>`（獨立於正文的證據）；正文本身推導出的標題不算數。
 */
export function looksLikeEmptyShell(
  rawHtml: string,
  extractedText: string,
  title: string = htmlTitle(rawHtml),
): boolean {
  if (bodyBeyondTitle(extractedText, title).length < NO_BODY_CHARS) return true;
  return extractedText.trim().length < SPA_SHELL_CHARS && SPA_MARKERS.test(rawHtml);
}

/** HTML `<title>` 的內容；沒有就空字串。與正文獨立，故可用來判斷正文是否只剩標題。 */
export function htmlTitle(rawHtml: string): string {
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml)?.[1];
  const titled = tag ? decodeEntities(tag).replace(/\s+/g, " ").trim() : "";
  return titled.slice(0, 200);
}

/**
 * 從網頁本身推導標題，供「手貼網址」這種沒有搜尋標題可用的情境。
 *
 * HTML 走 `<title>`，markdown（render 服務的輸出）走第一個非空行並剝掉 heading 記號。
 * 後者是**命名用**的退路，不可拿去當「正文是不是只剩標題」的依據（見 `bodyBeyondTitle`）。
 */
export function documentTitle(rawHtml: string, body: string): string {
  const titled = htmlTitle(rawHtml);
  if (titled) return titled;
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
 * 把失敗轉成一個可以傳到前端的代碼。
 *
 * 逾時要與其他失敗分得開：使用者該做的事完全不同（等一下再試 vs 放棄這個網址）。
 */
function failureCode(error: unknown, codes: { timeout: string; fallback: string }): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return codes.timeout;
    if (/^WEB_(?:SOURCE|RENDER)_[A-Z0-9_]+$/.test(error.message)) return error.message;
  }
  return codes.fallback;
}

export interface CapturePageOptions {
  /**
   * 第三方 render fallback。不傳就完全維持純 fetch 行為（既有的搜尋擷取路徑正是這樣呼叫，
   * 不得改變），傳了也只在 `looksLikeEmptyShell()` 成立時才會用到。
   */
  renderer?: HtmlRenderer | undefined;
  /**
   * 驗收標準：`true` 代表呼叫端要的是**真正的正文**，剝掉標題後空無一物就判這一筆失敗
   * （`contentStatus = summary_only`）。「貼上網址」通道用它，因為那裡沒有搜尋摘要可退。
   *
   * 與 `renderer` 正交：關掉第三方 render 不該順帶把「空殼也算數」的鬆標準偷渡回來，
   * 反過來也一樣。
   */
  requireBody?: boolean | undefined;
}

/**
 * 抓取一個網址的正文。
 *
 * 失敗不 throw：回一份 `contentStatus = summary_only` 的結果，並在 `metadata.failureReason`
 * 標明是哪一種失敗（限流、逾時、HTTP 4xx…）。呼叫端要嘛退回搜尋摘要（搜尋路徑），要嘛
 * 把原因逐筆回報給使用者（貼上網址通道）——把七種失敗收斂成一句「該站阻擋自動擷取」
 * 會讓使用者採取錯誤的行動。
 */
export async function captureWebPage(
  found: WebSearchResult,
  capturedAt = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
  options: CapturePageOptions = {},
): Promise<{ text: string; metadata: Record<string, string> }> {
  const { renderer, requireBody } = options;
  let url = safePublicUrl(found.url);
  let body = "";
  let raw = "";
  let renderedBy = "";
  let renderedTitle = "";
  let failureReason = "";
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
  } catch (error) {
    body = "";
    failureReason = failureCode(error, {
      timeout: "WEB_SOURCE_TIMEOUT",
      fallback: "WEB_SOURCE_FETCH_FAILED",
    });
  }
  const shell = looksLikeEmptyShell(raw, body, htmlTitle(raw));
  // 只有「呼叫端明確給了 renderer」且「原生擷取確實是空殼」兩個條件同時成立才走第三方。
  // `url` 在重導向迴圈裡每一步都過 safePublicUrl，所以送出去的必然是驗過的公開網址。
  if (renderer && shell) {
    try {
      const rendered = await renderer.render(url);
      const text = rendered.text.slice(0, MAX_CAPTURE_CHARS).trim();
      if (text) {
        body = text;
        renderedBy = renderer.name;
        renderedTitle = rendered.title.trim();
        failureReason = "";
      } else failureReason = "WEB_RENDER_EMPTY";
    } catch (error) {
      // render 失敗不 throw（fallback 是加分項），但代碼要留下來：限流、逾時、服務回報
      // 目標網址有問題……使用者該做的事完全不同，收斂成同一句話等於沒說。
      failureReason = failureCode(error, {
        timeout: "WEB_RENDER_TIMEOUT",
        fallback: "WEB_RENDER_FAILED",
      });
    }
  } else if (!renderer && shell && !failureReason) {
    // 原生擷取「成功」但只拿到殼，而這個部署沒有 render 服務可補——這不是網站擋我們，
    // 說清楚才不會讓使用者一直重試同一個網址。
    failureReason = "WEB_SOURCE_RENDER_UNAVAILABLE";
  }
  // 搜尋路徑一律帶著 found.title，輸出與過去逐字相同；只有手貼網址（沒有標題可用）
  // 才會退到從網頁本身推導，再退到網址本身。
  const title = found.title.trim() || renderedTitle || documentTitle(raw, body) || resolvedUrl;
  // 驗收標準只看 `requireBody`：沒傳就沿用「非空即 full」的舊行為（搜尋路徑的迴歸保護）。
  //
  // 兩個條件缺一不可：
  // ①「剝掉標題後仍有正文」——刻意不是字數門檻，一則兩百字的公告是合法內容。
  // ② 補抓沒有失敗——這一頁被判定為只有殼、而唯一能補救的 render 又沒成功時，手上這幾個
  //   字（`<title>` 殘骸、「Loading…」）不是正文，拿它冒充 full 就是騙人。
  const accepted = requireBody
    ? hasReadableBody(body, renderedTitle || htmlTitle(raw)) && !failureReason
    : !!body;
  const status = accepted ? "full" : "summary_only";
  if (!accepted && !failureReason) failureReason = "WEB_SOURCE_CONTENT_UNVERIFIED";
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
      // 沒收下這份正文就不該宣稱它是誰渲染的：metadata 是來源可查證性的依據，不可自相矛盾。
      ...(renderedBy && accepted ? { renderedBy } : {}),
      ...(accepted ? {} : { failureReason }),
    },
  };
}

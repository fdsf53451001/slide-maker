import type { WebSearchResult } from "@slide-maker/core";
import { assertPublicHttpUrl as safePublicUrl } from "@slide-maker/core/url-safety";

export type { WebSearchResult } from "@slide-maker/core";

const MAX_WEB_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_CHARS = 120_000;
const MAX_REDIRECTS = 5;

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

export async function captureWebPage(
  found: WebSearchResult,
  capturedAt = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
): Promise<{ text: string; metadata: Record<string, string> }> {
  let url = safePublicUrl(found.url);
  let body = "";
  let status = "summary_only";
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
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    body = mediaType === "text/html" || /<html[\s>]/i.test(raw) ? readableHtml(raw) : raw.trim();
    body = body.slice(0, MAX_CAPTURE_CHARS).trim();
    if (body) status = "full";
  } catch {
    body = "";
  }
  const text =
    status === "full"
      ? `# ${found.title}\n\nURL: ${resolvedUrl}\n\nCaptured: ${capturedAt}\n\n## 全文\n\n${body}\n`
      : `# ${found.title}\n\nURL: ${resolvedUrl}\n\nCaptured: ${capturedAt}\n\n## 未驗證搜尋摘要\n\n${found.summary}\n`;
  return {
    text,
    metadata: {
      url: resolvedUrl,
      title: found.title,
      summary: found.summary,
      capturedAt,
      contentStatus: status,
    },
  };
}

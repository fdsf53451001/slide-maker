const MAX_WEB_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_CHARS = 120_000;

export interface WebSearchResult {
  url: string;
  title: string;
  summary: string;
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

function safePublicUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("WEB_SOURCE_URL_UNSUPPORTED");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    throw new Error("WEB_SOURCE_URL_PRIVATE");
  }
  return url;
}

export async function captureWebPage(
  found: WebSearchResult,
  capturedAt = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
): Promise<{ text: string; metadata: Record<string, string> }> {
  const url = safePublicUrl(found.url);
  let body = "";
  let status = "summary_only";
  try {
    const response = await fetcher(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "text/html,text/plain,text/markdown;q=0.9",
        "User-Agent": "SlideMaker/0.1 source-capture",
      },
    });
    if (!response.ok) throw new Error(`WEB_SOURCE_HTTP_${response.status}`);
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
  const text = `# ${found.title}\n\nURL: ${found.url}\n\nCaptured: ${capturedAt}\n\n## 簡介\n\n${found.summary}\n\n## 全文\n\n${body || found.summary}\n`;
  return {
    text,
    metadata: {
      url: found.url,
      title: found.title,
      summary: found.summary,
      capturedAt,
      contentStatus: status,
    },
  };
}

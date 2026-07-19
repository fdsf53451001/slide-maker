import type { WebSearchResult } from "@slide-maker/core";
import { isIP } from "node:net";

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

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function ipv6Words(host: string): number[] | undefined {
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word <= 0xffff)
    ? words
    : undefined;
}

function isPrivateIpv6(host: string): boolean {
  const words = ipv6Words(host);
  if (!words) return true;
  const [first] = words;
  if (
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
    (first! & 0xfe00) === 0xfc00 ||
    (first! & 0xffc0) === 0xfe80 ||
    (first! & 0xff00) === 0xff00
  )
    return true;
  const hasEmbeddedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (!hasEmbeddedIpv4) return false;
  return isPrivateIpv4(
    `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`,
  );
}

function safePublicUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("WEB_SOURCE_URL_UNSUPPORTED");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(host) === 4 && isPrivateIpv4(host)) ||
    (isIP(host) === 6 && isPrivateIpv6(host))
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

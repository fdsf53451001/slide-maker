/**
 * 外連網址的 SSRF 防線：只放行 http(s)，並擋掉指向本機／內網／保留網段的主機。
 *
 * 這裡放在 core 而非各自複製，是因為現在有兩處會對「模型或搜尋結果給的網址」發請求：
 * server 的來源正文抓取，以及 Gemini 搜尋 provider 的 grounding 重導向解析。兩份各自
 * 維護的私有 IP 判斷遲早會漂移，而漂移的那一份就是漏洞。
 *
 * 錯誤沿用 `WEB_SOURCE_*` 代碼字串：來源匯入流程已依這些字串分類失敗原因。
 *
 * 刻意不從 `index.ts` re-export，改走 `@slide-maker/core/url-safety` 子路徑：editor 會把
 * core 的主入口打進瀏覽器 bundle，而 `node:net` 在瀏覽器沒有對應實作。
 */

import { isIP } from "node:net";

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

/**
 * 解析並驗證一個可對外請求的網址。非 http(s) 丟 `WEB_SOURCE_URL_UNSUPPORTED`，
 * 指向本機或私有網段丟 `WEB_SOURCE_URL_PRIVATE`。
 */
export function assertPublicHttpUrl(value: string): URL {
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

/** 網址是否安全可請求（`assertPublicHttpUrl` 的布林版；解析失敗也算不安全）。 */
export function isPublicHttpUrl(value: string): boolean {
  try {
    assertPublicHttpUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 搜尋候選是否值得送去抓正文。
 *
 * 副檔名一望即知是二進位文件的（PDF／Office／壓縮檔）先擋掉：正文抓取只認 text/html
 * 系列，這類網址必然停在 `summary_only` 而白跑一趟。這是**盡力而為的預篩**，不是安全
 * 邊界——網址沒有副檔名（例如尚未解開的重導向中繼網址）時判定為可讀，真正的內容型別
 * 檢查在 `captureWebPage` 讀到 `content-type` 時才成立。
 *
 * 共用於 openai 與 gemini 兩個搜尋 provider：兩份各自維護的清單遲早會漂移。
 */
export function isReadableWebUrl(value: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(value).pathname.toLowerCase();
  } catch {
    return false;
  }
  return !/\.(?:pdf|zip|docx?|pptx?|xlsx?)(?:$|\/)/.test(pathname);
}

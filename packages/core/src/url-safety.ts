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

import { lookup as dnsLookup } from "node:dns/promises";
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
 * DNS 解析器的注入介面。抽出來只為了讓測試釘住「公開域名解析到內網」的映射（`sslip.io`／
 * `nip.io` 這類靜態泛域名）而不必真的打 DNS；預設走 `node:dns` 的 `lookup(host,{all:true})`。
 */
export type HostLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true });

/**
 * `assertPublicHttpUrl` 的解析版：字面預篩通過後，實際解析 DNS 並對**每一個** A／AAAA
 * 記錄套用私有網段判斷，封死 `127.0.0.1.sslip.io`、`169.254.169.254.nip.io` 這類
 * 「公開泛域名靜態映射到回環／內網」的 SSRF 繞過——純字面比對永遠攔不到它們，因為主機名
 * 本身是合法的公開域名，危險只在解析結果裡。
 *
 * **取捨（resolve-then-check，非 connect-time 綁定）**：這裡是「先解析、逐位址檢查、再交給
 * fetch 自行連線」。理論上 resolve 與 connect 之間答案可被替換（DNS rebinding），要完全封死
 * 需用 undici dispatcher 的 `connect.lookup` 以「同一份驗證過的位址」連線。此處刻意不走
 * dispatcher：`captureWebPage` 的 fetcher 是可注入的（測試塞假 fetch），dispatcher 綁在 undici
 * 上、套不到注入的 fetcher，還會引入 undici 直接相依。resolve-then-check 的視窗窄，且已封死
 * 實際回報的 sslip.io／nip.io 類**靜態映射**向量（它們每次解析都回同一個內網位址）。殘留的
 * rebinding 視窗在此明記，屬已知限制。
 *
 * 字面 IP 主機（含 `[::1]`、`169.254.169.254`）由同步預篩完整涵蓋，毋須也無從再解析。
 */
export async function assertPublicHttpUrlResolved(
  value: string,
  lookup: HostLookup = defaultLookup,
): Promise<URL> {
  const url = assertPublicHttpUrl(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return url;
  const addresses = await lookup(host);
  // 解析不出任何位址：沒有可連線的目標，拒收即可（真正的 DNS 失敗會由 lookup 自行 throw）。
  if (addresses.length === 0) throw new Error("WEB_SOURCE_URL_PRIVATE");
  for (const { address } of addresses) {
    const kind = isIP(address);
    // 解析結果不是合法 IP，或落在任一私有／保留網段 → 整筆拒收（一個內網位址就足以構成 SSRF）。
    if (
      kind === 0 ||
      (kind === 4 && isPrivateIpv4(address)) ||
      (kind === 6 && isPrivateIpv6(address))
    )
      throw new Error("WEB_SOURCE_URL_PRIVATE");
  }
  return url;
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

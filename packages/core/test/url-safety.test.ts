import { describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  type HostLookup,
  isPublicHttpUrl,
  isReadableWebUrl,
} from "../src/url-safety.js";

/*
 * 直接測這個模組本身：它是 server 來源抓取與 Gemini 搜尋 provider 共用的 SSRF 防線，
 * 之前只被 apps/server 的 web-capture 測試間接覆蓋（且蓋不到 .local 這條）。
 */

describe("assertPublicHttpUrl", () => {
  it("accepts public http(s) urls and returns the parsed URL", () => {
    expect(assertPublicHttpUrl("https://udn.com/news/story/1").toString()).toBe(
      "https://udn.com/news/story/1",
    );
    expect(assertPublicHttpUrl("http://example.com").protocol).toBe("http:");
    // 公網 IP 字面值不該被誤判成私有網段。
    expect(assertPublicHttpUrl("http://8.8.8.8/").hostname).toBe("8.8.8.8");
    expect(assertPublicHttpUrl("http://[2001:4860:4860::8888]/").hostname).toBe(
      "[2001:4860:4860::8888]",
    );
  });

  it("rejects non-http(s) schemes", () => {
    for (const value of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com",
      "data:text/html,<b>x</b>",
      "javascript:alert(1)",
    ]) {
      expect(() => assertPublicHttpUrl(value)).toThrow("WEB_SOURCE_URL_UNSUPPORTED");
    }
  });

  it("rejects loopback and internal hostnames", () => {
    for (const value of [
      "http://localhost/",
      "http://LOCALHOST:8080/x",
      "http://api.localhost/",
      // .local 是 mDNS 網段名，只會解析到內網主機。
      "http://printer.local/",
      "http://INTERNAL.LOCAL/secret",
    ]) {
      expect(() => assertPublicHttpUrl(value)).toThrow("WEB_SOURCE_URL_PRIVATE");
    }
  });

  it("rejects every private and reserved IPv4 range", () => {
    for (const host of [
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "100.64.0.1", // CGNAT
      "169.254.169.254", // 雲端 metadata 端點
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1", // multicast 以上
      "255.255.255.255",
    ]) {
      expect(() => assertPublicHttpUrl(`http://${host}/`)).toThrow("WEB_SOURCE_URL_PRIVATE");
    }
    // 邊界外側必須放行，否則整段公網被誤擋。
    expect(() => assertPublicHttpUrl("http://172.32.0.1/")).not.toThrow();
    expect(() => assertPublicHttpUrl("http://100.128.0.1/")).not.toThrow();
    expect(() => assertPublicHttpUrl("http://223.255.255.255/")).not.toThrow();
  });

  it("rejects private IPv6 forms including ipv4-mapped loopback", () => {
    for (const host of [
      "::",
      "::1",
      "fc00::1", // unique local
      "fd12:3456::1",
      "fe80::1", // link local
      "ff02::1", // multicast
      "::ffff:127.0.0.1", // ipv4-mapped loopback
      "::ffff:169.254.169.254",
    ]) {
      expect(() => assertPublicHttpUrl(`http://[${host}]/`)).toThrow("WEB_SOURCE_URL_PRIVATE");
    }
    // ipv4-mapped 的公網位址仍可放行。
    expect(() => assertPublicHttpUrl("http://[::ffff:8.8.8.8]/")).not.toThrow();
  });

  it("throws on values that are not urls at all", () => {
    for (const value of ["", "not a url", "example.com/x"]) {
      expect(() => assertPublicHttpUrl(value)).toThrow();
    }
  });
});

describe("isPublicHttpUrl", () => {
  it("mirrors assertPublicHttpUrl as a boolean and never throws", () => {
    expect(isPublicHttpUrl("https://example.com/a")).toBe(true);
    expect(isPublicHttpUrl("http://10.0.0.1/")).toBe(false);
    expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicHttpUrl("garbage")).toBe(false);
  });
});

describe("assertPublicHttpUrlResolved", () => {
  /** 回一組固定 IP 的假解析器：釘住「公開域名解析到內網」而不真打 DNS。 */
  const lookupReturning = (...ips: string[]): HostLookup => {
    const fn = vi.fn(async (_host: string) =>
      ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
    return fn as unknown as HostLookup;
  };

  it("blocks public wildcard domains that resolve to loopback/internal IPs (sslip.io / nip.io)", async () => {
    // 主機名字面上是合法公開域名，危險全在解析結果裡——純字面比對永遠攔不到。
    await expect(
      assertPublicHttpUrlResolved("http://127.0.0.1.sslip.io/", lookupReturning("127.0.0.1")),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
    await expect(
      assertPublicHttpUrlResolved(
        "https://169.254.169.254.nip.io/latest/meta-data",
        lookupReturning("169.254.169.254"),
      ),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
    await expect(
      assertPublicHttpUrlResolved("http://internal.example.test/", lookupReturning("10.0.0.5")),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
  });

  it("blocks a domain that resolves to an internal IPv6 address", async () => {
    await expect(
      assertPublicHttpUrlResolved("http://rebind.example.test/", lookupReturning("fe80::1")),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
    await expect(
      assertPublicHttpUrlResolved("http://rebind.example.test/", lookupReturning("::1")),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
  });

  it("rejects when any resolved address is private, even if others are public", async () => {
    // 一個內網位址就足以構成 SSRF：多重 A 記錄裡只要有一個是私有就整筆拒收。
    await expect(
      assertPublicHttpUrlResolved(
        "http://mixed.example.test/",
        lookupReturning("93.184.216.34", "127.0.0.1"),
      ),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
  });

  it("rejects when the domain resolves to nothing", async () => {
    await expect(
      assertPublicHttpUrlResolved("http://empty.example.test/", lookupReturning()),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
  });

  it("allows a public domain that resolves to a public IP and returns the parsed URL", async () => {
    const url = await assertPublicHttpUrlResolved(
      "https://good.example.test/path",
      lookupReturning("93.184.216.34"),
    );
    expect(url.toString()).toBe("https://good.example.test/path");
  });

  it("keeps the literal-prefilter guarantees before any DNS lookup", async () => {
    // 字面 IP 主機由同步預篩涵蓋，不該（也無從）再解析：假解析器若被呼叫就讓測試失敗。
    const lookup = vi.fn(async () => {
      throw new Error("lookup must not run for literal-IP hosts");
    }) as unknown as HostLookup;
    expect((await assertPublicHttpUrlResolved("http://8.8.8.8/", lookup)).hostname).toBe("8.8.8.8");
    await expect(assertPublicHttpUrlResolved("http://127.0.0.1/", lookup)).rejects.toThrow(
      "WEB_SOURCE_URL_PRIVATE",
    );
    // 協定預篩也先於解析。
    await expect(assertPublicHttpUrlResolved("file:///etc/passwd", lookup)).rejects.toThrow(
      "WEB_SOURCE_URL_UNSUPPORTED",
    );
    // localhost 這種名稱由字面預篩擋下，同樣不進 DNS。
    await expect(assertPublicHttpUrlResolved("http://localhost/", lookup)).rejects.toThrow(
      "WEB_SOURCE_URL_PRIVATE",
    );
  });
});

describe("isReadableWebUrl", () => {
  it("rejects urls whose path is plainly a binary document", () => {
    for (const value of [
      "https://example.com/report.pdf",
      "https://example.com/REPORT.PDF",
      "https://example.com/a/deck.pptx",
      "https://example.com/sheet.xls",
      "https://example.com/doc.docx",
      "https://example.com/bundle.zip",
      "https://example.com/report.pdf/",
    ]) {
      expect(isReadableWebUrl(value)).toBe(false);
    }
  });

  it("keeps html-ish urls, including query strings and extensionless paths", () => {
    for (const value of [
      "https://example.com/",
      "https://example.com/news/story/7266/9487252",
      "https://example.com/view?file=report.pdf",
      "https://example.com/pdf-reader",
      // 尚未解開的 grounding 中繼網址沒有副檔名可判斷，只能放行給下游的 content-type 檢查。
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ",
    ]) {
      expect(isReadableWebUrl(value)).toBe(true);
    }
  });

  it("treats an unparseable value as not readable instead of throwing", () => {
    expect(isReadableWebUrl("not a url")).toBe(false);
  });
});

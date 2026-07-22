import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPublicHttpUrl, isReadableWebUrl } from "../src/url-safety.js";

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

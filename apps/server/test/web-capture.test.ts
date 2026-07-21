import { describe, expect, it } from "vitest";
import { captureWebPage, readableHtml } from "../src/web-capture.js";

describe("web source capture", () => {
  it("extracts readable full text without trusting the model search summary", async () => {
    const captured = await captureWebPage(
      { url: "https://example.com/guide", title: "Guide", summary: "Short summary" },
      "2026-07-15T00:00:00.000Z",
      async () =>
        new Response(
          "<html><nav>Menu</nav><main><h1>Full guide</h1><p>First useful paragraph.</p><p>Second useful paragraph.</p></main><script>secret()</script></html>",
          { headers: { "content-type": "text/html" } },
        ),
    );
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.text).not.toContain("Short summary");
    expect(captured.text).toContain(
      "## 全文\n\nFull guide\n\nFirst useful paragraph.\n\nSecond useful paragraph.",
    );
    expect(captured.text).not.toContain("Menu");
    expect(captured.text).not.toContain("secret");
  });

  it("falls back to the summary when capture fails", async () => {
    const captured = await captureWebPage(
      { url: "https://example.com/guide", title: "Guide", summary: "Fallback" },
      undefined,
      async () => {
        throw new Error("offline");
      },
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.text).toContain("## 未驗證搜尋摘要\n\nFallback");
  });

  it("does not mistake public hostnames beginning with IPv6 hex digits for private IPs", async () => {
    const captured = await captureWebPage(
      { url: "https://fcbarcelona.com/news", title: "News", summary: "Fallback" },
      undefined,
      async () => new Response("Public article", { headers: { "content-type": "text/plain" } }),
    );
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("blocks private IPv4 addresses embedded in IPv6", async () => {
    await expect(
      captureWebPage(
        { url: "http://[::ffff:127.0.0.1]/", title: "Private", summary: "Private" },
        undefined,
        async () => new Response("must not fetch"),
      ),
    ).rejects.toThrow("WEB_SOURCE_URL_PRIVATE");
  });

  it("validates redirects before fetching their destination", async () => {
    const requested: string[] = [];
    const captured = await captureWebPage(
      { url: "https://example.com/redirect", title: "Redirect", summary: "Fallback" },
      undefined,
      async (url) => {
        requested.push(url.toString());
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      },
    );
    expect(requested).toEqual(["https://example.com/redirect"]);
    expect(captured.metadata.contentStatus).toBe("summary_only");
  });

  it("does not decode binary downloads as page text", async () => {
    const captured = await captureWebPage(
      { url: "https://example.com/guide.pdf", title: "PDF", summary: "PDF summary" },
      undefined,
      async () =>
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x12]), {
          headers: { "content-type": "application/pdf" },
        }),
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.text).toContain("## 未驗證搜尋摘要\n\nPDF summary");
    expect(captured.text).not.toContain("�");
  });

  it("normalizes basic HTML", () =>
    expect(readableHtml("<h1>A &amp; B</h1><p>C</p>")).toBe("A & B\n\nC"));
});

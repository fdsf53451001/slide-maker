import { describe, expect, it } from "vitest";
import { captureWebPage, readableHtml } from "../src/web-capture.js";

describe("web source capture", () => {
  it("extracts readable full text and keeps the search summary", async () => {
    const captured = await captureWebPage({ url: "https://example.com/guide", title: "Guide", summary: "Short summary" }, "2026-07-15T00:00:00.000Z", async () => new Response(
      "<html><nav>Menu</nav><main><h1>Full guide</h1><p>First useful paragraph.</p><p>Second useful paragraph.</p></main><script>secret()</script></html>",
      { headers: { "content-type": "text/html" } },
    ));
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.text).toContain("## 簡介\n\nShort summary");
    expect(captured.text).toContain("## 全文\n\nFull guide\n\nFirst useful paragraph.\n\nSecond useful paragraph.");
    expect(captured.text).not.toContain("Menu");
    expect(captured.text).not.toContain("secret");
  });

  it("falls back to the summary when capture fails", async () => {
    const captured = await captureWebPage({ url: "https://example.com/guide", title: "Guide", summary: "Fallback" }, undefined, async () => { throw new Error("offline"); });
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.text).toContain("## 全文\n\nFallback");
  });

  it("does not decode binary downloads as page text", async () => {
    const captured = await captureWebPage({ url: "https://example.com/guide.pdf", title: "PDF", summary: "PDF summary" }, undefined, async () => new Response(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x12]),
      { headers: { "content-type": "application/pdf" } },
    ));
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.text).toContain("## 全文\n\nPDF summary");
    expect(captured.text).not.toContain("�");
  });

  it("normalizes basic HTML", () => expect(readableHtml("<h1>A &amp; B</h1><p>C</p>")).toBe("A & B\n\nC"));
});

import { describe, expect, it, vi } from "vitest";
import {
  captureWebPage,
  documentTitle,
  looksLikeEmptyShell,
  readableHtml,
} from "../src/web-capture.js";
import type { HtmlRenderer } from "../src/web-render.js";

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

/** 一段夠長的真實正文（>1200 字元），用來確認「有內容的頁」不會被誤判成空殼。 */
const LONG_BODY = "這是一段真正的文章內容，講的是電動車市場的成長與充電基礎建設。".repeat(50);
const SPA_SHELL = `<html><head><title>儀表板</title><script id="__NEXT_DATA__">{"props":{}}</script></head><body><div id="root"></div><noscript>請開啟 JavaScript</noscript></body></html>`;

function fakeRenderer(
  render: (url: URL) => Promise<string>,
  name = "fake-renderer",
): HtmlRenderer & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    async render(url: URL) {
      calls.push(url.toString());
      return { text: await render(url), title: "" };
    },
  };
}

describe("空殼判定", () => {
  it("正文太短一律算空殼（連 SPA 標記都不需要）", () =>
    expect(looksLikeEmptyShell("<html><body>Loading…</body></html>", "Loading…")).toBe(true));

  it("有 SPA 標記且正文偏短算空殼", () =>
    expect(looksLikeEmptyShell(SPA_SHELL, "導覽列 關於我們 聯絡我們 ".repeat(25))).toBe(true));

  it("有 SPA 標記但正文夠長不算空殼：server-rendered 的頁不該白付第三方成本", () =>
    expect(looksLikeEmptyShell(SPA_SHELL, LONG_BODY)).toBe(false));

  it("沒有 SPA 標記、正文中等長度不算空殼", () =>
    expect(looksLikeEmptyShell("<html><body>…</body></html>", "字".repeat(600))).toBe(false));
});

describe("文件標題推導", () => {
  it("HTML 走 <title> 並解實體", () =>
    expect(documentTitle("<html><head><title>A &amp; B</title></head></html>", "內文")).toBe(
      "A & B",
    ));
  it("沒有 <title> 時取 markdown 第一個 heading", () =>
    expect(documentTitle("", "# 動態載入的標題\n\n正文")).toBe("動態載入的標題"));
  it("兩者都沒有時回空字串，由呼叫端決定退路", () => expect(documentTitle("", "  ")).toBe(""));
});

describe("動態網頁的 render fallback", () => {
  const shellResponse = () => new Response(SPA_SHELL, { headers: { "content-type": "text/html" } });

  it("空殼 → 呼叫 renderer 並採用它的結果，且記下是誰渲染的", async () => {
    const renderer = fakeRenderer(async () => `# 儀表板\n\n${LONG_BODY}`, "jina");
    const captured = await captureWebPage(
      { url: "https://example.com/app", title: "Dashboard", summary: "摘要" },
      "2026-07-24T00:00:00.000Z",
      async () => shellResponse(),
      { renderer, requireBody: true },
    );
    expect(renderer.calls).toEqual(["https://example.com/app"]);
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.metadata.renderedBy).toBe("jina");
    expect(captured.text).toContain("## 全文\n\n# 儀表板");
    expect(captured.text).not.toContain("未驗證搜尋摘要");
  });

  it("正常頁面不呼叫 renderer：fallback 只在空殼時才付出第三方成本", async () => {
    const renderer = fakeRenderer(async () => "不該被用到");
    const captured = await captureWebPage(
      { url: "https://example.com/article", title: "Article", summary: "摘要" },
      undefined,
      async () =>
        new Response(`<html><body><p>${LONG_BODY}</p></body></html>`, {
          headers: { "content-type": "text/html" },
        }),
      { renderer, requireBody: true },
    );
    expect(renderer.calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.metadata.renderedBy).toBeUndefined();
    expect(captured.text).toContain(LONG_BODY.slice(0, 40));
  });

  it("renderer 失敗就沿用原生結果，不讓整筆擷取 throw", async () => {
    const renderer = fakeRenderer(async () => {
      throw new Error("WEB_RENDER_RATE_LIMITED");
    });
    const captured = await captureWebPage(
      { url: "https://example.com/app", title: "Dashboard", summary: "摘要" },
      undefined,
      async () => shellResponse(),
      { renderer, requireBody: true },
    );
    expect(renderer.calls).toHaveLength(1);
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.renderedBy).toBeUndefined();
    expect(captured.text).toContain("## 未驗證搜尋摘要\n\n摘要");
  });

  it("renderer 回空字串也不能升級成 full", async () => {
    const captured = await captureWebPage(
      { url: "https://example.com/app", title: "Dashboard", summary: "摘要" },
      undefined,
      async () => shellResponse(),
      { renderer: fakeRenderer(async () => "   "), requireBody: true },
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
  });

  it("原生 fetch 直接失敗時也會嘗試 renderer（403 擋爬蟲的頁正是這樣）", async () => {
    const renderer = fakeRenderer(async () => LONG_BODY);
    const captured = await captureWebPage(
      { url: "https://example.com/blocked", title: "Blocked", summary: "摘要" },
      undefined,
      async () => new Response("forbidden", { status: 403 }),
      { renderer, requireBody: true },
    );
    expect(renderer.calls).toEqual(["https://example.com/blocked"]);
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("沒傳 renderer 時行為與現行完全一致（既有搜尋擷取路徑的迴歸保護）", async () => {
    // 同一個空殼頁，沒傳 renderer 就照舊：剝完標籤剩下的 `<title>` 殘骸仍算 full。
    // 這個寬鬆標準是搜尋路徑的現況，不在這次的範圍內；這裡把它釘住，確保新功能沒有
    // 順手改到既有行為（收緊它會讓搜尋來源憑空消失）。
    const fetcher = vi.fn(async () => shellResponse());
    const captured = await captureWebPage(
      { url: "https://example.com/app", title: "Dashboard", summary: "摘要" },
      "2026-07-24T00:00:00.000Z",
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(captured.metadata).toEqual({
      url: "https://example.com/app",
      title: "Dashboard",
      summary: "摘要",
      capturedAt: "2026-07-24T00:00:00.000Z",
      contentStatus: "full",
    });
    expect(captured.text).toBe(
      "# Dashboard\n\nURL: https://example.com/app\n\nCaptured: 2026-07-24T00:00:00.000Z\n\n## 全文\n\n儀表板\n",
    );
  });

  it("要求正文但補抓失敗時降級為 summary_only：<title> 殘骸不算正文", async () => {
    const captured = await captureWebPage(
      { url: "https://example.com/app", title: "Dashboard", summary: "摘要" },
      undefined,
      async () => shellResponse(),
      {
        renderer: fakeRenderer(async () => {
          throw new Error("WEB_RENDER_HTTP_503");
        }),
        requireBody: true,
      },
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
  });

  it("沒有搜尋標題時（手貼網址）用網頁自己的標題，有標題時不受影響", async () => {
    const page = async () =>
      new Response(
        `<html><head><title>年度報告</title></head><body><p>${LONG_BODY}</p></body></html>`,
        {
          headers: { "content-type": "text/html" },
        },
      );
    const derived = await captureWebPage(
      { url: "https://example.com/report", title: "", summary: "" },
      undefined,
      page,
    );
    expect(derived.metadata.title).toBe("年度報告");
    expect(derived.text.startsWith("# 年度報告\n")).toBe(true);
    const searched = await captureWebPage(
      { url: "https://example.com/report", title: "搜尋給的標題", summary: "摘要" },
      undefined,
      page,
    );
    expect(searched.metadata.title).toBe("搜尋給的標題");
  });
});

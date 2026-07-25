import { describe, expect, it, vi } from "vitest";

// 單元測試不打真 DNS：把 SSRF 解析版驗證退化成同步字面檢查（協定／字面私有 IP 仍會擋，
// 只是不做 DNS 解析）。「公開域名解析到內網」的行為在 packages/core 的 url-safety 測試用
// 注入的假 lookup 直接釘住；連線路徑確實走 resolveUrl 這件事，另用注入的假 resolveUrl 驗。
vi.mock("@slide-maker/core/url-safety", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slide-maker/core/url-safety")>();
  return {
    ...actual,
    assertPublicHttpUrlResolved: async (value: string) => actual.assertPublicHttpUrl(value),
  };
});

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

  it("does not throw on a private starting URL: degrades to summary_only without fetching", async () => {
    // 契約是「失敗不 throw」。私有／畸形的起始 URL 若在 try 外驗證會直接 reject，違反契約並
    // 讓上游整批中止。放進 try 後，這一筆降級為 summary_only + failureReason，整批不受影響，
    // 而且絕不對私有位址發出請求。
    const fetcher = vi.fn(async () => new Response("must not fetch"));
    const captured = await captureWebPage(
      { url: "http://[::ffff:127.0.0.1]/", title: "Private", summary: "私有摘要" },
      undefined,
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_SOURCE_URL_PRIVATE");
    expect(captured.text).toContain("## 未驗證搜尋摘要\n\n私有摘要");
  });

  it("does not throw on a malformed starting URL either: degrades to summary_only", async () => {
    const fetcher = vi.fn(async () => new Response("must not fetch"));
    const captured = await captureWebPage(
      { url: "not a url", title: "", summary: "摘要" },
      undefined,
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(captured.metadata.contentStatus).toBe("summary_only");
    // 起始 URL 連解析都失敗時，resolvedUrl 退回原始輸入字串。
    expect(captured.metadata.url).toBe("not a url");
  });

  it("routes the fetch path through the injected resolver: a domain flagged private is blocked pre-fetch", async () => {
    // 釘住「連線路徑確實走 resolveUrl」：假解析器把某個公開域名判成私有（模擬 sslip.io 類
    // DNS 解析到內網），擷取就必須在發出請求前失敗，且降級為 summary_only。
    const fetcher = vi.fn(async () => new Response("must not fetch"));
    const captured = await captureWebPage(
      { url: "https://127-0-0-1.sslip.io/", title: "", summary: "摘要" },
      undefined,
      fetcher,
      { resolveUrl: async () => Promise.reject(new Error("WEB_SOURCE_URL_PRIVATE")) },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_SOURCE_URL_PRIVATE");
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

  it("enforces the byte cap while streaming, before the whole body is buffered", async () => {
    // chunked（無誠實 content-length）時，舊版先 arrayBuffer() 把整個 body 緩衝進記憶體才檢查
    // 長度，2MiB 上限形同虛設。改成邊讀邊數：一超過上限就 throw 並取消串流——絕不讀完整個
    // body。這裡的假串流若被讀完會吐 100MiB；我們斷言它在拉幾塊之後就停了。
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024)); // 每塊 1MiB
      },
    });
    const captured = await captureWebPage(
      { url: "https://example.com/huge", title: "Huge", summary: "太大摘要" },
      undefined,
      // 刻意不帶 content-length（chunked）：讓串流上限成為唯一的硬邊界。
      async () => new Response(stream, { headers: { "content-type": "text/html" } }),
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_SOURCE_TOO_LARGE");
    // 2MiB 上限：拉到第 3 塊（3MiB）才超標，遠在讀完 100 塊之前就停了。
    expect(pulled).toBeLessThan(10);
  });

  it("still enforces the byte cap when content-length lies (understates the body)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3 * 1024 * 1024)); // 一次就 3MiB > 2MiB
        controller.close();
      },
    });
    const captured = await captureWebPage(
      { url: "https://example.com/liar", title: "Liar", summary: "摘要" },
      undefined,
      async () =>
        new Response(stream, { headers: { "content-type": "text/html", "content-length": "10" } }),
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_SOURCE_TOO_LARGE");
  });

  it("normalizes basic HTML", () =>
    expect(readableHtml("<h1>A &amp; B</h1><p>C</p>")).toBe("A & B\n\nC"));

  describe("HTML 實體解碼永不 throw（decodeEntities）", () => {
    // 【缺陷】超範圍數值字元參照與大寫 &#X..; 會讓 String.fromCodePoint / parseInt 丟例外，而
    // decodeEntities 在 try 外經由 htmlTitle/documentTitle/readableHtml 被呼叫→整批來源匯入回 500。
    it("preserves out-of-range numeric references instead of throwing", () => {
      expect(readableHtml("<p>a &#99999999; b</p>")).toBe("a &#99999999; b");
      expect(readableHtml("<p>a &#xFFFFFFFF; b</p>")).toBe("a &#xFFFFFFFF; b");
      // 這些畸形實體出現在 <title> 裡時，htmlTitle/documentTitle 也不能炸。
      expect(() => documentTitle("<title>x &#99999999; y</title>", "")).not.toThrow();
      expect(documentTitle("<title>x &#99999999; y</title>", "")).toBe("x &#99999999; y");
    });

    it("decodes uppercase hex references (&#X41;) as well as lowercase and named", () => {
      expect(readableHtml("<p>&#X41;&#x42;&#67;</p>")).toBe("ABC");
      expect(readableHtml("<p>&#x4e2d;&#25991;</p>")).toBe("中文");
      expect(readableHtml("<p>&amp;&lt;&gt;&quot;&#x2764;</p>")).toBe('&<>"❤');
    });

    it("leaves unknown named entities untouched without throwing", () => {
      expect(readableHtml("<p>&bogusentity; &notareal;</p>")).toBe("&bogusentity; &notareal;");
    });
  });
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

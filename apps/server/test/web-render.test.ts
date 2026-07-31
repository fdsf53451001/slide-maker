import { describe, expect, it, vi } from "vitest";
import { MAX_WEB_BYTES } from "../src/web-capture.js";
import { createHtmlRenderer, createJinaRenderer } from "../src/web-render.js";

/** 這一組一律注入假 fetcher：任何真的打到 r.jina.ai 的測試都是錯的（配額、離線 CI）。 */
const ok = (body: string, init?: ResponseInit) => async () => new Response(body, init);

describe("Jina Reader renderer", () => {
  it("讀 r.jina.ai 的正文並原樣串接原始網址（含 query string）", async () => {
    const seen: string[] = [];
    const renderer = createJinaRenderer({
      fetcher: async (input) => {
        seen.push(String(input));
        return new Response("# 標題\n\n動態載入的正文。");
      },
    });
    const page = await renderer.render(new URL("https://example.com/a/b?q=1&r=2#frag"));
    expect(seen).toEqual(["https://r.jina.ai/https://example.com/a/b?q=1&r=2#frag"]);
    expect(page.text).toBe("# 標題\n\n動態載入的正文。");
    expect(page.title).toBe("");
    expect(renderer.name).toBe("jina");
  });

  it("沒注入 fetcher 時於呼叫時解析全域 fetch（建構時綁定會讓 L0 guard 攔不住）", async () => {
    // renderer 先建好（此時尚未換 fetch），之後才換掉 globalThis.fetch——模擬 createApp
    // 開機建 renderer、E2E L0 guard 稍後才裝。呼叫時解析才會用到換上去的那個。
    const renderer = createJinaRenderer();
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("# 標題\n\n動態載入的正文。");
    }) as typeof fetch;
    try {
      const page = await renderer.render(new URL("https://example.com/"));
      expect(seen).toEqual(["https://r.jina.ai/https://example.com/"]);
      expect(page.text).toContain("動態載入的正文。");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("沒有金鑰時不送 Authorization，有金鑰時送 Bearer", async () => {
    const headers: (Headers | undefined)[] = [];
    const capture = async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return new Response("正文");
    };
    await createJinaRenderer({ fetcher: capture }).render(new URL("https://example.com/"));
    await createJinaRenderer({ apiKey: "secret-key", fetcher: capture }).render(
      new URL("https://example.com/"),
    );
    expect(headers[0]?.get("authorization")).toBeNull();
    expect(headers[0]?.get("accept")).toBe("text/plain");
    expect(headers[0]?.get("x-return-format")).toBe("markdown");
    // 免費模式預設回快取快照，手貼網址的語意是「現在去抓」，所以一律 opt-out。
    expect(headers[0]?.get("x-no-cache")).toBe("true");
    expect(headers[1]?.get("x-no-cache")).toBe("true");
    expect(headers[1]?.get("authorization")).toBe("Bearer secret-key");
  });

  it("429 有專屬錯誤代碼：限流要與其他失敗分得開", async () => {
    const renderer = createJinaRenderer({ fetcher: ok("slow down", { status: 429 }) });
    await expect(renderer.render(new URL("https://example.com/"))).rejects.toThrow(
      "WEB_RENDER_RATE_LIMITED",
    );
  });

  it("其他非 2xx 帶上狀態碼", async () => {
    const renderer = createJinaRenderer({ fetcher: ok("nope", { status: 502 }) });
    await expect(renderer.render(new URL("https://example.com/"))).rejects.toThrow(
      "WEB_RENDER_HTTP_502",
    );
  });

  it("空回應不算成功", async () => {
    const renderer = createJinaRenderer({ fetcher: ok("   \n  ") });
    await expect(renderer.render(new URL("https://example.com/"))).rejects.toThrow(
      "WEB_RENDER_EMPTY",
    );
  });

  it("逾時由 AbortSignal.timeout 觸發並往外丟（不會卡住整批擷取）", async () => {
    // 直接用真的 AbortSignal.timeout：vi 的 fake timers 不接管它，假造只會得到假的綠燈。
    const renderer = createJinaRenderer({
      timeoutMs: 20,
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason as Error),
          );
        }),
    });
    await expect(renderer.render(new URL("https://example.com/"))).rejects.toThrow(
      /timed out|abort/i,
    );
  });

  it("宣告過大就不讀 body，實際過大也擋", async () => {
    const declared = createJinaRenderer({
      fetcher: ok("小", { headers: { "content-length": String(MAX_WEB_BYTES + 1) } }),
    });
    await expect(declared.render(new URL("https://example.com/"))).rejects.toThrow(
      "WEB_RENDER_TOO_LARGE",
    );
    const actual = createJinaRenderer({ fetcher: ok("x".repeat(MAX_WEB_BYTES + 1)) });
    await expect(actual.render(new URL("https://example.com/"))).rejects.toThrow(
      "WEB_RENDER_TOO_LARGE",
    );
  });

  it("chunked 回應超限時及早取消串流，不先緩衝完整 body", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const renderer = createJinaRenderer({
      // 不帶 content-length，讓實際串流位元組數成為唯一硬邊界。
      fetcher: async () => new Response(stream),
    });

    await expect(renderer.render(new URL("https://example.com/"))).rejects.toThrow(
      "WEB_RENDER_TOO_LARGE",
    );
    expect(cancelled).toBe(true);
    // 2MiB 上限在第 3 個 1MiB chunk 就超過，不能繼續拉完 100 個 chunk。
    expect(pulled).toBeLessThan(10);
  });

  it("串接前先驗網址：私有位址不會被送去第三方", async () => {
    const fetcher = vi.fn(ok("正文"));
    const renderer = createJinaRenderer({ fetcher });
    await expect(renderer.render(new URL("http://169.254.169.254/latest"))).rejects.toThrow(
      "WEB_SOURCE_URL_PRIVATE",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("串接前剝掉 userinfo：帳密不會被寫進第三方的 URL path", async () => {
    const seen: string[] = [];
    const renderer = createJinaRenderer({
      fetcher: async (input) => {
        seen.push(String(input));
        return new Response("正文");
      },
    });
    await renderer.render(new URL("https://user:pw@example.com/private"));
    expect(seen).toEqual(["https://r.jina.ai/https://example.com/private"]);
  });
});

/**
 * 實測（2026-07-24）的 Jina Reader 回應格式。`X-Return-Format` 與 `X-Respond-With` 兩個
 * header 的輸出完全相同，都帶這段前言——不剝掉就會被當成正文餵給模型。
 */
const wrapped = (fields: string, body: string) => `${fields}\n\nMarkdown Content:\n${body}`;

describe("Jina 回應的前言", () => {
  const renderWith = (raw: string, url = "https://example.com/") =>
    createJinaRenderer({ fetcher: ok(raw) }).render(new URL(url));

  it("只有 Markdown Content 之後才是正文，標題取自 Title 欄位", async () => {
    const page = await renderWith(
      wrapped(
        "Title: Example Domain\n\nURL Source: https://example.com/\n\nPublished Time: Tue, 21 Jul 2026 07:16:00 GMT",
        "# Example Domain\n\nThis domain is for use in illustrative examples.",
      ),
    );
    expect(page.title).toBe("Example Domain");
    expect(page.text).toBe("# Example Domain\n\nThis domain is for use in illustrative examples.");
    // 前言不得混進正文：否則模型會讀到「Title: …」「URL Source: …」這種假內容。
    expect(page.text).not.toContain("URL Source");
    expect(page.text).not.toContain("Published Time");
  });

  it("沒有前言的回應原樣當正文（服務改格式不該讓整批擷取失敗）", async () => {
    const page = await renderWith("# 標題\n\n正文。");
    expect(page.text).toBe("# 標題\n\n正文。");
    expect(page.title).toBe("");
  });

  it("URL Source 與請求的網址不符就判失敗，不默默收下別頁的內容", async () => {
    await expect(
      renderWith(
        wrapped("URL Source: https://other.example.org/login", "# 登入"),
        "https://example.com/article",
      ),
    ).rejects.toThrow("WEB_RENDER_URL_MISMATCH");
  });

  it("結尾斜線不算不同的頁", async () => {
    const page = await renderWith(
      wrapped("URL Source: https://example.com/docs/", "內容。"),
      "https://example.com/docs",
    );
    expect(page.text).toBe("內容。");
  });

  it("Warning 欄位＝服務回報自身異常：整筆判失敗，那行字不是正文", async () => {
    // 我們已經送了 x-no-cache，所以任何 warning（含「這是快取快照」與「抓不到目標網址」）
    // 都是非預期狀況。收下等於把服務的錯誤訊息存成使用者的來源。
    await expect(
      renderWith(
        wrapped(
          "Title: Example Domain\n\nWarning: This is a cached snapshot of the original page, consider retry with caching opt-out.",
          "# Example Domain\n\n舊快照的內容。",
        ),
      ),
    ).rejects.toThrow("WEB_RENDER_WARNING");
  });

  it("前言之後沒有正文也算空回應", async () => {
    await expect(
      renderWith(wrapped("Title: Example Domain\n\nURL Source: https://example.com/", "   ")),
    ).rejects.toThrow("WEB_RENDER_EMPTY");
  });
});

describe("renderer 選擇", () => {
  it("jina 得到會發請求的 renderer", () => expect(createHtmlRenderer("jina")?.name).toBe("jina"));

  it("none 得到 undefined：停用第三方就真的不必傳東西進擷取流程", () => {
    // 「要不要呼叫第三方」與「什麼算正文」是兩個正交政策，後者現在由 captureWebPage 的
    // requireBody 表達，不再需要一個假的停用 renderer 去撐住較嚴的驗收標準。
    expect(createHtmlRenderer("none")).toBeUndefined();
  });
});

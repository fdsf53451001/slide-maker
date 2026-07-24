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
    const text = await renderer.render(new URL("https://example.com/a/b?q=1&r=2#frag"));
    expect(seen).toEqual(["https://r.jina.ai/https://example.com/a/b?q=1&r=2#frag"]);
    expect(text).toBe("# 標題\n\n動態載入的正文。");
    expect(renderer.name).toBe("jina");
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

  it("串接前先驗網址：私有位址不會被送去第三方", async () => {
    const fetcher = vi.fn(ok("正文"));
    const renderer = createJinaRenderer({ fetcher });
    await expect(renderer.render(new URL("http://169.254.169.254/latest"))).rejects.toThrow(
      "WEB_SOURCE_URL_PRIVATE",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("renderer 選擇", () => {
  it("jina 得到會發請求的 renderer", () => expect(createHtmlRenderer("jina").name).toBe("jina"));

  it("none 得到不發任何請求、一律失敗的停用版本", async () => {
    const renderer = createHtmlRenderer("none");
    expect(renderer.name).toBe("none");
    await expect(renderer.render(new URL("https://example.com/"))).rejects.toThrow(
      "WEB_RENDER_DISABLED",
    );
  });
});

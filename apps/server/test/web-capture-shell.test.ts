import { describe, expect, it, vi } from "vitest";

// 單元測試不打真 DNS：SSRF 解析版驗證退化成同步字面檢查（見 web-capture.test.ts 的說明）。
vi.mock("@slide-maker/core/url-safety", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slide-maker/core/url-safety")>();
  return {
    ...actual,
    assertPublicHttpUrlResolved: async (value: string) => actual.assertPublicHttpUrl(value),
  };
});

import { captureWebPage, looksLikeEmptyShell } from "../src/web-capture.js";
import type { HtmlRenderer } from "../src/web-render.js";

/**
 * 空殼判定與 render fallback 的對抗性邊界。
 *
 * 這一組全部注入假 fetcher 與假 renderer——真的打 r.jina.ai 的測試會消耗第三方配額、
 * 在離線 CI 變成隨機紅燈，而且驗不到我們自己的判定邏輯。
 *
 * `looksLikeEmptyShell()` 現在**只**決定「要不要多花一次第三方 render」；「這頁到底有沒有
 * 正文」由 `hasReadableBody()`／`requireBody` 承擔（兩者曾共用一個 400 字元門檻，害合法的
 * 短頁面被回報成「該站阻擋自動擷取」）。兩種誤判的成本仍不對稱：
 * - 誤判成空殼 → 使用者的網址與內容被送去第三方（隱私與延遲成本）。
 * - 漏判 → SPA 空殼被當成正文（既有搜尋路徑的舊標準）。
 */

/** `NO_BODY_CHARS` = 40：剝掉標題後短於它就當「根本沒抓到」。 */
const noBodyChars = 40;
/** `SPA_SHELL_CHARS` = 1200。 */
const spaShellChars = 1200;

const htmlPage = (body: string, head = "") =>
  new Response(`<html><head>${head}</head><body><p>${body}</p></body></html>`, {
    headers: { "content-type": "text/html" },
  });

/** Next.js 風格的 SSR 標記；命中 `SPA_MARKERS` 但正文由伺服器產生。 */
const SPA_HEAD = `<title>儀表板</title><script id="__NEXT_DATA__">{"props":{}}</script>`;

function recordingRenderer(render: (url: URL) => Promise<string>, name = "fake") {
  const calls: string[] = [];
  const renderer: HtmlRenderer = {
    name,
    async render(url) {
      calls.push(url.toString());
      return { text: await render(url), title: "" };
    },
  };
  return { renderer, calls };
}

/** 只回正文的假 renderer（沒有自報標題，等同 render 服務沒給 `Title:`）。 */
const bodyRenderer = (name: string, render: () => Promise<string>): HtmlRenderer => ({
  name,
  render: async () => ({ text: await render(), title: "" }),
});

const found = (url = "https://example.com/page") => ({ url, title: "", summary: "搜尋摘要" });

describe("空殼門檻的邊界", () => {
  it("剝掉標題後剛好 40 字元不算空殼，39 字元算", () => {
    expect(looksLikeEmptyShell("", "字".repeat(noBodyChars))).toBe(false);
    expect(looksLikeEmptyShell("", "字".repeat(noBodyChars - 1))).toBe(true);
  });

  it("正文短但成句的靜態頁不再被送去第三方（門檻從 400 降到 40 的理由）", () => {
    // 一則 200 字的公告、一頁 FAQ、一則快訊——原生 fetch 抓得好好的，沒有理由多打一次
    // Jina，更沒有理由因此拒收。
    expect(looksLikeEmptyShell("", "字".repeat(100))).toBe(false);
    expect(looksLikeEmptyShell("", "字".repeat(399))).toBe(false);
  });

  it("剝掉的是 <title>（獨立於正文的證據），不是正文自己的第一行", () => {
    const brief =
      "台積電今日公布第二季財報：營收季增百分之八，毛利率百分之五十三，法人上修全年展望。";
    // 沒有 <title> 時，正文就是正文——不可以拿它的第一行當標題再剝掉（循環論證）。
    expect(looksLikeEmptyShell("<html><body>x</body></html>", brief)).toBe(false);
    // 有 <title> 而正文只剩同一句話，那才是空殼。
    expect(looksLikeEmptyShell(`<html><head><title>${brief}</title></head></html>`, brief)).toBe(
      true,
    );
  });

  it("SPA 標記把門檻拉到 1200：1199 算空殼、1200 不算", () => {
    expect(looksLikeEmptyShell(SPA_HEAD, "字".repeat(spaShellChars - 1))).toBe(true);
    expect(looksLikeEmptyShell(SPA_HEAD, "字".repeat(spaShellChars))).toBe(false);
  });

  it("長度以 trim 後計算：前後空白撐不出一份正文", () =>
    expect(looksLikeEmptyShell("", `${" ".repeat(500)}短正文${" ".repeat(500)}`)).toBe(true));

  it("只有 <title> 的 SPA 一律是空殼", () =>
    expect(
      looksLikeEmptyShell(
        `<html><head><title>儀表板</title></head><body><div id="root"></div></body></html>`,
        "儀表板",
      ),
    ).toBe(true));

  it("含 SPA 標記但有完整 SSR 正文的頁面不算空殼（不該白付第三方成本）", () =>
    expect(looksLikeEmptyShell(SPA_HEAD, "字".repeat(spaShellChars + 1))).toBe(false));

  it("純文字／markdown 回應沒有 SPA 標記，只看剝掉標題後的長度", () => {
    // markdown 沒有 <title> 可剝，整份就是正文；七個字撐不出一頁，值得再試一次 render。
    expect(looksLikeEmptyShell("# 標題\n\n內文", "# 標題\n\n內文")).toBe(true);
    expect(looksLikeEmptyShell("", `# 標題\n\n${"字".repeat(noBodyChars)}`)).toBe(false);
    expect(looksLikeEmptyShell("", "Loading…")).toBe(true);
  });
});

describe("render fallback 觸發條件", () => {
  it("正文 40 字元就不會呼叫 renderer", async () => {
    const { renderer, calls } = recordingRenderer(async () => "不該被用到");
    const captured = await captureWebPage(
      found(),
      undefined,
      async () => htmlPage("字".repeat(noBodyChars)),
      { renderer },
    );
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("正文 39 字元（剝掉標題後）才會把網址送去第三方", async () => {
    const { renderer, calls } = recordingRenderer(async () => "字".repeat(spaShellChars));
    await captureWebPage(found(), undefined, async () => htmlPage("字".repeat(noBodyChars - 1)), {
      renderer,
    });
    expect(calls).toEqual(["https://example.com/page"]);
  });

  it("純文字（text/plain）有正文的頁面不觸發 fallback", async () => {
    const { renderer, calls } = recordingRenderer(async () => "不該被用到");
    const captured = await captureWebPage(
      found(),
      undefined,
      async () =>
        new Response("字".repeat(noBodyChars + 10), { headers: { "content-type": "text/plain" } }),
      { renderer },
    );
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("含 SPA 標記但有完整 SSR 正文：不呼叫 renderer", async () => {
    const { renderer, calls } = recordingRenderer(async () => "不該被用到");
    const captured = await captureWebPage(
      found(),
      undefined,
      async () => htmlPage("字".repeat(spaShellChars), SPA_HEAD),
      { renderer },
    );
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("renderer 拿到的是重導向後的最終網址，不是使用者貼的那個", async () => {
    const { renderer, calls } = recordingRenderer(async () => "字".repeat(spaShellChars));
    await captureWebPage(
      { url: "https://example.com/short", title: "", summary: "" },
      undefined,
      async (input) =>
        String(input).endsWith("/short")
          ? new Response(null, {
              status: 302,
              headers: { location: "https://example.com/final?lang=zh" },
            })
          : htmlPage("短"),
      { renderer },
    );
    expect(calls).toEqual(["https://example.com/final?lang=zh"]);
  });

  it("原生擷取因媒體型別被拒時仍會呼叫 renderer，且其輸出被無條件採信", async () => {
    // 這不是 bug，是這條路的既定取捨（Jina 讀得動 PDF）。釘住是因為它同時代表：
    // `WEB_SOURCE_MEDIA_UNSUPPORTED` 這道守門在貼上網址通道等於不存在。
    const { renderer, calls } = recordingRenderer(async () => "字".repeat(spaShellChars));
    const captured = await captureWebPage(
      found("https://example.com/paper.pdf"),
      undefined,
      async () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
      { renderer },
    );
    expect(calls).toHaveLength(1);
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("沒有 renderer 而只抓到殼：失敗原因說清楚是伺服器沒啟用 render 服務", async () => {
    // 這頁剝完標籤只剩 <title>：使用者一直重試同一個網址也不會變好，訊息必須指向設定，
    // 而不是含糊的「該站阻擋自動擷取」。
    const captured = await captureWebPage(
      found(),
      undefined,
      async () =>
        new Response(
          `<html><head><title>儀表板</title></head><body><div id="root"></div></body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
      { requireBody: true },
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_SOURCE_RENDER_UNAVAILABLE");
  });
});

describe("render fallback 的失敗路徑", () => {
  const failures = [
    ["限流", new Error("WEB_RENDER_RATE_LIMITED")],
    ["5xx", new Error("WEB_RENDER_HTTP_502")],
    [
      "逾時",
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      }),
    ],
    ["超量", new Error("WEB_RENDER_TOO_LARGE")],
    ["空回應", new Error("WEB_RENDER_EMPTY")],
    ["網址對不上", new Error("WEB_RENDER_URL_MISMATCH")],
    ["非 Error 物件", "boom"],
  ] as const;

  /** 失敗代碼 → 前端拿得到的 `failureReason`。逾時與非 Error 物件會被正規化。 */
  const expectedReason: Record<string, string> = {
    限流: "WEB_RENDER_RATE_LIMITED",
    "5xx": "WEB_RENDER_HTTP_502",
    逾時: "WEB_RENDER_TIMEOUT",
    超量: "WEB_RENDER_TOO_LARGE",
    空回應: "WEB_RENDER_EMPTY",
    網址對不上: "WEB_RENDER_URL_MISMATCH",
    "非 Error 物件": "WEB_RENDER_FAILED",
  };

  for (const [label, reason] of failures) {
    it(`${label}：不 throw、不留下 renderedBy、狀態退回 summary_only 並保留原因`, async () => {
      const captured = await captureWebPage(
        found(),
        "2026-07-24T00:00:00.000Z",
        async () => htmlPage("短正文"),
        {
          renderer: {
            name: "jina",
            render: () => Promise.reject(reason as unknown as Error),
          },
          requireBody: true,
        },
      );
      expect(captured.metadata.contentStatus).toBe("summary_only");
      expect(captured.metadata.renderedBy).toBeUndefined();
      expect(captured.text).toContain("## 未驗證搜尋摘要");
      // 七種失敗不可收斂成同一句話：限流要等一分鐘再試，其餘該放棄這個網址。
      expect(captured.metadata.failureReason).toBe(expectedReason[label]);
    });
  }

  it("renderer 回來的內容只有標題：不得升級成 full", async () => {
    const captured = await captureWebPage(
      found(),
      undefined,
      async () =>
        new Response(`<html><head><title>儀表板</title></head><body>儀表板</body></html>`, {
          headers: { "content-type": "text/html" },
        }),
      { renderer: bodyRenderer("jina", async () => "# 儀表板"), requireBody: true },
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_SOURCE_CONTENT_UNVERIFIED");
  });

  it("renderer 輸出超過擷取上限會被截斷到 120000 字元", async () => {
    const captured = await captureWebPage(found(), undefined, async () => htmlPage("短"), {
      renderer: bodyRenderer("jina", async () => "字".repeat(200_000)),
      requireBody: true,
    });
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.text).toContain("字".repeat(1000));
    // 標頭之外的正文長度就是上限值。
    expect(captured.text.split("## 全文\n\n")[1]!.trim()).toHaveLength(120_000);
  });

  it("renderer 完全沒被呼叫時（頁面正常）不會出現 renderedBy 欄位", async () => {
    const captured = await captureWebPage(
      found(),
      undefined,
      async () => htmlPage("字".repeat(noBodyChars)),
      { renderer: bodyRenderer("jina", async () => "不該被用到"), requireBody: true },
    );
    expect(Object.keys(captured.metadata)).not.toContain("renderedBy");
  });

  /**
   * 【缺陷 D3】renderer 補抓回來的內容不被採信時，`contentStatus` 正確地退回
   * `summary_only`，但 `renderedBy` 還留在 metadata 上——這份 metadata 於是同時宣稱
   * 「沒有可驗證的正文」與「正文是 jina 渲染出來的」。
   *
   * 情境改成「補抓回來只有標題」（原本的「還是只有殼」在新的驗收標準下是合法正文，
   * 見上面那條），釘住的不變量不變：沒收下的內容不得留下渲染者。
   */
  it("【缺陷 D3】補抓後仍不被採信時不該留下 renderedBy", async () => {
    const captured = await captureWebPage(
      found(),
      undefined,
      async () =>
        new Response(`<html><head><title>儀表板</title></head><body>儀表板</body></html>`, {
          headers: { "content-type": "text/html" },
        }),
      {
        renderer: {
          name: "jina",
          render: async () => ({ text: "儀表板", title: "儀表板" }),
        },
        requireBody: true,
      },
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.renderedBy).toBeUndefined();
  });
});

describe("正文短但合法的頁面", () => {
  /**
   * 【缺陷 D1｜最嚴重】貼上網址通道無法收下任何正文短於 400 字元的頁面。
   *
   * 空殼門檻是用來決定「要不要多花一次第三方 render」的啟發式，卻同時被拿來當成
   * 「這頁到底有沒有內容」的最終判準：`captureWebPage` 在 render 之後再跑一次
   * `looksLikeEmptyShell("", body)`，補抓回來的內容只要短於 400 字元就一律降級成
   * `summary_only`，端點再據以整筆拒收。
   *
   * 於是一則 200 字的新聞快訊、一段公告、一頁定義或 FAQ——原生 fetch 抓得好好的、
   * Jina 也回同一份內容、兩邊完全一致——使用者拿到的訊息是
   * 「抓不到網頁正文（可能需要登入、或該站阻擋自動擷取）」。這個訊息是不誠實的：
   * 內容抓到了，是我們自己判它太短。
   *
   * AGENTS.md 把「短頁會被拒收」列為已知限制，所以這是**知情的取捨**而非疏漏；但
   * 「用來決定要不要多花一次 render」的啟發式，與「這頁到底有沒有內容」的最終判準，
   * 是兩件事——後者需要的是「原生與 render 兩邊一致」這種證據，不是同一個字數門檻。
   *
   * 修法：驗收標準改成 `requireBody`（剝掉標題後仍有正文 + 補抓沒有失敗），與 render
   * 觸發條件解耦。
   */
  it("【缺陷 D1】原生與 render 都拿到同一份短正文時，應該收下而不是宣稱抓不到", async () => {
    const brief =
      "台積電今日公布第二季財報：營收季增百分之八，毛利率百分之五十三，法人上修全年展望。";
    const captured = await captureWebPage(
      { url: "https://example.com/brief", title: "", summary: "" },
      undefined,
      async () => htmlPage(brief),
      { renderer: bodyRenderer("jina", async () => brief), requireBody: true },
    );
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.text).toContain(brief);
  });

  it("更短的公告（26 字元）走了一次 render，兩邊一致就收下", async () => {
    // 短到觸發 render 的頁面仍然可以是合法內容：只有「補抓也救不回來」才算失敗。
    const brief = "公告：本服務將於七月三十一日進行維護，屆時暫停使用。";
    const { renderer, calls } = recordingRenderer(async () => brief);
    const captured = await captureWebPage(
      { url: "https://example.com/notice", title: "", summary: "" },
      "2026-07-24T00:00:00.000Z",
      async () => htmlPage(brief),
      { renderer, requireBody: true },
    );
    expect(calls).toHaveLength(1);
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.text.split("## 全文\n\n")[1]!.trim()).toBe(brief);
  });
});

describe("外包模式（renderOnly）", () => {
  /** 原生 fetch 有沒有真的發生。外包模式下這個陣列必須永遠是空的。 */
  function recordingFetcher(respond: () => Response) {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return respond();
    }) as typeof fetch;
    return { fetcher, calls };
  }

  /**
   * 使用者實際踩到的形狀（2026-08-02，`ithelp.ithome.com.tw/2026ironman/event`）：伺服器
   * 渲染了三千多字真實中文內容，關鍵區塊卻留給 Vue 在瀏覽器端填，原始 HTML 裡就是
   * `{{ topic.title }}` 這串字面。
   *
   * 這個 fixture 的重點是它**不是空殼**：正文遠超 SPA_SHELL_CHARS、也沒有任何 SPA 掛載點
   * 指紋，`looksLikeEmptyShell()` 對它回 false。拿一個真的空殼來測，改動前的程式碼也會通過
   * ＝等於沒測。
   */
  const mixedRenderPage = () =>
    htmlPage(`${"這是伺服器渲染的真實內容。".repeat(200)}競賽主題 {{ topic.title }}`);

  it("原生 fetch 一次都不發生，正文一律取自 renderer", async () => {
    const { fetcher, calls } = recordingFetcher(mixedRenderPage);
    const { renderer, calls: rendered } = recordingRenderer(
      async () => "render 服務拿到的完整正文，競賽主題：JavaScript、Kubernetes、Modern Web。",
    );
    const captured = await captureWebPage(found(), undefined, fetcher, {
      renderer,
      renderOnly: true,
      requireBody: true,
    });
    expect(calls).toEqual([]);
    expect(rendered).toEqual(["https://example.com/page"]);
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.text).toContain("Kubernetes");
    expect(captured.text).not.toContain("{{ topic.title }}");
    expect(captured.metadata.renderedBy).toBe("fake");
  });

  it("同一頁在預設模式下會被原樣收下（含 {{ }} 殘骸）：這正是外包要解決的問題", async () => {
    // 對照組。少了它，上一條測試通過只能證明「外包模式會呼叫 renderer」，證明不了
    // 「不外包就會收下半份內容」——而後者才是改這條路徑的理由。
    const { renderer, calls } = recordingRenderer(async () => "不該被用到");
    const captured = await captureWebPage(found(), undefined, async () => mixedRenderPage(), {
      renderer,
      requireBody: true,
    });
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("full");
    expect(captured.text).toContain("{{ topic.title }}");
  });

  it("render 失敗就是這一筆失敗，不退回原生擷取的半份內容", async () => {
    const { fetcher, calls } = recordingFetcher(mixedRenderPage);
    const captured = await captureWebPage(found(), undefined, fetcher, {
      renderer: {
        name: "jina",
        render: async () => {
          throw new Error("WEB_RENDER_RATE_LIMITED");
        },
      },
      renderOnly: true,
      requireBody: true,
    });
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_RENDER_RATE_LIMITED");
    expect(captured.metadata.renderedBy).toBeUndefined();
  });

  it("沒有 renderer 時明確回報是伺服器沒啟用，且不偷偷退回原生 fetch", async () => {
    // 外包模式下沒有 render 服務＝這條路徑在這個部署上不能用。這是設定問題，訊息要讓
    // 使用者去找部署設定而不是一直重試同一個網址。
    const { fetcher, calls } = recordingFetcher(mixedRenderPage);
    const captured = await captureWebPage(found(), undefined, fetcher, {
      renderOnly: true,
      requireBody: true,
    });
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("summary_only");
    expect(captured.metadata.failureReason).toBe("WEB_SOURCE_RENDER_UNAVAILABLE");
  });

  it("私有網址擋在送出第三方之前：外包擷取不等於把 SSRF 防線也外包掉", async () => {
    const { renderer, calls } = recordingRenderer(async () => "不該被用到");
    const captured = await captureWebPage(found("http://127.0.0.1/admin"), undefined, undefined, {
      renderer,
      renderOnly: true,
      requireBody: true,
    });
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("summary_only");
  });
});

import { describe, expect, it } from "vitest";
import { captureWebPage, looksLikeEmptyShell } from "../src/web-capture.js";
import type { HtmlRenderer } from "../src/web-render.js";

/**
 * 空殼判定與 render fallback 的對抗性邊界。
 *
 * 這一組全部注入假 fetcher 與假 renderer——真的打 r.jina.ai 的測試會消耗第三方配額、
 * 在離線 CI 變成隨機紅燈，而且驗不到我們自己的判定邏輯。
 *
 * 重點在兩種誤判的成本並不對稱：
 * - 誤判成空殼 → 使用者的網址與內容被送去第三方（隱私成本），而且**正文短的合法頁面
 *   會整筆被拒收**。
 * - 漏判 → SPA 空殼被當成正文（既有搜尋路徑的舊標準）。
 */

/** `EMPTY_SHELL_CHARS` = 400；用單一字元組出剛好卡在門檻上下的正文。 */
const shellChars = 400;
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
      return render(url);
    },
  };
  return { renderer, calls };
}

const found = (url = "https://example.com/page") => ({ url, title: "", summary: "搜尋摘要" });

describe("空殼門檻的邊界", () => {
  it("正文剛好 400 字元不算空殼，399 字元算", () => {
    expect(looksLikeEmptyShell("", "字".repeat(shellChars))).toBe(false);
    expect(looksLikeEmptyShell("", "字".repeat(shellChars - 1))).toBe(true);
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

  it("純文字／markdown 回應沒有 SPA 標記，只看長度", () => {
    expect(looksLikeEmptyShell("# 標題\n\n內文", "# 標題\n\n內文")).toBe(true);
    expect(looksLikeEmptyShell("", `# 標題\n\n${"字".repeat(shellChars)}`)).toBe(false);
  });
});

describe("render fallback 觸發條件", () => {
  it("正文 400 字元就不會呼叫 renderer", async () => {
    const { renderer, calls } = recordingRenderer(async () => "不該被用到");
    const captured = await captureWebPage(
      found(),
      undefined,
      async () => htmlPage("字".repeat(shellChars)),
      renderer,
    );
    expect(calls).toEqual([]);
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("正文 399 字元就會把網址送去第三方：短頁面的隱私成本是真的", async () => {
    const { renderer, calls } = recordingRenderer(async () => "字".repeat(spaShellChars));
    await captureWebPage(
      found(),
      undefined,
      async () => htmlPage("字".repeat(shellChars - 1)),
      renderer,
    );
    expect(calls).toEqual(["https://example.com/page"]);
  });

  it("純文字（text/plain）夠長的頁面不觸發 fallback", async () => {
    const { renderer, calls } = recordingRenderer(async () => "不該被用到");
    const captured = await captureWebPage(
      found(),
      undefined,
      async () =>
        new Response("字".repeat(shellChars + 10), { headers: { "content-type": "text/plain" } }),
      renderer,
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
      renderer,
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
      renderer,
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
      renderer,
    );
    expect(calls).toHaveLength(1);
    expect(captured.metadata.contentStatus).toBe("full");
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
    ["停用", new Error("WEB_RENDER_DISABLED")],
    ["非 Error 物件", "boom"],
  ] as const;

  for (const [label, reason] of failures) {
    it(`${label}：不 throw、不留下 renderedBy、狀態退回 summary_only`, async () => {
      const captured = await captureWebPage(
        found(),
        "2026-07-24T00:00:00.000Z",
        async () => htmlPage("短正文"),
        {
          name: "jina",
          render: () => Promise.reject(reason as unknown as Error),
        },
      );
      expect(captured.metadata.contentStatus).toBe("summary_only");
      expect(captured.metadata.renderedBy).toBeUndefined();
      expect(captured.text).toContain("## 未驗證搜尋摘要");
    });
  }

  it("renderer 回傳的內容本身還是空殼：不得升級成 full", async () => {
    const captured = await captureWebPage(found(), undefined, async () => htmlPage("短"), {
      name: "jina",
      render: async () => "Loading…",
    });
    expect(captured.metadata.contentStatus).toBe("summary_only");
  });

  it("renderer 輸出超過擷取上限會被截斷到 120000 字元", async () => {
    const captured = await captureWebPage(found(), undefined, async () => htmlPage("短"), {
      name: "jina",
      render: async () => "字".repeat(200_000),
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
      async () => htmlPage("字".repeat(shellChars)),
      { name: "jina", render: async () => "不該被用到" },
    );
    expect(Object.keys(captured.metadata)).not.toContain("renderedBy");
  });

  /**
   * 【缺陷 D3】renderer 補抓回來的內容仍是空殼時，`contentStatus` 正確地退回
   * `summary_only`，但 `renderedBy` 還留在 metadata 上——這份 metadata 於是同時宣稱
   * 「沒有可驗證的正文」與「正文是 jina 渲染出來的」。
   *
   * 現況：這一條是紅的（`renderedBy` = "jina"）。影響有限（summary_only 的來源會被
   * 貼上網址通道丟掉），但 metadata 是來源可查證性的依據，不該自相矛盾。
   */
  it.fails("【缺陷 D3】補抓後仍是空殼時不該留下 renderedBy", async () => {
    const captured = await captureWebPage(found(), undefined, async () => htmlPage("短"), {
      name: "jina",
      render: async () => "還是只有殼",
    });
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
   * 現況：這一條是紅的（實得 `summary_only`）。
   */
  it.fails("【缺陷 D1】原生與 render 都拿到同一份短正文時，應該收下而不是宣稱抓不到", async () => {
    const brief =
      "台積電今日公布第二季財報：營收季增百分之八，毛利率百分之五十三，法人上修全年展望。";
    const captured = await captureWebPage(
      { url: "https://example.com/brief", title: "", summary: "" },
      undefined,
      async () => htmlPage(brief),
      { name: "jina", render: async () => brief },
    );
    expect(captured.metadata.contentStatus).toBe("full");
  });

  it("短正文頁面現況：狀態退成 summary_only，而摘要是空的（貼上網址沒有摘要可退）", async () => {
    const brief = "公告：本服務將於七月三十一日進行維護，屆時暫停使用。";
    const captured = await captureWebPage(
      { url: "https://example.com/notice", title: "", summary: "" },
      "2026-07-24T00:00:00.000Z",
      async () => htmlPage(brief),
      { name: "jina", render: async () => brief },
    );
    expect(captured.metadata.contentStatus).toBe("summary_only");
    // 沒有摘要、也沒有正文：這份 text 對使用者與模型都是零資訊。
    expect(captured.text.split("## 未驗證搜尋摘要")[1]!.trim()).toBe("");
  });
});

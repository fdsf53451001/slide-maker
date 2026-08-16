// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createDefaultStyle,
  STYLE_REFERENCE_IMAGE_LIMIT,
  type StylePreset,
  type StyleReferenceImage,
} from "@slide-maker/core";
import { StyleEditor } from "./StyleEditor.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StyleEditor cover", () => {
  it("automatically selects the first uploaded image as the cover", async () => {
    const now = new Date().toISOString();
    const reference: StyleReferenceImage = {
      id: "first-reference",
      name: "first.png",
      mediaType: "image/png",
      assetPath: "assets/first-reference.png",
      createdAt: now,
    };
    let submitted: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path.startsWith("/api/style-assets")) return Response.json(reference, { status: 201 });
      if (path === "/api/styles" && init?.method === "POST") {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json(
          {
            ...createDefaultStyle(now),
            ...submitted,
            id: "custom-style",
            name: "測試風格",
            system: false,
            referenceImages: [reference],
            createdAt: now,
            updatedAt: now,
          } satisfies StylePreset,
          { status: 201 },
        );
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<StyleEditor onSaved={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "測試風格" } });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, {
      target: {
        files: [new File([new Uint8Array([137, 80, 78, 71])], "first.png", { type: "image/png" })],
      },
    });

    expect(await screen.findByAltText("first.png")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "設為卡片封面" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "建立風格" }));

    await waitFor(() => expect(submitted?.coverImageId).toBe(reference.id));
  });

  it("參考圖的三顆操作鈕都有可及名稱（刪除還帶上是哪一張）", async () => {
    const now = new Date().toISOString();
    const reference: StyleReferenceImage = {
      id: "ref-1",
      name: "cover.png",
      mediaType: "image/png",
      assetPath: "assets/ref-1.png",
      createdAt: now,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = typeof input === "string" ? input : new URL(String(input)).pathname;
        if (path.startsWith("/api/style-assets")) return Response.json(reference, { status: 201 });
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    const { container } = render(<StyleEditor onSaved={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array([137])], "cover.png", { type: "image/png" })] },
    });
    expect(await screen.findByAltText("cover.png")).toBeTruthy();

    // 猜錯第三顆就是刪掉一張參考圖（數量有上限、順序有語意），所以名稱不能只是「×」。
    expect(screen.getByRole("button", { name: "往上移動" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "往下移動" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刪除參考圖 cover.png" })).toBeTruthy();
  });

  it("參考圖計數與上傳 disabled 都跟隨 core 的共用上限", async () => {
    const now = new Date().toISOString();
    const references = Array.from(
      { length: STYLE_REFERENCE_IMAGE_LIMIT },
      (_, index): StyleReferenceImage => ({
        id: `ref-${index}`,
        name: `reference-${index}.png`,
        mediaType: "image/png",
        assetPath: `assets/ref-${index}.png`,
        createdAt: now,
      }),
    );
    const style = {
      ...createDefaultStyle(now),
      id: "full-style",
      name: "已滿風格",
      system: false,
      referenceImages: references,
    } satisfies StylePreset;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = typeof input === "string" ? input : new URL(String(input)).pathname;
        if (path === "/api/styles/full-style/versions") return Response.json([style]);
        if (path === "/api/model-library")
          return Response.json({ connections: [], models: [], combinations: [] });
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    const { container } = render(
      <StyleEditor styleId="full-style" onSaved={vi.fn()} onExit={vi.fn()} />,
    );

    expect(
      await screen.findByText(
        `REFERENCE IMAGES · ${STYLE_REFERENCE_IMAGE_LIMIT}/${STYLE_REFERENCE_IMAGE_LIMIT}`,
      ),
    ).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "＋ 從 PDF 匯入參考圖" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("PDF 匯入的 remaining 也由共用上限扣除現有參考圖", async () => {
    const now = new Date().toISOString();
    const existing: StyleReferenceImage = {
      id: "existing-reference",
      name: "existing.png",
      mediaType: "image/png",
      assetPath: "assets/existing.png",
      createdAt: now,
    };
    const style = {
      ...createDefaultStyle(now),
      id: "almost-full-style",
      name: "待匯入風格",
      system: false,
      referenceImages: [existing],
    } satisfies StylePreset;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = typeof input === "string" ? input : new URL(String(input)).pathname;
        if (path === "/api/styles/almost-full-style/versions") return Response.json([style]);
        if (path === "/api/model-library")
          return Response.json({ connections: [], models: [], combinations: [] });
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    render(<StyleEditor styleId="almost-full-style" onSaved={vi.fn()} onExit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 從 PDF 匯入參考圖" }));

    expect(
      await screen.findByText(
        `PowerPoint／Keynote 可先「另存為 PDF」再匯入。此風格還可加入 ${STYLE_REFERENCE_IMAGE_LIMIT - 1} 張參考圖。`,
      ),
    ).toBeTruthy();
  });
});

describe("StyleEditor 的進行中文案", () => {
  it("上傳參考圖時只有上傳那顆改文案，其餘四個標籤都不謊稱自己在跑", async () => {
    const now = new Date().toISOString();
    // 上傳請求掛在飛行中，讓「進行中」這個狀態停住可供觀察。
    let releaseUpload: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = typeof input === "string" ? input : new URL(String(input)).pathname;
        if (path.startsWith("/api/style-assets"))
          return new Promise<Response>((resolve) => {
            releaseUpload = resolve;
          });
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    const { container } = render(<StyleEditor onSaved={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "風格" } });
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array([137])], "a.png", { type: "image/png" })] },
    });

    // 舊版一顆全頁共用的 busy 讓「儲存」在上傳期間寫著「儲存中…」——什麼都沒在儲存。
    await waitFor(() => expect(screen.getByText("＋ 上傳中…", { exact: false })).toBeTruthy());
    expect(screen.getByRole("button", { name: "建立風格" })).toBeTruthy();
    expect(screen.queryByText("儲存中…")).toBeNull();
    // 進行中的那一件事仍然由 live region 講出來，而且與上面的按鈕文案同源。
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/上傳參考圖/);

    releaseUpload?.(
      Response.json(
        {
          id: "ref-1",
          name: "a.png",
          mediaType: "image/png",
          assetPath: "assets/ref-1.png",
          createdAt: now,
        } satisfies StyleReferenceImage,
        { status: 201 },
      ),
    );
    await screen.findByAltText("a.png");
  });

  it("AI 分析期間只有分析鈕改文案，參考圖上傳的可及名稱不會變成「上傳中…」", async () => {
    const now = new Date().toISOString();
    let releaseAnalysis: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = typeof input === "string" ? input : new URL(String(input)).pathname;
        if (path.startsWith("/api/style-assets"))
          return Response.json(
            {
              id: "ref-1",
              name: "a.png",
              mediaType: "image/png",
              assetPath: "assets/ref-1.png",
              createdAt: now,
            } satisfies StyleReferenceImage,
            { status: 201 },
          );
        if (path === "/api/style-analysis")
          return new Promise<Response>((resolve) => {
            releaseAnalysis = resolve;
          });
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    const { container } = render(<StyleEditor onSaved={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array([137])], "a.png", { type: "image/png" })] },
    });
    await screen.findByAltText("a.png");

    fireEvent.click(screen.getByRole("button", { name: "AI 分析風格" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 分析中…" })).toBeTruthy());
    // `<label>` 包 `<input type="file">`：文案漏改成「上傳中…」時，那正是檔案輸入的可及名稱。
    expect(screen.getByText("加入 PNG / JPG 參考圖", { exact: false })).toBeTruthy();
    expect(screen.queryByText("＋ 上傳中…", { exact: false })).toBeNull();

    releaseAnalysis?.(Response.json({ designSystem: "x", avoid: [] }));
  });
});

describe("StyleEditor 載入不到指定版本", () => {
  it("不給按了沒有進展的「重試載入」，只留返回風格庫", async () => {
    // 清單成功回來、裡面就是沒有 v7：重試必然拿到同一份清單、落在同一條分支。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ ...createDefaultStyle(), id: "style-1", version: 1 }])),
    );

    render(
      <StyleEditor styleId="style-1" historicalVersion={7} onSaved={vi.fn()} onExit={vi.fn()} />,
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(/沒有 v7/);
    expect(screen.queryByRole("button", { name: "重試載入" })).toBeNull();
    expect(screen.getByRole("button", { name: "返回風格庫" })).toBeTruthy();
  });
});

describe("StyleEditor 的錯誤 toast", () => {
  it("div[role=alert] 內含具名關閉鈕，按下訊息消失", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = typeof input === "string" ? input : new URL(String(input)).pathname;
        if (path === "/api/styles" && init?.method === "POST")
          return Response.json({ error: "STYLE_WRITE_FAILED" }, { status: 500 });
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    render(<StyleEditor onSaved={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "存不起來的風格" } });
    fireEvent.click(screen.getByRole("button", { name: "建立風格" }));

    const toast = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".toast.error");
      if (!node) throw new Error("no toast");
      return node;
    });
    // 風格編輯器這一份原本也漏了 role="alert"，而這裡失敗的往往正是「儲存」。
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.tagName).toBe("DIV");

    fireEvent.click(within(toast).getByRole("button", { name: "關閉錯誤訊息" }));
    await waitFor(() => expect(document.querySelector(".toast.error")).toBeNull());
  });
});

describe("StyleEditor 載入失敗", () => {
  it("給得出重試與返回，而不是停在「載入中…」配一份可以覆寫掉風格的空表單", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return Response.json({ error: "BOOM" }, { status: 500 });
        return Response.json([
          {
            ...createDefaultStyle(new Date().toISOString()),
            id: "style-1",
            name: "既有風格",
            system: false,
          } satisfies StylePreset,
        ]);
      }),
    );

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    // 失敗時不得留下可編輯的空表單：存下去等於用空白覆蓋掉一份好好的風格。
    expect(screen.queryByLabelText("名稱")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重試載入" }));
    await waitFor(() => expect(screen.getByLabelText("名稱")).toHaveProperty("value", "既有風格"));
  });
});

/**
 * AI 分析的套用路徑與儲存後的版本清單。
 *
 * 這兩件事是同一次實測回報的：使用者對既有風格重跑分析、存檔，得到的 v3 與三週前的 v2
 * **逐字相同**（designSystem／avoid／referenceImages 全部一樣，只有版本號與時間不同），
 * 而且按下儲存後要手動重新整理才看得到新版本。他的結論是「好像不會改動到原來的，這樣
 * 等於沒反應」。
 */
const existingStyle = (overrides: Partial<StylePreset> = {}): StylePreset => ({
  ...createDefaultStyle("2026-07-20T00:00:00.000Z"),
  id: "style-1",
  version: 2,
  name: "玉山ithome",
  system: false,
  designSystem: "## 色票\n- #666666 — 頁尾註解說明文字、頁碼",
  avoid: ["避免使用寫實人物攝影", "禁止將內頁主標題置中"],
  referenceImages: [
    {
      id: "ref-1",
      name: "cover.png",
      mediaType: "image/png",
      assetPath: "assets/ref-1.png",
      createdAt: "2026-07-20T00:00:00.000Z",
    },
  ],
  ...overrides,
});

/** 版本清單 → 分析 → PATCH 的完整假伺服器；`patched` 收下真正送出去的那份草稿。 */
function styleServer(options: { analysis?: unknown; patchStatus?: number } = {}) {
  const state = { patched: undefined as Record<string, unknown> | undefined, analyses: 0 };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === "string" ? input : new URL(String(input)).pathname;
    if (path === "/api/styles/style-1/versions") return Response.json([existingStyle()]);
    if (path === "/api/style-analysis") {
      state.analyses += 1;
      return options.analysis === undefined
        ? Response.json({ error: "STYLE_ANALYSIS_INCOMPLETE" }, { status: 502 })
        : Response.json(options.analysis);
    }
    if (path === "/api/styles/style-1" && init?.method === "PATCH") {
      state.patched = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (options.patchStatus && options.patchStatus >= 400)
        return Response.json({ error: "STYLE_WRITE_FAILED" }, { status: options.patchStatus });
      return Response.json({
        ...existingStyle(),
        ...state.patched,
        version: 3,
        updatedAt: "2026-08-16T00:00:00.000Z",
      } satisfies StylePreset);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

/**
 * 端點只回 designSystem——但這裡**刻意多塞一個 `avoid`**：非嚴格 gateway 與舊版伺服器都可能
 * 回傳它，而前端必須完全不理。拿一份剛好沒有這個欄位的回應去測，「不小心又把 avoid 套上去」
 * 的改動不會變紅，等於沒測。
 */
const analysisResult = {
  designSystem: "## 色票\n- #0B1F3A — 主色；封面滿版底",
  avoid: ["不要在內容頁加入未被參考呈現的照片"],
};

describe("AI 分析的結果直接套用到草稿", () => {
  it("不再問「確定取代嗎？」，設計系統換成這次的結果", async () => {
    // 舊版按取消 → 什麼都不做、也不說：整份分析與已經花掉的配額一起消失，使用者以為
    // 重跑分析改不動既有內容。改成直接蓋上去是安全的——`draft` 只是草稿，按儲存才落地。
    styleServer({ analysis: analysisResult });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByLabelText(/^設計系統/)).toHaveProperty(
        "value",
        existingStyle().designSystem,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "AI 分析風格" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/^設計系統/)).toHaveProperty(
        "value",
        analysisResult.designSystem,
      ),
    );
    // 一次都不問——舊版連「按取消」這條路都不該存在了。
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("避免項目一個字都不動，連端點多回的那份也不理", async () => {
    // 產品決定：這一欄改成完全由使用者手寫，分析不再產出它。實測（新建的「極簡藍」）給了
    // 判準之後仍有 12 條，9 條是設計系統已經寫過的正面規則的否定句，另兩條真的會傷害輸出
    // （擋掉某頁真正需要的照片、與 density: "high" 正面衝突），而每一條都逐字進生成 prompt
    // 並被宣告為 mandatory negative constraint。
    styleServer({ analysis: analysisResult });
    const own = existingStyle().avoid.join("\n");

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/^避免項目/)).toHaveProperty("value", own));

    fireEvent.click(screen.getByRole("button", { name: "AI 分析風格" }));
    // 等分析確實套用完（設計系統換掉了），再看避免項目——否則這個斷言在請求還沒回來時
    // 就恆為真。
    await waitFor(() =>
      expect(screen.getByLabelText(/^設計系統/)).toHaveProperty(
        "value",
        analysisResult.designSystem,
      ),
    );
    expect(screen.getByLabelText(/^避免項目/)).toHaveProperty("value", own);
    // 端點多回的那條一個字都不得出現在畫面上。
    expect(screen.queryByText(/未被參考呈現的照片/)).toBeNull();
  });

  it("欄位旁邊講明這一欄不歸 AI 管", async () => {
    // 使用者對這一欄的期待剛剛才被改變（以前分析會覆寫它）。沒有這句說明的話，下一次分析
    // 完發現這裡沒動，看起來就像分析壞了。
    styleServer({ analysis: analysisResult });
    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    const field = await screen.findByLabelText(/^避免項目/);
    expect(field.closest("label")?.textContent).toMatch(/AI 分析風格不會更動/);
  });

  it("回饋標在被改的那一格上：設計系統掛橘框，其餘欄位不掛", async () => {
    // 上一版把整段說明放在分析按鈕下方，離設計系統那個 textarea 隔了半個表單，實測回報是
    // 「這陀不顯示」——它其實有渲染，只是沒人會在那裡找。橘框沿用 .outline-dirty 那組樣式。
    styleServer({ analysis: analysisResult });

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    const design = await screen.findByLabelText(/^設計系統/);
    expect(design.closest("label")?.className).not.toMatch(/field-analysis-applied/);
    fireEvent.click(screen.getByRole("button", { name: "AI 分析風格" }));

    await waitFor(() =>
      expect(design.closest("label")?.className).toMatch(/field-analysis-applied/),
    );
    // 沒被動過的欄位不得跟著亮：那正是使用者回頭檢查一個沒被改的欄位的原因。
    expect(screen.getByLabelText(/^避免項目/).closest("label")?.className).not.toMatch(
      /field-analysis-applied/,
    );

    const hint = await screen.findByText(/剛換成 AI 分析的結果/);
    expect(hint.getAttribute("role")).toBe("status");
    // 提示要指著真的存在的那顆按鈕（既有風格是「儲存新版本」）。
    expect(hint.textContent).toMatch(/儲存新版本/);
    expect(screen.getByRole("button", { name: "儲存新版本" })).toBeTruthy();
    // 這一格與那顆按鈕在同一個 label 裡，不是隔著半個表單的另一塊。
    expect(hint.closest("label")).toBe(design.closest("label"));
  });

  it("使用者自己改這一格之後，橘框就撤掉", async () => {
    // 他已經知道自己在動什麼，繼續標記等於一個永遠關不掉的提示。
    styleServer({ analysis: analysisResult });

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    const design = await screen.findByLabelText(/^設計系統/);
    fireEvent.click(screen.getByRole("button", { name: "AI 分析風格" }));
    await waitFor(() =>
      expect(design.closest("label")?.className).toMatch(/field-analysis-applied/),
    );

    fireEvent.change(design, { target: { value: "## 色票\n- #000000 — 我自己寫的" } });
    expect(design.closest("label")?.className).not.toMatch(/field-analysis-applied/);
    expect(screen.queryByText(/剛換成 AI 分析的結果/)).toBeNull();
  });

  it("分析失敗時走既有的錯誤路徑，一個字都不動草稿", async () => {
    styleServer({});

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    await screen.findByLabelText(/^設計系統/);
    fireEvent.click(screen.getByRole("button", { name: "AI 分析風格" }));

    await waitFor(() => expect(document.querySelector(".toast.error")).toBeTruthy());
    expect(screen.getByLabelText(/^設計系統/)).toHaveProperty(
      "value",
      existingStyle().designSystem,
    );
    expect(screen.getByLabelText(/^避免項目/)).toHaveProperty(
      "value",
      existingStyle().avoid.join("\n"),
    );
    expect(screen.queryByText(/剛換成 AI 分析的結果/)).toBeNull();
  });

  it("儲存成功後撤掉橘框——「按儲存才會生效」已經不成立了", async () => {
    styleServer({ analysis: analysisResult });

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    const design = await screen.findByLabelText(/^設計系統/);
    fireEvent.click(screen.getByRole("button", { name: "AI 分析風格" }));
    await screen.findByText(/剛換成 AI 分析的結果/);

    fireEvent.click(screen.getByRole("button", { name: "儲存新版本" }));
    await waitFor(() => expect(screen.queryByText(/剛換成 AI 分析的結果/)).toBeNull());
    expect(design.closest("label")?.className).not.toMatch(/field-analysis-applied/);
  });
});

describe("儲存後的版本歷史", () => {
  it("新版本立刻出現，不必重新整理", async () => {
    // 斷點在 `save()`：它更新了 style／draft／baseline 卻沒碰 `versions`，而 `versions` 只由
    // 載入 effect 填，那個 effect 的相依是 [styleId, historicalVersion, loadAttempt]——儲存
    // 既有風格時三個都沒變（`onSaved` 導向的就是現在這一頁），所以清單停在存檔前的樣子。
    const state = styleServer({ analysis: analysisResult });

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    const history = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".version-links");
      if (!node) throw new Error("no version list");
      return node;
    });
    expect(within(history).getByRole("link", { name: /v2/ })).toBeTruthy();
    expect(within(history).queryByRole("link", { name: /v3/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "改一行" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存新版本" }));

    // 不重新掛載、不改 props：新版本必須自己出現在清單裡。
    await waitFor(() => expect(within(history).getByRole("link", { name: /v3/ })).toBeTruthy());
    expect(within(history).getByRole("link", { name: /v2/ })).toBeTruthy();
    expect(state.patched?.description).toBe("改一行");
    // 版本清單只抓過一次：修法是把回應接進 state，不是在外面補一次 refetch。
    const versionCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).includes("/versions"));
    expect(versionCalls).toHaveLength(1);
  });

  it("儲存失敗時不會把沒建立成功的版本加進清單", async () => {
    styleServer({ patchStatus: 500 });

    render(<StyleEditor styleId="style-1" onSaved={vi.fn()} onExit={vi.fn()} />);
    await screen.findByLabelText("名稱");
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "存不起來" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存新版本" }));

    await waitFor(() => expect(document.querySelector(".toast.error")).toBeTruthy());
    const history = document.querySelector<HTMLElement>(".version-links")!;
    expect(within(history).queryByRole("link", { name: /v3/ })).toBeNull();
  });
});

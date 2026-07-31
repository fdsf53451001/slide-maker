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

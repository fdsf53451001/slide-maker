// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createDefaultStyle, createProject } from "@slide-maker/core";
import type { PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** 儀表板只需要幾支端點就能渲染；`/api/projects/import` 由各測試自己接管。 */
function stubDashboard(
  handler: (init?: RequestInit) => Response | Promise<Response>,
  projects: PresentationProject[] = [],
) {
  const now = new Date().toISOString();
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? new URL(input, "http://localhost").pathname
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    if (path === "/api/projects/import") {
      bodies.push(init?.body);
      return handler(init);
    }
    if (path === "/api/projects") return Response.json(projects);
    if (path === "/api/providers") return Response.json([]);
    if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
    if (path === "/api/model-library")
      return Response.json({ connections: [], models: [], combinations: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bodies, fetchMock };
}

const bundleFile = (name = "deck.slide-project.zip") =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, { type: "application/zip" });

function bundleInput(): HTMLInputElement {
  const input = document
    .querySelector(".dashboard-section-actions")
    ?.querySelector('input[type="file"]');
  if (!input) throw new Error("找不到匯入專案檔的 file input");
  return input as HTMLInputElement;
}

describe("匯入專案檔（.slide-project.zip）", () => {
  it("與「匯入 PDF」並列在「最近簡報」標題右側", async () => {
    stubDashboard(() => Response.json({}));
    render(<Editor />);
    const actions = (await screen.findByRole("button", { name: "匯入專案檔" })).parentElement;
    expect(actions?.className).toContain("dashboard-section-actions");
    // 份數文字與另一條匯入入口都還在同一群組裡。
    expect(actions?.textContent).toContain("0 份簡報");
    expect(actions?.textContent).toContain("匯入 PDF");
    // 舊的「已經有 PDF 了？」面板已經移除。
    expect(screen.queryByText(/已經有 PDF 了/)).toBeNull();
  });

  it("上傳成功就直接進入該專案", async () => {
    const imported: PresentationProject = {
      ...createProject({ topic: "還原的簡報", name: "還原的簡報（匯入）" }),
      workflowStage: "editing",
    };
    const { bodies } = stubDashboard(() => Response.json(imported, { status: 201 }));
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    const file = bundleFile();
    fireEvent.change(bundleInput(), { target: { files: [file] } });
    // raw bytes 直送，不包 FormData。
    await waitFor(() => expect(bodies[0]).toBe(file));
    await waitFor(() => expect(window.location.pathname).toBe(`/projects/${imported.id}`));
    // 真的離開儀表板進到該專案，不是只改了網址列。
    await waitFor(() => expect(screen.queryByRole("button", { name: "匯入專案檔" })).toBeNull());
    expect(screen.queryByText("最近簡報")).toBeNull();
  });

  it("失敗時把伺服器的原因留在畫面上，而不是只寫 console", async () => {
    stubDashboard(() =>
      Response.json(
        { error: "PROJECT_BUNDLE_INVALID", message: "這個檔案不是有效的專案封存。" },
        { status: 400 },
      ),
    );
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    fireEvent.change(bundleInput(), { target: { files: [bundleFile("broken.zip")] } });
    expect(await screen.findByText(/這個檔案不是有效的專案封存/)).toBeTruthy();
    // 失敗後按鈕要放開，讓使用者能換一個檔案重試。
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "匯入專案檔" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  /** 選同一個檔案兩次也要發第二次請求：input 的 value 沒清掉的話 change 不會再觸發。 */
  it("讀完檔案就清掉 input 的 value", async () => {
    const { bodies } = stubDashboard(() =>
      Response.json({ error: "PROJECT_BUNDLE_INVALID", message: "壞檔" }, { status: 400 }),
    );
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    const input = bundleInput();
    fireEvent.change(input, { target: { files: [bundleFile()] } });
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { files: [bundleFile()] } });
    await waitFor(() => expect(bodies).toHaveLength(2));
  });
});

describe("匯入專案檔的邊界情形", () => {
  /**
   * 「一份簡報都沒有」是新使用者的第一畫面，也是最需要「還原一份備份」的時候。
   * 兩個按鈕搬進 `.dashboard-section-actions` 之後不能被綁進非空的那個分支。
   */
  it("0 份簡報時兩個按鈕都在、都可按，空狀態文案也還在", async () => {
    stubDashboard(() => Response.json({}));
    render(<Editor />);
    const bundle = (await screen.findByRole("button", {
      name: "匯入專案檔",
    })) as HTMLButtonElement;
    const pdf = screen.getByRole("button", { name: "匯入 PDF" }) as HTMLButtonElement;
    expect(bundle.disabled).toBe(false);
    expect(pdf.disabled).toBe(false);
    expect(screen.getByText("還沒有簡報")).toBeTruthy();
    // 空狀態下 file input 也要掛好，否則按鈕按下去毫無反應。
    expect(bundleInput()).toBeTruthy();
    // 按下去真的會開啟 PDF 對話框：搬家沒有把 onClick 接線弄丟。
    fireEvent.click(pdf);
    expect(await screen.findByRole("dialog", { name: "從 PDF 匯入簡報" })).toBeTruthy();
  });

  it("已有簡報時兩個按鈕仍在，且份數文字同步", async () => {
    const existing = createProject({ topic: "既有簡報", name: "既有簡報" });
    stubDashboard(() => Response.json({}), [existing]);
    render(<Editor />);
    const actions = (await screen.findByRole("button", { name: "匯入專案檔" })).parentElement;
    expect(actions?.textContent).toContain("1 份簡報");
    expect(screen.getByRole("button", { name: "匯入 PDF" })).toBeTruthy();
    expect(screen.queryByText("還沒有簡報")).toBeNull();
  });

  /**
   * 伺服器對 `PROJECT_BUNDLE_*` 已附上中文 `message`（見 app.ts 的訊息表，由
   * `project-bundle-io.test.ts` 釘住），所以裸錯誤碼是退化路徑：舊版伺服器、或未來新增
   * 的碼漏了配訊息時仍會走到這裡。這條確認前端不吞掉失敗、並把按鈕放開讓人換檔重試。
   */
  it("伺服器只回錯誤碼（沒有 message）時仍然顯示失敗並解除 disabled", async () => {
    stubDashboard(() => Response.json({ error: "PROJECT_BUNDLE_INVALID" }, { status: 400 }));
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    fireEvent.change(bundleInput(), { target: { files: [bundleFile("random.zip")] } });
    expect(await screen.findByText(/PROJECT_BUNDLE_INVALID/)).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "匯入專案檔" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  /** 使用者可以把錯誤 toast 關掉，換一個檔案重來。 */
  it("錯誤 toast 可以關掉", async () => {
    stubDashboard(() =>
      Response.json({ error: "PROJECT_BUNDLE_INVALID", message: "壞檔" }, { status: 400 }),
    );
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    fireEvent.change(bundleInput(), { target: { files: [bundleFile()] } });
    // 訊息本身是 `role="alert"` 的容器（會被播報），關閉是裡面那顆具名的按鈕——
    // 兩個語意分開之後，「按下去關得掉」要對那顆按鈕測，不是對訊息文字節點。
    const toast = await screen.findByRole("alert");
    expect(toast.textContent).toContain("壞檔");
    fireEvent.click(within(toast).getByRole("button", { name: "關閉錯誤訊息" }));
    await waitFor(() => expect(screen.queryByText(/壞檔/)).toBeNull());
  });

  /** 網路整個斷掉（fetch reject）不能變成沒人接的 rejection，按鈕也不能卡在「匯入中…」。 */
  it("網路失敗時顯示原因並解除 disabled", async () => {
    stubDashboard(() => Promise.reject(new Error("Failed to fetch")));
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    fireEvent.change(bundleInput(), { target: { files: [bundleFile()] } });
    expect(await screen.findByText(/Failed to fetch/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "匯入專案檔" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /** 大檔案上傳要好幾秒：按鈕在這段期間必須擋住重複送出，並說明自己在忙。 */
  it("請求在途時按鈕顯示「匯入中…」且不可再按", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => (release = resolve));
    const { bodies } = stubDashboard(() => pending);
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    fireEvent.change(bundleInput(), { target: { files: [bundleFile()] } });
    const busy = (await screen.findByRole("button", { name: "匯入中…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    // 忙碌中再按一次不會多送一筆。
    fireEvent.click(busy);
    expect(bodies).toHaveLength(1);
    release(Response.json({ error: "PROJECT_BUNDLE_INVALID", message: "壞檔" }, { status: 400 }));
    await screen.findByRole("button", { name: "匯入專案檔" });
  });

  /** 開了檔案選取視窗又按取消：不送請求，按鈕也不能被鎖住。 */
  it("沒有選檔案就取消時不送請求", async () => {
    const { bodies } = stubDashboard(() => Response.json({}));
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    fireEvent.change(bundleInput(), { target: { files: [] } });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "匯入專案檔" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(bodies).toHaveLength(0);
  });

  /**
   * 端點吃 `express.raw`：包成 FormData 的話伺服器讀到的是 multipart 外框而不是 zip，
   * 一定解不開。這裡釘住「送出去的就是那個 File 本體」與 Content-Type。
   */
  it("以 raw bytes 送出，Content-Type 是 application/zip", async () => {
    const { fetchMock } = stubDashboard(() => Response.json({ error: "X" }, { status: 400 }));
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    const file = bundleFile();
    fireEvent.change(bundleInput(), { target: { files: [file] } });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("/api/projects/import")),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/projects/import"),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    expect(init.body).not.toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/zip");
  });

  /**
   * 隱藏的 file input 是輔助控制項，不能被輔助技術當成第二個「選擇檔案」欄位，
   * 也不能被 `getByRole("button")` 之類的查詢誤中。
   */
  it("隱藏的 file input 對輔助技術不可見，且 accept 是 .zip", async () => {
    stubDashboard(() => Response.json({}));
    render(<Editor />);
    await screen.findByRole("button", { name: "匯入專案檔" });
    const input = bundleInput();
    expect(input.hidden).toBe(true);
    expect(input.getAttribute("aria-hidden")).toBe("true");
    // 瀏覽器只認最後一段副檔名：`.slide-project.zip` 會失效，只能寫 `.zip`。
    expect(input.getAttribute("accept")).toBe(".zip");
  });
});

describe("匯出面板的備份檔名標示", () => {
  /**
   * 匯出連結沒有 `download` 屬性，檔名完全由伺服器的 `Content-Disposition` 決定
   * （伺服器端由 `apps/server/test/project-bundle-io.test.ts` 釘住）。
   * 這裡釘的是另一半：畫面上寫的副檔名要跟真的下載到的一致，
   * 而且 URL 的 path segment 仍是 `slide-project`（檔名變、端點不變）。
   */
  it("寫 .slide-project.zip，但端點路徑仍是 slide-project", async () => {
    const now = new Date().toISOString();
    const base = createProject({ topic: "備份用簡報", name: "備份用簡報" });
    const project: PresentationProject = {
      ...base,
      workflowStage: "editing",
      slides: base.slides.map((slide) => ({
        ...slide,
        currentVersionId: `${slide.id}-v1`,
        versions: [
          {
            id: `${slide.id}-v1`,
            imagePath: `assets/${slide.id}/v1.png`,
            prompt: "",
            providerId: "mock-image",
            model: "mock",
            parameters: {},
            styleVersion: 1,
            sources: [],
            createdAt: now,
          },
        ],
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? new URL(input, "http://localhost").pathname
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
        if (path === "/api/projects") return Response.json([project]);
        if (path === "/api/providers") return Response.json([]);
        if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
        if (path === "/api/model-library")
          return Response.json({ connections: [], models: [], combinations: [] });
        if (path.includes("/readiness"))
          return Response.json({
            providerId: "mock-image",
            status: "ready",
            blocking: false,
            requiresAcknowledgement: false,
            message: "Ready",
            checkedAt: now,
            expiresAt: now,
          });
        return Response.json(project);
      }),
    );
    render(<Editor />);
    fireEvent.click(await screen.findByText("備份用簡報"));
    fireEvent.click(await screen.findByRole("button", { name: "匯出" }));
    const link = (await screen.findByText(/備份完整專案/)) as HTMLAnchorElement;
    expect(link.textContent).toContain(".slide-project.zip");
    expect(new URL(link.href).pathname.endsWith(`/export/slide-project`)).toBe(true);
    // 其他三條連結的標示不受影響。
    expect(screen.getByText(/下載每頁 PNG/).textContent).toContain("(.zip)");
    expect(screen.getByText(/下載 PowerPoint/).textContent).toContain("(.pptx)");
  });
});

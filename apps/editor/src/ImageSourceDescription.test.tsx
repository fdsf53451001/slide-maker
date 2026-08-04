// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProject, type PresentationProject, type SourceAsset } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { SourcePanel } from "./SourcePanel.js";

/**
 * 上傳圖片後由伺服器背景產生的「內容描述」在前端的呈現與收尾。
 *
 * 兩件事要釘住：分析中的來源必須看得出來還沒好；描述完成後畫面要自己更新——那條輪詢是
 * 使用者唯一會知道「好了」的途徑，靜默失效的話畫面會永遠停在「分析中」。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOTICE = "［AI 圖片描述］以下內容由視覺模型讀圖產生";

function imageSource(patch: Partial<SourceAsset> = {}): SourceAsset {
  return {
    id: "source-image",
    name: "cost.png",
    mediaType: "image/png",
    usage: "visual-reference",
    allowModelAccess: true,
    status: "indexed",
    assetPath: "assets/sources/source-image/cost.png",
    sizeBytes: 2048,
    extractedText: "",
    chunks: [],
    metadata: {},
    // 逾時判斷用的是客戶端錨點而不是這個時間戳（見 SourcePanel 的 parsingExpired）；
    // 仍給當下時間，免得讀者以為它有語意。
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

function projectWith(source: SourceAsset): PresentationProject {
  const project = createProject({ topic: "圖片描述", brief: { desiredSlideCount: 1 } });
  project.workflowStage = "editing";
  project.sources = [source];
  return project;
}

describe("圖片來源的分析狀態", () => {
  it("分析中的來源顯示「分析中」而不是「0 個文字區塊」", () => {
    render(
      <SourcePanel
        project={projectWith(imageSource({ status: "parsing" }))}
        onProject={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByText(/AI 分析圖片內容中…/)).toBeTruthy();
    // 「0 個文字區塊」對使用者的意思是「這張圖沒有內容」，會讓人以為功能壞了。
    expect(screen.queryByText(/0 個文字區塊/)).toBe(null);
  });

  it("描述完成後顯示區塊數，預覽裡看得到描述本身與它的出處聲明", async () => {
    const described = imageSource({
      extractedText: `${NOTICE}，並非圖片內的原始文字。\n\nY 軸：每度成本。磷酸鐵鋰 56 美元。`,
      chunks: [{ id: "chunk-1", text: "描述", locator: "image-description:1" }],
      metadata: { imageDescriptionModel: "gpt-5-vision" },
    });
    render(<SourcePanel project={projectWith(described)} onProject={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByText(/1 個文字區塊/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "預覽 cost.png" }));
    const dialog = await screen.findByRole("dialog", { name: /預覽來源：cost.png/ });
    // 描述是模型衍生物：使用者看到內容的同時就要看到這一句，否則會把它當成圖上的原文。
    expect(dialog.textContent).toContain("磷酸鐵鋰 56 美元");
    expect(dialog.textContent).toContain(NOTICE);
  });
});

describe("上傳一律允許 AI 讀取", () => {
  /**
   * 上傳當下的那個退出勾選框已於 2026-08-04 依產品決定移除（「會上傳＝要準備使用」），
   * 前端從此固定送 `allowModelAccess=true`。
   *
   * 這條測試存在的唯一理由是防止那個預設被改回 `false`：伺服器端的授權閘門是**安靜地**
   * 跳過沒授權的來源，所以一旦送錯，圖片描述整條路（背景讀圖 → chunks → 搜尋 → 大綱引用）
   * 會全部失效卻不報任何錯，而伺服器端測試餵的是自己的參數、看不到前端送什麼。
   */
  it("上傳請求帶的是 allowModelAccess=true", async () => {
    const project = projectWith(imageSource());
    project.sources = [];
    const queries: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/sources?")) queries.push(url);
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SourcePanel project={project} onProject={vi.fn()} onError={vi.fn()} />);

    const input = screen.getByLabelText("上傳來源檔案") as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "chart.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(queries.length).toBe(1));
    // 伺服器只認 "true"／"false" 這兩個字串，所以斷言的是 query 字面而不是「有沒有這個參數」。
    expect(queries[0]).toContain("allowModelAccess=true");
  });
});

describe("來源卡片上的事後 toggle", () => {
  /**
   * 上傳當下的勾選框移除之後，這顆是使用者**唯一**能收回模型存取權的地方（AGENTS.md 的
   * 授權閘門那條也是這樣寫的），所以它得有測試釘住。
   *
   * 它擋得住的與擋不住的要分清楚：PATCH 回去之後，這份來源就進不了大綱 prompt 與 FTS
   * 檢索（伺服器端五處過濾都看 `allowModelAccess`）；但圖片若已經被排進背景讀圖，那一次
   * 送出收不回來。測試只能斷言前者——後者本來就不是前端做得到的事。
   */
  function renderWithToggle(source: SourceAsset) {
    const project = projectWith(source);
    const patches: Array<{ body: Record<string, unknown>; url: string }> = [];
    const onProject = vi.fn();
    const onError = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method !== "PATCH") return Response.json(project);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push({ body, url });
      return Response.json({ ...project, sources: [{ ...source, ...body }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SourcePanel project={project} onProject={onProject} onError={onError} />);
    return { project, patches, onProject, onError };
  }

  it("取消勾選會 PATCH allowModelAccess:false，並把伺服器回應交回上層", async () => {
    const { project, patches, onProject, onError } = renderWithToggle(imageSource());

    const toggle = screen.getByRole("checkbox", { name: "允許 AI 使用 cost.png" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);

    await waitFor(() => expect(patches.length).toBe(1));
    // 斷言 body 全等而不是「包含這個鍵」：多送一個欄位（例如順手帶上 usage）會覆寫掉
    // 使用者沒有要改的設定。
    expect(patches[0]!.body).toEqual({ allowModelAccess: false });
    expect(patches[0]!.url).toContain(`/sources/${project.sources[0]!.id}`);
    await waitFor(() => expect(onProject).toHaveBeenCalled());
    expect((onProject.mock.calls[0]![0] as PresentationProject).sources[0]!.allowModelAccess).toBe(
      false,
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("重新勾選會 PATCH 回 true：這顆是可逆的，不是一次性的封印", async () => {
    const { patches } = renderWithToggle(imageSource({ allowModelAccess: false }));

    const toggle = screen.getByRole("checkbox", { name: "允許 AI 使用 cost.png" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]!.body).toEqual({ allowModelAccess: true });
  });
});

describe("改用途成視覺參考時的配額同意", () => {
  /**
   * `respond` 決定伺服器對這次 PATCH 的回應——前端不預測伺服器會不會讀圖，只看回應，
   * 所以每個案例都得能自己決定那個回應長什麼樣。
   */
  function renderWithUsage(source: SourceAsset, respond?: (patched: SourceAsset) => SourceAsset) {
    const project = projectWith(source);
    const patches: Array<Record<string, unknown>> = [];
    const onError = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "PATCH") return Response.json(project);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(body);
      const patched = { ...source, ...body } as SourceAsset;
      return Response.json({ ...project, sources: [respond ? respond(patched) : patched] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SourcePanel project={project} onProject={vi.fn()} onError={onError} />);
    return { patches, onError };
  }

  it("使用者同意才帶 describeImage，取消就只改用途", async () => {
    // 伺服器接受了：回應裡這筆來源變成 parsing。
    const { patches, onError } = renderWithUsage(
      imageSource({ usage: "direct-asset" }),
      (patched) =>
        patched.status === "parsing" || !("describeImage" in patched)
          ? patched
          : { ...patched, status: "parsing" },
    );
    const select = screen.getByRole("combobox", { name: "cost.png 的生成用途" });

    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    fireEvent.change(select, { target: { value: "visual-reference" } });
    await waitFor(() => expect(patches.length).toBe(1));
    // 按了取消：只改用途，一個模型請求都不該被觸發。
    expect(patches[0]).toEqual({ usage: "visual-reference" });

    // 帶上參數型別，斷言才讀得到確認框實際顯示的那句話。
    const asked = vi.fn((_message?: string) => true);
    vi.stubGlobal("confirm", asked);
    fireEvent.change(select, { target: { value: "visual-reference" } });
    await waitFor(() => expect(patches.length).toBe(2));
    expect(patches[1]).toEqual({ usage: "visual-reference", describeImage: true });
    // 確認框必須講清楚代價，但不能保證一定會發生——會不會讀圖是伺服器組態決定的。
    const prompt = String(asked.mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("消耗配額");
    expect(prompt).toContain("若目前的模型設定支援讀圖");
    expect(onError).not.toHaveBeenCalled();
  });

  it("伺服器其實不會讀圖時直說，而不是讓使用者以為已經送出去了", async () => {
    // 這是 SLIDE_MAKER_IMAGE_DESCRIPTION=off、沒設文字模型、或模型不可用時的回應：
    // 用途改了，但這筆來源沒有進入 parsing。前端無從預先得知這些組態，只能看回應。
    const { patches, onError } = renderWithUsage(imageSource({ usage: "direct-asset" }));
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "cost.png 的生成用途" }), {
      target: { value: "visual-reference" },
    });
    await waitFor(() => expect(patches.length).toBe(1));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const notice = String(onError.mock.calls[0]?.[0] ?? "");
    expect(notice).toContain("不會讀圖");
    expect(notice).toContain("沒有消耗配額");
  });

  it("已經有描述的圖不再問，也不重複燒配額", async () => {
    const asked = vi.fn(() => true);
    vi.stubGlobal("confirm", asked);
    const { patches } = renderWithUsage(
      imageSource({ usage: "direct-asset", extractedText: `${NOTICE}，已經有描述了。` }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "cost.png 的生成用途" }), {
      target: { value: "visual-reference" },
    });
    await waitFor(() => expect(patches.length).toBe(1));
    expect(asked).not.toHaveBeenCalled();
    expect(patches[0]).toEqual({ usage: "visual-reference" });
  });

  it("還在分析中的圖不再問：同一張圖不得被排第二次", async () => {
    // 可達路徑：上傳（parsing）→ 改「直接素材」（狀態不會清、在途工作照跑）→ 改回
    // 「視覺參考」。此時 extractedText 仍是空的，只靠它擋不住重複排隊。
    const asked = vi.fn(() => true);
    vi.stubGlobal("confirm", asked);
    const { patches } = renderWithUsage(imageSource({ usage: "direct-asset", status: "parsing" }));
    fireEvent.change(screen.getByRole("combobox", { name: "cost.png 的生成用途" }), {
      target: { value: "visual-reference" },
    });
    await waitFor(() => expect(patches.length).toBe(1));
    expect(asked).not.toHaveBeenCalled();
    expect(patches[0]).toEqual({ usage: "visual-reference" });
  });
});

describe("用途已經不是視覺參考時不再顯示分析中", () => {
  it("排隊期間改成直接素材：卡片不得對著一份素材說 AI 正在讀它", () => {
    // 背景工作要輪到它才會把 parsing 收掉，前面排一長串時可能是好幾分鐘。
    const source = imageSource({ usage: "direct-asset", status: "parsing" });
    render(<SourcePanel project={projectWith(source)} onProject={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByText(/AI 分析圖片內容中…/)).toBe(null);
    expect(screen.getByText(/0 個文字區塊/)).toBeTruthy();
  });
});

describe("描述失敗時的可見性", () => {
  it("失敗原因對應到一句使用者能行動的話，而不是靜默地什麼都沒有", async () => {
    const failed = imageSource({
      metadata: { imageDescriptionFailure: "unsupported" },
    });
    render(<SourcePanel project={projectWith(failed)} onProject={vi.fn()} onError={vi.fn()} />);
    // 沒有這一行的話，「跑過但失敗」與「從來沒跑過」在畫面上完全一樣。
    expect(screen.getByText(/AI 未讀取圖片內容/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "預覽 cost.png" }));
    const dialog = await screen.findByRole("dialog", { name: /預覽來源：cost.png/ });
    expect(dialog.textContent).toContain("不支援讀圖");
    expect(dialog.textContent).toContain("模型庫");
  });

  it("成功時在來源詳情看得到產生描述的模型：可查證不能只成立在 project.json 裡", async () => {
    const described = imageSource({
      extractedText: `${NOTICE}。Y 軸：每度成本。`,
      chunks: [{ id: "chunk-1", text: "描述", locator: "image-description:1" }],
      metadata: { imageDescriptionModel: "gpt-5-vision" },
    });
    render(<SourcePanel project={projectWith(described)} onProject={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "預覽 cost.png" }));
    const dialog = await screen.findByRole("dialog", { name: /預覽來源：cost.png/ });
    expect(dialog.textContent).toContain("內容描述模型");
    expect(dialog.textContent).toContain("gpt-5-vision");
  });
});

describe("背景描述完成後畫面自己更新", () => {
  it("有來源停在 parsing 時持續輪詢專案，描述回來後停止", async () => {
    const parsing = projectWith(imageSource({ status: "parsing" }));
    const done = structuredClone(parsing);
    done.sources[0]!.status = "indexed";
    done.sources[0]!.extractedText = `${NOTICE}。Y 軸：每度成本。`;
    done.sources[0]!.chunks = [{ id: "chunk-1", text: "描述", locator: "image-description:1" }];

    let projectFetches = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/projects") return Response.json([parsing]);
      if (path === "/api/providers")
        return Response.json([
          {
            id: "mock-image",
            name: "Mock",
            availability: { status: "available" },
            capabilities: { fullSlideGeneration: true },
          },
        ]);
      if (path === "/api/styles") return Response.json([]);
      if (path === `/api/projects/${parsing.id}`) {
        projectFetches += 1;
        // 第一次載入時描述還沒好，之後才回寫完的版本。
        return Response.json(projectFetches > 1 ? done : parsing);
      }
      return Response.json(parsing);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("圖片描述"));
    // 「來源」的唯一入口是右側 inspector 的分頁，標籤帶著來源筆數（「來源 N」）。
    fireEvent.click(screen.getByRole("button", { name: /^來源 \d+$/ }));
    expect(await screen.findByText(/AI 分析圖片內容中…/)).toBeTruthy();

    // 沒有任何使用者操作，畫面就要自己換掉——這正是輪詢在做的事。
    expect(await screen.findByText(/1 個文字區塊/, {}, { timeout: 4_000 })).toBeTruthy();
    // 「輪詢有沒有停」由 ImageSourceDescriptionPolling.test.tsx 負責：那裡等的時間長於一個
    // 完整週期，這裡原本只等 400ms（短於 1.5 秒的間隔），把守衛整個拿掉也一樣會通過。
    // 這個案例會實際等過一輪 1.5 秒的輪詢；預設 5 秒逾時在並行跑測試時太緊。
  }, 20_000);
});

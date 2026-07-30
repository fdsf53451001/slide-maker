// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor, firstPresentableIndex, nextVisibleIndex } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSystemSettings();
});

describe("換頁的可見頁邊界只有一份", () => {
  const deck = (hiddenIndexes: number[], count = 5) =>
    Array.from({ length: count }, (_, index) => ({ hidden: hiddenIndexes.includes(index) }));

  it("往前往後都跳過連續的隱藏頁", () => {
    const slides = deck([1, 2]);
    expect(nextVisibleIndex(slides, 0, 1)).toBe(3);
    expect(nextVisibleIndex(slides, 3, -1)).toBe(0);
  });

  it("沒有下一張可見頁時回 undefined，而不是夾回原地——兩者是不同的意思", () => {
    // 夾回原地的話，控制列的 disabled 與「還有下一頁」就分不出來了。
    const slides = deck([3, 4]);
    expect(nextVisibleIndex(slides, 2, 1)).toBeUndefined();
    expect(nextVisibleIndex(slides, 0, -1)).toBeUndefined();
  });

  it("起點允許落在陣列外：Home／End 靠它取第一張與最後一張可見頁", () => {
    const slides = deck([0, 4]);
    expect(nextVisibleIndex(slides, -1, 1)).toBe(1);
    expect(nextVisibleIndex(slides, slides.length, -1)).toBe(3);
  });

  it("全部隱藏時任何方向都沒有可見頁", () => {
    const slides = deck([0, 1, 2, 3, 4]);
    expect(nextVisibleIndex(slides, -1, 1)).toBeUndefined();
    expect(nextVisibleIndex(slides, slides.length, -1)).toBeUndefined();
    expect(firstPresentableIndex(slides, 2)).toBeUndefined();
  });

  it("起始頁可見就用它；被隱藏就落到最近的可見頁（先往後、沒有才往前）", () => {
    expect(firstPresentableIndex(deck([]), 2)).toBe(2);
    expect(firstPresentableIndex(deck([2]), 2)).toBe(3);
    expect(firstPresentableIndex(deck([2, 3, 4]), 2)).toBe(1);
  });
});

function hiddenDeck(topic: string, hiddenOrders: number[] = [], slideCount = 4) {
  const project = createProject({ topic, brief: { desiredSlideCount: slideCount } });
  project.workflowStage = "editing";
  const now = new Date().toISOString();
  for (const slide of project.slides) {
    slide.hidden = hiddenOrders.includes(slide.order);
    slide.versions = [
      {
        id: `${slide.id}-v1`,
        imagePath: `assets/generated/${slide.id}.png`,
        prompt: "",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      },
    ];
    slide.currentVersionId = `${slide.id}-v1`;
  }
  return project;
}

/** 頁面 PATCH 直接併回同一份專案，模擬伺服器的部分更新語意。 */
function stubApi(state: { project: PresentationProject }) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    if (path === "/api/projects" && (init?.method ?? "GET") === "GET")
      return Response.json([state.project]);
    if (path === "/api/providers")
      return Response.json([
        {
          id: "mock-image",
          name: "Mock",
          availability: { status: "available" },
          capabilities: { fullSlideGeneration: true },
        },
      ]);
    if (path === "/api/styles") return Response.json([createDefaultStyle()]);
    if (path.includes("/readiness"))
      return Response.json({
        providerId: "mock-image",
        status: "ready",
        blocking: false,
        requiresAcknowledgement: false,
        message: "Ready",
        checkedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      });
    const slideMatch = /\/api\/projects\/[^/]+\/slides\/([^/]+)$/.exec(path);
    if (slideMatch && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.project = {
        ...state.project,
        slides: state.project.slides.map((slide) =>
          slide.id === slideMatch[1] ? { ...slide, ...patch } : slide,
        ),
      };
      return Response.json(state.project);
    }
    return Response.json(state.project);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function enter(topic: string) {
  render(<Editor />);
  fireEvent.click(await screen.findByText(topic));
  await screen.findByText("▶ 簡報模式");
}

const thumbnails = () => Array.from(document.querySelectorAll<HTMLElement>(".thumbnail"));

describe("縮圖列的隱藏按鈕", () => {
  it("按下去送出 hidden: true，縮圖跟著標成隱藏", async () => {
    const state = { project: hiddenDeck("隱藏按鈕") };
    const fetchMock = stubApi(state);
    await enter("隱藏按鈕");

    fireEvent.click(screen.getAllByLabelText("隱藏此頁")[1]!);

    await waitFor(() => expect(thumbnails()[1]!.className).toContain("hidden-slide"));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(String(call[0])).toContain(`/slides/${state.project.slides[1]!.id}`);
    expect(JSON.parse(String(call[1]!.body))).toEqual({ hidden: true });
    // 標記是 .thumb-canvas 的兄弟節點：放進被淡化的縮圖裡會跟著父層 opacity 一起糊掉。
    const badge = thumbnails()[1]!.querySelector(".thumb-hidden-badge")!;
    expect(badge.textContent).toBe("已隱藏");
    expect(badge.closest(".thumb-canvas")).toBeNull();
  });

  it("隱藏中的頁面按鈕改口成「取消隱藏」，再按一次送出 hidden: false", async () => {
    const state = { project: hiddenDeck("取消隱藏", [2]) };
    const fetchMock = stubApi(state);
    await enter("取消隱藏");

    const toggle = screen.getByLabelText("取消隱藏此頁");
    expect(toggle.getAttribute("title")).toBe("取消隱藏此頁");
    // 名稱已經蘊含狀態（「取消隱藏」＝現在是隱藏的），所以刻意不再加 aria-pressed：
    // 兩者併用會被念成「取消隱藏此頁, 已按下」，是雙重否定。
    expect(toggle.hasAttribute("aria-pressed")).toBe(false);
    // 可見頁那幾顆同樣只有名稱，沒有半個 pressed 狀態。
    for (const other of screen.getAllByLabelText("隱藏此頁"))
      expect(other.hasAttribute("aria-pressed")).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() => expect(thumbnails()[2]!.className).not.toContain("hidden-slide"));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ hidden: false });
  });

  /*
   * 圖示是 inline SVG 而不是 `◎`／`⊘`／`👁` 這類符號字元：符號會落到各平台不同的 fallback
   * 字型（`👁` 甚至變成彩色 emoji），同一排三顆圖示鈕就會粗細與大小對不齊。
   * 兩態共用眼睛輪廓、只差一條劃掉的斜線，才會被讀成同一顆按鈕的兩個狀態。
   */
  it("可見／隱藏兩態都是眼睛 SVG，只有隱藏那顆多一條劃掉的斜線", async () => {
    const state = { project: hiddenDeck("眼睛圖示", [2]) };
    stubApi(state);
    await enter("眼睛圖示");

    const visible = screen.getAllByLabelText("隱藏此頁")[0]!.querySelector("svg")!;
    const hidden = screen.getByLabelText("取消隱藏此頁").querySelector("svg")!;
    // 眼白＋瞳孔在兩態都在；文字節點（符號字元）一個都不該剩。
    for (const icon of [visible, hidden]) {
      expect(icon.querySelector("circle")).toBeTruthy();
      expect(icon.closest("button")!.textContent).toBe("");
    }
    expect(visible.querySelectorAll("path")).toHaveLength(1);
    expect(hidden.querySelectorAll("path")).toHaveLength(2);
  });

  it("點按鈕不會順手把那一頁選起來（stopPropagation 仍在）", async () => {
    const state = { project: hiddenDeck("不改選取") };
    stubApi(state);
    await enter("不改選取");
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();

    fireEvent.click(screen.getAllByLabelText("隱藏此頁")[3]!);
    await waitFor(() => expect(thumbnails()[3]!.className).toContain("hidden-slide"));
    expect(screen.getByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
  });

  it("隱藏頁仍然選得到、編得動：畫布照常顯示它", async () => {
    const state = { project: hiddenDeck("隱藏仍可編輯", [1]) };
    stubApi(state);
    await enter("隱藏仍可編輯");

    fireEvent.click(thumbnails()[1]!);
    expect(await screen.findByDisplayValue(state.project.slides[1]!.purpose)).toBeTruthy();
  });
});

describe("批次生成遇到隱藏頁時先讓使用者選", () => {
  /** `POST /api/projects/:id/generate` 的 body（批次生成唯一會打的那一支）。 */
  const generateBodies = (fetchMock: ReturnType<typeof stubApi>) =>
    fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith("/generate") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);

  const openProjectPanel = async () => {
    fireEvent.click(screen.getByRole("button", { name: "專案" }));
    return screen.findByText("批次生成全部頁面");
  };

  it("沒有隱藏頁：不出現對話框，直接送出且不帶 slideIds（與加入這個功能前逐位元相同）", async () => {
    const state = { project: hiddenDeck("無隱藏頁批次") };
    const fetchMock = stubApi(state);
    await enter("無隱藏頁批次");

    fireEvent.click(await openProjectPanel());
    expect(screen.queryByRole("dialog", { name: "要連隱藏頁一起生成嗎？" })).toBeNull();
    await waitFor(() => expect(generateBodies(fetchMock)).toHaveLength(1));
    expect(generateBodies(fetchMock)[0]).toEqual({ acceptUnknownReadiness: false });
  });

  it("有隱藏頁：出現三選一對話框，講出張數與配額，且還沒送出任何請求", async () => {
    const state = { project: hiddenDeck("問過再生成", [1, 3]) };
    const fetchMock = stubApi(state);
    await enter("問過再生成");

    fireEvent.click(await openProjectPanel());
    const dialog = await screen.findByRole("dialog", { name: "要連隱藏頁一起生成嗎？" });
    expect(dialog.textContent).toContain("消耗影像模型配額");
    // 共 4 頁、其中 2 頁隱藏。
    expect(dialog.textContent).toMatch(/共\s*4\s*頁/);
    expect(dialog.textContent).toMatch(/其中\s*2\s*頁已隱藏/);
    expect(generateBodies(fetchMock)).toHaveLength(0);
  });

  it("選「只生成可見頁」只送可見頁的 id", async () => {
    const state = { project: hiddenDeck("只生成可見", [1, 3]) };
    const fetchMock = stubApi(state);
    const visibleIds = [state.project.slides[0]!.id, state.project.slides[2]!.id];
    await enter("只生成可見");

    fireEvent.click(await openProjectPanel());
    fireEvent.click(await screen.findByText(/只生成可見頁（2 頁）/));

    await waitFor(() => expect(generateBodies(fetchMock)).toHaveLength(1));
    expect(generateBodies(fetchMock)[0]).toEqual({
      acceptUnknownReadiness: false,
      slideIds: visibleIds,
    });
    expect(screen.queryByRole("dialog", { name: "要連隱藏頁一起生成嗎？" })).toBeNull();
  });

  it("選「含隱藏頁一起生成」不帶 slideIds（讓 server 照舊排全部頁面）", async () => {
    const state = { project: hiddenDeck("含隱藏一起", [1]) };
    const fetchMock = stubApi(state);
    await enter("含隱藏一起");

    fireEvent.click(await openProjectPanel());
    fireEvent.click(await screen.findByText(/含隱藏頁一起生成（4 頁）/));

    await waitFor(() => expect(generateBodies(fetchMock)).toHaveLength(1));
    expect(generateBodies(fetchMock)[0]).toEqual({ acceptUnknownReadiness: false });
  });

  it("選「取消」什麼都不送，對話框關掉", async () => {
    const state = { project: hiddenDeck("取消批次", [2]) };
    const fetchMock = stubApi(state);
    await enter("取消批次");

    fireEvent.click(await openProjectPanel());
    const dialog = await screen.findByRole("dialog", { name: "要連隱藏頁一起生成嗎？" });
    fireEvent.click(within(dialog).getByText("取消"));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "要連隱藏頁一起生成嗎？" })).toBeNull(),
    );
    expect(generateBodies(fetchMock)).toHaveLength(0);
  });
});

describe("縮圖列 PAGES 的清點反映隱藏頁", () => {
  /** 給眼睛看的那一段（另一段是只給螢幕閱讀器的完整句子）。 */
  const countText = () =>
    document.querySelector(".rail-heading-count b span[aria-hidden='true']")!.textContent;
  const countTitle = () => document.querySelector(".rail-heading-count b")!.getAttribute("title");
  const countSpoken = () =>
    document.querySelector(".rail-heading-count b .visually-hidden")!.textContent;

  it("有隱藏頁時寫「可見數/總數」，並用一句完整的話說明", async () => {
    const state = { project: hiddenDeck("清點有隱藏", [1]) };
    stubApi(state);
    await enter("清點有隱藏");

    expect(countText()).toBe("3/4");
    expect(countTitle()).toBe("4 頁，其中 1 頁隱藏，3 頁會放映");
    // 「3/4」念出來是「三斜線四」，等於沒有資訊；閱讀器讀到的必須是那句話。
    expect(countSpoken()).toBe("4 頁，其中 1 頁隱藏，3 頁會放映");
  });

  it("沒有隱藏頁時維持單一數字，不寫成 4/4（那個分母不帶任何資訊）", async () => {
    const state = { project: hiddenDeck("清點無隱藏") };
    stubApi(state);
    await enter("清點無隱藏");

    expect(countText()).toBe("4");
    expect(countTitle()).toBe("4 頁");
    expect(countSpoken()).toBe("4 頁");
  });

  it("按下隱藏鈕後就地改成 3/4，取消隱藏再變回 4", async () => {
    const state = { project: hiddenDeck("清點跟著切換") };
    stubApi(state);
    await enter("清點跟著切換");
    expect(countText()).toBe("4");

    fireEvent.click(screen.getAllByLabelText("隱藏此頁")[2]!);
    await waitFor(() => expect(countText()).toBe("3/4"));

    fireEvent.click(screen.getByLabelText("取消隱藏此頁"));
    await waitFor(() => expect(countText()).toBe("4"));
    expect(countTitle()).toBe("4 頁");
  });

  it("全部頁面都隱藏時是 0/4，不是空字串也不是退回單一數字", async () => {
    // 0 是**最需要**分子的那一格：這個狀態下簡報模式與 pptx／pdf 都會被拒絕，
    // 縮圖列還是列出四張，單一個「4」等於完全沒有線索。
    const state = { project: hiddenDeck("全部隱藏", [0, 1, 2, 3]) };
    stubApi(state);
    await enter("全部隱藏");

    expect(countText()).toBe("0/4");
    expect(countTitle()).toBe("4 頁，其中 4 頁隱藏，0 頁會放映");
    expect(countSpoken()).toBe("4 頁，其中 4 頁隱藏，0 頁會放映");
  });

  it("只有一頁且未隱藏：單一個 1（分母同樣不帶資訊）", async () => {
    const state = { project: hiddenDeck("單頁未隱藏", [], 1) };
    stubApi(state);
    await enter("單頁未隱藏");

    expect(countText()).toBe("1");
    expect(countTitle()).toBe("1 頁");
  });

  it("只有一頁且被隱藏：0/1", async () => {
    const state = { project: hiddenDeck("單頁被隱藏", [0], 1) };
    stubApi(state);
    await enter("單頁被隱藏");

    expect(countText()).toBe("0/1");
    expect(countTitle()).toBe("1 頁，其中 1 頁隱藏，0 頁會放映");
  });

  it("隱藏兩頁再取消其中一頁，分子逐步回升而不是一次跳回單一數字", async () => {
    const state = { project: hiddenDeck("逐步取消隱藏", [1, 2]) };
    stubApi(state);
    await enter("逐步取消隱藏");
    expect(countText()).toBe("2/4");

    fireEvent.click(screen.getAllByLabelText("取消隱藏此頁")[0]!);

    await waitFor(() => expect(countText()).toBe("3/4"));
    expect(countTitle()).toBe("4 頁，其中 1 頁隱藏，3 頁會放映");
  });
});

describe("隱藏頁不佔頁碼", () => {
  it("編輯畫布的頁碼是可見序，隱藏頁本身沒有頁碼", async () => {
    const state = { project: hiddenDeck("畫布頁碼", [1]) };
    state.project.pageNumber = {
      ...state.project.pageNumber,
      enabled: true,
      skipFirstSlide: false,
      format: "number-total",
    };
    stubApi(state);
    await enter("畫布頁碼");

    // 四頁隱藏第二頁 → 可見頁是 1 / 3、2 / 3、3 / 3。
    await waitFor(() =>
      expect(document.querySelector(".page-number-text")!.textContent).toBe("1 / 3"),
    );
    fireEvent.click(thumbnails()[1]!);
    await waitFor(() => expect(document.querySelector(".page-number-layer")).toBeNull());
    fireEvent.click(thumbnails()[2]!);
    await waitFor(() =>
      expect(document.querySelector(".page-number-text")!.textContent).toBe("2 / 3"),
    );
  });
});

describe("匯出面板講清楚哪些頁面會進成品", () => {
  const openExportPanel = async () => {
    // 「匯出」在頁面上不只一處（分頁按鈕以外還有別的文案），限定在 inspector 分頁列裡取。
    const tabs = document.querySelector<HTMLElement>(".inspector-tabs")!;
    fireEvent.click(within(tabs).getByText("匯出"));
    return screen.findByText(/匯出會依目前頁面順序/);
  };
  const links = () =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>(".export-panel a")).map((anchor) =>
      anchor.getAttribute("href"),
    );

  it("有隱藏頁時就在下載點旁邊講出可見頁數，四個連結都還在", async () => {
    const state = { project: hiddenDeck("匯出說明", [1]) };
    stubApi(state);
    await enter("匯出說明");

    const text = (await openExportPanel()).textContent ?? "";
    expect(text).toMatch(/1\s*頁隱藏/);
    expect(text).toMatch(/3 \/ 4/);
    expect(text).toContain("pptx／pdf 只含可見頁");
    expect(text).toContain("PNG 與專案備份收錄全部頁面");
    expect(links()).toHaveLength(4);
  });

  it("沒有隱藏頁時仍講出規則，但不報張數（沒有可報的）", async () => {
    const state = { project: hiddenDeck("匯出無隱藏") };
    stubApi(state);
    await enter("匯出無隱藏");

    const text = (await openExportPanel()).textContent ?? "";
    expect(text).toContain("pptx／pdf 只含可見頁");
    expect(text).not.toMatch(/頁隱藏/);
    expect(links()).toHaveLength(4);
  });

  it("全部隱藏時 pptx／pdf 的連結整個不給，改成就地說明；另兩個仍在", async () => {
    // 伺服器對這個狀態回 400，而匯出連結是裸 `<a href>`：讓它按得下去等於把一段 JSON
    // 丟進瀏覽器分頁。
    const state = { project: hiddenDeck("全部隱藏匯出", [0, 1, 2, 3]) };
    stubApi(state);
    await enter("全部隱藏匯出");
    await openExportPanel();

    expect(document.querySelector(".export-blocked")?.textContent).toMatch(/所有頁面都已隱藏/);
    const hrefs = links();
    expect(hrefs.some((href) => href?.endsWith("/export/pptx"))).toBe(false);
    expect(hrefs.some((href) => href?.endsWith("/export/pdf"))).toBe(false);
    expect(hrefs.some((href) => href?.endsWith("/export/png.zip"))).toBe(true);
    expect(hrefs.some((href) => href?.endsWith("/export/slide-project"))).toBe(true);
  });
});

describe("簡報模式跳過隱藏頁", () => {
  it("鍵盤換頁不會停在隱藏頁，控制列的數字只算可見頁", async () => {
    const state = { project: hiddenDeck("簡報跳過", [1, 2]) };
    stubApi(state);
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    await enter("簡報跳過");

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    // 四頁隱藏中間兩頁 → 只剩兩張可見頁。
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByLabelText("上一頁").hasAttribute("disabled")).toBe(true);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("2 / 2")).toBeTruthy();
    expect(screen.getByLabelText("下一頁").hasAttribute("disabled")).toBe(true);

    // 到底了就停住，不迴圈也不掉進隱藏頁。
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("2 / 2")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(await screen.findByText("1 / 2")).toBeTruthy();
  });

  it("Home／End 落在第一張與最後一張可見頁上", async () => {
    const state = { project: hiddenDeck("簡報首末", [0, 3]) };
    stubApi(state);
    await enter("簡報首末");

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "End" });
    expect(await screen.findByText("2 / 2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Home" });
    expect(await screen.findByText("1 / 2")).toBeTruthy();
  });

  it("點擊舞台前進同樣跳過隱藏頁", async () => {
    const state = { project: hiddenDeck("點擊前進", [1]) };
    stubApi(state);
    await enter("點擊前進");

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    const dialog = await screen.findByRole("dialog", { name: "全螢幕簡報" });
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.click(dialog);
    // 隱藏的第二頁被跳過，直接到第三頁（可見序的第 2 頁）。
    expect(await screen.findByText("2 / 3")).toBeTruthy();
    expect(
      document.querySelector<HTMLImageElement>(".presentation-stage img")!.getAttribute("alt"),
    ).toBe("簡報第 2 頁");
  });

  it("滾輪換頁同樣跳過隱藏頁", async () => {
    const state = { project: hiddenDeck("滾輪跳過", [1, 2]) };
    stubApi(state);
    await enter("滾輪跳過");

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();

    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 2")).toBeTruthy();
  });

  it("控制列的上一頁按鈕跳過隱藏頁", async () => {
    const state = { project: hiddenDeck("控制列", [1, 2]) };
    stubApi(state);
    await enter("控制列");

    // 從最後一頁進場。
    fireEvent.click(thumbnails()[3]!);
    expect(await screen.findByDisplayValue(state.project.slides[3]!.purpose)).toBeTruthy();
    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByText("2 / 2")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("上一頁"));
    expect(await screen.findByText("1 / 2")).toBeTruthy();
  });

  it("選取的是隱藏頁時，進場落到最近的可見頁", async () => {
    const state = { project: hiddenDeck("起始頁", [1]) };
    stubApi(state);
    await enter("起始頁");

    fireEvent.click(thumbnails()[1]!);
    expect(await screen.findByDisplayValue(state.project.slides[1]!.purpose)).toBeTruthy();
    fireEvent.click(screen.getByText("▶ 簡報模式"));

    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    // 隱藏的第二頁不放映，落到第三頁＝可見序的第 2 頁。
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("全部頁面都被隱藏時不進簡報模式，改以錯誤訊息說明", async () => {
    const state = { project: hiddenDeck("全部隱藏", [0, 1, 2, 3]) };
    stubApi(state);
    await enter("全部隱藏");

    fireEvent.click(screen.getByText("▶ 簡報模式"));

    expect(await screen.findByText(/所有頁面都已隱藏/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "全螢幕簡報" })).toBeNull();
  });
});

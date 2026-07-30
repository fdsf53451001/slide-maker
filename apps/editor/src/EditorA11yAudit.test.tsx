// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";

/**
 * UI/UX 稽核修好的那幾件事的回歸測試。
 *
 * 這裡釘的都是「畫面上看不出差別、但使用者用不了」的類別：宣告成可按卻按不動的鍵盤路徑、
 * 按下去沒反應因而被連按的非同步動作、只有顏色沒有文字的狀態訊號。它們沒有一條會在
 * 視覺回歸或既有的功能測試裡露餡，所以必須各自有斷言。
 */

afterEach(() => {
  cleanup();
  resetSystemSettings();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

function editableDeck(topic: string, slideCount = 3) {
  const project = createProject({ topic, brief: { desiredSlideCount: slideCount } });
  project.workflowStage = "editing";
  const now = new Date().toISOString();
  for (const slide of project.slides) {
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

/**
 * 伺服器樁。`hold` 讓指定的端點停在 in-flight（回一個永不 resolve 的 promise），
 * 連點守衛必須在那段空窗裡就成立——那正是舊版按鈕還亮著的那一段。
 */
function stubApi(state: { project: PresentationProject }, hold?: (path: string) => boolean) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://local.test").pathname;
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
    if (path === "/api/model-library")
      return Response.json({ connections: [], models: [], combinations: [] });
    if (path === "/api/text-providers") return Response.json([]);
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
    if (hold?.(path)) return new Promise<Response>(() => undefined);
    return Response.json(state.project);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const thumbnails = () => Array.from(document.querySelectorAll<HTMLElement>(".thumbnail"));
const callsTo = (fetchMock: ReturnType<typeof stubApi>, suffix: string, method = "POST") =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith(suffix) && (init?.method ?? "GET") === method,
  );

async function enter(topic: string) {
  render(<Editor />);
  fireEvent.click(await screen.findByText(topic));
  await screen.findByText("▶ 簡報模式");
}

describe("縮圖列的鍵盤路徑", () => {
  it('Enter 與 Space 都選得起頁面（role="button" 不會自己合成 click）', async () => {
    const state = { project: editableDeck("縮圖鍵盤選取") };
    stubApi(state);
    await enter("縮圖鍵盤選取");
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();

    fireEvent.keyDown(thumbnails()[1]!, { key: "Enter" });
    expect(await screen.findByDisplayValue(state.project.slides[1]!.purpose)).toBeTruthy();

    fireEvent.keyDown(thumbnails()[2]!, { key: " " });
    expect(await screen.findByDisplayValue(state.project.slides[2]!.purpose)).toBeTruthy();
  });

  it("在操作按鈕上按 Enter 不會順手把那一頁也選起來", async () => {
    const state = { project: editableDeck("按鈕上的 Enter 不冒泡成選取") };
    stubApi(state);
    await enter("按鈕上的 Enter 不冒泡成選取");
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();

    // 真的 <button> 會自己處理 Enter，keydown 照樣冒泡到縮圖；不擋的話「按 Enter 隱藏
    // 這一頁」會連帶跳頁，使用者看到的是自己沒有要求的換頁。
    fireEvent.keyDown(within(thumbnails()[2]!).getByLabelText("隱藏此頁"), { key: "Enter" });
    expect(screen.getByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
  });

  it('選中的縮圖帶 aria-current="page"，其餘沒有', async () => {
    const state = { project: editableDeck("縮圖選中狀態") };
    stubApi(state);
    await enter("縮圖選中狀態");
    await screen.findByDisplayValue(state.project.slides[0]!.purpose);

    expect(thumbnails()[0]!.getAttribute("aria-current")).toBe("page");
    expect(thumbnails()[1]!.hasAttribute("aria-current")).toBe(false);

    fireEvent.click(thumbnails()[1]!);
    await waitFor(() => expect(thumbnails()[1]!.getAttribute("aria-current")).toBe("page"));
    expect(thumbnails()[0]!.hasAttribute("aria-current")).toBe(false);
  });

  /*
   * 縮圖列曾經有一組 ↑↓ 排序鈕，依使用者要求移除（維持移除）。要誠實記下放棄了什麼：
   * 拖曳因此又是縮圖列**唯一**的排序途徑，純鍵盤與觸控使用者排不了序——大綱頁那組 ↑↓
   * 仍在，但那是大綱階段，進了編輯階段就回不去。這是用畫面密度換排序的可及性，不是
   * 「反正別處也做得到」。
   */
  it("縮圖列不再有 ↑↓ 排序鈕", async () => {
    const state = { project: editableDeck("縮圖沒有排序鈕") };
    stubApi(state);
    await enter("縮圖沒有排序鈕");

    const actions = within(thumbnails()[1]!);
    expect(actions.queryByLabelText("往上移動")).toBeNull();
    expect(actions.queryByLabelText("往下移動")).toBeNull();
  });

  it("複製與刪除都有 aria-label，不只有滑鼠才看得到的 title", async () => {
    const state = { project: editableDeck("縮圖操作有名稱") };
    stubApi(state);
    await enter("縮圖操作有名稱");

    const actions = within(thumbnails()[0]!);
    expect(actions.getByLabelText("複製頁面").getAttribute("title")).toBe("複製頁面");
    expect(actions.getByLabelText("刪除頁面").getAttribute("title")).toBe("刪除頁面");
  });
});

describe("非同步動作的連點守衛", () => {
  it("複製頁面連按兩下只送一次（否則會得到兩份副本）", async () => {
    const state = { project: editableDeck("複製不重複") };
    const fetchMock = stubApi(state, (path) => path.endsWith("/duplicate"));
    await enter("複製不重複");

    const duplicate = within(thumbnails()[0]!).getByLabelText("複製頁面");
    fireEvent.click(duplicate);
    fireEvent.click(duplicate);
    await waitFor(() => expect((duplicate as HTMLButtonElement).disabled).toBe(true));

    expect(callsTo(fetchMock, "/duplicate")).toHaveLength(1);
  });

  it("「生成此頁」在 activeJob 出現之前那段空窗就鎖住，不會排出兩個 job", async () => {
    const state = { project: editableDeck("生成不重複") };
    // readiness → save → generate → getProject 四趟往返裡，`generate` 停在途中：
    // 這正是舊版 `activeJob` 還沒出現、按鈕還亮著的那一段。
    const fetchMock = stubApi(state, (path) => path.endsWith("/generate"));
    await enter("生成不重複");

    const button = await screen.findByRole("button", { name: /重新生成圖片|生成此頁/ });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: /生成中…/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /生成中…/ }));

    expect(callsTo(fetchMock, "/generate")).toHaveLength(1);
  });

  it("「依 Brief 重建大綱」連按兩下只跑一輪搜尋與大綱生成", async () => {
    const state = { project: editableDeck("重建大綱不重複") };
    const fetchMock = stubApi(state, (path) => path.endsWith("/outline"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await enter("重建大綱不重複");

    fireEvent.click(screen.getByRole("button", { name: "專案" }));
    fireEvent.click(await screen.findByText("依 Brief 重建大綱"));
    // 按下去之後文案必須換掉：這條路實測數十秒到數分鐘，沒有回饋就是被連按的原因。
    const busy = await screen.findByText("正在檢索來源與重建大綱…");
    fireEvent.click(busy);

    expect(callsTo(fetchMock, "/outline")).toHaveLength(1);
    expect((screen.getByText("儲存 Brief") as HTMLButtonElement).disabled).toBe(true);
  });

  it("「批次生成全部頁面」在 project.jobs 更新之前就鎖住", async () => {
    const state = { project: editableDeck("批次生成不重複") };
    const fetchMock = stubApi(state, (path) => /\/projects\/[^/]+\/generate$/.test(path));
    await enter("批次生成不重複");

    fireEvent.click(screen.getByRole("button", { name: "專案" }));
    fireEvent.click(await screen.findByText("批次生成全部頁面"));
    const busy = await screen.findByText("正在排程批次生成…");
    fireEvent.click(busy);

    expect(callsTo(fetchMock, "/generate")).toHaveLength(1);
  });

  it("「儲存 Brief」連按兩下只送一次 PATCH（兩筆會互相覆蓋）", async () => {
    const state = { project: editableDeck("儲存 Brief 不重複") };
    const fetchMock = stubApi(state, (path) => path.endsWith("/brief"));
    await enter("儲存 Brief 不重複");

    fireEvent.click(screen.getByRole("button", { name: "專案" }));
    fireEvent.click(await screen.findByText("儲存 Brief"));
    // 文案換掉才是使用者看得到的回饋；沒有它，這顆按鈕按下去與沒按完全一樣。
    const busy = await screen.findByText("正在儲存…");
    fireEvent.click(busy);

    expect(callsTo(fetchMock, "/brief", "PATCH")).toHaveLength(1);
  });

  it("縮圖的「刪除頁面」連按兩下只送一次 DELETE", async () => {
    const state = { project: editableDeck("刪除頁面不重複") };
    const slideId = state.project.slides[0]!.id;
    const fetchMock = stubApi(state, (path) => path.endsWith(`/slides/${slideId}`));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await enter("刪除頁面不重複");

    const remove = within(thumbnails()[0]!).getByLabelText("刪除頁面");
    fireEvent.click(remove);
    fireEvent.click(remove);
    // 第二刀送出去會刪掉「往前補上來」的那一頁，而使用者只按了同一顆按鈕兩次。
    await waitFor(() => expect((remove as HTMLButtonElement).disabled).toBe(true));

    expect(callsTo(fetchMock, `/slides/${slideId}`, "DELETE")).toHaveLength(1);
  });
});

describe("對話框：Escape、名稱與焦點", () => {
  it("系統設定按 Escape 關得掉", async () => {
    const state = { project: editableDeck("設定 Esc") };
    stubApi(state);
    await enter("設定 Esc");

    fireEvent.click(screen.getByRole("button", { name: "系統設定" }));
    const dialog = await screen.findByRole("dialog", { name: "系統設定" });
    // 進場焦點要落進對話框裡，否則第一次 Tab 會從頁面某處繼續走。
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "系統設定" })).toBeNull());
  });

  it("批次生成的三選一按 Escape 關得掉，而且一個請求都不送", async () => {
    const project = editableDeck("三選一 Esc", 3);
    project.slides[1]!.hidden = true;
    const state = { project };
    const fetchMock = stubApi(state);
    await enter("三選一 Esc");

    fireEvent.click(screen.getByRole("button", { name: "專案" }));
    fireEvent.click(await screen.findByText("批次生成全部頁面"));
    await screen.findByRole("dialog", { name: "要連隱藏頁一起生成嗎？" });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "要連隱藏頁一起生成嗎？" })).toBeNull(),
    );
    expect(callsTo(fetchMock, "/generate")).toHaveLength(0);
  });

  it("刪除簡報確認有名稱，而且 Escape 就是它最該有的那條退路", async () => {
    const state = { project: editableDeck("刪除確認") };
    stubApi(state);
    render(<Editor />);

    fireEvent.click(await screen.findByLabelText(`刪除 ${state.project.name}`));
    // 破壞性確認沒有名稱時，閱讀器只念得到「對話方塊」。
    const dialog = await screen.findByRole("dialog", { name: "刪除簡報" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "刪除簡報" })).toBeNull());
  });

  it("刪除進行中按 Escape 不關閉：畫面收掉了，DELETE 照樣跑完", async () => {
    const state = { project: editableDeck("刪除中不放手") };
    const fetchMock = stubApi(state, (path) => path === `/api/projects/${state.project.id}`);
    render(<Editor />);

    fireEvent.click(await screen.findByLabelText(`刪除 ${state.project.name}`));
    const dialog = await screen.findByRole("dialog", { name: "刪除簡報" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^刪除$/ }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "刪除中…" })).toBeTruthy(),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    // 關掉的話使用者會以為自己攔下了刪除，而伺服器那邊已經在刪。
    expect(screen.getByRole("dialog", { name: "刪除簡報" })).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith(`/api/projects/${state.project.id}`) && init?.method === "DELETE",
      ),
    ).toHaveLength(1);
  });

  it("風格選擇正在準備參考圖時按 Escape 不關閉", async () => {
    const state = { project: editableDeck("風格選擇忙碌中") };
    const fetchMock = stubApi(state, (path) => path.endsWith("/style-reference"));
    await enter("風格選擇忙碌中");

    fireEvent.click(await screen.findByText("＋ 將圖片加入風格庫"));
    await screen.findByRole("dialog", { name: "選擇風格" });

    fireEvent.click(screen.getByText("建立新風格"));
    await screen.findByText("正在準備參考圖…");

    fireEvent.keyDown(window, { key: "Escape" });
    // 關掉會讓「圖片已寫進 sessionStorage、但畫面回到編輯器」這種半完成狀態無從察覺。
    expect(screen.getByRole("dialog", { name: "選擇風格" })).toBeTruthy();
    expect(callsTo(fetchMock, "/style-reference")).toHaveLength(1);
  });
});

describe("錯誤 toast 的語意", () => {
  it("編輯器：div[role=alert] 內含具名關閉鈕，按下訊息消失", async () => {
    const state = { project: editableDeck("編輯器錯誤 toast") };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
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
      if (path === "/api/model-library")
        return Response.json({ connections: [], models: [], combinations: [] });
      if (path === "/api/text-providers") return Response.json([]);
      if (path.endsWith("/duplicate"))
        return Response.json({ error: "SLIDE_DUPLICATE_FAILED" }, { status: 500 });
      return Response.json(state.project);
    });
    vi.stubGlobal("fetch", fetchMock);
    await enter("編輯器錯誤 toast");

    fireEvent.click(within(thumbnails()[0]!).getByLabelText("複製頁面"));

    // `role="alert"` 掛在容器上、關閉鈕保住自己的 button 語意：兩者要同時成立，
    // 舊版的 `button[role="alert"]` 會讓閱讀器念完錯誤卻不說這是可以按掉的東西。
    const toast = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".toast.error");
      if (!node) throw new Error("no toast");
      return node;
    });
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.tagName).toBe("DIV");
    const dismiss = within(toast).getByRole("button", { name: "關閉錯誤訊息" });

    fireEvent.click(dismiss);
    await waitFor(() => expect(document.querySelector(".toast.error")).toBeNull());
  });
});

describe("對話框開著時，背後的畫布快捷鍵停用", () => {
  it("來源面板開出來的對話框（state 不在 Editor 裡）照樣擋得住 ↑↓ 換頁", async () => {
    const state = { project: editableDeck("對話框背後不換頁") };
    stubApi(state);
    await enter("對話框背後不換頁");
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^來源 \d+$/ }));
    fireEvent.click(await screen.findByText(/貼上網址/));
    await screen.findByRole("dialog", { name: "貼上網址" });

    // 逐一列舉 state 的舊寫法看不到別的元件開的對話框，這一下會直接把畫面換到第二頁。
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("dialog", { name: "貼上網址" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "頁面" }));
    expect(screen.getByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
  });
});

describe("狀態與說明的可及性", () => {
  it("生成失敗會被播報，而且旁邊就有重試", async () => {
    const project = editableDeck("生成失敗有下一步");
    project.jobs = [
      {
        id: "job-1",
        projectId: project.id,
        slideId: project.slides[0]!.id,
        providerId: "mock-image",
        status: "failed",
        operation: "generate",
        attempt: 1,
        error: "配額用盡",
        errorCode: "QUOTA_EXHAUSTED",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const state = { project };
    const fetchMock = stubApi(state, (path) => path.includes("/generate"));
    await enter("生成失敗有下一步");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("QUOTA_EXHAUSTED");
    expect(alert.textContent).toContain("配額用盡");

    fireEvent.click(within(alert).getByRole("button", { name: "重試" }));
    await waitFor(() => expect(callsTo(fetchMock, "/generate")).toHaveLength(1));
  });

  it("橘框有文字版本，dirty 的欄位用 aria-describedby 指向它", async () => {
    const project = editableDeck("橘框說得出話");
    const slide = project.slides[0]!;
    slide.outlineDirty = true;
    slide.content = "改過的內容";
    slide.versions[0]!.outlineSnapshot = {
      purpose: slide.purpose,
      content: "生成當時的內容",
      narrative: slide.narrative,
      layoutHint: slide.layoutHint,
      imagePrompt: slide.imagePrompt,
      sourceIds: [],
    };
    const state = { project };
    stubApi(state);
    await enter("橘框說得出話");

    const note = await screen.findByText(/尚未反映到目前的圖片/);
    // 逐欄列出，使用者才知道要回頭看哪一格。
    expect(note.textContent).toContain("內容");
    expect(note.textContent).not.toContain("敘事");

    const contentField = screen.getByText("內容").closest("label")!.querySelector("textarea")!;
    expect(contentField.getAttribute("aria-describedby")).toBe(note.id);
    const narrativeField = screen.getByText("敘事").closest("label")!.querySelector("textarea")!;
    expect(narrativeField.hasAttribute("aria-describedby")).toBe(false);
  });

  it("inspector 分頁的現況不再只有 CSS class", async () => {
    const state = { project: editableDeck("分頁現況") };
    stubApi(state);
    await enter("分頁現況");

    expect(screen.getByRole("button", { name: "頁面" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "匯出" }).hasAttribute("aria-current")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "匯出" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "匯出" }).getAttribute("aria-current")).toBe(
        "page",
      ),
    );
    expect(screen.getByRole("button", { name: "頁面" }).hasAttribute("aria-current")).toBe(false);
  });

  it("專案改名輸入框與自動儲存狀態都念得出來", async () => {
    const state = { project: editableDeck("標題列語意") };
    stubApi(state);
    await enter("標題列語意");

    expect(document.querySelector('.header-status[role="status"]')).toBeTruthy();

    fireEvent.click(document.querySelector<HTMLElement>(".title-name")!);
    expect(await screen.findByLabelText("專案名稱")).toBeTruthy();
  });
});

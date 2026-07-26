// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";

/**
 * 離開簡報模式後，編輯器選取的是**剛剛在放映的那一頁**。
 *
 * 三條退出路徑（Esc、控制列關閉鈕、以 F11／瀏覽器原生方式離開全螢幕）共用同一支
 * `exitPresentation()`，所以三條都各釘一次：任何一條被改回自己 `setPresentationIndex(null)`
 * 都會在這裡紅。最後一則釘的是守衛——放映途中該頁被刪掉時不可把選取寫成 `undefined`
 * （那會讓 `selected` 退回 `slides[0]`，看起來像無故跳回第一頁）。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSystemSettings();
  // 有幾則會操作 history（回專案列表、換專案）；jsdom 的 window 是整個檔案共用的，
  // 不歸零會讓下一則以 `/projects/…` 當起始路由。
  window.history.replaceState({}, "", "/");
});

function deck(topic: string, count = 3, hiddenOrders: number[] = []) {
  const project = createProject({ topic, brief: { desiredSlideCount: count } });
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

function stubApi(state: { project: PresentationProject }, alsoListed: PresentationProject[] = []) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    if (path === "/api/projects" && (init?.method ?? "GET") === "GET")
      return Response.json([state.project, ...alsoListed]);
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
    if (slideMatch && init?.method === "DELETE") {
      state.project = {
        ...state.project,
        slides: state.project.slides
          .filter((slide) => slide.id !== slideMatch[1])
          .map((slide, index) => ({ ...slide, order: index })),
      };
      return Response.json(state.project);
    }
    return Response.json(state.project);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const thumbnails = () => Array.from(document.querySelectorAll<HTMLElement>(".thumbnail"));
const selectedThumbnailIndex = () =>
  thumbnails().findIndex((node) => node.className.includes("selected"));
const stage = () => screen.queryByRole("dialog", { name: "全螢幕簡報" });

/** 進場並停在 `slides[1]`：起點不是第一頁，退出後才分得出「同步了」與「什麼都沒做」。 */
async function presentAtSecondSlide(topic: string, project: PresentationProject) {
  const state = { project };
  const fetchMock = stubApi(state);
  render(<Editor />);
  fireEvent.click(await screen.findByText(topic));
  await screen.findByText("▶ 簡報模式");
  fireEvent.click(screen.getByText("▶ 簡報模式"));
  expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
  expect(screen.getByText("1 / 3")).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(await screen.findByText("2 / 3")).toBeTruthy();
  return { state, fetchMock };
}

describe("離開簡報模式時選取放映中的那一頁", () => {
  it("Esc 退出：選取跟著換到放映到的那一頁", async () => {
    const project = deck("Esc 退出");
    await presentAtSecondSlide("Esc 退出", project);
    expect(selectedThumbnailIndex()).toBe(0);

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(stage()).toBeNull());
    expect(selectedThumbnailIndex()).toBe(1);
    expect(await screen.findByDisplayValue(project.slides[1]!.purpose)).toBeTruthy();
  });

  it("控制列的關閉鈕與 Esc 同一條路", async () => {
    const project = deck("關閉鈕");
    await presentAtSecondSlide("關閉鈕", project);

    fireEvent.click(screen.getByLabelText("離開簡報模式"));

    await waitFor(() => expect(stage()).toBeNull());
    expect(selectedThumbnailIndex()).toBe(1);
  });

  it("以瀏覽器原生方式離開全螢幕（F11）同樣同步選取", async () => {
    const project = deck("原生離開全螢幕");
    // 進場會呼叫 requestFullscreen；jsdom 沒有實作，補一個並讓 fullscreenElement 可控。
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = document.documentElement;
      }),
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    await presentAtSecondSlide("原生離開全螢幕", project);

    fullscreenElement = null;
    fireEvent(document, new Event("fullscreenchange"));

    await waitFor(() => expect(stage()).toBeNull());
    expect(selectedThumbnailIndex()).toBe(1);
  });

  it("放映中那一頁被刪掉：簡報模式整個結束，不留下隱形狀態，選取也不被改寫", async () => {
    const project = deck("放映中刪頁");
    const state = { project };
    stubApi(state);
    render(<Editor />);
    fireEvent.click(await screen.findByText("放映中刪頁"));
    await screen.findByText("▶ 簡報模式");
    // 明確選取第二頁：`selectedId` 一直是 undefined 的話，這則測試分不出
    // 「守住了原本的選取」與「本來就沒有選取」。
    const secondSlidePurpose = project.slides[1]!.purpose;
    fireEvent.click(thumbnails()[1]!);
    expect(await screen.findByDisplayValue(secondSlidePurpose)).toBeTruthy();

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("3 / 3")).toBeTruthy();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    // 縮圖列在簡報覆蓋層底下仍在 DOM 裡（別的分頁刪頁經輪詢回來也是同一個狀態轉換）。
    // 刪掉正在放映的末頁 → presentationIndex 越界，`project.slides[index]` 是 undefined。
    fireEvent.click(thumbnails()[2]!.querySelector<HTMLButtonElement>("[title='刪除頁面']")!);
    await waitFor(() => expect(state.project.slides.length).toBe(2));
    await waitFor(() => expect(thumbnails().length).toBe(2));

    // 覆蓋層自己就消失了——**不按 Escape**。這一則刻意不含 Escape：覆蓋層在刪頁當下就
    // unmount，先按再斷言 `stage()` 是空洞的（按之前就已經是 null）。
    await waitFor(() => expect(stage()).toBeNull());
    // 清除發生在 effect 裡，而 `waitFor` 期間 RTL 會關掉 act 環境——覆蓋層從 DOM 消失
    // （commit 完成）不代表那一輪的 passive effect 已經沖掉。不先沖乾淨就敲鍵盤，這一則
    // 會隨機測到「effect 還沒跑」而不是行為本身（實測在整包測試的負載下必現）。
    await act(async () => undefined);

    // 真正要釘的是「`presentationIndex` 也被清掉了」。沒清的話會留下隱形簡報模式：
    // 覆蓋層與關閉鈕都不在，但方向鍵仍落進簡報分支，`nextVisibleIndex(slides, 2, -1)`
    // 把覆蓋層叫回第 2 頁（而畫布的 Delete／⌘Z 全程靜默失效）。
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.queryByLabelText("離開簡報模式")).toBeNull());
    expect(stage()).toBeNull();

    // 清狀態是「純清」：不走 exitPresentation()，所以選取原封不動留在使用者選的第二頁。
    // 若改成呼叫 exitPresentation()，那個越界 index 換不出頁面，選取行為只會更難預測。
    expect(selectedThumbnailIndex()).toBe(1);
    expect(await screen.findByDisplayValue(secondSlidePurpose)).toBeTruthy();

    // 隱形狀態解除後，畫布快捷鍵回來了：↓ 換到下一頁而不是被簡報分支吃掉。
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(selectedThumbnailIndex()).toBe(1));
    expect(stage()).toBeNull();
  });
});

describe("離開專案就結束放映（exitPresentation 以外的第四、第五條路徑）", () => {
  /**
   * `presentationIndex` 是頂層狀態，不隨專案卸載；`exitPresentation()` 只覆蓋「使用者主動
   * 結束這場放映」的三條路。回專案列表與換專案是另外兩條，各自純清狀態。
   */
  it("按瀏覽器上一頁回專案列表、再點回同一個專案，不會彈回原本放映的那一頁", async () => {
    const project = deck("上一頁回列表");
    await presentAtSecondSlide("上一頁回列表", project);

    // 瀏覽器上一頁：keydown handler 遇 metaKey／altKey 直接 return，導航照常發生。
    window.history.pushState({}, "", "/");
    fireEvent.popState(window);

    // 回到專案列表：`route === "/"` 直接 early-return，覆蓋層跟著整棵樹被換掉。
    const card = await screen.findByLabelText("開啟 上一頁回列表");
    expect(stage()).toBeNull();

    fireEvent.click(card);

    // 再次進入同一個專案：`found.id !== project?.id` 為 false，沒有任何東西被重設——
    // 少了清除，殘留的 presentationIndex 會讓簡報覆蓋層直接彈回第 2 頁。
    await screen.findByText("▶ 簡報模式");
    await waitFor(() => expect(stage()).toBeNull());
  });

  it("換到別的專案不會以簡報模式開場，也不會用舊專案的 index 污染新專案的選取", async () => {
    const project = deck("換專案來源");
    const other = deck("換專案目的地");
    const state = { project };
    stubApi(state, [other]);
    render(<Editor />);
    fireEvent.click(await screen.findByText("換專案來源"));
    await screen.findByText("▶ 簡報模式");
    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "End" });
    // 停在末頁（index 2）：換到 B 之後若沒清掉，B 會以簡報模式開在 B.slides[2]，
    // 而且退出時還會把 B 的選取改寫成第 3 頁。
    expect(await screen.findByText("3 / 3")).toBeTruthy();

    window.history.pushState({}, "", "/");
    fireEvent.popState(window);
    fireEvent.click(await screen.findByLabelText("開啟 換專案目的地"));

    await screen.findByText("▶ 簡報模式");
    await waitFor(() => expect(stage()).toBeNull());
    expect(selectedThumbnailIndex()).toBe(0);
    expect(await screen.findByDisplayValue(other.slides[0]!.purpose)).toBeTruthy();
  });
});

describe("隱藏頁在場時，退出選的仍是放映中那一頁本身", () => {
  /**
   * `presentationIndex` 是**整份 slides 的索引**，縮圖列也列出全部頁面；一旦哪天有人
   * 拿「第幾張可見頁」去換算選取，這裡會是唯一會紅的地方——沒有隱藏頁時兩種算法
   * 得到同一個數字，前面那組測試分不出來。
   */
  it("跳過隱藏頁換到第 3 張（可見的第 2 張）後退出，選取落在縮圖列第 3 格", async () => {
    // slides[1] 隱藏：進場在 0，ArrowRight 跳過 1 直接到 2。
    const project = deck("隱藏頁退出", 4, [1]);
    const state = { project };
    stubApi(state);
    render(<Editor />);
    fireEvent.click(await screen.findByText("隱藏頁退出"));
    await screen.findByText("▶ 簡報模式");
    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    // 控制列數的是可見頁：3 張可見，起點是可見的第 1 張。
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(stage()).toBeNull());
    // 可見序是 2，但整份 slides 的索引是 2 也一樣——所以再驗一次 purpose，
    // 確認選中的是 slides[2] 這個物件而不是碰巧同號。
    expect(selectedThumbnailIndex()).toBe(2);
    expect(await screen.findByDisplayValue(project.slides[2]!.purpose)).toBeTruthy();
  });

  it("End 跳到最後一張可見頁後退出：選取是那一張，不是被隱藏的末頁", async () => {
    // 末頁 slides[3] 隱藏：End 應落在 slides[2]，退出後選取也必須是它。
    const project = deck("隱藏末頁退出", 4, [3]);
    const state = { project };
    stubApi(state);
    render(<Editor />);
    fireEvent.click(await screen.findByText("隱藏末頁退出"));
    await screen.findByText("▶ 簡報模式");
    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "End" });
    expect(await screen.findByText("3 / 3")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("離開簡報模式"));

    await waitFor(() => expect(stage()).toBeNull());
    expect(selectedThumbnailIndex()).toBe(2);
    expect(await screen.findByDisplayValue(project.slides[2]!.purpose)).toBeTruthy();
  });
});

describe("退出時同步選取的副作用：重新進場從離開的那一頁開始", () => {
  /**
   * 這是需求 1 真正被使用者感覺到的地方（`Editor.test.tsx` 的滾輪那則順帶改了進場落點，
   * 但那則釘的是手勢冷卻）。進場落點由 `startPresentation` 讀 `selected` 決定，所以
   * 「退出同步選取」與「重新進場的落點」是同一件事的兩面，必須一起釘。
   */
  it("放映到第 2 頁退出，再按一次簡報模式是從第 2 頁開始", async () => {
    const project = deck("重新進場");
    await presentAtSecondSlide("重新進場", project);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(stage()).toBeNull());

    fireEvent.click(screen.getByText("▶ 簡報模式"));

    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("離開後那一頁被隱藏，重新進場落到最近的可見頁而不是黑幕", async () => {
    const project = deck("離開後被隱藏");
    await presentAtSecondSlide("離開後被隱藏", project);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(stage()).toBeNull());
    expect(selectedThumbnailIndex()).toBe(1);

    // 把剛剛放映到、現在被選取的那一頁隱藏起來。
    fireEvent.click(screen.getAllByLabelText("隱藏此頁")[1]!);
    await waitFor(() => expect(thumbnails()[1]!.className).toContain("hidden-slide"));

    fireEvent.click(screen.getByText("▶ 簡報模式"));

    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    // firstPresentableIndex 先往後找：落在 slides[2]，也就是 2 張可見頁裡的第 2 張。
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });
});

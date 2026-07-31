// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";

/**
 * 簡報模式的**邊界**與**跨端頁碼**，補在 `HiddenSlides.test.tsx` 之外：
 * 那一份釘的是「四條換頁路徑會跳過隱藏頁」，這一份釘的是「到了邊界要停在哪、按鈕該不該
 * 灰掉」以及「放映中隱藏狀態變了，換頁還認得新的可見頁清單嗎」。
 *
 * 後者是滾輪那條路獨有的失效模式：鍵盤／點擊／控制列都在 render 期間重新算，滾輪的
 * listener 卻是掛在 effect 裡的閉包，`slides` 是掛載當下那一份。少了 `presentationHiddenKey`
 * 這個依賴，滾輪會拿著過期的可見頁清單換頁——mutation 測試證實這一條原本沒有任何測試會紅。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function hiddenDeck(topic: string, hiddenOrders: number[] = [], count = 4) {
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
const prevDisabled = () => screen.getByLabelText("上一頁").hasAttribute("disabled");
const nextDisabled = () => screen.getByLabelText("下一頁").hasAttribute("disabled");
const stageAlt = () =>
  document.querySelector<HTMLImageElement>(".presentation-stage img")?.getAttribute("alt");

async function present(topic: string, project: PresentationProject, selectIndex?: number) {
  const state = { project };
  const fetchMock = stubApi(state);
  await enter(topic);
  if (selectIndex !== undefined) {
    fireEvent.click(thumbnails()[selectIndex]!);
    expect(await screen.findByDisplayValue(project.slides[selectIndex]!.purpose)).toBeTruthy();
  }
  fireEvent.click(screen.getByText("▶ 簡報模式"));
  expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
  return { state, fetchMock };
}

describe("簡報模式的邊界", () => {
  it("只剩一張可見頁：上一頁與下一頁都灰掉，任何換頁路徑都停在原地", async () => {
    await present("只剩一張", hiddenDeck("只剩一張", [0, 2, 3]));

    expect(screen.getByText("1 / 1")).toBeTruthy();
    expect(prevDisabled()).toBe(true);
    expect(nextDisabled()).toBe(true);

    // 四條路徑都不該把它推離這一頁（尤其不該掉進隱藏頁）。
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "End" });
    fireEvent.keyDown(window, { key: "Home" });
    fireEvent.wheel(window, { deltaY: 200 });
    fireEvent.click(screen.getByRole("dialog", { name: "全螢幕簡報" }));
    expect(await screen.findByText("1 / 1")).toBeTruthy();
    expect(stageAlt()).toBe("簡報第 1 頁");
  });

  it("首頁被隱藏：從未選取狀態進場落在第一張可見頁，上一頁灰掉", async () => {
    await present("首頁隱藏", hiddenDeck("首頁隱藏", [0]));

    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(prevDisabled()).toBe(true);
    expect(nextDisabled()).toBe(false);
    // 往前不會退回被隱藏的封面。
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(await screen.findByText("1 / 3")).toBeTruthy();
  });

  it("末頁被隱藏：End 停在最後一張可見頁，下一頁灰掉", async () => {
    await present("末頁隱藏", hiddenDeck("末頁隱藏", [3]));

    fireEvent.keyDown(window, { key: "End" });
    expect(await screen.findByText("3 / 3")).toBeTruthy();
    expect(nextDisabled()).toBe(true);
    // 點舞台前進也不會掉進被隱藏的末頁。
    fireEvent.click(screen.getByRole("dialog", { name: "全螢幕簡報" }));
    expect(await screen.findByText("3 / 3")).toBeTruthy();
  });

  it("連續多張隱藏：一次跳過整段，不是一格一格停在隱藏頁上", async () => {
    // 六頁，中間三頁連續隱藏。
    await present("連續隱藏", hiddenDeck("連續隱藏", [1, 2, 3], 6));

    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "PageDown" });
    // 直接落在 order 4（可見序第 2 頁），不是 order 1。
    expect(await screen.findByText("2 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(await screen.findByText("1 / 3")).toBeTruthy();
  });

  it("空白鍵與 PageDown／PageUp 同樣跳過隱藏頁", async () => {
    await present("空白鍵", hiddenDeck("空白鍵", [1, 2]));

    fireEvent.keyDown(window, { key: " " });
    expect(await screen.findByText("2 / 2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(await screen.findByText("1 / 2")).toBeTruthy();
  });

  it("最後一張可見頁在中間時，End 不會停在它後面的隱藏頁", async () => {
    // 五頁，最後兩頁都隱藏 → 最後一張可見頁是 order 2。
    await present("末兩頁隱藏", hiddenDeck("末兩頁隱藏", [3, 4], 5));

    fireEvent.keyDown(window, { key: "End" });
    expect(await screen.findByText("3 / 3")).toBeTruthy();
    expect(nextDisabled()).toBe(true);
    expect(stageAlt()).toBe("簡報第 3 頁");
  });

  it("選取的隱藏頁後面沒有可見頁時，進場往前落到最後一張可見頁", async () => {
    // 四頁，後三頁隱藏；選在 order 3 → 只能往前落到 order 0。
    await present("往前落點", hiddenDeck("往前落點", [1, 2, 3]), 3);

    expect(screen.getByText("1 / 1")).toBeTruthy();
    expect(prevDisabled()).toBe(true);
    expect(nextDisabled()).toBe(true);
  });
});

describe("放映途中隱藏狀態改變", () => {
  it("滾輪換頁認得**當下**的可見頁清單，而不是進場那一刻的那一份", async () => {
    // 進場時四頁全可見，停在 order 0。放映中把 order 1 隱藏起來（縮圖列仍在 DOM 裡，
    // 使用者確實按得到；別的分頁改動經輪詢回來也是同一個狀態轉換）。
    const { state } = await present("放映中改隱藏", hiddenDeck("放映中改隱藏"));
    expect(screen.getByText("1 / 4")).toBeTruthy();

    fireEvent.click(screen.getAllByLabelText("隱藏此頁")[1]!);
    await waitFor(() => expect(thumbnails()[1]!.className).toContain("hidden-slide"));
    expect(state.project.slides[1]!.hidden).toBe(true);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());

    // 滾輪往下：必須跳過剛剛被隱藏的 order 1，落在 order 2＝可見序第 2 頁。
    // listener 若還握著進場時那份全可見的 slides，會停在 order 1（畫面顯示仍是「1 / 3」）。
    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();
    expect(stageAlt()).toBe("簡報第 2 頁");
  });

  it("取消隱藏後那一頁又回到放映序列裡", async () => {
    const { state } = await present("放映中取消隱藏", hiddenDeck("放映中取消隱藏", [1]));
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("取消隱藏此頁"));
    await waitFor(() => expect(thumbnails()[1]!.className).not.toContain("hidden-slide"));
    expect(state.project.slides[1]!.hidden).toBe(false);
    await waitFor(() => expect(screen.getByText("1 / 4")).toBeTruthy());

    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 4")).toBeTruthy();
  });
});

describe("跨端一致：編輯畫布與簡報模式的頁碼與伺服器算的是同一組", () => {
  /**
   * 與 `apps/server/test/hidden-slides-cross-end.test.ts` 用的是同一份組態
   * （5 頁、隱藏 order 2、`number-total`），期望值也刻意寫成同一組字串：
   * `1 / 4`、`2 / 4`、（無）、`3 / 4`、`4 / 4`。兩邊任一端漂掉都會有一邊紅。
   */
  const EXPECTED = ["1 / 4", "2 / 4", null, "3 / 4", "4 / 4"];

  it("編輯畫布：逐頁點過去，頁碼與伺服器端相同", async () => {
    const project = hiddenDeck("畫布跨端", [2], 5);
    project.pageNumber = {
      ...project.pageNumber,
      enabled: true,
      skipFirstSlide: false,
      format: "number-total",
    };
    const state = { project };
    stubApi(state);
    await enter("畫布跨端");

    for (const [index, expected] of EXPECTED.entries()) {
      fireEvent.click(thumbnails()[index]!);
      await waitFor(() =>
        expect(document.querySelector(".page-number-text")?.textContent ?? null).toBe(expected),
      );
    }
  });

  it("簡報模式：放映到的每一頁，頁碼與伺服器端相同", async () => {
    const project = hiddenDeck("簡報跨端", [2], 5);
    project.pageNumber = {
      ...project.pageNumber,
      enabled: true,
      skipFirstSlide: false,
      format: "number-total",
    };
    await present("簡報跨端", project);

    const visible = EXPECTED.filter((label): label is string => label !== null);
    for (const [step, expected] of visible.entries()) {
      await waitFor(() =>
        expect(document.querySelector(".presentation-stage .page-number-text")?.textContent).toBe(
          expected,
        ),
      );
      if (step < visible.length - 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    }
    // 放映序列裡沒有隱藏頁，所以「3 / 4」是第三次看到的、不是第四次。
    expect(nextDisabled()).toBe(true);
  });
});

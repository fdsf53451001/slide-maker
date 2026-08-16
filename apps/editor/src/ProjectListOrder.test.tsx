// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";

/**
 * 主畫面「最近簡報」的順序永遠是 `updatedAt` 由新到舊，與卡片上印的最後修改時間一致。
 *
 * 清單只在開頁時抓那一次，之後都靠編輯器的本機狀態維護，所以「專案物件換了」與「專案真的
 * 被改過」必須分得開——舊版是「只要 `project` 這個狀態換了物件就 unshift 到最前面」，於是
 * **點進去看一眼**（甚至只是輪詢回一份一模一樣的專案）也會把它推到最上面，而同一張卡片上
 * 的時間還是舊的，重新整理後順序又跳回去。
 *
 * 三則各釘一種來源：開啟（使用者的動作）、輪詢（背景的動作）、真的寫入（唯一該換位置的）。
 * 前兩則就是把 `Editor.tsx` 改回 unshift 會變紅的那兩則。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // 每一則都會 pushState 到 `/projects/…` 再回 `/`；jsdom 的 window 整個檔案共用，
  // 不歸零會讓下一則以專案路由當起點、直接跳過主畫面。
  window.history.replaceState({}, "", "/");
});

/** 卡片上的時間就是這一行；與 `CreateProject.tsx` 同一個格式化方式。 */
const displayTime = (iso: string) => new Date(iso).toLocaleString("zh-TW");

function deck(topic: string, updatedAt: string, count = 3) {
  const project = createProject({ topic, brief: { desiredSlideCount: count } });
  project.workflowStage = "editing";
  project.updatedAt = updatedAt;
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
        createdAt: updatedAt,
      },
    ];
    slide.currentVersionId = `${slide.id}-v1`;
  }
  return project;
}

/**
 * `state.projects` 就是伺服器上那一份，**已照 `updatedAt` 由新到舊排好**（`listProjects()`
 * 的行為）。PATCH 會照真實伺服器的樣子推進 `updatedAt` 並重排，前端只是收到新的那一份。
 */
function stubApi(state: { projects: PresentationProject[]; patchedUpdatedAt?: string }) {
  const find = (id: string) => state.projects.find((project) => project.id === id);
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    if (path === "/api/projects" && (init?.method ?? "GET") === "GET")
      return Response.json(state.projects);
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
    const slideMatch = /^\/api\/projects\/([^/]+)\/slides\/([^/]+)$/.exec(path);
    if (slideMatch && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      const target = find(slideMatch[1]!)!;
      const updated: PresentationProject = {
        ...target,
        // 真的有寫入 → 伺服器換掉 `updatedAt`，這才是該讓卡片換位置的事件。
        updatedAt: state.patchedUpdatedAt ?? target.updatedAt,
        slides: target.slides.map((slide) =>
          slide.id === slideMatch[2] ? { ...slide, ...patch } : slide,
        ),
      };
      state.projects = state.projects
        .map((project) => (project.id === updated.id ? updated : project))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return Response.json(updated);
    }
    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (projectMatch && (init?.method ?? "GET") === "GET")
      return Response.json(find(projectMatch[1]!) ?? {});
    return Response.json(state.projects[0]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 主畫面上每張卡片的名稱，由上而下。 */
const cardNames = () =>
  screen
    .getAllByRole("button", { name: /^開啟 / })
    .map((node) => node.getAttribute("aria-label")!.replace(/^開啟 /, ""));

/** 同一批卡片上印的「N 頁 · 最後修改時間」，順序與 `cardNames()` 一致。 */
const cardCaptions = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".project-card-info small")).map(
    (node) => node.textContent ?? "",
  );

/** 回主畫面：keydown handler 不吃瀏覽器上一頁，`popstate` 讓 Editor 換回 `/` 路由。 */
function goHome() {
  window.history.pushState({}, "", "/");
  fireEvent.popState(window);
}

const NEWER = "2026-08-16T10:00:00.000Z";
const OLDER = "2026-08-15T09:00:00.000Z";
const NEWEST = "2026-08-17T11:30:00.000Z";

describe("最近簡報的順序只跟著 updatedAt 走", () => {
  it("點進舊專案看一眼再回主畫面，它仍留在原本的位置", async () => {
    // 伺服器排好的順序是「較新的專案」在前；被開啟的是**第二張**卡片，
    // 舊版的 unshift 會把它推到第一張——這一則正是那個 regression 的守門測試。
    const state = {
      projects: [deck("較新的專案", NEWER), deck("較舊的專案", OLDER)],
    };
    stubApi(state);
    render(<Editor />);

    expect(await screen.findByLabelText("開啟 較舊的專案")).toBeTruthy();
    expect(cardNames()).toEqual(["較新的專案", "較舊的專案"]);

    fireEvent.click(screen.getByLabelText("開啟 較舊的專案"));
    // 真的進到編輯器了（不是點了個沒反應的按鈕），這一則才有意義。
    expect(await screen.findByText("▶ 簡報模式")).toBeTruthy();

    goHome();

    await screen.findByLabelText("開啟 較舊的專案");
    expect(cardNames()).toEqual(["較新的專案", "較舊的專案"]);
    // 就地換掉那一筆而不是補一張：prepend 少了 dedupe 會讓同一份專案出現兩次。
    expect(cardNames()).toHaveLength(2);
    // 順序與卡片上印的時間一致——這才是使用者看得到的那個矛盾（置頂了、時間卻是舊的）。
    expect(displayTime(NEWER)).not.toBe(displayTime(OLDER));
    expect(cardCaptions()).toEqual([
      expect.stringContaining(displayTime(NEWER)),
      expect.stringContaining(displayTime(OLDER)),
    ]);
  });

  it("背景輪詢回一份內容一樣的專案，順序同樣不動", async () => {
    // 開著生成中的專案時每 700 毫秒就換一次 `project` 物件；`updatedAt` 一個字都沒變，
    // 所以清單不該有任何動靜。舊版是「每輪詢一次就再 unshift 一次」。
    const older = deck("較舊的專案", OLDER);
    older.jobs = [
      {
        id: "job-1",
        projectId: older.id,
        slideId: older.slides[0]!.id,
        providerId: "mock-image",
        status: "running",
        operation: "generate",
        attempt: 0,
        createdAt: OLDER,
        updatedAt: OLDER,
      },
    ];
    const state = { projects: [deck("較新的專案", NEWER), older] };
    const fetchMock = stubApi(state);
    render(<Editor />);

    fireEvent.click(await screen.findByLabelText("開啟 較舊的專案"));
    await screen.findByText("▶ 簡報模式");

    // 等到輪詢真的打了兩次（第一次就把 `project` 換成另一個物件，第二次證明它會一直來）。
    const polls = () =>
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url) === `/api/projects/${older.id}` &&
          ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
      ).length;
    await waitFor(() => expect(polls()).toBeGreaterThanOrEqual(2), { timeout: 4_000 });

    goHome();

    await screen.findByLabelText("開啟 較舊的專案");
    expect(cardNames()).toEqual(["較新的專案", "較舊的專案"]);
    expect(cardCaptions()).toEqual([
      expect.stringContaining(displayTime(NEWER)),
      expect.stringContaining(displayTime(OLDER)),
    ]);
  });

  it("真的改了東西（伺服器回一份較新的 updatedAt）之後，那一份排到最上面", async () => {
    const state = {
      projects: [deck("較新的專案", NEWER), deck("較舊的專案", OLDER)],
      patchedUpdatedAt: NEWEST,
    };
    stubApi(state);
    render(<Editor />);

    fireEvent.click(await screen.findByLabelText("開啟 較舊的專案"));
    await screen.findByText("▶ 簡報模式");

    // 隱藏一頁：最短的一條真實寫入路徑（PATCH slide → 伺服器回整份專案）。
    fireEvent.click((await screen.findAllByLabelText("隱藏此頁"))[0]!);
    await screen.findByLabelText("取消隱藏此頁");

    goHome();

    await screen.findByLabelText("開啟 較舊的專案");
    expect(cardNames()).toEqual(["較舊的專案", "較新的專案"]);
    // 置頂的那一張帶著新的時間戳，不是「置頂了但時間還是舊的」。
    expect(cardCaptions()).toEqual([
      expect.stringContaining(displayTime(NEWEST)),
      expect.stringContaining(displayTime(NEWER)),
    ]);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** `withImage` 為 false 的頁面沒有目前版本——單頁 PNG 沒有位元組可輸出。 */
function deck(topic: string, withImage: boolean[]) {
  const project = createProject({ topic, brief: { desiredSlideCount: withImage.length } });
  project.workflowStage = "editing";
  const now = new Date().toISOString();
  for (const slide of project.slides) {
    if (!withImage[slide.order]) continue;
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
      return Response.json(state.project);
    }),
  );
}

async function openExport() {
  // 「匯出」在頁面上不只一處，限定在 inspector 分頁列裡取。
  const tabs = document.querySelector<HTMLElement>(".inspector-tabs")!;
  fireEvent.click(within(tabs).getByText("匯出"));
  await screen.findByText("當前頁面");
}

async function enter(topic: string) {
  render(<Editor />);
  fireEvent.click(await screen.findByText(topic));
  await screen.findByText("▶ 簡報模式");
  await openExport();
}

const groupTitles = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".export-panel .export-group h3")).map(
    (heading) => heading.textContent ?? "",
  );

/** 某一區裡的下載連結；分組的意義就在於「這個連結屬於哪個作用範圍」。 */
function groupLinks(title: string) {
  const group = Array.from(
    document.querySelectorAll<HTMLElement>(".export-panel .export-group"),
  ).find((section) => section.querySelector("h3")?.textContent?.startsWith(title))!;
  return Array.from(group.querySelectorAll<HTMLAnchorElement>("a")).map((anchor) => ({
    text: anchor.textContent,
    href: anchor.getAttribute("href"),
  }));
}

describe("匯出面板分成「專案」與「當前頁面」兩區", () => {
  it("四個專案級下載全部收在「專案」區，單頁 PNG 獨立在「當前頁面」區", async () => {
    const state = { project: deck("匯出分區", [true, true, true]) };
    stubApi(state);
    await enter("匯出分區");

    expect(groupTitles()[0]).toBe("專案");
    expect(groupTitles()[1]).toContain("當前頁面");
    // 作用範圍不同的下載不能混在一起：四個專案級連結長得一模一樣，沒有分區時使用者
    // 無從得知新增的那一個只匯出一頁。
    expect(groupLinks("專案").map((link) => link.href)).toEqual([
      `/api/projects/${state.project.id}/export/pptx`,
      `/api/projects/${state.project.id}/export/pdf`,
      `/api/projects/${state.project.id}/export/png.zip`,
      `/api/projects/${state.project.id}/export/slide-project`,
    ]);
    expect(groupLinks("當前頁面")).toEqual([
      {
        text: "下載此頁 PNG (.png)",
        href: `/api/projects/${state.project.id}/slides/${state.project.slides[0]!.id}/export/png`,
      },
    ]);
  });

  it("換頁之後單頁連結跟著換，區標題也報出是第幾頁", async () => {
    const state = { project: deck("換頁跟著換", [true, true, true]) };
    stubApi(state);
    await enter("換頁跟著換");
    expect(groupTitles()[1]).toContain("第 1 頁");

    // 點縮圖會把 inspector 切回「頁面」分頁（既有行為），所以要再回到匯出。
    fireEvent.click(document.querySelectorAll<HTMLElement>(".thumbnail")[2]!);
    await openExport();

    await waitFor(() => expect(groupTitles()[1]).toContain("第 3 頁"));
    expect(groupLinks("當前頁面")[0]!.href).toBe(
      `/api/projects/${state.project.id}/slides/${state.project.slides[2]!.id}/export/png`,
    );
  });

  it("這一頁還沒有圖片時整個不給連結，改成就地說明", async () => {
    // 伺服器會回 400 `EXPORT_SLIDE_IMAGE_MISSING`，而下載是裸 `<a href>`：按得下去
    // 等於把一段 JSON 丟進瀏覽器分頁。
    const state = { project: deck("尚未生成", [false, true]) };
    stubApi(state);
    await enter("尚未生成");

    expect(groupLinks("當前頁面")).toEqual([]);
    const blocked = Array.from(
      document.querySelectorAll<HTMLElement>(".export-panel .export-blocked"),
    );
    expect(blocked.map((node) => node.textContent).join("")).toContain("這一頁還沒有圖片");
    // 專案級的四個不受影響：整份匯出對「缺圖的可見頁」另有自己的錯誤路徑。
    expect(groupLinks("專案")).toHaveLength(4);
  });
});

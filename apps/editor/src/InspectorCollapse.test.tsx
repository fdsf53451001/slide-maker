// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";

/**
 * 側邊欄收納鈕。jsdom 不套用外部樣式表，所以量不到真實寬度——能釘住的是**驅動版面的
 * 那個開關**：`.shell` 上的 `inspector-collapsed` class（`styles.css` 靠它把 inspector
 * 軌道縮成 30px、把面板內容 `display: none`）。
 *
 * 另外釘住兩個容易被「簡化」掉的決定：
 * ① 收合鈕與還原鈕是同一顆，收起來之後它必須還在（否則側邊欄再也回不來）；
 * ② 面板內容是被 CSS 藏起來、不是在 JSX 卸載——未存檔的大綱草稿要能撐過一次收合。
 */

afterEach(() => {
  cleanup();
  resetSystemSettings();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

function editableProject(topic: string) {
  const project = createProject({ topic, brief: { desiredSlideCount: 1 } });
  project.workflowStage = "editing";
  return project;
}

function stubApi(project: PresentationProject) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://local.test").pathname;
    if (path === "/api/projects") return Response.json([project]);
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
    return Response.json(project);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const shell = () => document.querySelector<HTMLElement>(".shell");
const tabs = () => document.querySelector<HTMLElement>(".inspector-tabs");
const collapsed = () => !!shell()?.classList.contains("inspector-collapsed");

async function enter(topic: string) {
  stubApi(editableProject(topic));
  render(<Editor />);
  fireEvent.click(await screen.findByText(topic));
  await waitFor(() => expect(tabs()).not.toBeNull());
}

describe("側邊欄收納鈕", () => {
  it("就掛在「匯出」旁邊，是分頁列的最後一顆", async () => {
    await enter("收納鈕位置");

    const buttons = [...tabs()!.querySelectorAll("button")];
    const toggle = tabs()!.querySelector<HTMLButtonElement>(".inspector-collapse")!;
    expect(toggle).toBeTruthy();
    expect(buttons.at(-1)).toBe(toggle);
    expect(buttons.at(-2)!.textContent).toBe("匯出");
  });

  it("預設是展開的：沒有 inspector-collapsed，按鈕標示為收起", async () => {
    await enter("收納鈕預設展開");

    expect(collapsed()).toBe(false);
    expect(screen.getByLabelText("收起側邊欄")).toBeTruthy();
    expect(screen.getByLabelText("收起側邊欄").getAttribute("aria-expanded")).toBe("true");
  });

  it("按一下收起、再按一下還原（同一顆按鈕，收起後仍在）", async () => {
    await enter("收納鈕來回切換");

    fireEvent.click(screen.getByLabelText("收起側邊欄"));

    await waitFor(() => expect(collapsed()).toBe(true));
    // 收起後側邊欄只剩這顆按鈕看得見，它同時就是還原鈕。
    const restore = screen.getByLabelText("展開側邊欄");
    expect(restore.getAttribute("aria-expanded")).toBe("false");
    expect(restore.textContent).toBe("‹");

    fireEvent.click(restore);

    await waitFor(() => expect(collapsed()).toBe(false));
    expect(screen.getByLabelText("收起側邊欄").textContent).toBe("›");
  });

  it("收合不卸載面板：未存檔的大綱草稿撐得過一次收合再展開", async () => {
    await enter("收合保留草稿");

    const contentField = screen.getByText("內容").closest("label")!.querySelector("textarea")!;
    fireEvent.change(contentField, { target: { value: "還沒存檔的草稿" } });

    fireEvent.click(screen.getByLabelText("收起側邊欄"));
    await waitFor(() => expect(collapsed()).toBe(true));
    // 藏起來歸藏起來，DOM 節點與值都必須還在——這是選 CSS 而不是條件渲染的理由。
    expect(screen.getByText("內容").closest("label")!.querySelector("textarea")!.value).toBe(
      "還沒存檔的草稿",
    );

    fireEvent.click(screen.getByLabelText("展開側邊欄"));
    await waitFor(() => expect(collapsed()).toBe(false));
    expect(screen.getByText("內容").closest("label")!.querySelector("textarea")!.value).toBe(
      "還沒存檔的草稿",
    );
  });

  it("來源對話框不在被藏起來的子樹裡：收合鈕在它背後，按下去不得讓它消失", async () => {
    await enter("對話框不受收合影響");

    fireEvent.click(screen.getByRole("button", { name: /^來源 \d+$/ }));
    fireEvent.click(await screen.findByText(/貼上網址/));
    const dialog = await screen.findByRole("dialog", { name: "貼上網址" });
    // 對話框 portal 到 body：留在 `.inspector` 裡的話，收合的 `display: none`
    // 會連同 `position: fixed` 的它一起藏掉（祖先 none 蓋過後代的 fixed）。
    expect(dialog.closest(".inspector")).toBeNull();

    fireEvent.click(screen.getByLabelText("收起側邊欄"));

    await waitFor(() => expect(collapsed()).toBe(true));
    expect(screen.getByRole("dialog", { name: "貼上網址" })).toBe(dialog);
    expect(dialog.closest(".inspector")).toBeNull();
  });
});

// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { SourcePanel } from "./SourcePanel.js";
import { focusableWithin, useDialogA11y } from "./useDialogA11y.js";

/**
 * `useDialogA11y` 的兩個承諾：Tab 關在框內、關閉後焦點回到觸發它的那顆按鈕。
 *
 * 這兩件事沒有任何視覺表現，所以在畫面截圖、既有功能測試裡都不會露餡；而它們壞掉的
 * 後果是鍵盤與螢幕閱讀器使用者「走出去就回不來」——Tab 一路走進被 `aria-modal="true"`
 * 宣告為不存在的那片頁面，焦點環消失在遮罩底下。
 *
 * 先用一個最小 harness 釘住換行語意本身（邊界在哪、Shift 反向），再用兩個真的對話框
 * 確認它在實際的元件樹裡也接得上——只測 harness 的話，「忘了掛上 hook」不會被抓到。
 */

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

/** 三顆按鈕的對話框，外加一顆框外的按鈕當「trap 失效就會走到這裡」的證人。 */
function TrapHarness() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useDialogA11y(dialogRef, open);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        開啟
      </button>
      <button type="button">框外</button>
      {open && (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="測試對話框">
          <button type="button">第一</button>
          <button type="button">中間</button>
          <button type="button" onClick={() => setOpen(false)}>
            最後
          </button>
        </div>
      )}
    </div>
  );
}

describe("useDialogA11y 的 Tab 迴圈", () => {
  it("最後一個可聚焦元素按 Tab 回到第一個，第一個按 Shift+Tab 回到最後一個", () => {
    render(<TrapHarness />);
    fireEvent.click(screen.getByRole("button", { name: "開啟" }));

    const first = screen.getByRole("button", { name: "第一" });
    const last = screen.getByRole("button", { name: "最後" });
    // 進場焦點落在第一個可聚焦元素上。
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("焦點被搶到對話框外時，下一次 Tab 拉回邊界而不是從外面繼續走", () => {
    render(<TrapHarness />);
    fireEvent.click(screen.getByRole("button", { name: "開啟" }));

    // 別的程式碼（自動聚焦、瀏覽器還原）把焦點放到框外的情境。
    screen.getByRole("button", { name: "框外" }).focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "第一" }));

    screen.getByRole("button", { name: "框外" }).focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "最後" }));
  });

  it("關閉後焦點回到觸發它的按鈕，而不是掉回 <body>", () => {
    render(<TrapHarness />);
    const trigger = screen.getByRole("button", { name: "開啟" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "最後" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab 以外的鍵不被攔截（trap 只管 Tab）", () => {
    render(<TrapHarness />);
    fireEvent.click(screen.getByRole("button", { name: "開啟" }));
    const last = screen.getByRole("button", { name: "最後" });
    last.focus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(last);
  });
});

/* ---------- 真實對話框之一：Editor 的系統設定 ---------- */

function editableDeck(topic: string) {
  const project = createProject({ topic, brief: { desiredSlideCount: 2 } });
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

/*
  直接用 production 的那一份，不再自己重寫一份選擇器：舊版抄的字串漏了
  `inert`／`aria-hidden="true"`／`checkVisibility()` 三道過濾，於是「首／末可聚焦元素」在測試
  裡與 trap 眼中可能是不同的元素——改動 production 的選擇器時，這裡會靜默地比對到錯的元素而
  仍然全綠。同一個真相只能有一份。
*/
const focusableIn = focusableWithin;

describe("系統設定對話框的焦點契約", () => {
  it("Tab 在框內繞回去，Escape 關閉後焦點回到齒輪按鈕", async () => {
    const project = editableDeck("系統設定焦點");
    stubApi(project);
    render(<Editor />);
    fireEvent.click(await screen.findByText("系統設定焦點"));
    await screen.findByText("▶ 簡報模式");

    const trigger = screen.getByRole("button", { name: "系統設定" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "系統設定" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    const focusable = focusableIn(dialog);
    expect(focusable.length).toBeGreaterThan(1);
    focusable.at(-1)!.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "系統設定" })).toBeNull());
    // 掉回 <body> 的話，鍵盤使用者要從頁首重新 Tab 一次才回得到剛才那顆齒輪。
    expect(document.activeElement).toBe(trigger);
  });
});

/* ---------- 真實對話框之二：SourcePanel 的貼上網址 ---------- */

describe("貼上網址對話框的焦點契約", () => {
  it("Tab 繞回框內，取消之後焦點回到「＋ 貼上網址」", async () => {
    const project = createProject({ topic: "貼網址焦點", brief: { desiredSlideCount: 1 } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ project, failures: [] }, { status: 201 })),
    );
    render(<SourcePanel project={project} onProject={vi.fn()} onError={vi.fn()} />);

    const trigger = screen.getByText("＋ 貼上網址");
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "貼上網址" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // trap 掛在對話框容器（form）上，不是整片遮罩；用容器自己的可聚焦清單當真相。
    const container = dialog.querySelector<HTMLElement>("form") ?? dialog;
    const focusable = focusableIn(container);
    expect(focusable.length).toBeGreaterThan(1);
    focusable.at(-1)!.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "貼上網址" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

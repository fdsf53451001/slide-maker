// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createDefaultStyle,
  createProject,
  type EditableTextBox,
  type PresentationProject,
} from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";

/**
 * 兩項「把沒用的東西拿掉」的需求，各自的**兩個方向**都要釘住：拿掉的真的不見了，
 * 留下的還在。只斷言「不見了」的測試，會在整條狀態列或整個面板被誤刪時照樣綠。
 *
 * ①（需求 3）文字圖層狀態列只剩「N 個文字框」，快捷鍵說明整串移除，也不再掛與內文
 *    一字不差的 `title`。
 * ②（需求 4）沒有選取文字框時 `TEXT BOX` 區塊**整塊**不渲染——連標題都不留，而不是
 *    留一個空殼加一句「去選一個」。
 */

afterEach(() => {
  cleanup();
  resetSystemSettings();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

const makeBox = (overrides: Partial<EditableTextBox> = {}): EditableTextBox => ({
  id: "text-1",
  text: "原始文字",
  x: 100,
  y: 80,
  width: 300,
  height: 60,
  fontFamily: "Arial",
  fontSize: 40,
  fontWeight: 400,
  color: "#112233",
  opacity: 1,
  lineHeight: 1.2,
  letterSpacing: 0,
  align: "left",
  verticalAlign: "top",
  rotation: 0,
  confidence: 1,
  role: "presentation",
  ...overrides,
});

/** 一頁、`boxCount` 個文字框的可編輯文字層專案。 */
function textLayerProject(topic: string, boxCount = 1) {
  const project = createProject({ topic, brief: { desiredSlideCount: 1 } });
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
        textLayer: {
          originalVersionId: `${slide.id}-v0`,
          backgroundPath: `assets/generated/${slide.id}-clean.png`,
          compositePath: `assets/generated/${slide.id}-composite.png`,
          threshold: 0.75,
          renderRevision: 0,
          boxes: Array.from({ length: boxCount }, (_, index) =>
            makeBox({ id: `${slide.id}-text-${index}`, y: 80 + index * 100 }),
          ),
          extractedAt: now,
          updatedAt: now,
        },
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

const statusBar = () => document.querySelector<HTMLElement>(".text-layer-status");
const textProperties = () => document.querySelector<HTMLElement>(".text-properties");
const boxElements = () => [...document.querySelectorAll<HTMLElement>(".editable-text-box")];

async function enter(topic: string, project: PresentationProject) {
  stubApi(project);
  render(<Editor />);
  fireEvent.click(await screen.findByText(topic));
  await screen.findAllByLabelText("可編輯簡報文字");
}

describe("文字圖層狀態列只留框數", () => {
  it("內容一字不多：只有「N 個文字框」，沒有快捷鍵說明", async () => {
    const project = textLayerProject("狀態列框數", 2);
    await enter("狀態列框數", project);

    expect(statusBar()!.textContent).toBe("2 個文字框");
    // 逐項釘住被移除的那幾段：整串一起比對的話，只砍掉其中一段仍然會紅得莫名其妙。
    for (const removed of ["⌘/Ctrl+C", "⌘/Ctrl+V", "Delete", "單擊選取", "雙擊編輯文字", "·"])
      expect(statusBar()!.textContent).not.toContain(removed);
  });

  it("不再掛與內文一字不差的 title（多一次滑鼠停留卻什麼也沒多說）", async () => {
    const project = textLayerProject("狀態列沒有 title");
    await enter("狀態列沒有 title", project);

    expect(statusBar()!.getAttribute("title")).toBeNull();
  });

  it("框數跟著實際框數走，不是寫死的字串", async () => {
    const project = textLayerProject("狀態列跟著框數", 1);
    await enter("狀態列跟著框數", project);
    expect(statusBar()!.textContent).toBe("1 個文字框");

    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await waitFor(() => expect(statusBar()!.textContent).toBe("2 個文字框"));
  });
});

describe("沒選取文字框時 TEXT BOX 區塊整塊不渲染", () => {
  it("初次進頁沒有選取：連 TEXT BOX 標題都不出現", async () => {
    const project = textLayerProject("面板初始");
    await enter("面板初始", project);

    expect(textProperties()).toBeNull();
    expect(screen.queryByText("TEXT BOX")).toBeNull();
    // 舊版那句佔位提示連同區塊一起走了。
    expect(screen.queryByText("在畫布選擇一個文字框以調整格式。")).toBeNull();
  });

  it("選取後整塊出現，且欄位帶著那個框的值（不是空殼）", async () => {
    const project = textLayerProject("面板選取後出現");
    await enter("面板選取後出現", project);

    fireEvent.pointerDown(boxElements()[0]!);

    await waitFor(() => expect(textProperties()).not.toBeNull());
    expect(screen.getByText("TEXT BOX")).toBeTruthy();
    expect(screen.getByDisplayValue("Arial")).toBeTruthy();
    expect(screen.getByDisplayValue("40")).toBeTruthy();
  });

  it("取消選取（點畫布空白處）後整塊又收回去", async () => {
    const project = textLayerProject("面板取消選取");
    await enter("面板取消選取", project);
    fireEvent.pointerDown(boxElements()[0]!);
    await waitFor(() => expect(textProperties()).not.toBeNull());

    fireEvent.pointerDown(document.querySelector(".text-layer-canvas")!);

    await waitFor(() => expect(textProperties()).toBeNull());
    expect(screen.queryByText("TEXT BOX")).toBeNull();
  });

  it("刪掉選取中的最後一個文字框後不留下空的 TEXT BOX 區塊", async () => {
    const project = textLayerProject("刪掉最後一個框");
    await enter("刪掉最後一個框", project);
    fireEvent.pointerDown(boxElements()[0]!);
    await waitFor(() => expect(textProperties()).not.toBeNull());

    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(boxElements()).toHaveLength(0));
    // selectedTextId 指向已不存在的框時 `selectedText` 是 undefined——區塊必須跟著消失，
    // 不能因為「還有 selectedTextId」而留下一個所有欄位都讀不到值的殼。
    expect(textProperties()).toBeNull();
    expect(statusBar()!.textContent).toBe("0 個文字框");
  });
});

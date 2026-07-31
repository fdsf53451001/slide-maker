// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createProject,
  TEXT_STROKE_DEFAULT_COLOR,
  TEXT_STROKE_DEFAULT_OPACITY,
  TEXT_STROKE_DEFAULT_WIDTH_EM,
  TEXT_STROKE_MAX_WIDTH_EM,
  type EditableTextBox,
  type PresentationProject,
} from "@slide-maker/core";
import { Editor, TextLayerCanvas, strokeCssColor } from "./Editor.js";

/**
 * 文字描邊（編輯器端）。
 *
 * 描邊在這個專案裡有三個渲染端，這個檔負責 DOM 那一端與 inspector 的控制項；
 * 伺服器 SVG 與 PPTX 由 `apps/server/test/text-stroke.test.ts` 守。
 */

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

const firePointer = (element: Element, type: string, clientX: number, clientY: number) =>
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));

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
  color: "#ffffff",
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

const boxElements = () => [...document.querySelectorAll<HTMLElement>(".editable-text-box")];
const textareaOf = (index = 0) => boxElements()[index]!.querySelector("textarea")!;
/**
 * jsdom 對沒設定過的 `paintOrder` 回 `undefined`（它不是 CSSStyleDeclaration 的已知屬性），
 * 設定過之後又讀得到 camelCase 那個；兩種讀法都收，斷言比的是值本身。
 */
const paintOrderOf = (index = 0) => {
  const style = textareaOf(index).style;
  return style.paintOrder || style.getPropertyValue("paint-order") || "";
};

/**
 * 底色／描邊的參數收在各自那一列旁邊的下拉裡（勾選框本身一直看得到，不需要展開）。
 * 要碰色票、粗細、不透明度就得先打開那一顆——與使用者的操作順序相同。冪等。
 */
const openEffectPopover = (label: "底色" | "描邊") => {
  const trigger = screen.getByRole("button", { name: `${label}設定` });
  if (trigger.getAttribute("aria-expanded") === "false") fireEvent.click(trigger);
};

function renderCanvas(boxes: EditableTextBox[], selectedId?: string) {
  const onChange = vi.fn();
  render(
    <TextLayerCanvas
      background="/clean.png"
      boxes={boxes}
      canvasWidth={1920}
      canvasHeight={1080}
      selectedId={selectedId}
      onSelect={vi.fn()}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("strokeCssColor", () => {
  it("透明度吃進色值本身：-webkit-text-stroke-color 沒有對應的 -opacity 屬性", () => {
    expect(strokeCssColor({ color: "#ff8800", opacity: 0.7 })).toBe("rgba(255, 136, 0, 0.7)");
    expect(strokeCssColor({ color: "#000000", opacity: 1 })).toBe("rgba(0, 0, 0, 1)");
  });
});

describe("描邊在畫布 DOM 上的樣式", () => {
  it("沒有描邊時三個描邊相關的樣式一個都不寫（＝加入這個功能之前的輸出）", () => {
    renderCanvas([makeBox()]);
    const style = textareaOf().style;
    expect(style.getPropertyValue("-webkit-text-stroke-width")).toBe("");
    expect(style.getPropertyValue("-webkit-text-stroke-color")).toBe("");
    expect(paintOrderOf()).toBe("");
  });

  /*
   * `paint-order: stroke` 是這個功能唯一會「壞得很明顯」的地方：CSS 預設先填色再描邊，
   * 而描邊跨在字形輪廓上，少了它描邊會蓋掉字面。Chromium 實測純白字心像素 2691 → 6312
   * （不加／加），也就是不加的話字被吃掉一大半。jsdom 不做繪製，所以這裡只能釘住屬性
   * 有沒有寫出去——真正的像素證據在伺服器那組（同一個規則、同一個原因）。
   */
  it("有描邊時一定同時寫出 paint-order，否則描邊會蓋掉字面", () => {
    renderCanvas([makeBox({ strokeColor: "#000000", strokeWidth: 0.05, strokeOpacity: 1 })]);
    expect(paintOrderOf()).toBe("stroke");
  });

  it("線寬用 cqh 而不是裸 px：畫布靠容器查詢單位縮放，絕對 px 不會跟著走", () => {
    renderCanvas([makeBox({ fontSize: 40, strokeColor: "#000000", strokeWidth: 0.05 })]);
    // 40px × 0.05 = 2 畫布 px；1080 高的畫布上就是 (2 / 1080) × 100 cqh。
    expect(textareaOf().style.getPropertyValue("-webkit-text-stroke-width")).toBe(
      `${(2 / 1080) * 100}cqh`,
    );
  });

  it("描邊色帶著不透明度一起寫進 -webkit-text-stroke-color", () => {
    renderCanvas([makeBox({ strokeColor: "#ff0000", strokeWidth: 0.05, strokeOpacity: 0.4 })]);
    expect(textareaOf().style.getPropertyValue("-webkit-text-stroke-color")).toBe(
      "rgba(255, 0, 0, 0.4)",
    );
  });

  it("省略寬度與不透明度時落到共用預設值（與伺服器同一份 textStroke）", () => {
    renderCanvas([makeBox({ fontSize: 40, strokeColor: "#000000" })]);
    const style = textareaOf().style;
    expect(style.getPropertyValue("-webkit-text-stroke-width")).toBe(
      `${((40 * TEXT_STROKE_DEFAULT_WIDTH_EM) / 1080) * 100}cqh`,
    );
    expect(style.getPropertyValue("-webkit-text-stroke-color")).toBe(
      `rgba(0, 0, 0, ${TEXT_STROKE_DEFAULT_OPACITY})`,
    );
  });
});

describe("描邊欄位在既有操作之後還在", () => {
  it("拖曳搬動後三個描邊欄位原樣留在框上", () => {
    const painted = makeBox({ strokeColor: "#AbCdEf", strokeWidth: 0.06, strokeOpacity: 0.35 });
    const onChange = renderCanvas([painted], "text-1");
    const element = boxElements()[0]!;
    const stage = element.closest(".text-layer-canvas")!;
    firePointer(element, "pointerdown", 100, 100);
    firePointer(stage, "pointermove", 160, 140);
    firePointer(stage, "pointerup", 160, 140);
    const moved = (onChange.mock.calls.at(-1)![0] as EditableTextBox[])[0]!;
    expect(moved.strokeColor).toBe("#AbCdEf");
    expect(moved.strokeWidth).toBe(0.06);
    expect(moved.strokeOpacity).toBe(0.35);
  });

  it("改文字內容不會把描邊洗掉", () => {
    const onChange = renderCanvas([makeBox({ strokeColor: "#000000", strokeWidth: 0.06 })]);
    fireEvent.change(textareaOf(), { target: { value: "改過的文字" } });
    const next = (onChange.mock.calls.at(-1)![0] as EditableTextBox[])[0]!;
    expect(next.text).toBe("改過的文字");
    expect(next.strokeColor).toBe("#000000");
    expect(next.strokeWidth).toBe(0.06);
  });
});

/** inspector 的四個控制項。形狀與底色那組刻意一致（色彩欄位＝開關）。 */
describe("inspector 的描邊控制項", () => {
  function deckWithTextLayer(topic: string): PresentationProject {
    const project = createProject({ topic, brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const slide = project.slides[0]!;
    const now = new Date().toISOString();
    slide.versions = [
      {
        id: "v1",
        imagePath: "assets/generated/v1.png",
        prompt: "",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
        textLayer: {
          originalVersionId: "v0",
          backgroundPath: "assets/generated/clean.png",
          compositePath: "assets/generated/v1.png",
          threshold: 0.75,
          renderRevision: 0,
          extractedAt: now,
          updatedAt: now,
          // 兩個框：「展開狀態跨文字框保留」那條要真的切得動，只有一個框等於沒測到。
          boxes: [makeBox(), makeBox({ id: "text-2", text: "第二個框", y: 300 })],
        },
      },
    ];
    slide.currentVersionId = "v1";
    return project;
  }

  function stubApi(state: { project: PresentationProject }) {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      if (path === "/api/projects" && (init?.method ?? "GET") === "GET")
        return Response.json([state.project]);
      if (path === "/api/providers") return Response.json([]);
      if (path === "/api/styles") return Response.json([createDefaultStyleSafe()]);
      if (path.endsWith("/text-layer")) return Response.json(state.project);
      return Response.json(state.project);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function createDefaultStyleSafe() {
    return { id: "style-1", name: "預設", version: 1, referenceImages: [] };
  }

  async function openTextBox(topic: string) {
    const state = { project: deckWithTextLayer(topic) };
    stubApi(state);
    render(<Editor />);
    fireEvent.click(await screen.findByText(topic));
    const box = await waitFor(() => {
      const element = boxElements()[0];
      if (!element) throw new Error("尚未出現文字框");
      return element;
    });
    fireEvent.pointerDown(box);
    return state;
  }

  /*
   * 下拉本身的行為。每個效果一列（勾選框 ＋ 旁邊的下拉），參數收在下拉裡。
   * 重點是三件事：沒勾選時下拉按不開（沒有東西可調）、一次只有一個下拉開著
   * （兩個浮層會互相重疊）、換選文字框時要關掉（它是 fixed 定位的，留著會浮在原地
   * 卻改到另一個框的參數）。
   */
  it("預設關著；參數只在打開之後才在 DOM 裡", async () => {
    await openTextBox("描邊下拉預設關著");
    const trigger = screen.getByRole("button", { name: "描邊設定" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("文字描邊色")).toBeNull();
    // 勾選框本身則一直看得到——「有沒有套」不必打開下拉就知道。
    expect(screen.getByRole("checkbox", { name: "描邊" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("文字描邊色")).toBeTruthy();
  });

  it("沒勾選時下拉是停用的：沒有東西可調，開了只會是一片灰控制項", async () => {
    await openTextBox("描邊下拉停用");
    const trigger = screen.getByRole("button", { name: "描邊設定" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    await waitFor(() => expect(trigger.disabled).toBe(false));
  });

  it("一次只有一個下拉開著：打開底色會把描邊那顆關掉", async () => {
    await openTextBox("描邊下拉互斥");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "底色" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "底色設定" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    openEffectPopover("描邊");
    expect(screen.getByLabelText("文字描邊色")).toBeTruthy();

    openEffectPopover("底色");
    expect(screen.getByLabelText("文字框底色")).toBeTruthy();
    expect(screen.queryByLabelText("文字描邊色")).toBeNull();
  });

  it("Escape 關得掉，且焦點回到剛才按的那顆下拉鈕", async () => {
    await openTextBox("描邊下拉 Esc");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    openEffectPopover("描邊");
    expect(screen.getByRole("dialog", { name: "描邊設定" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("文字描邊色")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "描邊設定" }));
  });

  it("點下拉外面會關掉（它沒有遮罩，這是另一條退路）", async () => {
    await openTextBox("描邊下拉點外面");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    openEffectPopover("描邊");

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByLabelText("文字描邊色")).toBeNull());
  });

  it("點下拉裡面不會把自己關掉", async () => {
    await openTextBox("描邊下拉點裡面");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    openEffectPopover("描邊");

    fireEvent.pointerDown(screen.getByLabelText("文字描邊粗細"));
    expect(screen.getByLabelText("文字描邊色")).toBeTruthy();
  });

  it("換選文字框會關掉下拉：它是 fixed 定位的，留著會浮在原地卻改到別的框", async () => {
    await openTextBox("描邊下拉換框");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    openEffectPopover("描邊");
    expect(screen.getByLabelText("文字描邊色")).toBeTruthy();

    const boxes = boxElements();
    expect(boxes.length).toBeGreaterThan(1);
    fireEvent.pointerDown(boxes[1]!);
    await waitFor(() => expect(screen.queryByLabelText("文字描邊色")).toBeNull());
  });

  it("取消勾選會把下拉一起收起來（裡面全是停用的控制項）", async () => {
    await openTextBox("描邊下拉取消勾選");
    const checkbox = screen.getByRole("checkbox", { name: "描邊" });
    fireEvent.click(checkbox);
    openEffectPopover("描邊");
    expect(screen.getByLabelText("文字描邊色")).toBeTruthy();

    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.queryByLabelText("文字描邊色")).toBeNull());
  });

  it("勾選描邊會一次寫入三個欄位（色彩＋預設粗細＋預設不透明度）", async () => {
    await openTextBox("描邊勾選");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    openEffectPopover("描邊");
    await waitFor(() =>
      expect((screen.getByLabelText("文字描邊色") as HTMLInputElement).value).toBe(
        TEXT_STROKE_DEFAULT_COLOR,
      ),
    );
    expect((screen.getByLabelText("文字描邊粗細") as HTMLInputElement).value).toBe(
      String(TEXT_STROKE_DEFAULT_WIDTH_EM),
    );
    expect((screen.getByLabelText("文字描邊不透明度") as HTMLInputElement).value).toBe(
      String(TEXT_STROKE_DEFAULT_OPACITY),
    );
    expect(paintOrderOf()).toBe("stroke");
  });

  it("取消勾選會把三個欄位整個移除，不是留下 undefined", async () => {
    await openTextBox("描邊取消");
    const checkbox = screen.getByRole("checkbox", { name: "描邊" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(paintOrderOf()).toBe("stroke"));

    fireEvent.click(checkbox);
    await waitFor(() => expect(paintOrderOf()).toBe(""));
    expect(textareaOf().style.getPropertyValue("-webkit-text-stroke-width")).toBe("");
  });

  it("粗細超過上限先夾再寫入，否則存檔時整批文字框會被伺服器擋下", async () => {
    await openTextBox("描邊夾值");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    openEffectPopover("描邊");
    const width = await screen.findByLabelText("文字描邊粗細");
    fireEvent.change(width, { target: { value: "5" } });
    await waitFor(() =>
      expect((width as HTMLInputElement).value).toBe(String(TEXT_STROKE_MAX_WIDTH_EM)),
    );
  });

  it("粗細欄位被清空時保留原值，不會靜默變成 0（＝描邊無聲消失）", async () => {
    await openTextBox("描邊清空");
    fireEvent.click(screen.getByRole("checkbox", { name: "描邊" }));
    openEffectPopover("描邊");
    const width = await screen.findByLabelText("文字描邊粗細");
    fireEvent.change(width, { target: { value: "" } });
    expect((width as HTMLInputElement).value).toBe(String(TEXT_STROKE_DEFAULT_WIDTH_EM));
    expect(paintOrderOf()).toBe("stroke");
  });
});

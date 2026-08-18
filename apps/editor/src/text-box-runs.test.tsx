// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { EditableTextBox } from "@slide-maker/core";
import { TextLayerCanvas } from "./Editor.js";

/**
 * 框內多色（編輯器端）。
 *
 * `<textarea>` 只有一個 `color`，畫不出分段顏色，所以多色框在非編輯狀態改由一層
 * overlay 疊上去畫。這一組守三件事：單色框完全不受影響、多色框畫得出每一段、
 * 以及使用者改字或改整框顏色時分段怎麼走。
 * 伺服器 SVG 與 PPTX 由 `apps/server/test/text-run-colors.test.ts` 守。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const makeBox = (overrides: Partial<EditableTextBox> = {}): EditableTextBox => ({
  id: "text-1",
  text: "打造 AI Agent 的未來",
  x: 100,
  y: 80,
  width: 600,
  height: 60,
  fontFamily: "Arial",
  fontSize: 40,
  fontWeight: 400,
  color: "#111111",
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

const RUNS = [
  { length: 3, color: "#111111" },
  { length: 8, color: "#ff6b35" },
  { length: 4, color: "#111111" },
];

const boxElement = () => document.querySelector<HTMLElement>(".editable-text-box")!;
const overlay = () => boxElement().querySelector<HTMLElement>(".text-run-overlay");
const textarea = () => boxElement().querySelector<HTMLTextAreaElement>("textarea")!;

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

describe("多色文字在畫布上的渲染", () => {
  it("單色框不產生 overlay，textarea 的字色照舊（＝加入這個功能之前的輸出）", () => {
    renderCanvas([makeBox()]);
    expect(overlay()).toBeNull();
    expect(textarea().style.color).toBe("rgb(17, 17, 17)");
  });

  it("多色框逐段畫出顏色，textarea 的字讓位給 overlay", () => {
    renderCanvas([makeBox({ runs: RUNS })]);
    const spans = [...overlay()!.querySelectorAll("span")];
    expect(spans.map((span) => span.textContent)).toEqual(["打造 ", "AI Agent", " 的未來"]);
    expect(spans.map((span) => span.style.color)).toEqual([
      "rgb(17, 17, 17)",
      "rgb(255, 107, 53)",
      "rgb(17, 17, 17)",
    ]);
    // textarea 仍在原位（雙擊進入編輯、焦點與鍵盤操作都靠它），只是字透明。
    expect(textarea().style.color).toBe("transparent");
    expect(textarea().value).toBe("打造 AI Agent 的未來");
  });

  it("overlay 與 textarea 的排版參數逐一相同，兩層才疊得住", () => {
    renderCanvas([makeBox({ runs: RUNS })]);
    const a = overlay()!.style;
    const b = textarea().style;
    for (const property of [
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "text-align",
      "padding-top",
      "width",
      "height",
    ])
      expect(a.getPropertyValue(property), `overlay 與 textarea 的 ${property} 必須相同`).toBe(
        b.getPropertyValue(property),
      );
  });

  it("overlay 不吃指標事件（否則框選不到、雙擊也進不了編輯）", () => {
    renderCanvas([makeBox({ runs: RUNS })]);
    expect(overlay()!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("改字時分段跟著搬", () => {
  it("在強調段裡插字，那一段跟著變長", () => {
    const onChange = renderCanvas([makeBox({ runs: RUNS })], "text-1");
    fireEvent.doubleClick(boxElement());
    fireEvent.change(textarea(), { target: { value: "打造 AI Agentic 的未來" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0][0]).toMatchObject({
      text: "打造 AI Agentic 的未來",
      runs: [
        { length: 3, color: "#111111" },
        { length: 10, color: "#ff6b35" },
        { length: 4, color: "#111111" },
      ],
    });
  });

  it("整段刪光時 runs 欄位被移除，而不是留一個空陣列", () => {
    const onChange = renderCanvas([makeBox({ runs: RUNS })], "text-1");
    fireEvent.doubleClick(boxElement());
    fireEvent.change(textarea(), { target: { value: "" } });
    const patched = onChange.mock.calls[0]![0][0];
    expect(patched.text).toBe("");
    expect("runs" in patched).toBe(false);
  });
});

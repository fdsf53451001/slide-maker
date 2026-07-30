// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EditableTextBox } from "@slide-maker/core";
import { TextLayerCanvas } from "./Editor.js";

/**
 * 縮放把手不得攔掉「雙擊進入編輯」。
 *
 * 八個把手各 10px、四角四邊再各外擴 6px；只有一個字的文字框本身可能不到 20px，把手
 * 幾乎鋪滿整個框，雙擊必定命中把手。把手若把 dblclick 吞掉（舊版的 `stopPropagation`），
 * 那種框就**永遠**進不了編輯狀態——使用者實測回報的正是這個。
 *
 * 同時釘住反向不變量：把手上的**拖曳**仍然只是縮放，不會順手把框帶進編輯。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RESIZE_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

/** 一個字的框：24×30 畫布單位，接近 `move`／`resize` 的最小尺寸。 */
const tinyBox = (overrides: Partial<EditableTextBox> = {}): EditableTextBox => ({
  id: "text-1",
  text: "字",
  x: 100,
  y: 80,
  width: 24,
  height: 30,
  fontFamily: "Arial",
  fontSize: 24,
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

/** 畫布固定成 960×540 螢幕像素（畫布座標 1920×1080，比例 2）。 */
const stubStageBounds = () =>
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 960,
    bottom: 540,
    width: 960,
    height: 540,
    toJSON: () => ({}),
  } as DOMRect);

const firePointer = (element: Element, type: string, clientX: number, clientY: number) =>
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));

function renderCanvas(box: EditableTextBox = tinyBox()) {
  const onChange = vi.fn();
  render(
    <TextLayerCanvas
      background="/clean.png"
      boxes={[box]}
      canvasWidth={1920}
      canvasHeight={1080}
      selectedId={box.id}
      onSelect={vi.fn()}
      onChange={onChange}
    />,
  );
  return {
    onChange,
    textarea: () => screen.getByLabelText("可編輯簡報文字") as HTMLTextAreaElement,
    stage: () => document.querySelector(".text-layer-canvas")!,
  };
}

describe("極小文字框的雙擊進入編輯", () => {
  it.each(RESIZE_DIRECTIONS)("雙擊 %s 把手照樣進入編輯（把手不吞 dblclick）", (direction) => {
    const canvas = renderCanvas();
    expect(canvas.textarea().readOnly).toBe(true);

    fireEvent.doubleClick(screen.getByLabelText(`調整文字框 ${direction}`));

    // readOnly 解除＝真的進了編輯狀態；只是被選取的框不會解除。
    expect(canvas.textarea().readOnly).toBe(false);
    // 進編輯後把手整組收起來，不會擋在文字上。
    expect(document.querySelectorAll(".text-resize-handle")).toHaveLength(0);
  });

  /**
   * 把手只吃指標事件，所以不該出現在 Tab 順序與無障礙樹裡。
   *
   * 它們是真的 `<button>`，只綁 `onPointerDown`：按 Enter／Space 毫無反應，而 `aria-label`
   * 又會被念成「調整文字框 se」「調整文字框 nw」（`n`／`ne`／`se` 是內部方向碼）。每選取
   * 一個文字框就多出八個按不動的 Tab 停點與八句噪音，宣告成可按卻按不動比不宣告更糟。
   */
  it("八個把手都不進 Tab 順序、也不進無障礙樹", () => {
    renderCanvas();
    const handles = [...document.querySelectorAll<HTMLElement>(".text-resize-handle")];
    expect(handles).toHaveLength(RESIZE_DIRECTIONS.length);
    for (const handle of handles) {
      expect(handle.getAttribute("tabindex")).toBe("-1");
      expect(handle.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("雙擊框本體仍然進入編輯（沒有被把手的改動波及）", () => {
    const canvas = renderCanvas();
    fireEvent.doubleClick(document.querySelector(".editable-text-box")!);
    expect(canvas.textarea().readOnly).toBe(false);
  });

  it("雙擊把手不會 commit 任何尺寸變更（零位移＝沒有 resize）", () => {
    stubStageBounds();
    const canvas = renderCanvas();
    const handle = screen.getByLabelText("調整文字框 se");

    // 完整重現一次雙擊的事件序：兩組 pointerdown/up，最後一個 dblclick。
    firePointer(handle, "pointerdown", 62, 55);
    firePointer(handle, "pointerup", 62, 55);
    firePointer(handle, "pointerdown", 62, 55);
    firePointer(handle, "pointerup", 62, 55);
    fireEvent.doubleClick(handle);

    expect(canvas.onChange).not.toHaveBeenCalled();
    expect(canvas.textarea().readOnly).toBe(false);
  });
});

describe("把手的拖曳行為不變", () => {
  it("八個方向的拖曳都仍然改尺寸，且不會進入編輯", () => {
    for (const direction of RESIZE_DIRECTIONS) {
      stubStageBounds();
      // 用正常大小的框：極小框會被 24×18 的下限夾住，看不出方向差異。
      const canvas = renderCanvas(tinyBox({ width: 300, height: 60 }));
      const stage = canvas.stage();

      firePointer(screen.getByLabelText(`調整文字框 ${direction}`), "pointerdown", 200, 70);
      firePointer(stage, "pointermove", 240, 110);
      firePointer(stage, "pointerup", 240, 110);

      const moved = canvas.onChange.mock.calls.at(-1)?.[0] as EditableTextBox[] | undefined;
      expect(moved, `方向 ${direction} 應該 commit 一次尺寸變更`).toBeTruthy();
      const next = moved![0]!;
      // 每個方向至少動到一條邊；n/w 系動 x/y，s/e 系動寬高。
      const changed = next.x !== 100 || next.y !== 80 || next.width !== 300 || next.height !== 60;
      expect(changed, `方向 ${direction} 沒有任何幾何變化`).toBe(true);
      // 拖曳結束不得順手進編輯——那會讓每次縮放後都跳出游標。
      expect(canvas.textarea().readOnly).toBe(true);
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it("把手上的單擊（含微幅位移）不會進入編輯，也不會 commit 一次縮放", () => {
    stubStageBounds();
    const canvas = renderCanvas();
    const stage = canvas.stage();

    firePointer(screen.getByLabelText("調整文字框 e"), "pointerdown", 62, 55);
    firePointer(stage, "pointermove", 63, 55);
    firePointer(stage, "pointerup", 63, 55);

    expect(canvas.textarea().readOnly).toBe(true);
    // 只斷言 readOnly 會從缺陷上方跨過去：resize 沒有死區時，這 1 螢幕像素會讓框
    // 寬 +2 canvas 單位並 commit 一次 onChange（標 dirty、推 undo、觸發自動存檔）。
    expect(canvas.onChange).not.toHaveBeenCalled();
  });
});

describe("resize 把手的拖曳死區", () => {
  /**
   * 雙擊把手是正式支援的手勢，而只有一個字的框，八個把手幾乎鋪滿整個框身——雙擊之間的
   * 1px 手抖不可以變成一次縮放。死區與 `move` 共用同一個 3px 門檻。
   */
  it("雙擊把手（兩次按放各帶 1px 抖動）進入編輯，且不 commit 任何尺寸變更", () => {
    stubStageBounds();
    const canvas = renderCanvas();
    const handle = screen.getByLabelText("調整文字框 se");
    const stage = canvas.stage();

    // 第一次按放：按下 (62,55)、放開時偏了 1px。
    firePointer(handle, "pointerdown", 62, 55);
    firePointer(stage, "pointermove", 63, 55);
    firePointer(stage, "pointerup", 63, 55);
    // 第二次按放：另一個方向抖 1px。
    firePointer(handle, "pointerdown", 63, 55);
    firePointer(stage, "pointermove", 63, 56);
    firePointer(stage, "pointerup", 63, 56);
    fireEvent.doubleClick(handle);

    expect(canvas.onChange).not.toHaveBeenCalled();
    expect(canvas.textarea().readOnly).toBe(false);
  });

  it("跨過死區之後的微小移動照常生效（微調不是做不到，只是不能一步到位）", () => {
    stubStageBounds();
    const canvas = renderCanvas(tinyBox({ width: 300, height: 60 }));
    const stage = canvas.stage();

    firePointer(screen.getByLabelText("調整文字框 e"), "pointerdown", 200, 70);
    // 先拖出死區（10 螢幕 px＝20 canvas 單位），再退回到只差 1 螢幕 px 的位置。
    firePointer(stage, "pointermove", 210, 70);
    firePointer(stage, "pointermove", 201, 70);
    firePointer(stage, "pointerup", 201, 70);

    const next = (canvas.onChange.mock.calls.at(-1)?.[0] as EditableTextBox[] | undefined)?.[0];
    expect(next?.width).toBe(302);
  });
});

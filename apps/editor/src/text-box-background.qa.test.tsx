// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createProject,
  createDefaultStyle,
  type EditableTextBox,
  type PresentationProject,
} from "@slide-maker/core";
import { Editor, TextLayerCanvas, textBoxBackground } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";

/**
 * 文字框底色的**對抗性**驗證（編輯器端）。
 *
 * 重點不是「勾了底色會不會變色」——那是既有測試的守備範圍——而是**兩個新欄位在
 * 各種既有操作之後還在不在**：拖曳、縮放、複製貼上、復原重做、切頁。這些路徑全都
 * 是「重建整個框物件」的地方，任何一處寫成逐欄複製就會靜默掉欄位，而畫面上要等到
 * 重新載入才看得出來。
 */

afterEach(() => {
  cleanup();
  resetSystemSettings();
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

const boxElements = () => [...document.querySelectorAll<HTMLElement>(".editable-text-box")];

describe("textBoxBackground 的退化輸入", () => {
  it("沒有 backgroundColor 就回 undefined，連帶不覆寫 styles.css 的選取提示底", () => {
    expect(textBoxBackground(makeBox())).toBeUndefined();
    // 只有 opacity 沒有顏色也一樣不畫——與 SVG／PPTX 兩端的判斷條件相同。
    expect(textBoxBackground(makeBox({ backgroundOpacity: 0.4 }))).toBeUndefined();
  });

  it("大小寫混合的 hex 解析成與小寫相同的 rgba", () => {
    expect(textBoxBackground(makeBox({ backgroundColor: "#AbCdEf" }))).toBe(
      "rgba(171, 205, 239, 1)",
    );
    expect(textBoxBackground(makeBox({ backgroundColor: "#abcdef" }))).toBe(
      "rgba(171, 205, 239, 1)",
    );
  });

  it("0 與 1 兩端都照原值吐出（0 不可被 ?? 1 吃掉）", () => {
    expect(textBoxBackground(makeBox({ backgroundColor: "#000000", backgroundOpacity: 0 }))).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(textBoxBackground(makeBox({ backgroundColor: "#ffffff", backgroundOpacity: 1 }))).toBe(
      "rgba(255, 255, 255, 1)",
    );
  });
});

describe("畫布幾何：底色矩形＝文字框矩形本身", () => {
  const renderCanvas = (boxes: EditableTextBox[], onChange = vi.fn()) => {
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={boxes}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId={undefined}
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    return onChange;
  };

  it("底色容器的 left/top/width/height 恰好是框的百分比座標（無內距、無圓角）", () => {
    renderCanvas([makeBox({ backgroundColor: "#ff0000" })]);
    const container = boxElements()[0]!;
    expect(container.style.left).toBe(`${(100 / 1920) * 100}%`);
    expect(container.style.top).toBe(`${(80 / 1080) * 100}%`);
    expect(container.style.width).toBe(`${(300 / 1920) * 100}%`);
    expect(container.style.height).toBe(`${(60 / 1080) * 100}%`);
    expect(container.style.borderRadius).toBe("");
    expect(container.style.padding).toBe("");
  });

  it("旋轉只寫 rotate()，沒有額外的 translate——旋轉中心才會與 SVG 的框中心相同", () => {
    renderCanvas([makeBox({ backgroundColor: "#ff0000", rotation: -37.5 })]);
    expect(boxElements()[0]!.style.transform).toBe("rotate(-37.5deg)");
    // transform-origin 由 styles.css 的 `.editable-text-box { transform-origin: center }` 提供，
    // inline 不得覆寫成別的原點。
    expect(boxElements()[0]!.style.transformOrigin).toBe("");
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

  it("拖曳搬移後兩個底色欄位原樣留在框上", () => {
    stubStageBounds();
    const painted = makeBox({ backgroundColor: "#AbCdEf", backgroundOpacity: 0.35 });
    const onChange = vi.fn();
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[painted]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId="text-1"
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    const element = boxElements()[0]!;
    const stage = element.closest(".text-layer-canvas")!;
    firePointer(element, "pointerdown", 100, 100);
    firePointer(stage, "pointermove", 160, 140);
    firePointer(stage, "pointerup", 160, 140);
    const moved = (onChange.mock.calls.at(-1)![0] as EditableTextBox[])[0]!;
    expect(moved.x).toBeCloseTo(100 + 60 * 2);
    expect(moved.backgroundColor).toBe("#AbCdEf");
    expect(moved.backgroundOpacity).toBe(0.35);
  });

  it("縮放控點改尺寸後兩個底色欄位原樣留在框上", () => {
    stubStageBounds();
    const painted = makeBox({ backgroundColor: "#AbCdEf", backgroundOpacity: 0.35 });
    const onChange = vi.fn();
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[painted]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId="text-1"
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    const stage = boxElements()[0]!.closest(".text-layer-canvas")!;
    firePointer(screen.getByLabelText("調整文字框 se"), "pointerdown", 200, 70);
    firePointer(stage, "pointermove", 280, 130);
    firePointer(stage, "pointerup", 280, 130);
    const grown = (onChange.mock.calls.at(-1)![0] as EditableTextBox[])[0]!;
    expect(grown.width).toBeGreaterThan(painted.width);
    expect(grown.height).toBeGreaterThan(painted.height);
    expect(grown.backgroundColor).toBe("#AbCdEf");
    expect(grown.backgroundOpacity).toBe(0.35);
  });
});

/** 一頁／多頁、帶可編輯文字圖層的專案；進專案就是文字圖層編輯狀態。 */
function layeredProject(topic: string, boxesPerSlide: (slideId: string) => EditableTextBox[]) {
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
        textLayer: {
          originalVersionId: `${slide.id}-v0`,
          backgroundPath: `assets/generated/${slide.id}-clean.png`,
          compositePath: `assets/generated/${slide.id}-composite.png`,
          threshold: 0.75,
          renderRevision: 0,
          boxes: boxesPerSlide(slide.id),
          extractedAt: now,
          updatedAt: now,
        },
      },
    ];
    slide.currentVersionId = `${slide.id}-v1`;
  }
  return project;
}

/** PUT /text-layer 會寫回專案物件，切頁再切回來才看得到真正存下去的內容。 */
function stubPersistingApi(project: PresentationProject) {
  const written: EditableTextBox[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      const target = /\/slides\/([^/]+)\/versions\/([^/]+)\/text-layer$/.exec(path);
      if (target && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { boxes: EditableTextBox[] };
        written.push(body.boxes);
        const version = project.slides
          .find((slide) => slide.id === decodeURIComponent(target[1]!))
          ?.versions.find((candidate) => candidate.id === decodeURIComponent(target[2]!));
        if (version?.textLayer) version.textLayer = { ...version.textLayer, boxes: body.boxes };
        return Response.json(project);
      }
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
    }),
  );
  return written;
}

const enterProject = async (topic: string) => {
  fireEvent.click(await screen.findByText(topic));
  await screen.findByLabelText("可編輯簡報文字");
};

describe("底色欄位在既有互動之後是否還在", () => {
  const painted = (id: string) =>
    makeBox({ id, backgroundColor: "#AbCdEf", backgroundOpacity: 0.35 });

  it("複製貼上的副本帶著底色（只有 id 與座標換新）", async () => {
    const project = layeredProject("貼上帶底色", (slideId) => [painted(`${slideId}-t1`)]);
    stubPersistingApi(project);
    render(<Editor />);
    await enterProject("貼上帶底色");

    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    // 副本的底色必須與來源逐點相同；掉了欄位在畫面上就是「貼出來的框沒有底」。
    expect(boxElements()[1]!.style.background).toBe("rgba(171, 205, 239, 0.35)");
    expect(boxElements()[1]!.style.background).toBe(boxElements()[0]!.style.background);
  });

  it("Ctrl+Z 復原「關閉底色」會把兩個欄位整組帶回來，Ctrl+Shift+Z 再拿掉", async () => {
    const project = layeredProject("底色復原", (slideId) => [painted(`${slideId}-t1`)]);
    const written = stubPersistingApi(project);
    render(<Editor />);
    await enterProject("底色復原");

    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByLabelText("底色"));
    await waitFor(() => expect(boxElements()[0]!.style.background).toBe(""));
    // 先等「關掉底色」真的落地。不等的話 Ctrl+Z 會在 650ms debounce 到期前就把狀態改回
    // 伺服器上那份，自動儲存正確地判定無事可做——那時候沒有 PUT 是對的，不是掉欄位。
    await waitFor(
      () => expect(written.at(-1)?.[0] && "backgroundColor" in written.at(-1)![0]!).toBe(false),
      {
        timeout: 3000,
      },
    );

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(boxElements()[0]!.style.background).toBe("rgba(171, 205, 239, 0.35)"),
    );
    // 復原後存回去的內容也要帶著兩個欄位，不能只有畫面對、送出去的沒有。
    await waitFor(
      () => {
        const last = written.at(-1)?.[0];
        expect(last?.backgroundColor).toBe("#AbCdEf");
        expect(last?.backgroundOpacity).toBe(0.35);
      },
      { timeout: 3000 },
    );

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(boxElements()[0]!.style.background).toBe(""));
    await waitFor(
      () => expect(written.at(-1)?.[0] && "backgroundColor" in written.at(-1)![0]!).toBe(false),
      { timeout: 3000 },
    );
  });

  it("切到別頁再切回來，剛設好的底色仍在（每頁各自獨立）", async () => {
    const project = layeredProject("跨頁底色", (slideId) => [makeBox({ id: `${slideId}-t1` })]);
    stubPersistingApi(project);
    render(<Editor />);
    await enterProject("跨頁底色");

    const [first, second] = project.slides;
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByLabelText("底色"));
    await waitFor(() => expect(boxElements()[0]!.style.background).toBe("rgb(0, 0, 0)"));
    // 等自動儲存把這一頁寫回專案物件，否則切頁後重新播種的是舊內容。
    await waitFor(
      () => expect(first!.versions[0]!.textLayer!.boxes[0]!.backgroundColor).toBe("#000000"),
      { timeout: 3000 },
    );

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".text-layer-canvas img")!.src).toContain(
        second!.id,
      ),
    );
    // 第二頁沒設底色，不該沾到第一頁的設定。
    expect(boxElements()[0]!.style.background).toBe("");

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".text-layer-canvas img")!.src).toContain(
        first!.id,
      ),
    );
    await waitFor(() => expect(boxElements()[0]!.style.background).toBe("rgb(0, 0, 0)"));
  });

  it("關閉底色送出的框不含兩個 key，且其餘欄位一個都沒少", async () => {
    const project = layeredProject("關閉底色欄位", (slideId) => [painted(`${slideId}-t1`)]);
    const written = stubPersistingApi(project);
    render(<Editor />);
    await enterProject("關閉底色欄位");

    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByLabelText("底色"));
    await waitFor(
      () => {
        const last = written.at(-1)?.[0];
        expect(last && "backgroundColor" in last).toBe(false);
      },
      { timeout: 3000 },
    );
    const last = written.at(-1)![0]!;
    const source = painted("x");
    const { backgroundColor: _c, backgroundOpacity: _o, ...expected } = source;
    expect({ ...last, id: "x" }).toEqual(expected);
  });
});

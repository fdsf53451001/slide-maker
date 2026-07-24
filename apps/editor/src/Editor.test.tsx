// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createProject,
  createDefaultStyle,
  createSlidesFromBrief,
  editableTextBoxSchema,
  type PresentationProject,
} from "@slide-maker/core";
import { Editor, TextLayerCanvas } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom 沒有 PointerEvent，fireEvent.pointer* 不會帶座標；改用 MouseEvent 派發對應型別。
const firePointer = (element: Element, type: string, clientX: number, clientY: number) =>
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));

const makeBox = (overrides: Partial<import("@slide-maker/core").EditableTextBox> = {}) => ({
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
  align: "left" as const,
  verticalAlign: "top" as const,
  rotation: 0,
  confidence: 1,
  role: "presentation" as const,
  ...overrides,
});

describe("Editor MVP navigation", () => {
  it("always renders the clean background with the real text layered on top", () => {
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox()]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId={undefined}
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "文字抽離乾淨背景" }).getAttribute("src")).toBe(
      "/clean.png",
    );
    expect((screen.getByLabelText("可編輯簡報文字") as HTMLTextAreaElement).style.color).not.toBe(
      "transparent",
    );
  });

  it("selects a text box on single click and only enables text editing after double click", () => {
    const onSelect = vi.fn();
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox()]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId="text-1"
        onSelect={onSelect}
        onChange={vi.fn()}
      />,
    );
    const textarea = screen.getByLabelText("可編輯簡報文字") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    // 非編輯狀態顯示區放大，模擬 SVG 匯出不裁字的行為
    expect(textarea.style.width).toBe("400%");

    const boxElement = textarea.closest(".editable-text-box") as HTMLElement;
    fireEvent.pointerDown(boxElement);
    expect(onSelect).toHaveBeenCalledWith("text-1");
    expect(textarea.readOnly).toBe(true);

    fireEvent.doubleClick(boxElement);
    expect(textarea.readOnly).toBe(false);
    // 編輯中恢復框尺寸，避免放大的透明區攔截畫布點擊
    expect(textarea.style.width).toBe("");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(textarea.readOnly).toBe(true);
  });

  it("still selects a text box when pointer capture is unavailable", () => {
    const onSelect = vi.fn();
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox()]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId={undefined}
        onSelect={onSelect}
        onChange={vi.fn()}
      />,
    );
    const boxElement = screen
      .getByLabelText("可編輯簡報文字")
      .closest(".editable-text-box") as HTMLElement;
    Object.defineProperty(boxElement, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException("No active pointer", "NotFoundError");
      },
    });

    expect(() => fireEvent.pointerDown(boxElement)).not.toThrow();
    expect(onSelect).toHaveBeenCalledWith("text-1");
  });

  it("commits a drag as a single onChange when the pointer is released", () => {
    const bounds = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 960,
      bottom: 540,
      width: 960,
      height: 540,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(bounds);
    const onChange = vi.fn();
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox()]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId="text-1"
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    const boxElement = screen
      .getByLabelText("可編輯簡報文字")
      .closest(".editable-text-box") as HTMLElement;
    const stage = boxElement.closest(".text-layer-canvas") as HTMLElement;

    firePointer(boxElement, "pointerdown", 100, 100);
    firePointer(stage, "pointermove", 130, 120);
    firePointer(stage, "pointermove", 160, 140);
    expect(onChange).not.toHaveBeenCalled();

    firePointer(stage, "pointerup", 160, 140);
    expect(onChange).toHaveBeenCalledTimes(1);
    const moved = onChange.mock.calls[0]![0][0];
    expect(moved.x).toBeCloseTo(100 + 60 * 2); // 60 screen px × (1920/960)
    expect(moved.y).toBeCloseTo(80 + 40 * 2);
  });

  it("does not start a drag for sub-threshold pointer jitter", () => {
    const bounds = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 960,
      bottom: 540,
      width: 960,
      height: 540,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(bounds);
    const onChange = vi.fn();
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox()]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId="text-1"
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    const boxElement = screen
      .getByLabelText("可編輯簡報文字")
      .closest(".editable-text-box") as HTMLElement;
    const stage = boxElement.closest(".text-layer-canvas") as HTMLElement;

    firePointer(boxElement, "pointerdown", 100, 100);
    firePointer(stage, "pointermove", 101, 101);
    firePointer(stage, "pointerup", 101, 101);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the first reference image on a style-library card when legacy data has no cover id", async () => {
    const now = new Date().toISOString();
    const style = {
      ...createDefaultStyle(now),
      id: "legacy-style",
      name: "既有風格",
      system: false,
      referenceImages: [
        {
          id: "legacy-cover",
          name: "cover.png",
          mediaType: "image/png" as const,
          assetPath: "assets/legacy-cover.png",
          createdAt: now,
        },
      ],
      coverImageId: undefined,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
        if (path === "/api/projects") return Response.json([]);
        if (path === "/api/providers") return Response.json([]);
        if (path === "/api/styles") return Response.json([style]);
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    window.history.replaceState({}, "", "/styles");
    render(<Editor />);
    await screen.findByText("既有風格");
    expect(screen.getByRole("img", { name: "既有風格 封面" }).getAttribute("src")).toBe(
      "/api/style-assets/legacy-cover",
    );
    window.history.replaceState({}, "", "/");
  });

  it("creates a blank page so the slide panel drives purpose, outline and generation", async () => {
    let project = createProject({ topic: "空白頁插入", brief: { desiredSlideCount: 2 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    let addSlideBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: now,
          expiresAt: now,
        });
      if (path.endsWith("/slides") && init?.method === "POST") {
        addSlideBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        const created = {
          ...structuredClone(project.slides[0]!),
          id: "blank-slide",
          order: 1,
          purpose: "",
          content: "",
          narrative: "",
          layoutHint: "",
          imagePrompt: "",
          versions: [],
        };
        project = {
          ...project,
          slides: [project.slides[0]!, created, { ...project.slides[1]!, order: 2 }],
        };
        return Response.json(project, { status: 201 });
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("空白頁插入"));
    fireEvent.click(await screen.findByRole("button", { name: "新增頁面" }));

    // 新增頁面不再彈對話框問目的，而是直接建空白頁並選中它。
    await waitFor(() => expect(addSlideBody).toEqual({ afterSlideId: project.slides[0]!.id }));
    await waitFor(() =>
      expect((screen.getByLabelText("頁面目的") as HTMLTextAreaElement).value).toBe(""),
    );
    // 目的還空著時，大綱按鈕顯示「生成大綱」且不可按——先填目的才有意義。
    const outlineButton = screen.getByRole("button", { name: "生成大綱" });
    expect(outlineButton).toHaveProperty("disabled", true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/slides/ai"))).toBe(false);
  });

  it("shows a named style picker instead of asking for an internal style id", async () => {
    const project = createProject({ topic: "加入風格庫", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    project.slides[0]!.versions = [
      {
        id: "version-1",
        imagePath: "assets/generated/slide.png",
        prompt: "test",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      },
    ];
    project.slides[0]!.currentVersionId = "version-1";
    const customStyle = {
      ...createDefaultStyle(now),
      id: "team-visual",
      name: "團隊科技風",
      system: false,
      referenceImages: [],
    };
    vi.stubGlobal("prompt", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
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
        if (path === "/api/styles") return Response.json([createDefaultStyle(now), customStyle]);
        if (path.includes("/readiness"))
          return Response.json({
            providerId: "mock-image",
            status: "ready",
            blocking: false,
            requiresAcknowledgement: false,
            message: "Ready",
            checkedAt: now,
            expiresAt: now,
          });
        return Response.json(project);
      }),
    );

    render(<Editor />);
    fireEvent.click(await screen.findByText("加入風格庫"));
    fireEvent.click(await screen.findByText("＋ 將圖片加入風格庫"));

    expect(await screen.findByRole("dialog", { name: "選擇風格" })).toBeTruthy();
    expect(screen.getByText("建立新風格")).toBeTruthy();
    expect(screen.getByText("團隊科技風")).toBeTruthy();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("previews an old image version without creating a new version and switches only on confirmation", async () => {
    let project = createProject({ topic: "版本比較", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const firstCreatedAt = "2026-07-16T01:00:00.000Z";
    const secondCreatedAt = "2026-07-16T02:00:00.000Z";
    const baseOutline = {
      purpose: project.slides[0]!.purpose,
      narrative: "原始敘事",
      layoutHint: "原始構圖",
      sourceIds: [],
    };
    project.slides[0]!.versions = [
      {
        id: "version-1",
        imagePath: "assets/generated/version-1.png",
        prompt: "first",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        outlineSnapshot: {
          ...baseOutline,
          content: "第一版大綱內容",
          imagePrompt: "第一版圖片提示",
        },
        createdAt: firstCreatedAt,
      },
      {
        id: "version-2",
        imagePath: "assets/generated/version-2.png",
        prompt: "second",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        outlineSnapshot: {
          ...baseOutline,
          content: "第二版大綱內容",
          imagePrompt: "第二版圖片提示",
        },
        createdAt: secondCreatedAt,
      },
    ];
    Object.assign(project.slides[0]!, project.slides[0]!.versions[1]!.outlineSnapshot);
    project.slides[0]!.currentVersionId = "version-2";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles") return Response.json([createDefaultStyle(secondCreatedAt)]);
      if (path.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: secondCreatedAt,
          expiresAt: secondCreatedAt,
        });
      if (path.endsWith("/versions/version-1/activate")) {
        project = structuredClone(project);
        project.slides[0]!.currentVersionId = "version-1";
        Object.assign(project.slides[0]!, project.slides[0]!.versions[0]!.outlineSnapshot, {
          outlineDirty: false,
        });
        return Response.json(project);
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("版本比較"));
    fireEvent.click(await screen.findByRole("button", { name: "版本 1" }));

    expect(screen.getByRole("img", { name: "Slide 1" }).getAttribute("src")).toContain(
      "version-1.png",
    );
    expect(screen.getByText("正在預覽歷史版本")).toBeTruthy();
    expect(screen.getByDisplayValue("第一版大綱內容")).toHaveProperty("readOnly", true);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/versions/version-1/activate"),
      ),
    ).toBe(false);
    expect(screen.getAllByRole("button", { name: /^版本 \d/ })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "切換至此版本" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/versions/version-1/activate"),
        ),
      ).toBe(true),
    );
    expect(await screen.findByRole("button", { name: "版本 1（目前）" })).toBeTruthy();
    expect(screen.getByDisplayValue("第一版大綱內容")).toBeTruthy();
    expect(screen.queryByText("正在預覽歷史版本")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^版本 \d/ })).toHaveLength(2);
  });

  it("deletes an unused version after confirmation and leaves the preview state clean", async () => {
    let project = createProject({ topic: "刪除版本", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const baseVersion = {
      prompt: "p",
      providerId: "mock-image",
      model: "mock",
      parameters: {},
      styleVersion: 1,
      sources: [],
    };
    project.slides[0]!.versions = [
      {
        ...baseVersion,
        id: "version-1",
        imagePath: "assets/generated/version-1.png",
        createdAt: "2026-07-16T01:00:00.000Z",
      },
      {
        ...baseVersion,
        id: "version-2",
        imagePath: "assets/generated/version-2.png",
        createdAt: "2026-07-16T02:00:00.000Z",
      },
    ];
    project.slides[0]!.currentVersionId = "version-2";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles")
        return Response.json([createDefaultStyle("2026-07-16T02:00:00.000Z")]);
      if (path.endsWith("/versions/version-1") && init?.method === "DELETE") {
        project = structuredClone(project);
        project.slides[0]!.versions = project.slides[0]!.versions.filter(
          (version) => version.id !== "version-1",
        );
        return Response.json(project);
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("刪除版本"));
    // 先進入預覽，確認刪掉正在預覽的版本後會退回目前版本。
    fireEvent.click(await screen.findByRole("button", { name: "版本 1" }));
    expect(screen.getByText("正在預覽歷史版本")).toBeTruthy();
    // 使用中的版本沒有刪除鈕。
    expect(screen.queryByRole("button", { name: "刪除版本 2" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "刪除版本 1" }));
    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/versions/version-1") && init?.method === "DELETE",
        ),
      ).toBe(true),
    );
    // 這個 waitFor 必須等在「剩一顆」上：等「不是 null」的話刪除前就已經成立，
    // 等於沒有同步點，後面的長度斷言會賽跑到重繪之前。
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^版本 \d/ })).toHaveLength(1),
    );
    expect(screen.queryByText("正在預覽歷史版本")).toBeNull();
  });

  it("keeps the version when deletion is not confirmed", async () => {
    const project = createProject({ topic: "取消刪除", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    project.slides[0]!.versions = [
      {
        id: "version-1",
        imagePath: "assets/generated/version-1.png",
        prompt: "p",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: "2026-07-16T01:00:00.000Z",
      },
      {
        id: "version-2",
        imagePath: "assets/generated/version-2.png",
        prompt: "p",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: "2026-07-16T02:00:00.000Z",
      },
    ];
    project.slides[0]!.currentVersionId = "version-2";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === "/api/projects") return Response.json([project]);
      if (path === "/api/providers") return Response.json([]);
      if (path === "/api/styles")
        return Response.json([createDefaultStyle("2026-07-16T02:00:00.000Z")]);
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );

    render(<Editor />);
    fireEvent.click(await screen.findByText("取消刪除"));
    fireEvent.click(await screen.findByRole("button", { name: "刪除版本 1" }));
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith("/versions/version-1")),
    ).toBe(false);
    expect(screen.getAllByRole("button", { name: /^版本 \d/ })).toHaveLength(2);
  });

  // 伺服器的 409 只回裸錯誤碼（`{"error":"VERSION_REFERENCED_BY_TEXT_LAYER"}`，沒有
  // message 欄位），前端必須翻成可行動的中文；直接把錯誤碼倒到 toast 上等於沒有提示。
  it("explains a refused version deletion instead of showing the raw error code", async () => {
    const project = createProject({ topic: "刪除被擋", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const baseVersion = {
      prompt: "p",
      providerId: "mock-image",
      model: "mock",
      parameters: {},
      styleVersion: 1,
      sources: [],
    };
    project.slides[0]!.versions = [
      {
        ...baseVersion,
        id: "version-1",
        imagePath: "assets/generated/version-1.png",
        createdAt: "2026-07-16T01:00:00.000Z",
      },
      {
        ...baseVersion,
        id: "version-2",
        imagePath: "assets/generated/version-2.png",
        createdAt: "2026-07-16T02:00:00.000Z",
      },
    ];
    project.slides[0]!.currentVersionId = "version-2";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(typeof input === "string" ? input : (input as Request).url);
      if (path === "/api/projects") return Response.json([project]);
      if (path === "/api/providers") return Response.json([]);
      if (path === "/api/styles")
        return Response.json([createDefaultStyle("2026-07-16T02:00:00.000Z")]);
      if (path.endsWith("/versions/version-1") && init?.method === "DELETE")
        return Response.json({ error: "VERSION_REFERENCED_BY_TEXT_LAYER" }, { status: 409 });
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );

    render(<Editor />);
    fireEvent.click(await screen.findByText("刪除被擋"));
    fireEvent.click(await screen.findByRole("button", { name: "刪除版本 1" }));

    await waitFor(() => expect(screen.getByText(/有可編輯文字版本以這一版為原圖/)).toBeTruthy());
    expect(screen.queryByText(/VERSION_REFERENCED_BY_TEXT_LAYER/)).toBeNull();
    // 被擋下來的刪除不能讓卡片先行消失。
    expect(screen.getAllByRole("button", { name: /^版本 \d/ })).toHaveLength(2);
  });

  it("does not present the current outline as an old version when the legacy image has no snapshot", async () => {
    const project = createProject({ topic: "舊版無大綱", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    project.slides[0]!.versions = [
      {
        id: "legacy-version",
        imagePath: "assets/generated/legacy.png",
        prompt: "legacy",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      },
      {
        id: "current-version",
        imagePath: "assets/generated/current.png",
        prompt: "current",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        outlineSnapshot: {
          purpose: project.slides[0]!.purpose,
          content: project.slides[0]!.content,
          narrative: project.slides[0]!.narrative,
          layoutHint: project.slides[0]!.layoutHint,
          imagePrompt: project.slides[0]!.imagePrompt,
          sourceIds: [],
        },
        createdAt: now,
      },
    ];
    project.slides[0]!.currentVersionId = "current-version";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
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
        if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
        if (path.includes("/readiness"))
          return Response.json({
            providerId: "mock-image",
            status: "ready",
            blocking: false,
            requiresAcknowledgement: false,
            message: "Ready",
            checkedAt: now,
            expiresAt: now,
          });
        return Response.json(project);
      }),
    );

    render(<Editor />);
    fireEvent.click(await screen.findByText("舊版無大綱"));
    fireEvent.click(await screen.findByRole("button", { name: "版本 1" }));

    expect(await screen.findByText("此版本沒有大綱快照")).toBeTruthy();
    expect(screen.getByText(/只能比較圖片/)).toBeTruthy();
    expect(screen.queryByDisplayValue(project.slides[0]!.content)).toBeNull();
  });

  it("regenerates only the current slide outline from allowed project sources and marks the draft fields", async () => {
    let project = createProject({ topic: "單頁大綱更新", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    const slide = project.slides[0]!;
    slide.versions = [
      {
        id: "current-version",
        imagePath: "assets/generated/current.png",
        prompt: slide.imagePrompt,
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
        outlineSnapshot: {
          purpose: slide.purpose,
          content: slide.content,
          narrative: slide.narrative,
          layoutHint: slide.layoutHint,
          imagePrompt: slide.imagePrompt,
          sourceIds: [],
        },
      },
    ];
    slide.currentVersionId = "current-version";
    project.sources = [
      {
        id: "allowed-source",
        name: "允許來源.md",
        mediaType: "text/markdown",
        usage: "content",
        allowModelAccess: true,
        status: "indexed",
        assetPath: "assets/sources/allowed.md",
        sizeBytes: 100,
        extractedText: "完整證據",
        chunks: [{ id: "allowed-chunk", text: "完整證據" }],
        metadata: {},
        createdAt: now,
      },
      {
        id: "blocked-source",
        name: "禁止來源.md",
        mediaType: "text/markdown",
        usage: "content",
        allowModelAccess: false,
        status: "indexed",
        assetPath: "assets/sources/blocked.md",
        sizeBytes: 100,
        extractedText: "不可使用",
        chunks: [{ id: "blocked-chunk", text: "不可使用" }],
        metadata: {},
        createdAt: now,
      },
    ];
    const originalPurpose = slide.purpose;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: now,
          expiresAt: now,
        });
      if (path.endsWith(`/slides/${slide.id}/outline`)) {
        project = structuredClone(project);
        Object.assign(project.slides[0]!, {
          content: "加入來源證據後的高密度內容",
          narrative: "新版敘事",
          layoutHint: "新版構圖",
          imagePrompt: "新版圖片提示",
          sourceIds: ["allowed-source"],
          outlineDirty: true,
        });
        return Response.json(project);
      }
      if (path.endsWith(`/slides/${slide.id}`) && init?.method === "PATCH")
        return Response.json(project);
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("單頁大綱更新"));
    fireEvent.click(await screen.findByRole("button", { name: "重新生成單頁大綱" }));

    const updatedContent = await screen.findByDisplayValue("加入來源證據後的高密度內容");
    expect(screen.getByDisplayValue(originalPurpose)).toBeTruthy();
    expect(updatedContent.closest("label")?.classList.contains("outline-dirty")).toBe(true);
    // 模型挑的來源標成「AI 選用」而不是「我指定」：勾選框代表使用者的指定，模型不得代勞。
    const aiChosen = screen.getByRole("checkbox", { name: "允許來源.md", description: /^AI 選用/ });
    expect(aiChosen).toHaveProperty("checked", false);
    expect(aiChosen).toHaveProperty("indeterminate", true);
    const untouched = screen.getByRole("checkbox", { name: "禁止來源.md", description: /^沒用到/ });
    expect(untouched).toHaveProperty("checked", false);
    expect(untouched).toHaveProperty("indeterminate", false);
    expect(screen.getByText("來源 · 我指定 0 · AI 選用 1 / 共 2")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/outline$/),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("toggles a slide source between AI-chosen, user-pinned and unused, and saves the pins", async () => {
    let project = createProject({ topic: "來源三態", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    const slide = project.slides[0]!;
    // AI 選了甲，乙完全沒用到——這是重生成大綱之後最常見的起點。
    slide.sourceIds = ["source-a"];
    slide.pinnedSourceIds = [];
    project.sources = ["a", "b"].map((suffix) => ({
      id: `source-${suffix}`,
      name: `來源${suffix}.md`,
      mediaType: "text/markdown",
      usage: "content" as const,
      allowModelAccess: true,
      status: "indexed" as const,
      assetPath: `assets/sources/${suffix}.md`,
      sizeBytes: 10,
      extractedText: "內容",
      chunks: [{ id: `chunk-${suffix}`, text: "內容" }],
      metadata: {},
      createdAt: now,
    }));
    const patched: Array<{ sourceIds: string[]; pinnedSourceIds: string[] }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path.endsWith(`/slides/${slide.id}`) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          sourceIds: string[];
          pinnedSourceIds: string[];
        };
        patched.push(body);
        project = structuredClone(project);
        Object.assign(project.slides[0]!, body);
        return Response.json(project);
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("來源三態"));

    // 起點：甲是 AI 選用（mixed），乙沒用到。
    const aiChip = await screen.findByRole("checkbox", {
      name: "來源a.md",
      description: /^AI 選用/,
    });
    expect(aiChip).toHaveProperty("indeterminate", true);
    expect(screen.getByRole("checkbox", { name: "來源b.md", description: /^沒用到/ })).toBeTruthy();
    expect(screen.getByText("來源 · 我指定 0 · AI 選用 1 / 共 2")).toBeTruthy();

    // 點一下 AI 選的 → 變成我指定；使用清單不變。
    fireEvent.click(aiChip);
    const pinnedChip = await screen.findByRole("checkbox", {
      name: "來源a.md",
      description: /^我指定/,
    });
    expect(pinnedChip).toHaveProperty("checked", true);
    expect(pinnedChip).toHaveProperty("indeterminate", false);
    expect(pinnedChip.closest("label")?.className).toContain("source-chip-pinned");
    expect(screen.getByText("來源 · 我指定 1 · AI 選用 0 / 共 2")).toBeTruthy();

    // 再點一下 → 連使用清單一起移除，變回沒用到。
    fireEvent.click(pinnedChip);
    const droppedChip = await screen.findByRole("checkbox", {
      name: "來源a.md",
      description: /^沒用到/,
    });
    expect(droppedChip).toHaveProperty("checked", false);
    expect(droppedChip).toHaveProperty("indeterminate", false);
    expect(screen.getByText("來源 · 我指定 0 · AI 選用 0 / 共 2")).toBeTruthy();

    // 沒用到的來源被點選時直接成為我指定，並進入使用清單。
    fireEvent.click(screen.getByRole("checkbox", { name: "來源b.md", description: /^沒用到/ }));
    await screen.findByRole("checkbox", { name: "來源b.md", description: /^我指定/ });
    expect(screen.getByText("來源 · 我指定 1 · AI 選用 0 / 共 2")).toBeTruthy();

    // 自動儲存把兩份清單一起送出：只送 sourceIds 的話伺服器就分不出誰是使用者指定的。
    await waitFor(() => expect(patched.length).toBeGreaterThan(0));
    const last = patched.at(-1)!;
    expect(last.sourceIds).toEqual(["source-b"]);
    expect(last.pinnedSourceIds).toEqual(["source-b"]);
  });

  it("saves an AI-chosen source promoted to user-pinned even though the used-source list is unchanged", async () => {
    // 「把 AI 選的改成我指定」是這個功能最常見的一次操作，而它只動 pinnedSourceIds，
    // sourceIds 一個字都沒變。自動儲存的 dirty 判斷若只看 sourceIds，這個動作就永遠不會送出，
    // 使用者重新整理後指定全部不見，畫面上卻沒有任何失敗提示。
    let project = createProject({ topic: "只改指定", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    const slide = project.slides[0]!;
    slide.sourceIds = ["source-a"];
    slide.pinnedSourceIds = [];
    project.sources = [
      {
        id: "source-a",
        name: "來源a.md",
        mediaType: "text/markdown",
        usage: "content" as const,
        allowModelAccess: true,
        status: "indexed" as const,
        assetPath: "assets/sources/a.md",
        sizeBytes: 10,
        extractedText: "內容",
        chunks: [{ id: "chunk-a", text: "內容" }],
        metadata: {},
        createdAt: now,
      },
    ];
    const patched: Array<{ sourceIds: string[]; pinnedSourceIds: string[] }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path.endsWith(`/slides/${slide.id}`) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          sourceIds: string[];
          pinnedSourceIds: string[];
        };
        patched.push(body);
        project = structuredClone(project);
        Object.assign(project.slides[0]!, body);
        return Response.json(project);
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("只改指定"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "來源a.md", description: /^AI 選用/ }),
    );
    await screen.findByRole("checkbox", { name: "來源a.md", description: /^我指定/ });

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({
      sourceIds: ["source-a"],
      pinnedSourceIds: ["source-a"],
    });
  });

  it("shows the previewed version's own sources read-only, so a later pin cannot be edited or claimed as used", async () => {
    // 預覽歷史版本時大綱是唯讀的快照。來源晶片若還能點，使用者會以為自己在改這一頁，
    // 實際上改的是目前草稿，而畫面顯示的卻是舊版本——改完什麼也對不起來。
    // 另外快照只記 sourceIds，所以生成之後才指定的來源在這個畫面上必須顯示成「沒用到」，
    // 不能謊稱這張圖用了它。
    const project = createProject({ topic: "版本來源唯讀", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = "2026-07-16T01:00:00.000Z";
    const slide = project.slides[0]!;
    project.sources = ["a", "b"].map((suffix) => ({
      id: `source-${suffix}`,
      name: `來源${suffix}.md`,
      mediaType: "text/markdown",
      usage: "content" as const,
      allowModelAccess: true,
      status: "indexed" as const,
      assetPath: `assets/sources/${suffix}.md`,
      sizeBytes: 10,
      extractedText: "內容",
      chunks: [{ id: `chunk-${suffix}`, text: "內容" }],
      metadata: {},
      createdAt: now,
    }));
    slide.versions = [
      {
        id: "version-1",
        imagePath: "assets/generated/version-1.png",
        prompt: "first",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        outlineSnapshot: {
          purpose: slide.purpose,
          content: "第一版大綱內容",
          narrative: "原始敘事",
          layoutHint: "原始構圖",
          imagePrompt: "第一版圖片提示",
          // 生成當下只用了甲。
          sourceIds: ["source-a"],
        },
        createdAt: now,
      },
      {
        id: "version-2",
        imagePath: "assets/generated/version-2.png",
        prompt: "second",
        providerId: "mock-image",
        model: "mock",
        parameters: {},
        styleVersion: 1,
        sources: [],
        outlineSnapshot: {
          purpose: slide.purpose,
          content: "第二版大綱內容",
          narrative: "原始敘事",
          layoutHint: "原始構圖",
          imagePrompt: "第二版圖片提示",
          sourceIds: ["source-a", "source-b"],
        },
        createdAt: "2026-07-16T02:00:00.000Z",
      },
    ];
    slide.currentVersionId = "version-2";
    slide.sourceIds = ["source-a", "source-b"];
    // 第一版生成之後使用者才指定了甲與乙：甲當時就在用、只是沒被指定，乙當時根本沒用到。
    // 甲這一份是關鍵——快照不記指定，若預覽時拿現在的指定去標，它會被說成「那時候就指定了」。
    slide.pinnedSourceIds = ["source-a", "source-b"];
    // init 要進簽章，最後那段「完全沒發出 PATCH」的斷言才讀得到每次呼叫的第二個參數。
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("版本來源唯讀"));
    fireEvent.click(await screen.findByRole("button", { name: "版本 1" }));
    expect(await screen.findByText("正在預覽歷史版本")).toBeTruthy();

    // 甲是第一版實際用到的來源，但不是使用者指定的，所以是 AI 選用。
    const usedChip = screen.getByRole("checkbox", { name: "來源a.md", description: /^AI 選用/ });
    // 乙雖然目前被指定，第一版沒用到它，所以這個畫面必須顯示成沒用到。
    const pinnedButUnusedChip = screen.getByRole("checkbox", {
      name: "來源b.md",
      description: /^沒用到/,
    });
    expect(pinnedButUnusedChip).toHaveProperty("checked", false);
    expect(screen.getByText("來源 · 我指定 0 · AI 選用 1 / 共 2")).toBeTruthy();

    // 兩個晶片都不可操作。
    expect(usedChip).toHaveProperty("disabled", true);
    expect(pinnedButUnusedChip).toHaveProperty("disabled", true);
    fireEvent.click(pinnedButUnusedChip);
    expect(screen.getByRole("checkbox", { name: "來源b.md", description: /^沒用到/ })).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(false);
  });

  it("previews text and image sources with model access before the title", async () => {
    const project = createProject({ topic: "來源預覽", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    project.sources = [
      {
        id: "text-source",
        name: "研究摘要.md",
        mediaType: "text/markdown",
        usage: "content",
        allowModelAccess: true,
        status: "indexed",
        assetPath: "assets/sources/text-source/研究摘要.md",
        sizeBytes: 2048,
        extractedText: `Grok Build 能縮短從需求到可執行原型的迭代時間。${"完整簡介內容。".repeat(40)}`,
        chunks: [{ id: "chunk-1", text: "Grok Build 能縮短從需求到可執行原型的迭代時間。" }],
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "image-source",
        name: "流程圖.png",
        mediaType: "image/png",
        usage: "visual-reference",
        allowModelAccess: false,
        status: "indexed",
        assetPath: "assets/sources/image-source/流程圖.png",
        sizeBytes: 8192,
        extractedText: "",
        chunks: [],
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
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
        if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
        if (path.includes("/readiness"))
          return Response.json({
            providerId: "mock-image",
            status: "ready",
            blocking: false,
            requiresAcknowledgement: false,
            message: "Ready",
            checkedAt: now,
            expiresAt: now,
          });
        return Response.json(project);
      }),
    );

    render(<Editor />);
    fireEvent.click(await screen.findByText("來源預覽"));
    fireEvent.click(await screen.findByRole("button", { name: "來源 2" }));

    const title = await screen.findByText("研究摘要.md");
    expect(
      title.closest("header")?.firstElementChild?.querySelector("input[type=checkbox]"),
    ).toBeTruthy();
    expect(screen.getByText(/Grok Build 能縮短/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "預覽 流程圖.png" }).querySelector("img"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "預覽 研究摘要.md" }));
    const dialog = await screen.findByRole("dialog", { name: "預覽來源：研究摘要.md" });
    expect(screen.getByText("簡介")).toBeTruthy();
    expect(screen.getByText("全文")).toBeTruthy();
    expect(
      dialog.querySelector(".source-preview-intro p")?.textContent?.endsWith("完整簡介內容。"),
    ).toBe(true);
    expect(dialog.querySelector("pre")?.textContent?.endsWith("完整簡介內容。")).toBe(true);
    expect(screen.queryByText(/開啟原檔/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "關閉來源預覽" }));

    fireEvent.click(screen.getByRole("button", { name: "預覽 流程圖.png" }));
    expect(await screen.findByRole("img", { name: "流程圖.png" })).toBeTruthy();
  });

  describe("source search", () => {
    const openSourcesPanel = async () => {
      const project = createProject({ topic: "來源搜尋", brief: { desiredSlideCount: 1 } });
      project.workflowStage = "editing";
      const now = new Date().toISOString();
      const source = (overrides: Partial<(typeof project.sources)[number]>) => ({
        id: "source",
        name: "來源.md",
        mediaType: "text/markdown",
        usage: "content" as const,
        allowModelAccess: true,
        status: "indexed" as const,
        assetPath: "assets/sources/source/來源.md",
        sizeBytes: 1024,
        extractedText: "",
        chunks: [],
        metadata: {},
        createdAt: now,
        updatedAt: now,
        ...overrides,
      });
      project.sources = [
        source({
          id: "margin-source",
          name: "財報摘要.md",
          assetPath: "assets/sources/margin-source/財報摘要.md",
          extractedText: "2024 年毛利率成長明顯，第二段再次提到毛利率。",
        }),
        source({
          id: "other-source",
          name: "訪談筆記.md",
          assetPath: "assets/sources/other-source/訪談筆記.md",
          extractedText: "受訪者談的是通路策略。",
        }),
        source({
          id: "image-source",
          name: "毛利率圖表.png",
          mediaType: "image/png",
          usage: "visual-reference",
          assetPath: "assets/sources/image-source/毛利率圖表.png",
        }),
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const path =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.pathname
                : new URL(input.url).pathname;
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
          if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
          if (path.includes("/readiness"))
            return Response.json({
              providerId: "mock-image",
              status: "ready",
              blocking: false,
              requiresAcknowledgement: false,
              message: "Ready",
              checkedAt: now,
              expiresAt: now,
            });
          return Response.json(project);
        }),
      );
      render(<Editor />);
      fireEvent.click(await screen.findByText("來源搜尋"));
      fireEvent.click(await screen.findByRole("button", { name: "來源 3" }));
      await screen.findByRole("button", { name: "預覽 財報摘要.md" });
      return screen.getByLabelText("搜尋來源");
    };

    it("filters the list to matching sources and reports how many matched", async () => {
      const search = await openSourcesPanel();
      fireEvent.change(search, { target: { value: "毛利率" } });

      expect(screen.getByText("2 / 3 份來源符合")).toBeTruthy();
      expect(screen.getByRole("button", { name: "預覽 財報摘要.md" })).toBeTruthy();
      // 圖片沒有擷取文字，只能靠檔名命中。
      expect(screen.getByRole("button", { name: "預覽 毛利率圖表.png" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "預覽 訪談筆記.md" })).toBeNull();
    });

    it("shows an empty state that clears the search", async () => {
      const search = await openSourcesPanel();
      fireEvent.change(search, { target: { value: "不存在的字" } });

      expect(screen.getByText("找不到符合的來源")).toBeTruthy();
      expect(screen.queryByText(/份來源符合/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "清除搜尋" }));

      expect((search as HTMLInputElement).value).toBe("");
      expect(screen.getByRole("button", { name: "預覽 訪談筆記.md" })).toBeTruthy();
    });

    it("highlights every hit in the preview, and explains a name-only match", async () => {
      const search = await openSourcesPanel();
      fireEvent.change(search, { target: { value: "毛利率" } });
      fireEvent.click(screen.getByRole("button", { name: "預覽 財報摘要.md" }));

      const dialog = await screen.findByRole("dialog", { name: "預覽來源：財報摘要.md" });
      const marks = dialog.querySelectorAll("pre mark");
      expect([...marks].map((mark) => mark.textContent)).toEqual(["毛利率", "毛利率"]);
      expect(dialog.querySelector("pre")?.textContent).toBe(
        "2024 年毛利率成長明顯，第二段再次提到毛利率。",
      );
      expect(screen.queryByText(/全文中未出現/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "關閉來源預覽" }));

      fireEvent.click(screen.getByRole("button", { name: "預覽 毛利率圖表.png" }));
      await screen.findByRole("dialog", { name: "預覽來源：毛利率圖表.png" });
      expect(screen.getByText(/全文中未出現/)).toBeTruthy();
    });
  });

  it("searches web sources and saves only confirmed results back to the project", async () => {
    let project = createProject({ topic: "搜尋來源", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    const results = [
      {
        url: "https://openai.com/agents",
        title: "OpenAI Agents Guide",
        summary: "Agent building guidance.",
      },
      {
        url: "https://example.com/secondary",
        title: "Secondary result",
        summary: "A second result.",
      },
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
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
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: now,
          expiresAt: now,
        });
      if (path.endsWith("/web-search")) return Response.json(results);
      if (path.endsWith("/web-sources")) {
        const selected = JSON.parse(String(init?.body)).sources as typeof results;
        expect(selected).toEqual([results[0]]);
        project = structuredClone(project);
        project.sources = [
          {
            id: "web-source-1",
            name: "OpenAI Agents Guide.md",
            mediaType: "text/markdown",
            usage: "content",
            allowModelAccess: true,
            status: "indexed",
            assetPath: "assets/sources/web-source-1/OpenAI Agents Guide.md",
            sizeBytes: 500,
            extractedText: "# OpenAI Agents Guide\n\n## 全文\n\nComplete captured article.",
            chunks: [{ id: "chunk-1", text: "Complete captured article." }],
            metadata: { url: results[0]!.url, contentStatus: "full" },
            createdAt: now,
            updatedAt: now,
          },
        ];
        return Response.json(project, { status: 201 });
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("搜尋來源"));
    fireEvent.click(await screen.findByRole("button", { name: "來源 0" }));
    fireEvent.click(await screen.findByText("＋ 從網路加入資料"));
    fireEvent.change(screen.getByLabelText("搜尋關鍵字"), {
      target: { value: "building AI agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜尋" }));

    expect(await screen.findByText("OpenAI Agents Guide")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/web-sources"))).toBe(
      false,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "加入所選來源（1）" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/web-sources"))).toBe(
        true,
      ),
    );
    expect(await screen.findByText("OpenAI Agents Guide.md")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "搜尋並加入資料" })).toBeNull();
  });

  it("uploads multiple selected files and creates an indexed source from pasted text", async () => {
    let project = createProject({ topic: "多來源輸入", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    const uploadedNames: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://local.test");
      if (url.pathname === "/api/projects" && !url.search) return Response.json([project]);
      if (url.pathname === "/api/providers")
        return Response.json([
          {
            id: "mock-image",
            name: "Mock",
            availability: { status: "available" },
            capabilities: { fullSlideGeneration: true },
          },
        ]);
      if (url.pathname === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (url.pathname.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: now,
          expiresAt: now,
        });
      if (url.pathname.endsWith("/sources") && init?.method === "POST") {
        const name = url.searchParams.get("name")!;
        uploadedNames.push(name);
        project = structuredClone(project);
        project.sources.push({
          id: `source-${uploadedNames.length}`,
          name,
          mediaType: url.searchParams.get("mediaType") ?? "text/markdown",
          usage: "content",
          allowModelAccess: true,
          status: "indexed",
          assetPath: `assets/sources/${uploadedNames.length}/${name}`,
          sizeBytes: 10,
          extractedText: name,
          chunks: [{ id: `chunk-${uploadedNames.length}`, text: name }],
          metadata: {},
          createdAt: now,
          updatedAt: now,
        });
        return Response.json(project, { status: 201 });
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("多來源輸入"));
    fireEvent.click(await screen.findByRole("button", { name: "來源 0" }));
    const input = screen.getByLabelText("上傳來源檔案") as HTMLInputElement;
    expect(input.multiple).toBe(true);
    fireEvent.change(input, {
      target: {
        files: [
          new File(["one"], "one.md", { type: "text/markdown" }),
          new File(["two"], "two.txt", { type: "text/plain" }),
        ],
      },
    });

    expect((await screen.findAllByText("one.md")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("two.txt")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("＋ 輸入文字"));
    expect(await screen.findByRole("dialog", { name: "輸入文字來源" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("文字來源名稱"), { target: { value: "貼上研究" } });
    fireEvent.change(screen.getByLabelText("文字來源內容"), {
      target: { value: "這是直接貼上的完整研究內容。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入文字來源" }));

    expect((await screen.findAllByText("貼上研究.md")).length).toBeGreaterThan(0);
    expect(uploadedNames).toEqual(["one.md", "two.txt", "貼上研究.md"]);
    expect(screen.queryByRole("dialog", { name: "輸入文字來源" })).toBeNull();
  });

  it("changes editing pages with arrow keys and opens keyboard-driven presentation mode", async () => {
    const project = createProject({ topic: "鍵盤與簡報模式", brief: { desiredSlideCount: 3 } });
    project.workflowStage = "editing";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
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
        return Response.json(project);
      }),
    );
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });

    render(<Editor />);
    fireEvent.click(await screen.findByText("鍵盤與簡報模式"));
    expect(await screen.findByDisplayValue(project.slides[0]!.purpose)).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByDisplayValue(project.slides[1]!.purpose)).toBeTruthy();
    const focusedInput = screen.getByDisplayValue(project.slides[1]!.purpose);
    fireEvent.keyDown(focusedInput, { key: "ArrowDown" });
    expect(screen.getByDisplayValue(project.slides[1]!.purpose)).toBeTruthy();

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("3 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "全螢幕簡報" })).toBeNull());
  });

  it("shows the previewed historical version in presentation mode for the selected slide", async () => {
    const project = createProject({ topic: "歷史版本簡報", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    project.slides[0]!.versions = [
      {
        id: "old-version",
        imagePath: "assets/generated/old-version.png",
        prompt: "old",
        providerId: "codex-image-spike",
        model: "codex-imagegen",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      },
      {
        id: "new-version",
        imagePath: "assets/generated/new-version.png",
        prompt: "new",
        providerId: "codex-image-spike",
        model: "codex-imagegen",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      },
    ];
    project.slides[0]!.currentVersionId = "new-version";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
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
        return Response.json(project);
      }),
    );
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });

    render(<Editor />);
    fireEvent.click(await screen.findByText("歷史版本簡報"));
    expect(await screen.findByDisplayValue(project.slides[0]!.purpose)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "版本 1" }));
    expect(await screen.findByText("正在預覽歷史版本")).toBeTruthy();

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    const slideImage = screen.getByAltText("簡報第 1 頁");
    expect(slideImage.getAttribute("src")).toContain("old-version.png");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "全螢幕簡報" })).toBeNull());
  });

  it("opens current-image editing and submits an instruction without replacing the base version", async () => {
    const project = createProject({ topic: "圖片局部編輯", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    project.slides[0]!.versions = [
      {
        id: "base-version",
        imagePath: "assets/generated/base.png",
        prompt: "base",
        providerId: "codex-image-spike",
        model: "codex-imagegen",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      },
    ];
    project.slides[0]!.currentVersionId = "base-version";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/projects") return Response.json([project]);
      if (path === "/api/providers")
        return Response.json([
          {
            id: "mock-image",
            name: "Mock",
            availability: { status: "available" },
            capabilities: { fullSlideGeneration: true, imageEditing: true, maskedEditing: true },
          },
        ]);
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: now,
          expiresAt: now,
        });
      if (path.endsWith("/edit-image"))
        return Response.json(
          {
            id: "edit-job",
            projectId: project.id,
            slideId: project.slides[0]!.id,
            providerId: "mock-image",
            status: "queued",
            operation: "edit",
            attempt: 0,
            createdAt: now,
            updatedAt: now,
          },
          { status: 202 },
        );
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("圖片局部編輯"));
    fireEvent.click(await screen.findByText("編輯當頁圖片"));
    expect(await screen.findByRole("dialog", { name: "編輯當頁圖片" })).toBeTruthy();
    // 框選不再需要先勾選開關：進來就能直接在圖上拖曳，不框選則整張套用。
    expect(screen.getByText("直接在圖上拖曳即可限定修改範圍")).toBeTruthy();
    expect(screen.queryByText("限制修改範圍（框選）")).toBeNull();
    expect(screen.queryByLabelText("遮罩筆刷大小")).toBeNull();
    fireEvent.change(screen.getByLabelText("圖片修改說明"), {
      target: { value: "只調整右上角圖示" },
    });
    fireEvent.click(screen.getByText("套用修改 →"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/edit-image$/),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("只調整右上角圖示"),
        }),
      ),
    );
  });

  const extractionProject = () => {
    const project = createProject({ topic: "文字抽離測試專案", brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    project.slides[0]!.versions = [
      {
        id: "base-version",
        imagePath: "assets/generated/base.png",
        prompt: "base",
        providerId: "mock-image",
        model: "mock-svg-v1",
        parameters: {},
        styleVersion: 1,
        sources: [],
        createdAt: now,
      },
    ];
    project.slides[0]!.currentVersionId = "base-version";
    return project;
  };

  const extractionFetchMock = (project: ReturnType<typeof createProject>, maskedEditing: boolean) =>
    vi.fn(async (input: string | URL | Request) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      const now = new Date().toISOString();
      if (path === "/api/projects") return Response.json([project]);
      if (path === "/api/providers")
        return Response.json([
          {
            id: "mock-image",
            name: "Mock",
            availability: { status: "available" },
            capabilities: { fullSlideGeneration: true, imageEditing: true, maskedEditing },
          },
        ]);
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: now,
          expiresAt: now,
        });
      if (path === "/api/ocr/status") return Response.json({ available: true, message: "ok" });
      if (path.endsWith("/extract-text"))
        return Response.json(
          {
            id: "extract-job",
            projectId: project.id,
            slideId: project.slides[0]!.id,
            providerId: "local-inpaint",
            status: "queued",
            operation: "extract-text",
            attempt: 0,
            createdAt: now,
            updatedAt: now,
          },
          { status: 202 },
        );
      return Response.json(project);
    });

  it("抽離文字預設走 OpenCV 引擎（providerId local-inpaint），不受生圖模型 maskedEditing 限制", async () => {
    const project = extractionProject();
    // 生圖模型不支援 maskedEditing 也不影響 OpenCV 引擎（本機跑）。
    const fetchMock = extractionFetchMock(project, false);
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    // 點專案標題開啟專案（進入編輯器）；「抽離文字」按鈕在屬性面板中預設可見，
    // 不需要展開選項——早先誤把專案標題「抽離文字引擎」當成引擎控制的寫法已移除。
    fireEvent.click(await screen.findByText("文字抽離測試專案"));
    const extractButton = await screen.findByRole("button", { name: "抽離文字" });
    expect((extractButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(extractButton);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/extract-text$/),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"providerId":"local-inpaint"'),
        }),
      ),
    );

    // 切到「生圖模型」：模型不支援 maskedEditing 時按鈕停用。
    fireEvent.click(screen.getByRole("button", { name: "調整文字抽離選項" }));
    fireEvent.change(await screen.findByLabelText("抹字引擎"), { target: { value: "model" } });
    expect((screen.getByRole("button", { name: "抽離文字" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("選「生圖模型」時帶組合解析出的影像 providerId", async () => {
    const project = extractionProject();
    const fetchMock = extractionFetchMock(project, true);
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    // 開啟專案後，展開真正的「調整文字抽離選項」toggle 才會出現抹字引擎下拉。
    fireEvent.click(await screen.findByText("文字抽離測試專案"));
    fireEvent.click(await screen.findByRole("button", { name: "調整文字抽離選項" }));
    const engineSelect = (await screen.findByLabelText("抹字引擎")) as HTMLSelectElement;
    expect(engineSelect.value).toBe("opencv");
    fireEvent.change(engineSelect, { target: { value: "model" } });
    fireEvent.click(screen.getByRole("button", { name: "抽離文字" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/extract-text$/),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"providerId":"mock-image"'),
        }),
      ),
    );
  });

  it("opens a project and exposes slide, source, project and export workflows", async () => {
    const project = createProject({
      topic: "UI 測試專案",
      brief: { desiredSlideCount: 2, audience: "工程團隊" },
    });
    project.workflowStage = "editing";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;
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
        return Response.json(project);
      }),
    );

    render(<Editor />);
    fireEvent.click(await screen.findByText("UI 測試專案"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    expect(screen.queryByText("批次生成全部頁面")).toBeNull();
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("批次生成全部頁面")).toBeTruthy();

    fireEvent.click(screen.getAllByText("來源")[0]!);
    expect(await screen.findByText("＋ 上傳來源檔案")).toBeTruthy();
    fireEvent.click(screen.getAllByText("專案")[0]!);
    expect(await screen.findByText("PROJECT BRIEF")).toBeTruthy();
    expect(screen.getByDisplayValue("工程團隊")).toBeTruthy();
    fireEvent.click(screen.getAllByText("匯出")[0]!);
    expect(await screen.findByText(/PowerPoint/)).toBeTruthy();
    expect(screen.getByText(/完整專案/)).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it("uses the confirmed outline length and starts full-deck generation immediately after step two", async () => {
    let project = createProject({ topic: "不預設三頁的流程", brief: { desiredSlideCount: 4 } });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/projects" && method === "GET") return Response.json([project]);
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
      if (path.endsWith("/brief") && method === "PATCH") {
        project = { ...project, brief: { ...project.brief, ...JSON.parse(String(init?.body)) } };
        return Response.json(project);
      }
      if (path.endsWith("/outline") && method === "POST") {
        project = {
          ...project,
          workflowStage: "settings",
          slides: createSlidesFromBrief(project.brief),
        };
        return Response.json(project);
      }
      if (/\/slides\/[^/]+$/.test(path) && method === "PATCH") return Response.json(project);
      if (/\/api\/projects\/[^/]+\/generate$/.test(path) && method === "POST") {
        project = { ...project, workflowStage: "editing" };
        return Response.json(project.slides.map((slide) => ({ id: `job-${slide.id}` })));
      }
      if (path.endsWith("/api/text-providers") && method === "GET")
        return Response.json([
          {
            id: "openai",
            name: "OpenAI 相容（Gemini 等）",
            availability: { status: "available" },
            isDefault: true,
          },
        ]);
      if (/\/api\/projects\/[^/]+$/.test(path) && method === "GET") return Response.json(project);
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("不預設三頁的流程"));
    expect(await screen.findByText("STEP 2 · 需求")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("簡報頁數"), { target: { value: "7" } });
    fireEvent.click(screen.getByText("下一步：上傳素材"));
    expect(await screen.findByText("STEP 3 · 上傳素材")).toBeTruthy();
    fireEvent.click(screen.getByText("產生 7 頁大綱"));
    expect(await screen.findByText("確認設定並生成 7 頁簡報")).toBeTruthy();
    expect(screen.getByText(/全部 7 頁/)).toBeTruthy();
    fireEvent.click(screen.getByText("確認設定並生成 7 頁簡報"));

    // 生成流程改為組合驅動：client 不再送 providerId，由 server 依專案組合解析影像模型。
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/projects\/[^/]+\/generate$/),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ acceptUnknownReadiness: false }),
        }),
      ),
    );
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
  });
});

describe("簡報級頁碼", () => {
  function pageNumberProject(topic: string) {
    const project = createProject({ topic, brief: { desiredSlideCount: 3 } });
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

  /** 專案級 PATCH 直接把 patch 併回同一份專案，模擬 server 的部分更新語意。 */
  function stubApi(state: { project: ReturnType<typeof pageNumberProject> }) {
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
      if (path.endsWith("/page-number") && init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown> & {
          background?: Record<string, unknown>;
        };
        state.project = {
          ...state.project,
          pageNumber: {
            ...state.project.pageNumber,
            ...patch,
            background: { ...state.project.pageNumber.background, ...patch.background },
          },
        };
        return Response.json(state.project);
      }
      return Response.json(state.project);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("疊出頁碼並跳過封面，數字與匯出用的同一份計算一致", async () => {
    const state = { project: pageNumberProject("頁碼疊圖") };
    state.project.pageNumber = {
      ...state.project.pageNumber,
      enabled: true,
      skipFirstSlide: true,
      format: "zh-page",
    };
    stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("頁碼疊圖"));
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
    // 封面不編號：畫布上不該出現任何頁碼。
    expect(document.querySelector(".page-number-layer")).toBeNull();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByText("第 1 頁")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByText("第 2 頁")).toBeTruthy();
    // 位置以百分比座標定位，預覽與匯出共用同一份 pageNumberLayout。
    const text = document.querySelector<HTMLElement>(".page-number-text")!;
    expect(text.style.left).toBe(`${(63 / 1920) * 100}%`);
    expect(text.style.justifyContent).toBe("flex-end");
  });

  it("關閉時畫布上沒有頁碼", async () => {
    const state = { project: pageNumberProject("頁碼關閉") };
    stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("頁碼關閉"));
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByDisplayValue(state.project.slides[1]!.purpose)).toBeTruthy();
    expect(document.querySelector(".page-number-layer")).toBeNull();
  });

  it("設定面板即時送出部分更新，並讓畫布預覽跟著變", async () => {
    const state = { project: pageNumberProject("頁碼設定面板") };
    const fetchMock = stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("頁碼設定面板"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();
    // 關閉時只有啟用開關，其餘設定不佔面板空間。
    expect(screen.queryByLabelText("位置")).toBeNull();

    fireEvent.click(screen.getByLabelText("顯示頁碼"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/page-number$/),
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true }) }),
      ),
    );
    // 預設 skipFirstSlide，第二頁顯示 1。
    expect(await screen.findByText("1")).toBeTruthy();

    fireEvent.change(await screen.findByLabelText("格式"), { target: { value: "number-total" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/page-number$/),
        expect.objectContaining({ body: JSON.stringify({ format: "number-total" }) }),
      ),
    );
    // 三頁、跳封面 → 總數是 2，不是投影片張數 3。
    expect(await screen.findByText("1 / 2")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("加上背景色塊"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/page-number$/),
        expect.objectContaining({ body: JSON.stringify({ background: { enabled: true } }) }),
      ),
    );
    expect(await screen.findByLabelText("色塊顏色")).toBeTruthy();

    // 數字欄位是失焦／Enter 才送出的（每個 keystroke 就送會讓兩位數永遠打不進去，
    // 見「兩位數字級打得進去」那條）。
    const startAt = screen.getByLabelText("起始頁碼");
    fireEvent.change(startAt, { target: { value: "10" } });
    fireEvent.blur(startAt);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/page-number$/),
        expect.objectContaining({ body: JSON.stringify({ startAt: 10 }) }),
      ),
    );
    expect(await screen.findByText("10 / 11")).toBeTruthy();
  });

  it("其餘每個控制項都各自送出只含自己那一欄的 PATCH", async () => {
    // 面板上任一控制項若順手把整份設定重送，使用者在另一台裝置的調整就會被覆蓋；
    // 逐一鎖住「只送自己那一欄」才擋得住這種回歸。
    const state = { project: pageNumberProject("頁碼逐欄更新") };
    state.project.pageNumber = { ...state.project.pageNumber, enabled: true };
    const fetchMock = stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("頁碼逐欄更新"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();

    const expectPatch = async (body: unknown) =>
      waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringMatching(/\/page-number$/),
          expect.objectContaining({ method: "PATCH", body: JSON.stringify(body) }),
        ),
      );

    fireEvent.change(screen.getByLabelText("位置"), { target: { value: "bottom-left" } });
    await expectPatch({ position: "bottom-left" });
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".page-number-text")!.style.justifyContent).toBe(
        "flex-start",
      ),
    );

    fireEvent.click(screen.getByLabelText("封面不編號"));
    await expectPatch({ skipFirstSlide: false });

    // 數字欄位延後到失焦／Enter 才送；滑桿與色票 debounce 後才送。兩者都只帶自己那一欄。
    const fontSize = screen.getByLabelText("字級");
    fireEvent.change(fontSize, { target: { value: "48" } });
    fireEvent.blur(fontSize);
    await expectPatch({ fontSize: 48 });

    fireEvent.change(screen.getByLabelText("顏色"), { target: { value: "#ff0000" } });
    await expectPatch({ color: "#ff0000" });

    fireEvent.change(screen.getByLabelText("透明度"), { target: { value: "0.5" } });
    await expectPatch({ opacity: 0.5 });

    fireEvent.click(screen.getByLabelText("顯示頁碼"));
    await expectPatch({ enabled: false });
    // 關閉後畫布立刻不再有頁碼，面板也收起其餘欄位。
    await waitFor(() => expect(document.querySelector(".page-number-layer")).toBeNull());
    expect(screen.queryByLabelText("位置")).toBeNull();
  });

  it("關閉封面不編號後，封面立刻長出頁碼", async () => {
    const state = { project: pageNumberProject("封面編號") };
    state.project.pageNumber = {
      ...state.project.pageNumber,
      enabled: true,
      skipFirstSlide: true,
    };
    stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("封面編號"));
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
    expect(document.querySelector(".page-number-layer")).toBeNull();

    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("封面不編號"));

    // 停留在封面：原本沒有頁碼的那一頁現在顯示 1。
    expect(await screen.findByText("1")).toBeTruthy();
    expect(document.querySelector(".page-number-text")!.textContent).toBe("1");
  });

  it("簡報模式把頁碼疊在圖片矩形上，而不是整個舞台", async () => {
    const state = { project: pageNumberProject("簡報模式頁碼") };
    state.project.pageNumber = {
      ...state.project.pageNumber,
      enabled: true,
      skipFirstSlide: true,
      format: "number-total",
    };
    stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("簡報模式頁碼"));
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByDisplayValue(state.project.slides[1]!.purpose)).toBeTruthy();

    fireEvent.click(screen.getByText("▶ 簡報模式"));
    const stage = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".presentation-stage");
      if (!element) throw new Error("presentation stage not rendered");
      return element;
    });
    // 頁碼必須是圖片矩形的子節點，否則 letterbox 留下的黑邊會讓它偏離畫面。
    expect(stage.querySelector(".page-number-text")!.textContent).toBe("1 / 2");
    // 舞台是「兩軸都算死」的精確畫布比例，不是 aspect-ratio。用 aspect-ratio 搭
    // height: 100% + max-width: 100% 時，grid 的 auto track 會照 max-content 撐開再溢出，
    // `.presentation-mode` 的 overflow: hidden 就把右側連同右下角頁碼切掉
    // （實測 1000×800 視窗算出 1422×800）。長度單位取 `.presentation-surface` 的容器查詢
    // 單位而非 vw／vh：vw／vh 不扣傳統捲軸寬度，會比固定覆蓋層多出約 15px。
    expect(stage.style.aspectRatio).toBe("");
    // CSS 解析器會把 calc() 收斂成單一係數，所以比對算出來的數字而不是原始字串。
    const scale = (declaration: string, self: "cqw" | "cqh") => {
      const other = self === "cqw" ? "cqh" : "cqw";
      const match = new RegExp(`^min\\(100${self}, ([0-9.]+)${other}\\)$`).exec(declaration);
      if (!match) throw new Error(`舞台尺寸不是 min(100${self}, k${other}) 的形式：${declaration}`);
      return Number(match[1]);
    };
    expect(scale(stage.style.width, "cqw")).toBeCloseTo((1920 / 1080) * 100, 6);
    expect(scale(stage.style.height, "cqh")).toBeCloseTo((1080 / 1920) * 100, 6);

    // 翻到下一頁，簡報模式的數字跟著走。
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(document.querySelector(".presentation-stage .page-number-text")!.textContent).toBe(
        "2 / 2",
      ),
    );
  });

  it("編輯畫布以 --ar 供 CSS 算出精確比例，而不是 aspect-ratio", async () => {
    // `.page-number-layer` 是貼著 `.canvas` 的 inset: 0。`.canvas` 的比例只要不精確，
    // `object-fit: contain` 就會留出灰邊，頁碼落進灰邊裡、與匯出對不上。
    // aspect-ratio 搭 height: 100% + max-width: 100% 會失效（高度已是定值，寬度被夾住後
    // 比例直接無效；實測 540×671.5 而非 16:9），所以改由 CSS 用 --ar 算死兩軸。
    const state = { project: pageNumberProject("畫布比例") };
    state.project.pageNumber = { ...state.project.pageNumber, enabled: true };
    stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("畫布比例"));
    expect(await screen.findByDisplayValue(state.project.slides[0]!.purpose)).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });

    const canvas = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".canvas");
      if (!element) throw new Error("canvas not rendered");
      return element;
    });
    expect(canvas.style.aspectRatio).toBe("");
    expect(canvas.style.getPropertyValue("--ar")).toBe(String(1920 / 1080));
    // 頁碼疊層必須掛在同一個 `.canvas` 上，兩者的座標系才是同一個。
    expect(canvas.querySelector(".page-number-layer")).not.toBeNull();
  });

  it("兩位數字級打得進去：打字期間不送出、也不被伺服器打回舊值", async () => {
    // 每個 keystroke 就送 PATCH 的話，30 → 45 會先送出 `4`（違反 min 12）而 400，
    // 受控 input 當場被打回 30——12–120 區間裡每個值的首位數字都小於下界，必中。
    const state = { project: pageNumberProject("字級鍵盤輸入") };
    state.project.pageNumber = { ...state.project.pageNumber, enabled: true };
    const fetchMock = stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("字級鍵盤輸入"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();

    const fontSize = screen.getByLabelText("字級") as HTMLInputElement;
    const patches = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/page-number"));
    expect(fontSize.value).toBe("30");

    // 模擬「全選後打 4、再打 5」：中途不得送出，欄位也不得被打回 30。
    fireEvent.change(fontSize, { target: { value: "4" } });
    expect(fontSize.value).toBe("4");
    expect(patches()).toHaveLength(0);
    fireEvent.change(fontSize, { target: { value: "45" } });
    expect(fontSize.value).toBe("45");
    expect(patches()).toHaveLength(0);

    fireEvent.blur(fontSize);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ fontSize: 45 });
    await waitFor(() => expect(state.project.pageNumber.fontSize).toBe(45));
    expect(fontSize.value).toBe("45");
  });

  it("數字欄位按 Enter 也送出，越界值先夾進區間，空字串則還原", async () => {
    const state = { project: pageNumberProject("字級邊界輸入") };
    state.project.pageNumber = { ...state.project.pageNumber, enabled: true };
    const fetchMock = stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("字級邊界輸入"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();
    const patches = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/page-number"));

    const fontSize = screen.getByLabelText("字級") as HTMLInputElement;
    fireEvent.change(fontSize, { target: { value: "999" } });
    fireEvent.keyDown(fontSize, { key: "Enter" });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ fontSize: 120 });
    await waitFor(() => expect(fontSize.value).toBe("120"));

    // 清空欄位不得送出 `Number("") === 0`（違反 min，必然 400），而是還原成現值。
    const startAt = screen.getByLabelText("起始頁碼") as HTMLInputElement;
    fireEvent.change(startAt, { target: { value: "" } });
    fireEvent.blur(startAt);
    expect(startAt.value).toBe("1");
    expect(patches()).toHaveLength(1);
  });

  it("拖曳滑桿只在停手後送一次 PATCH，畫布卻是即時跟著動的", async () => {
    // 每個 change 都送的話，一次拖曳會連發數十筆，每筆都讓伺服器「取檔鎖 → 讀 project.json
    // → 全量 zod 驗證 → 原子寫」跑一趟；150 頁 PDF 匯入專案的 project.json 相當大。
    const state = { project: pageNumberProject("透明度拖曳") };
    state.project.pageNumber = { ...state.project.pageNumber, enabled: true };
    const fetchMock = stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("透明度拖曳"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();
    const patches = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/page-number"));

    const opacity = screen.getByLabelText("透明度");
    for (const value of ["0.7", "0.6", "0.5", "0.4", "0.3"])
      fireEvent.change(opacity, { target: { value } });

    // 樂觀值讓預覽在請求送出前就已經是最後一格的值。
    expect(document.querySelector<HTMLElement>(".page-number-text")!.style.opacity).toBe("0.3");
    expect(patches()).toHaveLength(0);

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({ opacity: 0.3 });
    // debounce 視窗過後不會再補送中間那幾格。
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(patches()).toHaveLength(1);
    expect(state.project.pageNumber.opacity).toBe(0.3);
  });

  it("debounce 期間改到別的欄位時，兩個欄位併成同一筆送出，不會有人被吃掉", async () => {
    const state = { project: pageNumberProject("色塊連續調整") };
    state.project.pageNumber = {
      ...state.project.pageNumber,
      enabled: true,
      background: { ...state.project.pageNumber.background, enabled: true },
    };
    const fetchMock = stubApi(state);

    render(<Editor />);
    fireEvent.click(await screen.findByText("色塊連續調整"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();
    const patches = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/page-number"));

    fireEvent.change(screen.getByLabelText("色塊顏色"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("色塊透明度"), { target: { value: "0.6" } });

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]![1]!.body))).toEqual({
      background: { color: "#112233", opacity: 0.6 },
    });
    await waitFor(() => expect(state.project.pageNumber.background.color).toBe("#112233"));
    expect(state.project.pageNumber.background.opacity).toBe(0.6);
  });

  it("回應亂序時 UI 停在最新的值，不會被較早的那筆蓋回去", async () => {
    // 兩筆在途時，先送的那筆若晚回來，無條件 setProject 會讓滑桿與畫布跳回舊值。
    const state = { project: pageNumberProject("亂序回應") };
    state.project.pageNumber = { ...state.project.pageNumber, enabled: true };
    const fetchMock = stubApi(state);
    const gate: (() => void)[] = [];
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (!String(input).endsWith("/page-number")) return response;
      // 第一筆頁碼 PATCH 卡住，等第二筆回來後才放行。
      if (gate.length === 0) await new Promise<void>((resolve) => gate.push(resolve));
      return response;
    });

    render(<Editor />);
    fireEvent.click(await screen.findByText("亂序回應"));
    expect(await screen.findByText("SLIDE SPEC")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.click(screen.getByText("設定"));
    expect(await screen.findByText("PAGE NUMBER")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("位置"), { target: { value: "bottom-left" } });
    await waitFor(() => expect(gate).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("位置"), { target: { value: "bottom-center" } });
    await waitFor(() => expect(state.project.pageNumber.position).toBe("bottom-center"));

    // 卡住的第一筆現在才回來，帶的是 bottom-left 那個時間點的專案。
    gate[0]!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector<HTMLElement>(".page-number-text")!.style.justifyContent).toBe(
      "center",
    );
    expect((screen.getByLabelText("位置") as HTMLSelectElement).value).toBe("bottom-center");
  });
});

describe("STEP 3 自動搜尋網路資源", () => {
  // systemSettings 是模組層單例，測試間必須重置，否則關掉的自動搜尋會漏到下一個測試。
  afterEach(() => resetSystemSettings());

  const STORAGE_KEY = "slide-maker:system-settings";
  const storedWebSearchMode = (): unknown =>
    (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { webSearchMode?: unknown })
      .webSearchMode;

  const materialsStep = async (sources: PresentationProject["sources"]) => {
    const now = new Date().toISOString();
    let project: PresentationProject = {
      ...createProject({ topic: "自動搜尋開關", brief: { desiredSlideCount: 3 } }),
      sources,
    };
    // 每一筆 PATCH /brief 的 body（App 層同步與 produceOutline 都會經過這裡）。
    const briefPatches: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://local.test");
      const path = url.pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/projects" && method === "GET") return Response.json([project]);
      if (path === "/api/providers")
        return Response.json([
          {
            id: "mock-image",
            name: "Mock",
            availability: { status: "available" },
            capabilities: { fullSlideGeneration: true },
          },
        ]);
      if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
      if (path === "/api/model-library")
        return Response.json({ connections: [], models: [], combinations: [] });
      if (path === "/api/text-providers") return Response.json([]);
      if (path.includes("/readiness"))
        return Response.json({
          providerId: "mock-image",
          status: "ready",
          blocking: false,
          requiresAcknowledgement: false,
          message: "Ready",
          checkedAt: now,
          expiresAt: now,
        });
      if (path.endsWith("/brief") && method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        briefPatches.push(patch);
        project = { ...project, brief: { ...project.brief, ...patch } };
        return Response.json(project);
      }
      if (path.endsWith("/sources") && method === "POST") {
        const name = url.searchParams.get("name") ?? "素材.md";
        project = structuredClone(project);
        project.sources.push({
          id: `uploaded-${project.sources.length + 1}`,
          name,
          mediaType: url.searchParams.get("mediaType") ?? "text/markdown",
          usage: "content",
          allowModelAccess: true,
          status: "indexed",
          assetPath: `assets/sources/uploaded/${name}`,
          sizeBytes: 12,
          extractedText: name,
          chunks: [{ id: `chunk-${project.sources.length + 1}`, text: name }],
          metadata: {},
          createdAt: now,
          updatedAt: now,
        });
        return Response.json(project, { status: 201 });
      }
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Editor />);
    fireEvent.click(await screen.findByText("自動搜尋開關"));
    expect(await screen.findByText("STEP 2 · 需求")).toBeTruthy();
    fireEvent.click(screen.getByText("下一步：上傳素材"));
    expect(await screen.findByText("STEP 3 · 上傳素材")).toBeTruthy();
    return {
      fetchMock,
      briefPatches,
      toggle: screen.getByLabelText("自動搜尋網路資源") as HTMLInputElement,
      submit: screen.getByRole("button", { name: /產生 3 頁大綱/ }) as HTMLButtonElement,
    };
  };

  // produceOutline 送出整份 brief（含 topic）；STEP 2 的「下一步」也會送整份 brief，
  // App 層同步則只帶 webSearchMode，所以要從按下產生大綱之後的那批 patch 裡找。
  const outlinePatch = (
    briefPatches: Record<string, unknown>[],
    fromIndex: number,
  ): Record<string, unknown> => {
    const patch = briefPatches.slice(fromIndex).find((entry) => "topic" in entry);
    expect(patch).toBeTruthy();
    return patch!;
  };

  const textSource = (): PresentationProject["sources"] => {
    const now = new Date().toISOString();
    return [
      {
        id: "text-source",
        name: "研究摘要.md",
        mediaType: "text/markdown",
        usage: "content",
        allowModelAccess: true,
        status: "indexed",
        assetPath: "assets/sources/text-source/研究摘要.md",
        sizeBytes: 2048,
        extractedText: "已經有素材了。",
        chunks: [{ id: "chunk-1", text: "已經有素材了。" }],
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    ];
  };

  const imageSource = (): PresentationProject["sources"] => {
    const now = new Date().toISOString();
    return [
      {
        id: "image-source",
        name: "示意圖.png",
        mediaType: "image/png",
        usage: "visual-reference",
        allowModelAccess: true,
        status: "indexed",
        assetPath: "assets/sources/image-source/示意圖.png",
        sizeBytes: 4096,
        extractedText: "",
        chunks: [],
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    ];
  };

  const failedSource = (): PresentationProject["sources"] => {
    const now = new Date().toISOString();
    return [
      {
        id: "failed-source",
        name: "壞掉的檔.pdf",
        mediaType: "application/pdf",
        usage: "content",
        allowModelAccess: true,
        status: "failed",
        assetPath: "assets/sources/failed-source/壞掉的檔.pdf",
        sizeBytes: 1024,
        extractedText: "",
        chunks: [],
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    ];
  };

  it("關掉自動搜尋且沒有素材時擋住產生大綱，並說明原因", async () => {
    const { toggle, submit, fetchMock } = await materialsStep([]);
    expect(toggle.checked).toBe(true);
    expect(submit.disabled).toBe(false);

    fireEvent.click(toggle);

    expect((screen.getByLabelText("自動搜尋網路資源") as HTMLInputElement).checked).toBe(false);
    expect(
      (screen.getByRole("button", { name: /產生 3 頁大綱/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/已關閉自動搜尋，請先上傳或貼上至少一項素材/)).toBeTruthy();
    // 勾選狀態寫進 systemSettings，App 層才會把它同步回專案 brief。
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/projects\/[^/]+\/brief$/),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ webSearchMode: "disabled" }),
        }),
      ),
    );
  });

  it("開著自動搜尋時，沒有素材也能產生大綱", async () => {
    const { toggle, submit } = await materialsStep([]);
    expect(toggle.checked).toBe(true);
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText(/已關閉自動搜尋/)).toBeNull();
  });

  it("關掉自動搜尋但已有素材時仍可產生大綱", async () => {
    const { toggle } = await materialsStep(textSource());
    fireEvent.click(toggle);
    expect(
      (screen.getByRole("button", { name: /產生 3 頁大綱/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText(/已關閉自動搜尋/)).toBeNull();
  });

  it("關掉自動搜尋時，圖片素材也算數，可產生大綱", async () => {
    const { toggle } = await materialsStep(imageSource());
    fireEvent.click(toggle);
    expect(
      (screen.getByRole("button", { name: /產生 3 頁大綱/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText(/已關閉自動搜尋/)).toBeNull();
  });

  it("關掉自動搜尋時，只有解析失敗的素材仍視為沒有素材", async () => {
    const { toggle } = await materialsStep(failedSource());
    fireEvent.click(toggle);
    expect(
      (screen.getByRole("button", { name: /產生 3 頁大綱/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/已關閉自動搜尋，請先上傳或貼上至少一項素材/)).toBeTruthy();
  });

  it("素材從 0 變 1 時解鎖產生大綱按鈕", async () => {
    const { toggle } = await materialsStep([]);
    fireEvent.click(toggle);
    expect(
      (screen.getByRole("button", { name: /產生 3 頁大綱/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("上傳來源檔案"), {
      target: { files: [new File(["研究"], "研究.md", { type: "text/markdown" })] },
    });

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /產生 3 頁大綱/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(/已關閉自動搜尋/)).toBeNull();
    // 自動搜尋仍是關的，解鎖純粹來自素材數量。
    expect((screen.getByLabelText("自動搜尋網路資源") as HTMLInputElement).checked).toBe(false);
  });

  it("localStorage 既有的 cached 視為已勾選，產生大綱時原樣送出而不改寫成 live", async () => {
    // resetSystemSettings() 會把 DEFAULTS（webSearchMode: "cached"）寫進 localStorage，
    // 等同「使用者上次留下 cached」的既有狀態。
    resetSystemSettings();
    expect(storedWebSearchMode()).toBe("cached");

    const { toggle, submit, briefPatches } = await materialsStep([]);
    expect(toggle.checked).toBe(true);

    const before = briefPatches.length;
    fireEvent.click(submit);

    await waitFor(() => expect(outlinePatch(briefPatches, before).webSearchMode).toBe("cached"));
    expect(briefPatches.some((patch) => patch.webSearchMode === "live")).toBe(false);
    expect(storedWebSearchMode()).toBe("cached");
  });

  it("重新勾選自動搜尋會寫回 live，並隨產生大綱一起送出", async () => {
    const { toggle, briefPatches } = await materialsStep([]);

    fireEvent.click(toggle);
    expect(storedWebSearchMode()).toBe("disabled");
    fireEvent.click(screen.getByLabelText("自動搜尋網路資源"));
    expect(storedWebSearchMode()).toBe("live");
    expect((screen.getByLabelText("自動搜尋網路資源") as HTMLInputElement).checked).toBe(true);

    const before = briefPatches.length;
    fireEvent.click(screen.getByRole("button", { name: /產生 3 頁大綱/ }));

    await waitFor(() => expect(outlinePatch(briefPatches, before).webSearchMode).toBe("live"));
  });

  it("關閉自動搜尋後產生大綱，PATCH /brief 帶的是 disabled", async () => {
    const { toggle, briefPatches } = await materialsStep(textSource());

    fireEvent.click(toggle);
    const before = briefPatches.length;
    fireEvent.click(screen.getByRole("button", { name: /產生 3 頁大綱/ }));

    await waitFor(() => expect(outlinePatch(briefPatches, before).webSearchMode).toBe("disabled"));
  });

  it("STEP 1 不再有 Web Search 下拉，只留模型組合", async () => {
    await materialsStep([]);
    const step1 = screen.getByRole("region", { name: "選擇模型組合" });
    expect(within(step1).queryByLabelText("Web Search")).toBeNull();
    expect(within(step1).getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByText("Live（即時搜尋）")).toBeNull();
  });
});

describe("文字圖層鍵盤快捷鍵", () => {
  // 其中一條會開系統設定對話框；不重置的話設定會漏到後面的測試。
  // 另有一條會把網址推到 /styles 去驗路由 gate：不推回來的話，後面測試裡新掛的 Editor
  // 會以 /styles 當初始路由開在風格庫畫面，連專案都點不到。
  afterEach(() => {
    resetSystemSettings();
    window.history.pushState({}, "", "/");
  });

  /** 兩頁都帶可編輯文字圖層的專案：進入專案就會直接是文字圖層編輯狀態。 */
  function textLayerProject(
    topic: string,
    boxOverrides: Partial<import("@slide-maker/core").EditableTextBox> = {},
  ) {
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
            boxes: [makeBox({ id: `${slide.id}-text-1`, ...boxOverrides })],
            extractedAt: now,
            updatedAt: now,
          },
        },
      ];
      slide.currentVersionId = `${slide.id}-v1`;
    }
    return project;
  }

  function stubTextLayerApi(
    project: PresentationProject,
    // 「編輯當頁圖片」按鈕要 provider 具備 imageEditing 才會啟用，開得了對話框才驗得到 gate。
    capabilities: Record<string, boolean> = { fullSlideGeneration: true },
  ) {
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
            capabilities,
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

  /**
   * 會把 PUT /text-layer 的內容寫回專案物件的 stub。
   *
   * 切頁再切回來時文字框是從專案重新播種的；不落地的話，連「已經存好的編輯」在切回來時
   * 都會憑空消失，就分不出哪些是真的沒存到。
   */
  function stubPersistingTextLayerApi(project: PresentationProject) {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      const written = /\/slides\/([^/]+)\/versions\/([^/]+)\/text-layer$/.exec(path);
      if (written && init?.method === "PUT") {
        const version = project.slides
          .find((slide) => slide.id === decodeURIComponent(written[1]!))
          ?.versions.find((candidate) => candidate.id === decodeURIComponent(written[2]!));
        const body = JSON.parse(String(init.body)) as {
          boxes: import("@slide-maker/core").EditableTextBox[];
        };
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
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** 等畫布真的換到指定那一頁；兩頁框數一樣時，只看框數是分不出來的。 */
  const waitForSlide = (slideId: string) =>
    waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".text-layer-canvas img")!.src).toContain(
        slideId,
      ),
    );

  /** 進入專案並回傳畫布上的文字框元素（依 DOM 順序，與 textBoxes 陣列同序）。 */
  const enterProject = async (topic: string) => {
    fireEvent.click(await screen.findByText(topic));
    await screen.findByLabelText("可編輯簡報文字");
  };
  const boxElements = () => [...document.querySelectorAll<HTMLElement>(".editable-text-box")];

  it("複製再貼上會多一個文字框，且階梯式錯開不疊在原位", async () => {
    const project = textLayerProject("文字框複製貼上");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("文字框複製貼上");
    fireEvent.pointerDown(boxElements()[0]!);

    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    // 位置以百分比定位；來源 x=100 → 副本 x=124（+24）。
    expect(boxElements()[1]!.style.left).toBe(`${(124 / 1920) * 100}%`);
    expect(boxElements()[1]!.style.top).toBe(`${(104 / 1080) * 100}%`);

    // 連續貼上要再往下錯開一格，否則第二份會完全蓋住第一份。
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(3));
    expect(boxElements()[2]!.style.left).toBe(`${(148 / 1920) * 100}%`);
    expect(screen.getByText(/3 個文字框/)).toBeTruthy();
  });

  it("貼上的副本自己拿到新 id，並成為新的選取項", async () => {
    const project = textLayerProject("貼上後選取副本");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("貼上後選取副本");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "v", metaKey: true });

    await waitFor(() => expect(boxElements()).toHaveLength(2));
    // 選取狀態跟著副本走；共用 id 的話兩個框會同時亮起來。
    expect(boxElements()[0]!.className).not.toContain("selected");
    expect(boxElements()[1]!.className).toContain("selected");
  });

  it("Delete 刪掉選取的文字框，Ctrl+Z 還救得回來", async () => {
    const project = textLayerProject("文字框刪除");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("文字框刪除");
    fireEvent.pointerDown(boxElements()[0]!);

    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(boxElements()).toHaveLength(0));

    // 走 changeTextBoxes 才會推 undo 歷史。
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(1));
  });

  it("Backspace 與 Delete 等價，但沒有選取時不吞掉按鍵", async () => {
    const project = textLayerProject("文字框退格刪除");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("文字框退格刪除");

    // 未選取任何框：放行給瀏覽器（例如上一頁），文字框陣列不動。
    const ignored = fireEvent.keyDown(window, { key: "Backspace" });
    expect(ignored).toBe(true);
    expect(boxElements()).toHaveLength(1);

    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => expect(boxElements()).toHaveLength(0));
  });

  it("正在編輯文字內容的框裡，這三個鍵維持瀏覽器原生行為", async () => {
    const project = textLayerProject("編輯中不攔截");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("編輯中不攔截");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });

    // 雙擊進入文字內容編輯：textarea 不再是 readOnly。
    fireEvent.doubleClick(boxElements()[0]!);
    const textarea = screen.getByLabelText("可編輯簡報文字") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);

    fireEvent.keyDown(textarea, { key: "v", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "Delete" });
    fireEvent.keyDown(textarea, { key: "Backspace" });
    // 三個鍵都不得改動文字框陣列——貼上沒有多一個框，刪除也沒有刪掉整個框。
    await waitFor(() => expect(boxElements()).toHaveLength(1));
    expect(screen.getByText(/1 個文字框/)).toBeTruthy();
  });

  it("剪貼簿跨投影片保留，貼到別頁時階梯重新從第一階算", async () => {
    // 每貼一次就把剪貼簿換成剛貼上那份的話，同一份內容貼到第 2、3、4 頁會 +24／+48／+72
    // 一路斜著漂移；階梯只該發生在同一頁重複貼上。
    const project = textLayerProject("跨頁貼上");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("跨頁貼上");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".text-layer-canvas img")!.src).toContain(
        project.slides[1]!.id,
      ),
    );
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    expect(boxElements()[1]!.style.left).toBe(`${(124 / 1920) * 100}%`);
  });

  it("貼齊右下緣的框改成往回位移，副本不會原地重疊", async () => {
    // 夾在畫布內會讓 x/y 原封不動，副本正好蓋在來源上；右對齊頁尾、底部圖說都是這種框。
    const project = textLayerProject("貼齊邊緣", { x: 1920 - 300, y: 1080 - 60 });
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("貼齊邊緣");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await waitFor(() => expect(boxElements()).toHaveLength(2));
    expect(boxElements()[1]!.style.left).toBe(`${((1920 - 300 - 24) / 1920) * 100}%`);
    expect(boxElements()[1]!.style.top).toBe(`${((1080 - 60 - 24) / 1080) * 100}%`);
    // 連續貼上仍要一階一階退，不可停在同一點。
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(3));
    expect(boxElements()[2]!.style.left).toBe(`${((1920 - 300 - 48) / 1920) * 100}%`);
  });

  it("比畫布還大的框也看得出位移，不會兩軸都被夾成 0", async () => {
    const project = textLayerProject("超出畫布的框", { x: 0, y: 0, width: 2400, height: 1200 });
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("超出畫布的框");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await waitFor(() => expect(boxElements()).toHaveLength(2));
    expect(boxElements()[1]!.style.left).toBe(`${(24 / 1920) * 100}%`);
    expect(boxElements()[1]!.style.top).toBe(`${(24 / 1080) * 100}%`);
  });

  it("剪貼簿為空時 ⌘V 放行，沒有選取時 ⌘C 放行", async () => {
    const project = textLayerProject("空剪貼簿放行");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("空剪貼簿放行");

    // 都不 preventDefault，瀏覽器原生的複製／貼上照常運作。
    expect(fireEvent.keyDown(window, { key: "v", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "c", ctrlKey: true })).toBe(true);
    expect(boxElements()).toHaveLength(1);
  });

  it("長按不會連發：event.repeat 一律忽略", async () => {
    // 壓住 ⌘V 兩秒就是數十個框，每個都推一筆 undo 歷史，足以把 60 筆歷史全擠掉。
    const project = textLayerProject("長按貼上");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("長按貼上");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));

    for (let i = 0; i < 10; i += 1)
      fireEvent.keyDown(window, { key: "v", ctrlKey: true, repeat: true });
    fireEvent.keyDown(window, { key: "Delete", repeat: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
  });

  it("⌘⇧V 與 ⌥ 組合不搶：那是貼成純文字等別的手勢", async () => {
    const project = textLayerProject("修飾鍵組合");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("修飾鍵組合");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });

    expect(fireEvent.keyDown(window, { key: "v", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "v", metaKey: true, altKey: true })).toBe(true);
    expect(boxElements()).toHaveLength(1);
  });

  it("簡報模式中按 Delete 不會偷偷刪掉編輯頁的文字框", async () => {
    // 焦點停在「▶ 簡報模式」按鈕上，Backspace 是 PowerPoint／Keynote 的上一頁反射動作；
    // 沒有 gate 的話會刪掉 selected 那頁的框（不一定是正在放映的那頁）並自動存回伺服器。
    const project = textLayerProject("簡報模式不刪框");
    const fetchMock = stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("簡報模式不刪框");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByText("▶ 簡報模式"));
    await waitFor(() => expect(document.querySelector(".presentation-stage")).not.toBeNull());

    fireEvent.keyDown(window, { key: "Backspace" });
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(boxElements()).toHaveLength(1));
    // 自動儲存也不該被觸發：沒有任何一筆 text-layer 寫入。
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/text-layer")),
    ).toHaveLength(0);
  });

  it("系統設定對話框開著時，快捷鍵不會打到底下的畫布", async () => {
    const project = textLayerProject("對話框擋住畫布");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("對話框擋住畫布");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "系統設定" }));
    expect(await screen.findByLabelText("Web Search")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Delete" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxElements()).toHaveLength(1);
  });

  it("焦點停在唯讀 textarea 上時快捷鍵照樣生效", async () => {
    // 單擊選取走的是 pointerdown + preventDefault，焦點不會移到畫布；而剛結束編輯的那個
    // textarea 仍握著焦點、只是變回唯讀。真實瀏覽器裡 keydown 的 target 常常就是它，
    // 不是 window——這正是 isTypingTarget 對 textarea 要看 readOnly 的理由。
    // 其餘測試一律往 window 派事件，走不到這條分支。
    const project = textLayerProject("唯讀 textarea 焦點");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("唯讀 textarea 焦點");
    fireEvent.pointerDown(boxElements()[0]!);
    const textarea = screen.getByLabelText("可編輯簡報文字") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);

    fireEvent.keyDown(textarea, { key: "c", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));

    fireEvent.keyDown(screen.getAllByLabelText("可編輯簡報文字")[1]!, { key: "Delete" });
    await waitFor(() => expect(boxElements()).toHaveLength(1));
  });

  it("面板輸入框還握著焦點時，Delete 留給輸入框、不刪掉選取的文字框", async () => {
    // isTypingTarget 放行 input/select 的那一段：面板欄位裡的 Delete 是刪字元，
    // 攔下來會讓數字欄位變成刪不掉。
    const project = textLayerProject("面板欄位焦點");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("面板欄位焦點");
    fireEvent.pointerDown(boxElements()[0]!);
    const lineHeight = screen.getByLabelText("行高");

    expect(fireEvent.keyDown(lineHeight, { key: "Delete" })).toBe(true);
    expect(fireEvent.keyDown(lineHeight, { key: "v", ctrlKey: true })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxElements()).toHaveLength(1);
  });

  it("點選文字框會把焦點收回畫布：剛改完面板欄位，Delete 照樣刪得掉", async () => {
    // 選取走 pointerdown + preventDefault（拖曳必須擋掉原生行為），連帶擋掉瀏覽器移動焦點：
    // 焦點還留在剛才那個面板欄位上，接著按 Delete 會被 isTypingTarget 放行，什麼都不會發生
    // 也沒有任何回饋——使用者體感是「時靈時不靈」。修法是選取時主動把焦點搬到畫布容器，
    // 而不是放寬 isTypingTarget（那會讓面板欄位裡的刪字元變成刪框）。
    const project = textLayerProject("選取時收回焦點");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("選取時收回焦點");
    fireEvent.pointerDown(boxElements()[0]!);
    const lineHeight = screen.getByLabelText("行高") as HTMLInputElement;
    lineHeight.focus();
    expect(document.activeElement).toBe(lineHeight);

    fireEvent.pointerDown(boxElements()[0]!);
    const canvas = document.querySelector(".text-layer-canvas");
    expect(document.activeElement).toBe(canvas);
    // 真實瀏覽器的 keydown target 就是這個容器（測試其餘處一律往 window 派事件）。
    fireEvent.keyDown(canvas!, { key: "Delete" });
    await waitFor(() => expect(boxElements()).toHaveLength(0));
  });

  it("圖片編輯對話框開著時，快捷鍵不會打到底下的畫布", async () => {
    const project = textLayerProject("圖片編輯對話框擋住畫布");
    stubTextLayerApi(project, { fullSlideGeneration: true, imageEditing: true });

    render(<Editor />);
    await enterProject("圖片編輯對話框擋住畫布");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "編輯當頁圖片" }));
    expect(await screen.findByRole("dialog", { name: "編輯當頁圖片" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxElements()).toHaveLength(1);
  });

  it("風格選擇對話框開著時，快捷鍵不會打到底下的畫布", async () => {
    const project = textLayerProject("風格選擇器擋住畫布");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("風格選擇器擋住畫布");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "＋ 將圖片加入風格庫" }));
    expect(await screen.findByRole("dialog", { name: "選擇風格" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxElements()).toHaveLength(1);
  });

  it("切到別條路由（風格庫）後，快捷鍵不會打到還留著的專案狀態", async () => {
    // /styles 與 /models 都只是提早 return 換一個畫面，project 與 textEditing 都還在、
    // effect 也還掛著；少了路由那一項，在風格庫按 Delete 會刪掉背景那頁的文字框。
    const project = textLayerProject("風格庫路由");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("風格庫路由");
    fireEvent.pointerDown(boxElements()[0]!);
    window.history.pushState({}, "", "/styles");
    fireEvent.popState(window);
    await waitFor(() => expect(document.querySelector(".text-layer-canvas")).toBeNull());

    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    window.history.pushState({}, "", `/projects/${project.id}`);
    fireEvent.popState(window);
    await screen.findByLabelText("可編輯簡報文字");
    expect(boxElements()).toHaveLength(1);
  });

  it("使用者圈選了頁面文字時，⌘C 讓給瀏覽器、剪貼簿不被換掉", async () => {
    const project = textLayerProject("圈選文字時不搶複製");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("圈選文字時不搶複製");
    fireEvent.pointerDown(boxElements()[0]!);
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "使用者圈起來的一段字",
    } as unknown as Selection);

    expect(fireEvent.keyDown(window, { key: "c", ctrlKey: true })).toBe(true);
    // 剪貼簿沒被寫入，所以 ⌘V 也一併放行、不會多出框。
    expect(fireEvent.keyDown(window, { key: "v", ctrlKey: true })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxElements()).toHaveLength(1);
  });

  it("重新按 ⌘C 不會把副本壓回第一階（那一階已經被佔住）", async () => {
    // 落點看的是「這一階有沒有被佔住」而不是記著的階數，所以重新複製同一個框不會讓
    // 下一份副本疊回第一份上——使用者看到的會是「⌘V 沒反應」，要拖走才發現有兩個。
    const project = textLayerProject("重新複製歸零");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("重新複製歸零");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(3));
    expect(boxElements()[2]!.style.left).toBe(`${(148 / 1920) * 100}%`);

    // 重新複製同一個來源框：第一、二階都有人了，副本接著落到第三階。
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(4));
    expect(boxElements()[3]!.style.left).toBe(`${(172 / 1920) * 100}%`);

    // 把中間那份刪掉，空出來的位置會被下一份副本重新使用。
    fireEvent.pointerDown(boxElements()[1]!);
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(boxElements()).toHaveLength(3));
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(4));
    expect(boxElements()[3]!.style.left).toBe(`${(124 / 1920) * 100}%`);
  });

  it("貼上與刪除的復原：工具列按鈕與 Ctrl+Z 走同一條歷史", async () => {
    const project = textLayerProject("復原一致性");
    stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("復原一致性");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(boxElements()).toHaveLength(1));

    // 按鈕復原 → 鍵盤復原 → 按鈕重做 → 鍵盤重做，四者必須在同一條堆疊上前後接得起來。
    fireEvent.click(screen.getByRole("button", { name: "復原" }));
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    // 再重做一次是把那次刪除也重做回來，所以回到 1 個框。
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(1));
  });

  it("有文字圖層時進簡報模式：滾輪只換頁，文字框一個都沒動", async () => {
    // 兩條 handler 同時掛在 window 上；滾輪換的是 presentationIndex，而文字快捷鍵改的是
    // 編輯頁那份 textBoxes。互相踩到的話會是「放映時滑一下，編輯頁的字就少一塊」。
    const project = textLayerProject("簡報滾輪與文字層並存");
    const fetchMock = stubTextLayerApi(project);

    render(<Editor />);
    await enterProject("簡報滾輪與文字層並存");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();

    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 2")).toBeTruthy();
    // 滾輪期間夾雜的複製／貼上／刪除同樣不得生效。
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Delete" });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(boxElements()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/text-layer")),
    ).toHaveLength(0);

    // 離開簡報模式後兩者都回到正常：快捷鍵生效，滾輪不再被攔。
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    expect(fireEvent.wheel(window, { deltaY: 200, cancelable: true })).toBe(true);
  });

  it("回到前一頁再貼上會接著往下疊，不會與該頁既有副本重疊", async () => {
    // 離開該頁再回來時，落點仍要看「這一頁現在有哪些框」：退回第一階的話新副本會逐像素
    // 疊在上一次貼的那份上，畫面上完全看不出 ⌘V 有作用。
    const project = textLayerProject("階梯跨頁往返");
    stubPersistingTextLayerApi(project);

    render(<Editor />);
    await enterProject("階梯跨頁往返");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    // 等自動儲存把副本落地，切回這一頁時它才還在。
    await waitFor(() => expect(project.slides[0]!.versions[0]!.textLayer!.boxes).toHaveLength(2), {
      timeout: 3_000,
    });

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitForSlide(project.slides[1]!.id);
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(2));

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitForSlide(project.slides[0]!.id);
    await waitFor(() => expect(boxElements()).toHaveLength(2));
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    await waitFor(() => expect(boxElements()).toHaveLength(3));

    // 第三個框往下疊一階，不與第二個重疊。
    expect(boxElements()[2]!.style.left).not.toBe(boxElements()[1]!.style.left);
    expect(boxElements()[2]!.style.left).toBe(`${(148 / 1920) * 100}%`);
    expect(boxElements()[2]!.style.top).toBe(`${(128 / 1080) * 100}%`);
  });

  it("刪除後在 650ms 內切頁，這一刀會在換頁前送出", async () => {
    // 自動儲存的 debounce 綁在 selected.id 上：切頁時 cleanup 把計時器清掉，重新播種又把
    // textDirty 設回 false。沒有換頁前的 flush，這次刪除就既沒送出也沒保留、還不會報錯；
    // 鍵盤快捷鍵讓「Delete 之後馬上按方向鍵」變成很自然的節奏，撞上的機率遠高於用按鈕操作。
    const project = textLayerProject("刪除後立刻切頁");
    const fetchMock = stubPersistingTextLayerApi(project);

    render(<Editor />);
    await enterProject("刪除後立刻切頁");
    fireEvent.pointerDown(boxElements()[0]!);
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(boxElements()).toHaveLength(0));

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitForSlide(project.slides[1]!.id);
    // 送的必須是「舊那頁」：debounce 到期前就已經寫進第一頁的版本裡。
    await waitFor(() => expect(project.slides[0]!.versions[0]!.textLayer!.boxes).toHaveLength(0));
    expect(project.slides[1]!.versions[0]!.textLayer!.boxes).toHaveLength(1);

    // 換頁 flush 與原本的 debounce 不得各送一次。
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/text-layer")),
    ).toHaveLength(1);

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitForSlide(project.slides[0]!.id);
    expect(boxElements()).toHaveLength(0);
  });
});

describe("系統設定對話框", () => {
  afterEach(() => resetSystemSettings());

  it("仍保留 Web Search 三段模式下拉", async () => {
    const project = createProject({
      topic: "系統設定保留搜尋模式",
      brief: { desiredSlideCount: 1 },
    });
    project.workflowStage = "editing";
    const now = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
        if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
        if (path === "/api/model-library")
          return Response.json({ connections: [], models: [], combinations: [] });
        if (path === "/api/text-providers") return Response.json([]);
        return Response.json(project);
      }),
    );

    render(<Editor />);
    fireEvent.click(await screen.findByText("系統設定保留搜尋模式"));
    fireEvent.click(await screen.findByRole("button", { name: "系統設定" }));

    const select = (await screen.findByLabelText("Web Search")) as HTMLSelectElement;
    expect(select.value).toBe("cached");
    expect([...select.options].map((option) => option.value)).toEqual([
      "live",
      "cached",
      "disabled",
    ]);
  });
});

describe("簡報模式滾輪換頁", () => {
  function wheelProject(topic: string) {
    const project = createProject({ topic, brief: { desiredSlideCount: 3 } });
    project.workflowStage = "editing";
    return project;
  }

  function stubWheelApi(project: PresentationProject) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
        return Response.json(project);
      }),
    );
  }

  /**
   * 節流是以 `Date.now()` 的時間戳判斷的；真的去等 320ms 會讓測試又慢又飄，
   * 所以把時鐘接管過來，由測試決定「經過了多久」。
   */
  function fakeClock() {
    let current = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => current);
    return (ms: number) => {
      current += ms;
    };
  }

  /** 進入專案並開啟簡報模式；回傳時畫面上已經是全螢幕簡報，停在第 1 頁。 */
  const enterPresentation = async (project: PresentationProject) => {
    fireEvent.click(await screen.findByText(project.name));
    expect(await screen.findByDisplayValue(project.slides[0]!.purpose)).toBeTruthy();
    fireEvent.click(await screen.findByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
  };

  it("向下／向右滾動切下一頁，向上／向左切上一頁", async () => {
    const project = wheelProject("滾輪換頁");
    stubWheelApi(project);
    const advance = fakeClock();

    render(<Editor />);
    await enterPresentation(project);
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.wheel(window, { deltaY: 120 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    advance(500);
    fireEvent.wheel(window, { deltaY: -120 });
    expect(await screen.findByText("1 / 3")).toBeTruthy();

    // 橫向滾動（觸控板左右滑）也要能換頁：取絕對值較大的那一軸。
    advance(500);
    fireEvent.wheel(window, { deltaX: 120, deltaY: 0 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();
  });

  it("滑鼠一格 notch（deltaMode=1，以行為單位）就能換一頁", async () => {
    const project = wheelProject("滾輪一格換頁");
    stubWheelApi(project);
    fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    // Firefox 一格 notch 是 3 行；正規化成 48px 才過得了 40px 的門檻。
    fireEvent.wheel(window, { deltaY: 3, deltaMode: 1 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();
  });

  it("到頭到尾就停住，不會迴圈到另一端", async () => {
    const project = wheelProject("滾輪邊界");
    stubWheelApi(project);
    const advance = fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    fireEvent.wheel(window, { deltaY: -300 });
    expect(screen.getByText("1 / 3")).toBeTruthy();

    for (let step = 0; step < 4; step += 1) {
      advance(500);
      fireEvent.wheel(window, { deltaY: 300 });
    }
    expect(await screen.findByText("3 / 3")).toBeTruthy();
  });

  it("一次觸控板手勢只切一頁，慣性尾巴不會連跳", async () => {
    const project = wheelProject("滾輪節流");
    stubWheelApi(project);
    const advance = fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    // 60Hz 的慣性事件流：第一批湊滿門檻換一頁後，剩下的全被冷卻鎖吃掉。
    for (let step = 0; step < 30; step += 1) {
      fireEvent.wheel(window, { deltaY: 60 });
      advance(16);
    }
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    // 手勢結束後重新出手才會再切一頁。
    advance(500);
    fireEvent.wheel(window, { deltaY: 120 });
    expect(await screen.findByText("3 / 3")).toBeTruthy();
  });

  it("沒湊滿門檻的輕碰不換頁，也不會跨手勢累加", async () => {
    const project = wheelProject("滾輪門檻");
    stubWheelApi(project);
    const advance = fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    // 單次 30px 不到 40px 的門檻。
    fireEvent.wheel(window, { deltaY: 30 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    // 隔了一段時間的第二次輕碰算新手勢，殘量歸零；兩次相加雖然過門檻也不該換頁。
    advance(500);
    fireEvent.wheel(window, { deltaY: 30 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("離開簡報模式後不再攔截滾輪", async () => {
    const project = wheelProject("滾輪離場");
    stubWheelApi(project);
    fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    // 簡報模式中要擋掉預設捲動，否則 macOS 上整頁會跟著彈跳。
    expect(fireEvent.wheel(window, { deltaY: 200, cancelable: true })).toBe(false);
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "全螢幕簡報" })).toBeNull());

    // listener 已經拆掉：事件不再被 preventDefault，也不會再開回簡報模式。
    expect(fireEvent.wheel(window, { deltaY: 200, cancelable: true })).toBe(true);
    expect(screen.queryByRole("dialog", { name: "全螢幕簡報" })).toBeNull();
  });

  it("Ctrl／⌘＋滾輪是瀏覽器縮放手勢，不攔也不換頁", async () => {
    const project = wheelProject("滾輪縮放放行");
    stubWheelApi(project);
    const advance = fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    // 無條件 preventDefault 會連瀏覽器縮放一起擋掉，簡報中就再也放大不了。
    expect(fireEvent.wheel(window, { deltaY: 200, ctrlKey: true, cancelable: true })).toBe(true);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    advance(500);
    expect(fireEvent.wheel(window, { deltaY: 200, metaKey: true, cancelable: true })).toBe(true);
    expect(screen.getByText("1 / 3")).toBeTruthy();

    // 一般滾輪不受影響，照常換頁。
    advance(500);
    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();
  });

  it("換頁後的冷卻窗：220ms 的下一下不算數，再等一下才算", async () => {
    // 只有「間隔 500ms 一定換頁」的測試時，冷卻長度在 100ms 與 480ms 之間怎麼改都不會轉紅
    // （手勢間隔會一路把鎖往後推，蓋掉短冷卻的差別）。這條把冷卻夾在 140ms 與 400ms 之間。
    const project = wheelProject("滾輪冷卻窗");
    stubWheelApi(project);
    const advance = fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    // 220ms：已經是新手勢（>140ms）但還在冷卻裡，不換頁。
    advance(220);
    fireEvent.wheel(window, { deltaY: 200 });
    expect(screen.getByText("2 / 3")).toBeTruthy();

    // 再 200ms（距換頁 420ms）冷卻已解，這一下要算數。
    advance(200);
    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("3 / 3")).toBeTruthy();
  });

  it("一直轉滾輪不會卡在同一頁：冷卻最多被慣性尾巴推到 900ms", async () => {
    // 冷卻上限若被放大（或拿掉），持續進來的事件會把鎖無限往後推，使用者會發現滾輪
    // 換完第一頁之後就再也沒有反應。
    const project = wheelProject("滾輪冷卻上限");
    stubWheelApi(project);
    const advance = fakeClock();

    render(<Editor />);
    await enterPresentation(project);

    // 60Hz 連續事件持續 1.1 秒，中間一次都沒有斷過。
    for (let step = 0; step < 70; step += 1) {
      fireEvent.wheel(window, { deltaY: 60 });
      advance(16);
    }
    // 第一頁在一開始就換掉，第二次要等冷卻上限（900ms）到期才會發生。
    expect(await screen.findByText("3 / 3")).toBeTruthy();
  });

  it("重新進入簡報模式時手勢狀態歸零，第一下滾輪就有反應", async () => {
    // 上一輪換頁留下的冷卻是掛在 ref 上的，不重置的話重新進場的第一下會被默默吃掉。
    const project = wheelProject("重新進場");
    stubWheelApi(project);
    fakeClock();

    render(<Editor />);
    await enterPresentation(project);
    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    // 完全不推進時鐘就離開再進來：冷卻若沒歸零，下一下必然落在鎖裡。
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "全螢幕簡報" })).toBeNull());
    fireEvent.click(screen.getByText("▶ 簡報模式"));
    expect(await screen.findByRole("dialog", { name: "全螢幕簡報" })).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.wheel(window, { deltaY: 200 });
    expect(await screen.findByText("2 / 3")).toBeTruthy();
  });
});

describe("文字框底色", () => {
  afterEach(() => {
    resetSystemSettings();
    window.history.pushState({}, "", "/");
  });

  const backgroundBoxes = () => [...document.querySelectorAll<HTMLElement>(".editable-text-box")];

  it("畫布把底色畫在文字框容器上（不是放大成 400% 的 textarea）", () => {
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox({ backgroundColor: "#112233", backgroundOpacity: 0.5 })]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId={undefined}
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    const container = backgroundBoxes()[0]!;
    expect(container.style.background).toBe("rgba(17, 34, 51, 0.5)");
    // 容器尺寸就是框本身；底色若掛在 textarea 上會跟著放大顯示區糊成四倍大。
    expect(container.style.width).toBe(`${(300 / 1920) * 100}%`);
    expect((screen.getByLabelText("可編輯簡報文字") as HTMLTextAreaElement).style.background).toBe(
      "",
    );
  });

  it("沒設定底色的框不寫 inline 背景，選取提示底維持既有樣式", () => {
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox()]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId="text-1"
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    const container = backgroundBoxes()[0]!;
    expect(container.style.background).toBe("");
    expect(container.className).toContain("selected");
  });

  it("省略 backgroundOpacity 時視為不透明，且不影響文字自身的 opacity", () => {
    render(
      <TextLayerCanvas
        background="/clean.png"
        boxes={[makeBox({ backgroundColor: "#ff0000", opacity: 0.25 })]}
        canvasWidth={1920}
        canvasHeight={1080}
        selectedId={undefined}
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(backgroundBoxes()[0]!.style.background).toBe("rgb(255, 0, 0)");
    expect((screen.getByLabelText("可編輯簡報文字") as HTMLTextAreaElement).style.opacity).toBe(
      "0.25",
    );
  });

  /** 一頁帶可編輯文字圖層的專案；進專案就直接是文字圖層編輯狀態，屬性面板才會出現。 */
  function backgroundProject(topic: string) {
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
            boxes: [makeBox({ id: `${slide.id}-text-1` })],
            extractedAt: now,
            updatedAt: now,
          },
        },
      ];
      slide.currentVersionId = `${slide.id}-v1`;
    }
    return project;
  }

  /** 回傳所有 PUT /text-layer 送出的框；欄位有沒有被刪掉只有這裡看得出來。 */
  function stubBackgroundApi(project: PresentationProject) {
    const written: import("@slide-maker/core").EditableTextBox[][] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      const target = /\/slides\/([^/]+)\/versions\/([^/]+)\/text-layer$/.exec(path);
      if (target && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          boxes: import("@slide-maker/core").EditableTextBox[];
        };
        written.push(body.boxes);
        // 存過的內容要落地：不落地的話伺服器回來的專案永遠是初始狀態，
        // 下一次編輯會被「與已存內容相同」的比對擋掉，第二筆 PUT 就永遠不會送出。
        // 落地前**必須**跑一次 schema.parse，因為真正的伺服器就是這樣重建物件的：
        // 回應裡的 key 順序是 schema 的宣告順序，而不是客戶端送出的物件順序
        //（本地新加的 optional 欄位排在尾端）。假伺服器若直接回存 body.boxes，
        // 「本地與伺服器是否一致」的比對在測試裡永遠成立，正式環境卻永遠不成立——
        // 自動儲存會無限迴圈，而測試全綠。
        const stored = body.boxes.map((box) => editableTextBoxSchema.parse(box));
        const version = project.slides
          .find((slide) => slide.id === decodeURIComponent(target[1]!))
          ?.versions.find((candidate) => candidate.id === decodeURIComponent(target[2]!));
        if (version?.textLayer) version.textLayer = { ...version.textLayer, boxes: stored };
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
    });
    vi.stubGlobal("fetch", fetchMock);
    return written;
  }

  const enterAndSelect = async (topic: string) => {
    fireEvent.click(await screen.findByText(topic));
    await screen.findByLabelText("可編輯簡報文字");
    fireEvent.pointerDown(backgroundBoxes()[0]!);
  };

  it("屬性面板勾選底色會給預設黑底，取消勾選則把兩個欄位整個移除", async () => {
    const project = backgroundProject("屬性面板底色");
    const written = stubBackgroundApi(project);

    render(<Editor />);
    await enterAndSelect("屬性面板底色");

    const toggle = screen.getByLabelText("底色") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    // 沒啟用底色時色票與不透明度都是停用的，避免改了看不出效果。
    expect((screen.getByLabelText("文字框底色") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(toggle);
    await waitFor(() => expect(backgroundBoxes()[0]!.style.background).toBe("rgb(0, 0, 0)"));
    expect((screen.getByLabelText("文字框底色") as HTMLInputElement).value).toBe("#000000");
    await waitFor(() => expect(written.at(-1)?.[0]?.backgroundColor).toBe("#000000"), {
      timeout: 3000,
    });
    expect(written.at(-1)?.[0]?.backgroundOpacity).toBe(1);

    fireEvent.click(toggle);
    await waitFor(() => expect(backgroundBoxes()[0]!.style.background).toBe(""));
    // 關閉必須是「移除 key」而不是寫 undefined：schema 開了 exactOptionalPropertyTypes。
    await waitFor(
      () => {
        const box = written.at(-1)?.[0];
        expect(box && "backgroundColor" in box).toBe(false);
        expect(box && "backgroundOpacity" in box).toBe(false);
      },
      { timeout: 3000 },
    );
  });

  it("啟用底色只送出一筆自動儲存，不會被伺服器回應的欄位順序帶進無限迴圈", async () => {
    const project = backgroundProject("底色自動儲存");
    const written = stubBackgroundApi(project);

    render(<Editor />);
    await enterAndSelect("底色自動儲存");
    fireEvent.click(screen.getByLabelText("底色"));

    await waitFor(() => expect(written).toHaveLength(1), { timeout: 3000 });
    // 每一輪迴圈是 650ms 的 debounce＋一次伺服器往返；等兩輪還是 1 筆才算真的停住。
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(written).toHaveLength(1);
  });

  it("改色票與不透明度會即時反映在畫布的底色上", async () => {
    const project = backgroundProject("底色色票");
    stubBackgroundApi(project);

    render(<Editor />);
    await enterAndSelect("底色色票");

    fireEvent.click(screen.getByLabelText("底色"));
    fireEvent.change(screen.getByLabelText("文字框底色"), { target: { value: "#ff0000" } });
    await waitFor(() => expect(backgroundBoxes()[0]!.style.background).toBe("rgb(255, 0, 0)"));

    fireEvent.change(screen.getByLabelText("底色不透明度"), { target: { value: "0.4" } });
    await waitFor(() =>
      expect(backgroundBoxes()[0]!.style.background).toBe("rgba(255, 0, 0, 0.4)"),
    );
  });
});

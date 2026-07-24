// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createProject,
  createDefaultStyle,
  createSlidesFromBrief,
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

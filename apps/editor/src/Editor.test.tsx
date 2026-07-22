// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProject, createDefaultStyle, createSlidesFromBrief } from "@slide-maker/core";
import { Editor, TextLayerCanvas } from "./Editor.js";

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

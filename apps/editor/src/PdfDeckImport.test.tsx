// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject } from "@slide-maker/core";
import type { PresentationProject, SlideSpec } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { pickAnalysisSlides } from "./PdfDeckAnalysis.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const slide = (id: string, content: string, order: number): SlideSpec => ({
  id,
  order,
  purpose: `頁 ${order + 1}`,
  content,
  narrative: "",
  layoutHint: "",
  dataBasis: [],
  imagePrompt: "",
  sourceIds: [],
  outlineDirty: false,
  versions: [],
});

/**
 * 由 PDF 匯入建立的專案：每頁在匯入當下就有原圖與可編輯文字兩個版本，
 * `currentVersionId` 指向原圖。
 */
function importedProject(
  stage: PresentationProject["workflowStage"],
  options: { current?: "original" | "text" } = {},
): PresentationProject {
  const base = createProject({ topic: "Imported Deck", name: "Imported Deck" });
  const now = new Date().toISOString();
  return {
    ...base,
    workflowStage: stage,
    slides: ["首頁內容", "第二頁內容", "第三頁內容"].map((content, order) => {
      const id = `slide-${order + 1}`;
      const versionId = `version-${order + 1}`;
      const textVersionId = `text-version-${order + 1}`;
      const original = {
        id: versionId,
        imagePath: `assets/${id}/${versionId}.png`,
        prompt: "",
        providerId: "pdf-import",
        model: "pdf-import",
        parameters: { pdfImport: true, pdfPage: order + 1, pdfSourcePath: "assets/x.pdf" },
        styleVersion: 1,
        sources: [],
        createdAt: now,
        label: "原始頁面",
      };
      return {
        ...slide(id, content, order),
        currentVersionId: options.current === "text" ? textVersionId : versionId,
        versions: [
          original,
          {
            ...original,
            id: textVersionId,
            imagePath: `assets/text-layers/${versionId}/composite-0-x.png`,
            label: "可編輯文字",
            textLayer: {
              originalVersionId: versionId,
              backgroundPath: `assets/text-layers/${versionId}/background-${textVersionId}.png`,
              compositePath: `assets/text-layers/${versionId}/composite-0-x.png`,
              threshold: 0.75,
              renderRevision: 0,
              boxes: [],
              extractedAt: now,
              updatedAt: now,
            },
          },
        ],
      };
    }),
  };
}

function stubFetch(project: PresentationProject, extra?: Record<string, () => Response>) {
  const now = new Date().toISOString();
  const calls: { path: string; method: string }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? new URL(input, "http://localhost").pathname
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    calls.push({ path, method: init?.method ?? "GET" });
    const handler = extra?.[path];
    if (handler) return handler();
    if (path === "/api/projects") return Response.json([project]);
    if (path === "/api/providers") return Response.json([]);
    if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
    if (path === "/api/model-library")
      return Response.json({ connections: [], models: [], combinations: [] });
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
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("pickAnalysisSlides", () => {
  it("takes the cover, the sparsest page and the pages around the median", () => {
    const slides = [
      slide("cover", "封面", 0),
      slide("dense", "x".repeat(400), 1),
      slide("sparse", "", 2),
      slide("mid-a", "x".repeat(120), 3),
      slide("mid-b", "x".repeat(160), 4),
      slide("mid-c", "x".repeat(200), 5),
    ];
    const picked = pickAnalysisSlides(slides);
    expect(picked[0]).toBe("cover");
    expect(picked[1]).toBe("sparse");
    expect(picked).toHaveLength(4);
    expect(picked).not.toContain("dense");
  });

  it("never asks for more than four pages", () => {
    const slides = Array.from({ length: 40 }, (_, index) =>
      slide(`s${index}`, "x".repeat(index * 10), index),
    );
    expect(pickAnalysisSlides(slides)).toHaveLength(4);
  });

  it("returns every page of a short deck without duplicates", () => {
    const picked = pickAnalysisSlides([slide("a", "1", 0), slide("b", "22", 1)]);
    expect(picked).toEqual(["a", "b"]);
  });

  it("handles an empty deck", () => {
    expect(pickAnalysisSlides([])).toEqual([]);
  });
});

describe("PDF deck import entry point", () => {
  it("offers importing a PDF next to creating a presentation", async () => {
    stubFetch(createProject({ topic: "既有" }));
    render(<Editor />);
    fireEvent.click(await screen.findByRole("button", { name: "匯入 PDF" }));
    expect(await screen.findByRole("dialog", { name: "從 PDF 匯入簡報" })).toBeTruthy();
    expect(screen.getByText("選擇 PDF 檔")).toBeTruthy();
  });

  /** 匯入對話框是新使用者看到的第一個畫面：那裡的 `PDF_ASPECT_UNSUPPORTED` 沒有意義。 */
  it("explains a rejected PDF in a sentence instead of an error code", async () => {
    stubFetch(createProject({ topic: "既有" }), {
      "/api/pdf-deck/inspect": () =>
        Response.json(
          {
            error: "PDF_ASPECT_UNSUPPORTED",
            message: "只能匯入 16:9 的簡報：這份 PDF 第一頁不是 16:9。",
          },
          { status: 400 },
        ),
    });
    const { container } = render(<Editor />);
    fireEvent.click(await screen.findByRole("button", { name: "匯入 PDF" }));
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input!, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "deck.pdf")] },
    });
    expect(await screen.findByText(/只能匯入 16:9 的簡報/)).toBeTruthy();
    expect(screen.queryByText(/PDF_ASPECT_UNSUPPORTED/)).toBeNull();
  });
});

describe("PDF deck analysis stage", () => {
  it("replaces the four-step wizard with the style analysis page", async () => {
    const project = importedProject("settings");
    stubFetch(project);
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    // 分析頁的兩個出口永遠都在。
    expect(await screen.findByRole("button", { name: "先用預設風格進編輯器 →" })).toBeTruthy();
    expect(screen.getByText("改用風格庫的風格")).toBeTruthy();
    expect(screen.getByRole("button", { name: "分析這份簡報的風格" })).toBeTruthy();
    expect(screen.queryByLabelText("建立簡報流程")).toBeNull();
  });

  /**
   * 建參考圖 → 分析 → 寫回 snapshot 是伺服器端的一筆交易。前端自己串三支端點的話，
   * 分析失敗時剛建好的參考圖沒有主，重試幾次就在 `styles/assets` 下堆孤兒檔。
   */
  it("analyses through a single transactional endpoint and shows why it failed", async () => {
    const project = importedProject("settings");
    const calls = stubFetch(project, {
      [`/api/projects/${project.id}/style-analysis`]: () =>
        Response.json(
          {
            error: "CODEX_STYLE_ANALYSIS_DISABLED",
            message: "目前選定的模型組合沒有可用的文字模型，無法分析風格。",
          },
          { status: 400 },
        ),
    });
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    fireEvent.click(await screen.findByRole("button", { name: "分析這份簡報的風格" }));
    // 顯示的是使用者看得懂的原因，不是裸的 `CODEX_STYLE_ANALYSIS_DISABLED`。
    expect(await screen.findByText(/目前選定的模型組合沒有可用的文字模型/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重試" })).toBeTruthy();
    expect(calls.some((call) => call.path.endsWith("/style-reference"))).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/style-snapshot"))).toBe(false);
  });

  /** 分析用的頁面會留作往後每一次生圖的參考圖（刻意的），使用者要看得到。 */
  it("tells the user that the analysed pages stay attached as style references", async () => {
    const project = importedProject("settings");
    const analysed: PresentationProject = {
      ...project,
      styleSnapshot: {
        ...project.styleSnapshot,
        designSystem: "## 色票\n- #0B1F3A",
        referenceImages: [1, 2, 3, 4].map((index) => ({
          id: `ref-${index}`,
          name: `Imported Deck - Slide ${index}`,
          mediaType: "image/png" as const,
          assetPath: `assets/ref-${index}.png`,
          createdAt: new Date().toISOString(),
        })),
      },
    };
    stubFetch(project, {
      [`/api/projects/${project.id}/style-analysis`]: () => Response.json(analysed),
    });
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    fireEvent.click(await screen.findByRole("button", { name: "分析這份簡報的風格" }));
    expect(await screen.findByText(/分析用的 4 張頁面也留作參考圖/)).toBeTruthy();
  });

  it("enters the editor without analysing when the user opts out", async () => {
    const project = importedProject("settings");
    const calls = stubFetch(project, {
      [`/api/projects/${project.id}/workflow-stage`]: () =>
        Response.json({ ...project, workflowStage: "editing" }),
    });
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    fireEvent.click(await screen.findByRole("button", { name: "先用預設風格進編輯器 →" }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.path.endsWith("/workflow-stage") && call.method === "PATCH"),
      ).toBe(true),
    );
  });
});

describe("PDF import page versions", () => {
  /**
   * 使用者拍板：兩個版本在匯入時就建好，靠既有的版本切換 UI 存取，
   * 不再有 PDF 專屬的「編輯文字」按鈕。
   */
  it("exposes both versions through the version history and keeps the OCR button untouched", async () => {
    stubFetch(importedProject("editing"));
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    expect(await screen.findByRole("button", { name: /版本 1：原始頁面/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /版本 2：可編輯文字/ })).toBeTruthy();
    // 「抽離文字」是既有的 OCR ＋ 生圖模型抹字，PDF 匯入頁不再接管它。
    expect(screen.getByRole("button", { name: "抽離文字" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "編輯文字" })).toBeNull();
  });

  /**
   * 這個版本已經有 100% 精確、零成本的文字層了；再按一次是拿 OCR ＋ 生圖模型
   * 重做一份更差的。按鈕本身保留（使用者的決定），但在這裡不該可按。
   */
  it("disables the OCR extraction button on a version that already carries a text layer", async () => {
    stubFetch(importedProject("editing", { current: "text" }));
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    const extract = await screen.findByRole("button", { name: "抽離文字" });
    expect((extract as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * `pdf-text-layer.ts` 把 PDF 內嵌字型收斂成 Arial／Times New Roman／Courier New，
   * 所以切到「可編輯文字」版本整頁字型會肉眼可見地變樣。規格要求提示一次。
   */
  it("explains the system-font re-render once when the editable text version is active", async () => {
    stubFetch(importedProject("editing", { current: "text" }));
    const { unmount } = render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    expect(await screen.findByText(/文字會以系統字型重繪/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByText(/文字會以系統字型重繪/)).toBeNull());
    // 一次性：確認過就不再出現，重新開啟編輯器也一樣。
    unmount();
    cleanup();
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    expect(await screen.findByRole("button", { name: /版本 2：可編輯文字/ })).toBeTruthy();
    expect(screen.queryByText(/文字會以系統字型重繪/)).toBeNull();
  });

  it("keeps the notice away from the original page version", async () => {
    stubFetch(importedProject("editing"));
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    expect(await screen.findByRole("button", { name: /版本 1：原始頁面/ })).toBeTruthy();
    expect(screen.queryByText(/文字會以系統字型重繪/)).toBeNull();
  });

  /**
   * 提示的措辭（「請切回『原始頁面』版本，匯出時也會保真」）只在 PDF 匯入頁成立。
   * 生圖 + OCR 抽出來的文字層同樣是系統字型，但它沒有「原始頁面」可以切回去，
   * 對著它顯示這句話會把使用者導到不存在的出口。
   */
  it("keeps the notice away from an OCR text layer on a generated page", async () => {
    const project = importedProject("editing", { current: "text" });
    const ocrProject: PresentationProject = {
      ...project,
      slides: project.slides.map((current) => ({
        ...current,
        versions: current.versions.map((version) => ({
          ...version,
          // 生圖 provider 產生的頁面：文字層一樣在，但不是 PDF 匯入來的。
          providerId: "mock-image",
          model: "mock",
          parameters: {},
        })),
      })),
    };
    stubFetch(ocrProject);
    render(<Editor />);
    fireEvent.click(await screen.findByText("Imported Deck"));
    expect(await screen.findByRole("button", { name: /版本 2：可編輯文字/ })).toBeTruthy();
    expect(screen.queryByText(/文字會以系統字型重繪/)).toBeNull();
  });
});

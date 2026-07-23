// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ModelLibrary } from "./ModelLibrary.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 影像庫含一個 local kind（fullSlideGeneration:false 的抹字工具）與一個 mock 生圖模型，
// 外加一個已存在的組合，讓 CombinationRow 的影像下拉渲染出來。
const libraryWithLocalImage = () => ({
  schemaVersion: 1 as const,
  connections: [],
  models: [
    {
      id: "local-inpaint",
      name: "OpenCV 抹字修補（本機）",
      capability: "image",
      providerKind: "local",
      model: "opencv-inpaint-telea",
    },
    {
      id: "mock-image",
      name: "Mock 生圖",
      capability: "image",
      providerKind: "mock",
      model: "mock",
    },
  ],
  combinations: [{ id: "combo-1", name: "預設組合", imageModelRef: "mock-image" }],
  defaultCombinationId: "combo-1",
  system: {},
  updatedAt: new Date().toISOString(),
});

describe("ModelLibrary 組合影像下拉", () => {
  it("排除 local kind（如 local-inpaint），只列可整頁生成的影像模型", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/model-library") return Response.json(libraryWithLocalImage());
      return Response.json({ error: "UNEXPECTED_REQUEST" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ModelLibrary onNavigate={() => {}} />);

    // 以既有組合的名稱（value）為錨點定位到 CombinationRow——「新增組合」表單也有一個
    // aria-label 相同的空白輸入，故用 display value 區分；再取其影像下拉（三個 select 依序
    // image/text/search）。
    const comboName = await screen.findByDisplayValue("預設組合");
    const comboRow = comboName.closest(".model-library-combo") as HTMLElement;
    const imageSelect = within(comboRow).getAllByRole("combobox")[0] as HTMLSelectElement;
    const optionLabels = [...imageSelect.options].map((option) => option.textContent);

    // local-inpaint 綁進組合的影像模型必然在生成時失敗，故不得出現在下拉。
    expect(optionLabels).toContain("Mock 生圖");
    expect(optionLabels).not.toContain("OpenCV 抹字修補（本機）");
  });
});

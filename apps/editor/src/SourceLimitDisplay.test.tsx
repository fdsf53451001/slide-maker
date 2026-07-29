// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createDefaultStyle,
  createProject,
  MAX_DECK_IMPORT_PAGES,
  MAX_UPLOAD_BYTES,
  SOURCE_COUNT_LIMIT,
  STYLE_REFERENCE_IMAGE_LIMIT,
  URL_SOURCE_BATCH_LIMIT,
  type SourceAsset,
} from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { SourcePanel } from "./SourcePanel.js";
import { MAX_ANALYSIS_PAGES } from "./PdfDeckAnalysis.js";
import { PdfDeckImportModal } from "./PdfDeckImportModal.js";

/**
 * 前端顯示的上限數字必須來自 core 的常數，不是自己抄一份。
 *
 * 使用者實測時看到的是 `SOURCES 175/100`：伺服器早就放寬到 200，畫面上還印著寫死的 100，
 * 而且沒有任何測試會紅——`SourcePanel` 的註解當時正好在講「抄一份到前端就是第二份真相」，
 * 同一批改動裡卻留著另一個實例，還是使用者每天看得到的那個。
 *
 * 這裡刻意**與常數比對而不是與字面量 200 比對**：寫死 200 只是把過期時間往後推，
 * 下次改上限時這個測試自己就會變成新的第二份真相。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sourceAt = (index: number): SourceAsset => ({
  id: `source-${index}`,
  name: `來源-${index}.md`,
  mediaType: "text/markdown",
  usage: "content",
  allowModelAccess: true,
  status: "indexed",
  assetPath: `assets/source-${index}.md`,
  sizeBytes: 16,
  extractedText: "內容",
  chunks: [],
  metadata: {},
  createdAt: "2026-07-29T00:00:00.000Z",
});

describe("來源面板顯示的上限", () => {
  it("SOURCES 的分母就是 SOURCE_COUNT_LIMIT，不是寫死的數字", async () => {
    const project = createProject({ topic: "上限顯示", brief: { desiredSlideCount: 1 } });
    // 用一個「不等於上限、也不等於舊上限」的份數，分子分母都驗得出來。
    project.sources = Array.from({ length: 7 }, (_value, index) => sourceAt(index));
    project.workflowStage = "editing";
    const now = new Date().toISOString();
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
        if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
        if (path === "/api/providers") return Response.json([]);
        if (path.startsWith("/api/projects/")) return Response.json(project);
        return Response.json([]);
      }),
    );

    render(<Editor />);
    // 專案列表 → 進專案 → 切到來源分頁，與使用者實測時看到 `SOURCES 175/100` 的路徑一致。
    fireEvent.click(await screen.findByText("上限顯示"));
    fireEvent.click(await screen.findByRole("button", { name: /來源 7/ }));
    const sources = await screen.findByText("SOURCES");

    expect(sources.parentElement?.textContent).toContain(`7/${SOURCE_COUNT_LIMIT}`);
    // 舊的寫死值不得再出現在這一格裡（上限改動時它就是那個過期的分母）。
    expect(sources.parentElement?.textContent).not.toContain("/100");
  });

  it("貼上網址的筆數上限來自 URL_SOURCE_BATCH_LIMIT", () => {
    const project = createProject({ topic: "貼上網址", brief: { desiredSlideCount: 1 } });
    render(<SourcePanel project={project} onProject={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByText("＋ 貼上網址"));

    expect(screen.getByText(new RegExp(`最多 ${URL_SOURCE_BATCH_LIMIT} 筆`))).toBeTruthy();
    // 超過上限的提示也用同一個數字：兩處分歧時使用者會被告知一個伺服器不認的上限。
    const textarea = screen.getByLabelText("網址清單") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: Array.from(
          { length: URL_SOURCE_BATCH_LIMIT + 1 },
          (_value, index) => `https://example.com/${index}`,
        ).join("\n"),
      },
    });
    expect(screen.getByText(new RegExp(`超過上限 ${URL_SOURCE_BATCH_LIMIT} 筆`))).toBeTruthy();
  });

  it("風格分析的挑頁上限與風格參考圖的上限是同一個數字", () => {
    // 這個 4 原本散在四個檔案（core 的 schema、伺服器兩個端點、編輯器），改動時必漏一個。
    expect(MAX_ANALYSIS_PAGES).toBe(STYLE_REFERENCE_IMAGE_LIMIT);
  });

  it("PDF 匯入視窗寫給使用者的頁數與檔案上限來自同一組常數", () => {
    // 放寬伺服器上限之後，畫面若還印著舊數字，等於繼續勸退做得到的事。
    render(<PdfDeckImportModal onClose={vi.fn()} onImported={vi.fn()} />);
    const hint = screen.getByText(/只收 16:9 的頁面/);
    expect(hint.textContent).toContain(`最多 ${MAX_DECK_IMPORT_PAGES} 頁`);
    expect(hint.textContent).toContain(`${Math.round(MAX_UPLOAD_BYTES / 1024 ** 2)}MB`);
  });
});

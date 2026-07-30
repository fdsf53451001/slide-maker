// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProject, type SourceAsset } from "@slide-maker/core";
import { SourcePanel } from "./SourcePanel.js";
import { PdfImportModal } from "./PdfImportModal.js";

/**
 * 對話框的忙碌守衛與焦點契約。
 *
 * 這一組釘的都是「畫面關掉了、工作還在跑」這一類：使用者以為自己取消了，伺服器那邊卻
 * 照樣落地，而畫面上再也找不到任何線索。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const now = new Date().toISOString();
const textSource = (id: string, name: string): SourceAsset => ({
  id,
  name,
  mediaType: "text/markdown",
  usage: "content",
  allowModelAccess: true,
  status: "indexed",
  assetPath: `sources/${id}.md`,
  sizeBytes: 128,
  extractedText: "內容",
  chunks: [],
  metadata: {},
  createdAt: now,
});

function panelWithSource() {
  const project = {
    ...createProject({ topic: "對話框守衛", brief: { desiredSlideCount: 1 } }),
    sources: [textSource("src-1", "note.md")],
  };
  render(<SourcePanel project={project} onProject={vi.fn()} onError={vi.fn()} />);
  return project;
}

describe("SourcePanel 的 Escape 鏈", () => {
  it("搜尋資料儲存中按 Escape 不會關掉對話框（addWebSources 還在跑）", async () => {
    const project = panelWithSource();
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = typeof input === "string" ? input : String(input);
        if (path.includes("/web-search"))
          return Response.json([{ url: "https://example.com/a", title: "A", summary: "s" }]);
        // 儲存永遠停在半路，模擬「按下加入之後那幾秒」。
        return new Promise<Response>((resolve) => {
          release = () => resolve(Response.json(project));
        });
      }),
    );

    fireEvent.click(screen.getByText("＋ 從網路加入資料"));
    fireEvent.change(screen.getByLabelText("搜尋關鍵字"), { target: { value: "測試關鍵字" } });
    fireEvent.click(screen.getByRole("button", { name: "搜尋" }));
    const save = await screen.findByRole("button", { name: /加入所選來源/ });
    fireEvent.click(save);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /正在擷取全文並儲存/ })).toBeTruthy(),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "搜尋並加入資料" })).toBeTruthy();

    release!();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "搜尋並加入資料" })).toBeNull(),
    );
  });

  it("對話框忙碌中按 Escape 不會掉到「清空搜尋關鍵字」那一支", async () => {
    const project = panelWithSource();
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(Response.json({ project, failures: [] }, { status: 201 }));
          }),
      ),
    );

    const search = screen.getByLabelText("搜尋來源") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "note" } });

    fireEvent.click(screen.getByText("＋ 貼上網址"));
    fireEvent.change(screen.getByLabelText("網址清單"), {
      target: { value: "https://example.com/slow" },
    });
    fireEvent.click(screen.getByRole("button", { name: /加入網址來源/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /正在擷取網頁正文/ })).toBeTruthy(),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    // 對話框沒關（正確），但背後的搜尋框也不該被清掉——那會讓整份來源清單在對話框後面跳掉。
    expect(screen.queryByRole("dialog", { name: "貼上網址" })).toBeTruthy();
    expect((screen.getByLabelText("搜尋來源") as HTMLInputElement).value).toBe("note");

    release!();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "貼上網址" })).toBeNull());
  });

  it("別的元件開著對話框時，Escape 也不清掉背後的搜尋框", () => {
    panelWithSource();
    const search = screen.getByLabelText("搜尋來源") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "note" } });

    /*
      模擬 header 齒輪開出來的系統設定對話框：它與 `SourcePanel` 住在同一個 shell 裡，但狀態在
      別的元件，這條 Escape 鏈自己那四個旗標一個都不會亮。它會 fall through 到最後一支，
      無聲清掉背後的搜尋框，整份來源清單在對話框後面跳掉（175 份縮到 3 張又彈回全部）。
      判準用 `[role="dialog"][aria-modal="true"]`，與 `Editor` 的三條 handler 同一份。
    */
    const foreign = document.createElement("div");
    foreign.setAttribute("role", "dialog");
    foreign.setAttribute("aria-modal", "true");
    document.body.append(foreign);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect((screen.getByLabelText("搜尋來源") as HTMLInputElement).value).toBe("note");
    } finally {
      foreign.remove();
    }

    // 對話框收掉之後，Escape 又該回去清搜尋框（那是它自己的職責）。
    fireEvent.keyDown(window, { key: "Escape" });
    expect((screen.getByLabelText("搜尋來源") as HTMLInputElement).value).toBe("");
  });
});

describe("來源卡片上的「AI 未讀取圖片內容」", () => {
  it("是持久狀態而不是事件：不得用 assertive 的 role=alert", () => {
    const project = {
      ...createProject({ topic: "描述失敗", brief: { desiredSlideCount: 1 } }),
      sources: [1, 2, 3].map((n) => ({
        ...textSource(`img-${n}`, `chart-${n}.png`),
        mediaType: "image/png" as const,
        usage: "visual-reference" as const,
        extractedText: "",
        metadata: { imageDescriptionFailure: "unsupported" },
      })),
    };
    render(<SourcePanel project={project} onProject={vi.fn()} onError={vi.fn()} />);

    const warnings = document.querySelectorAll(".source-describe-failed");
    expect(warnings).toHaveLength(3);
    // 12 張圖同時失敗時，掛載這一頁就等於 12 次強制插播並打斷讀屏正在念的內容。
    for (const node of warnings) expect(node.getAttribute("role")).toBeNull();
  });
});

describe("PdfImportModal 是一個真正的對話框", () => {
  const pagesResponse = () =>
    Response.json({
      pages: ["data:image/png;base64,iVBORw0KGgo="],
      totalPages: 1,
      truncated: false,
    });

  it("有 dialog 角色與名稱、關閉鈕有可及名稱", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pagesResponse()),
    );
    render(<PdfImportModal remaining={4} onImported={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "從 PDF 匯入參考圖" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "關閉" })).toBeTruthy();
  });

  it("Escape 可關閉；上傳中則遮罩點擊與 Escape 都擋住", async () => {
    const onClose = vi.fn();
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = typeof input === "string" ? input : String(input);
        if (path.includes("/pdf-pages")) return pagesResponse();
        if (path.startsWith("data:")) return new Response(new Blob([new Uint8Array([1])]));
        return new Promise<Response>((resolve) => {
          release = () => resolve(Response.json({ id: "ref", name: "p1.png" }, { status: 201 }));
        });
      }),
    );

    const { container } = render(
      <PdfImportModal remaining={4} onImported={vi.fn()} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array([1])], "deck.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: /第 1 頁/ }));
    fireEvent.click(screen.getByRole("button", { name: /加入 1 張/ }));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());

    // 上傳中：背景點擊與 Escape 都不該把對話框連同進行中的迴圈與錯誤訊息一起丟掉。
    fireEvent.click(container.querySelector(".pdf-modal-backdrop")!);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    release!();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProject, type PresentationProject } from "@slide-maker/core";
import { SourcePanel } from "./SourcePanel.js";

/**
 * 「貼上網址」對話框的對抗性測試：多行解析、上限、送出中狀態、失敗清單的誠實度。
 *
 * 直接掛 `SourcePanel`（而不是整個 Editor）是為了讓每個情境只需要造一個假回應——
 * 用整個 Editor 會讓一半的 assertion 花在無關的載入流程上。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel() {
  const project = createProject({ topic: "貼上網址", brief: { desiredSlideCount: 1 } });
  const onProject = vi.fn();
  const onError = vi.fn();
  render(<SourcePanel project={project} onProject={onProject} onError={onError} />);
  fireEvent.click(screen.getByText("＋ 貼上網址"));
  const textarea = screen.getByLabelText("網址清單") as HTMLTextAreaElement;
  const paste = (value: string) => fireEvent.change(textarea, { target: { value } });
  return { project, onProject, onError, textarea, paste };
}

const submitButton = () =>
  screen.getByRole("button", { name: /加入網址來源|正在擷取網頁正文/ }) as HTMLButtonElement;

/** 假的 /url-sources 回應；其餘請求一律失敗（這個對話框不該打別的端點）。 */
function stubUrlSources(respond: (urls: string[]) => Response | Promise<Response>) {
  const seen: string[][] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!path.endsWith("/url-sources")) throw new Error(`unexpected request: ${path}`);
    const urls = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
    seen.push(urls);
    return respond(urls);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { seen, fetchMock };
}

const projectResponse = (project: PresentationProject, failures: unknown[] = []) =>
  Response.json({ project, failures }, { status: 201 });

describe("貼上網址對話框", () => {
  it("多行貼上：忽略空行與前後空白、重複網址只送一次、順序不變", async () => {
    const { project, paste } = renderPanel();
    const { seen } = stubUrlSources(() => projectResponse(project));
    paste(
      [
        "  https://example.com/a  ",
        "",
        "   ",
        "https://example.com/b",
        "https://example.com/a",
      ].join("\n"),
    );
    expect(submitButton().textContent).toContain("加入網址來源（2）");
    fireEvent.click(submitButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("\\r\\n 換行（從 Windows／試算表貼上）也切得開", async () => {
    const { project, paste } = renderPanel();
    const { seen } = stubUrlSources(() => projectResponse(project));
    paste("https://example.com/a\r\nhttps://example.com/b");
    fireEvent.click(submitButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("空白輸入時送不出去", () => {
    const { paste } = renderPanel();
    const { fetchMock } = stubUrlSources(() => new Response(null));
    paste("   \n\n  ");
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(submitButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("超過 10 筆：明講超過上限並擋住送出", () => {
    const { paste } = renderPanel();
    const { fetchMock } = stubUrlSources(() => new Response(null));
    paste(Array.from({ length: 11 }, (_value, index) => `https://example.com/${index}`).join("\n"));
    expect(screen.getByText(/超過上限 10 筆/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(submitButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("送出中：按鈕顯示進行中並鎖住，關閉與取消也一起鎖住", async () => {
    const { project, paste } = renderPanel();
    let release: (() => void) | undefined;
    stubUrlSources(
      async () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(projectResponse(project));
        }),
    );
    paste("https://example.com/slow");
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().textContent).toBe("正在擷取網頁正文…"));
    expect(submitButton().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "關閉貼上網址" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // 送出中點背景不該把對話框關掉（請求還在跑，關掉等於讓使用者不知道結果）。
    fireEvent.click(screen.getByRole("dialog", { name: "貼上網址" }));
    expect(screen.queryByLabelText("網址清單")).toBeTruthy();
    release!();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "貼上網址" })).toBeNull());
  });

  it("全部成功就關閉對話框並把新專案交回去", async () => {
    const { project, paste } = renderPanel();
    const updated = structuredClone(project);
    const onProject = vi.fn();
    cleanup();
    render(<SourcePanel project={project} onProject={onProject} onError={vi.fn()} />);
    fireEvent.click(screen.getByText("＋ 貼上網址"));
    stubUrlSources(() => projectResponse(updated));
    fireEvent.change(screen.getByLabelText("網址清單"), {
      target: { value: "https://example.com/ok" },
    });
    fireEvent.click(submitButton());
    await waitFor(() => expect(onProject).toHaveBeenCalledWith(updated));
    expect(screen.queryByRole("dialog", { name: "貼上網址" })).toBeNull();
  });

  it("部分失敗：對話框留著、只剩失敗的網址、原因翻成人話，專案照樣更新", async () => {
    const { project, paste } = renderPanel();
    const onProject = vi.fn();
    cleanup();
    render(<SourcePanel project={project} onProject={onProject} onError={vi.fn()} />);
    fireEvent.click(screen.getByText("＋ 貼上網址"));
    stubUrlSources(() =>
      projectResponse(project, [
        { url: "https://example.com/spa", reason: "WEB_SOURCE_CONTENT_UNVERIFIED" },
      ]),
    );
    fireEvent.change(screen.getByLabelText("網址清單"), {
      target: { value: "https://example.com/ok\nhttps://example.com/spa" },
    });
    fireEvent.click(submitButton());
    await waitFor(() => expect(onProject).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "貼上網址" })).toBeTruthy();
    expect((screen.getByLabelText("網址清單") as HTMLTextAreaElement).value).toBe(
      "https://example.com/spa",
    );
    expect(screen.getByText(/抓不到網頁正文/)).toBeTruthy();
    void paste;
  });

  it("沒對到翻譯的錯誤代碼原樣顯示，不會被吞掉", async () => {
    const { project, paste } = renderPanel();
    stubUrlSources(() =>
      projectResponse(project, [{ url: "https://example.com/x", reason: "WEB_SOURCE_HTTP_451" }]),
    );
    paste("https://example.com/x\nhttps://example.com/y");
    fireEvent.click(submitButton());
    expect(await screen.findByText("WEB_SOURCE_HTTP_451")).toBeTruthy();
  });

  it("全部失敗：顯示伺服器訊息與逐筆原因，且不會回報一份新專案", async () => {
    const { onProject, paste } = renderPanel();
    stubUrlSources(() =>
      Response.json(
        {
          error: "URL_SOURCES_UNVERIFIED",
          message: "沒有任何網址取得可驗證的正文，因此未加入專案。",
          failures: [{ url: "http://127.0.0.1/admin", reason: "WEB_SOURCE_URL_PRIVATE" }],
        },
        { status: 400 },
      ),
    );
    paste("http://127.0.0.1/admin");
    fireEvent.click(submitButton());
    expect(await screen.findByText(/沒有任何網址取得可驗證的正文/)).toBeTruthy();
    expect(screen.getByText(/指向本機或內網位址/)).toBeTruthy();
    expect(onProject).not.toHaveBeenCalled();
    // 失敗後可以直接改一改再送一次。
    expect((screen.getByLabelText("網址清單") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("上限錯誤（409）不會被誤翻成「抓不到正文」，但只看得到裸錯誤代碼", async () => {
    const { paste } = renderPanel();
    stubUrlSources(() => Response.json({ error: "SOURCE_PROJECT_LIMIT" }, { status: 409 }));
    paste("https://example.com/full");
    fireEvent.click(submitButton());
    // 至少沒有謊稱是網頁的問題；但「專案來源已達上限」這句話始終沒有出現，
    // 使用者看到的是伺服器的錯誤代碼原文（見報告 D5：這條路連 failures 都沒有）。
    expect(await screen.findByText("SOURCE_PROJECT_LIMIT")).toBeTruthy();
    expect(screen.queryByText(/抓不到網頁正文/)).toBeNull();
  });

  /**
   * 【缺陷 D6】伺服器對無效網址不做去重（`seen` 只擋通過驗證的網址），同一個無效網址
   * 貼兩次就會回兩筆一模一樣的 failure；失敗清單用 `key={failure.url}` 當 list key，
   * React 會在 console 報重複 key。清單本身還畫得出來，所以這是體感層級的問題，但它
   * 也代表「失敗清單的每一列不是唯一的」，未來要做逐列重試就會撞上。
   *
   * 現況：這一條是紅的（React 會 log「Encountered two children with the same key」）。
   */
  it.fails("【缺陷 D6】重複的失敗網址不該產生重複的 React key", async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
    const { project, paste } = renderPanel();
    stubUrlSources(() =>
      projectResponse(project, [
        { url: "https://example.com/x", reason: "WEB_SOURCE_URL_INVALID" },
        { url: "https://example.com/x", reason: "WEB_SOURCE_URL_INVALID" },
      ]),
    );
    paste("https://example.com/x\nhttps://example.com/y");
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getAllByText(/網址格式不正確/)).toHaveLength(2));
    expect(errors.flat().join(" ")).not.toContain("same key");
  });
});

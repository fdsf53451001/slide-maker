// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createProject, createDefaultStyle, type PresentationProject } from "@slide-maker/core";
import { batchExtractPlan, Editor } from "./Editor.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const now = new Date().toISOString();

type Kind = "plain" | "extracted" | "manual" | "no-image";

/**
 * 依序造出四種頁面：沒有文字層、已抽離的文字層、手動文字層、還沒有圖。
 * 合格的只有「沒有文字層」與「手動文字層」兩種。
 */
const projectWith = (topic: string, kinds: Kind[]): PresentationProject => {
  const project = createProject({ topic, brief: { desiredSlideCount: kinds.length } });
  project.workflowStage = "editing";
  project.slides = project.slides.slice(0, kinds.length);
  project.slides.forEach((slide, index) => {
    const kind = kinds[index]!;
    if (kind === "no-image") {
      slide.versions = [];
      delete slide.currentVersionId;
      return;
    }
    const layer =
      kind === "plain"
        ? undefined
        : {
            originalVersionId: `${slide.id}-v1`,
            backgroundPath: `assets/generated/${slide.id}.png`,
            compositePath: `assets/generated/${slide.id}-composite.png`,
            threshold: 0.75,
            renderRevision: 0,
            boxes: [],
            origin: kind,
            extractedAt: now,
            updatedAt: now,
          };
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
        ...(layer ? { textLayer: layer } : {}),
      },
    ];
    slide.currentVersionId = `${slide.id}-v1`;
  });
  return project;
};

interface ExtractStub {
  /** 每一次 `POST …/extract-text` 的 slide id，依送出順序。 */
  calls: string[];
  /** 讓最新那一筆抽字請求回應。 */
  release: (body?: { status: number; payload: unknown }) => void;
  /** 目前有幾筆抽字請求在飛（驗「嚴格循序」用）。 */
  inFlight: () => number;
  /** `GET /api/ocr/status` 被打了幾次（驗「開跑前只檢查一次」用）。 */
  ocrStatusCalls: () => number;
}

const stubApi = (
  project: PresentationProject,
  ocrAvailable = true,
  /** 其餘出現在專案列表裡的專案（測「批次途中換專案」用）。 */
  others: PresentationProject[] = [],
  /** 讓 `GET /api/projects/:id`（逐頁重讀）失敗，測它不會被記成該頁抽字失敗。 */
  reloadFails = false,
): ExtractStub => {
  const calls: string[] = [];
  let inFlight = 0;
  let ocrStatusCalls = 0;
  let resolveCurrent: ((value: { status: number; payload: unknown }) => void) | undefined;
  const known = [project, ...others];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://local.test").pathname;
    if (path.endsWith("/extract-text") && init?.method === "POST") {
      calls.push(path.split("/slides/")[1]!.replace("/extract-text", ""));
      inFlight += 1;
      const outcome = await new Promise<{ status: number; payload: unknown }>((resolve) => {
        resolveCurrent = resolve;
      });
      inFlight -= 1;
      return Response.json(outcome.payload, { status: outcome.status });
    }
    if (path === "/api/projects") return Response.json(known);
    // `GET /api/projects/:id` 要依 id 回對應的那一份，否則「換專案」的測試分不出
    // 「寫回了舊專案」與「本來就長一樣」。
    const match = known.find((candidate) => path === `/api/projects/${candidate.id}`);
    if (match && init?.method === undefined) {
      // 只在批次已經開始送頁之後才壞，開專案那一趟要放行（否則連畫面都進不去）。
      if (reloadFails && calls.length > 0)
        return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
      return Response.json(match);
    }
    if (path === "/api/providers")
      return Response.json([
        {
          id: "mock-image",
          name: "Mock",
          availability: { status: "available" },
          capabilities: { fullSlideGeneration: true, imageEditing: true, maskedEditing: true },
        },
      ]);
    if (path === "/api/styles") return Response.json([createDefaultStyle()]);
    if (path === "/api/model-library")
      return Response.json({ connections: [], models: [], combinations: [] });
    if (path === "/api/text-providers") return Response.json([]);
    if (path === "/api/ocr/status") {
      ocrStatusCalls += 1;
      return Response.json({
        available: ocrAvailable,
        message: ocrAvailable ? "ok" : "OCR 環境沒有安裝，無法抽離文字。",
      });
    }
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
  return {
    calls,
    release: (body = { status: 202, payload: { id: "job", status: "queued" } }) => {
      const resolve = resolveCurrent;
      resolveCurrent = undefined;
      resolve?.(body);
    },
    inFlight: () => inFlight,
    ocrStatusCalls: () => ocrStatusCalls,
  };
};

/**
 * 讓已經解析的 promise 鏈與 React 的更新都跑完（測「之後什麼都沒再發生」用）。
 *
 * **一定要包在 `act()` 裡**：批次是一條在測試主體之外推進的 async 鏈，它呼叫的
 * `setProject`／`setError` 都落在 act 之外，React 只把它們排進佇列而不會 render。
 * 光 `await setTimeout` 的話，「舊專案的內容被寫回畫面」這種錯誤根本不會顯示出來——
 * 斷言讀到的仍是舊的 DOM，測試於是綠著放過去（實測：拿掉寫回前的守衛，整組還是全綠）。
 */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

const openProjectPanel = async (topic: string) => {
  fireEvent.click(await screen.findByText(topic));
  fireEvent.click(await screen.findByRole("button", { name: "專案" }));
};

const batchButton = () =>
  screen.getByRole("button", { name: /^(批次抽離全部文字|抽離文字 \d+ \/ \d+…)$/ });

/** 編輯器的錯誤列（`.toast.error`，節點內容是「訊息 ×」）。 */
const errorToast = () => document.querySelector(".toast.error");
const findErrorToast = async () => {
  await waitFor(() => expect(errorToast()).toBeTruthy());
  return errorToast()!;
};

/**
 * 編輯器的**非錯誤**通知列（`.toast.import-report`）。
 *
 * 摘要分兩條通道是刻意的：使用者自己按的「停止」不是故障，用紅色錯誤列回報等於在說他
 * 做錯了什麼。真的有頁面失敗、或伺服器層級的中止才走 `.toast.error`。
 */
const noticeToast = () => document.querySelector(".toast.import-report");
const findNoticeToast = async () => {
  await waitFor(() => expect(noticeToast()).toBeTruthy());
  return noticeToast()!;
};

/**
 * 批次按鈕的說明文字。
 *
 * 讀的是**外層 `.batch-extract-row`** 而不是按鈕本身：按鈕在最需要解釋的時候正好是
 * disabled 的，而瀏覽器不會對 disabled 的表單控制項派送指標事件——掛在它身上的 tooltip
 * 使用者一次都看不到。jsdom 不模擬這件事，所以「按鈕上有 title 屬性」這種斷言即使綠了
 * 也證明不了任何事，必須釘在真正會顯示的那個節點上。
 */
const batchRowTitle = () =>
  document.querySelector<HTMLElement>(".batch-extract-row")?.getAttribute("title");

describe("batchExtractPlan", () => {
  it("只挑「有圖且還沒有 extracted 文字層」的頁，隱藏頁一併納入", () => {
    const project = projectWith("計畫", ["plain", "extracted", "manual", "no-image"]);
    project.slides[2]!.hidden = true;
    const plan = batchExtractPlan(project.slides);
    expect(plan.targets.map((slide) => slide.id)).toEqual([
      project.slides[0]!.id,
      project.slides[2]!.id,
    ]);
    expect(plan.hiddenTargets).toBe(1);
    expect(plan.skippedExtracted).toBe(1);
    expect(plan.skippedNoImage).toBe(1);
  });

  it("沒有 origin 的舊文字層視同 extracted（與單頁抽字鈕同一條規則）", () => {
    const project = projectWith("舊層", ["extracted"]);
    delete project.slides[0]!.versions[0]!.textLayer!.origin;
    expect(batchExtractPlan(project.slides).targets).toHaveLength(0);
    expect(batchExtractPlan(project.slides).skippedExtracted).toBe(1);
  });
});

describe("批次抽離全部文字", () => {
  it("確認框列出處理／跳過／隱藏頁數，取消就一個請求都不送", async () => {
    const project = projectWith("確認", ["plain", "extracted", "manual", "no-image"]);
    project.slides[2]!.hidden = true;
    const stub = stubApi(project);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Editor />);
    await openProjectPanel("確認");

    fireEvent.click(batchButton());
    const message = confirmSpy.mock.calls[0]![0] as string;
    expect(message).toContain("會處理 2 頁");
    expect(message).toContain("其中 1 頁是隱藏頁");
    expect(message).toContain("跳過 2 頁");
    expect(message).toContain("1 頁已經有可編輯文字層");
    expect(message).toContain("1 頁還沒有圖");
    expect(message).toContain("OpenCV");
    // 換專案會讓整批靜默停下、事後畫面上不留痕跡，使用者回來只會以為它跑完了。
    // 這句話必須在**開始之前**就講。
    expect(message).toContain("中途離開這份專案會停止批次");
    expect(stub.calls).toHaveLength(0);
  });

  /**
   * 伺服器的 OCR 閘門併發是 1、等待區 2 筆，第 4 筆起立刻 429。整批因此必須嚴格循序：
   * 同一時間只能有一筆請求在飛。
   */
  it("嚴格循序：前一頁沒回來之前，下一頁一個位元組都不送", async () => {
    const project = projectWith("循序", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("循序");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    expect(stub.inFlight()).toBe(1);
    // 進度顯示在按鈕上，且按鈕不可再按。
    await waitFor(() => expect(batchButton().textContent).toBe("抽離文字 1 / 3…"));
    expect((batchButton() as HTMLButtonElement).disabled).toBe(true);

    // 等一段時間也不會有第二筆偷跑。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.calls).toHaveLength(1);

    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    expect(stub.inFlight()).toBe(1);
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(3));
    stub.release();

    // 全部成功：不留任何錯誤訊息，按鈕回到原本的字。
    await waitFor(() => expect(batchButton().textContent).toBe("批次抽離全部文字"));
    expect(errorToast()).toBeNull();
    expect(stub.calls).toEqual(project.slides.map((slide) => slide.id));
  });

  it("單頁的 4xx 不中斷整批，最後把逐頁原因寫進錯誤訊息", async () => {
    const project = projectWith("單頁失敗", ["plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("單頁失敗");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release({
      status: 422,
      payload: { error: "OCR_NO_TEXT", message: "這一頁沒有偵測到文字。" },
    });
    // 第二頁照樣送出。
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    stub.release();

    const toast = await findErrorToast();
    expect(toast.textContent).toContain("成功 1 頁");
    expect(toast.textContent).toContain("失敗 1 頁");
    expect(toast.textContent).toContain("第 1 頁：這一頁沒有偵測到文字。");
  });

  it("OCR_QUEUE_BUSY 是伺服器層級的拒絕，整批立刻停下並說明", async () => {
    const project = projectWith("整批中止", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("整批中止");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release({
      status: 429,
      payload: { error: "OCR_QUEUE_BUSY", message: "另一頁正在抽離文字，請稍候再試。" },
    });

    const toast = await findErrorToast();
    expect(toast.textContent).toContain("已中止");
    expect(toast.textContent).toContain("還有 2 頁沒有送出");
    expect(toast.textContent).toContain("另一頁正在抽離文字，請稍候再試。");
    // 停下來就是停下來：不再有第二筆。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.calls).toHaveLength(1);
  });

  it("「停止」做完當前這一頁才停，摘要說明是使用者中止的", async () => {
    const project = projectWith("中止測試", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("中止測試");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await screen.findByRole("button", { name: "停止中…" });
    // 在飛的那一頁沒有取消機制，它照樣跑完並寫回。
    stub.release();

    // 一頁都沒失敗的中止走**非錯誤**通道：使用者自己按的停止不是故障，紅色錯誤列
    // 讀起來像出事了。真的有失敗頁時才會改走 `.toast.error`（見下一條測試）。
    const toast = await findNoticeToast();
    expect(toast.textContent).toContain("已由你中止");
    expect(toast.textContent).toContain("完成 1 頁");
    expect(toast.textContent).toContain("還有 2 頁沒有送出");
    expect(errorToast()).toBeNull();
    expect(stub.calls).toHaveLength(1);
  });

  /**
   * 停止按在**最後一頁**上時迴圈是自然結束的，沒有「下一頁」可以擋。少了收尾那一句
   * 補判，這條路會命中「全部跑完就不留訊息」的 early return：使用者按了停止，畫面上
   * 按鈕直接變回原樣，一個字都沒有，完全不知道自己那一下有沒有被收到。
   */
  it("在最後一頁按停止仍會回報，不會靜悄悄結束", async () => {
    const project = projectWith("最後一頁停止", ["plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("最後一頁停止");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release();
    // 已經在跑最後一頁了才按停止。
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    stub.release();

    const toast = await findNoticeToast();
    expect(toast.textContent).toContain("完成 2 頁");
    // 兩頁都做完了，不可以說「還有 N 頁沒有送出」。
    expect(toast.textContent).not.toContain("沒有送出");
    expect(errorToast()).toBeNull();
  });

  /**
   * 5xx 沒有具名代碼（`MASKED_EDITING_UNSUPPORTED` 這類裸 `Error` 會落到伺服器最後那條
   * `INTERNAL_SERVER_ERROR`），但它同樣是「下一頁不會變好」。只認代碼的話，150 頁的
   * 專案會照樣送 150 次註定失敗的請求，每一次都還先排一輪 OCR 佇列。
   */
  it("5xx 也整批停下，不是逐頁重試到底", async () => {
    const project = projectWith("伺服器炸了", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("伺服器炸了");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release({ status: 500, payload: { error: "INTERNAL_SERVER_ERROR" } });

    const toast = await findErrorToast();
    expect(toast.textContent).toContain("已中止");
    expect(toast.textContent).toContain("還有 2 頁沒有送出");
    await settle();
    expect(stub.calls).toHaveLength(1);
  });

  /**
   * `/api/ocr/status` 自己壞掉（500、非 JSON）時，例外會從 `void runBatchTextExtraction()`
   * 漏出去變成 unhandled rejection——使用者按下去只看到按鈕閃一下，畫面上一個字都沒有。
   */
  it("查 OCR 狀態的那一趟自己失敗時也要說話，不是靜默吞掉", async () => {
    const project = projectWith("狀態端點壞了", ["plain", "plain"]);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      if (path.endsWith("/extract-text") && init?.method === "POST") {
        calls.push(path);
        return Response.json({ id: "job" }, { status: 202 });
      }
      // 非 JSON 的 500：`response.json()` 直接 reject，連 ApiError 都構造不出來。
      if (path === "/api/ocr/status")
        return new Response("<html>502 Bad Gateway</html>", { status: 500 });
      if (path === "/api/projects") return Response.json([project]);
      if (path === `/api/projects/${project.id}`) return Response.json(project);
      if (path === "/api/providers")
        return Response.json([
          {
            id: "mock-image",
            name: "Mock",
            availability: { status: "available" },
            capabilities: { fullSlideGeneration: true, imageEditing: true, maskedEditing: true },
          },
        ]);
      if (path === "/api/styles") return Response.json([createDefaultStyle()]);
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
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
    window.addEventListener("unhandledrejection", onRejection);
    render(<Editor />);
    await openProjectPanel("狀態端點壞了");

    fireEvent.click(batchButton());
    // 訊息一定要出現，而且進度不能卡住。
    await findErrorToast();
    await settle();
    window.removeEventListener("unhandledrejection", onRejection);

    expect(rejections).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(batchButton().textContent).toBe("批次抽離全部文字");
  });

  /**
   * 循序不變量的另一半：批次進行中不准再單獨抽一頁。單頁那顆的守門是 `textLayerBusy`，
   * 只看「當前這一頁」——使用者切到別頁它就亮了，於是兩個 OCR 請求同時在飛，而伺服器的
   * 閘門只有 1 active ＋ 2 waiting，多出來的那筆很容易讓批次裡的某頁撞上 429 而整批中止。
   */
  it("批次進行中，單頁「抽離文字」也是灰的（含切到別頁之後）", async () => {
    const project = projectWith("互斥", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("互斥");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));

    const singleExtract = () =>
      screen.getByRole("button", { name: /^(抽離文字|處理中…)$/ }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("button", { name: "頁面" }));
    expect(singleExtract().disabled).toBe(true);
    // 切到別頁也一樣：`textLayerBusy` 是逐頁的，擋不住這件事。
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(singleExtract().disabled).toBe(true));
    // 說明掛在外層容器上（disabled 的按鈕收不到指標事件）。
    expect(document.querySelector(".text-extraction-control")?.getAttribute("title")).toContain(
      "批次抽離文字進行中",
    );

    // 批次跑完之後解鎖。
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(3));
    stub.release();
    await waitFor(() => expect(singleExtract().disabled).toBe(false));
  });

  /** 反方向：單頁抽字在飛的時候不准開批次（同一條閘門，同一個 429 風險）。 */
  it("單頁抽字進行中時批次按鈕是灰的，並說明原因", async () => {
    const project = projectWith("反向互斥", ["plain", "plain"]);
    const stub = stubApi(project);
    render(<Editor />);
    fireEvent.click(await screen.findByText("反向互斥"));
    await screen.findByRole("button", { name: "專案" });

    // 從「頁面」分頁送出單頁抽字，請求停在飛行中。
    fireEvent.click(screen.getByRole("button", { name: /^抽離文字$/ }));
    await waitFor(() => expect(stub.calls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "專案" }));
    expect((batchButton() as HTMLButtonElement).disabled).toBe(true);
    expect(batchRowTitle()).toContain("有頁面正在抽離文字");

    stub.release();
    await waitFor(() => expect((batchButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it("OCR 不可用時直接顯示伺服器那句話，一頁都不送", async () => {
    const project = projectWith("OCR 壞了", ["plain", "plain"]);
    const stub = stubApi(project, false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("OCR 壞了");

    fireEvent.click(batchButton());
    const toast = await findErrorToast();
    expect(toast.textContent).toContain("OCR 環境沒有安裝");
    expect(stub.calls).toHaveLength(0);
  });

  it("沒有合格頁面時按鈕是灰的，並說明原因", async () => {
    const project = projectWith("全都抽過了", ["extracted", "extracted"]);
    stubApi(project);
    render(<Editor />);
    await openProjectPanel("全都抽過了");

    expect((batchButton() as HTMLButtonElement).disabled).toBe(true);
    // 說明讀外層那一列，不是按鈕本身（見 `batchRowTitle` 的註解：disabled 的按鈕
    // 不會收到指標事件，掛在它身上的 tooltip 使用者一次都看不到）。
    expect(batchRowTitle()).toBe("所有頁面都已經有可編輯文字層。");
  });

  /**
   * 跳過規則的**端到端**版本：`batchExtractPlan` 的單元測試只證明那個函式挑對了頁，
   * 證不了迴圈真的只跑它挑出來的那些頁。有人把迴圈改成直接吃 `project.slides`
   * （或「順手」把已抽過的頁也重跑一次拿新結果）時，只有這裡會紅。
   */
  it("只對合格頁送出請求：已抽過的與沒有圖的一個都不送，手動層與隱藏頁照送", async () => {
    const project = projectWith("跳過規則", ["extracted", "manual", "no-image", "plain"]);
    project.slides[1]!.hidden = true;
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("跳過規則");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    stub.release();
    await settle();

    // 順序也要對：依 `slides` 現有順序，manual（隱藏）在前、plain 在後。
    expect(stub.calls).toEqual([project.slides[1]!.id, project.slides[3]!.id]);
    expect(stub.calls).not.toContain(project.slides[0]!.id);
    expect(stub.calls).not.toContain(project.slides[2]!.id);
  });

  /**
   * OCR 可不可用是伺服器層級的事實，開跑前查一次就夠。改成逐頁查會讓 50 頁的批次多打
   * 50 趟往返，而且答案不會不一樣——真的中途壞掉是靠 `OCR_UNAVAILABLE` 的錯誤碼分岔
   * 停下來的，不是靠輪詢。
   */
  it("整批只查一次 OCR 狀態，不是每頁查一次", async () => {
    const project = projectWith("只查一次", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("只查一次");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(3));
    stub.release();
    await waitFor(() => expect(batchButton().textContent).toBe("批次抽離全部文字"));

    expect(stub.ocrStatusCalls()).toBe(1);
  });

  /**
   * `OCR_UNAVAILABLE`（409）與 `OCR_QUEUE_BUSY`（429）是不同的碼、不同的狀態，但同屬
   * 「伺服器現在整個不行」。只釘 QUEUE_BUSY 的話，有人把中止條件從那組代碼縮成
   * `status === 429` 也照樣綠。
   */
  it("逐頁請求撞到 OCR_UNAVAILABLE 也整批停下，不是只當成這一頁失敗", async () => {
    const project = projectWith("環境掛了", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("環境掛了");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release({
      status: 409,
      payload: { error: "OCR_UNAVAILABLE", message: "OCR 環境沒有安裝，無法抽離文字。" },
    });

    const toast = await findErrorToast();
    expect(toast.textContent).toContain("已中止");
    expect(toast.textContent).toContain("完成 0 頁");
    expect(toast.textContent).toContain("還有 2 頁沒有送出");
    // 撞出中止的那一頁不算「失敗頁」，它只是撞見了伺服器的狀態。
    expect(toast.textContent).not.toContain("失敗 1 頁");
    await settle();
    expect(stub.calls).toHaveLength(1);
  });

  /** 進度是使用者判斷「還要等多久」的唯一依據，必須逐頁前進到最後一頁而不是停在 1。 */
  it("進度逐頁前進到最後一頁，跑完才回到原本的按鈕字樣", async () => {
    const project = projectWith("進度", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("進度");

    fireEvent.click(batchButton());
    await waitFor(() => expect(batchButton().textContent).toBe("抽離文字 1 / 3…"));
    stub.release();
    await waitFor(() => expect(batchButton().textContent).toBe("抽離文字 2 / 3…"));
    stub.release();
    await waitFor(() => expect(batchButton().textContent).toBe("抽離文字 3 / 3…"));
    // 進行中「停止」在旁邊而且按得下去；跑完之後整顆消失。
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    stub.release();

    await waitFor(() => expect(batchButton().textContent).toBe("批次抽離全部文字"));
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停止中…" })).toBeNull();
  });

  /**
   * 錯誤列是一顆按鈕，逐頁原因最多列 6 筆、其餘只報數量。這條 slice 的邊界沒有人會手算，
   * 而 100 頁全失敗時把 100 條原因串上去等於一面文字牆。
   */
  it("失敗頁超過 6 頁時只列前 6 筆，其餘報數量", async () => {
    const project = projectWith(
      "整批失敗",
      Array.from({ length: 8 }, () => "plain" as const),
    );
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("整批失敗");

    fireEvent.click(batchButton());
    for (let page = 1; page <= 8; page += 1) {
      await waitFor(() => expect(stub.calls).toHaveLength(page));
      stub.release({
        status: 422,
        payload: { error: "OCR_NO_TEXT", message: `第 ${page} 頁沒有文字` },
      });
    }

    const toast = await findErrorToast();
    expect(toast.textContent).toContain("成功 0 頁");
    expect(toast.textContent).toContain("失敗 8 頁");
    expect(toast.textContent).toContain("第 6 頁：第 6 頁沒有文字");
    expect(toast.textContent).not.toContain("第 7 頁：");
    expect(toast.textContent).toContain("另有 2 頁");
    // 每一頁都送出去過了，不可以再說「還有 N 頁沒有送出」。
    expect(toast.textContent).not.toContain("沒有送出");
  });

  /**
   * 批次途中換專案：在飛的那一頁**照樣跑完**（伺服器端沒有取消機制），但它的結果
   * 一個位元組都不可以寫回畫面——`setProject` 拿到的是舊專案，會直接把新開的專案蓋掉。
   * 後續頁面也不可以再送，摘要更不可以跳出來（那是另一份專案的事）。
   */
  it("批次途中換專案：舊專案的結果不寫回、不再送下一頁、不留下卡住的進度", async () => {
    const source = projectWith("換走的專案", ["plain", "plain", "plain"]);
    const target = projectWith("換去的專案", ["plain"]);
    const stub = stubApi(source, true, [target]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("換走的專案");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));

    // 回列表再開另一份專案（header 左上角的 brand 是這條路的真實入口）。
    fireEvent.click(document.querySelector<HTMLElement>("button.brand")!);
    fireEvent.click(await screen.findByLabelText("開啟 換去的專案"));
    await screen.findByRole("button", { name: "專案" });

    // 在飛的那一頁現在才回來。
    stub.release();
    await settle();

    /*
     * 這裡**刻意沒有**「標題還是新專案」這種斷言。
     *
     * 寫回前那道 `batchExtractStop.current === "left"` 守衛擋的是 `setProject(舊專案)`，
     * 但它的後果在畫面上看不出來：`Editor` 另有一條路由對帳的 effect（`route` 形如
     * `/projects/:id` 時，把 `project` 拉回網址指的那一份），會在同一批更新裡把舊專案
     * 換回來。實測拿掉那道守衛，標題斷言照樣是綠的——寫了只會給人「有在防」的錯覺。
     * 這條測試真正釘得住的是下面三件事。
     */
    // 後續兩頁一個都沒送。
    expect(stub.calls).toHaveLength(1);
    // 摘要屬於舊專案，不可以出現在新專案的畫面上。
    expect(errorToast()).toBeNull();
    // 進度沒有卡住：新專案的按鈕是可按的原始狀態，不是「抽離文字 2 / 3…」。
    fireEvent.click(await screen.findByRole("button", { name: "專案" }));
    expect(batchButton().textContent).toBe("批次抽離全部文字");
    expect((batchButton() as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * 元件整個卸載（關掉編輯器）走的是同一條旗標，但沒有「後面還有畫面」可以看：
   * 這裡釘的是「不再送下一頁」，以及回應回來時不會炸出未捕捉的例外。
   */
  it("批次途中卸載編輯器：在飛的那一頁回來後不再送下一頁，也不丟出例外", async () => {
    const project = projectWith("卸載", ["plain", "plain", "plain"]);
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<Editor />);
    await openProjectPanel("卸載");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));

    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
    window.addEventListener("unhandledrejection", onRejection);
    view.unmount();
    stub.release();
    await settle();
    window.removeEventListener("unhandledrejection", onRejection);

    expect(stub.calls).toHaveLength(1);
    expect(rejections).toEqual([]);
  });

  /**
   * 有圖正在生成時抽字抽到的是**舊圖**（等一下就會被換掉），所以按鈕要灰掉並說明。
   * 這與「批次生成全部頁面」點擊時的門檻是同一條。
   */
  it("有頁面正在生成圖片時按鈕是灰的，並說出是哪一種阻擋", async () => {
    const project = projectWith("生成中", ["plain", "plain"]);
    project.jobs = [
      {
        id: "job-1",
        projectId: project.id,
        slideId: project.slides[0]!.id,
        providerId: "mock-image",
        status: "running",
        operation: "generate",
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    stubApi(project);
    render(<Editor />);
    await openProjectPanel("生成中");

    expect((batchButton() as HTMLButtonElement).disabled).toBe(true);
    /*
     * 說明讀外層那一列（disabled 的按鈕收不到指標事件）。
     *
     * 文案也不再只說「生成圖片」：這個門檻匹配的是**任何** queued/running 的 job，而實務上
     * 最常見的來源正是這個批次自己排的抹字 job——批次跑完後按鈕還灰著，卻寫「有頁面正在
     * 生成圖片」，使用者會去找一個根本不存在的生成工作。
     */
    expect(batchRowTitle()).toBe("有頁面的圖片工作還在跑（生成或抹字），等它完成再抽字。");
  });

  /**
   * 逐頁重讀專案（`GET /api/projects/:id`）只是為了讓畫面跟上，**不是**抽字成功與否的
   * 一部分：`extractText` 的 202 一回來，抹字 job 就已經寫進 project.json 了。網路抖一下
   * 害重讀失敗時把這一頁記成「抽字失敗」是在說謊——使用者會為一頁其實成功的頁重按一次，
   * 白燒一次 4GB 的 OCR。
   */
  it("逐頁重讀專案失敗不算該頁失敗，整批照樣往下跑", async () => {
    const project = projectWith("重讀失敗", ["plain", "plain"]);
    const stub = stubApi(project, true, [], true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("重讀失敗");

    fireEvent.click(batchButton());
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release();
    // 重讀 500 了，但下一頁照樣送。
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    stub.release();
    await waitFor(() => expect(batchButton().textContent).toBe("批次抽離全部文字"));
    await settle();

    // 兩頁都成功＝完全不留訊息（一句「失敗 2 頁」在這裡是純粹的假警報）。
    expect(errorToast()).toBeNull();
    expect(noticeToast()).toBeNull();
  });
});

/**
 * 抹字引擎選「生圖模型」時，抽字端點會**逐頁**排一個遮罩編輯 job，每頁燒一次影像模型
 * 配額——與「批次生成全部頁面」是同一個成本結構。CLAUDE.md 對這種情況明訂要用共用的
 * `BatchGenerateDialog` 三選一，不是只在 confirm 裡告知。
 *
 * OpenCV（預設）在本機跑、不吃配額，沒有取捨可問，所以**不得**多這一次點擊。
 */
describe("生圖模型引擎 × 隱藏頁：走共用的三選一", () => {
  /** 把抹字引擎從預設的 OpenCV 換成生圖模型（選單收在「頁面」分頁的 ▾ 裡）。 */
  const chooseModelEngine = () => {
    fireEvent.click(screen.getByRole("button", { name: "頁面" }));
    fireEvent.click(screen.getByRole("button", { name: "調整文字抽離選項" }));
    fireEvent.change(screen.getByLabelText("抹字引擎"), { target: { value: "model" } });
    fireEvent.click(screen.getByRole("button", { name: "專案" }));
  };

  it("生圖模型＋有隱藏頁：跳三選一，選「只抽可見頁」就不碰隱藏頁", async () => {
    const project = projectWith("要問清楚", ["plain", "plain", "plain"]);
    project.slides[1]!.hidden = true;
    const stub = stubApi(project);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("要問清楚");
    chooseModelEngine();

    fireEvent.click(batchButton());
    const dialog = await screen.findByRole("dialog", { name: "批次抽離文字與隱藏頁" });
    // 分母是**這次要抽字的頁數**，不是整份簡報的頁數。
    expect(dialog.textContent).toContain("這次會處理 3 頁");
    expect(dialog.textContent).toContain("消耗一次影像模型配額");
    within(dialog).getByRole("button", { name: "含隱藏頁一起抽（3 頁）" });

    fireEvent.click(within(dialog).getByRole("button", { name: "只抽可見頁（2 頁）" }));
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    stub.release();
    await settle();

    expect(stub.calls).toEqual([project.slides[0]!.id, project.slides[2]!.id]);
    // 對話框本身就是那次確認，不可以再跳一次 `confirm()`——連問兩遍同一件事只會讓人
    // 以為第一次沒按到。
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("生圖模型＋有隱藏頁：選「含隱藏頁」就三頁全抽", async () => {
    const project = projectWith("全抽", ["plain", "plain", "plain"]);
    project.slides[1]!.hidden = true;
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("全抽");
    chooseModelEngine();

    fireEvent.click(batchButton());
    const dialog = await screen.findByRole("dialog", { name: "批次抽離文字與隱藏頁" });
    fireEvent.click(within(dialog).getByRole("button", { name: "含隱藏頁一起抽（3 頁）" }));

    for (let page = 1; page <= 3; page += 1) {
      await waitFor(() => expect(stub.calls).toHaveLength(page));
      stub.release();
    }
    await settle();
    expect(stub.calls).toEqual(project.slides.map((slide) => slide.id));
  });

  it("生圖模型＋有隱藏頁：取消就一個請求都不送", async () => {
    const project = projectWith("反悔", ["plain", "plain"]);
    project.slides[1]!.hidden = true;
    const stub = stubApi(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("反悔");
    chooseModelEngine();

    fireEvent.click(batchButton());
    const dialog = await screen.findByRole("dialog", { name: "批次抽離文字與隱藏頁" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await settle();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stub.calls).toHaveLength(0);
    expect(batchButton().textContent).toBe("批次抽離全部文字");
  });

  /** OpenCV 不吃配額：即使有隱藏頁也不得多一次點擊，維持單一 `confirm()`。 */
  it("OpenCV＋有隱藏頁：不跳三選一，只有原本那一次 confirm", async () => {
    const project = projectWith("不必多問", ["plain", "plain"]);
    project.slides[1]!.hidden = true;
    const stub = stubApi(project);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("不必多問");

    fireEvent.click(batchButton());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    stub.release();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    stub.release();
    await settle();
    // 隱藏頁照樣抽（不吃配額，抽字是讓頁面可編輯，不是產出成品）。
    expect(stub.calls).toEqual(project.slides.map((slide) => slide.id));
  });

  /** 生圖模型但**沒有**隱藏頁時同樣不必問：沒有取捨存在。 */
  it("生圖模型但沒有隱藏頁：不跳三選一", async () => {
    const project = projectWith("沒有隱藏頁", ["plain", "plain"]);
    const stub = stubApi(project);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor />);
    await openProjectPanel("沒有隱藏頁");
    chooseModelEngine();

    fireEvent.click(batchButton());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stub.calls).toHaveLength(1));
  });
});

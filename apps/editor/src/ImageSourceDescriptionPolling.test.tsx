// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createProject, type PresentationProject, type SourceAsset } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { parsingBudgetMs } from "./SourcePanel.js";

/**
 * 背景描述那條輪詢的**收尾**行為。
 *
 * 這條 interval 是為了「描述好了畫面自己更新」而開的，所以它必須在三種情況下停：來源離開
 * parsing、元件被卸載，以及那筆來源卡住太久。停不下來的症狀是靜默的——畫面看起來完全正常，
 * 只有伺服器 log 上多出每 1.5 秒一次、永遠不會結束的 GET；使用者開幾個分頁就是幾倍。
 *
 * 「卡住太久」的另一半同樣重要：上限**不得提早收手**。一批圖是排隊跑的（併發 2、單張上限
 * 90 秒），第七張在伺服器一切正常的情況下也要五分鐘以上才輪得到；上限算得太短的話，描述
 * 靜靜落地、畫面卻永遠停在「分析中」。所以這裡兩側都釘：剛開始的要繼續輪詢，真的超時的
 * 要停下來並改口。
 */

const POLL_INTERVAL_MS = 1_500;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function parsingImage(): SourceAsset {
  return {
    id: "source-image",
    name: "cost.png",
    mediaType: "image/png",
    usage: "visual-reference",
    allowModelAccess: true,
    status: "parsing",
    assetPath: "assets/sources/source-image/cost.png",
    sizeBytes: 2048,
    extractedText: "",
    chunks: [],
    metadata: {},
    // 逾時判斷用的是**客戶端錨點**（第一次看到它是 parsing 的時刻），不是這個時間戳；
    // 伺服器時間戳與客戶端時鐘可能差好幾分鐘。這裡仍給當下時間，免得誤導讀者。
    createdAt: new Date().toISOString(),
  };
}

function projectWith(source: SourceAsset, topic: string): PresentationProject {
  const project = createProject({ topic, brief: { desiredSlideCount: 1 } });
  project.workflowStage = "editing";
  project.sources = [source];
  return project;
}

/**
 * 掛上假的 fetch，並回傳「/api/projects/:id 被打了幾次」的計數器。
 * `nextProject` 決定每一次輪詢拿到什麼，讓案例自己控制何時離開 parsing。
 */
function stubEditorFetch(
  listed: PresentationProject,
  nextProject: (call: number) => PresentationProject,
): { calls: () => number } {
  let projectFetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;
      if (path === "/api/projects") return Response.json([listed]);
      if (path === "/api/providers")
        return Response.json([
          {
            id: "mock-image",
            name: "Mock",
            availability: { status: "available" },
            capabilities: { fullSlideGeneration: true },
          },
        ]);
      if (path === "/api/styles") return Response.json([]);
      if (path === `/api/projects/${listed.id}`) {
        projectFetches += 1;
        return Response.json(nextProject(projectFetches));
      }
      return Response.json(listed);
    }),
  );
  return { calls: () => projectFetches };
}

async function openSourcePanel(topic: string): Promise<void> {
  fireEvent.click(await screen.findByText(topic));
  // 「來源」的唯一入口是右側 inspector 的分頁，標籤帶著來源筆數（「來源 N」）。
  fireEvent.click(screen.getByRole("button", { name: /^來源 \d+$/ }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("背景描述輪詢的收尾", () => {
  it("描述回來之後輪詢真的停下來：等超過一整個週期也不再有新請求", async () => {
    const topic = "輪詢收尾";
    const parsing = projectWith(parsingImage(), topic);
    const done = structuredClone(parsing);
    done.sources[0]!.status = "indexed";
    done.sources[0]!.extractedText = "［AI 圖片描述］Y 軸：每度成本。";
    done.sources[0]!.chunks = [{ id: "chunk-1", text: "描述", locator: "image-description:1" }];

    const { calls } = stubEditorFetch(parsing, (call) => (call > 1 ? done : parsing));
    render(<Editor />);
    await openSourcePanel(topic);
    expect(await screen.findByText(/AI 分析圖片內容中…/)).toBeTruthy();
    expect(await screen.findByText(/1 個文字區塊/, {}, { timeout: 6_000 })).toBeTruthy();

    // 等待必須明顯長於一個週期。停手前只等半個週期的話，「輪詢根本沒停」也會通過——
    // 那正是這條斷言唯一要抓的失效模式。
    const settledCalls = calls();
    await sleep(POLL_INTERVAL_MS * 2 + 500);
    expect(calls()).toBe(settledCalls);
  }, 30_000);

  it("元件卸載後不再輪詢：留下的 interval 會對著已消失的畫面一直打伺服器", async () => {
    const topic = "卸載收尾";
    const parsing = projectWith(parsingImage(), topic);
    const { calls } = stubEditorFetch(parsing, () => parsing);

    const view = render(<Editor />);
    await openSourcePanel(topic);
    expect(await screen.findByText(/AI 分析圖片內容中…/)).toBeTruthy();
    // 先確認輪詢真的跑起來了，否則下面「沒有新請求」是因為它從來沒開始。
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1), {
      timeout: 6_000,
      interval: 100,
    });

    view.unmount();
    const atUnmount = calls();
    await sleep(POLL_INTERVAL_MS * 2 + 500);
    expect(calls()).toBe(atUnmount);
  }, 30_000);

  it("剛開始分析的來源即使一直是 parsing 也照樣輪詢：上限不得提早收手", async () => {
    const topic = "分析中";
    // 伺服器時間戳刻意設成「六分鐘前」——比任何合理的上限都久。判斷若是拿它比
    // Date.now()，這一則就會在 t=0 停手；改用客戶端錨點之後，它與判斷完全無關。
    // 客戶端時鐘比伺服器快幾分鐘（沒對時的機器很常見）就是這個形狀。
    const fresh = parsingImage();
    fresh.updatedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const parsing = projectWith(fresh, topic);
    const { calls } = stubEditorFetch(parsing, () => parsing);

    render(<Editor />);
    await openSourcePanel(topic);
    expect(await screen.findByText(/AI 分析圖片內容中…/)).toBeTruthy();

    // 描述本身動輒十幾秒、排隊時更久；上限若從「畫面掛上去」起算或算錯單位，這裡就會停手。
    await sleep(POLL_INTERVAL_MS * 3 + 500);
    expect(calls()).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/AI 分析圖片內容中…/)).toBeTruthy();
  }, 30_000);

  it("卡在 parsing 超過上限之後停止輪詢，並改口說可能已中斷", async () => {
    const topic = "永遠分析中";
    // 伺服器在描述途中被砍、或收尾寫入失敗時，來源就是這個形狀：project.json 裡永遠是
    // parsing，直到下一次啟動修復。沒有上限的話，每個開著的分頁都會以 1.5 秒為週期永遠
    // 打同一個端點，而畫面上完全看不出異常。
    const parsing = projectWith(parsingImage(), topic);
    const { calls } = stubEditorFetch(parsing, () => parsing);

    render(<Editor />);
    await openSourcePanel(topic);
    expect(await screen.findByText(/AI 分析圖片內容中…/)).toBeTruthy();
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1), {
      timeout: 6_000,
      interval: 100,
    });

    // 只快轉時鐘、不碰計時器：錨點是 Date.now() 記的，interval 仍照真實時間跑，所以
    // 「下一次輪詢時發現已經超過預算」這條真實路徑會被完整走過一遍。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + parsingBudgetMs(1) + 60_000);
    try {
      await vi.waitFor(() => expect(screen.getByText(/AI 分析可能已中斷/)).toBeTruthy(), {
        timeout: 8_000,
        interval: 100,
      });
      expect(screen.queryByText(/AI 分析圖片內容中…/)).toBe(null);
      // 改口之後輪詢也要真的停：等超過兩個完整週期都不該再有新請求。
      const atTimeout = calls();
      await new Promise((resolve) => globalThis.setTimeout(resolve, POLL_INTERVAL_MS * 2 + 500));
      expect(calls()).toBe(atTimeout);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";
import { UsagePanel, formatCount, isUsageSummary } from "./UsagePanel.js";
import type { UsageBucket, UsageModelBucket, UsageSummary } from "./api.js";

/**
 * 用量面板釘住的是**誠實**，不是版面：
 *
 * ① 「未回報」與「本機處理」必須是兩個分開的句子（前者燒了配額卻不知道燒多少，後者
 *    根本沒碰模型）——混成一個數字就等於讓批次抽字的幾十筆 OpenCV 呼叫淹掉真正的問題。
 * ② `unreadable` 不可以畫成一排 0：「沒有數字」與「沒有呼叫過」意思剛好相反。
 * ③ `truncated` 要說出「這不是全部歷史」。
 * ④ 換專案時上一份專案的數字一格都不能留在畫面上（這個 repo 踩過好幾次）。
 */

afterEach(() => {
  cleanup();
  resetSystemSettings();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

function bucket(patch: Partial<UsageBucket> = {}): UsageBucket {
  return {
    calls: 0,
    requests: 0,
    reportedCalls: 0,
    unreportedCalls: 0,
    localCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    imageTokens: 0,
    totalTokens: 0,
    ...patch,
  };
}

function modelBucket(patch: Partial<UsageModelBucket> = {}): UsageModelBucket {
  return { ...bucket(), modelEntryId: "", model: "", providerKind: "", ...patch };
}

function summary(patch: Partial<UsageSummary> = {}): UsageSummary {
  return {
    totalCalls: 0,
    totalRequests: 0,
    reportedCalls: 0,
    unreportedCalls: 0,
    localCalls: 0,
    failedCalls: 0,
    totals: bucket(),
    byCapability: {},
    byOperation: {},
    byModel: [],
    malformedLines: 0,
    truncated: false,
    droppedRecords: 0,
    unreadable: false,
    ...patch,
  };
}

/** 一份「像樣的」統計：3 次未回報、8 次本機、2 次失敗、有重試。 */
function richSummary(): UsageSummary {
  return summary({
    totalCalls: 24,
    totalRequests: 27,
    reportedCalls: 13,
    unreportedCalls: 3,
    localCalls: 8,
    failedCalls: 2,
    totals: bucket({
      calls: 24,
      requests: 27,
      reportedCalls: 13,
      unreportedCalls: 3,
      localCalls: 8,
      failedCalls: 2,
      inputTokens: 12345,
      outputTokens: 6789,
      totalTokens: 19134,
    }),
    // 分組桶的 unreportedCalls 由伺服器算好（reported + unreported + local = calls）。
    byCapability: {
      image: bucket({
        calls: 5,
        requests: 6,
        reportedCalls: 2,
        unreportedCalls: 3,
        totalTokens: 4000,
      }),
      text: bucket({ calls: 11, requests: 11, reportedCalls: 11, totalTokens: 15134 }),
    },
    byOperation: {
      generate: bucket({
        calls: 5,
        requests: 6,
        reportedCalls: 2,
        unreportedCalls: 3,
        totalTokens: 4000,
      }),
      "extract-text": bucket({ calls: 8, localCalls: 8 }),
    },
    byModel: [
      modelBucket({
        modelEntryId: "entry-1",
        model: "gpt-image-2",
        providerKind: "openai",
        calls: 5,
        requests: 6,
        reportedCalls: 2,
        unreportedCalls: 3,
        failedCalls: 1,
        totalTokens: 4000,
      }),
    ],
    firstAt: "2026-07-28T01:12:00.000Z",
    lastAt: "2026-07-30T06:03:00.000Z",
  });
}

/** 依專案 id 回不同的統計；回 `Promise` 就由測試自己決定何時 resolve。 */
function stubUsage(byProject: Record<string, UsageSummary | Promise<UsageSummary>>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://local.test").pathname;
    const match = /^\/api\/projects\/([^/]+)\/usage$/.exec(path);
    if (!match) throw new Error(`unexpected fetch: ${path}`);
    const projectId = decodeURIComponent(match[1] ?? "");
    const entry = byProject[projectId];
    if (entry === undefined) return Response.json({ error: "Project not found" }, { status: 404 });
    return Response.json(await entry);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const panel = () => document.querySelector<HTMLElement>(".usage-panel");
const text = (selector: string) => panel()?.querySelector<HTMLElement>(selector)?.textContent ?? "";
const signals = () =>
  [...(panel()?.querySelectorAll(".usage-signals li") ?? [])].map((li) => li.textContent ?? "");

describe("用量面板", () => {
  it("未回報與本機呼叫是兩句分開的話，未回報不會被算進 token", async () => {
    stubUsage({ p1: richSummary() });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("19,134");
    const lines = signals();
    const unreported = lines.find((line) => line.includes("未回報用量"));
    const local = lines.find((line) => line.includes("本機處理"));
    expect(unreported).toBeTruthy();
    expect(local).toBeTruthy();
    // 分開的兩行：同一行同時講兩件事就等於把它們混成一個數字。
    expect(unreported).not.toBe(local);
    expect(unreported).toContain("3");
    expect(unreported).toContain("沒有");
    expect(local).toContain("8");
    expect(local).toContain("沒有消耗任何模型配額");
    // 失敗一樣燒配額，也要講。
    expect(lines.some((line) => line.includes("呼叫失敗"))).toBe(true);
  });

  it("送出請求比呼叫多的那個差額（重試）看得出來", async () => {
    stubUsage({ p1: richSummary() });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("19,134");
    expect(text(".usage-figures")).toContain("24");
    expect(text(".usage-figures")).toContain("27");
    expect(text(".usage-retry")).toContain("3");
    expect(text(".usage-retry")).toContain("重試");
  });

  it("依能力與依模型各自成組，分組層級的數字全部取自伺服器欄位", async () => {
    stubUsage({ p1: richSummary() });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("19,134");
    const sections = [...(panel()?.querySelectorAll(".usage-section") ?? [])];
    const capability = sections.find((node) => node.textContent?.includes("依能力"));
    const model = sections.find((node) => node.textContent?.includes("依模型"));
    expect(capability?.textContent).toContain("影像");
    expect(capability?.textContent).toContain("文字");
    expect(model?.textContent).toContain("gpt-image-2");
    expect(model?.textContent).toContain("openai");
    // 「已回報 2 / 5」是兩個伺服器欄位並排。
    expect(model?.textContent).toContain("2 / 5");
  });

  /**
   * 分組層級的「未回報」必須**如實顯示**，而且是伺服器 `bucket.unreportedCalls` 那一格
   * （前端不得拿 `calls − reported − local` 自己減，見 CLAUDE.md 與 `api.ts`）。
   *
   * 只寫「已回報 2 / 5」是不夠的：剩下的 3 次到底是燒了配額卻沒回報，還是根本沒碰模型的
   * 本機呼叫？那正是使用者要在這一列裡分辨的事——而兩者在畫面上長得一樣就等於沒說。
   */
  it("分組列直接顯示伺服器給的未回報數，且本機那一組不會被說成未回報", async () => {
    stubUsage({ p1: richSummary() });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("19,134");
    const rows = [...(panel()?.querySelectorAll(".usage-row") ?? [])];
    const note = (name: string) =>
      rows
        .find((row) => row.querySelector(".usage-row-name")?.textContent === name)
        ?.querySelector(".usage-row-note")?.textContent ?? "";

    // 影像：5 次呼叫、2 次有回報、3 次燒了配額卻沒回報。
    expect(note("影像")).toContain("2 / 5");
    expect(note("影像")).toContain("未回報 3 次");
    expect(note("gpt-image-2")).toContain("未回報 3 次");
    // 未回報是這一列上該警示的事（本機不是）。
    const image = rows.find((row) => row.querySelector(".usage-row-name")?.textContent === "影像");
    expect(image?.querySelector(".usage-row-note")?.className).toContain("warn");

    // 抽離文字全是本機（折疊起來的「依操作」內容一樣在 DOM 裡）：不可以被寫成「未回報」，
    // 那是完全相反的意思——一個燒了配額，一個根本沒碰模型。
    expect(note("抽離文字")).toContain("本機 8 次");
    expect(note("抽離文字")).not.toContain("未回報");

    // 文字那一組全部有回報：一句多餘的話都不該出現。
    const textRow = rows.find(
      (row) => row.querySelector(".usage-row-name")?.textContent === "文字",
    );
    expect(textRow?.querySelector(".usage-row-note")).toBeNull();
  });

  /**
   * 同一個桶**同時**有未回報與本機呼叫——`richSummary()` 剛好一組只有未回報、一組只有本機，
   * 所以這個混合的形狀在那份 fixture 底下測不到，而它正是措辭最容易出錯的地方：兩段話疊在
   * 一起時，讀者必須還能分清楚哪個數字燒了配額。可達路徑很平常（`image` 桶裡 mock 與不回報
   * 的 gateway 並存、抹字引擎設成生圖模型時的 `extract-text`）。
   */
  it("同一組同時有未回報與本機時，兩者是各自獨立的子句", async () => {
    stubUsage({
      p1: summary({
        totalCalls: 10,
        totalRequests: 10,
        unreportedCalls: 2,
        localCalls: 8,
        totals: bucket({ calls: 10, requests: 10, unreportedCalls: 2, localCalls: 8 }),
        byCapability: {
          image: bucket({ calls: 10, requests: 10, unreportedCalls: 2, localCalls: 8 }),
        },
      }),
    });
    render(<UsagePanel projectId="p1" />);

    const row = await waitFor(() => {
      const found = [...(panel()?.querySelectorAll(".usage-row") ?? [])].find(
        (node) => node.querySelector(".usage-row-name")?.textContent === "影像",
      );
      expect(found).toBeTruthy();
      return found!;
    });
    const note = row.querySelector(".usage-row-note")?.textContent ?? "";
    expect(note).toContain("已回報用量 0 / 10 次");
    // 兩個括號各自貼著自己的數字：本機那一段**不可以**接在未回報後面當它的括號註解
    // （舊版就是 `未回報 2 次（本機 8 次未耗配額）`，括號裡的數字還比較大）。
    expect(note).toContain("未回報 2 次（已耗配額）");
    expect(note).toContain("本機 8 次（未耗配額）");
    expect(note).not.toContain("次（本機");
  });

  it("依操作預設折疊", async () => {
    stubUsage({ p1: richSummary() });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("19,134");
    const details = panel()?.querySelector<HTMLDetailsElement>(".usage-operations");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("抽離文字");
  });

  it("金額一個字都不顯示", async () => {
    stubUsage({ p1: { ...richSummary(), cost: { unit: "openrouter-credit", amount: 4.25 } } });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("19,134");
    expect(panel()?.textContent).not.toContain("4.25");
    expect(panel()?.textContent).not.toContain("credit");
  });

  it("unreadable：明講數字是空的，且不畫成一排 0", async () => {
    stubUsage({ p1: summary({ unreadable: true }) });
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(text(".usage-unreadable")).not.toBe(""));
    expect(text(".usage-unreadable")).toContain("讀不出來");
    expect(text(".usage-unreadable")).toContain("不代表這個專案沒有呼叫過模型");
    // 讀不出來就不該有任何數字（連空狀態的「還沒有呼叫」都不能講——那是另一回事）。
    expect(panel()?.querySelector(".usage-figures")).toBeNull();
    expect(panel()?.querySelector(".usage-empty")).toBeNull();
  });

  it("truncated：說出這不是全部歷史，並帶上被捨棄的筆數", async () => {
    stubUsage({
      p1: summary({
        totalCalls: 4,
        totalRequests: 4,
        reportedCalls: 4,
        totals: bucket({ calls: 4, requests: 4, reportedCalls: 4, totalTokens: 900 }),
        truncated: true,
        droppedRecords: 2500,
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(text(".usage-truncated")).not.toBe(""));
    expect(text(".usage-truncated")).toContain("不是");
    expect(text(".usage-truncated")).toContain("2,500");
    // 截斷歸截斷，數字照樣要顯示。
    expect(text(".usage-figures")).toContain("900");
  });

  it("壞行低調顯示", async () => {
    stubUsage({ p1: summary({ malformedLines: 3 }) });
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(text(".usage-malformed")).not.toBe(""));
    expect(text(".usage-malformed")).toContain("3");
  });

  it("空狀態：沒有呼叫過就直說，不是一片 0", async () => {
    stubUsage({ p1: summary() });
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(panel()?.querySelector(".usage-empty")).not.toBeNull());
    expect(text(".usage-empty")).toContain("還沒有任何模型呼叫");
    expect(panel()?.querySelector(".usage-figures")).toBeNull();
    expect(panel()?.querySelector(".usage-signals")).toBeNull();
  });

  /**
   * 這一條只驗**同一幀**的清除（render 期的 projectId 守衛）。
   *
   * 「在途回應不可以寫回畫面」是另一件事，而且它需要一個**真的還在途中**的請求——換專案
   * 的那一刻若上一支請求早就回來了（像這裡），`abandoned` 那道守衛根本沒有被碰到。
   * 那條路由下面的「在途請求跨越專案切換」負責，包含先後顛倒的那個真正會出錯的順序。
   */
  it("換專案：上一份專案的數字在同一幀就消失", async () => {
    let resolveSecond: (value: UsageSummary) => void = () => undefined;
    const second = new Promise<UsageSummary>((resolve) => {
      resolveSecond = resolve;
    });
    let firstCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      if (path === "/api/projects/p1/usage") {
        firstCalls += 1;
        return Response.json(richSummary());
      }
      return Response.json(await second);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<UsagePanel projectId="p1" />);
    await screen.findByText("19,134");

    rerender(<UsagePanel projectId="p2" />);
    // 換過去的**那一幀**就不能再有上一份專案的數字。
    expect(panel()?.textContent).not.toContain("19,134");
    expect(text(".usage-loading")).toContain("讀取用量統計");
    // 換專案不會回頭再打上一個專案一次（deps 換了，舊的 effect 只被清掉）。
    expect(firstCalls).toBe(1);

    await act(async () => {
      resolveSecond(
        summary({
          totalCalls: 2,
          totalRequests: 2,
          reportedCalls: 2,
          totals: bucket({ calls: 2, requests: 2, reportedCalls: 2, totalTokens: 77 }),
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(text(".usage-figures")).toContain("77"));
    expect(panel()?.textContent).not.toContain("19,134");
  });

  it("重新整理只在按下去時打一次，沒有輪詢", async () => {
    const fetchMock = stubUsage({ p1: summary() });
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(panel()?.querySelector(".usage-empty")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 等再久都不會自己多打一次（面板刻意沒有定時器；輪詢由 Editor 那條負責）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("重新整理"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("載入失敗顯示錯誤而不是 0", async () => {
    stubUsage({});
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(text(".usage-error")).not.toBe(""));
    expect(panel()?.querySelector(".usage-figures")).toBeNull();
    expect(panel()?.querySelector(".usage-empty")).toBeNull();
  });

  it("認不得的回應不會炸掉畫面，也不會被畫成一排 0", async () => {
    // 這不是假想：舊測試的 catch-all stub 就是回一份專案 JSON，`totals` 缺席時
    // render 會直接把整個 inspector 炸掉。用量是觀測，不該有本事弄壞編輯器。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "p1", slides: [] })),
    );
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(text(".usage-error")).toContain("格式無法解析"));
    expect(panel()?.querySelector(".usage-figures")).toBeNull();
    expect(panel()?.querySelector(".usage-empty")).toBeNull();
    expect(panel()?.textContent).toContain("USAGE");
  });
});

/** 面板真的掛在 inspector 的「專案」分頁上，而且只在切過去時才抓。 */
describe("用量面板在編輯器裡的位置", () => {
  function editableProject(topic: string) {
    const project = createProject({ topic, brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    return project;
  }

  function stubEditor(project: PresentationProject, usage: UsageSummary) {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      if (path === `/api/projects/${project.id}/usage`) return Response.json(usage);
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

  it("切到「專案」分頁才抓，抓到的數字顯示在 USAGE 區塊", async () => {
    const project = editableProject("用量分頁");
    const fetchMock = stubEditor(project, richSummary());
    render(<Editor />);
    fireEvent.click(await screen.findByText("用量分頁"));
    await waitFor(() => expect(document.querySelector(".inspector-tabs")).not.toBeNull());

    const usageCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/usage")).length;
    // 停在「投影片」分頁時完全不打這支 API。
    expect(usageCalls()).toBe(0);

    fireEvent.click(screen.getByText("專案"));
    await screen.findByText("19,134");
    expect(usageCalls()).toBe(1);
    expect(panel()?.textContent).toContain("USAGE");
  });
});

/**
 * 批次生成收尾（`jobsBusy` 由 true 變 false）自動重抓一次。
 *
 * 兩側都要釘，而且**第二側才是重點**：
 *
 * ① 跑完要更新——那一刻正是使用者最想看用量的時候，而面板本身只在掛載與按「重新整理」
 *    時抓；停在「專案」分頁看著批次跑完的人，數字會停在開跑前。
 * ② 跑的**過程中**不可以連打——批次生成每完成一頁就換一份專案物件（專案輪詢每 700 毫秒
 *    拉一次），監聽 `project.jobs` 的話這裡就會變成對 `GET /usage` 的連續請求，而那支端點
 *    會先 `await usageLedger.idle()`。所以下面刻意讓 jobs 陣列在生成期間變好幾次。
 */
describe("批次生成結束後自動重抓", () => {
  function runningProject(topic: string): PresentationProject {
    const project = createProject({ topic, brief: { desiredSlideCount: 1 } });
    project.workflowStage = "editing";
    const slide = project.slides[0]!;
    project.jobs = [
      {
        id: "job-1",
        projectId: project.id,
        slideId: slide.id,
        providerId: "mock-image",
        status: "running",
        // `generationJobSchema` 的 `operation` 有 `.default()`，所以**輸入**可以省略，但
        // `PresentationProject["jobs"]` 是 parse 後的型別，這一格是必填的（少了它整個
        // `apps/editor` 的 `pnpm typecheck` 會紅）。
        operation: "generate",
        attempt: 1,
        progress: { step: 1, total: 6 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    return project;
  }

  /** 每一次輪詢都回一份**新的**專案物件（jobs 陣列跟著換），由 `done()` 決定何時收工。 */
  function stubGenerating(initial: PresentationProject, usage: UsageSummary) {
    let step = 1;
    let finished = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      if (path === `/api/projects/${initial.id}/usage`) return Response.json(usage);
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
      // 每次都是全新的物件與全新的 jobs 陣列，正如真的在跑的批次生成。
      const snapshot = structuredClone(initial);
      step += 1;
      const job = snapshot.jobs[0]!;
      if (finished) {
        job.status = "completed";
        job.progress = { step: 6, total: 6 };
      } else {
        job.progress = { step: Math.min(step, 5), total: 6 };
      }
      if (path === "/api/projects") return Response.json([snapshot]);
      return Response.json(snapshot);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      usageCalls: () =>
        fetchMock.mock.calls.filter(([input]) => String(input).includes("/usage")).length,
      projectCalls: () =>
        fetchMock.mock.calls.filter(
          ([input]) =>
            new URL(String(input), "http://local.test").pathname === `/api/projects/${initial.id}`,
        ).length,
      finish: () => {
        finished = true;
      },
    };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("生成中不重抓、結束時剛好重抓一次", async () => {
    const project = runningProject("批次生成用量");
    const stub = stubGenerating(project, richSummary());

    render(<Editor />);
    fireEvent.click(await screen.findByText("批次生成用量"));
    await waitFor(() => expect(document.querySelector(".inspector-tabs")).not.toBeNull());
    fireEvent.click(screen.getByText("專案"));
    await screen.findByText("19,134");
    expect(stub.usageCalls()).toBe(1);

    // 生成期間：專案輪詢打了好幾次、jobs 每次都換了物件，用量端點仍然只被打過那一次。
    await sleep(2_200);
    expect(stub.projectCalls()).toBeGreaterThanOrEqual(2);
    expect(stub.usageCalls()).toBe(1);

    // 收工：下一次輪詢帶回 completed，busy 的 false 邊緣觸發一次重抓。
    stub.finish();
    await waitFor(() => expect(stub.usageCalls()).toBe(2), { timeout: 5_000 });

    // 剛好一次：邊緣不可以變成另一條輪詢（面板刻意沒有定時器）。
    await sleep(2_200);
    expect(stub.usageCalls()).toBe(2);
  }, 30_000);
});

/**
 * 批次**抽字**的 `jobsBusy` 邊緣與批次**生成**不同，所以要單獨釘一條。
 *
 * 生成是伺服器一次把所有 job 排進佇列，`jobsBusy` 全程 true、只有一個邊緣；抽字是前端的
 * 逐頁迴圈，每一頁換來一個抹字 job，而那個 job 往往在迴圈等下一頁 OCR 的時候就跑完了——
 * `jobsBusy` 於是一頁掉一次 false。沒有守衛的話 20 頁就是約 20 次 `GET /usage`，每一次都
 * 要 `await usageLedger.idle()` 加一趟完整的專案載入與帳本解析，而抽字按鈕就在同一個
 * 「專案」分頁上，面板全程掛著、跟著閃「更新中…」。
 */
describe("批次抽字期間不重抓", () => {
  /** 三頁都沒有文字層＝三頁都會被批次抽字挑中。 */
  function extractableProject(topic: string): PresentationProject {
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

  /**
   * 抽字端點回 202 之後，專案裡就多一個 queued 的抹字 job；**下一趟**讀專案時它已經完成。
   * 這正是實機的節奏（抹字比一頁 OCR 快），也正是製造出「一頁一個 false 邊緣」的東西。
   */
  function stubExtracting(project: PresentationProject, usage: UsageSummary) {
    const extractCalls: string[] = [];
    let jobStatus: "idle" | "queued" | "completed" = "idle";
    const now = new Date().toISOString();
    const snapshot = () => {
      const clone = structuredClone(project);
      clone.jobs =
        jobStatus === "idle"
          ? []
          : [
              {
                id: `job-${extractCalls.length}`,
                projectId: clone.id,
                slideId: clone.slides[0]!.id,
                providerId: "local-inpaint",
                status: jobStatus,
                operation: "extract-text",
                attempt: 1,
                progress: { step: jobStatus === "queued" ? 1 : 6, total: 6 },
                createdAt: now,
                updatedAt: now,
              },
            ];
      // 讀過一次就當它跑完了：queued → completed，於是 busy 掉回 false。
      if (jobStatus === "queued") jobStatus = "completed";
      return clone;
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      if (path === `/api/projects/${project.id}/usage`) return Response.json(usage);
      if (path.endsWith("/extract-text") && init?.method === "POST") {
        extractCalls.push(path);
        // 一頁 OCR 實機是十幾秒，遠比 700 毫秒的專案輪詢慢——**這個時間差才是問題的來源**：
        // 上一頁的抹字 job 在這段等待裡跑完，輪詢看到沒有 busy job，false 邊緣就發生了。
        // 這裡壓成 1 秒（仍長過一次輪詢），少了它整批會快到輪詢一次都插不進來，測試就
        // 驗不到任何東西（實測：拿掉守衛也照樣綠）。
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        jobStatus = "queued";
        return Response.json({ id: "job", status: "queued" }, { status: 202 });
      }
      if (path === "/api/ocr/status") return Response.json({ available: true, message: "ok" });
      if (path === "/api/projects") return Response.json([snapshot()]);
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
      return Response.json(snapshot());
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      extractCalls,
      usageCalls: () =>
        fetchMock.mock.calls.filter(([input]) => String(input).includes("/usage")).length,
    };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("逐頁的 job 進出佇列不觸發重抓，整批收尾才補一次", async () => {
    const project = extractableProject("批次抽字用量");
    const stub = stubExtracting(project, richSummary());
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Editor />);
    fireEvent.click(await screen.findByText("批次抽字用量"));
    fireEvent.click(await screen.findByRole("button", { name: "專案" }));
    await screen.findByText("19,134");
    expect(stub.usageCalls()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "批次抽離全部文字" }));
    // 三頁都送出去了＝迴圈跑完；期間每一頁都製造過一次 busy 的 false 邊緣。
    await waitFor(() => expect(stub.extractCalls).toHaveLength(3), { timeout: 5_000 });
    expect(stub.usageCalls()).toBe(1);

    // 收尾補的那一次（最後一頁的 job 還在佇列裡時，等它自己的 false 邊緣）。
    await waitFor(() => expect(stub.usageCalls()).toBe(2), { timeout: 5_000 });
    // 就這一次：邊緣不可以退化成輪詢。
    await act(async () => {
      await sleep(2_200);
    });
    expect(stub.usageCalls()).toBe(2);
  }, 30_000);
});

/**
 * 形狀檢查（`isUsageSummary`）**誤判合法回應**的代價，是整個 USAGE 區塊變成一行錯誤字——
 * 那是使用者直接看到的迴歸，而且比顯示錯數字更容易發生：`apps/editor` 不相依 `apps/server`，
 * 兩邊只靠「線上形狀」對齊。
 *
 * 所以下面兩份 payload **不是手寫的**：它們是 `apps/server/test/usage-wire-contract.test.ts`
 * 用假 gateway（零配額）跑完一次真的模型呼叫之後，`GET /api/projects/:id/usage` 實際回出來的
 * JSON 原封不動貼過來的。伺服器那一份測試逐格斷言 wire 上的 key 與型別，所以這兩份一旦過期
 * 就會在伺服器側先紅；這一份則保證「伺服器真的回這個形狀時，前端認得」。
 */
const SERVER_EMPTY_LEDGER = {
  totalCalls: 0,
  totalRequests: 0,
  reportedCalls: 0,
  unreportedCalls: 0,
  localCalls: 0,
  failedCalls: 0,
  totals: {
    calls: 0,
    requests: 0,
    reportedCalls: 0,
    unreportedCalls: 0,
    localCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    imageTokens: 0,
    totalTokens: 0,
  },
  byCapability: {},
  byOperation: {},
  byModel: [],
  malformedLines: 0,
  truncated: false,
  droppedRecords: 0,
  unreadable: false,
} as const;

/** 有回報＋未回報＋本機＋失敗四種都真的跑過端點產生出來的那一份。 */
const SERVER_MIXED_LEDGER = {
  totalCalls: 5,
  totalRequests: 5,
  reportedCalls: 1,
  unreportedCalls: 2,
  localCalls: 2,
  failedCalls: 1,
  totals: {
    calls: 5,
    requests: 5,
    reportedCalls: 1,
    unreportedCalls: 2,
    localCalls: 2,
    failedCalls: 1,
    inputTokens: 1234,
    outputTokens: 56,
    reasoningTokens: 9,
    cachedTokens: 7,
    imageTokens: 0,
    totalTokens: 1290,
  },
  byCapability: {
    text: {
      calls: 3,
      requests: 3,
      reportedCalls: 1,
      unreportedCalls: 2,
      localCalls: 0,
      failedCalls: 1,
      inputTokens: 1234,
      outputTokens: 56,
      reasoningTokens: 9,
      cachedTokens: 7,
      imageTokens: 0,
      totalTokens: 1290,
    },
    image: {
      calls: 2,
      requests: 2,
      reportedCalls: 0,
      unreportedCalls: 0,
      localCalls: 2,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      imageTokens: 0,
      totalTokens: 0,
    },
  },
  byOperation: {
    "outline-regenerate": {
      calls: 3,
      requests: 3,
      reportedCalls: 1,
      unreportedCalls: 2,
      localCalls: 0,
      failedCalls: 1,
      inputTokens: 1234,
      outputTokens: 56,
      reasoningTokens: 9,
      cachedTokens: 7,
      imageTokens: 0,
      totalTokens: 1290,
    },
    generate: {
      calls: 2,
      requests: 2,
      reportedCalls: 0,
      unreportedCalls: 0,
      localCalls: 2,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      imageTokens: 0,
      totalTokens: 0,
    },
  },
  byModel: [
    {
      calls: 3,
      requests: 3,
      reportedCalls: 1,
      unreportedCalls: 2,
      localCalls: 0,
      failedCalls: 1,
      inputTokens: 1234,
      outputTokens: 56,
      reasoningTokens: 9,
      cachedTokens: 7,
      imageTokens: 0,
      totalTokens: 1290,
      modelEntryId: "openai-text",
      model: "gpt-5-fake",
      providerKind: "openai",
    },
    {
      calls: 2,
      requests: 2,
      reportedCalls: 0,
      unreportedCalls: 0,
      localCalls: 2,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      imageTokens: 0,
      totalTokens: 0,
      modelEntryId: "mock-image",
      model: "mock",
      providerKind: "mock",
    },
  ],
  firstAt: "2026-07-29T23:09:37.903Z",
  lastAt: "2026-07-29T23:09:37.994Z",
  malformedLines: 0,
  truncated: false,
  droppedRecords: 0,
  unreadable: false,
} as const;

describe("形狀檢查不可以誤判合法回應", () => {
  it("伺服器對空帳本回的那一份（全 0、byModel 空陣列、三個 optional 欄位缺席）認得", () => {
    // 這是最容易被誤判的一份：剛建好專案的人第一次點開「專案」分頁看到的就是它。
    expect(isUsageSummary(structuredClone(SERVER_EMPTY_LEDGER))).toBe(true);
  });

  it("伺服器對混合資料回的那一份認得，而且畫面上真的畫出它的數字", async () => {
    expect(isUsageSummary(structuredClone(SERVER_MIXED_LEDGER))).toBe(true);
    stubUsage({ p1: structuredClone(SERVER_MIXED_LEDGER) as unknown as UsageSummary });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("1,290");
    expect(panel()?.querySelector(".usage-error")).toBeNull();
    // 四種來源在畫面上都找得到，而且未回報與本機是兩句分開的話。
    const lines = signals();
    expect(lines.find((line) => line.includes("未回報用量"))).toContain("2");
    expect(lines.find((line) => line.includes("本機處理"))).toContain("2");
    expect(lines.some((line) => line.includes("呼叫失敗"))).toBe(true);
    expect(panel()?.textContent).toContain("gpt-5-fake");
  });

  it("optional 欄位（cost／firstAt／lastAt）缺席與有值都不算錯誤回應", () => {
    const base = structuredClone(SERVER_MIXED_LEDGER) as Record<string, unknown>;
    const { firstAt, lastAt, ...withoutMoments } = base;
    expect(firstAt && lastAt).toBeTruthy();
    expect(isUsageSummary(withoutMoments)).toBe(true);
    expect(isUsageSummary({ ...base, cost: { unit: "openrouter-credit", amount: 0.42 } })).toBe(
      true,
    );
    // 只有 firstAt 沒有 lastAt（理論上不會發生）也只是不顯示區間，不是壞回應。
    expect(isUsageSummary({ ...withoutMoments, firstAt })).toBe(true);
  });

  it("極大的數字不算錯誤回應", () => {
    const huge = structuredClone(SERVER_MIXED_LEDGER) as unknown as UsageSummary;
    huge.totals.totalTokens = Number.MAX_SAFE_INTEGER;
    huge.totals.inputTokens = 987_654_321;
    huge.totalCalls = 12_345_678;
    expect(isUsageSummary(huge)).toBe(true);
  });

  /**
   * 反面：認不得的東西必須真的被判掉，否則上面那些「認得」的斷言就沒有意義（一個永遠回
   * true 的檢查也會全部通過）。每一條都是實際可能發生的形狀。
   */
  it.each([
    ["null", null],
    ["字串（反向代理插的 HTML）", "<!doctype html><title>502</title>"],
    ["陣列（回成專案清單）", []],
    ["專案 JSON（catch-all stub 的實測形狀）", { id: "p1", slides: [] }],
  ])("%s 判成錯誤回應", (_name, value) => {
    expect(isUsageSummary(value)).toBe(false);
  });

  it("少一格的桶判成錯誤回應（頂層、分組、byModel 三處都要檢）", () => {
    const withoutTotalsKey = structuredClone(SERVER_MIXED_LEDGER) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    delete withoutTotalsKey.totals!.unreportedCalls;
    expect(isUsageSummary(withoutTotalsKey)).toBe(false);

    const withoutGroupKey = structuredClone(SERVER_MIXED_LEDGER) as unknown as {
      byCapability: Record<string, Record<string, unknown>>;
    };
    delete withoutGroupKey.byCapability.image!.localCalls;
    expect(isUsageSummary(withoutGroupKey)).toBe(false);

    const withoutModelKey = structuredClone(SERVER_MIXED_LEDGER) as unknown as {
      byModel: Record<string, unknown>[];
    };
    delete withoutModelKey.byModel[0]!.requests;
    expect(isUsageSummary(withoutModelKey)).toBe(false);

    const withoutTopKey = structuredClone(SERVER_MIXED_LEDGER) as unknown as Record<
      string,
      unknown
    >;
    delete withoutTopKey.unreportedCalls;
    expect(isUsageSummary(withoutTopKey)).toBe(false);
  });

  /**
   * `NaN`／`Infinity` 過 `JSON.stringify` 會變成 `null`，所以前端拿到的是 null 而不是數字。
   * 判成錯誤是**刻意的**：畫一格 "NaN" 或 "Infinity" 出來比一行錯誤字更難懂。伺服器側有一條
   * 對稱的斷言（wire 上不得出現 null）。
   */
  it("數字位置變成 null 判成錯誤回應", () => {
    const withNull = structuredClone(SERVER_MIXED_LEDGER) as unknown as Record<string, unknown>;
    withNull.totalCalls = null;
    expect(isUsageSummary(withNull)).toBe(false);
  });

  /**
   * `byModel` 的三個字串欄位（`modelEntryId`／`model`／`providerKind`）和那 12 個數字一樣
   * 非驗不可：`providerKind` 會直接被當成 JSX 子節點畫成 badge，塞一個物件進去就是
   * 「Objects are not valid as a React child」——整個 inspector 白畫面，而那正是這道守衛
   * 唯一要防的事。只驗數字的話這個形狀會**通過**檢查然後在 render 期炸掉。
   */
  it.each([
    ["providerKind 是物件（會被當成 React 子節點）", "providerKind", { kind: "openai" }],
    ["model 是數字", "model", 42],
    ["modelEntryId 不見了", "modelEntryId", undefined],
  ])("byModel 的 %s 判成錯誤回應", (_name, key, value) => {
    const broken = structuredClone(SERVER_MIXED_LEDGER) as unknown as {
      byModel: Record<string, unknown>[];
    };
    if (value === undefined) delete broken.byModel[0]![key];
    else broken.byModel[0]![key] = value;
    expect(isUsageSummary(broken)).toBe(false);
  });

  it("truncated／unreadable 不是布林就判成錯誤回應", () => {
    const wrong = structuredClone(SERVER_MIXED_LEDGER) as unknown as Record<string, unknown>;
    expect(isUsageSummary({ ...wrong, truncated: "false" })).toBe(false);
    expect(isUsageSummary({ ...wrong, unreadable: 0 })).toBe(false);
  });
});

/**
 * 六個誠實訊號**逐一**都要真的出現在畫面上。
 *
 * 一次餵一份「只有這個訊號」的統計，而不是一份什麼都有的：那樣任何一個訊號漏掉都還是綠的
 * （其他五個會讓斷言通過）。這六個訊號是整個面板存在的理由，漏掉任何一個就等於在說謊。
 */
describe("六個誠實訊號各自都看得見", () => {
  const withCalls = (patch: Partial<UsageSummary>): UsageSummary =>
    summary({
      totalCalls: 4,
      totalRequests: 4,
      reportedCalls: 4,
      totals: bucket({ calls: 4, requests: 4, reportedCalls: 4, totalTokens: 900 }),
      ...patch,
    });

  it("unreportedCalls 自己一個也會被講出來（而且不會被說成本機）", async () => {
    stubUsage({
      p1: withCalls({
        reportedCalls: 3,
        unreportedCalls: 1,
        totals: bucket({
          calls: 4,
          requests: 4,
          reportedCalls: 3,
          unreportedCalls: 1,
          totalTokens: 900,
        }),
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("900");
    const line = signals().find((entry) => entry.includes("未回報用量"));
    expect(line).toBeTruthy();
    expect(line).toContain("1");
    expect(signals().some((entry) => entry.includes("本機"))).toBe(false);
  });

  it("localCalls 自己一個也會被講出來（而且不會被說成未回報）", async () => {
    stubUsage({
      p1: withCalls({
        reportedCalls: 3,
        localCalls: 1,
        totals: bucket({
          calls: 4,
          requests: 4,
          reportedCalls: 3,
          localCalls: 1,
          totalTokens: 900,
        }),
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("900");
    const line = signals().find((entry) => entry.includes("本機"));
    expect(line).toBeTruthy();
    expect(line).toContain("沒有消耗任何模型配額");
    expect(signals().some((entry) => entry.includes("未回報"))).toBe(false);
  });

  it("failedCalls 自己一個也會被講出來，並說明失敗一樣燒配額", async () => {
    stubUsage({
      p1: withCalls({
        failedCalls: 2,
        totals: bucket({
          calls: 4,
          requests: 4,
          reportedCalls: 4,
          failedCalls: 2,
          totalTokens: 900,
        }),
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("900");
    const line = signals().find((entry) => entry.includes("失敗"));
    expect(line).toContain("2");
    expect(line).toContain("消耗配額");
  });

  /** 既有測試的 malformed 案例是空帳本；有數字的帳本混著壞行才是實際會遇到的形狀。 */
  it("malformedLines 在有數字的帳本上照樣顯示，而且數字還是照算", async () => {
    stubUsage({ p1: withCalls({ malformedLines: 2 }) });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("900");
    expect(text(".usage-malformed")).toContain("2");
    expect(text(".usage-malformed")).toContain("無法解析");
  });

  /**
   * `truncated` 在**空的**保留紀錄上要換一句話說：「還沒有任何呼叫」與「保留的紀錄裡沒有
   * 呼叫」是完全不同的兩件事，而輪替過的長壽專案剛好會落在後者。
   */
  it("truncated 且保留下來的紀錄是空的：不可以說「還沒有任何模型呼叫」", async () => {
    stubUsage({ p1: summary({ truncated: true, droppedRecords: 4_000 }) });
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(panel()?.querySelector(".usage-empty")).not.toBeNull());
    expect(text(".usage-empty")).toContain("目前保留的紀錄裡沒有任何模型呼叫");
    expect(text(".usage-empty")).not.toContain("還沒有任何模型呼叫");
    expect(text(".usage-truncated")).toContain("4,000");
  });

  /**
   * `unreadable` 時**畫面上一個數字都不可以有**。
   *
   * 只斷言「沒有 .usage-figures」是不夠的：壞行數、被捨棄的筆數、甚至一排 0 都是數字，而
   * 「我們讀不到」與「這個專案沒有呼叫過」在畫面上長得一模一樣時，這個面板就在說謊。
   * 所以這裡故意給它一份「其他欄位都不是 0」的統計，然後掃整個面板的文字。
   */
  it("unreadable：整個面板一個數字都不出現", async () => {
    stubUsage({
      p1: summary({
        unreadable: true,
        // 讀不出來時伺服器不會給這些，但前端不可以依賴那個巧合。
        malformedLines: 7,
        droppedRecords: 3_000,
        truncated: true,
        totalCalls: 9,
        totals: bucket({ calls: 9, requests: 9, reportedCalls: 9, totalTokens: 1_234 }),
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await waitFor(() => expect(text(".usage-unreadable")).not.toBe(""));
    expect(panel()?.textContent ?? "").not.toMatch(/\d/);
    for (const selector of [
      ".usage-figures",
      ".usage-empty",
      ".usage-signals",
      ".usage-truncated",
      ".usage-malformed",
      ".usage-section",
      ".usage-range",
    ])
      expect(panel()?.querySelector(selector), selector).toBeNull();
  });
});

describe("金額一個字都不顯示", () => {
  it("cost 有值時，畫面上找不到任何金額字樣", async () => {
    stubUsage({
      p1: { ...richSummary(), cost: { unit: "openrouter-credit", amount: 12.3456 } },
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("19,134");
    const shown = panel()?.textContent ?? "";
    // 原值、四捨五入後的樣子、單位名稱、以及任何貨幣符號或說法都不可以出現。
    for (const forbidden of [
      "12.3456",
      "12.35",
      "12.3",
      "$",
      // 「USD」而不是「US」：面板標題本身就叫 USAGE。
      "USD",
      "NT$",
      "credit",
      "openrouter",
      "金額",
      "費用",
      "成本",
      "花費",
      "元",
    ])
      expect(shown, forbidden).not.toContain(forbidden);
    // 小數點本身也不該出現：這個面板上的每一個數字都是整數計數或 token。
    expect(shown).not.toMatch(/\d\.\d/);
  });
});

/**
 * 在途請求跨越專案切換。
 *
 * **先後顛倒那個順序才是會出錯的那一個**：新專案先回、舊專案後回。舊回應若寫進 state，
 * render 期的 projectId 守衛會把它整份丟掉並改回 loading——新專案剛剛拿到的數字就這樣
 * 從畫面上消失，而且 effect 的 deps 一格都沒變，於是**永遠停在「讀取用量統計…」**。
 * 換句話說：漏掉 `abandoned` 守衛的症狀不是「顯示錯的專案」，是「畫面卡死」。
 */
describe("在途請求跨越專案切換", () => {
  const freshSummary = () =>
    summary({
      totalCalls: 2,
      totalRequests: 2,
      reportedCalls: 2,
      totals: bucket({ calls: 2, requests: 2, reportedCalls: 2, totalTokens: 77 }),
    });

  it("舊專案的回應晚於新專案落地：不覆蓋新數字，也不會卡在讀取中", async () => {
    let resolveOld: (value: UsageSummary) => void = () => undefined;
    const old = new Promise<UsageSummary>((resolve) => {
      resolveOld = resolve;
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(raw, "http://local.test").pathname;
        seen.push(path);
        if (path === "/api/projects/p1/usage") return Response.json(await old);
        return Response.json(freshSummary());
      }),
    );

    const { rerender } = render(<UsagePanel projectId="p1" />);
    await waitFor(() => expect(seen).toContain("/api/projects/p1/usage"));
    // p1 還在途中就換到 p2，p2 先回。
    rerender(<UsagePanel projectId="p2" />);
    await waitFor(() => expect(text(".usage-figures")).toContain("77"));

    // 現在 p1 那份陳舊的回應才落地。
    await act(async () => {
      resolveOld(richSummary());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(panel()?.textContent).not.toContain("19,134");
    expect(text(".usage-figures")).toContain("77");
    // 最關鍵的一格：畫面沒有被打回「讀取中」（那會是永久的，deps 不會再變）。
    expect(panel()?.querySelector(".usage-loading")).toBeNull();
    expect(panel()?.querySelector(".usage-error")).toBeNull();
  });

  it("舊專案的請求失敗晚於新專案落地：不可以把新專案的畫面換成錯誤", async () => {
    let rejectOld: (reason: Error) => void = () => undefined;
    const old = new Promise<UsageSummary>((_resolve, reject) => {
      rejectOld = reject;
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(raw, "http://local.test").pathname;
        seen.push(path);
        if (path === "/api/projects/p1/usage") return Response.json(await old);
        return Response.json(freshSummary());
      }),
    );

    const { rerender } = render(<UsagePanel projectId="p1" />);
    await waitFor(() => expect(seen).toContain("/api/projects/p1/usage"));
    rerender(<UsagePanel projectId="p2" />);
    await waitFor(() => expect(text(".usage-figures")).toContain("77"));

    await act(async () => {
      rejectOld(new Error("上一個專案的請求逾時了"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(panel()?.querySelector(".usage-error")).toBeNull();
    expect(panel()?.querySelector(".usage-loading")).toBeNull();
    expect(text(".usage-figures")).toContain("77");
  });
});

describe("極大數字與無障礙", () => {
  it("千分位不依賴執行環境的 ICU，且到 MAX_SAFE_INTEGER 都不會變成科學記號", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_000)).toBe("1,000");
    expect(formatCount(10_000_000)).toBe("10,000,000");
    expect(formatCount(987_654_321)).toBe("987,654,321");
    expect(formatCount(Number.MAX_SAFE_INTEGER)).toBe("9,007,199,254,740,991");
    // 小數一律截掉（token 數不該出現 .5）。
    expect(formatCount(1_234.9)).toBe("1,234");
  });

  it("千萬級 token 照樣排在同一份 dl 裡（欄位數不變、每格都是完整數字）", async () => {
    stubUsage({
      p1: summary({
        totalCalls: 12_345,
        totalRequests: 13_000,
        reportedCalls: 12_345,
        totals: bucket({
          calls: 12_345,
          requests: 13_000,
          reportedCalls: 12_345,
          inputTokens: 78_901_234,
          outputTokens: 12_345_678,
          totalTokens: 91_246_912,
        }),
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("91,246,912");
    const cells = [...(panel()?.querySelectorAll(".usage-figures dd") ?? [])].map(
      (cell) => cell.textContent,
    );
    expect(cells).toEqual(["12,345", "13,000", "78,901,234", "12,345,678", "91,246,912"]);
    // 沒有一格被截成 "…" 或掉成科學記號。
    for (const cell of cells) expect(cell).not.toMatch(/[e…]/);
  });

  it("超長模型名不會把那一列的數字擠掉（名稱與數字是分開的節點）", async () => {
    const longName = "gemini-3.1-flash-image-preview-2026-07-30-experimental-very-long";
    stubUsage({
      p1: summary({
        totalCalls: 1,
        totalRequests: 1,
        reportedCalls: 1,
        totals: bucket({ calls: 1, requests: 1, reportedCalls: 1, totalTokens: 5 }),
        byModel: [
          modelBucket({
            modelEntryId: "entry-long",
            model: longName,
            providerKind: "gemini",
            calls: 1,
            requests: 1,
            reportedCalls: 1,
            totalTokens: 5,
          }),
        ],
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText(longName);
    const row = [...(panel()?.querySelectorAll(".usage-row") ?? [])].find((node) =>
      node.textContent?.includes(longName),
    );
    // 名稱在 .usage-row-name（CSS 對它套了 ellipsis），數字在另一個節點裡。
    expect(row?.querySelector(".usage-row-name")?.textContent).toBe(longName);
    expect(row?.querySelector(".usage-row-figures")?.textContent).toContain("1 次呼叫");
  });

  it("模型名與 entry id 都缺席時顯示「未知模型」而不是空白列", async () => {
    stubUsage({
      p1: summary({
        totalCalls: 1,
        totalRequests: 1,
        reportedCalls: 1,
        totals: bucket({ calls: 1, requests: 1, reportedCalls: 1, totalTokens: 5 }),
        byModel: [modelBucket({ calls: 1, requests: 1, reportedCalls: 1, totalTokens: 5 })],
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("未知模型");
  });

  /** 伺服器的 enum 之後長出新值時，那一列必須還在（顯示原始鍵值），不可以整列消失。 */
  it("認不得的能力／操作鍵顯示原始鍵值", async () => {
    stubUsage({
      p1: summary({
        totalCalls: 1,
        totalRequests: 1,
        reportedCalls: 1,
        totals: bucket({ calls: 1, requests: 1, reportedCalls: 1, totalTokens: 5 }),
        byCapability: {
          video: bucket({ calls: 1, requests: 1, reportedCalls: 1, totalTokens: 5 }),
        },
        byOperation: {
          "narrate-deck": bucket({ calls: 1, requests: 1, reportedCalls: 1, totalTokens: 5 }),
        },
      }),
    });
    render(<UsagePanel projectId="p1" />);

    await screen.findByText("video");
    expect(panel()?.textContent).toContain("narrate-deck");
  });

  it("「重新整理」按鈕有可存取名稱，載入中改名並停用，載入完恢復", async () => {
    let resolveUsage: (value: UsageSummary) => void = () => undefined;
    const pending = new Promise<UsageSummary>((resolve) => {
      resolveUsage = resolve;
    });
    stubUsage({ p1: pending });
    render(<UsagePanel projectId="p1" />);

    // 讀取中：名稱是「更新中…」而且按不下去（不會排出第二支請求）。
    const loading = await screen.findByRole("button", { name: "更新中…" });
    expect((loading as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveUsage(summary());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const refresh = screen.getByRole("button", { name: "重新整理" });
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    // 分組標題是真的標題元素，讀螢幕的人才走得到（不是純樣式的 div）。
    stubUsage({ p1: richSummary() });
    fireEvent.click(refresh);
    await screen.findByText("19,134");
    expect(screen.getByRole("heading", { name: "依能力" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "依模型" })).toBeTruthy();
  });
});

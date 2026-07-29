// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, createProject, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { resetSystemSettings } from "./systemSettings.js";
import { UsagePanel } from "./UsagePanel.js";
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

  it("換專案：上一份專案的數字在同一幀就消失，不會被在途回應寫回來", async () => {
    let resolveSecond: (value: UsageSummary) => void = () => undefined;
    const second = new Promise<UsageSummary>((resolve) => {
      resolveSecond = resolve;
    });
    let resolveFirstRefetch: (value: UsageSummary) => void = () => undefined;
    const firstRefetch = new Promise<UsageSummary>((resolve) => {
      resolveFirstRefetch = resolve;
    });
    let firstCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://local.test").pathname;
      if (path === "/api/projects/p1/usage") {
        firstCalls += 1;
        return Response.json(firstCalls === 1 ? richSummary() : await firstRefetch);
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

    // 上一份專案的在途回應之後才落地，它一樣不可以寫回畫面。
    await act(async () => {
      resolveFirstRefetch(richSummary());
      await Promise.resolve();
    });
    expect(panel()?.textContent).not.toContain("19,134");

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

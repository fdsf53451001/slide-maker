// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createDefaultStyle,
  createProject,
  outlineMarkdown,
  type PresentationProject,
} from "@slide-maker/core";
import { ExportPanel } from "./editor/ExportPanel.js";
import { SetupFlow } from "./editor/SetupFlow.js";
import type { ProviderSummary } from "./api.js";

/**
 * 「下載大綱 (.md)」的兩個入口。
 *
 * 兩者刻意**不是同一條路**：匯出面板是裸 `<a href>` 指到伺服器端點，精靈那顆是在瀏覽器裡
 * 就地把**畫面上的草稿**產成 Blob。所以這一份要釘的是三件事——匯出面板那個連結不被
 * 「全部頁面都隱藏」那條分支波及；精靈那顆吃的是草稿而不是伺服器上那一份；以及兩端產出
 * 的位元組逐字元相同（`GOLDEN`）。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  capture = undefined;
});

/*
 * jsdom 沒有實作 `URL.createObjectURL`／`revokeObjectURL`。這兩顆刻意裝在**模組層而且不拆**：
 * revoke 是排在 macrotask 上的，上一條測試的計時器可能落在下一條測試執行中才燒起來，
 * afterEach 把它們刪掉會變成一個看不懂的 unhandled `URL.revokeObjectURL is not a function`。
 * 每條測試改以自己那一次的 blob URL 對照（`counter` 全檔遞增，不會撞號），與跨測試的殘留無關。
 */
let capture: { blobs: Map<string, Blob>; revoked: string[] } | undefined;
let objectUrlCounter = 0;
Object.assign(URL, {
  createObjectURL: (blob: Blob) => {
    const url = `blob:test/${++objectUrlCounter}`;
    capture?.blobs.set(url, blob);
    return url;
  },
  revokeObjectURL: (url: string) => capture?.revoked.push(url),
});

/** jsdom 的 Blob 沒有 `.text()`，只能走 FileReader。 */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("讀取 Blob 失敗"));
    reader.readAsText(blob);
  });
}

/**
 * 跨端黃金樣本，**與 `apps/server/test/export-outline-md.test.ts` 的那一份是同一組**。
 *
 * 格式化函式住在 `packages/core` 的唯一理由就是「兩個下載點只能有一份格式」。兩邊各自對照
 * 同一個字面值之後，任何一端自己重寫一份格式化都會讓其中一邊變紅——只斷言「等於
 * `outlineMarkdown()` 的回傳值」是抓不到的（那條在兩端都恆真）。
 */
const FIXTURE_NAME = "Q3 產品回顧";
const FIXTURE_SLIDES = [
  {
    purpose: "開場",
    content: "- 一\n- 二",
    narrative: "先講背景。\n\n再講問題。",
    layoutHint: "左圖右文",
    hidden: false,
  },
  {
    purpose: "備用資料",
    content: "| a | b |\n| - | - |",
    narrative: "",
    layoutHint: "全幅表格",
    hidden: true,
  },
  { purpose: "", content: "", narrative: "只有敘事。", layoutHint: "留白", hidden: false },
];

const GOLDEN = [
  "# Q3 產品回顧",
  "",
  "## 1. 開場",
  "",
  "- 一",
  "- 二",
  "",
  "> 講述：先講背景。",
  ">",
  "> 再講問題。",
  "",
  "## 2. 備用資料",
  "",
  // 隱藏註記落在正文而不是 `##` 那一行：這份檔要能回丟成「大綱參考」，而標題行裡的
  // 「（隱藏頁）」會被模型照抄成頁標題（`hidden` 不是大綱 schema 的欄位，它沒有別的做法）。
  "（這一頁在原簡報中設為隱藏：不放映，也不會進 pptx／pdf。）",
  "",
  "| a | b |",
  "| - | - |",
  "",
  "## 3.",
  "",
  "> 講述：只有敘事。",
  "",
].join("\n");

function fixtureProject(name = FIXTURE_NAME): PresentationProject {
  const project = createProject({
    topic: name,
    brief: { desiredSlideCount: FIXTURE_SLIDES.length },
  });
  project.workflowStage = "settings";
  for (const [index, slide] of project.slides.entries()) {
    const fields = FIXTURE_SLIDES[index]!;
    slide.purpose = fields.purpose;
    slide.content = fields.content;
    slide.narrative = fields.narrative;
    slide.layoutHint = fields.layoutHint;
    slide.hidden = fields.hidden;
  }
  return project;
}

/**
 * 攔下瀏覽器下載。下載本身沒有任何 DOM 痕跡——唯一觀察得到的是「拿哪個 Blob 建了 URL、
 * 掛在哪個 `<a download>` 上被按了一下」。
 */
function captureDownloads() {
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  const clicks: { href: string; download: string; attached: boolean }[] = [];
  capture = { blobs, revoked };
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({
      href: this.getAttribute("href") ?? "",
      download: this.download,
      // 連結要真的在文件裡才觸發得了下載（部分瀏覽器對 detached 節點的 click 不動作）。
      attached: document.body.contains(this),
    });
  });
  return {
    clicks,
    revoked,
    /** 最後一次下載的檔案內容。 */
    text: async () => {
      const last = clicks.at(-1);
      if (!last) throw new Error("沒有任何下載被觸發");
      return readBlob(blobs.get(last.href)!);
    },
    type: () => blobs.get(clicks.at(-1)!.href)!.type,
  };
}

const PROVIDERS: ProviderSummary[] = [
  {
    id: "mock-image",
    name: "Mock",
    availability: { status: "available" },
    capabilities: { fullSlideGeneration: true },
  },
];

/** 精靈掛載時會打 readiness 與模型庫；其餘端點在這幾條測試裡一次都不該被碰到。 */
function stubWizardFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
    if (path.endsWith("/api/model-library"))
      return Response.json({ connections: [], models: [], combinations: [] });
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderWizard(project: PresentationProject) {
  const onProject = vi.fn();
  const onError = vi.fn();
  render(
    <SetupFlow
      project={project}
      providers={PROVIDERS}
      styles={[createDefaultStyle()]}
      acceptUnknownReadiness={false}
      onAcceptUnknownReadiness={vi.fn()}
      onProject={onProject}
      onExit={vi.fn()}
      onError={onError}
    />,
  );
  await screen.findByText("STEP 4 · 確認大綱與生成設定");
  return { onProject, onError };
}

/** 第 `index` 張大綱卡上的某個欄位。用卡片定位，才不會被「內容剛好與別頁相同」絆到。 */
const outlineField = (index: number, label: "頁面目的" | "頁面內容" | "敘事") =>
  within(
    document.querySelectorAll<HTMLElement>(".outline-review > article")[index]!,
  ).getByLabelText(label);

const actionButtons = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".setup-actions > button")).map((button) =>
    (button.textContent ?? "").replace(/→$/, ""),
  );

describe("匯出面板的「下載大綱」連結", () => {
  const outlineLink = () =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>(".export-panel a")).find((anchor) =>
      anchor.getAttribute("href")?.endsWith("/export/outline.md"),
    );

  it("連結在「專案」區，href 指到匯出端點且 projectId 有轉義", () => {
    render(
      <ExportPanel
        projectId="p 1/2"
        selected={undefined}
        activeImage={undefined}
        hiddenCount={0}
        visibleSlideCount={3}
      />,
    );

    const link = outlineLink()!;
    expect(link.getAttribute("href")).toBe("/api/projects/p%201%2F2/export/outline.md");
    expect(link.textContent).toBe("下載大綱 (.md)");
    expect(link.closest(".export-group")!.querySelector("h3")!.textContent).toBe("專案");
  });

  /*
   * `visibleSlideCount === 0` 那條分支擋的是「pptx／pdf 沒有可以匯出的頁面」（伺服器會回
   * 400，而連結是裸 `<a href>`）。大綱是內容文件、與圖片無關，隱藏頁照樣收錄並在檔案裡
   * 標明，全部隱藏時它仍然匯得出來——被那條分支順手擋掉是靜默的功能倒退。
   */
  it("全部頁面都隱藏時仍然出現（pptx／pdf 在同一個狀態被擋掉）", () => {
    render(
      <ExportPanel
        projectId="p1"
        selected={undefined}
        activeImage={undefined}
        hiddenCount={3}
        visibleSlideCount={0}
      />,
    );

    expect(outlineLink()?.getAttribute("href")).toBe("/api/projects/p1/export/outline.md");
    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".export-panel a")).map(
      (anchor) => anchor.getAttribute("href"),
    );
    // 對照組：這個狀態下 pptx／pdf 確實不給連結，所以上面那條不是「什麼都沒被擋」。
    expect(hrefs.some((href) => href?.endsWith("/export/pptx"))).toBe(false);
    expect(hrefs.some((href) => href?.endsWith("/export/pdf"))).toBe(false);
    expect(document.querySelector(".export-blocked")).toBeTruthy();
  });

  /*
   * 這句就地說明原本寫「下方**兩種**格式仍會收錄全部頁面」，而加進「下載大綱」之後下方是
   * 三個連結——一個讀起來完全正確、實際上錯掉的數字，沒有任何測試會發現。寫死的清點與它
   * 指著的那份清單分屬兩處，下一個新增格式的人只會改清單。
   */
  it("就地說明不寫死「幾種格式」（那個數字會跟著新增格式靜默過期）", () => {
    render(
      <ExportPanel
        projectId="p1"
        selected={undefined}
        activeImage={undefined}
        hiddenCount={3}
        visibleSlideCount={0}
      />,
    );

    const note = document.querySelector(".export-blocked")!.textContent ?? "";
    expect(note).not.toMatch(/[一二三四五六七八九十兩\d]+\s*種格式/);
    // 而它指著的那份清單此刻確實不只兩個。
    const group = document.querySelectorAll(".export-panel .export-group")[0]!;
    expect(group.querySelectorAll("a").length).toBeGreaterThan(2);
  });
});

describe("精靈 STEP 4 的「下載大綱」按鈕", () => {
  it("夾在「返回修改需求」與主按鈕之間", async () => {
    stubWizardFetch();
    await renderWizard(fixtureProject());

    // 順序是可讀性的一部分：次要動作聚在左邊，主按鈕永遠是最後一顆。
    expect(actionButtons()).toEqual(["返回修改需求", "下載大綱 (.md)", "確認設定並生成 3 頁簡報"]);
  });

  it("0 頁時不出現（下載到的會是一份只有標題的空檔）", async () => {
    stubWizardFetch();
    const project = fixtureProject();
    project.slides = [];
    await renderWizard(project);

    expect(actionButtons()).toEqual(["返回修改需求", "確認設定並生成 0 頁簡報"]);
    expect(screen.queryByText("下載大綱 (.md)")).toBeNull();
  });

  it("按下去產出的位元組逐字元等於伺服器端點的那一份（GOLDEN）", async () => {
    stubWizardFetch();
    const downloads = captureDownloads();
    await renderWizard(fixtureProject());

    fireEvent.click(screen.getByText("下載大綱 (.md)"));

    expect(await downloads.text()).toBe(GOLDEN);
    // 少了 charset，瀏覽器開起來的中文會照它自己的預設猜編碼。
    expect(downloads.type()).toBe("text/markdown;charset=utf-8");
    // 版面指示是給影像模型的，不可混進這份要能回丟成「大綱參考」的檔案。
    for (const slide of FIXTURE_SLIDES)
      expect(await downloads.text()).not.toContain(slide.layoutHint);
  });

  it("檔名走 core 的規則：`<洗過的專案名>.outline.md`", async () => {
    stubWizardFetch();
    const downloads = captureDownloads();
    await renderWizard(fixtureProject("年報 2026/上"));

    fireEvent.click(screen.getByText("下載大綱 (.md)"));

    expect(downloads.clicks.at(-1)!.download).toBe("年報-2026-上.outline.md");
    // detached 的 `<a>` 在部分瀏覽器上按不動。
    expect(downloads.clicks.at(-1)!.attached).toBe(true);
  });

  /*
   * 這顆按鈕**不接匯出端點**的全部理由。`outline` 是本地草稿，STEP 4 就地改的
   * purpose／content／敘事要按下「確認設定並生成」才 PATCH 回伺服器；走端點的話，剛改完
   * 一段文字就按下載會拿到改**之前**的版本，而畫面上完全看不出差別。
   */
  it("下載到的是畫面上還沒送出的草稿，不是伺服器上那一份", async () => {
    const fetchMock = stubWizardFetch();
    const downloads = captureDownloads();
    const project = fixtureProject();
    await renderWizard(project);

    fireEvent.change(outlineField(0, "頁面目的"), { target: { value: "改過的開場" } });
    fireEvent.change(outlineField(0, "頁面內容"), { target: { value: "- 改過的第一點" } });
    fireEvent.change(outlineField(2, "敘事"), { target: { value: "改過的敘事。" } });

    fireEvent.click(screen.getByText("下載大綱 (.md)"));

    const text = await downloads.text();
    expect(text).toContain("## 1. 改過的開場");
    expect(text).toContain("- 改過的第一點");
    expect(text).toContain("> 講述：改過的敘事。");
    // 改**之前**的字一個都不該還在——「新舊都在」與「只有舊的」一樣是錯的。
    expect(text).not.toContain("## 1. 開場");
    expect(text).not.toContain("- 一");
    expect(text).not.toContain("只有敘事。");
    // 而且伺服器上那一份完全沒被動過：這顆按鈕不寫任何東西回去。
    expect(project.slides[0]!.purpose).toBe("開場");
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/slides/"))).toBe(true);

    // 草稿與 core 的格式化函式對得上：兩個下載點共用的就是這一個函式。
    expect(text).toBe(
      outlineMarkdown({
        name: project.name,
        slides: project.slides.map((slide, index) =>
          index === 0
            ? {
                ...slide,
                purpose: "改過的開場",
                content: "- 改過的第一點",
              }
            : index === 2
              ? { ...slide, narrative: "改過的敘事。" }
              : slide,
        ),
      }),
    );
  });

  it("同一步驟再改一次，第二次下載反映的是最新的草稿", async () => {
    stubWizardFetch();
    const downloads = captureDownloads();
    await renderWizard(fixtureProject());

    fireEvent.change(outlineField(0, "頁面目的"), { target: { value: "第一版" } });
    fireEvent.click(screen.getByText("下載大綱 (.md)"));
    expect(await downloads.text()).toContain("## 1. 第一版");

    fireEvent.change(outlineField(0, "頁面目的"), { target: { value: "第二版" } });
    fireEvent.click(screen.getByText("下載大綱 (.md)"));
    const second = await downloads.text();
    expect(second).toContain("## 1. 第二版");
    expect(second).not.toContain("第一版");
  });

  /*
   * 下載在 `click()` 之後才排進佇列，當場 revoke 會讓部分瀏覽器抓到一個已經失效的 URL；
   * 完全不 revoke 則讓這份 Blob 活到分頁關閉。所以它必須是「延後、但確實會做」。
   */
  it("blob URL 不在 click 當下釋放，但下一個 macrotask 會釋放", async () => {
    stubWizardFetch();
    const downloads = captureDownloads();
    await renderWizard(fixtureProject());

    fireEvent.click(screen.getByText("下載大綱 (.md)"));
    const url = downloads.clicks.at(-1)!.href;
    expect(downloads.revoked).not.toContain(url);

    await waitFor(() => expect(downloads.revoked).toContain(url));
  });

  it("按完之後那個暫時的 `<a>` 沒有留在畫面上", async () => {
    stubWizardFetch();
    captureDownloads();
    await renderWizard(fixtureProject());

    fireEvent.click(screen.getByText("下載大綱 (.md)"));

    expect(document.querySelectorAll("body > a")).toHaveLength(0);
  });
});

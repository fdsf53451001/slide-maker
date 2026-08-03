import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProject,
  outlineMarkdown,
  outlineMarkdownFilename,
  type PresentationProject,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { exportFilename, exportPresentation } from "../src/exporters.js";
import { FileProjectRepository } from "../src/repository.js";

/**
 * `outline.md` 匯出格式在 **HTTP 邊界**上的樣子，外加它與精靈那顆下載按鈕的跨端一致性。
 *
 * 它是唯一一個**不讀任何資產**的匯出格式：內容全部在 `project.json` 裡，不經過
 * `visibleVersions()`，所以「全部頁面都隱藏」與「一頁圖都還沒生成」對它都不是異常狀態
 * （pptx／pdf 在前者會回 400）。這幾條就是把那個「不受波及」釘住。
 *
 * `export-streaming.test.ts` 那一條刻意不收這個格式：它斷言每一份都大於一個 chunk，
 * 而純文字的大綱永遠塞不進那個門檻。chunked 的守門因此要在這裡自己來一次。
 */

/**
 * 跨端黃金樣本的來源資料。
 *
 * **與 `apps/editor/src/OutlineMarkdownDownload.test.tsx` 的那一份是同一組**：精靈那顆下載
 * 按鈕在瀏覽器裡就地產檔、匯出端點在伺服器上產檔，兩條路各自對照同一個字面值，任何一端
 * 自己重寫一份格式化都會讓其中一邊變紅。格式化函式住在 `packages/core` 的唯一理由就是這個。
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

/** 上面那份 fixture 唯一正確的輸出。改格式就要同時改編輯器那一份，否則兩端會靜默分岔。 */
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

describe("outline.md 匯出", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let repository: FileProjectRepository;

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-outline-md-")),
      ".slide-maker-data",
    );
    repository = new FileProjectRepository(root);
    await repository.initialize();
    const app = await createApp(root);
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        bindUnavailable = true;
        return;
      }
      throw error;
    }
    if (!server) throw new Error("Local test server did not initialize");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  /**
   * 落地一份專案。刻意**不給任何版本／圖片**：`outline.md` 一個資產都不讀，缺圖與它無關，
   * 而 fixture 給了圖就等於讓這一點無法被觀察。
   */
  async function seed(
    name: string,
    slides: typeof FIXTURE_SLIDES,
    overrides: { allHidden?: boolean } = {},
  ): Promise<PresentationProject> {
    const project = createProject({ topic: name, brief: { desiredSlideCount: slides.length } });
    for (const [index, slide] of project.slides.entries()) {
      const fields = slides[index]!;
      slide.purpose = fields.purpose;
      slide.content = fields.content;
      slide.narrative = fields.narrative;
      slide.layoutHint = fields.layoutHint;
      slide.hidden = overrides.allHidden ?? fields.hidden;
    }
    await repository.saveProject(project);
    return project;
  }

  it("回 200＋`text/markdown; charset=utf-8`，檔名是 `<專案>.outline.md`", async () => {
    if (bindUnavailable) return;
    const project = await seed(FIXTURE_NAME, FIXTURE_SLIDES);

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/outline.md`);

    expect(response.status).toBe(200);
    // charset 不可省：整份檔案是中文，少了它瀏覽器會照自己的預設猜編碼。
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition.startsWith("attachment; filename*=UTF-8''")).toBe(true);
    expect(decodeURIComponent(disposition.split("''")[1]!)).toBe("Q3-產品回顧.outline.md");
  }, 60_000);

  it("走 chunked：沒有 content-length（Cloud Run 對 non-streamed 回應有 32 MiB 上限）", async () => {
    if (bindUnavailable) return;
    const project = await seed("串流守門", FIXTURE_SLIDES);

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/outline.md`);

    // 「純文字一定很小」不是不走 sendChunked 的理由：100 頁的大綱不小，而且一條路上放
    // 兩種寫法，下一個人只會抄到錯的那一種。
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBe("chunked");
  }, 60_000);

  it("內容逐字元等於跨端黃金樣本（精靈那顆按鈕產的是同一份）", async () => {
    if (bindUnavailable) return;
    const project = await seed(FIXTURE_NAME, FIXTURE_SLIDES);

    const body = await (
      await fetch(`${baseUrl}/api/projects/${project.id}/export/outline.md`)
    ).text();

    expect(body).toBe(GOLDEN);
    // layoutHint 是給影像模型的版面指示，這份檔要能回丟成「大綱參考」來源，不可混進正文。
    for (const slide of FIXTURE_SLIDES) expect(body).not.toContain(slide.layoutHint);
  }, 60_000);

  it("端點的輸出就是 core 的 `outlineMarkdown()`，不是伺服器自己寫的第二份", async () => {
    if (bindUnavailable) return;
    const project = await seed("同一個函式", FIXTURE_SLIDES);

    const body = await (
      await fetch(`${baseUrl}/api/projects/${project.id}/export/outline.md`)
    ).text();

    expect(body).toBe(outlineMarkdown(project));
  }, 60_000);

  it("檔名走 core 的 `outlineMarkdownFilename()`，不是通用那條剛好拼得一樣", async () => {
    // 通用那條（`<專案>.${format}`）目前剛好也會拼出 `<專案>.outline.md`，但那是巧合：
    // 檔名規則一改就會靜默分岔成「精靈一個檔名、匯出端點另一個檔名」。
    const project = await seed("檔名規則", FIXTURE_SLIDES);
    expect(exportFilename(project, "outline.md")).toBe(outlineMarkdownFilename(project.name));
  }, 60_000);

  it("全部頁面都隱藏時照樣匯得出來（pptx／pdf 在同一個狀態回 400）", async () => {
    if (bindUnavailable) return;
    // 大綱是內容文件、與圖片無關；`png.zip`／`slide-project` 也收錄全部頁面。
    const project = await seed("全部隱藏也匯得出", FIXTURE_SLIDES, { allHidden: true });

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/outline.md`);
    expect(response.status).toBe(200);
    const body = await response.text();
    // 不只是「回了 200」：三頁一頁不少，而且每一頁都標了隱藏——但標在正文那一行，
    // `##` 標題本身乾淨（否則回丟成大綱參考時會多出三頁叫「…（隱藏頁）」的投影片）。
    expect(body.match(/^## .*$/gm)).toEqual(["## 1. 開場", "## 2. 備用資料", "## 3."]);
    expect(body.split("（這一頁在原簡報中設為隱藏").length - 1).toBe(3);
    expect(body).toContain("> 講述：只有敘事。");

    // 對照組：同一份專案的 pptx／pdf 確實在這個狀態被擋下，所以上面的 200 不是「這個
    // 狀態下什麼都不會失敗」。
    for (const format of ["pptx", "pdf"] as const) {
      const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/export/${format}`);
      expect(blocked.status, format).toBe(400);
      const payload = (await blocked.json()) as { error: string; message?: string };
      expect(payload.error, format).toBe("EXPORT_NO_VISIBLE_SLIDES");
      // 那句 400 的說明要把**還匯得出來的格式列全**——匯出連結是裸 `<a href>`，這段文字
      // 就是使用者在瀏覽器分頁裡唯一看得到的下一步。少列一個，等於使用者以為只剩兩條路。
      for (const alternative of ["下載每頁 PNG", "下載大綱", "備份完整專案"])
        expect(payload.message, `${format} / ${alternative}`).toContain(alternative);
    }
  }, 120_000);

  it("一頁圖都還沒生成時也匯得出來（它一個資產都不讀）", async () => {
    if (bindUnavailable) return;
    // fixture 本來就沒有任何 currentVersionId；這一條把「大綱在生成之前就下載得到」寫成
    // 正面斷言——精靈 STEP 4 的那顆按鈕正是在這個時間點按下去的。
    const project = await seed("尚未生成", FIXTURE_SLIDES);
    expect(project.slides.every((slide) => !slide.currentVersionId)).toBe(true);

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/outline.md`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(GOLDEN.replace("# Q3 產品回顧", "# 尚未生成"));
  }, 60_000);

  it("`exportPresentation` 直接呼叫時同樣不碰 repository", async () => {
    // 匯出端點以外還有這個直接呼叫的入口（測試與未來的批次工具都走它）。傳一個會在任何
    // 資產存取上爆掉的 repository：只要 `outline.md` 那條偷偷讀了一個檔就會紅。
    const project = await seed("不碰資產", FIXTURE_SLIDES);
    const exploding = new Proxy({} as FileProjectRepository, {
      get() {
        throw new Error("outline.md must not touch the repository");
      },
    });

    const bytes = await exportPresentation(exploding, project, "outline.md");

    expect(Buffer.from(bytes).toString("utf8")).toBe(GOLDEN.replace("# Q3 產品回顧", "# 不碰資產"));
  }, 60_000);
});

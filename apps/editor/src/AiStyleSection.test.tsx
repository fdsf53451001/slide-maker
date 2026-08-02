// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createDefaultStyle,
  createProject,
  projectStyleId,
  STYLE_NAME_MAX_LENGTH,
  tonalRegisterBullet,
  type PresentationProject,
  type StylePreset,
} from "@slide-maker/core";
import { Editor } from "./Editor.js";
import { aiStyleEntries, styleLibraryCopyInput, styleLibraryCopyName } from "./editor/aiStyles.js";

/**
 * 風格庫頁的「AI 產生」區：各專案自己那份、風格庫查不到的設計系統。
 *
 * 這一區存在的前提是一條**不可以被順手改好**的不變式：專案本地風格的 id
 * （`projectStyleId()` ＝ `pdf-style-<projectId>`）永遠不進風格庫，否則生成前的版本同步
 * 會把它整包蓋掉。所以第一組測試釘的不是畫面而是那條不變式。
 */

const NOW = "2026-08-02T10:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeEach(() => {
  window.history.pushState({}, "", "/styles");
});

const DESIGN_SYSTEM_WITH_TONE = [
  "## 設計思路",
  "以資料密度優先的深色簡報。",
  "## 不可協商：每一頁都必須相同",
  tonalRegisterBullet("dark"),
  "- 背景：#0d131f",
].join("\n");

const DESIGN_SYSTEM_WITHOUT_TONE = [
  "## 設計思路",
  "舊格式：這個欄位存在之前分析出來的設計系統。",
  "## 不可協商：每一頁都必須相同",
  "- 背景：#ffffff",
].join("\n");

function aiProject(input: {
  id: string;
  name: string;
  designSystem?: string;
  styleName?: string;
  referenceImages?: StylePreset["referenceImages"];
  styleDirection?: PresentationProject["styleDirection"];
  updatedAt?: string;
  /** 有生成圖的頁面數；0 代表這份簡報一張圖都還沒生。 */
  renderedSlides?: number;
  hiddenFirstSlide?: boolean;
}): PresentationProject {
  const base = createProject({ topic: input.name, name: input.name, now: NOW });
  const slides = base.slides.slice(0, 3).map((slide, index) => ({
    ...slide,
    order: index,
    hidden: index === 0 && input.hiddenFirstSlide === true,
    ...(index < (input.renderedSlides ?? 0)
      ? {
          currentVersionId: `${input.id}-s${index}-v1`,
          versions: [
            {
              id: `${input.id}-s${index}-v1`,
              imagePath: `assets/${input.id}-s${index}/v1.png`,
              prompt: "",
              providerId: "mock-image",
              model: "mock",
              parameters: {},
              styleVersion: 1,
              sources: [],
              createdAt: NOW,
            },
          ],
        }
      : {}),
  }));
  return {
    ...base,
    id: input.id,
    name: input.name,
    updatedAt: input.updatedAt ?? NOW,
    workflowStage: "editing",
    slides,
    styleSnapshot: {
      ...createDefaultStyle(NOW),
      // 專案本地 fork：id 是這一區唯一的判準。
      id: projectStyleId(input.id),
      system: false,
      name: input.styleName ?? `${input.name} 的設計系統`,
      designSystem: input.designSystem ?? DESIGN_SYSTEM_WITH_TONE,
      referenceImages: input.referenceImages ?? [],
    },
    ...(input.styleDirection ? { styleDirection: input.styleDirection } : {}),
  };
}

/** 用了風格庫裡的風格（不該出現在「AI 產生」區）。 */
function libraryStyleProject(id: string, name: string): PresentationProject {
  const base = createProject({ topic: name, name, now: NOW });
  return {
    ...base,
    id,
    name,
    workflowStage: "editing",
    styleSnapshot: { ...createDefaultStyle(NOW), designSystem: DESIGN_SYSTEM_WITH_TONE },
  };
}

const reference = (id: string): StylePreset["referenceImages"][number] => ({
  id,
  name: `${id}.png`,
  mediaType: "image/png",
  assetPath: `assets/${id}.png`,
  createdAt: NOW,
});

type Recorded = { path: string; method: string; body: unknown };

function stubLibrary(projects: PresentationProject[], styles: StylePreset[] = []) {
  const calls: Recorded[] = [];
  let created = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? new URL(input, "http://localhost").pathname
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ path, method, body });
    if (path === "/api/projects" && method === "GET") return Response.json(projects);
    if (path === "/api/providers") return Response.json([]);
    if (path === "/api/styles" && method === "GET")
      return Response.json([createDefaultStyle(NOW), ...styles]);
    if (path === "/api/styles" && method === "POST") {
      const input_ = body as { name: string };
      created += 1;
      return Response.json(
        {
          ...createDefaultStyle(NOW),
          // 伺服器一律發新 uuid（`stylePresetInputSchema` 把 id omit 掉）。
          id: `library-copy-${created}`,
          system: false,
          name: input_.name,
        },
        { status: 201 },
      );
    }
    if (path === "/api/model-library")
      return Response.json({ connections: [], models: [], combinations: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function aiSection(): HTMLElement {
  const section = document.querySelector(".ai-style-section");
  if (!section) throw new Error("找不到「AI 產生」區");
  return section as HTMLElement;
}

function cards(): HTMLElement[] {
  return [...aiSection().querySelectorAll(".ai-style-card")] as HTMLElement[];
}

describe("風格庫的「AI 產生」區：不變式", () => {
  /**
   * **這一條是整個功能的地基**：`pdf-style-*` 一旦進了風格庫，`refreshStyleForGeneration()`
   * 就查得到它，下一次生成前會用庫裡那一版 `structuredClone` 整包蓋掉專案專屬的設計系統，
   * 而那時 `POST /outline` 已被 `OUTLINE_HAS_GENERATED_VERSIONS` 擋住＝沒有復原路徑。
   * 所以複製動作只能建**新 id**，且送出的 body 一個 `pdf-style-` 字樣都不能有。
   */
  it("複製動作送出的 body 不帶 id，也沒有任何 pdf-style-* 字樣", async () => {
    const project = aiProject({ id: "proj-a", name: "營運回顧", renderedSlides: 1 });
    const { calls } = stubLibrary([project]);
    render(<Editor />);

    fireEvent.click(await screen.findByRole("button", { name: "複製到風格庫" }));

    await waitFor(() =>
      expect(calls.some((call) => call.path === "/api/styles" && call.method === "POST")).toBe(
        true,
      ),
    );
    const posted = calls.find((call) => call.path === "/api/styles" && call.method === "POST")!;
    const body = posted.body as Record<string, unknown>;
    expect(body.id).toBeUndefined();
    expect("id" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(projectStyleId("proj-a"));
    expect(JSON.stringify(body)).not.toContain("pdf-style-");
    // 設計系統本體有跟著走，否則複製出去的是一份空殼。
    expect(body.designSystem).toBe(DESIGN_SYSTEM_WITH_TONE);
  });

  /** 原專案不改指向：改了就等於把它放回「風格庫查得到 → 下次生成被蓋掉」的老路。 */
  it("不動原專案：沒有任何寫入打到 /api/projects/*", async () => {
    const project = aiProject({ id: "proj-a", name: "營運回顧", renderedSlides: 1 });
    const { calls } = stubLibrary([project]);
    render(<Editor />);

    fireEvent.click(await screen.findByRole("button", { name: "複製到風格庫" }));
    await screen.findByText(/已複製為/);

    const projectWrites = calls.filter(
      (call) => call.path.startsWith("/api/projects/") && call.method !== "GET",
    );
    expect(projectWrites).toEqual([]);
  });

  /** 複製出來的那一份要立刻出現在上方風格庫，使用者才知道動作成功了。 */
  it("複製成功後新風格進入上方風格庫，且卡片留下複本名稱", async () => {
    const project = aiProject({ id: "proj-a", name: "營運回顧", renderedSlides: 1 });
    stubLibrary([project]);
    render(<Editor />);

    const before = document.querySelectorAll(".style-library-section .style-card").length;
    fireEvent.click(await screen.findByRole("button", { name: "複製到風格庫" }));

    await waitFor(() =>
      expect(document.querySelectorAll(".style-library-section .style-card")).toHaveLength(
        before + 1,
      ),
    );
    expect(
      within(cards()[0]!).getByText(/已複製為「營運回顧 的設計系統（來自 營運回顧）」/),
    ).toBeTruthy();
    // 唯讀衍生視圖：原本那張卡片還在，沒有被「搬」進風格庫。
    expect(cards()).toHaveLength(1);
  });

  /** 連點兩下只能建出一份：兩份同名風格是無法自動收拾的髒資料。 */
  it("複製進行中按鈕停用，不會建出第二份", async () => {
    const project = aiProject({ id: "proj-a", name: "營運回顧", renderedSlides: 1 });
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => (release = resolve));
    const calls: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ path, method, body: undefined });
        if (path === "/api/styles" && method === "POST") return pending;
        if (path === "/api/projects") return Response.json([project]);
        if (path === "/api/styles") return Response.json([createDefaultStyle(NOW)]);
        if (path === "/api/providers") return Response.json([]);
        if (path === "/api/model-library")
          return Response.json({ connections: [], models: [], combinations: [] });
        return Response.json({});
      }),
    );
    render(<Editor />);

    fireEvent.click(await screen.findByRole("button", { name: "複製到風格庫" }));
    const busy = (await screen.findByRole("button", { name: "複製中…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(
      calls.filter((call) => call.path === "/api/styles" && call.method === "POST"),
    ).toHaveLength(1);
    release(Response.json({ ...createDefaultStyle(NOW), id: "library-copy-1" }, { status: 201 }));
    await screen.findByRole("button", { name: "複製到風格庫" });
  });

  /** 失敗要說得出原因，而不是按鈕彈回來就沒事了。 */
  it("複製失敗時顯示伺服器的原因並放開按鈕", async () => {
    const project = aiProject({ id: "proj-a", name: "營運回顧", renderedSlides: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/styles" && method === "POST")
          return Response.json(
            { error: "STYLE_REFERENCE_LIMIT", message: "風格參考圖超過上限。" },
            { status: 400 },
          );
        if (path === "/api/projects") return Response.json([project]);
        if (path === "/api/styles") return Response.json([createDefaultStyle(NOW)]);
        if (path === "/api/providers") return Response.json([]);
        if (path === "/api/model-library")
          return Response.json({ connections: [], models: [], combinations: [] });
        return Response.json({});
      }),
    );
    render(<Editor />);

    fireEvent.click(await screen.findByRole("button", { name: "複製到風格庫" }));
    expect(await screen.findByText(/風格參考圖超過上限/)).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "複製到風格庫" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});

describe("風格庫的「AI 產生」區：卡片內容", () => {
  it("有參考圖、有明暗登記、有生成圖：三樣都顯示得出來", async () => {
    const project = aiProject({
      id: "proj-ref",
      name: "年度報告",
      referenceImages: [reference("ref-1"), reference("ref-2")],
      renderedSlides: 2,
    });
    stubLibrary([project]);
    render(<Editor />);

    const card = within(
      (await screen.findAllByRole("article")).find((node) =>
        node.className.includes("ai-style-card"),
      )!,
    );
    expect(card.getByText("參考圖分析")).toBeTruthy();
    expect(card.getByText("深色")).toBeTruthy();
    expect(card.getByText("來自「年度報告」")).toBeTruthy();
    // 縮圖走專案既有的取圖路徑（`/api/projects/:id/assets/...`），不是自己拼的路徑。
    const image = card.getByRole("img") as HTMLImageElement;
    expect(new URL(image.src).pathname).toBe("/api/projects/proj-ref/assets/proj-ref-s0/v1.png");
  });

  it("無參考圖但風格決議成功：標成「AI 自由設計決議」", async () => {
    const project = aiProject({
      id: "proj-dir",
      name: "產品發表",
      styleDirection: { applied: true },
      renderedSlides: 1,
    });
    stubLibrary([project]);
    render(<Editor />);

    await screen.findByText("AI 自由設計決議");
    expect(screen.queryByText("參考圖分析")).toBeNull();
  });

  /** 兩者皆非的舊資料也要有標籤：沒有標籤的卡片會讓人以為它與旁邊那些是同一種東西。 */
  it("既無參考圖也沒有風格決議紀錄（舊資料）：給中性標籤", async () => {
    const project = aiProject({ id: "proj-old", name: "舊簡報", renderedSlides: 1 });
    stubLibrary([project]);
    render(<Editor />);

    await screen.findByText("AI 產生", { selector: ".ai-style-tag" });
  });

  /** 舊格式沒有明暗登記那一行：一個 chip 都不顯示，不猜一邊。 */
  it("設計系統沒有明暗登記時不顯示深／淺 chip", async () => {
    const project = aiProject({
      id: "proj-no-tone",
      name: "沒有登記",
      designSystem: DESIGN_SYSTEM_WITHOUT_TONE,
      renderedSlides: 1,
    });
    stubLibrary([project]);
    render(<Editor />);

    await screen.findByText(/來自「沒有登記」/);
    expect(screen.queryByText("深色")).toBeNull();
    expect(screen.queryByText("淺色")).toBeNull();
    expect(document.querySelectorAll(".ai-style-tag")).toHaveLength(1);
  });

  it("淺色登記顯示「淺色」", async () => {
    const project = aiProject({
      id: "proj-light",
      name: "淺色簡報",
      designSystem: DESIGN_SYSTEM_WITH_TONE.replace(
        tonalRegisterBullet("dark"),
        tonalRegisterBullet("light"),
      ),
      renderedSlides: 1,
    });
    stubLibrary([project]);
    render(<Editor />);

    await screen.findByText("淺色");
  });

  /** 一張圖都還沒生：退回純文字卡片，不放破圖。 */
  it("還沒生成任何圖的專案顯示純文字卡片", async () => {
    const project = aiProject({ id: "proj-blank", name: "只有大綱", renderedSlides: 0 });
    stubLibrary([project]);
    render(<Editor />);

    await screen.findByText("尚未生成任何頁面");
    expect(within(cards()[0]!).queryByRole("img")).toBeNull();
  });

  /** 次要動作：開啟該專案（縮圖與按鈕兩處都通到同一個地方）。 */
  it("「開啟簡報」進入該專案", async () => {
    const project = aiProject({ id: "proj-open", name: "要開起來的", renderedSlides: 1 });
    stubLibrary([project]);
    render(<Editor />);

    fireEvent.click(await screen.findByRole("button", { name: "開啟簡報" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/proj-open"));
  });
});

describe("風格庫的「AI 產生」區：清單本身", () => {
  it("空狀態說明它是什麼、什麼情況下會出現", async () => {
    stubLibrary([libraryStyleProject("proj-lib", "用風格庫風格的簡報")]);
    render(<Editor />);

    const empty = await screen.findByText("還沒有 AI 產生的設計系統");
    // 空白區塊沒有用：說明必須講出「這是什麼、什麼情況下才會出現東西」。
    const hint = within(empty.parentElement!).getByText(/什麼時候會出現|自由設計|PDF/);
    expect(hint.textContent).toContain("AI 自由設計");
    expect(hint.textContent).toContain("PDF");
    expect(cards()).toHaveLength(0);
  });

  it("用風格庫風格的專案不會被列進來", async () => {
    stubLibrary([
      libraryStyleProject("proj-lib", "用風格庫風格的簡報"),
      aiProject({ id: "proj-ai", name: "自己一套的簡報", renderedSlides: 1 }),
    ]);
    render(<Editor />);

    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(within(cards()[0]!).getByText("來自「自己一套的簡報」")).toBeTruthy();
  });

  it("依 updatedAt 由新到舊排序，與上方專案清單一致", async () => {
    stubLibrary([
      aiProject({ id: "old", name: "比較舊", updatedAt: "2026-07-01T00:00:00.000Z" }),
      aiProject({ id: "new", name: "比較新", updatedAt: "2026-08-01T00:00:00.000Z" }),
      aiProject({ id: "mid", name: "中間", updatedAt: "2026-07-20T00:00:00.000Z" }),
    ]);
    render(<Editor />);

    await waitFor(() => expect(cards()).toHaveLength(3));
    // `:scope >` 是必要的：卡片沒有封面時預覽區裡也有一個 <small>（「尚未生成任何頁面」）。
    expect(cards().map((card) => card.querySelector(":scope > small")?.textContent)).toEqual([
      "來自「比較新」",
      "來自「中間」",
      "來自「比較舊」",
    ]);
  });
});

describe("aiStyleEntries / styleLibraryCopyInput（單元）", () => {
  it("id 是專案本地 fork、且真的有設計系統時才收", () => {
    const withSystem = aiProject({ id: "a", name: "有設計系統" });
    const withoutSystem = aiProject({ id: "b", name: "只改過名字", designSystem: "" });
    const fromLibrary = libraryStyleProject("c", "庫裡的風格");
    expect(
      aiStyleEntries([withSystem, withoutSystem, fromLibrary]).map((e) => e.project.id),
    ).toEqual(["a"]);
  });

  /** 隱藏頁不上場，拿它代表整份簡報的長相是錯的。 */
  it("縮圖跳過隱藏頁，取第一張有圖的可見頁", () => {
    const project = aiProject({
      id: "hid",
      name: "第一頁被藏起來",
      renderedSlides: 2,
      hiddenFirstSlide: true,
    });
    expect(aiStyleEntries([project])[0]?.cover).toContain("/assets/hid-s1/v1.png");
  });

  it("複製輸入不帶 id、不帶參考圖，設計系統與其餘風格欄位照搬", () => {
    const project = aiProject({
      id: "copy",
      name: "來源簡報",
      referenceImages: [reference("ref-1")],
    });
    const entry = aiStyleEntries([project])[0]!;
    const input = styleLibraryCopyInput(entry);
    expect("id" in input).toBe(false);
    // 參考圖的資產歸原專案所有（`ownedStyleReferences()`），原專案重新分析或換風格時會被
    // 真的刪掉，共用 id 的複本就指向不存在的檔案。所以一張都不帶。
    expect(input.referenceImages).toEqual([]);
    expect(input.designSystem).toBe(DESIGN_SYSTEM_WITH_TONE);
    expect(input.density).toBe(project.styleSnapshot.density);
    expect(input.avoid).toEqual(project.styleSnapshot.avoid);
  });

  /**
   * 專案名的上限是 200 字、風格名只有 120——不裁就是一個註定被伺服器 400 擋下的名字，
   * 使用者看到的是「按了沒反應」。
   */
  it("名稱裁到風格名的上限，且仍留得住來源專案", () => {
    const short = styleLibraryCopyName("設計系統", "營運回顧");
    expect(short).toBe("設計系統（來自 營運回顧）");
    expect(short.length).toBeLessThanOrEqual(STYLE_NAME_MAX_LENGTH);

    const longProject = styleLibraryCopyName("設計系統", "專".repeat(200));
    expect(longProject.length).toBeLessThanOrEqual(STYLE_NAME_MAX_LENGTH);
    expect(longProject.trim().length).toBeGreaterThan(0);

    const longStyle = styleLibraryCopyName("風".repeat(300), "營運回顧");
    expect(longStyle.length).toBeLessThanOrEqual(STYLE_NAME_MAX_LENGTH);
    expect(longStyle.endsWith("（來自 營運回顧）")).toBe(true);
  });
});

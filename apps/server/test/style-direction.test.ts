import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  PresentationProject,
  StructuredTextProvider,
  StructuredTextRequest,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelLibraryError, ModelRuntime } from "../src/model-runtime.js";
import { STYLE_DIRECTION_PROMPT } from "../src/style-direction.js";
import { isStyleDirectionPrompt, STYLE_DIRECTION_REPLY } from "./helpers/style-direction-stub.js";

/**
 * 「AI 自由設計」的風格決議。
 *
 * 這一組釘的是使用者實測回報的第二個症狀（「一長串一黑一白」）的**成因端**：預設風格的
 * `designSystem` 是空字串、`referenceImages` 也是空的，於是每一頁生圖那次無狀態呼叫手上
 * 沒有任何共用的視覺基準，只能各自「選一個原創且連貫的方向」。決議一次、每頁吃同一份
 * 字串，那個「一致」才第一次真的存在於 prompt 裡。
 *
 * 它是**可選步驟**，所以這裡每一條都在問同一個問題的不同面向：它失敗的時候，那份已經
 * 花掉一次搜尋加兩次模型呼叫生出來的大綱有沒有活下來，而使用者知不知道發生了什麼。
 */
describe("AI 自由設計的風格決議", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  const restore: (() => void)[] = [];

  /**
   * 大綱的兩階段固定回同一份最小合法結果；風格決議那一次交給 `onDirection` 決定。
   * `resolveOverride` 讓測試模擬「解析 provider 這個動作本身就失敗」（設定錯誤）。
   */
  const stubText = (options: {
    onDirection: (request: StructuredTextRequest) => unknown;
    /** 在模型「回覆之前」跑一次，讓測試確定性地插進另一條寫入路徑（見 superseded 那條）。 */
    beforeDirection?: () => Promise<unknown>;
    resolveOverride?: (call: number) => StructuredTextProvider | undefined;
    availability?: StructuredTextProvider["availability"];
  }) => {
    let resolveCall = 0;
    const provider = {
      id: "stub-text",
      availability: options.availability ?? { status: "available" as const },
      runStructured: async (request: StructuredTextRequest) => {
        if (isStyleDirectionPrompt(request.prompt)) {
          if (options.beforeDirection) await options.beforeDirection();
          const result = options.onDirection(request);
          if (result instanceof Error) throw result;
          return { value: result };
        }
        if (request.prompt.includes("presentation strategist"))
          return {
            value: {
              actualSlideCount: 1,
              rationale: "測試用計畫",
              slides: [{ purpose: "市場概況", pageType: "cover", sourceRefs: [], imageRefs: [] }],
            },
          };
        return {
          value: {
            slides: [
              {
                planRef: "P1",
                content: SLIDE_BODY,
                narrative: "先講結論",
                layoutHint: "單欄重點",
                sourceRefs: [],
                imageRefs: [],
                sourceUrls: [],
              },
            ],
          },
        };
      },
    } as StructuredTextProvider;
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockImplementation((() => {
      resolveCall += 1;
      return options.resolveOverride?.(resolveCall) ?? provider;
    }) as ModelRuntime["resolveTextProvider"]);
    restore.push(() => spy.mockRestore());
  };

  /** 只有這一頁的正文有這串字：拿它檢查 log 裡有沒有洩漏簡報內容。 */
  const SLIDE_BODY = "台灣電動車二〇二五年掛牌數為五萬八千輛";

  const captureWarnings = (): (() => Record<string, unknown>[]) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    restore.push(() => spy.mockRestore());
    return () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  beforeAll(async () => {
    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-style-direction-")), "data");
    const app = await createApp(dataRoot);
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
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }, 60_000);

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  const createProject = async (): Promise<PresentationProject> => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "台灣電動車市場",
        brief: { desiredSlideCount: 1, webSearchMode: "disabled" },
      }),
    });
    return (await response.json()) as PresentationProject;
  };

  const generateOutline = async (projectId: string) => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace: true }),
    });
    return { status: response.status, body: (await response.json()) as PresentationProject };
  };

  it("把一份三軌設計系統寫進 styleSnapshot，之後每一頁生圖都吃同一份字串", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    stubText({ onDirection: () => STYLE_DIRECTION_REPLY });
    const { status, body } = await generateOutline(project.id);
    expect(status).toBe(200);
    expect(body.styleDirection).toEqual({ applied: true });
    // 明暗登記要以可執行的句子落地，這是「一黑一白」的直接解藥。
    expect(body.styleSnapshot.designSystem).toContain("明暗登記：深色（dark）");
    expect(body.styleSnapshot.designSystem).toContain("不可協商：每一頁都必須相同");
    expect(body.styleSnapshot.designSystem).toContain("每頁自由決定：鼓勵各頁不同");
  });

  it("prompt 明說每頁是獨立呼叫，並要求三軌分開", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const prompts: string[] = [];
    stubText({
      onDirection: (request) => {
        prompts.push(request.prompt);
        return STYLE_DIRECTION_REPLY;
      },
    });
    await generateOutline(project.id);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    // 受詞問題要講給模型聽：它必須知道自己寫的這份文件是唯一會跨頁旅行的東西。
    expect(prompt).toContain(
      "Whatever you leave unstated will be decided independently on every page",
    );
    expect(prompt).toContain("Sort your decisions into three tracks");
    expect(prompt).toContain("no page may cross to the other side");
    // 同一個量只能出現在一軌。文案佔比已經由資訊密度設定給了數字，所以它不在自由軸上，
    // 而且禁令清單要點名它——否則模型會把它寫進 designSystem 的自由段，繞過密度設定。
    expect(prompt).not.toContain("the ratio of copy to visual");
    expect(prompt).toContain("or a share of the canvas given to copy in it");
    // 面積額度與邊距只對一般內頁成立（同一份 prompt 明說封面可以滿版）。
    expect(prompt).toContain("how much of a normal content page it is allowed to cover");
    expect(prompt).toContain("the outer page margins a normal content page uses");
    // 這是風格指南不是摘要：不得複述簡報的事實內容或組織／產品名稱。
    expect(prompt).toContain("Do not restate the deck's factual content");
    expect(prompt).toContain("UNTRUSTED_INPUT");
  });

  it("設定錯誤與執行期失敗走不同的代碼，兩者都不會讓大綱失敗", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * 這一條是 CLAUDE.md 那條「設定錯誤 vs 執行期失敗」在**可選步驟**上的形狀。設定錯誤
     * 平常要擋在花配額之前，但跑到這裡時大綱已經生出來了——擋下只是把跑完的工作丟掉。
     * 所以兩者都降級，差別在代碼：一個要使用者去模型庫改設定，一個是再試一次。
     */
    const configProject = await createProject();
    const configLogs = captureWarnings();
    stubText({
      onDirection: () => STYLE_DIRECTION_REPLY,
      // 第 1 次解析是大綱自己要用的（必須成功），第 2 次才是風格決議那一次。模型庫在
      // 大綱那數十秒之間被存檔就是這個形狀（`applyLibrary` 會原子替換 registry）。
      resolveOverride: (call) => {
        if (call < 2) return undefined;
        throw new ModelLibraryError("COMBINATION_NOT_FOUND", "找不到模型組合：x");
      },
    });
    const config = await generateOutline(configProject.id);
    expect(config.status).toBe(200);
    expect(config.body.slides[0]!.content).toBe(SLIDE_BODY);
    expect(config.body.styleDirection).toEqual({
      applied: false,
      reason: "COMBINATION_NOT_FOUND",
    });
    expect(config.body.styleSnapshot.designSystem).toBe("");
    expect(
      configLogs().filter((entry) => entry.event === "style_direction_model_unresolved"),
    ).toHaveLength(1);
    for (const undo of restore.splice(0)) undo();

    const runtimeProject = await createProject();
    const runtimeLogs = captureWarnings();
    stubText({
      // 非嚴格 gateway 會把 request body 原樣回聲進 400 的 message，而那份 body 裝著這份
      // 簡報每一頁的正文。用真的會洩漏的例外形狀，改動前的程式碼才通不過下面那條斷言。
      onDirection: (request) => new Error(`HTTP 400 from gateway: ${request.prompt}`),
    });
    const runtimeRun = await generateOutline(runtimeProject.id);
    expect(runtimeRun.status).toBe(200);
    expect(runtimeRun.body.slides[0]!.content).toBe(SLIDE_BODY);
    expect(runtimeRun.body.styleDirection).toEqual({
      applied: false,
      reason: "STYLE_DIRECTION_FAILED",
    });
    const failures = runtimeLogs().filter((entry) => entry.event === "style_direction_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: "STYLE_DIRECTION_FAILED", errorName: "Error" });
    // 序列化後一個字的正文都不得出現——`logWarn` 的第三個參數會把 message 與 stack 整份
    // 寫進去，所以這條 catch 必須先過濾。
    const serialized = JSON.stringify(failures);
    expect(serialized).not.toContain(SLIDE_BODY);
    expect(serialized).not.toContain(STYLE_DIRECTION_PROMPT.slice(0, 40));
  });

  it("模型沒 throw 但交出空殼時算降級，不會靜默寫進一個空的設計系統", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    const logs = captureWarnings();
    // parse 得過、不 throw，但沒有色票＝空殼。與「整段沒跑」長得一模一樣，只是換了入口。
    stubText({ onDirection: () => ({ designRationale: "現代簡約", invariants: { palette: [] } }) });
    const { status, body } = await generateOutline(project.id);
    expect(status).toBe(200);
    expect(body.styleDirection).toEqual({ applied: false, reason: "STYLE_DIRECTION_EMPTY" });
    expect(body.styleSnapshot.designSystem).toBe("");
    expect(logs().some((entry) => entry.reason === "STYLE_DIRECTION_EMPTY")).toBe(true);
  });

  it("缺明暗登記時照樣採用，但把「明暗仍可能翻」這件事回報給前端", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    stubText({
      onDirection: () => ({
        ...STYLE_DIRECTION_REPLY,
        invariants: {
          ...STYLE_DIRECTION_REPLY.invariants,
          tonalRegister: undefined,
          // 沒有 hex 就推不出來：其餘欄位仍然有價值，丟掉它們沒有道理。
          background: "深色底",
        },
      }),
    });
    const { body } = await generateOutline(project.id);
    expect(body.styleDirection).toEqual({
      applied: true,
      reason: "STYLE_DIRECTION_TONE_MISSING",
    });
    expect(body.styleSnapshot.designSystem).toContain("不可協商");
    expect(body.styleSnapshot.designSystem).not.toContain("明暗登記");
  });

  it("決議結果撐得過生成前的風格同步，不會被風格庫的原版蓋回去", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * 每一次生成之前 `refreshStyleForGeneration` 都會拿風格庫裡同 id 的風格比對版本號，
     * 版本不同就整包覆蓋 `styleSnapshot`——而決議的產物就寫在那裡面。目前兩邊同為
     * version 1 所以相安無事，但那是**巧合維持的**：哪天有人動了預設風格的版本號，
     * 每一份「AI 自由設計」的簡報都會在按下生成的那一刻靜默失去設計系統，而畫面上唯一
     * 的徵兆就是頁與頁又開始不一致。這條測試走真正的生成端點，讓那個改動當場變紅。
     */
    const project = await createProject();
    stubText({ onDirection: () => STYLE_DIRECTION_REPLY });
    const { body: outlined } = await generateOutline(project.id);
    expect(outlined.styleSnapshot.designSystem).not.toBe("");
    const generate = await fetch(`${baseUrl}/api/projects/${project.id}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "mock-image", acceptUnknownReadiness: true }),
    });
    expect(generate.status).toBeLessThan(400);
    const after = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}`)
    ).json()) as PresentationProject;
    expect(after.styleSnapshot.designSystem).toBe(outlined.styleSnapshot.designSystem);
  }, 60_000);

  it("自由那一軌整段掉了要留下證據，不能與「模型寫得保守」混在一起", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * `freeChoices` 是 `.default([])`，排版端又略過空段落 → 產出的設計系統沒有那個標題 →
     * 合約整份讀成 invariant（那是舊格式相容所必需的），**構圖自由那一軌整個消失**。
     * 這是「模型沒有 throw 不等於它做了事」的另一個入口，而且與一黑一白剛好是相反方向的
     * 失敗（每頁都同一個版型），同樣靜默。
     */
    const project = await createProject();
    const logs = captureWarnings();
    stubText({ onDirection: () => ({ ...STYLE_DIRECTION_REPLY, freeChoices: [] }) });
    const { body } = await generateOutline(project.id);
    // 仍然採用：其餘七軌有價值，丟掉它們沒有道理。
    expect(body.styleDirection?.applied).toBe(true);
    expect(body.styleSnapshot.designSystem).not.toContain("每頁自由決定");
    const empty = logs().filter((entry) => entry.event === "style_direction_free_choices_empty");
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ projectId: project.id, modelId: "stub-text" });
  }, 60_000);

  it("被別條路搶先寫入時記一行，並且不留下過期的結果", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * 模型跑那十幾秒裡使用者剛套用了一個帶參考圖的風格（或跑完一次真正的參考圖分析）。
     * 這一次的呼叫等於白花了，而原因只有伺服器看得到；同時那份結果連同它的降級說明都已
     * 經過期，留著會讓前端對著一份其實有設計系統的專案說「沒有共用的設計系統」。
     */
    const project = await createProject();
    const logs = captureWarnings();
    stubText({
      // 在模型回覆**之前**完成另一條路的寫入，讓「交易裡的重檢」必定看到它。用 await 而
      // 不是真的競速：race 出來的測試會間歇性地驗到另一半，等於沒有釘住任何一邊。
      beforeDirection: () =>
        fetch(`${baseUrl}/api/projects/${project.id}/style-snapshot`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ designSystem: "## 色票\n- #123456 — 另一條路寫的" }),
        }),
      onDirection: () => STYLE_DIRECTION_REPLY,
    });
    const { body } = await generateOutline(project.id);
    // 別人的設計系統原封不動，我們的結果連同降級說明一起消失。
    expect(body.styleSnapshot.designSystem).toContain("另一條路寫的");
    expect(body.styleDirection).toBeUndefined();
    const superseded = logs().filter((entry) => entry.event === "style_direction_superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({ projectId: project.id, applied: true });
  }, 60_000);

  it("漏網的例外只讓風格決議消失，大綱照樣落地", async (context) => {
    if (bindUnavailable) return context.skip();
    // `resolveStyleDirection()` 承諾永遠不 throw，而那個承諾離「被某次重構弄假」只有一步。
    // 呼叫端的 `.catch()` 把它變成結構保證，這條測試釘的就是那道網子。
    const project = await createProject();
    const logs = captureWarnings();
    stubText({
      onDirection: () => STYLE_DIRECTION_REPLY,
      // `resolve()` 丟一個**不是** ModelLibraryError 的例外：`resolveStyleDirection` 會照
      // 原樣往上拋（它只認得設定錯誤），於是只剩呼叫端那道網子接得住。
      resolveOverride: (call) => {
        if (call < 2) return undefined;
        throw new TypeError("registry exploded");
      },
    });
    const { status, body } = await generateOutline(project.id);
    expect(status).toBe(200);
    expect(body.slides[0]!.content).toBe(SLIDE_BODY);
    expect(body.styleDirection).toBeUndefined();
    const unexpected = logs().filter((entry) => entry.event === "style_direction_unexpected");
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toMatchObject({ projectId: project.id, errorName: "TypeError" });
    expect(JSON.stringify(unexpected)).not.toContain(SLIDE_BODY);
  }, 60_000);

  it("風格被換掉時，過期的決議結果要跟著消失（兩個 writer 都要）", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * 這條不變式有兩個 writer：`PATCH /style-snapshot`（參考圖分析那條）與 `POST /style`
     * （套用風格庫的風格）。只守一個等於沒守，而後果有兩層：①前端會對著一份剛換好的風格
     * 說「這份簡報沒有共用的設計系統」；②殘留的 `applied: true` 會讓
     * `shouldResolveStyleDirection()` 判定「上次是我們自己寫的、可以重寫」，下一次重建大綱
     * 就把使用者剛選的風格覆蓋掉。
     */
    for (const writer of ["snapshot", "library-style"] as const) {
      const project = await createProject();
      stubText({ onDirection: () => STYLE_DIRECTION_REPLY });
      const { body: outlined } = await generateOutline(project.id);
      expect(outlined.styleDirection?.applied, writer).toBe(true);
      for (const undo of restore.splice(0)) undo();

      const response =
        writer === "snapshot"
          ? await fetch(`${baseUrl}/api/projects/${project.id}/style-snapshot`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ designSystem: "## 色票\n- #F7F5F0 — 內頁畫布底色" }),
            })
          : await fetch(`${baseUrl}/api/projects/${project.id}/style`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ styleId: "ai-free-design" }),
            });
      expect(response.status, writer).toBeLessThan(400);
      const replaced = (await response.json()) as PresentationProject;
      expect(replaced.styleDirection, writer).toBeUndefined();
    }
  }, 60_000);

  it("上一份設計系統是我們自己寫的時候，重建大綱會重新決議", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * `shouldResolveStyleDirection()` 若只看 designSystem 空不空，就分不出「使用者／分析
     * 寫的」與「上次我們自己寫的」——而使用者改完 brief 重建大綱，多半正是因為主題換了。
     * 沿用照舊主題決議出來的視覺系統已經夠糟，`styleDirectionNotice()` 對舊的
     * `applied:true` 又回 `undefined`（完全靜默），兩件事加起來就是「怎麼重建都沒反應」。
     */
    const project = await createProject();
    let calls = 0;
    stubText({
      onDirection: () => {
        calls += 1;
        return { ...STYLE_DIRECTION_REPLY, designRationale: `第 ${calls} 次決議` };
      },
    });
    const first = await generateOutline(project.id);
    expect(first.body.styleSnapshot.designSystem).toContain("第 1 次決議");
    const second = await generateOutline(project.id);
    expect(calls).toBe(2);
    expect(second.body.styleSnapshot.designSystem).toContain("第 2 次決議");
    expect(second.body.styleDirection).toEqual({ applied: true });
  }, 60_000);

  it("決議寫進去的 snapshot 會 fork 成專案本地 id，風格庫換版也蓋不掉", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * 這是整條路上最容易靜默失效的地方。`refreshStyleForGeneration()` 每次生成前都拿
     * `styles.get(styleSnapshot.id)` 比對版本，不同就 `structuredClone(latest)` 整包蓋掉。
     * 只寫 designSystem 欄位而不 fork 的話，擋著的只是「兩邊版本號剛好相同」這個巧合——
     * 使用者到風格庫改一次 avoid 就 version+1，下一次生成這份設計系統就消失，而
     * `styleDirection` 還寫著 `applied: true`，前端一個字都不會說；那時 `POST /outline`
     * 已被 `OUTLINE_HAS_GENERATED_VERSIONS` 擋住，沒有復原路徑。
     *
     * 必須用**非系統風格**（複製出來的那種）才測得到：系統風格改不動
     * （`SYSTEM_STYLE_READ_ONLY`），版本永遠停在 1，兩邊也就永遠相同。
     */
    const copied = await fetch(`${baseUrl}/api/styles/ai-free-design/duplicate`, {
      method: "POST",
    });
    expect(copied.status).toBeLessThan(400);
    const style = (await copied.json()) as { id: string; version: number; designSystem: string };
    // 複製出來的風格正好是決議會開火的形狀：無參考圖、無設計系統。
    expect(style.designSystem).toBe("");

    const project = await createProject();
    const applied = await fetch(`${baseUrl}/api/projects/${project.id}/style`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ styleId: style.id }),
    });
    expect(applied.status).toBeLessThan(400);

    stubText({ onDirection: () => STYLE_DIRECTION_REPLY });
    const { body: outlined } = await generateOutline(project.id);
    expect(outlined.styleSnapshot.designSystem).not.toBe("");
    expect(outlined.styleSnapshot.id).toBe(`pdf-style-${project.id}`);
    expect(outlined.styleSnapshot.system).toBe(false);

    // 使用者到風格庫改一下這個風格 → version 往前走。
    const bumped = await fetch(`${baseUrl}/api/styles/${style.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avoid: ["漸層", "陰影"] }),
    });
    expect(bumped.status).toBeLessThan(400);
    expect(((await bumped.json()) as { version: number }).version).toBeGreaterThan(style.version);

    const generate = await fetch(`${baseUrl}/api/projects/${project.id}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "mock-image", acceptUnknownReadiness: true }),
    });
    expect(generate.status).toBeLessThan(400);
    const after = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}`)
    ).json()) as PresentationProject;
    expect(after.styleSnapshot.designSystem).toBe(outlined.styleSnapshot.designSystem);
  }, 60_000);

  it("已經有設計系統的專案一次模型都不叫，那份設計系統原封不動", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject();
    // 參考圖分析出來的（或使用者自己寫的）設計系統：覆蓋它是不可逆的破壞，而且使用者
    // 不會知道發生了什麼——他只會看到自己分析出來的視覺語言突然變了。
    const analysed = "## 色票\n- #F7F5F0 — 內頁畫布底色";
    const patched = await fetch(`${baseUrl}/api/projects/${project.id}/style-snapshot`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ designSystem: analysed }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as PresentationProject).styleSnapshot.designSystem).toBe(
      analysed,
    );
    let directionCalls = 0;
    stubText({
      onDirection: () => {
        directionCalls += 1;
        return STYLE_DIRECTION_REPLY;
      },
    });
    const { body } = await generateOutline(project.id);
    // 一次都不叫，不只是「叫了但沒覆蓋」：這一步會燒配額，而它對這個專案毫無用處。
    expect(directionCalls).toBe(0);
    expect(body.styleDirection).toBeUndefined();
    expect(body.styleSnapshot.designSystem).toBe(analysed);
  });
});

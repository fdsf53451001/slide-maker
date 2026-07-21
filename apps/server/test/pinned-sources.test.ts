import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { strToU8, unzipSync, zipSync } from "fflate";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

/**
 * 使用者在單頁指定的來源（pinnedSourceIds）：模型只能加，不能減。
 *
 * 這裡用假的 OpenAI-compatible 端點驅動單頁大綱重生成，才控制得住「模型回傳了什麼」——
 * 這正是「模型不得覆蓋使用者勾選」要驗的東西。
 */
describe("使用者指定來源優先於模型選擇", () => {
  let appServer: Server | undefined;
  let fake: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";
  let unavailable = false;
  const savedEnv: Record<string, string | undefined> = {};
  /** 假模型下一次要回傳的 sourceIds，讓每個案例各自決定模型的行為。 */
  let modelSourceIds: string[] = [];
  /** 最後一次收到的單頁重生成 prompt，用來檢查指定的來源真的進了 prompt。 */
  let lastSlidePrompt = "";
  /**
   * 擋住假模型回覆的閘門，用來重現「模型還在想、使用者同時動了指定」的併發時序。
   * 預設不擋，只有需要的案例才設。
   */
  let slideGate: Promise<void> | undefined;
  /** 假模型收到單頁 prompt 時通知測試，讓測試知道「模型已經開始想了」。 */
  let announceSlidePrompt: (() => void) | undefined;

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    fake = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (part: Buffer) => chunks.push(part));
      request.on("end", () => {
        void (async () => {
          response.writeHead(200, { "content-type": "application/json" });
          if ((request.url ?? "").endsWith("/models"))
            return response.end(JSON.stringify({ data: [] }));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            messages?: Array<{ content?: unknown }>;
            response_format?: {
              json_schema?: { schema?: { properties?: Record<string, unknown> } };
            };
          };
          const properties = body.response_format?.json_schema?.schema?.properties ?? {};
          const isSingleSlide = "sourceIds" in properties && !("slides" in properties);
          if (isSingleSlide) {
            // 攤平成純文字：content 是 part 陣列時直接 JSON.stringify 會把內層引號跳脫掉，
            // 斷言就只能比對 \" 這種難讀又脆弱的字串。
            lastSlidePrompt = (body.messages ?? [])
              .map((message) => {
                if (typeof message.content === "string") return message.content;
                if (Array.isArray(message.content))
                  return message.content
                    .map((part: unknown) =>
                      typeof part === "object" && part && "text" in part
                        ? String((part as { text: unknown }).text)
                        : JSON.stringify(part),
                    )
                    .join("\n");
                return JSON.stringify(message.content);
              })
              .join("\n");
            announceSlidePrompt?.();
            if (slideGate) await slideGate;
          }
          response.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      content: "重寫後的內容。",
                      narrative: "重寫後的敘事。",
                      layoutHint: "單欄",
                      sourceIds: modelSourceIds,
                    }),
                  },
                },
              ],
            }),
          );
        })();
      });
    });
    await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", resolve));

    setEnv(
      "SLIDE_MAKER_OPENAI_BASE_URL",
      `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
    );
    setEnv("SLIDE_MAKER_OPENAI_API_KEY", "test-key");
    setEnv("SLIDE_MAKER_OPENAI_TEXT_MODEL", "gpt-5");
    setEnv("SLIDE_MAKER_TEXT_ENGINE", "openai");

    dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-pinned-")), ".slide-maker-data");
    const app = await createApp(dataRoot);
    try {
      await new Promise<void>((resolve, reject) => {
        appServer = app.listen(0, "127.0.0.1", (error?: Error) =>
          error ? reject(error) : resolve(),
        );
      });
      baseUrl = `http://127.0.0.1:${(appServer!.address() as AddressInfo).port}`;
    } catch (error) {
      if (["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
        unavailable = true;
      else throw error;
    }
  });

  afterAll(async () => {
    if (appServer?.listening)
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    if (fake?.listening) await new Promise<void>((resolve) => fake!.close(() => resolve()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }

  async function addSource(projectId: string, name: string, text: string): Promise<string> {
    const query = new URLSearchParams({
      name,
      mediaType: "text/markdown",
      usage: "content",
      allowModelAccess: "true",
    });
    const project = await json<PresentationProject>(
      `/api/projects/${projectId}/sources?${query.toString()}`,
      { method: "POST", headers: { "content-type": "text/markdown" }, body: text },
    );
    const created = project.sources.find((source) => source.name === name);
    if (!created) throw new Error(`來源未建立：${name}`);
    return created.id;
  }

  async function newProject(topic: string): Promise<PresentationProject> {
    return json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, brief: { desiredSlideCount: 1 } }),
    });
  }

  async function patchSlide(
    projectId: string,
    slideId: string,
    patch: Record<string, unknown>,
  ): Promise<PresentationProject> {
    return json<PresentationProject>(`/api/projects/${projectId}/slides/${slideId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  it("重生成大綱時把指定的來源與模型挑的來源聯集，模型覆蓋不了使用者的指定", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("指定來源合併");
    const slideId = project.slides[0]!.id;
    const pinnedId = await addSource(project.id, "電動車年報.md", "台灣電動車市場銷量分析全文。");
    const otherId = await addSource(project.id, "電池成本報告.md", "磷酸鐵鋰電池每度成本趨勢。");

    await patchSlide(project.id, slideId, {
      sourceIds: [pinnedId],
      pinnedSourceIds: [pinnedId],
    });

    // 模型完全不提使用者指定的那份，只回傳另一份。
    modelSourceIds = [otherId];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    const slide = regenerated.slides[0]!;
    expect(slide.content).toBe("重寫後的內容。");
    expect([...slide.sourceIds].sort()).toEqual([pinnedId, otherId].sort());
    expect(slide.pinnedSourceIds).toEqual([pinnedId]);
    // 指定的來源要真的進 prompt，否則模型只是被事後掛上一個它沒讀過的 id。
    expect(lastSlidePrompt).toContain(pinnedId);
    expect(lastSlidePrompt).toContain("台灣電動車市場銷量分析全文。");
  });

  it("模型只回傳幻覺 id 時濾掉它並退回實際進 prompt 的來源，指定的來源照樣留著", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("模型回傳空值");
    const slideId = project.slides[0]!.id;
    const pinnedId = await addSource(project.id, "充電樁調查.md", "全台充電樁佈建數量與分布。");
    const otherId = await addSource(project.id, "政策白皮書.md", "電動車補助政策的沿革。");
    await patchSlide(project.id, slideId, {
      sourceIds: [pinnedId],
      pinnedSourceIds: [pinnedId],
    });

    // 格式合法但不屬於這個專案的 id：模型幻覺出來的引用要被濾掉。
    modelSourceIds = ["11111111-2222-3333-4444-555555555555"];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    const slide = regenerated.slides[0]!;
    expect(slide.sourceIds).toContain(pinnedId);
    expect(slide.sourceIds).toContain(otherId);
    expect(slide.sourceIds).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(slide.pinnedSourceIds).toEqual([pinnedId]);
  });

  it("沒有指定任何來源時完全由模型決定，不會被硬塞來源", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("全交給模型");
    const slideId = project.slides[0]!.id;
    const first = await addSource(project.id, "來源甲.md", "台灣電動車市場銷量分析。");
    const second = await addSource(project.id, "來源乙.md", "磷酸鐵鋰電池成本。");

    modelSourceIds = [second];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    const slide = regenerated.slides[0]!;
    expect(slide.sourceIds).toEqual([second]);
    expect(slide.sourceIds).not.toContain(first);
    expect(slide.pinnedSourceIds).toEqual([]);
    // 沒有指定來源時，prompt 裡連 pinnedSourceIds 這個字都不該出現：從沒用過這個功能的
    // 專案，送進模型的內容必須與加入功能前逐字元相同。
    expect(lastSlidePrompt).not.toContain("pinnedSourceIds");
  });

  it("取消使用一份來源時連同指定一起移除，不留下無法操作的幽靈指定", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("取消指定");
    const slideId = project.slides[0]!.id;
    const pinnedId = await addSource(project.id, "年報.md", "台灣電動車市場銷量分析。");
    const otherId = await addSource(project.id, "報告.md", "磷酸鐵鋰電池成本。");
    await patchSlide(project.id, slideId, {
      sourceIds: [pinnedId, otherId],
      pinnedSourceIds: [pinnedId],
    });

    // 只把 sourceIds 改成不含 pinnedId（前端取消指定時的寫法），指定清單要一起收斂。
    const updated = await patchSlide(project.id, slideId, { sourceIds: [otherId] });
    expect(updated.slides[0]?.sourceIds).toEqual([otherId]);
    expect(updated.slides[0]?.pinnedSourceIds).toEqual([]);
  });

  it("同一次 PATCH 送進不在使用清單裡的指定時，伺服器把它夾掉而不是原封存起來", async (context) => {
    if (unavailable) return context.skip();
    // pinnedSourceIds ⊆ sourceIds 是伺服器要守住的不變式，不能只靠前端自律。
    // 存下越界的指定，UI 上就會出現一個看不到、點不掉，卻仍在下次重生成搶名額的幽靈。
    const project = await newProject("越界的指定");
    const slideId = project.slides[0]!.id;
    const usedId = await addSource(project.id, "有用到.md", "台灣電動車市場銷量分析。");
    const unusedId = await addSource(project.id, "沒用到.md", "磷酸鐵鋰電池成本。");

    const updated = await patchSlide(project.id, slideId, {
      sourceIds: [usedId],
      pinnedSourceIds: [usedId, unusedId],
    });

    expect(updated.slides[0]?.sourceIds).toEqual([usedId]);
    expect(updated.slides[0]?.pinnedSourceIds).toEqual([usedId]);
  });

  it("刪除來源時一併清掉頁面的指定，不會留下指向已刪來源的 id", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("刪除來源");
    const slideId = project.slides[0]!.id;
    const pinnedId = await addSource(project.id, "待刪來源.md", "台灣電動車市場銷量分析。");
    await patchSlide(project.id, slideId, {
      sourceIds: [pinnedId],
      pinnedSourceIds: [pinnedId],
    });

    const afterDelete = await json<PresentationProject>(
      `/api/projects/${project.id}/sources/${pinnedId}?force=true`,
      { method: "DELETE" },
    );
    expect(afterDelete.sources).toHaveLength(0);
    expect(afterDelete.slides[0]?.sourceIds).toEqual([]);
    expect(afterDelete.slides[0]?.pinnedSourceIds).toEqual([]);
  });

  it("載入加入這個欄位之前存下的專案檔：補成空陣列，行為等同全交給模型", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("舊專案檔");
    const slideId = project.slides[0]!.id;
    const sourceId = await addSource(project.id, "舊來源.md", "台灣電動車市場銷量分析。");
    await patchSlide(project.id, slideId, { sourceIds: [sourceId], pinnedSourceIds: [sourceId] });

    // 把 pinnedSourceIds 從磁碟上的專案檔整個拿掉，模擬升級前寫下的資料。
    const path = join(dataRoot, "projects", project.id, "project.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      slides: Array<Record<string, unknown>>;
    };
    for (const slide of stored.slides) delete slide.pinnedSourceIds;
    expect(stored.slides.every((slide) => !("pinnedSourceIds" in slide))).toBe(true);
    await writeFile(path, JSON.stringify(stored), "utf8");

    const loaded = await json<PresentationProject>(`/api/projects/${project.id}`);
    expect(loaded.slides[0]?.pinnedSourceIds).toEqual([]);
    expect(loaded.slides[0]?.sourceIds).toEqual([sourceId]);

    // 沒有指定＝模型說了算，這正是加入欄位前的行為。
    modelSourceIds = [];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(regenerated.slides[0]?.pinnedSourceIds).toEqual([]);
    expect(lastSlidePrompt).not.toContain("pinnedSourceIds");
  });

  it("指定的來源會連同「必須採用」的指令一起送進模型，而不是只在事後被伺服器補進 sourceIds", async (context) => {
    if (unavailable) return context.skip();
    // 只在回寫時做聯集的話，這一頁會掛著一個模型從沒被要求採用的來源：id 有了，
    // 內容卻與它無關。使用者看到的是「我指定的來源被引用了」，實際上是假的引用。
    const project = await newProject("指定要進 prompt");
    const slideId = project.slides[0]!.id;
    const pinnedId = await addSource(project.id, "年報.md", "台灣電動車市場銷量分析。");
    await addSource(project.id, "報告.md", "磷酸鐵鋰電池成本。");
    await patchSlide(project.id, slideId, {
      sourceIds: [pinnedId],
      pinnedSourceIds: [pinnedId],
    });

    modelSourceIds = [pinnedId];
    await json<PresentationProject>(`/api/projects/${project.id}/slides/${slideId}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // 指令本身要在，模型才知道這幾份是硬性要求而不是一般候選。
    expect(lastSlidePrompt).toContain("pinnedSourceIds lists sources");
    // 而且要真的告訴模型「是哪幾份」：光有指令、payload 卻是空的一樣沒有用。
    expect(lastSlidePrompt).toContain(`"pinnedSourceIds":["${pinnedId}"]`);
  });

  it("模型思考期間新增的指定不會被這次回寫吃掉", async (context) => {
    if (unavailable) return context.skip();
    // 重生成大綱是長時間的請求，使用者常常一邊等一邊繼續勾來源。若回寫時用的是發問前
    // 讀到的舊指定清單，這段期間的勾選就會在使用者眼前默默消失，而且沒有任何錯誤提示。
    const project = await newProject("併發新增指定");
    const slideId = project.slides[0]!.id;
    const lateId = await addSource(project.id, "遲到指定.md", "台灣電動車市場銷量分析。");
    const modelPick = await addSource(project.id, "模型選的.md", "磷酸鐵鋰電池成本。");

    const promptArrived = new Promise<void>((resolve) => {
      announceSlidePrompt = resolve;
    });
    let release = () => {};
    slideGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    modelSourceIds = [modelPick];

    try {
      const outlineDone = json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/outline`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      await promptArrived;
      // 模型還在想的時候，使用者指定了一份新的來源。
      await patchSlide(project.id, slideId, {
        sourceIds: [lateId],
        pinnedSourceIds: [lateId],
      });
      release();
      const regenerated = await outlineDone;

      const slide = regenerated.slides[0]!;
      expect(slide.pinnedSourceIds).toEqual([lateId]);
      expect(slide.sourceIds).toContain(lateId);
      expect(slide.sourceIds).toContain(modelPick);
    } finally {
      slideGate = undefined;
      announceSlidePrompt = undefined;
    }
  });

  it("指定的來源被改成不給模型讀之後重生成，指定會跟著收斂而不是變成幽靈", async (context) => {
    if (unavailable) return context.skip();
    // 來源不必被刪除也會離開可用範圍：改成「不允許模型存取」或「不參與生成」都會讓它
    // 從 sourceIds 消失。指定清單沒跟著收，就會留下一個既不在使用清單、UI 也點不掉的指定。
    const project = await newProject("指定來源被停用");
    const slideId = project.slides[0]!.id;
    const revokedId = await addSource(project.id, "待停用.md", "台灣電動車市場銷量分析。");
    const otherId = await addSource(project.id, "仍可用.md", "磷酸鐵鋰電池成本。");
    await patchSlide(project.id, slideId, {
      sourceIds: [revokedId, otherId],
      pinnedSourceIds: [revokedId],
    });

    await json<PresentationProject>(`/api/projects/${project.id}/sources/${revokedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowModelAccess: false }),
    });

    modelSourceIds = [otherId];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    const slide = regenerated.slides[0]!;
    expect(slide.sourceIds).not.toContain(revokedId);
    expect(slide.pinnedSourceIds).toEqual([]);
  });

  it("指定的份數超過模型回覆上限時仍然成功，不會變成看不懂的 500", async (context) => {
    if (unavailable) return context.skip();
    // 模型回覆的 sourceIds 硬性上限是 20。指定 22 份時，若 prompt 要求「全部都要回」，
    // 非嚴格 gateway 會照做（CLAUDE.md：Gemini 系 translator 不遵守 json_schema），
    // 回覆驗證失敗後三次重試都失敗，使用者只會拿到 500，也無從得知少指定幾份就能解決。
    const project = await newProject("指定超過上限");
    const slideId = project.slides[0]!.id;
    const pinnedIds: string[] = [];
    for (let index = 0; index < 22; index += 1)
      pinnedIds.push(
        await addSource(project.id, `指定來源 ${index}.md`, `台灣電動車市場第 ${index} 份`),
      );
    const extraId = await addSource(project.id, "模型自己找的.md", "磷酸鐵鋰電池成本。");
    await patchSlide(project.id, slideId, {
      sourceIds: pinnedIds,
      pinnedSourceIds: pinnedIds,
    });

    // 模型照著「指定的都要回」回傳 23 個，超過 schema 的 20 個上限。
    modelSourceIds = [...pinnedIds, extraId];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    const slide = regenerated.slides[0]!;
    expect(slide.content).toBe("重寫後的內容。");
    // 22 份指定一份都不能少：上限是用來擋模型挑進來的來源，不是用來砍使用者的選擇。
    for (const pinnedId of pinnedIds) expect(slide.pinnedSourceIds).toContain(pinnedId);
    expect(slide.sourceIds).toEqual(expect.arrayContaining(pinnedIds));
    // 指令也不能再要求「全部都要回」，否則模型每次都會撞上限。
    expect(lastSlidePrompt).not.toContain("include every one of them");
  });

  it("指定超過上限又碰上模型另挑別的來源時，被上限砍掉的是模型挑的那些", async (context) => {
    if (unavailable) return context.skip();
    // 上面那個案例裡模型回的正好是使用者指定的那些，所以聯集怎麼排都不會少人。
    // 真正問得出順序的是「指定 21 份、模型另外挑了 3 份沒指定的」：聯集有 24 個，
    // 上限 max(20, 21) = 21，一定得砍 3 個。指定排在前面才會砍到模型挑的那 3 個；
    // 反過來排就會砍掉 3 份使用者親手指定的來源，而且畫面上不會有任何說明。
    const project = await newProject("指定與模型搶名額");
    const slideId = project.slides[0]!.id;
    const pinnedIds: string[] = [];
    for (let index = 0; index < 21; index += 1)
      pinnedIds.push(
        await addSource(project.id, `指定來源 ${index}.md`, `台灣電動車市場第 ${index} 份`),
      );
    const modelPicks: string[] = [];
    for (let index = 0; index < 3; index += 1)
      modelPicks.push(
        await addSource(project.id, `模型挑的 ${index}.md`, `磷酸鐵鋰電池成本第 ${index} 份`),
      );
    await patchSlide(project.id, slideId, {
      sourceIds: pinnedIds,
      pinnedSourceIds: pinnedIds,
    });

    modelSourceIds = [...modelPicks];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    const slide = regenerated.slides[0]!;
    // 21 份指定全數存活，一份都沒被模型的選擇擠掉。
    expect([...slide.pinnedSourceIds].sort()).toEqual([...pinnedIds].sort());
    expect(slide.sourceIds).toEqual(expect.arrayContaining(pinnedIds));
    expect(slide.sourceIds).toHaveLength(21);
  });

  it("模型回傳剛好多一個時精準截到上限：第 20 個留下、第 21 個丟掉，且不會變成 500", async (context) => {
    if (unavailable) return context.skip();
    // 截斷的邊界只有在「剛好超出 1 個」時才問得出來。上面那個 22 份指定的案例問不到：
    // 那些 id 本來就會經由指定清單回到 sourceIds，截多截少都看不出差別。
    // 這裡完全不指定，模型回傳的 21 個 id 就是唯一的來源，截到 19 或 21 都會被抓到——
    // 截到 21 會讓 `.max(20)` 直接 throw（使用者拿到 500），截到 19 會無聲少掉一份引用。
    const project = await newProject("剛好多一個");
    const slideId = project.slides[0]!.id;
    const sourceIds: string[] = [];
    for (let index = 0; index < 21; index += 1)
      sourceIds.push(
        await addSource(project.id, `候選來源 ${index}.md`, `台灣電動車市場第 ${index} 份`),
      );

    modelSourceIds = [...sourceIds];
    const regenerated = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${slideId}/outline`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    const slide = regenerated.slides[0]!;
    expect(slide.content).toBe("重寫後的內容。");
    // 前 20 個原封留下（含第 20 個），第 21 個被丟掉。
    expect(slide.sourceIds).toEqual(sourceIds.slice(0, 20));
    expect(slide.sourceIds).not.toContain(sourceIds[20]);
    expect(slide.pinnedSourceIds).toEqual([]);
  });

  it("執行期間取消指定後又重新指定，等於從沒取消過", async (context) => {
    if (unavailable) return context.skip();
    // 撤銷是拿「開始時的指定」減「結束時的指定」算出來的，不是把每一次點擊都記成事件。
    // 使用者在等待期間反覆點同一個晶片是很常見的，只要最後停在「有指定」，這一份就該留著；
    // 若改成記錄事件（點過取消就永久排除），這個序列會讓來源在使用者眼前莫名消失。
    const project = await newProject("取消後又重新指定");
    const slideId = project.slides[0]!.id;
    const flakyId = await addSource(project.id, "反覆點的.md", "台灣電動車市場銷量分析。");
    const keptId = await addSource(project.id, "沒動過的.md", "磷酸鐵鋰電池成本。");
    await patchSlide(project.id, slideId, {
      sourceIds: [flakyId, keptId],
      pinnedSourceIds: [flakyId],
    });

    const promptArrived = new Promise<void>((resolve) => {
      announceSlidePrompt = resolve;
    });
    let release = () => {};
    slideGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    modelSourceIds = [flakyId, keptId];

    try {
      const outlineDone = json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/outline`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      await promptArrived;
      // 先取消……
      await patchSlide(project.id, slideId, { sourceIds: [keptId], pinnedSourceIds: [] });
      // ……又反悔，重新指定回去。
      await patchSlide(project.id, slideId, {
        sourceIds: [keptId, flakyId],
        pinnedSourceIds: [flakyId],
      });
      release();
      const regenerated = await outlineDone;

      const slide = regenerated.slides[0]!;
      expect(slide.pinnedSourceIds).toEqual([flakyId]);
      expect(slide.sourceIds).toContain(flakyId);
      expect(slide.sourceIds).toContain(keptId);
    } finally {
      slideGate = undefined;
      announceSlidePrompt = undefined;
    }
  });

  it("重生成期間取消的指定不會被模型的選擇復活", async (context) => {
    if (unavailable) return context.skip();
    // 模型正是被那份指定誘導才選它的。若使用者在執行期間取消指定（晶片轉灰、PATCH 也寫進去了），
    // 回寫時卻把模型的選擇整批蓋上去，那份來源就會以「AI 選用」復活——使用者明確的「我不要」
    // 被一個由他自己先前的指定所導致的結果推翻，而且沒有任何提示。
    const project = await newProject("併發取消指定");
    const slideId = project.slides[0]!.id;
    const revokedId = await addSource(project.id, "反悔的指定.md", "台灣電動車市場銷量分析。");
    const keptId = await addSource(project.id, "留著的來源.md", "磷酸鐵鋰電池成本。");
    await patchSlide(project.id, slideId, {
      sourceIds: [revokedId, keptId],
      pinnedSourceIds: [revokedId],
    });

    const promptArrived = new Promise<void>((resolve) => {
      announceSlidePrompt = resolve;
    });
    let release = () => {};
    slideGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 模型兩份都選（它看到的 prompt 裡 revokedId 還是指定的）。
    modelSourceIds = [revokedId, keptId];

    try {
      const outlineDone = json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/outline`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      await promptArrived;
      // 模型還在想的時候，使用者按掉了那份指定（前端會同時移出兩份清單）。
      await patchSlide(project.id, slideId, {
        sourceIds: [keptId],
        pinnedSourceIds: [],
      });
      release();
      const regenerated = await outlineDone;

      const slide = regenerated.slides[0]!;
      expect(slide.pinnedSourceIds).toEqual([]);
      expect(slide.sourceIds).not.toContain(revokedId);
      // 沒被取消的來源照常留下，取消的效果只針對那一份。
      expect(slide.sourceIds).toContain(keptId);
    } finally {
      slideGate = undefined;
      announceSlidePrompt = undefined;
    }
  });

  it("匯入手改過的專案檔時，越界的指定在解析層就被夾掉", async (context) => {
    if (unavailable) return context.skip();
    // 不變式若只寫在各個 API 端點，匯入就繞得過去：`presentationProjectSchema` 本身
    // 不檢查跨欄位關係的話，手改過的 project.json 會匯入出一個 UI 點不到、卻仍會吃掉
    // 檢索名額並在下次重生成被強制併入 sourceIds 的幽靈指定。
    const project = await newProject("匯入越界指定");
    const slideId = project.slides[0]!.id;
    const usedId = await addSource(project.id, "有用到.md", "台灣電動車市場銷量分析。");
    const ghostId = await addSource(project.id, "沒用到.md", "磷酸鐵鋰電池成本。");
    await patchSlide(project.id, slideId, { sourceIds: [usedId, ghostId], pinnedSourceIds: [] });

    const exported = await fetch(`${baseUrl}/api/projects/${project.id}/export/slide-project`);
    expect(exported.status).toBe(200);
    const files = unzipSync(new Uint8Array(await exported.arrayBuffer()));
    const stored = JSON.parse(Buffer.from(files["project.json"]!).toString("utf8")) as {
      slides: Array<{ sourceIds: string[]; pinnedSourceIds: string[] }>;
    };
    // 手動竄改：指定一份不在使用清單裡的來源。
    stored.slides[0]!.sourceIds = [usedId];
    stored.slides[0]!.pinnedSourceIds = [usedId, ghostId];
    files["project.json"] = strToU8(JSON.stringify(stored));

    const imported = await fetch(`${baseUrl}/api/projects/import`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zipSync(files),
    });
    expect(imported.status).toBe(201);
    const body = (await imported.json()) as PresentationProject;
    expect(body.slides[0]?.sourceIds).toEqual([usedId]);
    expect(body.slides[0]?.pinnedSourceIds).toEqual([usedId]);

    // 重新讀一次：磁碟上存的也必須是夾過的版本，而不是只有回應好看。
    const reloaded = await json<PresentationProject>(`/api/projects/${body.id}`);
    expect(reloaded.slides[0]?.pinnedSourceIds).toEqual([usedId]);
  });

  describe("版本還原與啟用", () => {
    /**
     * 產生一個帶 outlineSnapshot 的版本：還原／啟用只有在有快照時才會覆寫大綱欄位，
     * 也只有那條路徑才需要重新夾指定清單。
     */
    async function generateVersion(projectId: string, slideId: string): Promise<string> {
      const queued = await json<{ id: string }>(
        `/api/projects/${projectId}/slides/${slideId}/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "mock-image" }),
        },
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const loaded = await json<PresentationProject>(`/api/projects/${projectId}`);
        const job = loaded.jobs.find((candidate) => candidate.id === queued.id);
        if (job?.status === "completed") {
          const version = loaded.slides.find((slide) => slide.id === slideId)?.versions.at(-1);
          if (!version?.outlineSnapshot) throw new Error("版本沒有 outlineSnapshot");
          return version.id;
        }
        if (job?.status === "failed") throw new Error("生成失敗");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("生成逾時");
    }

    it("還原舊版本後，當時沒用到的來源不會還掛著「我指定」", async (context) => {
      if (unavailable) return context.skip();
      // 快照只記 sourceIds，還原會把 sourceIds 換成當時的清單並宣告 outlineDirty=false。
      // 指定清單沒一起收，這一頁就會宣稱「與圖同步」，卻標示著一份圖裡根本沒有的來源。
      const project = await newProject("還原後的指定");
      const slideId = project.slides[0]!.id;
      const oldId = await addSource(project.id, "舊來源.md", "台灣電動車市場銷量分析。");
      const laterId = await addSource(project.id, "後加來源.md", "磷酸鐵鋰電池成本。");
      await patchSlide(project.id, slideId, { sourceIds: [oldId], pinnedSourceIds: [] });
      const versionId = await generateVersion(project.id, slideId);

      // 生成之後才指定了一份新來源。
      await patchSlide(project.id, slideId, {
        sourceIds: [oldId, laterId],
        pinnedSourceIds: [laterId],
      });

      const restored = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${versionId}/restore`,
        { method: "POST" },
      );
      const slide = restored.slides[0]!;
      expect(slide.sourceIds).toEqual([oldId]);
      expect(slide.outlineDirty).toBe(false);
      expect(slide.pinnedSourceIds).toEqual([]);
    });

    it("啟用舊版本後同樣收斂指定，兩條版本路徑不能只修一條", async (context) => {
      if (unavailable) return context.skip();
      const project = await newProject("啟用後的指定");
      const slideId = project.slides[0]!.id;
      const oldId = await addSource(project.id, "初版來源.md", "台灣電動車市場銷量分析。");
      const laterId = await addSource(project.id, "後加來源.md", "磷酸鐵鋰電池成本。");
      await patchSlide(project.id, slideId, { sourceIds: [oldId], pinnedSourceIds: [] });
      const versionId = await generateVersion(project.id, slideId);

      await patchSlide(project.id, slideId, {
        sourceIds: [oldId, laterId],
        pinnedSourceIds: [laterId],
      });
      // 產生第二個版本，第一個版本才不會是「目前版本」，activate 才有東西可切換。
      await generateVersion(project.id, slideId);

      const activated = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${versionId}/activate`,
        { method: "POST" },
      );
      const slide = activated.slides[0]!;
      expect(slide.currentVersionId).toBe(versionId);
      expect(slide.sourceIds).toEqual([oldId]);
      expect(slide.pinnedSourceIds).toEqual([]);
    });

    it("還原後保留仍在使用清單裡的指定，收斂不能變成一律清空", async (context) => {
      if (unavailable) return context.skip();
      // 上面兩個案例只證明「不該留的有被清掉」；沒有這一個，把 clamp 寫成無條件清空
      // 也一樣會通過，使用者的指定會在每次還原版本時無聲蒸發。
      const project = await newProject("還原保留指定");
      const slideId = project.slides[0]!.id;
      const keptId = await addSource(project.id, "一直在用.md", "台灣電動車市場銷量分析。");
      await patchSlide(project.id, slideId, {
        sourceIds: [keptId],
        pinnedSourceIds: [keptId],
      });
      const versionId = await generateVersion(project.id, slideId);

      const restored = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${versionId}/restore`,
        { method: "POST" },
      );
      expect(restored.slides[0]?.sourceIds).toEqual([keptId]);
      expect(restored.slides[0]?.pinnedSourceIds).toEqual([keptId]);
    });

    it("還原丟掉的指定可以再還原回來：每一版都記著自己當時生效的指定", async (context) => {
      if (unavailable) return context.skip();
      // 「指定 X → 重生成 → 生成圖片 → 覺得不好看 → 還原上一版」是很日常的路徑。
      // 版本若只記 sourceIds，X 的指定會在還原時消失，而且沒有任何地方記得它曾被指定——
      // 那是不可逆且無聲的。指定存在版本上就只是換一組，切回新版即可原封拿回來。
      const project = await newProject("還原可逆");
      const slideId = project.slides[0]!.id;
      const baseId = await addSource(project.id, "一開始就有.md", "台灣電動車市場銷量分析。");
      const pinnedId = await addSource(project.id, "後來指定的.md", "磷酸鐵鋰電池成本。");
      await patchSlide(project.id, slideId, { sourceIds: [baseId], pinnedSourceIds: [] });
      const beforePin = await generateVersion(project.id, slideId);

      // 指定 X，然後再生成一版。
      await patchSlide(project.id, slideId, {
        sourceIds: [baseId, pinnedId],
        pinnedSourceIds: [pinnedId],
      });
      const afterPin = await generateVersion(project.id, slideId);

      // 還原到指定之前那一版：當時沒有指定，所以指定清單跟著回到空的。
      const rolledBack = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${beforePin}/restore`,
        { method: "POST" },
      );
      expect(rolledBack.slides[0]?.sourceIds).toEqual([baseId]);
      expect(rolledBack.slides[0]?.pinnedSourceIds).toEqual([]);

      // 反悔了：切回有指定的那一版，指定要原封回來，而不是永久蒸發。
      const rolledForward = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${afterPin}/restore`,
        { method: "POST" },
      );
      expect(rolledForward.slides[0]?.sourceIds).toEqual([baseId, pinnedId]);
      expect(rolledForward.slides[0]?.pinnedSourceIds).toEqual([pinnedId]);
    });

    it("啟用舊版本時把那一版的指定原封帶回來，不是靠不變式夾成空的", async (context) => {
      if (unavailable) return context.skip();
      // 上面那個「啟用後同樣收斂指定」只證明了不該留的有被清掉，但那個結果光靠
      // `pinnedSourceIds ⊆ sourceIds` 的 transform 就會發生——activate 根本不還原指定
      // 也一樣會通過。要問出 activate 有沒有真的讀版本上的指定，得讓「當時有指定、
      // 現在沒有」：切回去之後指定必須回來，而不是停留在現在的空清單。
      const project = await newProject("啟用取回指定");
      const slideId = project.slides[0]!.id;
      const baseId = await addSource(project.id, "一開始就有.md", "台灣電動車市場銷量分析。");
      const pinnedId = await addSource(project.id, "當時指定的.md", "磷酸鐵鋰電池成本。");
      await patchSlide(project.id, slideId, { sourceIds: [baseId], pinnedSourceIds: [] });
      const beforePin = await generateVersion(project.id, slideId);

      await patchSlide(project.id, slideId, {
        sourceIds: [baseId, pinnedId],
        pinnedSourceIds: [pinnedId],
      });
      const afterPin = await generateVersion(project.id, slideId);

      // 先切到沒有指定的那一版，讓「現在的指定」變成空的。
      const back = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${beforePin}/activate`,
        { method: "POST" },
      );
      expect(back.slides[0]?.pinnedSourceIds).toEqual([]);

      // 再切回有指定的那一版：指定要從版本上取回來。
      const forward = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${afterPin}/activate`,
        { method: "POST" },
      );
      expect(forward.slides[0]?.currentVersionId).toBe(afterPin);
      expect(forward.slides[0]?.sourceIds).toEqual([baseId, pinnedId]);
      expect(forward.slides[0]?.pinnedSourceIds).toEqual([pinnedId]);
    });

    it("版本記錄上越界的指定，還原時的回應也要夾過，不能只有磁碟乾淨", async (context) => {
      if (unavailable) return context.skip();
      // 版本層的 pinnedSourceIds 沒有任何 transform 管它——不變式只夾頁面的那一份。
      // 手改過或匯入的專案檔可以讓某一版帶著「不在自己快照 sourceIds 裡」的指定，
      // 還原時若直接把它塞回頁面再原封回傳，前端就會拿到一個磁碟上並不存在的狀態：
      // 晶片顯示「我指定」，重新整理後卻消失，使用者無從理解剛才看到的是什麼。
      const project = await newProject("還原夾越界指定");
      const slideId = project.slides[0]!.id;
      const usedId = await addSource(project.id, "當時用的.md", "台灣電動車市場銷量分析。");
      const ghostId = await addSource(project.id, "當時沒用的.md", "磷酸鐵鋰電池成本。");
      await patchSlide(project.id, slideId, { sourceIds: [usedId], pinnedSourceIds: [] });
      const versionId = await generateVersion(project.id, slideId);

      // 手動竄改：讓這一版記著一個它自己的快照裡沒有的指定。
      const path = join(dataRoot, "projects", project.id, "project.json");
      const stored = JSON.parse(await readFile(path, "utf8")) as {
        slides: Array<{ versions: Array<Record<string, unknown>> }>;
      };
      const target = stored.slides[0]!.versions.find((version) => version.id === versionId)!;
      target.pinnedSourceIds = [ghostId];
      expect((target.outlineSnapshot as { sourceIds: string[] }).sourceIds).toEqual([usedId]);
      await writeFile(path, JSON.stringify(stored), "utf8");

      const restored = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${versionId}/restore`,
        { method: "POST" },
      );
      expect(restored.slides[0]?.sourceIds).toEqual([usedId]);
      expect(restored.slides[0]?.pinnedSourceIds).toEqual([]);
      // 回應與磁碟必須是同一份，不能只有重新讀取才看得到夾過的結果。
      const reloaded = await json<PresentationProject>(`/api/projects/${project.id}`);
      expect(reloaded.slides[0]?.pinnedSourceIds).toEqual([]);
    });

    it("版本記錄上越界的指定，啟用時的回應也要夾過", async (context) => {
      if (unavailable) return context.skip();
      // 與 restore 是兩條各自的程式路徑，只修一條的錯誤在這個功能上已經發生過一次。
      const project = await newProject("啟用夾越界指定");
      const slideId = project.slides[0]!.id;
      const usedId = await addSource(project.id, "當時用的.md", "台灣電動車市場銷量分析。");
      const ghostId = await addSource(project.id, "當時沒用的.md", "磷酸鐵鋰電池成本。");
      await patchSlide(project.id, slideId, { sourceIds: [usedId], pinnedSourceIds: [] });
      const versionId = await generateVersion(project.id, slideId);
      // 產生第二版，第一版才不是目前版本，activate 才有東西可切。
      await patchSlide(project.id, slideId, {
        sourceIds: [usedId, ghostId],
        pinnedSourceIds: [],
      });
      await generateVersion(project.id, slideId);

      const path = join(dataRoot, "projects", project.id, "project.json");
      const stored = JSON.parse(await readFile(path, "utf8")) as {
        slides: Array<{ versions: Array<Record<string, unknown>> }>;
      };
      const target = stored.slides[0]!.versions.find((version) => version.id === versionId)!;
      target.pinnedSourceIds = [ghostId];
      await writeFile(path, JSON.stringify(stored), "utf8");

      const activated = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${versionId}/activate`,
        { method: "POST" },
      );
      expect(activated.slides[0]?.sourceIds).toEqual([usedId]);
      expect(activated.slides[0]?.pinnedSourceIds).toEqual([]);
      const reloaded = await json<PresentationProject>(`/api/projects/${project.id}`);
      expect(reloaded.slides[0]?.pinnedSourceIds).toEqual([]);
    });

    it("修圖產生的新版本沿用被編輯那一版的指定，而不是編輯當下的指定", async (context) => {
      if (unavailable) return context.skip();
      // 修圖是在既有版本上動刀：新版本的大綱快照沿用被編輯的那一版，指定清單必須指向
      // 同一個時間點。若改用「按下修圖當下」的指定，這一版就會記著一組與它的快照無關的
      // 指定；還原回來時使用者會拿到一份自己從沒為這張圖選過的指定，而且沒有任何線索
      // 說明它從哪來。兩份清單同源不是潔癖，是版本記錄能不能被信任的前提。
      const project = await newProject("修圖沿用指定");
      const slideId = project.slides[0]!.id;
      const baseId = await addSource(project.id, "一直在用甲.md", "台灣電動車市場銷量分析。");
      const laterId = await addSource(project.id, "一直在用乙.md", "磷酸鐵鋰電池成本。");
      // 生成第一版時兩份都在用，但一份都沒指定。
      await patchSlide(project.id, slideId, {
        sourceIds: [baseId, laterId],
        pinnedSourceIds: [],
      });
      await generateVersion(project.id, slideId);

      // 生成之後才指定了乙——這是「編輯當下」的狀態，不該被寫進修圖產生的版本。
      await patchSlide(project.id, slideId, {
        sourceIds: [baseId, laterId],
        pinnedSourceIds: [laterId],
      });

      const queued = await json<{ id: string }>(
        `/api/projects/${project.id}/slides/${slideId}/edit-image`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "mock-image", instruction: "把背景調亮一點" }),
        },
      );
      const deadline = Date.now() + 5_000;
      let editedVersionId = "";
      while (Date.now() < deadline) {
        const loaded = await json<PresentationProject>(`/api/projects/${project.id}`);
        const job = loaded.jobs.find((candidate) => candidate.id === queued.id);
        if (job?.status === "completed") {
          editedVersionId = loaded.slides[0]!.versions.at(-1)!.id;
          break;
        }
        if (job?.status === "failed") throw new Error("修圖失敗");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(editedVersionId).not.toBe("");

      // 還原到修圖產生的那一版：指定要回到被編輯那一版的狀態（空的），
      // 而不是按下修圖時畫面上的那一組。
      const restored = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${editedVersionId}/restore`,
        { method: "POST" },
      );
      expect(restored.slides[0]?.sourceIds).toEqual([baseId, laterId]);
      expect(restored.slides[0]?.pinnedSourceIds).toEqual([]);
    });

    it("補快照給沒有快照的舊版本時，當時生效的指定要一起補上", async (context) => {
      if (unavailable) return context.skip();
      // 加入 outlineSnapshot 之前生成的版本沒有快照，重生成大綱時會就地補一份
      // 「這次編輯之前的狀態」。指定沒跟著補的話，那一版就永遠記著「沒有指定」，
      // 使用者還原回去會發現指定憑空消失——而且不可逆，沒有任何地方記得它曾經存在。
      const project = await newProject("補快照帶指定");
      const slideId = project.slides[0]!.id;
      const pinnedId = await addSource(project.id, "當時指定的.md", "台灣電動車市場銷量分析。");
      await patchSlide(project.id, slideId, {
        sourceIds: [pinnedId],
        pinnedSourceIds: [pinnedId],
      });
      const versionId = await generateVersion(project.id, slideId);

      // 把這一版打回「舊版本」的形狀：既沒有 outlineSnapshot 也沒有 pinnedSourceIds。
      const path = join(dataRoot, "projects", project.id, "project.json");
      const stored = JSON.parse(await readFile(path, "utf8")) as {
        slides: Array<{ versions: Array<Record<string, unknown>> }>;
      };
      const target = stored.slides[0]!.versions.find((version) => version.id === versionId)!;
      delete target.outlineSnapshot;
      delete target.pinnedSourceIds;
      await writeFile(path, JSON.stringify(stored), "utf8");

      // 重生成大綱：這一步會為目前版本補上快照。
      modelSourceIds = [pinnedId];
      await json<PresentationProject>(`/api/projects/${project.id}/slides/${slideId}/outline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      // 還原回去：補的快照要連指定一起帶回來。
      const restored = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${versionId}/restore`,
        { method: "POST" },
      );
      expect(restored.slides[0]?.sourceIds).toEqual([pinnedId]);
      expect(restored.slides[0]?.pinnedSourceIds).toEqual([pinnedId]);
    });

    it("加入這個欄位之前生成的版本，還原後等同沒有指定而不是壞掉", async (context) => {
      if (unavailable) return context.skip();
      const project = await newProject("舊版本還原");
      const slideId = project.slides[0]!.id;
      const sourceId = await addSource(project.id, "來源.md", "台灣電動車市場銷量分析。");
      await patchSlide(project.id, slideId, {
        sourceIds: [sourceId],
        pinnedSourceIds: [sourceId],
      });
      const versionId = await generateVersion(project.id, slideId);

      // 把版本記錄裡的 pinnedSourceIds 整個拿掉，模擬升級前寫下的資料。
      const path = join(dataRoot, "projects", project.id, "project.json");
      const stored = JSON.parse(await readFile(path, "utf8")) as {
        slides: Array<{ versions: Array<Record<string, unknown>> }>;
      };
      for (const version of stored.slides[0]!.versions) delete version.pinnedSourceIds;
      await writeFile(path, JSON.stringify(stored), "utf8");

      const restored = await json<PresentationProject>(
        `/api/projects/${project.id}/slides/${slideId}/versions/${versionId}/restore`,
        { method: "POST" },
      );
      expect(restored.slides[0]?.sourceIds).toEqual([sourceId]);
      expect(restored.slides[0]?.pinnedSourceIds).toEqual([]);
    });
  });
});

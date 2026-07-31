import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  outlineContentCharBudget,
  type PresentationProject,
  type StructuredTextProvider,
  type StructuredTextRequest,
} from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { ModelRuntime } from "../src/model-runtime.js";
import {
  OUTLINE_DECK_CHUNK_BUDGET,
  OUTLINE_SLIDE_IMAGE_REF_LIMIT,
  OUTLINE_SLIDE_SOURCE_REF_LIMIT,
} from "../src/outline-sources.js";

/** 預設風格是 high 密度；硬上限由 core 決定，測試不重寫一份數字。 */
const HARD_LIMIT = outlineContentCharBudget("high").hard;

/**
 * 兩階段大綱的來源歸屬。
 *
 * 這一組釘的是 2026-07-29 線上那份 20 頁專案全數 `GEMINI_IMAGE_REFERENCES_LIMIT` 的根因：
 * 每頁的 `sourceIds` 是「凡是有片段進了 prompt 的所有來源」的無差別聯集，20 頁只剩 2 種
 * 不同的集合，模型的選擇被完全稀釋。這裡的每一條都對應那條路上的一個具體缺陷，而且錯了
 * 都是靜默的——模型不會 throw，大綱照樣生得出來，只是每頁都掛著同一組圖。
 */

/** 只有正文才有這串字：用來分辨階段 1 的 prompt 有沒有夾帶不該出現的東西。 */
const BODY_MARKER = "台灣電動車二〇二五年掛牌數為五萬八千輛";

interface StagePayload {
  topic: string;
  sourceCatalog: { ref: string; name: string; kind: string; summary: string }[];
  uploadedSources?: { ref: string; source?: string; text: string }[];
  slides?: {
    planRef: string;
    purpose: string;
    sourceRefs: string[];
    imageRefs: string[];
    excerptRefs: string[];
  }[];
  previousAttempt?: { planRef: string; sourceRefs: string[]; imageRefs: string[] }[];
}

function untrustedPayload(prompt: string): StagePayload {
  const marker = "\nUNTRUSTED_INPUT\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return JSON.parse(prompt.slice(index + marker.length)) as StagePayload;
}

describe("兩階段大綱的來源歸屬", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  const prompts: string[] = [];
  const restore: (() => void)[] = [];

  /** 每一輪的回覆由 attempt（第幾次呼叫）決定：1 是規劃，之後是寫作。 */
  const stubTextProvider = (reply: (attempt: number, prompt: string) => unknown) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        prompts.push(request.prompt);
        const result = reply(prompts.length, request.prompt);
        if (result instanceof Error) throw result;
        // provider 合約是信封（`StructuredTextResult`）：模型的輸出在 `value`，用量在 `usage`。
        return { value: result };
      },
    } as StructuredTextProvider);
    restore.push(() => spy.mockRestore());
  };

  const captureLogs = (level: "warn" | "error" = "warn"): (() => Record<string, unknown>[]) => {
    const lines: string[] = [];
    const collect = (line: unknown) => {
      lines.push(String(line));
    };
    const spy =
      level === "warn"
        ? vi.spyOn(console, "warn").mockImplementation(collect)
        : vi.spyOn(console, "error").mockImplementation(collect);
    restore.push(() => spy.mockRestore());
    return () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  };

  beforeAll(async () => {
    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-outline-two-stage-")), "data");
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
  });

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    prompts.length = 0;
  });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  /** 搜尋一律關掉：這裡驗的是來源歸屬，不是網路搜尋流程。 */
  const createProject = async (desiredSlideCount: number) => {
    const { body } = await post<PresentationProject>("/api/projects", {
      topic: "台灣電動車市場",
      brief: { desiredSlideCount, webSearchMode: "disabled" },
    });
    return body;
  };

  /** 上傳一份文字來源；`usage` 用來造出「圖片來源」（模型只能把它放進 imageRefs）。 */
  const addSource = async (
    projectId: string,
    name: string,
    text: string,
    usage = "content",
  ): Promise<PresentationProject> => {
    const query = new URLSearchParams({ name, mediaType: "text/markdown", usage });
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/sources?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new TextEncoder().encode(text),
      },
    );
    return (await response.json()) as PresentationProject;
  };

  /** 造出「會被 jobs.ts 附成參考圖」的來源：判準是 usage，不是模型填在哪個欄位。 */
  const withImageSources = async (count: number, desiredSlideCount: number, usage: string) => {
    const project = await createProject(desiredSlideCount);
    let latest = project;
    for (let index = 0; index < count; index += 1)
      latest = await addSource(
        project.id,
        `圖表${index + 1}.md`,
        `${BODY_MARKER}。圖表 ${index + 1} 的說明文字與座標軸標籤。`,
        usage,
      );
    return latest;
  };

  const withSources = async (count: number, desiredSlideCount = count) => {
    const project = await createProject(desiredSlideCount);
    let latest = project;
    for (let index = 0; index < count; index += 1)
      latest = await addSource(
        project.id,
        `來源${index + 1}.md`,
        `${BODY_MARKER}。第 ${index + 1} 份來源的獨有內容：主題 ${index + 1} 的細節說明。`,
      );
    return latest;
  };

  const planReply = (slides: { sourceRefs?: string[]; imageRefs?: string[] }[]) => ({
    actualSlideCount: slides.length,
    rationale: "測試用計畫",
    slides: slides.map((slide, index) => ({
      purpose: `第 ${index + 1} 頁`,
      sourceRefs: slide.sourceRefs ?? [],
      imageRefs: slide.imageRefs ?? [],
    })),
  });

  const draftReply = (
    slides: { sourceRefs?: string[]; imageRefs?: string[]; planRef?: string; content?: string }[],
  ) => ({
    slides: slides.map((slide, index) => ({
      // 階段 1 的錨點原樣回聲：這是兩次無狀態呼叫之間唯一的配對依據。
      planRef: slide.planRef ?? `P${index + 1}`,
      content: slide.content ?? `第 ${index + 1} 頁的內容`,
      narrative: "講者補充",
      layoutHint: "單欄重點",
      sourceRefs: slide.sourceRefs ?? [],
      imageRefs: slide.imageRefs ?? [],
      sourceUrls: [],
    })),
  });

  const generateDeck = (projectId: string) =>
    post<PresentationProject & { error?: string }>(`/api/projects/${projectId}/outline`, {
      replace: true,
    });

  it("20 頁各自拿到模型挑的那一份來源，不是同一組灌到底", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(20);
    // 第 i 頁挑第 i 份來源：舊版把「所有進了 prompt 的來源」聯集進每一頁，20 頁只會剩下
    // 一兩種集合；那正是每頁都掛上 12 張圖、整份撞上參考圖上限的原因。
    const picks = Array.from({ length: 20 }, (_, index) => ({ sourceRefs: [`S${index + 1}`] }));
    stubTextProvider((attempt) => (attempt === 1 ? planReply(picks) : draftReply(picks)));
    captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(prompts).toHaveLength(2);
    expect(body.slides).toHaveLength(20);
    const sourceIds = body.slides.map((slide) => slide.sourceIds);
    expect(sourceIds.every((ids) => ids.length === 1)).toBe(true);
    expect(new Set(sourceIds.map((ids) => ids.join(","))).size).toBe(20);
    expect(sourceIds.map((ids) => ids[0])).toEqual(project.sources.map((source) => source.id));
  });

  it("階段 1 只拿得到目錄（含檔名），階段 2 才拿得到逐頁的正文片段", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(4, 3);
    const picks = [{ sourceRefs: ["S1"] }, { sourceRefs: ["S2"] }, { sourceRefs: ["S3"] }];
    stubTextProvider((attempt) => (attempt === 1 ? planReply(picks) : draftReply(picks)));
    captureLogs();

    await generateDeck(project.id);

    const plan = untrustedPayload(prompts[0]!);
    // 目錄用短序號而非 UUID：108 個 36 字元的 id 讓模型逐頁複製是幻覺溫床，也非常燒 token。
    expect(plan.sourceCatalog.map((entry) => entry.ref)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(JSON.stringify(plan)).not.toContain(project.sources[0]!.id);
    // 檔名一定要在：線上有一張圖的檔名寫著 AWS 資安、正文卻整篇在講餐廳評分，只給正文
    // 的目錄會讓它永遠檢索不到。
    expect(plan.sourceCatalog.map((entry) => entry.name)).toContain("來源1.md");
    // 規劃階段沒有正文可寫，所以也不該收到正文欄位。
    expect(plan.uploadedSources).toBeUndefined();

    const draft = untrustedPayload(prompts[1]!);
    expect(draft.slides).toHaveLength(3);
    // 逐頁檢索：每頁自己的 excerptRefs，而不是整份共用一包。
    expect(draft.slides!.every((slide) => slide.excerptRefs.length > 0)).toBe(true);
    // 跨頁去重：同一塊在 prompt 裡只出現一次。
    const refs = (draft.uploadedSources ?? []).map((excerpt) => excerpt.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(JSON.stringify(draft.uploadedSources)).toContain(BODY_MARKER);
  });

  it("imageRefs 超過上限時多的被截掉，並留下帶數字的 log", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(6, 1);
    // 非嚴格 gateway 不遵守 json_schema，prompt 又明說「留空是合法答案」，實測仍會硬湊滿。
    const tooMany = [{ imageRefs: ["S1", "S2", "S3", "S4", "S5"], sourceRefs: ["S6"] }];
    stubTextProvider((attempt) => (attempt === 1 ? planReply(tooMany) : draftReply(tooMany)));
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    const slide = body.slides[0]!;
    // 只留前 3 張圖 + 1 份內容來源：一張都不砍正是整份專案生成失敗的原因。
    expect(slide.sourceIds).toHaveLength(OUTLINE_SLIDE_IMAGE_REF_LIMIT + 1);
    expect(slide.sourceIds).not.toContain(project.sources[3]!.id);
    expect(slide.sourceIds).not.toContain(project.sources[4]!.id);

    const overLimit = readWarnings().filter((entry) => entry.event === "outline_refs_over_limit");
    // 兩個階段各截一次（兩次獨立呼叫，兩次都可能超）。
    expect(overLimit).toHaveLength(2);
    expect(overLimit[0]).toMatchObject({
      projectId: project.id,
      stage: "plan",
      droppedImageRefs: 2,
      droppedSourceRefs: 0,
      imageRefLimit: OUTLINE_SLIDE_IMAGE_REF_LIMIT,
      sourceRefLimit: OUTLINE_SLIDE_SOURCE_REF_LIMIT,
    });
    expect(overLimit[1]).toMatchObject({ stage: "draft", droppedImageRefs: 2 });
  });

  it("對不上目錄的幻覺 ref 被丟棄，部分命中留一行帶兩個數字的 log", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(3, 1);
    const picks = [{ sourceRefs: ["S2", "S999", "來源2.md"] }];
    stubTextProvider((attempt) => (attempt === 1 ? planReply(picks) : draftReply(picks)));
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    // 幻覺 ref 不猜、不保留：只有 S2 是真的。
    expect(body.slides[0]!.sourceIds).toEqual([project.sources[1]!.id]);
    const partial = readWarnings().filter((entry) => entry.event === "outline_refs_partial");
    expect(partial).toHaveLength(2);
    expect(partial[0]).toMatchObject({
      projectId: project.id,
      stage: "plan",
      returnedCount: 3,
      matchedCount: 1,
      slideCount: 1,
      catalogCount: 3,
    });
    // 「一筆都沒對上」才是降級，部分命中不是。
    expect(readWarnings().filter((entry) => entry.event === "outline_refs_unmatched")).toEqual([]);
  });

  it("整組 ref 都對不上時當降級記一行 log，並退回這一頁自己檢索到的來源", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(3, 2);
    // 「模型沒有 throw」不等於「它做了事」：整組幻覺 ref 會 parse 成功，然後靜默走回
    // fallback——與整個兩階段沒跑長得一模一樣，只是換了個入口。
    const picks = [{ sourceRefs: ["S77"] }, { sourceRefs: ["S88"] }];
    stubTextProvider((attempt) => (attempt === 1 ? planReply(picks) : draftReply(picks)));
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    const unmatched = readWarnings().filter((entry) => entry.event === "outline_refs_unmatched");
    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]).toMatchObject({ stage: "plan", returnedCount: 2, matchedCount: 0 });
    const fallback = readWarnings().filter(
      (entry) => entry.event === "outline_source_ids_fallback",
    );
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ projectId: project.id, fallbackSlideOrders: [0, 1] });
    // 退回檢索結果，而不是留下一頁沒有任何引用。
    for (const slide of body.slides) expect(slide.sourceIds.length).toBeGreaterThan(0);
  });

  it("模型一個 ref 都沒回時走 fallback，且不同頁仍可能拿到不同的來源", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(3, 2);
    const empty = [{}, {}];
    stubTextProvider((attempt) => (attempt === 1 ? planReply(empty) : draftReply(empty)));
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(
      readWarnings().filter((entry) => entry.event === "outline_source_ids_fallback"),
    ).toHaveLength(1);
    for (const slide of body.slides) expect(slide.sourceIds.length).toBeGreaterThan(0);
    // fallback 是逐頁的檢索結果，不是「整份專案的來源聯集」——後者正是要修掉的那條路。
    expect(body.slides.every((slide) => slide.sourceIds.length <= project.sources.length)).toBe(
      true,
    );
  });

  it("模型把整批圖片來源填進 sourceRefs 時，附圖數仍被 imageRefs 的上限擋住", async (context) => {
    if (bindUnavailable) return context.skip();
    // qa 的 probe：10 份 visual-reference、模型回 sourceRefs:[S1..S8]／imageRefs:[]，
    // 兩者都在自己的 schema 上限內，落地卻是 8 張附圖——`sourceIds` 把兩個欄位壓平成同一
    // 個陣列，jobs.ts 再從每一個 id 依 usage 反推附圖，「哪幾張是圖」在落地那一刻就沒了。
    const project = await withImageSources(10, 1, "visual-reference");
    const picks = [{ sourceRefs: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"] }];
    stubTextProvider((attempt) => (attempt === 1 ? planReply(picks) : draftReply(picks)));
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    const attached = body.slides[0]!.sourceIds.filter((id) =>
      project.sources.some((source) => source.id === id && source.usage === "visual-reference"),
    );
    expect(attached).toHaveLength(OUTLINE_SLIDE_IMAGE_REF_LIMIT);
    // 保留的是模型最先挑的那幾張，不是隨便三張。
    expect(attached).toEqual(project.sources.slice(0, 3).map((source) => source.id));
    const capped = readWarnings().filter((entry) => entry.event === "outline_image_sources_capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({
      projectId: project.id,
      imageRefLimit: OUTLINE_SLIDE_IMAGE_REF_LIMIT,
      droppedCount: 5,
    });
    // 只記 id 與數字：檔名不進 log。
    expect(JSON.stringify(capped[0])).not.toContain("圖表1.md");
  });

  it("原樣素材與風格參考也算附圖，同樣受 imageRefs 上限管", async (context) => {
    if (bindUnavailable) return context.skip();
    // `direct-asset` 與 `style-reference` 在 jobs.ts 一樣會被附成參考圖。目錄的 kind 若
    // 只認 visual-reference，prompt 那句「imageRefs 只能放 kind 是 image 的」等於明文禁止
    // 模型附上使用者標為「原樣素材」的圖，而上限又擋不住它們從 sourceRefs 溜進來。
    const project = await withImageSources(6, 1, "direct-asset");
    const picks = [{ sourceRefs: ["S1", "S2", "S3", "S4", "S5", "S6"] }];
    stubTextProvider((attempt) => (attempt === 1 ? planReply(picks) : draftReply(picks)));
    captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(untrustedPayload(prompts[0]!).sourceCatalog.map((entry) => entry.kind)).toEqual(
      Array.from({ length: 6 }, () => "image"),
    );
    expect(body.slides[0]!.sourceIds).toHaveLength(OUTLINE_SLIDE_IMAGE_REF_LIMIT);
  });

  it("階段 2 打亂順序回覆時依 planRef 對回計畫，而不是照位置硬配", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(3, 3);
    stubTextProvider((attempt) => {
      if (attempt === 1)
        return planReply([{ sourceRefs: ["S1"] }, { sourceRefs: ["S2"] }, { sourceRefs: ["S3"] }]);
      // 非嚴格 gateway 重排 JSON 陣列並不罕見：第 3 頁被排到最前面。頁數相同，所以
      // 長度檢查完全擋不住——照位置配的話，封面會拿到結論頁的內文而毫無徵兆。
      return {
        slides: [
          { planRef: "P3", content: "第三頁", sourceRefs: ["S3"] },
          { planRef: "P1", content: "第一頁", sourceRefs: ["S1"] },
          { planRef: "P2", content: "第二頁", sourceRefs: ["S2"] },
        ].map((slide) => ({
          ...slide,
          narrative: "講者補充",
          layoutHint: "單欄重點",
          imageRefs: [],
          sourceUrls: [],
        })),
      };
    });
    captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(body.slides.map((slide) => slide.purpose)).toEqual(["第 1 頁", "第 2 頁", "第 3 頁"]);
    expect(body.slides.map((slide) => slide.content)).toEqual(["第一頁", "第二頁", "第三頁"]);
    // 來源也跟著重排後的那一筆走，不是跟著位置。
    expect(body.slides.map((slide) => slide.sourceIds)).toEqual(
      project.sources.map((source) => [source.id]),
    );
  });

  it("planRef 重複或指到不存在的頁時擋下整份，並留一行只有數字的 log", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 2);
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ sourceRefs: ["S1"] }, { sourceRefs: ["S2"] }])
        : draftReply([{ planRef: "P1" }, { planRef: "P1" }]),
    );
    const readWarnings = captureLogs();
    captureLogs("error");

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(400);
    expect(body.error).toBe("OUTLINE_PLAN_MISMATCH");
    // 裸錯誤碼在編輯器裡等於叫人再按一次卻不說為什麼。
    expect((body as { message?: string }).message).toMatch(/錯位|再產生一次/);
    const drift = readWarnings().filter((entry) => entry.event === "outline_draft_alignment_drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      projectId: project.id,
      attempt: 1,
      reason: "plan_ref",
      plannedCount: 2,
      returnedCount: 2,
    });
    expect(JSON.stringify(drift[0])).not.toContain("第 1 頁");
  });

  it("模型完全不回 planRef 時沿用陣列位置，但把「沒驗證過」記下來", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 2);
    // 擋下的話，所有不回聲這個欄位的 gateway 一律產不出大綱——代價遠大於風險，因為這
    // 正是改動前的既有行為。但「沒有證據」不等於「配對正確」，必須留下一行。
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ sourceRefs: ["S1"] }, { sourceRefs: ["S2"] }])
        : draftReply([{ planRef: "" }, { planRef: "" }]),
    );
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(body.slides.map((slide) => slide.content)).toEqual(["第 1 頁的內容", "第 2 頁的內容"]);
    const missing = readWarnings().filter((entry) => entry.event === "outline_plan_ref_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ projectId: project.id, attempt: 1, slideCount: 2 });
  });

  it("重試中途頁數漂掉時採用先前那份合格草稿，而不是整批失敗", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 2);
    const overflow = `${"台".repeat(HARD_LIMIT + 30)}第一輪`;
    stubTextProvider((attempt) => {
      if (attempt === 1) return planReply([{ sourceRefs: ["S1"] }, { sourceRefs: ["S2"] }]);
      // 第 1 輪超標但在可接受上限內（shortestOverflow 已經存好，落地沒問題）；
      // 第 2 輪模型把兩頁併成一頁。丟掉手上那份合格草稿等於讓使用者燒掉配額拿到零產出。
      if (attempt === 2) return draftReply([{ content: overflow }, { content: "第二頁" }]);
      return draftReply([{ content: "被併成一頁" }]);
    });
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    expect(body.slides.map((slide) => slide.content)).toEqual([overflow, "第二頁"]);
    const drift = readWarnings().filter((entry) => entry.event === "outline_draft_alignment_drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      // 迴圈記的是**寫作階段第幾輪**（規劃不算），第 2 輪漂掉。
      attempt: 2,
      reason: "count",
      plannedCount: 2,
      returnedCount: 1,
    });
    // 走的是既有的降級採用路徑，所以那一行 log 也要在。
    expect(
      readWarnings().filter((entry) => entry.event === "outline_content_overflow_accepted"),
    ).toHaveLength(1);
  });

  it("第一輪就頁數不符時擋下，訊息報的是使用者設定的頁數而不是計畫的頁數", async (context) => {
    if (bindUnavailable) return context.skip();
    // brief 要 3 頁，階段 1 合法地回了 5 頁（允許 ±2），階段 2 只寫 4 頁。
    const project = await withSources(2, 3);
    stubTextProvider((attempt) =>
      attempt === 1 ? planReply([{}, {}, {}, {}, {}]) : draftReply([{}, {}, {}, {}]),
    );
    captureLogs();
    const readErrors = captureLogs("error");

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(400);
    expect(body.error).toBe("OUTLINE_COUNT_INVALID");
    // 「本次要求 5 頁，允許 5–5 頁」會與使用者自己的設定矛盾，還把他導向去改一個他從沒
    // 設過的數字。
    const message = (body as { message?: string }).message ?? "";
    expect(message).toContain("本次要求 3 頁");
    expect(message).toContain("規劃階段定為 5 頁");
    expect(message).toContain("撰寫階段回傳 4 頁");
    const invalid = readErrors().filter((entry) => entry.event === "outline_count_invalid");
    expect(invalid).toHaveLength(1);
    // 事後看 log 要分得出是哪一個階段回錯頁數。
    expect(invalid[0]).toMatchObject({ stage: "draft", requestedCount: 3, returnedCount: 4 });
  });

  it("餵回上一輪的 previousAttempt 不會把幻覺 ref 再送進模型面前", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 1);
    const overflow = `${"台".repeat(HARD_LIMIT + 30)}第一輪`;
    stubTextProvider((attempt) => {
      if (attempt === 1) return planReply([{ sourceRefs: ["S1"] }]);
      if (attempt === 2)
        return draftReply([{ content: overflow, sourceRefs: ["S1", "S999"], imageRefs: ["S404"] }]);
      return draftReply([{ content: "改短了", sourceRefs: ["S1"] }]);
    });
    captureLogs();

    const { status } = await generateDeck(project.id);

    expect(status).toBe(200);
    const fedBack = untrustedPayload(prompts[2]!).previousAttempt!;
    // 重試指令說「reproduce exactly, including its cited sources」：把 S999 原樣餵回去，
    // 等於每一輪都在要求模型重現同一個幻覺。
    expect(fedBack[0]!.sourceRefs).toEqual(["S1"]);
    expect(fedBack[0]!.imageRefs).toEqual([]);
    expect(prompts[2]).not.toContain("S999");
    expect(prompts[2]).not.toContain("S404");
  });

  it("頁數多時整份節錄仍被全域塊數上限擋住，且沒有任何一頁被餓死", async (context) => {
    if (bindUnavailable) return context.skip();
    // 逐頁預算（下限 5）兼任不了總量控制：20 頁 × 5 塊 = 100 塊相異正文，超過全域預算。
    // 每一頁指定 5 份自己專屬的來源，逐頁檢索因此真的各拿各的（去重救不了）。
    const pages = 20;
    const perPage = 5;
    const project = await createProject(pages);
    let latest = project;
    for (let index = 0; index < pages * perPage; index += 1)
      latest = await addSource(
        project.id,
        `來源${index + 1}.md`,
        `第 ${index + 1} 份來源的獨有內容：主題 ${index + 1} 的細節說明與數據。`,
      );
    expect(latest.sources).toHaveLength(pages * perPage);
    const picks = Array.from({ length: pages }, (_, page) => ({
      sourceRefs: Array.from({ length: perPage }, (_, slot) => `S${page * perPage + slot + 1}`),
    }));
    stubTextProvider((attempt) => (attempt === 1 ? planReply(picks) : draftReply(picks)));
    const readWarnings = captureLogs();

    const { status } = await generateDeck(project.id);

    expect(status).toBe(200);
    const draft = untrustedPayload(prompts[1]!);
    expect(draft.uploadedSources).toHaveLength(OUTLINE_DECK_CHUNK_BUDGET);
    const exhausted = readWarnings().filter(
      (entry) => entry.event === "outline_chunk_budget_exhausted",
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({
      slideCount: pages,
      deckChunkBudget: OUTLINE_DECK_CHUNK_BUDGET,
      includedChunks: OUTLINE_DECK_CHUNK_BUDGET,
      pagesWithoutExcerpts: 0,
    });
    // round-robin：預算是一輪一輪發的，所以每一頁都拿得到正文。照頁序一頁一頁發的話，
    // 前 19 頁吃光預算，最後一頁只能靠 purpose 硬掰。
    expect(draft.slides!.every((slide) => slide.excerptRefs.length > 0)).toBe(true);
  });

  it("錨點只是格式有出入（P01、小寫）時照樣對得回去，不是硬失敗", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(3, 3);
    // 「一個錨點都沒有」（證據最少）直接放行，而「每一筆都有、只是多了個零」（證據幾乎
    // 齊全）卻擋下，是說不通的不對稱；而且 runStructured 無狀態，習慣補零的模型再按一次
    // 還是同一個格式——那條路對它等於永久壞掉。
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ sourceRefs: ["S1"] }, { sourceRefs: ["S2"] }, { sourceRefs: ["S3"] }])
        : draftReply([{ planRef: " p03 " }, { planRef: "P01" }, { planRef: "P0002" }]),
    );
    const readWarnings = captureLogs();

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(200);
    // 內容依錨點抽出來的頁碼重排：P01 的那一筆是第 1 頁。
    expect(body.slides.map((slide) => slide.content)).toEqual([
      "第 2 頁的內容",
      "第 3 頁的內容",
      "第 1 頁的內容",
    ]);
    const normalized = readWarnings().filter(
      (entry) => entry.event === "outline_plan_ref_normalized",
    );
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({ projectId: project.id, attempt: 1, slideCount: 3 });
    // 格式修正過不是「沒驗證過」：雙射仍然成立，不得記成 missing。
    expect(readWarnings().filter((entry) => entry.event === "outline_plan_ref_missing")).toEqual(
      [],
    );
  });

  it("錨點指到不存在的頁時仍然擋下，正規化沒有放寬安全性", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 2);
    // 2 頁的計畫卻回 P21：抽得出頁碼但落在範圍外，仍是「模型分不清哪一頁」的正面證據。
    stubTextProvider((attempt) =>
      attempt === 1
        ? planReply([{ sourceRefs: ["S1"] }, { sourceRefs: ["S2"] }])
        : draftReply([{ planRef: "P1" }, { planRef: "P21" }]),
    );
    const readWarnings = captureLogs();
    captureLogs("error");

    const { status, body } = await generateDeck(project.id);

    expect(status).toBe(400);
    expect(body.error).toBe("OUTLINE_PLAN_MISMATCH");
    expect(
      readWarnings().filter((entry) => entry.event === "outline_draft_alignment_drift"),
    ).toHaveLength(1);
  });

  it("整份大綱的一頁都撈不到正文時留下獨立的一行 log", async (context) => {
    if (bindUnavailable) return context.skip();
    // 整批圖片描述失敗、來源全都沒有 chunk 時，droppedChunks 是 0——附在預算那一行裡的
    // 欄位因此永遠不會被記，而「模型只能靠 purpose 硬掰整份大綱」一行證據都沒有。
    const project = await createProject(2);
    stubTextProvider((attempt) => (attempt === 1 ? planReply([{}, {}]) : draftReply([{}, {}])));
    const readWarnings = captureLogs();

    const { status } = await generateDeck(project.id);

    expect(status).toBe(200);
    const starved = readWarnings().filter(
      (entry) => entry.event === "outline_pages_without_excerpts",
    );
    expect(starved).toHaveLength(1);
    expect(starved[0]).toMatchObject({
      projectId: project.id,
      slideCount: 2,
      pagesWithoutExcerpts: 2,
      includedChunks: 0,
      eligibleSourceCount: 0,
    });
    // 預算根本沒用完，所以那一行不該出現——兩件事必須分得開。
    expect(
      readWarnings().filter((entry) => entry.event === "outline_chunk_budget_exhausted"),
    ).toEqual([]);
  });

  it("單頁重生也套同一份影像上限，兩條大綱路徑的附圖數一致", async (context) => {
    if (bindUnavailable) return context.skip();
    // 專案有 6 張 visual-reference，模型一個 id 都沒回 → 退回「這一頁檢索到的所有來源」，
    // 那正是原始事故的形狀（整份路徑已經擋住，單頁沒擋的話同一份專案會有兩種附圖數）。
    const project = await withImageSources(6, 1, "visual-reference");
    stubTextProvider((attempt) => (attempt === 1 ? planReply([{}]) : draftReply([{}])));
    captureLogs();
    const { body: outlined } = await generateDeck(project.id);
    for (const undo of restore.splice(0)) undo();
    prompts.length = 0;

    const target = outlined.slides[0]!;
    stubTextProvider(() => ({
      content: "重生後的內容",
      narrative: "講者補充",
      layoutHint: "單欄重點",
      sourceIds: [],
    }));
    const readWarnings = captureLogs();

    const { status, body } = await post<PresentationProject>(
      `/api/projects/${project.id}/slides/${target.id}/outline`,
      {},
    );

    expect(status).toBe(200);
    const regenerated = body.slides.find((slide) => slide.id === target.id)!;
    expect(regenerated.sourceIds).toHaveLength(OUTLINE_SLIDE_IMAGE_REF_LIMIT);
    const capped = readWarnings().filter((entry) => entry.event === "outline_image_sources_capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({
      projectId: project.id,
      slideId: target.id,
      imageRefLimit: OUTLINE_SLIDE_IMAGE_REF_LIMIT,
      slideCount: 1,
    });
    expect(JSON.stringify(capped[0])).not.toContain("圖表1.md");
  });

  it("階段 1 的例外不得把 prompt 正文帶進 log", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 1);
    // 非嚴格 gateway 會把 request body 原樣回聲進 400 的 message，而那份 body 裝著來源正文。
    stubTextProvider((_attempt, prompt) => new Error(`HTTP 400 from gateway: ${prompt}`));
    const readWarnings = captureLogs();
    const readErrors = captureLogs("error");

    const { status } = await generateDeck(project.id);

    expect(status).not.toBe(200);
    const failed = readWarnings().filter((entry) => entry.event === "outline_stage_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ projectId: project.id, stage: "plan", attempt: 1 });
    const serialized = JSON.stringify(failed[0]);
    expect(serialized).not.toContain(BODY_MARKER);
    expect(serialized).not.toContain("UNTRUSTED_INPUT");
    expect(serialized).not.toContain("HTTP 400 from gateway");
    // 診斷資訊仍要留下來：只是不留 message／stack。
    expect(failed[0]!.errorName).toBe("Error");

    // 同一個請求的 ERROR 那一路（統一 error handler 的 http_request_failed）也必須乾淨。
    // 只把 console.error 靜音而不斷言，等於把這條路遮起來——而這個檔案的主張正好是
    // 「正文一字不進 log」。實測那一行曾經含 4528 字元的來源正文。
    const failures = readErrors().filter((entry) => entry.event === "http_request_failed");
    expect(failures).toHaveLength(1);
    const errorLine = JSON.stringify(failures[0]);
    expect(errorLine).not.toContain(BODY_MARKER);
    expect(errorLine).not.toContain("UNTRUSTED_INPUT");
    expect(errorLine).not.toContain("HTTP 400 from gateway");
    // 呼叫堆疊留著（那幾行沒有資料，只有檔名與行號），診斷價值才沒有一起消失。
    expect(String(JSON.stringify(failures[0]!.errorFrames))).toContain("app.ts");
  });

  it("例外訊息是多行、且某行以 at 開頭時，那一行不得被當成呼叫堆疊記下來", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 1);
    // Jina／CLIProxyAPI 把錯誤格式化成多行並不罕見，而 `/^\s*at /` 只要求行首是 `at `：
    // 訊息裡任何以 `at ` 起頭的句子都會被當成 frame 收進 log。
    const leakingLine = `at 2026-07-29 the customer 王小明 signed 機密合約 ${BODY_MARKER}`;
    stubTextProvider(() => new Error(`Gateway rejected the request:\n${leakingLine}\nend`));
    captureLogs();
    const readErrors = captureLogs("error");

    const { status } = await generateDeck(project.id);

    expect(status).not.toBe(200);
    const failures = readErrors().filter((entry) => entry.event === "http_request_failed");
    expect(failures).toHaveLength(1);
    const serialized = JSON.stringify(failures[0]);
    expect(serialized).not.toContain(BODY_MARKER);
    expect(serialized).not.toContain("王小明");
    expect(serialized).not.toContain("the customer");
    // 真正的 frame 仍然留著，否則這條修正等於把診斷價值一起砍掉。
    expect(String(JSON.stringify(failures[0]!.errorFrames))).toContain("app.ts");
  });

  it("階段 2 的回覆不合 schema 時，log 留下壞掉的欄位路徑而不是收到的值", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await withSources(2, 1);
    stubTextProvider((attempt) =>
      attempt === 1 ? planReply([{ sourceRefs: ["S1"] }]) : { slides: [{ content: 12 }] },
    );
    const readWarnings = captureLogs();
    captureLogs("error");

    const { status } = await generateDeck(project.id);

    expect(status).not.toBe(200);
    const failed = readWarnings().filter((entry) => entry.event === "outline_stage_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ stage: "draft", attempt: 1, errorName: "ZodError" });
    // 這一條**不是**洩漏測試：`invalid_type` 的 issue 只記型別名（`received: "number"`），
    // 訊息裡根本沒有收到的值，拿它去斷言「正文沒外洩」不過濾也會通過＝等於沒測。真正會
    // 洩漏的是同一個 catch 罩住的 provider 例外，那條在 `outline-two-stage-qa.test.ts`。
    // 這裡只驗診斷資訊有留下來：沒有欄位路徑就查不出是哪個欄位壞了。
    expect(JSON.stringify(failed[0]!.zodPaths)).toContain("content");
    // 例外整包（含 message／stack）不得出現在 log 裡：`logWarn` 的第三個參數會把它序列化成
    // 巢狀的 `error` 欄位，而那正是這條路徑刻意不走的。（斷言 `errorMessage` 沒有意義：
    // 那個欄位名從來就不存在，恆真。）
    expect(failed[0]!.error).toBeUndefined();
  });
});

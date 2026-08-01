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
import { ModelRuntime } from "../src/model-runtime.js";
import { isStyleDirectionPrompt, STYLE_DIRECTION_REPLY } from "./helpers/style-direction-stub.js";

/**
 * 頁型（`slide.pageType`）從大綱貫穿到影像合約。
 *
 * 改動前沒有任何欄位承載它：影像合約要模型自己從 `purpose`／`content` 反推這一頁是封面、
 * 段落頁還是內頁，猜錯就套錯頁型規則——而段落頁的規則往往允許換底色，那正是背景翻轉的
 * 其中一個入口。這一組釘的是「決定在大綱做一次、下游照著執行」，以及那個決定改變時
 * `outlineDirty` 要亮（它會換掉整張圖的版面）。
 */
describe("頁型從大綱貫穿到生成", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  const restore: (() => void)[] = [];

  /** 計畫階段回的頁型由測試決定；寫作階段固定回一份最小合法草稿。 */
  const stubText = (pageTypes: readonly unknown[]) => {
    const spy = vi.spyOn(ModelRuntime.prototype, "resolveTextProvider").mockReturnValue({
      id: "stub-text",
      availability: { status: "available" },
      runStructured: async (request: StructuredTextRequest) => {
        if (isStyleDirectionPrompt(request.prompt)) return { value: STYLE_DIRECTION_REPLY };
        if (request.prompt.includes("presentation strategist"))
          return {
            value: {
              actualSlideCount: pageTypes.length,
              rationale: "測試用計畫",
              slides: pageTypes.map((pageType, index) => ({
                purpose: `第 ${index + 1} 頁`,
                ...(pageType === undefined ? {} : { pageType }),
                sourceRefs: [],
                imageRefs: [],
              })),
            },
          };
        return {
          value: {
            slides: pageTypes.map((_, index) => ({
              planRef: `P${index + 1}`,
              content: `第 ${index + 1} 頁的內容`,
              narrative: "講者補充",
              layoutHint: "單欄重點",
              sourceRefs: [],
              imageRefs: [],
              sourceUrls: [],
            })),
          },
        };
      },
    } as StructuredTextProvider);
    restore.push(() => spy.mockRestore());
  };

  beforeAll(async () => {
    const dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-page-type-")), "data");
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

  const createProject = async (desiredSlideCount: number): Promise<PresentationProject> => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "台灣電動車市場",
        brief: { desiredSlideCount, webSearchMode: "disabled" },
      }),
    });
    return (await response.json()) as PresentationProject;
  };

  const generateOutline = async (projectId: string): Promise<PresentationProject> => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace: true }),
    });
    return (await response.json()) as PresentationProject;
  };

  it("計畫階段定下的頁型落到每一頁上", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(3);
    stubText(["cover", "section", "content"]);
    const outlined = await generateOutline(project.id);
    expect(outlined.slides.map((slide) => slide.pageType)).toEqual(["cover", "section", "content"]);
  });

  it("認不得或缺席的頁型退回「沒有表態」，不會讓整份大綱失敗", async (context) => {
    if (bindUnavailable) return context.skip();
    /*
     * 裸 `z.enum()` 在這裡有兩個問題：非嚴格 gateway 回 " Cover " 這種良性變體會讓整份
     * 大綱失敗（而模型顯然知道自己在指哪一種），而 zod 的 `invalid_enum_value` 還會把
     * 收到的值寫進 `ZodError.message`——那個例外會被 `runOutlineStage` 的 catch 記進 log。
     */
    const project = await createProject(3);
    stubText([" Cover ", "封面", undefined]);
    const outlined = await generateOutline(project.id);
    expect(outlined.slides.map((slide) => slide.pageType)).toEqual(["cover", undefined, undefined]);
  });

  it("改頁型會亮 outlineDirty，改隱藏不會", async (context) => {
    if (bindUnavailable) return context.skip();
    const project = await createProject(1);
    stubText(["content"]);
    const outlined = await generateOutline(project.id);
    const slideId = outlined.slides[0]!.id;
    const patch = async (body: unknown) => {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/slides/${slideId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await response.json()) as PresentationProject;
    };
    // 隱藏一個像素都沒動到圖：列進 outlineFields 會讓「隱藏再取消隱藏」留下橘框。
    expect((await patch({ hidden: true })).slides[0]!.outlineDirty).toBe(false);
    expect((await patch({ hidden: false })).slides[0]!.outlineDirty).toBe(false);
    // 頁型相反：它決定套哪一段版面規則，換了就與畫面上的圖不同步了。
    const retyped = await patch({ pageType: "cover" });
    expect(retyped.slides[0]!.pageType).toBe("cover");
    expect(retyped.slides[0]!.outlineDirty).toBe(true);
  });
});

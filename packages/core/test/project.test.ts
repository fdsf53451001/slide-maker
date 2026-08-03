import { describe, expect, it } from "vitest";
import {
  createProject,
  parseProject,
  ProviderRegistry,
  UNTITLED_PROJECT_NAME,
} from "../src/index.js";

describe("project contract", () => {
  it("creates a schema-valid project with editable slide specs", () => {
    const project = createProject({ topic: "開源簡報生成" });
    expect(parseProject(project)).toEqual(project);
    expect(project.slides).toHaveLength(project.brief.desiredSlideCount);
    expect(project.workflowStage).toBe("requirements");
    expect(project.brief.contentMode).toBe("creative");
    expect(project.brief.webSearchMode).toBe("cached");
  });

  it("rejects duplicate provider ids", () => {
    const registry = new ProviderRegistry<{ id: string }>();
    registry.register({ id: "mock" });
    expect(() => registry.register({ id: "mock" })).toThrow(/already registered/);
  });

  it("migrates legacy jobs to lifecycle version 1", () => {
    const project = createProject({ topic: "Legacy" });
    const now = new Date().toISOString();
    (project.jobs as unknown[]).push({
      id: "legacy-job",
      projectId: project.id,
      slideId: project.slides[0]!.id,
      providerId: "mock-image",
      status: "running",
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    });
    const migrated = parseProject(project);
    expect(migrated.jobs[0]).toMatchObject({
      lifecycleVersion: 1,
      phase: "waiting_for_codex",
      progress: { step: 4, total: 6 },
    });
  });

  it("在解析層就把越界的指定夾掉，而不是留給每個寫入端點各自負責", () => {
    // `pinnedSourceIds ⊆ sourceIds` 只在這裡強制一次，載入、匯入、每次存檔都會經過。
    // 這個單元測試把不變式釘在它真正的家：伺服器的端點測試證明的是「端點有走這條路」，
    // 一旦哪天有人改成散在各個端點自己夾，這裡會先紅，而不是等到某個沒被蓋到的
    // 寫入路徑在正式環境放出一個 UI 點不掉的幽靈指定。
    const project = createProject({ topic: "指定不變式" }) as unknown as Record<string, unknown>;
    const slides = project.slides as Array<Record<string, unknown>>;
    slides[0]!.sourceIds = ["source-in-use"];
    slides[0]!.pinnedSourceIds = ["source-in-use", "source-not-in-use"];

    const parsed = parseProject(project);
    expect(parsed.slides[0]?.sourceIds).toEqual(["source-in-use"]);
    // 夾掉的是越界的那一個，不是整份清空——無條件清空同樣能讓「幽靈消失」，
    // 卻會在每次載入專案時把使用者的指定悄悄抹掉。
    expect(parsed.slides[0]?.pinnedSourceIds).toEqual(["source-in-use"]);
  });

  it("舊專案檔沒有 pinnedSourceIds 時補成空陣列，等同全交給模型", () => {
    const project = createProject({ topic: "舊專案檔" }) as unknown as Record<string, unknown>;
    const slides = project.slides as Array<Record<string, unknown>>;
    slides[0]!.sourceIds = ["source-a"];
    delete slides[0]!.pinnedSourceIds;

    const parsed = parseProject(project);
    expect(parsed.slides[0]?.pinnedSourceIds).toEqual([]);
    expect(parsed.slides[0]?.sourceIds).toEqual(["source-a"]);
  });

  /*
   * 主畫面的「開始規劃」不強迫先想好主題，所以 `brief.topic` 可以是空字串。它擋在
   * 「產生大綱」那一步，不擋在建立專案——但 `name` 仍是 `min(1)`（列表卡片上唯一認得出
   * 這份專案的字），空主題因此必須有替代名，否則 `presentationProjectSchema.parse()`
   * 會在建立當下就丟出來，使用者看到的是一個沒有下一步的錯誤。
   */
  it("允許空白主題建立專案，並補上未命名的替代名稱", () => {
    const project = createProject({ topic: "" });
    expect(parseProject(project)).toEqual(project);
    expect(project.brief.topic).toBe("");
    expect(project.name).toBe(UNTITLED_PROJECT_NAME);
    // 佔位大綱仍要讀得通：直接內插空字串會產出「說明  為何值得…」這種句子，而這些文字
    // 會跟著進生成大綱的 prompt。
    expect(project.slides.map((slide) => slide.content).join("")).not.toMatch(/ {2}/);
    expect(project.slides.some((slide) => slide.content.includes("這份簡報"))).toBe(true);
  });

  it("有主題時名稱就是主題，明確給的名稱優先於兩者", () => {
    expect(createProject({ topic: "季度回顧" }).name).toBe("季度回顧");
    expect(createProject({ topic: "季度回顧", name: "給董事會的版本" }).name).toBe(
      "給董事會的版本",
    );
    // 只有空白的名稱等同沒給，不能讓專案叫做「   」。
    expect(createProject({ topic: "", name: "   " }).name).toBe(UNTITLED_PROJECT_NAME);
  });

  it("derives the workflow stage for projects saved before the two-step flow", () => {
    const untouched = createProject({ topic: "Legacy requirements" }) as unknown as Record<
      string,
      unknown
    >;
    delete untouched.workflowStage;
    expect(parseProject(untouched).workflowStage).toBe("requirements");

    const generated = createProject({ topic: "Legacy generated" }) as unknown as Record<
      string,
      unknown
    >;
    delete generated.workflowStage;
    (generated.jobs as unknown[]).push({
      id: "old-job",
      projectId: generated.id,
      slideId: (generated.slides as Array<{ id: string }>)[0]!.id,
      providerId: "mock-image",
      status: "completed",
      attempt: 1,
      createdAt: generated.createdAt,
      updatedAt: generated.updatedAt,
    });
    expect(parseProject(generated).workflowStage).toBe("editing");
  });
});

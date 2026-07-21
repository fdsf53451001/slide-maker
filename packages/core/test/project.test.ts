import { describe, expect, it } from "vitest";
import { createProject, parseProject, ProviderRegistry } from "../src/index.js";

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

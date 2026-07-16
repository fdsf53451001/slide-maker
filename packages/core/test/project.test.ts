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

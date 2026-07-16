import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "@slide-maker/core";
import { FileProjectRepository } from "../src/repository.js";

describe("FileProjectRepository", () => {
  it("round-trips a validated project", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-test-"));
    const repository = new FileProjectRepository(root);
    const project = createProject({ topic: "持久化測試" });
    await repository.saveProject(project);
    expect(await repository.loadProject(project.id)).toEqual(project);
  });

  it("rejects asset traversal", async () => {
    const repository = new FileProjectRepository(join(tmpdir(), "slide-maker-test-root"));
    expect(() => repository.assetPath("valid", "../../secret")).toThrow(/escaped/);
  });
});

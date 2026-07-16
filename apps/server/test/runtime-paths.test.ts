import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EDITOR_BUILD_MISSING } from "../src/app.js";
import { runtimePaths } from "../src/runtime-paths.js";

describe("server runtime paths", () => {
  it("resolves repository assets from the module location instead of cwd", () => {
    expect(runtimePaths.editorDist).toBe(resolve(import.meta.dirname, "../../editor/dist"));
    expect(runtimePaths.dataRoot).toBe(resolve(import.meta.dirname, "../../../.slide-maker-data"));
    expect(runtimePaths.workspaceRoot).toBe(resolve(import.meta.dirname, "../../../"));
    expect(runtimePaths.codexImageJobsRoot).toBe(resolve(tmpdir(), "slide-maker-codex-image-jobs"));
    expect(runtimePaths.codexImageJobsRoot.startsWith(`${runtimePaths.workspaceRoot}/`)).toBe(false);
  });

  it("provides an actionable missing-editor response", () => {
    expect(EDITOR_BUILD_MISSING).toContain("pnpm --filter @slide-maker/editor build");
  });
});

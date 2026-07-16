import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

export function runtimePathsFrom(moduleUrl: string): { dataRoot: string; editorDist: string; workspaceRoot: string; codexImageJobsRoot: string } {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  return {
    dataRoot: resolve(moduleDirectory, "../../../.slide-maker-data"),
    editorDist: resolve(moduleDirectory, "../../editor/dist"),
    workspaceRoot: resolve(moduleDirectory, "../../../"),
    // Codex app-server does not expose the CLI's --ignore-rules switch. Keep
    // image jobs outside the repository so it cannot inherit AGENTS.md or
    // other project instructions while walking parent directories.
    codexImageJobsRoot: resolve(tmpdir(), "slide-maker-codex-image-jobs"),
  };
}

export const runtimePaths = runtimePathsFrom(import.meta.url);

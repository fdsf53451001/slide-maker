import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function runtimePathsFrom(moduleUrl: string): {
  dataRoot: string;
  editorDist: string;
  workspaceRoot: string;
} {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  return {
    dataRoot: resolve(moduleDirectory, "../../../.slide-maker-data"),
    editorDist: resolve(moduleDirectory, "../../editor/dist"),
    workspaceRoot: resolve(moduleDirectory, "../../../"),
  };
}

export const runtimePaths = runtimePathsFrom(import.meta.url);

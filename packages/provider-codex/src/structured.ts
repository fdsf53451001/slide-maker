import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnWithArgv } from "./index.js";

export interface CodexStructuredOptions {
  prompt: string;
  outputSchema: Record<string, unknown>;
  webSearchMode?: "live" | "cached" | "disabled";
  executable?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  imagePaths?: readonly string[];
}

function inside(root: string, candidate: string): boolean {
  const base = resolve(root); const path = resolve(candidate);
  return path === base || path.startsWith(`${base}${sep}`);
}

function environment(): NodeJS.ProcessEnv {
  const value: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "CODEX_HOME", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"] as const) {
    if (process.env[key]) value[key] = process.env[key];
  }
  return value;
}

export async function runCodexStructured(options: CodexStructuredOptions): Promise<unknown> {
  const root = resolve(options.workspaceRoot ?? join(tmpdir(), "slide-maker-codex-structured"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error("CODEX_STRUCTURED_WORKSPACE_INVALID");
  const canonicalRoot = await realpath(root);
  const workspace = await mkdtemp(join(root, "job-"));
  if (!inside(canonicalRoot, await realpath(workspace))) throw new Error("CODEX_STRUCTURED_WORKSPACE_INVALID");
  const schemaPath = join(workspace, "schema.json");
  const outputPath = join(workspace, "result.json");
  await writeFile(schemaPath, `${JSON.stringify(options.outputSchema, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const localImages: string[] = [];
  for (const [index, sourcePath] of (options.imagePaths ?? []).entries()) {
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > 16 * 1024 * 1024) throw new Error("CODEX_STRUCTURED_IMAGE_INVALID");
    const handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const bytes = await handle.readFile();
      const extension = bytes[0] === 0x89 && bytes[1] === 0x50 ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : undefined;
      if (!extension) throw new Error("CODEX_STRUCTURED_IMAGE_INVALID");
      const target = join(workspace, `reference-${index + 1}.${extension}`);
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" }); localImages.push(target);
    } finally { await handle.close(); }
  }
  const result = await spawnWithArgv(options.executable ?? "codex", [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--sandbox", "read-only", "--skip-git-repo-check", "-C", workspace,
    "--output-schema", schemaPath, "--output-last-message", outputPath,
    "-c", `web_search=${JSON.stringify(options.webSearchMode ?? "disabled")}`,
    ...localImages.flatMap((path) => ["-i", path]),
    ...(localImages.length > 0 ? ["--"] : []),
    options.prompt,
  ], {
    cwd: workspace, env: environment(), timeoutMs: options.timeoutMs ?? 10 * 60_000,
    maxOutputBytes: 2 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.timedOut) throw new Error("CODEX_STRUCTURED_TIMEOUT");
  if (options.signal?.aborted) throw new DOMException("Codex request cancelled", "AbortError");
  if (result.exitCode !== 0) throw new Error("CODEX_STRUCTURED_FAILED");
  const metadata = await lstat(outputPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > 2 * 1024 * 1024) {
    throw new Error("CODEX_STRUCTURED_OUTPUT_INVALID");
  }
  const handle = await open(outputPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== metadata.size) throw new Error("CODEX_STRUCTURED_OUTPUT_INVALID");
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("CODEX_STRUCTURED_OUTPUT_INVALID");
    throw error;
  } finally {
    await handle.close();
  }
}

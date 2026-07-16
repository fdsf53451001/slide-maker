import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, ProviderRegistry, type ImageProvider } from "@slide-maker/core";
import { CodexImageSpikeProvider, spawnWithArgv } from "@slide-maker/provider-codex";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

const mode = process.argv[2];

if (mode === "text") {
  const workspace = await mkdtemp(join(tmpdir(), "slide-maker-codex-text-"));
  const result = await spawnWithArgv(
    "codex",
    [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      workspace,
      "Reply with exactly: SLIDE_MAKER_CODEX_OK. Do not use tools or web search.",
    ],
    { cwd: workspace, timeoutMs: 120_000 },
  );
  const eventCount = result.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
  if (result.timedOut) throw new Error("TEXT_SMOKE_TIMEOUT");
  if (result.exitCode !== 0) throw new Error(`TEXT_SMOKE_FAILED_${result.exitCode}`);
  if (!result.stdout.includes("SLIDE_MAKER_CODEX_OK"))
    throw new Error("TEXT_SMOKE_UNEXPECTED_RESPONSE");
  console.log(JSON.stringify({ smoke: "text", status: "passed", eventCount }));
} else if (mode === "image") {
  if (process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX !== "1")
    throw new Error("IMAGE_SMOKE_OPT_IN_REQUIRED");
  const dataRoot = await mkdtemp(join(tmpdir(), "slide-maker-codex-image-smoke-"));
  const repository = new FileProjectRepository(dataRoot);
  const project = createProject({
    topic: "A minimal editorial slide with the title: Soft Sandbox Smoke Test",
  });
  project.slides = [project.slides[0]!];
  project.slides[0]!.purpose = "Codex image provider smoke test";
  project.slides[0]!.content = "Soft Sandbox Smoke Test";
  project.slides[0]!.imagePrompt =
    "Minimal dark navy 16:9 presentation slide, one warm orange circle, large white title Soft Sandbox Smoke Test, no other text.";
  await repository.saveProject(project);
  const provider = new CodexImageSpikeProvider({
    allowExecution: true,
    workspaceRoot: join(dataRoot, "codex-jobs"),
    timeoutMs: 5 * 60_000,
  });
  const runner = new JobRunner(
    repository,
    new ProviderRegistry<ImageProvider>().register(provider),
  );
  const startedAt = Date.now();
  const job = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
  const deadline = Date.now() + 6 * 60_000;
  let finalProject = project;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    finalProject = (await repository.loadProject(project.id))!;
    const status = finalProject.jobs.find((candidate) => candidate.id === job.id)?.status;
    if (["completed", "failed", "cancelled"].includes(status ?? "")) break;
  }
  const finalJob = finalProject.jobs.find((candidate) => candidate.id === job.id);
  const version = finalProject.slides[0]?.versions.at(-1);
  if (finalJob?.status !== "completed" || !version) {
    throw new Error(
      `IMAGE_SMOKE_${finalJob?.status?.toUpperCase() ?? "TIMEOUT"}:${finalJob?.error ?? "NO_RESULT"}`,
    );
  }
  const relativeAssetPath = version.imagePath.startsWith("assets/")
    ? version.imagePath.slice("assets/".length)
    : version.imagePath;
  const bytes = await readFile(repository.assetPath(project.id, relativeAssetPath));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  console.log(
    JSON.stringify({
      smoke: "image",
      status: "passed",
      providerId: version.providerId,
      mediaExtension: version.imagePath.split(".").at(-1),
      structurallyValidated: true,
      persistedVersion: true,
      elapsedMs: Date.now() - startedAt,
      width,
      height,
      byteLength: bytes.byteLength,
      sha256Prefix: createHash("sha256").update(bytes).digest("hex").slice(0, 12),
    }),
  );
} else {
  throw new Error("Usage: tsx scripts/codex-smoke.ts text|image");
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProject,
  parseProject,
  ProviderRegistry,
  SafeProviderError,
  type GeneratedImage,
  type ImageGenerationContext,
  type ImageGenerationRequest,
  type ImageProvider,
} from "@slide-maker/core";
import { MockImageProvider } from "@slide-maker/provider-mock";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

const QA_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const capabilities = {
  fullSlideGeneration: true as const,
  referenceImages: false,
  imageEditing: false,
  maskedEditing: false,
  multipleReferenceImages: false,
  supportedSizes: [{ width: 1920, height: 1080 }],
  reproducibleParameters: [] as string[],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForJob(
  repository: FileProjectRepository,
  projectId: string,
  jobId: string,
  predicate: (job: NonNullable<Awaited<ReturnType<FileProjectRepository["loadProject"]>>>["jobs"][number]) => boolean,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const project = await repository.loadProject(projectId);
    const job = project?.jobs.find((candidate) => candidate.id === jobId);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach the expected observable state`);
}

async function fixture(provider: ImageProvider, Repository = FileProjectRepository) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-observability-"));
  const repository = new Repository(root);
  const project = createProject({ topic: "QA observability canary" });
  await repository.saveProject(project);
  const runner = new JobRunner(repository, new ProviderRegistry<ImageProvider>().register(provider));
  return { root, repository, project, runner };
}

class PersistBarrierRepository extends FileProjectRepository {
  readonly enteredPersist = deferred();
  readonly releasePersist = deferred();

  override async saveAsset(projectId: string, relativePath: string, bytes: Uint8Array): Promise<string> {
    this.enteredPersist.resolve();
    await this.releasePersist.promise;
    return super.saveAsset(projectId, relativePath, bytes);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("QA generation job observability", () => {
  it("persists every Codex phase and event in order, survives reload, and exposes a growing elapsed time", async () => {
    const beforeLaunch = deferred();
    const afterLaunch = deferred();
    const afterStarted = deferred();
    const afterItem = deferred();
    const afterCompleted = deferred();
    const afterValidation = deferred();
    const provider: ImageProvider = {
      id: "qa-observable",
      name: "QA observable provider",
      availability: { status: "available" },
      timeoutMs: 600_000,
      capabilities,
      async generate(_request: ImageGenerationRequest, context?: ImageGenerationContext): Promise<GeneratedImage> {
        await beforeLaunch.promise;
        await context?.onProgress?.({ phase: "launching" });
        await afterLaunch.promise;
        await context?.onProgress?.({ phase: "waiting_for_codex", eventCode: "turn_started" });
        await afterStarted.promise;
        await context?.onProgress?.({ phase: "waiting_for_codex", eventCode: "item_completed" });
        await afterItem.promise;
        await context?.onProgress?.({ phase: "waiting_for_codex", eventCode: "turn_completed" });
        await afterCompleted.promise;
        await context?.onProgress?.({ phase: "validating_output" });
        await afterValidation.promise;
        return { bytes: QA_PNG, mediaType: "image/png", extension: "png", model: "qa", parameters: {} };
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { root, repository, project, runner } = await fixture(provider, PersistBarrierRepository);
    const persistedRepository = repository as PersistBarrierRepository;
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    expect(queued).toMatchObject({ phase: "queued", progress: { step: 1, total: 6 }, timeoutMs: 600_000 });

    const preparing = await waitForJob(repository, project.id, queued.id, (job) => job.phase === "preparing");
    expect(preparing.startedAt).toBeTruthy();
    beforeLaunch.resolve();
    await waitForJob(repository, project.id, queued.id, (job) => job.phase === "launching");
    afterLaunch.resolve();

    const waiting = await waitForJob(repository, project.id, queued.id, (job) => job.providerEventCode === "turn_started");
    expect(waiting).toMatchObject({ status: "running", phase: "waiting_for_codex", progress: { step: 4, total: 6 } });
    const reloaded = await new FileProjectRepository(root).loadProject(project.id);
    expect(reloaded?.jobs.find((job) => job.id === queued.id)).toMatchObject({ phase: "waiting_for_codex", providerEventCode: "turn_started" });
    const startedAt = Date.parse(waiting.startedAt!);
    const elapsed1 = Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const elapsed2 = Date.now() - startedAt;
    expect(elapsed2).toBeGreaterThan(elapsed1);

    afterStarted.resolve();
    await waitForJob(repository, project.id, queued.id, (job) => job.providerEventCode === "item_completed");
    afterItem.resolve();
    await waitForJob(repository, project.id, queued.id, (job) => job.providerEventCode === "turn_completed");
    afterCompleted.resolve();
    await waitForJob(repository, project.id, queued.id, (job) => job.phase === "validating_output");
    afterValidation.resolve();
    await persistedRepository.enteredPersist.promise;
    await waitForJob(repository, project.id, queued.id, (job) => job.phase === "persisting");
    persistedRepository.releasePersist.resolve();
    const completed = await waitForJob(repository, project.id, queued.id, (job) => job.status === "completed");
    expect(completed).toMatchObject({ phase: "completed", progress: { step: 6, total: 6 }, attempt: 1 });
    expect(completed.finishedAt).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 0));
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { phase: string; jobId: string });
    const phases = records.filter((record) => record.jobId === queued.id).map((record) => record.phase);
    expect(phases).toEqual([
      "queued", "preparing", "launching", "waiting_for_codex", "waiting_for_codex",
      "waiting_for_codex", "validating_output", "persisting", "completed",
    ]);
  });

  it("cancels a waiting provider through AbortSignal and never retries it", async () => {
    const waiting = deferred();
    let invocations = 0;
    const provider: ImageProvider = {
      id: "qa-cancellable",
      name: "QA cancellable provider",
      availability: { status: "available" },
      timeoutMs: 60_000,
      capabilities,
      async generate(_request, context): Promise<GeneratedImage> {
        invocations += 1;
        await context?.onProgress?.({ phase: "launching" });
        await context?.onProgress?.({ phase: "waiting_for_codex", eventCode: "turn_started" });
        waiting.resolve();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException("cancelled", "AbortError"));
          context?.signal?.addEventListener("abort", abort, { once: true });
          if (context?.signal?.aborted) abort();
        });
      },
    };
    const { repository, project, runner } = await fixture(provider);
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waiting.promise;
    await waitForJob(repository, project.id, queued.id, (job) => job.phase === "waiting_for_codex");
    const cancelled = await runner.cancel(project.id, queued.id);
    expect(cancelled).toMatchObject({ status: "cancelled", phase: "cancelled", errorCode: "CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await repository.loadProject(project.id))?.jobs[0]).toMatchObject({ status: "cancelled", finishedAt: expect.any(String) });
    expect(invocations).toBe(1);
  });

  it("exposes a positive timeout remainder while waiting, then fails once with CODEX_TIMEOUT", async () => {
    let invocations = 0;
    const provider: ImageProvider = {
      id: "qa-timeout",
      name: "QA timeout provider",
      availability: { status: "available" },
      timeoutMs: 120,
      capabilities,
      async generate(_request, context): Promise<GeneratedImage> {
        invocations += 1;
        await context?.onProgress?.({ phase: "launching" });
        await context?.onProgress?.({ phase: "waiting_for_codex", eventCode: "turn_started" });
        await new Promise((resolve) => setTimeout(resolve, 120));
        throw new SafeProviderError("CODEX_TIMEOUT", "RAW-STDERR-CANARY");
      },
    };
    const { repository, project, runner } = await fixture(provider);
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    const waiting = await waitForJob(repository, project.id, queued.id, (job) => job.phase === "waiting_for_codex");
    const elapsed = Date.now() - Date.parse(waiting.startedAt!);
    expect(waiting.timeoutMs).toBe(120);
    expect(waiting.timeoutMs! - elapsed).toBeGreaterThan(0);
    const failed = await waitForJob(repository, project.id, queued.id, (job) => job.status === "failed");
    expect(failed).toMatchObject({ status: "failed", phase: "failed", errorCode: "CODEX_TIMEOUT", attempt: 1 });
    expect(failed.error).toContain("SLIDE_MAKER_CODEX_TIMEOUT_MS");
    expect(JSON.stringify(failed)).not.toContain("RAW-STDERR-CANARY");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(invocations).toBe(1);
  });

  it.each([
    ["CODEX_TIMEOUT", "Codex 圖片生成逾時。請確認額度與登入狀態，必要時調高 SLIDE_MAKER_CODEX_TIMEOUT_MS 後重啟 server。"],
    ["CODEX_USAGE_LIMIT", "Codex 額度已達上限，請在額度恢復後重試。"],
    ["CODEX_AUTH_REQUIRED", "Codex 尚未登入或授權已失效，請先在 CLI 完成登入。"],
  ])("persists a safe, actionable %s classification", async (code, safeMessage) => {
    const provider: ImageProvider = {
      id: `qa-${code.toLowerCase()}`,
      name: "QA safe error provider",
      availability: { status: "available" },
      capabilities,
      async generate() { throw new SafeProviderError(code, safeMessage); },
    };
    const { repository, project, runner } = await fixture(provider);
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    const failed = await waitForJob(repository, project.id, queued.id, (job) => job.status === "failed");
    expect(failed).toMatchObject({ phase: "failed", errorCode: code, error: safeMessage, attempt: 1 });
    expect(JSON.stringify(failed)).not.toMatch(/stderr|Bearer|token|raw prompt/i);
  });

  it("writes structured phase logs with identifiers but without prompt, style, source, stderr, or token data", async () => {
    const canaries = ["PROMPT-CANARY", "STYLE-CANARY", "SOURCE-CANARY", "RAW-STDERR-CANARY", "TOKEN-CANARY"];
    const provider: ImageProvider = {
      id: "qa-log-safe",
      name: "QA log safe provider",
      availability: { status: "available" },
      capabilities,
      async generate() { throw new Error(`${canaries[3]} ${canaries[4]}`); },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { repository, project, runner } = await fixture(provider);
    await repository.updateProject(project.id, (current) => {
      current.slides[0]!.imagePrompt = canaries[0]!;
      current.styleSnapshot.promptTemplate = canaries[1]!;
      current.slides[0]!.sourceIds = [canaries[2]!];
    });
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waitForJob(repository, project.id, queued.id, (job) => job.status === "failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records.every((record) => record.event === "slide_job_phase" && record.jobId === queued.id && record.projectId === project.id)).toBe(true);
    for (const canary of canaries) expect(output).not.toContain(canary);
  });

  it("migrates legacy jobs without observability fields and keeps old project files readable", () => {
    const legacy = createProject({ topic: "Legacy manifest", now: "2026-07-14T00:00:00.000Z" });
    const job = {
      id: "legacy-running",
      projectId: legacy.id,
      slideId: legacy.slides[0]!.id,
      providerId: "mock-image",
      status: "running",
      attempt: 1,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:01:00.000Z",
    };
    (legacy.jobs as unknown[]).push(job);
    const migrated = parseProject(JSON.parse(JSON.stringify(legacy)));
    expect(migrated.jobs[0]).toMatchObject({
      lifecycleVersion: 1,
      phase: "waiting_for_codex",
      progress: { step: 4, total: 6 },
      phaseUpdatedAt: job.updatedAt,
      startedAt: job.createdAt,
    });
  });

  it("gives the deterministic mock provider observable lifecycle phases", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new MockImageProvider();
    const { repository, project, runner } = await fixture(provider);
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waitForJob(repository, project.id, queued.id, (job) => job.status === "completed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const phases = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { jobId: string; phase: string })
      .filter((record) => record.jobId === queued.id)
      .map((record) => record.phase);
    expect(phases).toEqual(["queued", "preparing", "persisting", "completed"]);
  });
});

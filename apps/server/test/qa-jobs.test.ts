import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProject,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageProvider,
  ProviderRegistry,
} from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

const QA_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

class QaImageProvider implements ImageProvider {
  readonly id: string = "qa-image";
  readonly name = "QA deterministic image";
  readonly availability = { status: "available" as const };
  readonly capabilities = {
    fullSlideGeneration: true as const,
    referenceImages: false,
    imageEditing: false,
    maskedEditing: false,
    multipleReferenceImages: false,
    supportedSizes: [{ width: 1920, height: 1080 }],
    reproducibleParameters: [] as string[],
  };

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    void request;
    return {
      bytes: QA_PNG,
      mediaType: "image/png",
      extension: "png",
      model: "qa-v1",
      parameters: { deterministic: true },
    };
  }
}

class QaFailingProvider extends QaImageProvider {
  override readonly id = "qa-failing";

  override async generate(): Promise<GeneratedImage> {
    throw new Error("Bearer qa-secret-value request failed");
  }
}

async function waitForTerminalJob(repository: FileProjectRepository, projectId: string, jobId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const project = await repository.loadProject(projectId);
    const job = project?.jobs.find((candidate) => candidate.id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return { project, job };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state`);
}

async function fixture(provider: ImageProvider) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-jobs-"));
  const repository = new FileProjectRepository(root);
  const project = createProject({ topic: "QA job persistence", now: "2026-07-14T00:00:00.000Z" });
  await repository.saveProject(project);
  const providers = new ProviderRegistry<ImageProvider>().register(provider);
  return { root, repository, project, runner: new JobRunner(repository, providers) };
}

describe("QA job persistence contract", () => {
  it("persists a completed result, immutable version metadata, and asset bytes", async () => {
    const { root, repository, project, runner } = await fixture(new QaImageProvider());
    const slide = project.slides[0]!;
    const queued = await runner.enqueue(project.id, slide.id, "qa-image");
    const { project: completedProject, job } = await waitForTerminalJob(repository, project.id, queued.id);

    expect(job.status).toBe("completed");
    expect(job.attempt).toBe(1);
    expect(job.resultVersionId).toBeTruthy();
    const completedSlide = completedProject?.slides.find((candidate) => candidate.id === slide.id);
    const version = completedSlide?.versions.find((candidate) => candidate.id === job.resultVersionId);
    expect(completedSlide?.currentVersionId).toBe(version?.id);
    expect(version).toMatchObject({
      providerId: "qa-image",
      model: "qa-v1",
      styleVersion: project.styleSnapshot.version,
      parameters: { deterministic: true },
      outlineSnapshot: {
        purpose: slide.purpose,
        content: slide.content,
        narrative: slide.narrative,
        layoutHint: slide.layoutHint,
        imagePrompt: slide.imagePrompt,
        sourceIds: slide.sourceIds,
      },
    });
    expect(completedSlide?.outlineDirty).toBe(false);
    expect(new Uint8Array(await readFile(join(root, "projects", project.id, version!.imagePath))))
      .toEqual(QA_PNG);
  });

  it("replaces provider errors with a fixed safe message before persisting", async () => {
    const { repository, project, runner } = await fixture(new QaFailingProvider());
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, "qa-failing");
    const { job } = await waitForTerminalJob(repository, project.id, queued.id);

    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("PROVIDER_FAILED");
    expect(job.error).toBe("圖片生成失敗，請檢查 provider 狀態後重試。");
    expect(job.error).not.toContain("qa-secret-value");
  });

  it("marks an interrupted running job failed during recovery", async () => {
    const { repository, project, runner } = await fixture(new QaImageProvider());
    const now = "2026-07-14T01:00:00.000Z";
    project.jobs.push({
      id: "interrupted-job",
      projectId: project.id,
      slideId: project.slides[0]!.id,
      providerId: "qa-image",
      status: "running",
      operation: "generate",
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    });
    await repository.saveProject(project);

    await runner.recoverInterruptedJobs();

    const recovered = await repository.loadProject(project.id);
    expect(recovered?.jobs[0]).toMatchObject({
      id: "interrupted-job",
      status: "failed",
      attempt: 1,
    });
    expect(recovered?.jobs[0]).toMatchObject({
      errorCode: "SERVER_RESTARTED",
      error: "Server 重新啟動，請重試這一頁。",
    });
  });
});

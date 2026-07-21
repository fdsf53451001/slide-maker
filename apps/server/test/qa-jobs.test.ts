import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  createProject,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageProvider,
  ProviderRegistry,
  type SourceAsset,
} from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

const QA_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

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

class QaReferenceCapturingProvider extends QaImageProvider {
  override readonly id = "qa-capture";
  override readonly capabilities = {
    fullSlideGeneration: true as const,
    referenceImages: true,
    imageEditing: false,
    maskedEditing: false,
    multipleReferenceImages: true,
    supportedSizes: [{ width: 1920, height: 1080 }],
    reproducibleParameters: [] as string[],
  };

  captured: ImageGenerationRequest | undefined;

  override async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    this.captured = request;
    return super.generate(request);
  }
}

class QaEditCapturingProvider extends QaImageProvider {
  override readonly id: string = "qa-edit";
  override readonly capabilities = {
    fullSlideGeneration: true as const,
    referenceImages: false,
    imageEditing: true,
    maskedEditing: true,
    multipleReferenceImages: false,
    supportedSizes: [{ width: 1920, height: 1080 }],
    reproducibleParameters: [] as string[],
  };

  captured: ImageGenerationRequest | undefined;

  override async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    this.captured = request;
    return super.generate(request);
  }
}

class QaTextExtractionProvider extends QaEditCapturingProvider {
  override readonly id = "qa-text-extraction";

  override async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    this.captured = request;
    const bytes = await sharp({
      create: {
        width: request.width,
        height: request.height,
        channels: 4,
        background: "#202020",
      },
    })
      .png()
      .toBuffer();
    return {
      bytes: new Uint8Array(bytes),
      mediaType: "image/png",
      extension: "png",
      model: "qa-text-v1",
      parameters: {},
    };
  }
}

class QaFailingProvider extends QaImageProvider {
  override readonly id = "qa-failing";

  override async generate(): Promise<GeneratedImage> {
    throw new Error("Bearer qa-secret-value request failed");
  }
}

class PersistFailingRepository extends FileProjectRepository {
  override async saveAsset(): Promise<string> {
    throw new Error("disk full: unable to persist asset");
  }
}

async function waitForTerminalJob(
  repository: FileProjectRepository,
  projectId: string,
  jobId: string,
) {
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
    const { project: completedProject, job } = await waitForTerminalJob(
      repository,
      project.id,
      queued.id,
    );

    expect(job.status).toBe("completed");
    expect(job.attempt).toBe(1);
    expect(job.resultVersionId).toBeTruthy();
    const completedSlide = completedProject?.slides.find((candidate) => candidate.id === slide.id);
    const version = completedSlide?.versions.find(
      (candidate) => candidate.id === job.resultVersionId,
    );
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
    expect(
      new Uint8Array(await readFile(join(root, "projects", project.id, version!.imagePath))),
    ).toEqual(QA_PNG);
  });

  it("completes generation and persists the outline snapshot for a blank slide with only a purpose", async () => {
    const { repository, project, runner } = await fixture(new QaImageProvider());
    const slide = project.slides[0]!;
    slide.purpose = "只填了頁面目的";
    slide.content = "";
    slide.narrative = "";
    slide.layoutHint = "";
    slide.imagePrompt = "";
    await repository.saveProject(project);
    const queued = await runner.enqueue(project.id, slide.id, "qa-image");
    const { project: completedProject, job } = await waitForTerminalJob(
      repository,
      project.id,
      queued.id,
    );

    expect(job.status).toBe("completed");
    const version = completedProject?.slides
      .find((candidate) => candidate.id === slide.id)
      ?.versions.find((candidate) => candidate.id === job.resultVersionId);
    expect(version?.outlineSnapshot).toMatchObject({
      purpose: "只填了頁面目的",
      content: "",
      imagePrompt: "",
    });
  });

  it("maps source usages to distinct provider reference roles", async () => {
    const provider = new QaReferenceCapturingProvider();
    const { repository, project, runner } = await fixture(provider);
    const now = "2026-07-14T00:00:00.000Z";
    const makeSource = (id: string, usage: SourceAsset["usage"]): SourceAsset => ({
      id,
      name: `${id}.png`,
      mediaType: "image/png",
      usage,
      allowModelAccess: true,
      status: "indexed",
      assetPath: `assets/${id}.png`,
      sizeBytes: 8,
      extractedText: "",
      chunks: [],
      metadata: {},
      createdAt: now,
    });
    project.sources.push(
      makeSource("src-visual", "visual-reference"),
      makeSource("src-style", "style-reference"),
      makeSource("src-direct", "direct-asset"),
      makeSource("src-excluded", "exclude-from-generation"),
    );
    project.slides[0]!.sourceIds = ["src-visual", "src-style", "src-direct", "src-excluded"];
    await repository.saveProject(project);
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, "qa-capture");
    const { job } = await waitForTerminalJob(repository, project.id, queued.id);

    expect(job.status).toBe("completed");
    expect(
      provider.captured?.references.map((reference) => ({
        name: reference.name,
        role: reference.role,
      })),
    ).toEqual([
      { name: "src-visual.png", role: "content" },
      { name: "src-style.png", role: "style" },
      { name: "src-direct.png", role: "direct-asset" },
    ]);
  });

  it("allows an intrinsic edit base when the provider rejects supplemental references", async () => {
    const provider = new QaEditCapturingProvider();
    const { repository, project, runner } = await fixture(provider);
    const slide = project.slides[0]!;
    const generated = await runner.enqueue(project.id, slide.id, provider.id);
    const first = await waitForTerminalJob(repository, project.id, generated.id);
    expect(first.job.status).toBe("completed");

    const edited = await runner.enqueue(project.id, slide.id, provider.id, {
      instruction: "只調整右上角裝飾，其餘保持不變",
      baseVersionId: first.job.resultVersionId!,
    });
    const second = await waitForTerminalJob(repository, project.id, edited.id);

    expect(second.job.status).toBe("completed");
    expect(provider.captured?.edit).toMatchObject({
      instruction: "只調整右上角裝飾，其餘保持不變",
      baseImageIndex: 0,
    });
    expect(provider.captured?.references).toHaveLength(1);
    expect(provider.captured?.references[0]?.name).toBe("Current slide image");
  });

  it("deletes superseded text-extraction assets after replacing the version", async () => {
    const provider = new QaTextExtractionProvider();
    const { repository, project, runner } = await fixture(provider);
    const slide = project.slides[0]!;
    const generated = await runner.enqueue(project.id, slide.id, provider.id);
    const original = await waitForTerminalJob(repository, project.id, generated.id);
    const originalVersionId = original.job.resultVersionId!;

    const extracted = await runner.enqueue(project.id, slide.id, provider.id, {
      instruction: "Remove text",
      baseVersionId: originalVersionId,
      textExtraction: {
        originalVersionId,
        threshold: 0.75,
        boxes: [],
      },
    });
    const first = await waitForTerminalJob(repository, project.id, extracted.id);
    const extractedVersion = first.project?.slides[0]?.versions.find(
      (version) => version.id === first.job.resultVersionId,
    );
    expect(extractedVersion?.textLayer).toBeDefined();
    const stalePaths = [
      extractedVersion!.textLayer!.backgroundPath,
      extractedVersion!.textLayer!.compositePath,
    ];

    const replaced = await runner.enqueue(project.id, slide.id, provider.id, {
      instruction: "Remove text again",
      baseVersionId: originalVersionId,
      textExtraction: {
        originalVersionId,
        replaceVersionId: extractedVersion!.id,
        threshold: 0.75,
        boxes: [],
      },
    });
    const second = await waitForTerminalJob(repository, project.id, replaced.id);
    expect(second.job.status).toBe("completed");
    for (const stalePath of stalePaths)
      await expect(
        readFile(repository.assetPath(project.id, stalePath.replace(/^assets\//, ""))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    const current = second.project?.slides[0]?.versions.find(
      (version) => version.id === extractedVersion!.id,
    );
    await expect(
      readFile(repository.assetPath(project.id, current!.imagePath.replace(/^assets\//, ""))),
    ).resolves.toBeDefined();
  });

  it("classifies persist-stage failures as PERSIST_FAILED with a safe message", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-jobs-persist-"));
    const repository = new PersistFailingRepository(root);
    const project = createProject({
      topic: "QA persist failure",
      now: "2026-07-14T00:00:00.000Z",
    });
    await repository.saveProject(project);
    const providers = new ProviderRegistry<ImageProvider>().register(new QaImageProvider());
    const runner = new JobRunner(repository, providers);
    const queued = await runner.enqueue(project.id, project.slides[0]!.id, "qa-image");
    const { job } = await waitForTerminalJob(repository, project.id, queued.id);

    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("PERSIST_FAILED");
    expect(job.error).toBe("圖片已生成，但結果儲存失敗（資料驗證或寫入錯誤），請重試。");
    expect(job.error).not.toContain("disk full");
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

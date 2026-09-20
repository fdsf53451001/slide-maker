import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createProject,
  ProviderRegistry,
  type GenerationJob,
  type ImageGenerationRequest,
  type ImageProvider,
} from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

// 排程測試只需要合法的輸出格式頭，不透過模型生成影像。
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

async function fixture(maxConcurrency = 2) {
  const repository = new FileProjectRepository(await mkdtemp(join(tmpdir(), "sequential-deck-")));
  const calls: Array<{
    request: ImageGenerationRequest;
    finish: () => void;
    fail: () => void;
  }> = [];
  const provider: ImageProvider = {
    id: "sequence-test",
    name: "Sequence test",
    maxConcurrency,
    availability: { status: "available" },
    capabilities: {
      fullSlideGeneration: true,
      referenceImages: true,
      multipleReferenceImages: true,
      imageEditing: true,
      maskedEditing: true,
      supportedSizes: [{ width: 1920, height: 1080 }],
      reproducibleParameters: [],
    },
    async generate(request, context) {
      await new Promise<void>((resolve, reject) => {
        calls.push({ request, finish: resolve, fail: () => reject(new Error("TEST_FAILURE")) });
        context?.signal?.addEventListener("abort", () => reject(new Error("TEST_ABORT")), {
          once: true,
        });
      });
      return {
        bytes: PNG,
        mediaType: "image/png",
        extension: "png",
        model: "test",
        parameters: {},
      };
    },
  };
  const registry = new ProviderRegistry<ImageProvider>().register(provider);
  const runner = new JobRunner(repository, registry);
  const project = createProject({ topic: "Sequential slides", brief: { desiredSlideCount: 3 } });
  await repository.saveProject(project);
  return { repository, provider, registry, runner, project, calls };
}

describe("sequential deck generation", () => {
  it("removes cancelled queued pages even when another project occupies their provider", async (ctx) => {
    const f = await fixture(1);
    ctx.onTestFinished(() => f.runner.shutdown());
    f.registry.register({ ...f.provider, id: "other-provider" });
    const other = createProject({ topic: "Busy provider" });
    await f.repository.saveProject(other);
    await f.runner.enqueue(other.id, other.slides[0]!.id, f.provider.id);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const cancelled = await f.runner.enqueue(f.project.id, f.project.slides[0]!.id, f.provider.id);
    await f.runner.enqueue(f.project.id, f.project.slides[1]!.id, "other-provider");
    // Wait for both deferred scheduling callbacks without advancing the active provider.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.calls).toHaveLength(1);
    await f.runner.cancel(f.project.id, cancelled.id);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls[1]!.request.slide.id).toBe(f.project.slides[1]!.id);
    f.calls[0]!.finish();
    f.calls[1]!.finish();
    await vi.waitFor(async () => {
      expect((await f.repository.loadProject(f.project.id))!.jobs.map((job) => job.status)).toEqual(
        ["cancelled", "completed"],
      );
    });
  });

  it("does not serialize a local edit behind a whole-slide generation", async (ctx) => {
    const f = await fixture();
    ctx.onTestFinished(() => f.runner.shutdown());
    await f.runner.enqueue(f.project.id, f.project.slides[0]!.id, f.provider.id);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.calls[0]!.finish();
    await vi.waitFor(async () => {
      expect((await f.repository.loadProject(f.project.id))!.jobs[0]!.status).toBe("completed");
    });
    const first = (await f.repository.loadProject(f.project.id))!.slides[0]!;
    await f.runner.enqueue(f.project.id, f.project.slides[1]!.id, f.provider.id);
    await f.runner.enqueue(f.project.id, first.id, f.provider.id, {
      instruction: "Change the accent colour",
      baseVersionId: first.currentVersionId!,
    });
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    expect(f.calls[2]!.request.edit).toBeDefined();
    expect(f.calls[2]!.request.references.some((r) => r.role === "deck-frame")).toBe(false);
    f.calls[1]!.finish();
    f.calls[2]!.finish();
    await vi.waitFor(async () => {
      expect(
        (await f.repository.loadProject(f.project.id))!.jobs.every((j) => j.status === "completed"),
      ).toBe(true);
    });
  });

  it("waits for persisted previous images while another project uses the free provider slot", async (ctx) => {
    const f = await fixture();
    ctx.onTestFinished(() => f.runner.shutdown());
    const other = createProject({ topic: "Independent deck" });
    await f.repository.saveProject(other);
    for (const slide of f.project.slides)
      await f.runner.enqueue(f.project.id, slide.id, f.provider.id);
    await f.runner.enqueue(other.id, other.slides[0]!.id, f.provider.id);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls.map((call) => call.request.projectId)).toEqual([f.project.id, other.id]);
    expect(f.calls[0]!.request.references).toEqual([]);
    f.calls[0]!.finish();
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    const first = (await f.repository.loadProject(f.project.id))!.slides[0]!;
    const firstVersion = first.versions.find((v) => v.id === first.currentVersionId)!;
    expect(f.calls[2]!.request.slide.id).toBe(f.project.slides[1]!.id);
    expect(f.calls[2]!.request.references.find((r) => r.role === "deck-frame")?.path).toBe(
      f.repository.resolveAsset(f.project.id, firstVersion.imagePath),
    );
    f.calls[2]!.finish();
    await vi.waitFor(() => expect(f.calls).toHaveLength(4));
    const second = (await f.repository.loadProject(f.project.id))!.slides[1]!;
    expect(f.calls[3]!.request.references.find((r) => r.role === "deck-frame")?.path).toBe(
      f.repository.resolveAsset(
        f.project.id,
        second.versions.find((v) => v.id === second.currentVersionId)!.imagePath,
      ),
    );
    f.calls[1]!.finish();
    f.calls[3]!.finish();
    await vi.waitFor(async () => {
      const project = await f.repository.loadProject(f.project.id);
      expect(project!.jobs.every((job) => job.status === "completed")).toBe(true);
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "continues after a %s page, including across providers",
    async (status) => {
      const f = await fixture();
      onTestFinished(() => f.runner.shutdown());
      f.registry.register({ ...f.provider, id: "other-provider" });
      const first = await f.runner.enqueue(f.project.id, f.project.slides[0]!.id, f.provider.id);
      await f.runner.enqueue(f.project.id, f.project.slides[1]!.id, "other-provider");
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      if (status === "failed") f.calls[0]!.fail();
      else await f.runner.cancel(f.project.id, first.id);
      await vi.waitFor(() => expect(f.calls).toHaveLength(2));
      expect(f.calls[1]!.request.slide.id).toBe(f.project.slides[1]!.id);
      f.calls[1]!.finish();
      await vi.waitFor(async () => {
        expect(
          (await f.repository.loadProject(f.project.id))!.jobs.map((job) => job.status),
        ).toEqual([status, "completed"]);
      });
    },
  );

  it("recovers queued generation sequentially and skips a cancelled queued page", async (ctx) => {
    const f = await fixture();
    ctx.onTestFinished(() => f.runner.shutdown());
    const now = new Date().toISOString();
    const jobs: GenerationJob[] = f.project.slides.map((slide) => ({
      id: randomUUID(),
      projectId: f.project.id,
      slideId: slide.id,
      providerId: f.provider.id,
      status: "queued",
      lifecycleVersion: 1,
      phase: "queued",
      progress: { step: 1, total: 6 },
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      phaseUpdatedAt: now,
      operation: "generate",
    }));
    await f.repository.updateProject(f.project.id, (project) => {
      project.jobs.push(...jobs);
    });
    await f.runner.recoverInterruptedJobs();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.runner.cancel(f.project.id, jobs[1]!.id);
    f.calls[0]!.finish();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls[1]!.request.slide.id).toBe(f.project.slides[2]!.id);
    expect(f.calls[1]!.request.references.some((r) => r.role === "deck-frame")).toBe(true);
    f.calls[1]!.finish();
    await vi.waitFor(async () => {
      expect((await f.repository.loadProject(f.project.id))!.jobs.map((job) => job.status)).toEqual(
        ["completed", "cancelled", "completed"],
      );
    });
  });
});

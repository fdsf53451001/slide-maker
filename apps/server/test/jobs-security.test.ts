import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProject,
  ProviderRegistry,
  SafeProviderError,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageProvider,
} from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

const capabilities = {
  fullSlideGeneration: true as const,
  referenceImages: false,
  imageEditing: false,
  maskedEditing: false,
  multipleReferenceImages: false,
  supportedSizes: [{ width: 1920, height: 1080 }],
  reproducibleParameters: [],
};

async function waitForJobs(repository: FileProjectRepository, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const project = await repository.loadProject(projectId);
    if (project?.jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status)))
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Jobs did not settle");
}

describe("JobRunner provider boundaries", () => {
  it("honors the provider concurrency limit", async () => {
    let active = 0;
    let maximum = 0;
    const provider: ImageProvider = {
      id: "serial-test",
      name: "Serial test",
      availability: { status: "available" },
      maxConcurrency: 1,
      capabilities,
      async generate(_request: ImageGenerationRequest): Promise<GeneratedImage> {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return {
          bytes: new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080"/></svg>',
          ),
          mediaType: "image/svg+xml",
          extension: "svg",
          model: "test",
          parameters: {},
        };
      },
    };
    // SVG is deliberately accepted only from the built-in mock provider, so use its
    // id while replacing the implementation inside this isolated registry.
    Object.defineProperty(provider, "id", { value: "mock-image" });
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-concurrency-")),
    );
    const project = createProject({ topic: "Concurrency" });
    await repository.saveProject(project);
    const runner = new JobRunner(
      repository,
      new ProviderRegistry<ImageProvider>().register(provider),
    );
    await Promise.all([
      runner.enqueue(project.id, project.slides[0]!.id, provider.id),
      runner.enqueue(project.id, project.slides[1]!.id, provider.id),
    ]);
    await waitForJobs(repository, project.id);
    expect(maximum).toBe(1);
    expect(
      (await repository.loadProject(project.id))?.jobs.every((job) => job.status === "completed"),
    ).toBe(true);
  });

  it("rejects mismatched provider output before it reaches assets", async () => {
    const provider: ImageProvider = {
      id: "bad-output",
      name: "Bad output",
      availability: { status: "available" },
      capabilities,
      async generate() {
        return {
          bytes: new TextEncoder().encode("<html><script>alert(1)</script></html>"),
          mediaType: "image/png",
          extension: "png",
          model: "bad",
          parameters: {},
        };
      },
    };
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-bad-output-")),
    );
    const project = createProject({ topic: "Output validation" });
    await repository.saveProject(project);
    const runner = new JobRunner(
      repository,
      new ProviderRegistry<ImageProvider>().register(provider),
    );
    await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waitForJobs(repository, project.id);
    const loaded = await repository.loadProject(project.id);
    expect(loaded?.jobs[0]?.status).toBe("failed");
    expect(loaded?.slides[0]?.versions).toHaveLength(0);
    expect(loaded?.jobs[0]).toMatchObject({
      errorCode: "OUTPUT_VALIDATION_FAILED",
      error: "生成圖片未通過安全或格式驗證。",
    });
  });

  it("rejects invalid provider concurrency before persisting a job", async () => {
    const provider: ImageProvider = {
      id: "invalid-concurrency",
      name: "Invalid concurrency",
      availability: { status: "available" },
      maxConcurrency: Number.POSITIVE_INFINITY,
      capabilities,
      async generate() {
        throw new Error("must not run");
      },
    };
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-invalid-concurrency-")),
    );
    const project = createProject({ topic: "Invalid concurrency" });
    await repository.saveProject(project);
    const runner = new JobRunner(
      repository,
      new ProviderRegistry<ImageProvider>().register(provider),
    );
    await expect(runner.enqueue(project.id, project.slides[0]!.id, provider.id)).rejects.toThrow(
      /between 1 and 32/,
    );
    expect((await repository.loadProject(project.id))?.jobs).toHaveLength(0);
  });

  it("cannot cancel another project's job by guessing its id", async () => {
    const provider: ImageProvider = {
      id: "mock-image",
      name: "Ownership test",
      availability: { status: "available" },
      maxConcurrency: 1,
      capabilities,
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          bytes: new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080"/></svg>',
          ),
          mediaType: "image/svg+xml",
          extension: "svg",
          model: "test",
          parameters: {},
        };
      },
    };
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-cancel-owner-")),
    );
    const victim = createProject({ topic: "Victim" });
    const attacker = createProject({ topic: "Attacker" });
    await repository.saveProject(victim);
    await repository.saveProject(attacker);
    const runner = new JobRunner(
      repository,
      new ProviderRegistry<ImageProvider>().register(provider),
    );
    const job = await runner.enqueue(victim.id, victim.slides[0]!.id, provider.id);
    await expect(runner.cancel(attacker.id, job.id)).rejects.toThrow("Job not found");
    await waitForJobs(repository, victim.id);
    expect((await repository.loadProject(victim.id))?.jobs[0]?.status).toBe("completed");
  });

  it("does not trust provider-authored safe error text or codes", async () => {
    const provider: ImageProvider = {
      id: "hostile-error",
      name: "Hostile",
      availability: { status: "available" },
      capabilities,
      async generate() {
        throw new SafeProviderError("ATTACKER_CODE", "Bearer forged-secret\nforged log");
      },
    };
    const repository = new FileProjectRepository(
      await mkdtemp(join(tmpdir(), "slide-maker-hostile-error-")),
    );
    const project = createProject({ topic: "Error boundary" });
    await repository.saveProject(project);
    const runner = new JobRunner(
      repository,
      new ProviderRegistry<ImageProvider>().register(provider),
    );
    await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waitForJobs(repository, project.id);
    const job = (await repository.loadProject(project.id))?.jobs[0];
    expect(job).toMatchObject({
      errorCode: "PROVIDER_FAILED",
      error: "圖片生成失敗，請檢查 provider 狀態後重試。",
    });
    expect(JSON.stringify(job)).not.toMatch(/ATTACKER_CODE|forged-secret|forged log|Bearer/);
  });
});

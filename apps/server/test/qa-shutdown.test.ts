import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProject,
  ProviderRegistry,
  type GeneratedImage,
  type ImageProvider,
} from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import type { ProviderReadinessService } from "../src/readiness.js";
import { FileProjectRepository } from "../src/repository.js";
import { gracefulShutdown, installShutdownHandlers } from "../src/shutdown.js";

const capabilities = {
  fullSlideGeneration: true as const,
  referenceImages: false,
  imageEditing: false,
  maskedEditing: false,
  multipleReferenceImages: false,
  supportedSizes: [{ width: 1920, height: 1080 }],
  reproducibleParameters: [] as string[],
};

async function waitFor(repository: FileProjectRepository, projectId: string, predicate: (jobs: NonNullable<Awaited<ReturnType<FileProjectRepository["loadProject"]>>>["jobs"]) => boolean) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const project = await repository.loadProject(projectId);
    if (project && predicate(project.jobs)) return project;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Jobs did not reach the expected shutdown state");
}

afterEach(() => vi.restoreAllMocks());

describe("QA graceful JobRunner shutdown", () => {
  it("aborts the active job, drains queued work, preserves SERVER_SHUTDOWN, and restarts with no running jobs", async () => {
    let invocations = 0;
    const provider: ImageProvider = {
      id: "qa-long-running",
      name: "QA long running",
      availability: { status: "available" },
      maxConcurrency: 1,
      capabilities,
      async generate(_request, context): Promise<GeneratedImage> {
        invocations += 1;
        await context?.onLifecycle?.({ type: "spawned" });
        await context?.onProgress?.({ phase: "waiting_for_codex", eventCode: "turn_started" });
        return new Promise<never>((_resolve, reject) => {
          const abort = () => {
            void Promise.resolve(context?.onLifecycle?.({ type: "exited", exitClass: "aborted" }))
              .finally(() => reject(new DOMException("shutdown", "AbortError")));
          };
          context?.signal?.addEventListener("abort", abort, { once: true });
          if (context?.signal?.aborted) abort();
        });
      },
    };
    const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-shutdown-"));
    const repository = new FileProjectRepository(root);
    const project = createProject({ topic: "PROMPT-CANARY" });
    project.styleSnapshot.promptTemplate = "STYLE-CANARY";
    project.slides[0]!.sourceIds = ["SOURCE-CANARY"];
    await repository.saveProject(project);
    const providers = new ProviderRegistry<ImageProvider>().register(provider);
    const runner = new JobRunner(repository, providers);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const active = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waitFor(repository, project.id, (jobs) => jobs.some((job) => job.id === active.id && job.childLifecycle?.spawnedAt !== undefined));
    const queued = await runner.enqueue(project.id, project.slides[1]!.id, provider.id);
    await waitFor(repository, project.id, (jobs) => jobs.some((job) => job.id === queued.id && job.status === "queued"));

    await runner.shutdown(500);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopped = await repository.loadProject(project.id);
    expect(stopped?.jobs).toHaveLength(2);
    for (const job of stopped!.jobs) {
      expect(job).toMatchObject({ status: "failed", phase: "failed", errorCode: "SERVER_SHUTDOWN", finishedAt: expect.any(String) });
    }
    const lifecycle = stopped?.jobs.find((job) => job.id === active.id)?.childLifecycle;
    expect(lifecycle).toMatchObject({
      spawnedAt: expect.any(String),
      lastAllowedEventAt: expect.any(String),
      shutdownRequestedAt: expect.any(String),
      exitedAt: expect.any(String),
      exitClass: "server_shutdown",
    });
    expect(Object.keys(lifecycle!).sort()).toEqual([
      "exitClass", "exitedAt", "lastAllowedEventAt", "shutdownRequestedAt", "spawnedAt",
    ]);
    expect(stopped?.jobs.find((job) => job.id === queued.id)?.attempt).toBe(0);
    expect(invocations).toBe(1);
    await expect(runner.enqueue(project.id, project.slides[2]!.id, provider.id)).rejects.toThrow("SERVER_SHUTTING_DOWN");

    const restarted = new JobRunner(new FileProjectRepository(root), providers);
    await restarted.recoverInterruptedJobs();
    const reloaded = await new FileProjectRepository(root).loadProject(project.id);
    expect(reloaded?.jobs.every((job) => job.status === "failed" && job.errorCode === "SERVER_SHUTDOWN")).toBe(true);
    expect(reloaded?.jobs.some((job) => job.status === "running" || job.status === "queued")).toBe(false);

    const serialized = JSON.stringify(reloaded);
    expect(serialized).not.toMatch(/pid|RAW-STDERR|TOKEN-CANARY|base64|revised_prompt/i);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logOutput = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logOutput).not.toMatch(/PROMPT-CANARY|STYLE-CANARY|SOURCE-CANARY|RAW-STDERR|TOKEN-CANARY|base64|revised_prompt/i);
  });

  it("is reentrant, returns at the hard deadline, and never fabricates child exit evidence", async () => {
    const provider: ImageProvider = {
      id: "qa-ignores-abort",
      name: "QA ignores abort",
      availability: { status: "available" },
      maxConcurrency: 1,
      capabilities,
      async generate(_request, context): Promise<GeneratedImage> {
        await context?.onLifecycle?.({ type: "spawned" });
        return new Promise<never>(() => undefined);
      },
    };
    const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-shutdown-deadline-"));
    const repository = new FileProjectRepository(root);
    const project = createProject({ topic: "Shutdown hard deadline" });
    await repository.saveProject(project);
    const runner = new JobRunner(repository, new ProviderRegistry<ImageProvider>().register(provider));
    const job = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waitFor(repository, project.id, (jobs) => jobs.some((candidate) => candidate.id === job.id && candidate.childLifecycle?.spawnedAt !== undefined));

    const startedAt = Date.now();
    const first = runner.shutdown(100);
    const second = runner.shutdown(100);
    expect(second).toBe(first);
    await first;
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(750);

    const stopped = await repository.loadProject(project.id);
    const terminal = stopped?.jobs.find((candidate) => candidate.id === job.id);
    expect(terminal).toMatchObject({ status: "failed", errorCode: "SERVER_SHUTDOWN" });
    expect(terminal?.childLifecycle).toMatchObject({
      spawnedAt: expect.any(String),
      shutdownRequestedAt: expect.any(String),
    });
    expect(terminal?.childLifecycle).not.toHaveProperty("exitedAt");
    expect(terminal?.childLifecycle).not.toHaveProperty("exitClass");
  });

  it("records a cancel request without fabricating exitedAt when the provider reports no close", async () => {
    const provider: ImageProvider = {
      id: "qa-cancel-no-close",
      name: "QA cancel no close",
      availability: { status: "available" },
      maxConcurrency: 1,
      capabilities,
      async generate(_request, context): Promise<GeneratedImage> {
        await context?.onLifecycle?.({ type: "spawned" });
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException("cancel", "AbortError"));
          context?.signal?.addEventListener("abort", abort, { once: true });
          if (context?.signal?.aborted) abort();
        });
      },
    };
    const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-cancel-lifecycle-"));
    const repository = new FileProjectRepository(root);
    const project = createProject({ topic: "Cancel lifecycle evidence" });
    await repository.saveProject(project);
    const runner = new JobRunner(repository, new ProviderRegistry<ImageProvider>().register(provider));
    const job = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    await waitFor(repository, project.id, (jobs) => jobs.some((candidate) => candidate.id === job.id && candidate.childLifecycle?.spawnedAt !== undefined));

    const cancelled = await runner.cancel(project.id, job.id);
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "CANCELLED" });
    expect(cancelled.childLifecycle).toMatchObject({ spawnedAt: expect.any(String), cancelRequestedAt: expect.any(String) });
    expect(cancelled.childLifecycle).not.toHaveProperty("exitedAt");
    expect(cancelled.childLifecycle).not.toHaveProperty("exitClass");
  });

  it("deduplicates repeated shutdown triggers", async () => {
    const close = vi.fn((callback: () => void) => setTimeout(callback, 10));
    const server = { close, closeAllConnections: vi.fn() } as unknown as Server;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    const jobs = { shutdown } as unknown as JobRunner;
    const beginShutdown = vi.fn();
    const readiness = { beginShutdown } as unknown as ProviderReadinessService;
    const runtime = { on: vi.fn().mockReturnThis(), removeListener: vi.fn().mockReturnThis(), exit: vi.fn() } as unknown as Pick<NodeJS.Process, "on" | "removeListener" | "exit">;
    const trigger = installShutdownHandlers(server, jobs, readiness, 100, runtime);
    const first = trigger();
    const second = trigger();
    expect(second).toBe(first);
    await first;
    expect(close).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(beginShutdown).toHaveBeenCalledTimes(1);
  });

  it("exits zero after the first signal completes", async () => {
    const listeners = new Map<string, () => void>();
    const exit = vi.fn();
    const runtime = {
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return runtime;
      }),
      removeListener: vi.fn((event: string) => {
        listeners.delete(event);
        return runtime;
      }),
      exit,
    } as unknown as Pick<NodeJS.Process, "on" | "removeListener" | "exit">;
    const close = vi.fn((callback: () => void) => setTimeout(callback, 10));
    const closeAllConnections = vi.fn();
    const server = { close, closeAllConnections } as unknown as Server;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    const jobs = { shutdown } as unknown as JobRunner;
    const readiness = { beginShutdown: vi.fn() } as unknown as ProviderReadinessService;
    installShutdownHandlers(server, jobs, readiness, 100, runtime);

    listeners.get("SIGTERM")!();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(exit).toHaveBeenLastCalledWith(0);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("forces exit one immediately when a second signal arrives during shutdown", async () => {
    const listeners = new Map<string, () => void>();
    const exit = vi.fn();
    const runtime = {
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return runtime;
      }),
      removeListener: vi.fn((event: string) => {
        listeners.delete(event);
        return runtime;
      }),
      exit,
    } as unknown as Pick<NodeJS.Process, "on" | "removeListener" | "exit">;
    const closeAllConnections = vi.fn();
    const server = {
      close: vi.fn((callback: () => void) => setTimeout(callback, 50)),
      closeAllConnections,
    } as unknown as Server;
    const jobs = { shutdown: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50))) } as unknown as JobRunner;
    const readiness = { beginShutdown: vi.fn() } as unknown as ProviderReadinessService;
    installShutdownHandlers(server, jobs, readiness, 100, runtime);

    listeners.get("SIGTERM")!();
    listeners.get("SIGINT")!();
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0]).toEqual([1]);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("forces open HTTP connections closed at the graceful shutdown deadline", async () => {
    const closeAllConnections = vi.fn();
    const server = {
      close: vi.fn((_callback: () => void) => undefined),
      closeAllConnections,
    } as unknown as Server;
    const jobs = { shutdown: vi.fn(() => new Promise<void>(() => undefined)) } as unknown as JobRunner;
    const readiness = { beginShutdown: vi.fn() } as unknown as ProviderReadinessService;
    const startedAt = Date.now();
    await expect(gracefulShutdown(server, jobs, readiness, 100)).rejects.toThrow("SERVER_SHUTDOWN_DEADLINE_EXCEEDED");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(Date.now() - startedAt).toBeLessThan(750);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
  });
});

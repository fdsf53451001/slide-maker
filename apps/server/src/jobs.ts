import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import {
  SafeProviderError,
  type GenerationJob,
  type EditableTextBox,
  type ImageGenerationProgress,
  type ImageProvider,
  type SlideOutlineSnapshot,
  type SlideSpec,
} from "@slide-maker/core";
import type { ImageProviderSource } from "./readiness.js";
import { FileProjectRepository } from "./repository.js";
import { FileStyleRepository } from "./styles.js";
import { renderComposite } from "./text-layers.js";

const PHASE_STEP = {
  queued: 1,
  preparing: 2,
  launching: 3,
  waiting_for_codex: 4,
  validating_output: 5,
  persisting: 6,
  completed: 6,
  failed: 6,
  cancelled: 6,
} as const;
const PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  CODEX_TIMEOUT:
    "Codex 圖片生成逾時。請確認額度與登入狀態，必要時調高 SLIDE_MAKER_CODEX_TIMEOUT_MS 後重啟 server。",
  CODEX_USAGE_LIMIT: "Codex 額度已達上限，請在額度恢復後重試。",
  CODEX_AUTH_REQUIRED: "Codex 尚未登入或授權已失效，請先在 CLI 完成登入。",
  CODEX_PROCESS_FAILED: "Codex 執行失敗，請檢查 CLI 狀態後重試。",
  CODEX_IMAGE_ARTIFACT_UNSUPPORTED:
    "目前 Codex CLI 沒有可安全依賴的圖片產物契約；已阻止生成以避免消耗額度。",
};

function outlineSnapshot(slide: SlideSpec): SlideOutlineSnapshot {
  return {
    purpose: slide.purpose,
    content: slide.content,
    narrative: slide.narrative,
    layoutHint: slide.layoutHint,
    imagePrompt: slide.imagePrompt,
    sourceIds: [...slide.sourceIds],
  };
}

function sameOutline(slide: SlideSpec, snapshot: SlideOutlineSnapshot): boolean {
  return (
    slide.purpose === snapshot.purpose &&
    slide.content === snapshot.content &&
    slide.narrative === snapshot.narrative &&
    slide.layoutHint === snapshot.layoutHint &&
    slide.imagePrompt === snapshot.imagePrompt &&
    JSON.stringify(slide.sourceIds) === JSON.stringify(snapshot.sourceIds)
  );
}

function safeFailure(
  error: unknown,
  aborted: boolean,
  persisting = false,
): { code: string; message: string; phase: "failed" | "cancelled" } {
  if (aborted || (error instanceof DOMException && error.name === "AbortError"))
    return { code: "CANCELLED", message: "生成工作已取消。", phase: "cancelled" };
  if (persisting)
    return {
      code: "PERSIST_FAILED",
      message: "圖片已生成，但結果儲存失敗（資料驗證或寫入錯誤），請重試。",
      phase: "failed",
    };
  if (error instanceof SafeProviderError && Object.hasOwn(PROVIDER_ERROR_MESSAGES, error.code)) {
    return { code: error.code, message: PROVIDER_ERROR_MESSAGES[error.code]!, phase: "failed" };
  }
  const message = error instanceof Error ? error.message : "";
  if (/timed out|timeout/i.test(message))
    return { code: "PROVIDER_TIMEOUT", message: "圖片生成逾時，請稍後重試。", phase: "failed" };
  if (/PNG|output|image size|image format|dimensions|symlink|workspace|regular file/i.test(message))
    return {
      code: "OUTPUT_VALIDATION_FAILED",
      message: "生成圖片未通過安全或格式驗證。",
      phase: "failed",
    };
  return {
    code: "PROVIDER_FAILED",
    message: "圖片生成失敗，請檢查 provider 狀態後重試。",
    phase: "failed",
  };
}

function validatedOutput(
  result: Awaited<ReturnType<ImageProvider["generate"]>>,
  providerId: string,
): {
  bytes: Uint8Array;
  extension: "png" | "jpg" | "svg";
  parameters: Record<string, unknown>;
} {
  if (result.bytes.byteLength === 0 || result.bytes.byteLength > 25 * 1024 * 1024)
    throw new Error("Provider returned an invalid image size");
  let extension: "png" | "jpg" | "svg";
  const bytes = result.bytes;
  if (
    result.mediaType === "image/png" &&
    result.extension === "png" &&
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  ) {
    extension = "png";
  } else if (
    result.mediaType === "image/jpeg" &&
    ["jpg", "jpeg"].includes(result.extension) &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    extension = "jpg";
  } else if (
    providerId === "mock-image" &&
    result.mediaType === "image/svg+xml" &&
    result.extension === "svg"
  ) {
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      !/^<svg\s/i.test(svg.trim()) ||
      /<(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|\/\/)/i.test(
        svg,
      )
    ) {
      throw new Error("Mock provider returned unsafe SVG");
    }
    extension = "svg";
  } else {
    throw new Error("Provider returned an unsupported or mismatched image format");
  }
  let parameters: unknown;
  try {
    const serialized = JSON.stringify(result.parameters);
    if (serialized.length > 65_536) throw new Error("Provider parameters are too large");
    parameters = JSON.parse(serialized);
  } catch {
    throw new Error("Provider parameters must be JSON-safe");
  }
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    throw new Error("Provider parameters must be an object");
  return { bytes, extension, parameters: parameters as Record<string, unknown> };
}

export async function compositeMaskedEdit(
  base: Uint8Array,
  edited: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const normalizedMask = await sharp(mask)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();
  const overlay = await sharp(edited)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .composite([{ input: normalizedMask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return new Uint8Array(
    await sharp(base)
      .resize(width, height, { fit: "fill" })
      .composite([{ input: overlay, blend: "over" }])
      .png()
      .toBuffer(),
  );
}

export class JobRunner {
  readonly #controllers = new Map<string, AbortController>();
  readonly #activeTasks = new Map<string, Promise<void>>();
  readonly #pendingLifecycleWrites = new Set<Promise<void>>();
  readonly #shutdownKeys = new Set<string>();
  readonly #activeByProvider = new Map<string, number>();
  readonly #pendingByProvider = new Map<string, Array<{ projectId: string; jobId: string }>>();
  #accepting = true;
  #shutdownPromise?: Promise<void>;

  constructor(
    private readonly repository: FileProjectRepository,
    private readonly providers: ImageProviderSource,
    private readonly styles?: FileStyleRepository,
  ) {}

  private controllerKey(projectId: string, jobId: string): string {
    return `${projectId}:${jobId}`;
  }

  async enqueue(
    projectId: string,
    slideId: string,
    providerId: string,
    edit?: {
      instruction: string;
      baseVersionId: string;
      maskPath?: string;
      textExtraction?: {
        originalVersionId: string;
        replaceVersionId?: string;
        threshold: number;
        boxes: EditableTextBox[];
      };
    },
  ): Promise<GenerationJob> {
    if (!this.#accepting) throw new Error("SERVER_SHUTTING_DOWN");
    const provider = this.providers.get(providerId);
    if (provider.availability.status !== "available") throw new Error("Provider is unavailable");
    this.providerLimit(provider);
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: randomUUID(),
      projectId,
      slideId,
      providerId,
      status: "queued",
      lifecycleVersion: 1,
      phase: "queued",
      progress: { step: 1, total: 6 },
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      phaseUpdatedAt: now,
      operation: edit?.textExtraction ? "extract-text" : edit ? "edit" : "generate",
      ...(edit
        ? {
            editInstruction: edit.instruction,
            baseVersionId: edit.baseVersionId,
            ...(edit.maskPath ? { maskPath: edit.maskPath } : {}),
            ...(edit.textExtraction ? { textExtraction: edit.textExtraction } : {}),
          }
        : {}),
      ...(provider.timeoutMs ? { timeoutMs: provider.timeoutMs } : {}),
    };
    await this.repository.updateProject(projectId, (project) => {
      if (!this.#accepting) throw new Error("SERVER_SHUTTING_DOWN");
      if (!project.slides.some((slide) => slide.id === slideId)) throw new Error("Slide not found");
      if (
        !provider.capabilities.supportedSizes.some(
          (size) => size.width === project.canvas.width && size.height === project.canvas.height,
        )
      ) {
        throw new Error("Provider does not support this canvas size");
      }
      project.jobs.push(job);
      project.updatedAt = now;
    });
    this.logPhase(job);
    setTimeout(() => {
      this.schedule(projectId, job.id, providerId);
    }, 0);
    return job;
  }

  async cancel(projectId: string, jobId: string): Promise<GenerationJob> {
    const result = await this.repository.updateProject(projectId, (project) => {
      const job = project.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error("Job not found");
      if (job.status === "queued" || job.status === "running") {
        const wasRunning = job.status === "running";
        job.status = "cancelled";
        job.phase = "cancelled";
        job.errorCode = "CANCELLED";
        job.error = "生成工作已取消。";
        job.progress = { step: 6, total: 6 };
        job.updatedAt = new Date().toISOString();
        job.phaseUpdatedAt = job.updatedAt;
        job.finishedAt = job.updatedAt;
        if (wasRunning && job.childLifecycle?.spawnedAt && !job.childLifecycle.exitedAt) {
          job.childLifecycle.cancelRequestedAt = job.updatedAt;
        }
        project.updatedAt = job.updatedAt;
      }
      const result = structuredClone(job);
      queueMicrotask(() => this.logPhase(result));
      return result;
    });
    this.#controllers.get(this.controllerKey(projectId, jobId))?.abort();
    return result;
  }

  async cancelProject(projectId: string): Promise<void> {
    const project = await this.repository.loadProject(projectId);
    if (!project) return;
    const active = project.jobs.filter(
      (job) => job.status === "queued" || job.status === "running",
    );
    await Promise.all(active.map((job) => this.cancel(projectId, job.id).catch(() => undefined)));
  }

  async recoverInterruptedJobs(): Promise<void> {
    for (const project of await this.repository.listProjects()) {
      const queued = await this.repository.updateProject(project.id, (current) => {
        const queued: Array<{ jobId: string; providerId: string }> = [];
        for (const job of current.jobs) {
          if (job.status === "running") {
            job.status = "failed";
            job.phase = "failed";
            job.errorCode = "SERVER_RESTARTED";
            job.error = "Server 重新啟動，請重試這一頁。";
            job.progress = { step: 6, total: 6 };
            job.updatedAt = new Date().toISOString();
            job.phaseUpdatedAt = job.updatedAt;
            job.finishedAt = job.updatedAt;
            if (job.childLifecycle?.spawnedAt && !job.childLifecycle.exitedAt) {
              job.childLifecycle.recoveredAt = job.updatedAt;
              delete job.childLifecycle.exitClass;
            }
            current.updatedAt = job.updatedAt;
          } else if (job.status === "queued")
            queued.push({ jobId: job.id, providerId: job.providerId });
        }
        return queued;
      });
      for (const { jobId, providerId } of queued) {
        setTimeout(() => {
          this.schedule(project.id, jobId, providerId);
        }, 0);
      }
    }
  }

  private schedule(projectId: string, jobId: string, providerId: string): void {
    if (!this.#accepting) return;
    let provider: ImageProvider;
    let limit: number;
    try {
      provider = this.providers.get(providerId);
      limit = this.providerLimit(provider);
    } catch {
      void this.failUnsettledJob(
        projectId,
        jobId,
        "Configured provider is unavailable or has invalid concurrency settings",
      );
      return;
    }
    const active = this.#activeByProvider.get(providerId) ?? 0;
    if (active >= limit) {
      this.#pendingByProvider.set(providerId, [
        ...(this.#pendingByProvider.get(providerId) ?? []),
        { projectId, jobId },
      ]);
      return;
    }
    this.#activeByProvider.set(providerId, active + 1);
    const key = this.controllerKey(projectId, jobId);
    const task = this.run(projectId, jobId)
      .then(
        () => undefined,
        async () => {
          await this.failUnsettledJob(
            projectId,
            jobId,
            "Job runner failed before generation could complete",
          );
        },
      )
      .finally(() => {
        this.#activeTasks.delete(key);
        this.releaseProviderSlot(providerId);
      });
    this.#activeTasks.set(key, task);
  }

  private releaseProviderSlot(providerId: string): void {
    const remaining = Math.max(0, (this.#activeByProvider.get(providerId) ?? 1) - 1);
    this.#activeByProvider.set(providerId, remaining);
    const queue = this.#pendingByProvider.get(providerId);
    const next = queue?.shift();
    if (queue?.length === 0) this.#pendingByProvider.delete(providerId);
    if (next && this.#accepting) this.schedule(next.projectId, next.jobId, providerId);
  }

  private providerLimit(provider: ImageProvider): number {
    const limit = provider.maxConcurrency ?? 1;
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new Error("Provider maxConcurrency must be an integer between 1 and 32");
    }
    return limit;
  }

  private async updateProviderProgress(
    projectId: string,
    jobId: string,
    progress: ImageGenerationProgress,
  ): Promise<void> {
    const allowedPhases = ["launching", "waiting_for_codex", "validating_output"] as const;
    if (!allowedPhases.includes(progress.phase as (typeof allowedPhases)[number])) return;
    const phase = progress.phase as (typeof allowedPhases)[number];
    const eventCode = ["turn_started", "item_completed", "turn_completed"].includes(
      String(progress.eventCode),
    )
      ? progress.eventCode
      : undefined;
    await this.repository.updateProject(projectId, (project) => {
      const job = project.jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "running") return;
      if ((job.progress?.step ?? 0) > PHASE_STEP[phase]) return;
      if (job.phase === phase && (!eventCode || job.providerEventCode === eventCode)) return;
      job.phase = phase;
      job.progress = { step: PHASE_STEP[phase], total: 6 };
      if (eventCode) job.providerEventCode = eventCode;
      job.phaseUpdatedAt = new Date().toISOString();
      if (eventCode) {
        job.childLifecycle ??= {};
        job.childLifecycle.lastAllowedEventAt = job.phaseUpdatedAt;
      }
      job.updatedAt = job.phaseUpdatedAt;
      project.updatedAt = job.updatedAt;
      queueMicrotask(() => this.logPhase(structuredClone(job)));
    });
  }

  private async setPhase(projectId: string, jobId: string, phase: "persisting"): Promise<void> {
    await this.repository.updateProject(projectId, (project) => {
      const job = project.jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "running") return;
      job.phase = phase;
      job.progress = { step: PHASE_STEP[phase], total: 6 };
      job.phaseUpdatedAt = new Date().toISOString();
      job.updatedAt = job.phaseUpdatedAt;
      project.updatedAt = job.updatedAt;
      queueMicrotask(() => this.logPhase(structuredClone(job)));
    });
  }

  private async updateChildLifecycle(
    projectId: string,
    jobId: string,
    event:
      | { type: "spawned" }
      | { type: "exited"; exitClass: "success" | "nonzero" | "timeout" | "aborted" },
  ): Promise<void> {
    if (
      event.type === "exited" &&
      !["success", "nonzero", "timeout", "aborted"].includes(event.exitClass)
    )
      return;
    const key = this.controllerKey(projectId, jobId);
    try {
      await this.repository.updateProject(projectId, (project) => {
        const job = project.jobs.find((candidate) => candidate.id === jobId);
        const shutdownExit = event.type === "exited" && this.#shutdownKeys.has(key);
        const cancelExit =
          event.type === "exited" && job?.status === "cancelled" && job.errorCode === "CANCELLED";
        if (!job || (job.status !== "running" && !shutdownExit && !cancelExit)) return;
        const now = new Date().toISOString();
        job.childLifecycle ??= {};
        if (event.type === "spawned") job.childLifecycle.spawnedAt ??= now;
        else {
          job.childLifecycle.exitedAt ??= now;
          // The server-owned shutdown intent has precedence over the provider's
          // local AbortSignal classification, including when close races persistence.
          job.childLifecycle.exitClass = shutdownExit ? "server_shutdown" : event.exitClass;
        }
        job.updatedAt = now;
        project.updatedAt = now;
      });
    } finally {
      // Shutdown keys intentionally live until process exit so an async close observer
      // cannot race the terminal SERVER_SHUTDOWN classification.
    }
  }

  private observeChildLifecycle(
    projectId: string,
    jobId: string,
    event:
      | { type: "spawned" }
      | { type: "exited"; exitClass: "success" | "nonzero" | "timeout" | "aborted" },
  ): Promise<void> {
    const write = this.updateChildLifecycle(projectId, jobId, event);
    this.#pendingLifecycleWrites.add(write);
    void write.finally(() => this.#pendingLifecycleWrites.delete(write)).catch(() => undefined);
    return write;
  }

  shutdown(graceMs = 3_000): Promise<void> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 100 || graceMs > 30_000)
      throw new Error("Shutdown graceMs is out of range");
    this.#accepting = false;
    const requestedAt = new Date().toISOString();
    for (const [key, controller] of this.#controllers) {
      this.#shutdownKeys.add(key);
    }
    this.#shutdownPromise ??= this.performShutdown(graceMs, requestedAt);
    // Persistence is started synchronously before abort callbacks can report a
    // child close; the shutdown key still provides the authoritative class.
    for (const controller of this.#controllers.values()) controller.abort();
    return this.#shutdownPromise;
  }

  private async performShutdown(graceMs: number, now: string): Promise<void> {
    this.#pendingByProvider.clear();
    for (const project of await this.repository.listProjects()) {
      await this.repository.updateProject(project.id, (current) => {
        for (const job of current.jobs) {
          if (job.status !== "queued" && job.status !== "running") continue;
          const wasRunning = job.status === "running";
          job.status = "failed";
          job.phase = "failed";
          job.errorCode = "SERVER_SHUTDOWN";
          job.error = "Server 正在關閉，生成工作已停止。";
          job.progress = { step: 6, total: 6 };
          job.updatedAt = now;
          job.phaseUpdatedAt = now;
          job.finishedAt = now;
          if (wasRunning) {
            job.childLifecycle ??= {};
            job.childLifecycle.shutdownRequestedAt = now;
            this.#shutdownKeys.add(this.controllerKey(project.id, job.id));
          }
          queueMicrotask(() => this.logPhase(structuredClone(job)));
        }
        current.updatedAt = now;
      });
    }
    const deadline = Date.now() + graceMs;
    const waitWithinDeadline = async (promises: readonly Promise<unknown>[]) => {
      if (promises.length === 0) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(promises).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await waitWithinDeadline([...this.#activeTasks.values()]);
    // Lifecycle observers may be deliberately fire-and-forget in providers.
    // Drain every write observed before the same shutdown deadline.
    while (this.#pendingLifecycleWrites.size > 0 && Date.now() < deadline) {
      await waitWithinDeadline([...this.#pendingLifecycleWrites]);
    }
  }

  private logPhase(job: GenerationJob): void {
    const started = Date.parse(job.startedAt ?? job.createdAt);
    console.log(
      JSON.stringify({
        event: "slide_job_phase",
        jobId: job.id,
        projectId: job.projectId,
        slideId: job.slideId,
        providerId: job.providerId,
        phase: job.phase ?? job.status,
        step: job.progress?.step,
        total: job.progress?.total,
        elapsedMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined,
        errorCode: job.errorCode,
      }),
    );
  }

  private async failUnsettledJob(projectId: string, jobId: string, _error: string): Promise<void> {
    try {
      await this.repository.updateProject(projectId, (project) => {
        const job = project.jobs.find((candidate) => candidate.id === jobId);
        if (!job || !["queued", "running"].includes(job.status)) return;
        job.status = "failed";
        job.phase = "failed";
        job.errorCode = "JOB_SCHEDULING_FAILED";
        job.error = "生成工作無法排程，請檢查 provider 設定。";
        job.progress = { step: 6, total: 6 };
        job.updatedAt = new Date().toISOString();
        job.phaseUpdatedAt = job.updatedAt;
        job.finishedAt = job.updatedAt;
        project.updatedAt = job.updatedAt;
        queueMicrotask(() => this.logPhase(structuredClone(job)));
      });
    } catch {
      // The project may have been removed between recovery and scheduling.
    }
  }

  private async run(projectId: string, jobId: string): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(this.controllerKey(projectId, jobId), controller);
    const context = await this.repository.updateProject(projectId, (project) => {
      const job = project.jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "queued") return undefined;
      const slide = project.slides.find((candidate) => candidate.id === job.slideId);
      if (!slide) return undefined;
      job.status = "running";
      job.phase = "preparing";
      job.progress = { step: 2, total: 6 };
      job.attempt += 1;
      job.updatedAt = new Date().toISOString();
      job.phaseUpdatedAt = job.updatedAt;
      job.startedAt ??= job.updatedAt;
      delete job.error;
      delete job.errorCode;
      queueMicrotask(() => this.logPhase(structuredClone(job)));
      return {
        job: structuredClone(job),
        slide: structuredClone(slide),
        project: structuredClone(project),
      };
    });
    if (!context) {
      this.#controllers.delete(this.controllerKey(projectId, jobId));
      return;
    }
    let persisting = false;
    let resultPersisted = false;
    const generatedAssets = new Set<string>();
    try {
      const { project, slide, job } = context;
      const provider = this.providers.get(job.providerId);
      const selectedSources = project.sources.filter(
        (source) =>
          slide.sourceIds.includes(source.id) &&
          source.allowModelAccess &&
          source.usage !== "exclude-from-generation",
      );
      const styleReferences = this.styles
        ? project.styleSnapshot.referenceImages.map((reference) => ({
            path: this.styles!.referenceAssetPath(reference.assetPath),
            mediaType: reference.mediaType,
            role: "style" as const,
            name: reference.name,
          }))
        : [];
      const contentReferences = selectedSources
        .filter((source) =>
          ["visual-reference", "style-reference", "direct-asset"].includes(source.usage),
        )
        .map((source) => ({
          path: this.repository.assetPath(projectId, source.assetPath.replace(/^assets\//, "")),
          mediaType: source.mediaType,
          role: (source.usage === "style-reference"
            ? "style"
            : source.usage === "direct-asset"
              ? "direct-asset"
              : "content") as "style" | "content" | "direct-asset",
          name: source.name,
        }));
      const references = [...styleReferences, ...contentReferences];
      let edit;
      if (job.operation === "edit" || job.operation === "extract-text") {
        const baseVersion = slide.versions.find((version) => version.id === job.baseVersionId);
        if (!baseVersion || !job.editInstruction) throw new Error("EDIT_BASE_VERSION_MISSING");
        const basePath =
          job.operation === "edit" && baseVersion.textLayer
            ? baseVersion.textLayer.backgroundPath
            : baseVersion.imagePath;
        const baseRelative = basePath.replace(/^assets\//, "");
        const baseMediaType = /\.jpe?g$/i.test(baseRelative) ? "image/jpeg" : "image/png";
        references.unshift({
          path: this.repository.assetPath(projectId, baseRelative),
          mediaType: baseMediaType,
          role: "content",
          name: "Current slide image",
        });
        const baseImageIndex = 0;
        let maskImageIndex: number | undefined;
        if (job.maskPath) {
          references.splice(1, 0, {
            path: this.repository.assetPath(projectId, job.maskPath.replace(/^assets\//, "")),
            mediaType: "image/png",
            role: "content",
            name: "Edit mask",
          });
          maskImageIndex = 1;
        }
        edit = {
          instruction: job.editInstruction,
          baseImageIndex,
          ...(maskImageIndex === undefined ? {} : { maskImageIndex }),
          ...(job.operation === "extract-text" ? { purpose: "text-removal" as const } : {}),
        };
      }
      // Base/mask images are intrinsic edit inputs, not optional reference-image
      // capability. Only gate supplemental style/content references here.
      const supplementalReferences = edit
        ? references.filter(
            (_reference, index) => index !== edit.baseImageIndex && index !== edit.maskImageIndex,
          )
        : references;
      if (supplementalReferences.length && !provider.capabilities.referenceImages)
        throw new Error("STYLE_REFERENCES_UNSUPPORTED");
      if (supplementalReferences.length > 1 && !provider.capabilities.multipleReferenceImages)
        throw new Error("MULTIPLE_REFERENCES_UNSUPPORTED");
      const result = await provider.generate(
        {
          projectId,
          slide,
          style: project.styleSnapshot,
          width: project.canvas.width,
          height: project.canvas.height,
          references,
          model: provider.id === "mock-image" ? "mock-svg-v1" : "codex-imagegen",
          parameters: {},
          ...(edit ? { edit } : {}),
        },
        {
          signal: controller.signal,
          onProgress: async (progress) => this.updateProviderProgress(projectId, jobId, progress),
          onLifecycle: async (event) => this.observeChildLifecycle(projectId, jobId, event),
        },
      );
      if (controller.signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
      let safe = validatedOutput(result, provider.id);
      if (
        (job.operation === "edit" || job.operation === "extract-text") &&
        job.maskPath &&
        job.baseVersionId
      ) {
        const baseVersion = slide.versions.find((version) => version.id === job.baseVersionId)!;
        const basePath =
          job.operation === "edit" && baseVersion.textLayer
            ? baseVersion.textLayer.backgroundPath
            : baseVersion.imagePath;
        const [baseBytes, maskBytes] = await Promise.all([
          readFile(this.repository.assetPath(projectId, basePath.replace(/^assets\//, ""))),
          readFile(this.repository.assetPath(projectId, job.maskPath.replace(/^assets\//, ""))),
        ]);
        safe = {
          bytes: await compositeMaskedEdit(
            new Uint8Array(baseBytes),
            safe.bytes,
            new Uint8Array(maskBytes),
            project.canvas.width,
            project.canvas.height,
          ),
          extension: "png",
          parameters: { ...safe.parameters, maskedEdit: true },
        };
      }
      persisting = true;
      await this.setPhase(projectId, jobId, "persisting");
      const versionId = job.textExtraction?.replaceVersionId ?? randomUUID();
      // 在 replaceVersionId 流程中 versionId 不變、檔名重複，會覆蓋同一張背景圖；
      // 加上 randomUUID 後每次生成都是獨立 URL，避免 immutable cache 顯示舊背景。
      const filename = `${slide.id}/${versionId}-${randomUUID()}.${safe.extension}`;
      const backgroundPath = await this.repository.saveAsset(projectId, filename, safe.bytes);
      generatedAssets.add(backgroundPath);
      const baseVersion = slide.versions.find((version) => version.id === job.baseVersionId);
      let imagePath = backgroundPath;
      let textLayer =
        job.operation === "extract-text" && job.textExtraction
          ? {
              originalVersionId: job.textExtraction.originalVersionId,
              backgroundPath,
              compositePath: backgroundPath,
              threshold: job.textExtraction.threshold,
              renderRevision: 0,
              boxes: structuredClone(job.textExtraction.boxes),
              extractedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          : job.operation === "edit" && baseVersion?.textLayer
            ? {
                ...structuredClone(baseVersion.textLayer),
                backgroundPath,
                compositePath: backgroundPath,
                renderRevision: baseVersion.textLayer.renderRevision + 1,
                updatedAt: new Date().toISOString(),
              }
            : undefined;
      if (textLayer) {
        textLayer.compositePath = await renderComposite(this.repository, project, textLayer);
        generatedAssets.add(textLayer.compositePath);
        imagePath = textLayer.compositePath;
      }
      // 編輯／抽字是在既有版本上動刀，大綱沿用被編輯的那一版；重新生成才用當下的大綱。
      const outlineBase = job.operation !== "generate" ? baseVersion : undefined;
      const generatedOutline = structuredClone(
        outlineBase?.outlineSnapshot ?? outlineSnapshot(slide),
      );
      // 指定清單與 outlineSnapshot 同源，兩者要指向同一個時間點。記下來，還原版本時才有辦法
      // 把當時生效的指定一起帶回去，而不是讓它在還原後無聲消失。
      const generatedPins = [
        ...(outlineBase?.outlineSnapshot
          ? (outlineBase.pinnedSourceIds ?? [])
          : slide.pinnedSourceIds),
      ];
      const staleAssets = await this.repository.updateProject(projectId, (current) => {
        const currentJob = current.jobs.find((candidate) => candidate.id === jobId);
        const currentSlide = current.slides.find((candidate) => candidate.id === slide.id);
        if (!currentJob || !currentSlide)
          throw new Error("Project changed while generation was running");
        if (currentJob.status !== "running") return undefined;
        const nextVersion = {
          id: versionId,
          imagePath,
          prompt: job.operation !== "generate" ? job.editInstruction! : currentSlide.imagePrompt,
          providerId: provider.id,
          model: result.model,
          ...(current.combinationId ? { combinationId: current.combinationId } : {}),
          parameters: safe.parameters,
          styleVersion: current.styleSnapshot.version,
          outlineSnapshot: generatedOutline,
          pinnedSourceIds: generatedPins,
          sources: selectedSources.map((source) => ({
            sourceId: source.id,
            title: source.name,
            ...(source.chunks[0]?.locator ? { locator: source.chunks[0].locator } : {}),
            ...(source.chunks[0]?.text ? { excerpt: source.chunks[0].text.slice(0, 500) } : {}),
            ...(source.metadata.url ? { url: source.metadata.url } : {}),
            capturedAt: new Date().toISOString(),
          })),
          createdAt: new Date().toISOString(),
          ...(textLayer ? { textLayer } : {}),
          ...(job.operation === "edit"
            ? { label: `Edited: ${job.editInstruction!.slice(0, 80)}` }
            : {}),
          ...(job.operation === "extract-text" ? { label: "文字抽離" } : {}),
        };
        const replaceIndex =
          job.operation === "extract-text" && job.textExtraction?.replaceVersionId
            ? currentSlide.versions.findIndex(
                (version) => version.id === job.textExtraction!.replaceVersionId,
              )
            : -1;
        const staleCandidates = new Set<string>();
        if (replaceIndex >= 0) {
          const previous = currentSlide.versions[replaceIndex]!;
          staleCandidates.add(previous.imagePath);
          if (previous.textLayer) {
            staleCandidates.add(previous.textLayer.backgroundPath);
            staleCandidates.add(previous.textLayer.compositePath);
          }
          currentSlide.versions[replaceIndex] = {
            ...nextVersion,
            createdAt: previous.createdAt,
          };
        } else currentSlide.versions.push(nextVersion);
        currentSlide.currentVersionId = versionId;
        currentSlide.outlineDirty =
          job.operation !== "generate"
            ? currentSlide.outlineDirty || !sameOutline(currentSlide, generatedOutline)
            : !sameOutline(currentSlide, generatedOutline);
        currentJob.status = "completed";
        currentJob.phase = "completed";
        currentJob.progress = { step: 6, total: 6 };
        currentJob.resultVersionId = versionId;
        currentJob.updatedAt = new Date().toISOString();
        currentJob.phaseUpdatedAt = currentJob.updatedAt;
        currentJob.finishedAt = currentJob.updatedAt;
        current.updatedAt = currentJob.updatedAt;
        queueMicrotask(() => this.logPhase(structuredClone(currentJob)));
        const referencedAssets = new Set(
          current.slides.flatMap((candidate) =>
            candidate.versions.flatMap((version) => [
              version.imagePath,
              ...(version.textLayer
                ? [version.textLayer.backgroundPath, version.textLayer.compositePath]
                : []),
            ]),
          ),
        );
        return [...staleCandidates].filter((assetPath) => !referencedAssets.has(assetPath));
      });
      const completed = staleAssets !== undefined;
      resultPersisted = completed;
      await Promise.allSettled(
        (completed ? staleAssets : [...generatedAssets]).map((assetPath) =>
          this.repository.deleteAsset(projectId, assetPath),
        ),
      );
    } catch (error) {
      if (!resultPersisted)
        await Promise.allSettled(
          [...generatedAssets].map((assetPath) =>
            this.repository.deleteAsset(projectId, assetPath),
          ),
        );
      const shutdownRequested = this.#shutdownKeys.has(this.controllerKey(projectId, jobId));
      const failure = shutdownRequested
        ? {
            code: "SERVER_SHUTDOWN",
            message: "Server 正在關閉，生成工作已停止。",
            phase: "failed" as const,
          }
        : safeFailure(error, controller.signal.aborted, persisting);
      await this.repository.updateProject(projectId, (project) => {
        const job = project.jobs.find((candidate) => candidate.id === jobId);
        if (!job || job.status !== "running") return;
        job.status = failure.phase;
        job.phase = failure.phase;
        job.progress = { step: 6, total: 6 };
        job.errorCode = failure.code;
        job.error = failure.message;
        job.updatedAt = new Date().toISOString();
        job.phaseUpdatedAt = job.updatedAt;
        job.finishedAt = job.updatedAt;
        if (shutdownRequested) {
          job.childLifecycle ??= {};
          job.childLifecycle.shutdownRequestedAt ??= job.updatedAt;
        }
        project.updatedAt = job.updatedAt;
        queueMicrotask(() => this.logPhase(structuredClone(job)));
      });
    } finally {
      this.#controllers.delete(this.controllerKey(projectId, jobId));
    }
  }
}

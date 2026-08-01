import { randomUUID } from "node:crypto";
import type { Express } from "express";
import sharp from "sharp";
import { z } from "zod";
import { idSchema } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/**
 * 單頁的生圖與遮罩編輯。
 *
 * 與同檔的 {@link registerDeckGenerationRoutes} 分成兩個 registrar：原檔裡抽字家族
 * （OCR status／extract-text／text-layer）就夾在這兩群之間，那是下一批才搬的深水區。
 */
export function registerSlideGenerationRoutes(app: Express, ctx: AppContext): void {
  const { repository, runtime, jobs, readiness } = ctx;
  const { resolveImageProviderId, refreshStyleForGeneration } = ctx;

  app.post("/api/projects/:projectId/slides/:slideId/generate", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const slideId = idSchema.parse(request.params.slideId);
    const { providerId: explicitProviderId, acceptUnknownReadiness } = z
      .object({
        providerId: z.string().optional(),
        acceptUnknownReadiness: z.boolean().default(false),
      })
      .parse(request.body ?? {});
    const providerId = await resolveImageProviderId(projectId, explicitProviderId);
    await readiness.assertCanGenerate(providerId, acceptUnknownReadiness);
    await refreshStyleForGeneration(projectId, providerId);
    const job = await jobs.enqueue(projectId, slideId, providerId);
    response.status(202).json(job);
  });

  app.post("/api/projects/:projectId/slides/:slideId/edit-image", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const slideId = idSchema.parse(request.params.slideId);
    const { providerId, instruction, maskDataUrl, acceptUnknownReadiness } = z
      .object({
        providerId: z.string().default("mock-image"),
        instruction: z.string().trim().min(1).max(2_000),
        maskDataUrl: z.string().max(7_000_000).optional(),
        acceptUnknownReadiness: z.boolean().default(false),
      })
      .parse(request.body ?? {});
    await readiness.assertCanGenerate(providerId, acceptUnknownReadiness);
    const provider = runtime.imageProvider(providerId);
    if (!provider.capabilities.imageEditing) throw new Error("IMAGE_EDITING_UNSUPPORTED");
    if (maskDataUrl && !provider.capabilities.maskedEditing)
      throw new Error("MASKED_EDITING_UNSUPPORTED");
    await refreshStyleForGeneration(projectId, providerId);
    const project = await repository.loadProject(projectId);
    if (!project) throw new Error("Project not found");
    const slide = project.slides.find((candidate) => candidate.id === slideId);
    const baseVersion = slide?.versions.find((version) => version.id === slide.currentVersionId);
    if (!slide || !baseVersion) throw new Error("EDIT_BASE_VERSION_MISSING");
    let maskPath: string | undefined;
    if (maskDataUrl) {
      const match = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/.exec(maskDataUrl);
      if (!match) throw new Error("EDIT_MASK_INVALID");
      const bytes = new Uint8Array(Buffer.from(match[1]!, "base64"));
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error("EDIT_MASK_INVALID");
      const metadata = await sharp(bytes).metadata();
      if (
        metadata.format !== "png" ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > 4096 ||
        metadata.height > 4096
      )
        throw new Error("EDIT_MASK_INVALID");
      // 正規化到 canvas 尺寸：前端可能送 960×540，而 OpenAI /images/edits 要求 mask 與
      // image 同尺寸，下游各通道也才不必各自 resize。kernel:"nearest" 是必要的——遮罩是
      // 二值的，而放大（960→1920）走的是 bicubic，會在邊緣 overshoot 出半透明過渡帶，
      // 那些半透明像素在 compositeMaskedEdit 的 dest-in 之後會變成邊界鬼影。
      // 格式／尺寸驗證在正規化之前。
      const normalized = await sharp(bytes)
        .resize(project.canvas.width, project.canvas.height, { fit: "fill", kernel: "nearest" })
        .png()
        .toBuffer();
      maskPath = await repository.saveAsset(
        projectId,
        `edit-masks/${randomUUID()}.png`,
        new Uint8Array(normalized),
      );
    }
    const job = await jobs.enqueue(projectId, slideId, providerId, {
      instruction,
      baseVersionId: baseVersion.id,
      ...(maskPath ? { maskPath } : {}),
    });
    response.status(202).json(job);
  });
}

/** 整份簡報的批次生成與 job 取消。 */
export function registerDeckGenerationRoutes(app: Express, ctx: AppContext): void {
  const { repository, jobs, readiness } = ctx;
  const { resolveImageProviderId, refreshStyleForGeneration } = ctx;

  app.post("/api/projects/:projectId/generate", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const {
      providerId: explicitProviderId,
      acceptUnknownReadiness,
      slideIds,
    } = z
      .object({
        providerId: z.string().optional(),
        acceptUnknownReadiness: z.boolean().default(false),
        slideIds: z.array(idSchema).optional(),
      })
      .parse(request.body ?? {});
    const providerId = await resolveImageProviderId(projectId, explicitProviderId);
    await readiness.assertCanGenerate(providerId, acceptUnknownReadiness);
    await refreshStyleForGeneration(projectId, providerId);
    const project = await repository.loadProject(projectId);
    if (!project) throw new Error("Project not found");
    const targets = slideIds ?? project.slides.map((slide) => slide.id);
    if (!targets.length || targets.some((id) => !project.slides.some((slide) => slide.id === id)))
      throw new Error("INVALID_SLIDE_SELECTION");
    await repository.updateProject(projectId, (current) => {
      current.workflowStage = "editing";
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    const queued = [];
    for (const slideId of targets) queued.push(await jobs.enqueue(projectId, slideId, providerId));
    response.status(202).json(queued);
  });

  app.post("/api/projects/:projectId/jobs/:jobId/cancel", async (request, response) => {
    const job = await jobs.cancel(
      idSchema.parse(request.params.projectId),
      idSchema.parse(request.params.jobId),
    );
    response.json(job);
  });
}

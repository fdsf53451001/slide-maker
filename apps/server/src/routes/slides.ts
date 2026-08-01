import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { slideSpecFieldsSchema, slideSpecSchema } from "@slide-maker/core";
import { asPersisted, idSchema, preserveCurrentOutlineSnapshot } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/**
 * 單頁欄位的部分更新。
 *
 * 刻意與同檔的 {@link registerSlideCollectionRoutes} 分成兩個 registrar：原檔裡「單頁
 * 重生大綱」那條 route 就夾在這兩群之間，而它屬於下一批才搬的深水區。合成一個 registrar
 * 會讓註冊順序與原檔不同——路徑雖然互斥、理論上無感，但這批的驗收標準是 router stack
 * 逐行相同，不靠「理論上」。
 */
export function registerSlidePatchRoute(app: Express, ctx: AppContext): void {
  const { repository } = ctx;

  app.patch("/api/projects/:projectId/slides/:slideId", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const slideId = idSchema.parse(request.params.slideId);
    const patch = slideSpecFieldsSchema
      .pick({
        purpose: true,
        content: true,
        narrative: true,
        layoutHint: true,
        imagePrompt: true,
        dataBasis: true,
        sourceIds: true,
        pinnedSourceIds: true,
        styleOverride: true,
        hidden: true,
      })
      .partial()
      .parse(request.body);
    const project = await repository.updateProject(projectId, (current) => {
      const slide = current.slides.find((candidate) => candidate.id === slideId);
      if (!slide) throw new Error("Slide not found");
      // pinnedSourceIds 不列入：它只影響下次重生成大綱的優先序，不改變已生成的圖，
      // 單獨改它不該讓這一頁被標成「與圖不同步」。
      // hidden 同理且更明確：隱藏只決定這一頁上不上場，一個像素都沒動到圖。
      const outlineFields = [
        "purpose",
        "content",
        "narrative",
        "layoutHint",
        "imagePrompt",
        "sourceIds",
      ] as const;
      const outlineChanged = outlineFields.some(
        (field) => field in patch && JSON.stringify(patch[field]) !== JSON.stringify(slide[field]),
      );
      if (outlineChanged) preserveCurrentOutlineSnapshot(slide);
      Object.assign(slide, patch);
      if (outlineChanged) slide.outlineDirty = true;
      current.updatedAt = new Date().toISOString();
      // 部分更新無從檢查跨欄位關係（例如只送 pinnedSourceIds 時看不到 sourceIds），
      // 所以夾在 schema：這裡的解析結果就是等一下會落地的那一份。
      return asPersisted(current);
    });
    return response.json(project);
  });
}

/** 單頁的新增／複製／刪除／重排。 */
export function registerSlideCollectionRoutes(app: Express, ctx: AppContext): void {
  const { repository } = ctx;

  app.post("/api/projects/:projectId/slides", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const input = slideSpecFieldsSchema
      .pick({
        purpose: true,
        content: true,
        narrative: true,
        layoutHint: true,
        imagePrompt: true,
        dataBasis: true,
        sourceIds: true,
      })
      .partial()
      .extend({ afterSlideId: idSchema.optional() })
      .parse(request.body ?? {});
    const project = await repository.updateProject(projectId, (current) => {
      const insertAt = input.afterSlideId
        ? current.slides.findIndex((slide) => slide.id === input.afterSlideId) + 1
        : current.slides.length;
      if (input.afterSlideId && insertAt === 0) throw new Error("Slide not found");
      const created = slideSpecSchema.parse({
        id: randomUUID(),
        order: insertAt,
        purpose: input.purpose ?? "",
        content: input.content ?? "",
        narrative: input.narrative ?? "",
        layoutHint: input.layoutHint ?? "",
        dataBasis: input.dataBasis ?? [],
        imagePrompt: input.imagePrompt ?? "",
        sourceIds: input.sourceIds ?? [],
        versions: [],
      });
      current.slides.splice(insertAt, 0, created);
      current.slides.forEach((slide, order) => {
        slide.order = order;
      });
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.status(201).json(project);
  });

  app.post("/api/projects/:projectId/slides/:slideId/duplicate", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const slideId = idSchema.parse(request.params.slideId);
    const project = await repository.updateProject(projectId, (current) => {
      const index = current.slides.findIndex((slide) => slide.id === slideId);
      if (index < 0) throw new Error("Slide not found");
      const source = current.slides[index]!;
      // 版本一起複製，否則複製出來的頁是空白的（沒有圖，也沒有可還原的歷史）。
      // 版本 id 必須重新配發：`VERSION_HAS_ACTIVE_JOB` 與 text-layer 的引用檢查都不限
      // slideId，共用 id 會讓兩頁互相鎖住彼此的版本。
      const versionIdMap = new Map(source.versions.map((version) => [version.id, randomUUID()]));
      const duplicate = {
        ...structuredClone(source),
        id: randomUUID(),
        // 資產路徑刻意共用、不複製檔案：所有寫入端（重生成、text-layer 重繪）都是產生
        // 新檔而非就地覆寫，而回收一律重算全專案引用（見版本 DELETE），所以共用既不會
        // 互相污染，也不會被誤刪。
        versions: source.versions.map((version) => ({
          ...structuredClone(version),
          id: versionIdMap.get(version.id)!,
          ...(version.textLayer
            ? {
                textLayer: {
                  ...structuredClone(version.textLayer),
                  // 指向同頁原圖版本的配對要跟著搬到複製出來的那一份；指到別頁的
                  // （目前不會發生）維持原值，總比指向不存在的 id 好。
                  originalVersionId:
                    versionIdMap.get(version.textLayer.originalVersionId) ??
                    version.textLayer.originalVersionId,
                },
              }
            : {}),
        })),
        order: index + 1,
      };
      if (source.currentVersionId) {
        const currentVersionId = versionIdMap.get(source.currentVersionId);
        if (currentVersionId) duplicate.currentVersionId = currentVersionId;
        else delete duplicate.currentVersionId;
      }
      current.slides.splice(index + 1, 0, duplicate);
      current.slides.forEach((slide, order) => {
        slide.order = order;
      });
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.status(201).json(project);
  });

  app.delete("/api/projects/:projectId/slides/:slideId", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const slideId = idSchema.parse(request.params.slideId);
    const project = await repository.updateProject(projectId, (current) => {
      if (current.slides.length <= 1) throw new Error("LAST_SLIDE_CANNOT_BE_DELETED");
      const index = current.slides.findIndex((slide) => slide.id === slideId);
      if (index < 0) throw new Error("Slide not found");
      if (
        current.jobs.some(
          (job) => job.slideId === slideId && ["queued", "running"].includes(job.status),
        )
      )
        throw new Error("SLIDE_HAS_ACTIVE_JOB");
      current.slides.splice(index, 1);
      current.slides.forEach((slide, order) => {
        slide.order = order;
      });
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.json(project);
  });

  app.post("/api/projects/:projectId/slides/reorder", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { slideIds } = z
      .object({ slideIds: z.array(idSchema).min(1).max(100) })
      .parse(request.body);
    const project = await repository.updateProject(projectId, (current) => {
      if (
        new Set(slideIds).size !== current.slides.length ||
        current.slides.some((slide) => !slideIds.includes(slide.id))
      )
        throw new Error("INVALID_SLIDE_ORDER");
      const byId = new Map(current.slides.map((slide) => [slide.id, slide]));
      current.slides = slideIds.map((id, order) => ({ ...byId.get(id)!, order }));
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.json(project);
  });
}

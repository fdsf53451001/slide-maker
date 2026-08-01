import type { Express } from "express";
import { z } from "zod";
import {
  createProject,
  pageNumberSettingsSchema,
  presentationBriefSchema,
  type PresentationBrief,
} from "@slide-maker/core";
import { ModelLibraryError } from "../model-runtime.js";
import { idSchema } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/** 專案基本 CRUD：列表、建立，以及 brief／頁碼／名稱／模型組合的部分更新。 */
export function registerProjectRoutes(app: Express, ctx: AppContext): void {
  const { repository, styles, runtime } = ctx;

  app.get("/api/projects", async (_request, response) =>
    response.json(await repository.listProjects()),
  );

  app.post("/api/projects", async (request, response) => {
    const input = z
      .object({
        topic: z.string().trim().min(1).max(500),
        name: z.string().trim().min(1).max(200).optional(),
        brief: presentationBriefSchema.partial().optional(),
        styleId: idSchema.optional(),
        styleVersion: z.number().int().positive().optional(),
      })
      .parse(request.body);
    const style = input.styleId ? await styles.get(input.styleId, input.styleVersion) : undefined;
    if (input.styleId && !style) throw new Error("Style not found");
    const brief = input.brief
      ? (Object.fromEntries(
          Object.entries(input.brief).filter((entry) => entry[1] !== undefined),
        ) as Partial<PresentationBrief>)
      : undefined;
    const project = createProject({
      topic: input.topic,
      ...(input.name ? { name: input.name } : {}),
      ...(brief ? { brief } : {}),
      ...(style ? { style } : {}),
    });
    await repository.saveProject(project);
    response.status(201).json(project);
  });

  app.patch("/api/projects/:projectId/brief", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const patch = presentationBriefSchema.partial().parse(request.body);
    const project = await repository.updateProject(projectId, (current) => {
      const previousTopic = current.brief.topic;
      current.brief = presentationBriefSchema.parse({ ...current.brief, ...patch });
      current.name = patch.topic && current.name === previousTopic ? patch.topic : current.name;
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.json(project);
  });

  // 巢狀 partial：`background` 只送其中一個欄位時，其餘欄位要保留專案現值而不是被預設值覆蓋，
  // 所以內層也得是 partial（`deepPartial()` 不會穿透帶 `.default()` 的物件欄位）。
  const pageNumberPatchSchema = pageNumberSettingsSchema
    .omit({ background: true })
    .partial()
    .extend({
      background: pageNumberSettingsSchema.shape.background.removeDefault().partial().optional(),
    });

  app.patch("/api/projects/:projectId/page-number", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const patch = pageNumberPatchSchema.parse(request.body);
    const project = await repository.updateProject(projectId, (current) => {
      current.pageNumber = pageNumberSettingsSchema.parse({
        ...current.pageNumber,
        ...patch,
        background: { ...current.pageNumber.background, ...patch.background },
      });
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.json(project);
  });

  app.patch("/api/projects/:projectId/name", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { name } = z.object({ name: z.string().trim().min(1).max(200) }).parse(request.body);
    const project = await repository.updateProject(projectId, (current) => {
      current.name = name;
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.json(project);
  });

  // 專案組合選單：綁定專案要用的模型組合（生成時據此解析影像／文字／搜尋模型）。
  app.patch("/api/projects/:projectId/combination", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { combinationId } = z.object({ combinationId: idSchema }).parse(request.body);
    if (!runtime.library.combinations.some((item) => item.id === combinationId))
      throw new ModelLibraryError("COMBINATION_NOT_FOUND", `找不到模型組合：${combinationId}`);
    const project = await repository.updateProject(projectId, (current) => {
      current.combinationId = combinationId;
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.json(project);
  });
}

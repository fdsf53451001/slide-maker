import express, { type Express } from "express";
import { z } from "zod";
import { sourceUsageSchema } from "@slide-maker/core";
import { shouldDescribeImageSource } from "../image-description.js";
import { asPersisted, idSchema } from "../project-write-helpers.js";
import { assertSourceCapacity, ingestSource, safeFilename, searchSources } from "../sources.js";
import type { AppContext } from "./context.js";

/**
 * 專案來源的列出與上傳。
 *
 * 與同檔的 {@link registerSourceEditRoutes} 分成兩個 registrar：原檔裡「網頁來源」那三條
 * （web-search／web-sources／url-sources）就夾在這兩群之間，合成一個 registrar 會打散註冊順序。
 */
export function registerSourceIntakeRoutes(app: Express, ctx: AppContext): void {
  const { repository, retriever } = ctx;
  const { imageDescriptionProvider, scheduleImageDescription } = ctx;

  app.get("/api/projects/:projectId/sources", async (request, response) => {
    const project = await repository.loadProject(idSchema.parse(request.params.projectId));
    if (!project) throw new Error("Project not found");
    response.json(project.sources);
  });

  app.post(
    "/api/projects/:projectId/sources",
    express.raw({ type: () => true, limit: "100mb" }),
    async (request, response) => {
      const projectId = idSchema.parse(request.params.projectId);
      const input = z
        .object({
          name: z.string().min(1),
          mediaType: z.string().min(1),
          usage: sourceUsageSchema.optional(),
          // **不可用 `z.coerce.boolean()`**：query string 一律是字串，而 `Boolean("false")`
          // 與 `Boolean("0")` 都是 `true`，等於這個欄位永遠關不掉。以前只是「欄位標錯」，
          // 加入圖片描述之後它變成外送決策——`shouldDescribeImageSource()` 的授權閘門會
          // 直接失效，使用者明明選了不給 AI 讀取，圖片照樣送去模型。
          allowModelAccess: z
            .enum(["true", "false"])
            .default("true")
            .transform((value) => value === "true"),
        })
        .parse(request.query);
      const bytes =
        request.body instanceof Buffer ? new Uint8Array(request.body) : new Uint8Array();
      const existing = await repository.loadProject(projectId);
      if (!existing) throw new Error("Project not found");
      assertSourceCapacity(existing.sources, bytes.length);
      const source = await ingestSource(input, bytes, "assets/pending");
      source.assetPath = await repository.saveAsset(
        projectId,
        `sources/${source.id}/${safeFilename(source.name)}`,
        bytes,
      );
      // 圖片的內容描述在背景跑，但「要不要跑」現在就得決定：先標成 parsing，201 的回應
      // 本身就帶著這個狀態，前端不必等下一次輪詢才知道有東西正在分析。
      const describable = shouldDescribeImageSource(source) && !!imageDescriptionProvider(existing);
      if (describable) source.status = "parsing";
      const project = await repository.updateProject(projectId, (current) => {
        // 交易內再驗一次：上面那次是在寫檔之前，兩者之間可能有別的上傳先寫進去。
        assertSourceCapacity(current.sources, source.sizeBytes);
        current.sources.push(source);
        current.updatedAt = new Date().toISOString();
        return structuredClone(current);
      });
      retriever.index(project.id, project.sources);
      if (describable) scheduleImageDescription(project.id, source.id);
      response.status(201).json(project);
    },
  );
}

/** 來源的用途／授權修改、刪除，以及專案內全文檢索。 */
export function registerSourceEditRoutes(app: Express, ctx: AppContext): void {
  const { repository, retriever } = ctx;
  const { imageDescriptionProvider, scheduleImageDescription } = ctx;

  app.patch("/api/projects/:projectId/sources/:sourceId", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const sourceId = idSchema.parse(request.params.sourceId);
    const patch = z
      .object({
        name: z.string().trim().min(1).max(255).optional(),
        usage: sourceUsageSchema.optional(),
        allowModelAccess: z.boolean().optional(),
        /**
         * 改成「視覺參考」時要不要順便補跑一次內容描述。
         *
         * 預設 false，且必須由前端在**跟使用者確認過會呼叫模型、消耗配額**之後才送 true：
         * 這條路是使用者在下拉選單裡改個用途就觸發模型呼叫，靜默地做等於偷花配額。
         */
        describeImage: z.boolean().optional(),
      })
      .parse(request.body);
    let describable = false;
    const project = await repository.updateProject(projectId, (current) => {
      const source = current.sources.find((item) => item.id === sourceId);
      if (!source) throw new Error("Source not found");
      const { describeImage: _requested, ...fields } = patch;
      Object.assign(source, fields, { updatedAt: new Date().toISOString() });
      // 冪等由 shouldDescribeImageSource（已經有文字的不再跑）與這裡的 `parsing` 檢查一起
      // 保證。少了後者有一條可達路徑會讓同一張圖跑兩次：上傳（parsing）→ 改「直接素材」
      // （狀態不會清、在途工作照跑）→ 改回「視覺參考」並同意 → 又排一次。`shouldDescribe`
      // 自己不能檢查 `parsing`，因為背景工作送出前的重新確認正是在 parsing 狀態下做的。
      describable =
        patch.describeImage === true &&
        source.status !== "parsing" &&
        shouldDescribeImageSource(source) &&
        !!imageDescriptionProvider(current);
      if (describable) source.status = "parsing";
      current.updatedAt = source.updatedAt!;
      return structuredClone(current);
    });
    retriever.index(project.id, project.sources);
    if (describable) scheduleImageDescription(project.id, sourceId);
    response.json(project);
  });

  app.delete("/api/projects/:projectId/sources/:sourceId", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const sourceId = idSchema.parse(request.params.sourceId);
    const force = request.query.force === "true";
    let assetPath = "";
    const project = await repository.updateProject(projectId, (current) => {
      const index = current.sources.findIndex((item) => item.id === sourceId);
      if (index < 0) throw new Error("Source not found");
      const references = current.slides.filter((slide) =>
        slide.sourceIds.includes(sourceId),
      ).length;
      if (references && !force) throw new Error(`SOURCE_IN_USE:${references}`);
      assetPath = current.sources[index]!.assetPath;
      current.sources.splice(index, 1);
      // 指定清單不必在這裡另外清：它恆為 sourceIds 的子集（slideSpecSchema 的 transform），
      // 來源一離開 sourceIds，對它的指定就跟著消失。
      for (const slide of current.slides)
        slide.sourceIds = slide.sourceIds.filter((id) => id !== sourceId);
      current.updatedAt = new Date().toISOString();
      return asPersisted(current);
    });
    await repository.deleteAsset(projectId, assetPath);
    retriever.index(project.id, project.sources);
    response.json(project);
  });

  app.get("/api/projects/:projectId/search", async (request, response) => {
    const project = await repository.loadProject(idSchema.parse(request.params.projectId));
    if (!project) throw new Error("Project not found");
    const { q, limit } = z
      .object({
        q: z.string().trim().min(1).max(500),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(request.query);
    // 縱深防禦：索引可能領先專案（大綱生成會先索引尚未落地的網頁來源，失敗時雖會回滾，
    // 但程序被砍就來不及）。過濾發生在 SQL 的 LIMIT 之後，故先過度撈取再截斷，免得孤兒
    // 占掉名額害真實結果不足。
    const owned = new Set(project.sources.map((source) => source.id));
    const results = retriever
      .search(project.id, q, limit * 2)
      .filter((chunk) => owned.has(chunk.sourceId))
      .slice(0, limit);
    response.json(results.length ? results : searchSources(project.sources, q, limit));
  });
}

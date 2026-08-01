import type { Express } from "express";
import { z } from "zod";
import { STYLE_REFERENCE_IMAGE_LIMIT } from "@slide-maker/core";
import { idSchema } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/**
 * `GET /usage` 等待背景記帳收尾的上限。
 *
 * 記帳是 fire-and-forget 的，剛跑完的那一筆可能還在途中；等一下才不會少算。但這個等待
 * **一定要有期限**：少算最後一筆是可接受的誤差，讓統計頁轉不完不是。
 */
const USAGE_SUMMARY_IDLE_MS = 500;

/** 專案層級的設定與讀取：套用風格、風格快照、流程階段、單一專案讀取／用量／刪除。 */
export function registerProjectSettingsRoutes(app: Express, ctx: AppContext): void {
  const { repository, styles, jobs, usageLedger } = ctx;
  const { ownedStyleReferences, writeProjectStyleSnapshot } = ctx;

  app.post("/api/projects/:projectId/style", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const input = z
      .object({ styleId: idSchema, version: z.number().int().positive().optional() })
      .parse(request.body);
    const style = await styles.get(input.styleId, input.version);
    if (!style) throw new Error("Style not found");
    const superseded: string[] = [];
    const project = await repository.updateProject(projectId, (current) => {
      // 整包換掉 styleSnapshot：本地 fork 自己建的那批分析圖從此沒有任何引用，
      // 留著就是 styles/assets 下的孤兒（不在專案目錄裡，刪專案也帶不走）。
      const keep = new Set(style.referenceImages.map((image) => image.id));
      superseded.push(...ownedStyleReferences(current).filter((id) => !keep.has(id)));
      current.styleSnapshot = structuredClone(style);
      // 換掉整個風格＝「AI 自由設計」那次風格決議的結果連同它的降級說明都已經過期。
      // 留著的話：前端會對著一份剛套用的風格說「這份簡報沒有共用的設計系統」，而且
      // `shouldResolveStyleDirection()` 讀到殘留的 `applied:true` 會判定「上次是我們自己
      // 寫的、可以重寫」，下一次重建大綱就把使用者剛選的風格覆蓋掉。
      // 這條不變式有兩個 writer（另一個是 `app.ts` 的 `writeProjectStyleSnapshot()`），
      // 只守一個等於沒守。
      delete current.styleDirection;
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    await Promise.allSettled(superseded.map((id) => styles.deleteReference(id)));
    response.json(project);
  });

  /**
   * 把風格分析結果寫回專案自己的 styleSnapshot（PDF 匯入的分析頁用）。
   * 建參考圖 → 分析 → 寫回的整段交易在 `/api/projects/:projectId/style-analysis`；
   * 這一支只負責寫，給已經有結果（或只想改名／改 avoid）的呼叫端用。
   */
  app.patch("/api/projects/:projectId/style-snapshot", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const patch = z
      .object({
        designSystem: z.string().max(20_000).optional(),
        avoid: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        // 分析用的那幾張頁面圖。存進 snapshot 才有主：否則每按一次「重新分析」
        // 就有 4 張 1920×1080 PNG 躺在 styles/assets 下面，沒有引用、沒有清理路徑，
        // 連刪專案都帶不走（它們不在 project root 底下）。
        referenceIds: z.array(idSchema).max(STYLE_REFERENCE_IMAGE_LIMIT).optional(),
      })
      .parse(request.body ?? {});
    const referenceImages = patch.referenceIds
      ? (await Promise.all(patch.referenceIds.map((id) => styles.referenceMetadata(id)))).filter(
          (image) => image !== undefined,
        )
      : undefined;
    response.json(
      await writeProjectStyleSnapshot(projectId, {
        ...(patch.designSystem === undefined ? {} : { designSystem: patch.designSystem }),
        ...(patch.avoid ? { avoid: patch.avoid } : {}),
        ...(patch.name ? { name: patch.name } : {}),
        ...(referenceImages ? { referenceImages } : {}),
      }),
    );
  });

  app.patch("/api/projects/:projectId/workflow-stage", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { workflowStage } = z
      .object({ workflowStage: z.enum(["requirements", "settings", "editing"]) })
      .parse(request.body);
    const project = await repository.updateProject(projectId, (current) => {
      current.workflowStage = workflowStage;
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    response.json(project);
  });

  app.get("/api/projects/:projectId", async (request, response) => {
    const id = idSchema.parse(request.params.projectId);
    const project = await repository.loadProject(id);
    if (!project) return response.status(404).json({ error: "Project not found" });
    return response.json(project);
  });

  /**
   * 專案的模型用量統計。
   *
   * **伺服器端聚合完成才回**，前端不得拿原始帳本自己算：那等於讓前端鏡射一份「未回報的
   * 呼叫不計入 token 總和」的規則，而那份規則必然漂移。回應裡的 `unreportedCalls` 也是
   * 直接給出來的，不要前端自己減。
   */
  app.get("/api/projects/:projectId/usage", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const project = await repository.loadProject(projectId);
    if (!project) return response.status(404).json({ error: "Project not found" });
    // 背景記帳（圖片描述、job）可能還在途中；等它收尾才不會讓剛跑完的呼叫少算一筆。
    // 但只等一小段：另一個專案的批次記帳不該讓這個查詢卡著，而聚合少算最後一筆遠比
    // 一個轉不完的圈可以接受。
    await usageLedger.idle(USAGE_SUMMARY_IDLE_MS);
    return response.json(await usageLedger.summarizeProject(projectId));
  });

  app.delete("/api/projects/:projectId", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    await jobs.cancelProject(projectId).catch(() => undefined);
    await repository.deleteProject(projectId);
    // 帳本在專案目錄之外（見 usage-ledger.ts 的 ④），所以要自己刪；排在取消 job 之後，
    // 被取消的那幾筆記帳才不會在刪完之後又把檔案建回來。
    await usageLedger.deleteProject(projectId);
    response.json({ ok: true });
  });
}

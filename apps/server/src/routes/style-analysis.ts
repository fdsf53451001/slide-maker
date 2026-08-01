import type { Express } from "express";
import { z } from "zod";
import {
  logWarn,
  STYLE_REFERENCE_IMAGE_LIMIT,
  type StructuredTextResult,
  type StyleReferenceImage,
} from "@slide-maker/core";
import { idSchema } from "../project-write-helpers.js";
import {
  renderDesignSystem,
  STYLE_ANALYSIS_PROMPT,
  StyleAnalysisError,
  styleAnalysisJsonSchema,
  styleAnalysisSchema,
} from "../style-analysis.js";
import type { UsageRecordInput } from "../usage-ledger.js";
import { failedCallFields, usageCallFields } from "../usage-recording.js";
import type { AppContext } from "./context.js";

export const projectStyleAnalysisInputSchema = z.object({
  slideIds: z.array(idSchema).min(1).max(STYLE_REFERENCE_IMAGE_LIMIT),
  combinationId: idSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

/** 參考圖風格分析：無專案脈絡的那條，與 PDF 匯入分析頁專用的一筆交易那條。 */
export function registerStyleAnalysisRoutes(app: Express, ctx: AppContext): void {
  const { repository, styles, runtime, usageLedger, usageModelFields } = ctx;
  const { saveVersionStyleReference, writeProjectStyleSnapshot } = ctx;

  /** 跑一次參考圖風格分析，輸出可直接寫進 StylePreset 的 designSystem。 */
  async function analyzeStyleReferences(
    referenceIds: readonly string[],
    combinationId: string | undefined,
  ): Promise<{ designSystem: string; avoid: string[] }> {
    // 風格分析無專案脈絡：由呼叫端指定組合，未指定時退回模型庫預設組合。
    const structuredText = runtime.resolveTextProvider(combinationId);
    if (structuredText.availability.status !== "available")
      throw new StyleAnalysisError("STYLE_ANALYSIS_DISABLED");
    const imagePaths = [];
    for (const id of referenceIds) {
      const reference = await styles.referenceMetadata(id);
      if (!reference) throw new Error("Style asset not found");
      imagePaths.push(styles.referenceAssetPath(reference.assetPath));
    }
    // 風格分析沒有專案可以掛，走全域帳本（第一版只寫不顯示）。丟掉它會讓「模型庫的
    // 文字模型到底被叫了幾次」永遠對不上。
    const usageFields: Omit<UsageRecordInput, "ok" | "usage"> = {
      capability: "text",
      operation: "style-analysis",
      ...usageModelFields(structuredText.id),
    };
    let outcome: StructuredTextResult;
    try {
      outcome = await structuredText.runStructured({
        timeoutMs: runtime.system.modelTimeoutMs,
        outputSchema: styleAnalysisJsonSchema,
        imagePaths,
        prompt: STYLE_ANALYSIS_PROMPT,
      });
    } catch (error) {
      void usageLedger.recordGlobal({ ...usageFields, ok: false, ...failedCallFields(error) });
      throw error;
    }
    void usageLedger.recordGlobal({ ...usageFields, ok: true, ...usageCallFields(outcome) });
    const result = styleAnalysisSchema.parse(outcome.value);
    const rendered = renderDesignSystem(result);
    /*
     * 明暗登記是這份設計系統裡唯一「缺了就等於整條規則不存在」的欄位（其餘欄位少一個
     * 只是少一段），而非嚴格 gateway 丟掉自己不認識的欄位是常態——所以它的降級一定要
     * 留下證據。只記代碼與模型 id：色值、頁面內容、prompt 一字不進 log。
     */
    if (rendered.tonalRegisterSource !== "model")
      logWarn("style_analysis_tonal_register_degraded", {
        source: rendered.tonalRegisterSource,
        modelId: structuredText.id,
        referenceCount: referenceIds.length,
      });
    return { designSystem: rendered.markdown, avoid: result.avoid };
  }

  app.post("/api/style-analysis", async (request, response) => {
    const { referenceIds, combinationId } = z
      .object({
        referenceIds: z.array(idSchema).min(1).max(STYLE_REFERENCE_IMAGE_LIMIT),
        combinationId: idSchema.optional(),
      })
      .parse(request.body);
    response.json(await analyzeStyleReferences(referenceIds, combinationId));
  });

  /**
   * PDF 匯入分析頁專用：建立分析用參考圖 → 跑分析 → 寫回 styleSnapshot，一筆交易。
   *
   * 由前端串三支端點的話，中間任何一步失敗（分析被停用、模型交出空殼、逾時——
   * 全都是規格明文要求「明確顯示錯誤、可重試」的正常路徑）都會留下剛寫進
   * `styles/assets` 的參考圖：沒有任何 snapshot 引用、風格庫列表看不到、也不在專案
   * 目錄底下（刪專案帶不走）。按三次重試就是 24 個孤兒檔。這裡失敗就把這一輪自己
   * 建的那批刪掉，重試幾次都不會累積。
   */
  app.post("/api/projects/:projectId/style-analysis", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const input = projectStyleAnalysisInputSchema.parse(request.body ?? {});
    const project = await repository.loadProject(projectId);
    if (!project) throw new Error("Project not found");
    const created: StyleReferenceImage[] = [];
    const analysed = await (async () => {
      try {
        for (const slideId of input.slideIds) {
          const slide = project.slides.find((candidate) => candidate.id === slideId);
          const versionId = slide?.currentVersionId;
          if (!slide || !versionId) throw new Error("Version not found");
          created.push(await saveVersionStyleReference(project, slide.id, versionId));
        }
        const analysis = await analyzeStyleReferences(
          created.map((image) => image.id),
          input.combinationId,
        );
        return await writeProjectStyleSnapshot(projectId, {
          designSystem: analysis.designSystem,
          avoid: analysis.avoid,
          ...(input.name ? { name: input.name } : {}),
          referenceImages: created,
        });
      } catch (error) {
        await Promise.allSettled(created.map((image) => styles.deleteReference(image.id)));
        throw error;
      }
    })();
    response.json(analysed);
  });
}

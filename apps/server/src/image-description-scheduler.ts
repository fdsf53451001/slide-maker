import {
  logInfo,
  logWarn,
  type PresentationProject,
  type StructuredTextProvider,
} from "@slide-maker/core";
import {
  IMAGE_DESCRIPTION_FAILURE_KEY,
  ImageDescriptionQueue,
  classifyImageDescriptionFailure,
  describeImage,
  imageDescriptionFields,
  parseImageDescription,
  shouldDescribeImageSource,
  type DescribeImageResult,
  type ImageDescriptionFailure,
} from "./image-description.js";
import type { ImageDescriptionMode } from "./config.js";
import { ModelLibraryError, type ModelRuntime } from "./model-runtime.js";
import type { FileProjectRepository } from "./repository.js";
import type { SqliteFtsRetriever } from "./retriever.js";
import type { UsageLedger, UsageRecordInput } from "./usage-ledger.js";
import { failedCallFields, usageCallFields, type UsageModelFields } from "./usage-recording.js";

/**
 * 啟動時的兩支修復（原本是 createApp 裡的兩個閉包）。走訪迴圈仍留在 createApp。
 */
export function createStartupRepairs(repository: FileProjectRepository) {
  // 上一輪程序在圖片描述途中被砍時，來源會永遠停在 parsing：背景描述沒有持久化，重啟後
  // 沒有人接手，前端就一直顯示「分析中」。放回 indexed——那正是「沒有描述」這個既有狀態。
  // 刻意不動 updatedAt：這是修復而非編輯，動了會打亂專案列表的排序。
  const clearStalledParsing = async (
    project: PresentationProject,
  ): Promise<PresentationProject> => {
    if (!project.sources.some((source) => source.status === "parsing")) return project;
    logWarn("image_description_parsing_reset", { projectId: project.id });
    // 走 updateProject 而不是拿列表快照直接 saveProject：後者的讀在鎖外，等於用一份可能
    // 過期的整份專案盲寫回去。
    return repository
      .updateProject(project.id, (draft) => {
        for (const source of draft.sources)
          if (source.status === "parsing") source.status = "indexed";
        return structuredClone(draft);
      })
      .catch((error: unknown) => {
        logWarn("image_description_parsing_reset_failed", { projectId: project.id }, error);
        return project;
      });
  };
  /**
   * 清掉上一輪行程留下的 `ocr-input/` 殘骸。
   *
   * 正常出口由抽字端點的 try/finally 負責，但那擋不住行程被砍——而「OCR 途中被 OOM 砍掉」
   * 正是 OCR 併發閘門要防的情境，它必然留下殘檔。Cloud Run 是 max_instance=1 且
   * scale-to-zero，實例重啟頻繁，開機掃除因此特別有效。
   *
   * **只能在啟動時掃，不可在請求時掃。** 請求時掃會刪到別人的檔案：樣式精修跑在閘門
   * **之外**，所以兩個請求可以同時處在「OCR 已完成、正在精修」的階段，各自的 ocr-input
   * 都還活著。啟動時沒有任何請求在途，才是安全的時機。
   *
   * 失敗一律只記 log：清不掉舊的暫存檔絕不能讓伺服器起不來。
   */
  const sweepOcrInputs = async (projectId: string): Promise<void> => {
    try {
      await repository.deleteAssetDirectory(projectId, "ocr-input");
    } catch (error) {
      logWarn("ocr_input_sweep_failed", { projectId }, error);
    }
  };
  return { clearStalledParsing, sweepOcrInputs };
}

/**
 * 圖片來源的背景描述管線（原本是 createApp 裡的三個閉包）。
 *
 * `runtime` 與 `resolveStructuredText` 都收活引用：模型庫熱重建會換掉 registry，
 * 而描述工作可能在佇列裡等十幾秒才真正送出，那時要用的是最新的組合。
 */
export function createImageDescriptionScheduler(options: {
  repository: FileProjectRepository;
  retriever: SqliteFtsRetriever;
  runtime: ModelRuntime;
  usageLedger: UsageLedger;
  usageModelFields: UsageModelFields;
  imageDescriptions: ImageDescriptionQueue;
  imageDescriptionMode: ImageDescriptionMode;
  resolveStructuredText: (project?: PresentationProject) => StructuredTextProvider;
}) {
  const {
    repository,
    retriever,
    runtime,
    usageLedger,
    usageModelFields,
    imageDescriptions,
    imageDescriptionMode,
    resolveStructuredText,
  } = options;
  /**
   * 現在有沒有可用的文字模型可以跑圖片描述。
   *
   * 這件事必須在回應 201 之前就知道：沒有可用模型時連 `parsing` 都不該標，否則前端會閃
   * 一下「分析中」再默默變回去。解析失敗（組合沒設文字模型、模型庫沒有預設組合）屬可選
   * 步驟的正常降級，安靜略過。`SLIDE_MAKER_IMAGE_DESCRIPTION=off` 時整條路直接不存在。
   *
   * 這裡的降級**刻意不比照抽字那條擋下**（那條見 `TEXT_EXTRACTION_STYLE_MODEL_MESSAGE`）：
   * 沒有描述的圖片來源仍然完全可用（上傳成功、看得到、放得進頁面），差別只在 FTS 撈不到
   * 它，而讓上傳因為模型組合沒設好就整批失敗是更糟的交換。但「安靜略過」不等於「不留
   * 證據」：解析失敗照樣記一行代碼，否則「為什麼我的圖都沒有被讀」在伺服器端查無此事。
   */
  const imageDescriptionProvider = (
    project: PresentationProject,
  ): StructuredTextProvider | undefined => {
    if (imageDescriptionMode === "off") return undefined;
    try {
      const provider = resolveStructuredText(project);
      return provider.availability.status === "available" ? provider : undefined;
    } catch (error) {
      // 只記 id 與代碼：來源檔名、圖片內容、prompt 一律不進 log。
      logWarn("image_description_model_unresolved", {
        projectId: project.id,
        code: error instanceof ModelLibraryError ? error.code : "UNKNOWN",
      });
      return undefined;
    }
  };

  /**
   * 把卡在 parsing 的來源放回 indexed，並記下失敗原因。
   *
   * 狀態不收尾的話前端會一直轉圈；而只收尾不記原因的話，「跑過但失敗」與「從來沒跑過」
   * 在 UI 上長得一模一樣——最常見的失敗（選到的文字模型不會讀圖）就會變成每上傳一張圖
   * 都白打一次請求，使用者卻永遠看不到線索。
   */
  const releaseParsingStatus = async (
    projectId: string,
    sourceId: string,
    failure?: ImageDescriptionFailure,
  ): Promise<void> => {
    try {
      await repository.updateProject(projectId, (draft) => {
        const target = draft.sources.find((item) => item.id === sourceId);
        if (!target) return;
        if (target.status === "parsing") target.status = "indexed";
        if (failure) target.metadata[IMAGE_DESCRIPTION_FAILURE_KEY] = failure;
      });
    } catch (error) {
      logWarn("image_description_release_failed", { projectId, sourceId }, error);
    }
  };

  /**
   * 背景產生圖片來源的可檢索描述，並寫回 extractedText／chunks／索引。
   *
   * 全程可降級：任何一步失敗都只留一筆 log，來源回到「沒有描述」的既有狀態，上傳本身
   * 早已回過 201，不受影響。provider 在工作真正開跑時才解析，排隊期間使用者換了模型組合
   * 也算數。
   */
  const scheduleImageDescription = (projectId: string, sourceId: string): void => {
    void imageDescriptions.enqueue(async (signal) => {
      try {
        if (signal.aborted) throw new Error("IMAGE_DESCRIPTION_ABORTED");
        const current = await repository.loadProject(projectId);
        const source = current?.sources.find((item) => item.id === sourceId);
        // 排隊期間來源（或整個專案）被刪掉：沒有東西要收尾，也沒有失敗可言。
        if (!current || !source) return;
        // **授權要在送出的那一刻重新確認，不是排隊的那一刻。**一次拖五張圖時後面幾張會
        // 排隊十幾秒，使用者這段時間完全可能取消某張的「AI 使用」或改掉用途；沿用排隊當時
        // 的判斷等於把圖片照樣送出去。這是這個功能唯一的硬條件，只能以最新狀態為準。
        if (!shouldDescribeImageSource(source)) {
          await releaseParsingStatus(projectId, sourceId);
          return;
        }
        const provider = imageDescriptionProvider(current);
        if (!provider) throw new Error("IMAGE_DESCRIPTION_PROVIDER_UNAVAILABLE");
        // 描述是背景工作、前端完全看不見它的成本；漏記這一筆等於讓「上傳十張圖」燒掉的
        // 配額憑空消失。失敗也記（見 catch）。
        const usageFields: Omit<UsageRecordInput, "ok" | "usage"> = {
          capability: "text",
          operation: "image-description",
          sourceId,
          ...usageModelFields(provider.id),
        };
        let described: DescribeImageResult;
        try {
          described = await describeImage({
            provider,
            imagePath: repository.resolveAsset(projectId, source.assetPath),
            language: current.brief.language,
            timeoutMs: runtime.system.modelTimeoutMs,
            signal,
          });
        } catch (error) {
          void usageLedger.recordProject(projectId, {
            ...usageFields,
            ok: false,
            ...failedCallFields(error),
          });
          throw error;
        }
        // 記帳排在 parse 之前，與另外四條文字路徑一致：模型回了東西＝配額已經燒掉，
        // 格式對不對是下一個問題（見 `UsageRecordInput.ok` 與 `DescribeImageResult`）。
        void usageLedger.recordProject(projectId, {
          ...usageFields,
          ok: true,
          ...usageCallFields(described),
        });
        const description = parseImageDescription(described.value);
        const fields = imageDescriptionFields(sourceId, description);
        if (!fields) throw new Error("IMAGE_DESCRIPTION_EMPTY");
        const entry = runtime.library.models.find((model) => model.id === provider.id);
        const updated = await repository.updateProject(projectId, (draft) => {
          const target = draft.sources.find((item) => item.id === sourceId);
          if (!target) return undefined;
          // in-flight 的那一段擋不住「已經送出去了」，但至少不讓它落地：使用者在請求途中
          // 收回授權時，描述不得寫進專案，也就不會進到大綱 prompt。
          if (!target.allowModelAccess) {
            if (target.status === "parsing") target.status = "indexed";
            return undefined;
          }
          target.extractedText = fields.extractedText;
          target.chunks = fields.chunks;
          target.status = "indexed";
          // 模型衍生物必須可查證：留下是誰產生的這份描述。
          target.metadata = {
            ...target.metadata,
            // 結構化摘要（標題＋一句話）給大綱目錄用。舊資料沒有這個欄位，目錄那端的
            // fallback（剝掉聲明後取正文）因此必須永遠留著。
            ...(fields.summary ? { summary: fields.summary } : {}),
            imageDescriptionProvider: provider.id,
            imageDescriptionModel: entry?.model || entry?.name || "unknown",
            imageDescribedAt: new Date().toISOString(),
          };
          delete target.metadata[IMAGE_DESCRIPTION_FAILURE_KEY];
          target.updatedAt = new Date().toISOString();
          // 刻意不動 draft.updatedAt：那是「使用者改了這個專案」的時間戳，專案列表照它排序。
          // 背景寫入去碰它的話，使用者離開專案十幾秒後它會自己跳到列表最前面。
          return structuredClone(draft);
        });
        if (!updated) return;
        retriever.index(updated.id, updated.sources);
        logInfo("image_description_indexed", {
          projectId,
          sourceId,
          chunkCount: fields.chunks.length,
        });
      } catch (error) {
        const failure = classifyImageDescriptionFailure(error);
        logWarn("image_description_failed", { projectId, sourceId, failure }, error);
        await releaseParsingStatus(projectId, sourceId, failure);
      }
    });
  };
  return { imageDescriptionProvider, releaseParsingStatus, scheduleImageDescription };
}

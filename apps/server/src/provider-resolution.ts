import type { PresentationProject, StructuredTextProvider } from "@slide-maker/core";
import { ModelLibraryError, type ModelRuntime } from "./model-runtime.js";
import type { FileProjectRepository } from "./repository.js";

/**
 * 依專案組合解析 provider 的三支（原本是 createApp 裡的三個閉包）。
 *
 * `runtime` 必須是本體：模型庫存檔走 `runtime.rebuild()` 原子替換 registry，
 * 在這裡解構出 `runtime.library`／`defaultCombinationId` 之類的快照，熱重建之後
 * 解析到的就是舊模型庫。
 */
export function createProviderResolvers(repository: FileProjectRepository, runtime: ModelRuntime) {
  // 依專案綁定的組合解析文字／搜尋 provider（無 project 時退回預設組合）。
  const resolveStructuredText = (project?: PresentationProject): StructuredTextProvider =>
    runtime.resolveTextProvider(project?.combinationId);
  // lazy 綁定：專案未選組合時，於首次生成寫入預設組合 id。
  const ensureProjectCombination = async (projectId: string): Promise<PresentationProject> => {
    const project = await repository.loadProject(projectId);
    if (!project) throw new Error("Project not found");
    if (project.combinationId) return project;
    const defaultId = runtime.defaultCombinationId;
    if (!defaultId)
      throw new ModelLibraryError("NO_DEFAULT_COMBINATION", "模型庫尚未設定預設組合。");
    return repository.updateProject(projectId, (current) => {
      current.combinationId = defaultId;
      /*
       * 刻意不動 `updatedAt`：綁預設組合是**系統補值**（使用者從沒選過它），而這一步跑在
       * `readiness.assertCanGenerate()` 與能力檢查**之前**——生成被擋下（例如風格帶參考圖
       * 但這個組合的影像模型不支援）時，使用者拿到一則紅色錯誤、零張圖，專案卻已經帶著全新
       * 的「最後修改時間」跳到主畫面最上面。真的生成出東西的那一次，`routes/generation.ts`
       * 建立 job 時本來就會寫 `updatedAt`，不會漏記。
       */
      return structuredClone(current);
    });
  };
  // 生成時解析影像 provider id：客戶端顯式指定則沿用（相容既有選單／測試），
  // 否則由專案組合決定（並於首次生成 lazy 綁定預設組合）。
  const resolveImageProviderId = async (
    projectId: string,
    explicitProviderId: string | undefined,
  ): Promise<string> => {
    if (explicitProviderId) return explicitProviderId;
    const project = await ensureProjectCombination(projectId);
    return runtime.resolveImageEntryId(project.combinationId);
  };
  return { ensureProjectCombination, resolveImageProviderId, resolveStructuredText };
}

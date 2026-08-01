import {
  SafeProviderError,
  type ProviderUsage,
  type StructuredTextResult,
} from "@slide-maker/core";
import type { ModelRuntime } from "./model-runtime.js";
import type { UsageLedger, UsageRecordInput } from "./usage-ledger.js";

/**
 * 一次 provider 呼叫的用量欄位（成功路徑）。
 *
 * `requests` 與 `usage` 分開帶：gateway 不回報用量時 usage 是空的，但「provider 自己
 * 內部重試了幾次」仍然問得出來——那是 UI 上唯一能解釋成本的東西。
 */
export const usageCallFields = (outcome: {
  usage?: ProviderUsage;
  requests?: number;
}): Pick<UsageRecordInput, "usage" | "requests"> => ({
  ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  ...(outcome.requests === undefined ? {} : { requests: outcome.requests }),
});

/**
 * 失敗的呼叫身上的用量欄位。
 *
 * `SafeProviderError` 會帶著「往返成功之後才失敗」那些路徑的用量（搜尋回了一整包
 * grounding 卻沒有可驗證的候選、重試三輪都不是合法 JSON、影像解不出圖）。少了這一步，
 * 那些**最貴又零產出**的呼叫在帳本上會與「這個 gateway 不回報用量」長得一模一樣。
 * 錯誤物件上除了這兩個欄位以外的東西一律不碰——message 與 stack 可能夾帶正文。
 */
export const failedCallFields = (error: unknown): Pick<UsageRecordInput, "usage" | "requests"> =>
  error instanceof SafeProviderError ? usageCallFields(error) : {};

/**
 * {@link createUsageRecorder} 產出的 `usageModelFields`，供其他 factory 當參數型別用。
 * 形狀與原本那個閉包的回傳註記逐字相同。
 */
export type UsageModelFields = (entryId: string | undefined) => {
  modelEntryId?: string;
  model?: string;
  providerKind?: string;
};

/**
 * 綁定 runtime 與帳本的記帳器（原本是 createApp 裡的兩個閉包）。
 *
 * 收 `runtime` 本體而不是它身上任何欄位的快照：模型庫存檔會走 `runtime.rebuild()`
 * 原子替換 registry，抓一份 `runtime.library` 下來的話熱重建之後就永遠查的是舊 entry。
 */
export function createUsageRecorder(runtime: ModelRuntime, usageLedger: UsageLedger) {
  /**
   * 模型 entry → 帳本要記的識別欄位。
   *
   * provider 的 `id` 就是模型庫的 entry id（見 `ModelRuntime`），所以查得回 `providerKind`
   * 與真正的模型名。查不到（entry 剛被刪、或 mock provider）就只留 entry id——**不可**因此
   * 整筆不記，那會讓被刪掉的模型所燒掉的配額憑空消失。
   */
  const usageModelFields = (
    entryId: string | undefined,
  ): { modelEntryId?: string; model?: string; providerKind?: string } => {
    if (!entryId) return {};
    const entry = runtime.library.models.find((model) => model.id === entryId);
    return {
      modelEntryId: entryId,
      ...(entry?.model ? { model: entry.model } : {}),
      ...(entry?.providerKind ? { providerKind: entry.providerKind } : {}),
    };
  };

  /**
   * 跑一次結構化文字呼叫並記帳，回傳模型的輸出值。
   *
   * 成功與失敗都記——失敗一樣燒配額，只記成功的會系統性低估，而失敗（逾時、gateway 4xx、
   * 模型回了但格式不對）恰恰是重試迴圈跑滿三輪的那些最貴的情況。記帳一律 `void`：帳本永不
   * reject，也不得插進呼叫端的時序。
   *
   * **記帳排在 schema parse 之前**（呼叫端拿到的是未驗證的 `value`）：`ok` 的語意是
   * 「provider 往返成功、配額已經燒掉」，而 parse 失敗時 token 一樣花光了。八條記帳路徑
   * 對這件事必須一致。
   */
  const recordStructuredUsage = async (
    projectId: string,
    fields: Omit<UsageRecordInput, "ok" | "usage">,
    run: () => Promise<StructuredTextResult>,
  ): Promise<unknown> => {
    let outcome: StructuredTextResult;
    try {
      outcome = await run();
    } catch (error) {
      void usageLedger.recordProject(projectId, {
        ...fields,
        ok: false,
        ...failedCallFields(error),
      });
      throw error;
    }
    void usageLedger.recordProject(projectId, {
      ...fields,
      ok: true,
      ...usageCallFields(outcome),
    });
    return outcome.value;
  };
  return { usageModelFields, recordStructuredUsage };
}

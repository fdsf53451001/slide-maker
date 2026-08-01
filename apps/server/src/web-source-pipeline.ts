import { z } from "zod";
import {
  SafeProviderError,
  type PresentationProject,
  type SourceAsset,
  type WebSearchOutcome,
} from "@slide-maker/core";
import type { ModelRuntime } from "./model-runtime.js";
import type { FileProjectRepository } from "./repository.js";
import { ingestSource, safeFilename } from "./sources.js";
import { captureWebPage, type WebSearchResult } from "./web-capture.js";
import type { HtmlRenderer } from "./web-render.js";
import type { UsageLedger, UsageRecordInput } from "./usage-ledger.js";
import { failedCallFields, usageCallFields, type UsageModelFields } from "./usage-recording.js";

export const webSearchResultSchema = z.object({
  url: z.string().url(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(4_000),
});
export const webSearchOutputSchema = z.object({ results: z.array(webSearchResultSchema).max(20) });

/**
 * 這條管線用得到的測試注入點（`AppDependencies` 的子集，逐字相同）。
 *
 * 刻意不從 app.ts import `AppDependencies`：那會讓 app.ts ↔ 這個模組互相 import。
 * 結構相容即可，createApp 直接把整個 `dependencies` 傳進來。
 */
export interface WebSourceDependencies {
  webSearch?: (
    query: string,
    limit: number,
    project: PresentationProject,
  ) => Promise<WebSearchResult[]>;
  captureWebPage?: typeof captureWebPage;
}

/**
 * 網頁來源管線（原本是 createApp 裡的四個閉包）。
 *
 * **整份專案只有這一份實作**：整份大綱與 web-search／web-sources／url-sources 三條
 * route 都用它，差別只在 `materializeWebSources` 的 options。複製第二份就會出現兩套
 * 去重與落地規則。
 */
export function createWebSourcePipeline(
  repository: FileProjectRepository,
  runtime: ModelRuntime,
  usageLedger: UsageLedger,
  usageModelFields: UsageModelFields,
  dependencies: WebSourceDependencies,
) {
  const searchFor =
    (project: PresentationProject) =>
    async (
      query: string,
      limit: number,
      target: PresentationProject,
    ): Promise<WebSearchResult[]> => {
      // 測試替身沒有經過任何模型，記帳會製造出不存在的呼叫；這條路刻意不記。
      if (dependencies.webSearch) return dependencies.webSearch(query, limit, target);
      const provider = runtime.resolveSearchProvider(project.combinationId);
      const usageFields: Omit<UsageRecordInput, "ok" | "usage"> = {
        capability: "search",
        operation: "search",
        ...usageModelFields(provider.id),
      };
      let outcome: WebSearchOutcome;
      try {
        outcome = await provider.search(query, limit, target.brief.language);
      } catch (error) {
        // 搜尋的上游有重試迴圈，每一輪都是一次真的請求；失敗不記就會低估整整幾輪。
        // `*_WEB_SEARCH_EMPTY` 更是這條路上最貴的失敗：整段帶 grounding 的長回應燒完卻
        // 零產出，usage 就在錯誤物件身上（見 `failedCallFields`）。
        void usageLedger.recordProject(project.id, {
          ...usageFields,
          ok: false,
          ...failedCallFields(error),
        });
        throw error;
      }
      void usageLedger.recordProject(project.id, {
        ...usageFields,
        ok: true,
        ...usageCallFields(outcome),
      });
      return outcome.results;
    };
  const capturePage = dependencies.captureWebPage ?? captureWebPage;
  /**
   * 把一批網頁結果落地成專案來源（同 URL 更新既有筆、否則新增），只收抓得到正文的。
   *
   * 搜尋擷取與「貼上網址」兩條入口共用這一份，差別只在 `options`：
   * - `renderer`：交給 `captureWebPage` 的第三方 render fallback。**搜尋路徑不傳**——
   *   那些網址是模型給的，使用者沒有逐筆同意把它們送去第三方。
   * - `requireBody`：驗收標準改成「剝掉標題後仍有正文」。貼上網址沒有搜尋摘要可退，
   *   存一份空來源等於騙人。
   * - `refresh`：略過「已存在且是 full 就不重抓」的捷徑。使用者手動貼上網址，意思就是
   *   「現在去抓這一頁」，回一份舊快取等於沒做事。
   * - `deadline`：整批的時間預算（epoch ms）。逾時後剩下的網址不再擷取，逐筆回報
   *   `WEB_SOURCE_BATCH_TIMEOUT`。
   *
   * **逐筆循序**是刻意的：Jina 無金鑰模式約 20 RPM，10 筆併發送出去撞限流的機率遠高於
   * 循序，而限流的結果是整批都白跑。循序的代價是最壞延遲會疊加，那個風險改由 `deadline`
   * 承擔（超時的那幾筆回一個看得懂的原因，而不是讓整個 HTTP 請求被閘道砍掉）。
   */
  const materializeWebSources = async (
    projectId: string,
    existingSources: readonly SourceAsset[],
    foundSources: readonly WebSearchResult[],
    options: {
      renderer?: HtmlRenderer | undefined;
      requireBody?: boolean;
      refresh?: boolean;
      deadline?: number;
    } = {},
  ) => {
    const sourceByUrl = new Map(
      existingSources
        .filter((source) => source.metadata.url)
        .map((source) => [source.metadata.url!, structuredClone(source)]),
    );
    const addedSources: SourceAsset[] = [];
    const refreshedSources: SourceAsset[] = [];
    const verifiedResults: WebSearchResult[] = [];
    /** 抓不到正文而被丟掉的網址與原因（呼叫端要逐筆回報失敗時才用得到）。 */
    const unverifiedUrls: { url: string; reason: string }[] = [];
    for (const found of foundSources.slice(0, 20)) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        unverifiedUrls.push({ url: found.url, reason: "WEB_SOURCE_BATCH_TIMEOUT" });
        continue;
      }
      const known = sourceByUrl.get(found.url);
      if (!options.refresh && known?.metadata.contentStatus === "full") {
        verifiedResults.push({
          url: known.metadata.url ?? found.url,
          title: known.metadata.title ?? found.title,
          summary: known.metadata.summary ?? found.summary,
        });
        continue;
      }
      const capturedAt = new Date().toISOString();
      const captured = await capturePage(found, capturedAt, undefined, {
        renderer: options.renderer,
        requireBody: options.requireBody,
      });
      if (captured.metadata.contentStatus !== "full") {
        const reason = captured.metadata.failureReason || "WEB_SOURCE_CONTENT_UNVERIFIED";
        // 至少留一筆伺服器端記錄：render 失敗（限流尤其）完全靜默的話，營運端看不出
        // 「使用者一直加不進來」是配額問題還是網站問題。
        if (reason.startsWith("WEB_RENDER_")) console.warn("web render failed", { reason });
        unverifiedUrls.push({ url: found.url, reason });
        continue;
      }
      const verified = {
        ...found,
        url: captured.metadata.url ?? found.url,
      };
      // 去重要用**擷取後**的網址：存下來的 `metadata.url` 是重導向／canonical 化之後的那個，
      // 拿擷取前的輸入去查會讓每一次 http→https、結尾斜線、去追蹤參數的重導向都走成「新增」，
      // 於是每試一次就多一個孤兒資產目錄，而交易裡的 url 去重又會把它丟掉（＝永遠加不進去）。
      const existing = sourceByUrl.get(verified.url) ?? known;
      const bytes = new TextEncoder().encode(captured.text);
      if (existing) {
        const refreshed = await ingestSource(
          {
            name: existing.name,
            mediaType: "text/markdown",
            usage: existing.usage,
            allowModelAccess: existing.allowModelAccess,
          },
          bytes,
          existing.assetPath,
          capturedAt,
        );
        refreshed.id = existing.id;
        refreshed.createdAt = existing.createdAt;
        refreshed.metadata = captured.metadata;
        refreshed.assetPath = await repository.saveAsset(
          projectId,
          existing.assetPath.replace(/^assets\//, ""),
          bytes,
        );
        sourceByUrl.set(found.url, refreshed);
        sourceByUrl.set(verified.url, refreshed);
        // 同一批裡重抓到「剛剛才新增的那一筆」時，要就地換掉那個物件而不是另外排一個
        // refresh：交易是照 id 對位的，而這個 id 還不在專案裡，排進 refreshedSources 只會
        // 被丟掉——結果是專案裡留著第一次的文字，磁碟上卻是第二次的內容。
        const addedIndex = addedSources.findIndex((source) => source.id === refreshed.id);
        if (addedIndex >= 0) addedSources[addedIndex] = refreshed;
        else {
          const refreshedIndex = refreshedSources.findIndex((source) => source.id === refreshed.id);
          if (refreshedIndex >= 0) refreshedSources[refreshedIndex] = refreshed;
          else refreshedSources.push(refreshed);
        }
      } else {
        const source = await ingestSource(
          {
            // 搜尋路徑的 metadata.title 就是 found.title（檔名不變）；手貼網址沒有標題，
            // 由 captureWebPage 從網頁本身推導後放進 metadata。
            name: `${safeFilename(captured.metadata.title || found.title)}.md`,
            mediaType: "text/markdown",
            usage: "content",
            allowModelAccess: true,
          },
          bytes,
          "assets/pending",
          capturedAt,
        );
        source.metadata = captured.metadata;
        source.assetPath = await repository.saveAsset(
          projectId,
          `sources/${source.id}/${safeFilename(source.name)}`,
          bytes,
        );
        sourceByUrl.set(found.url, source);
        sourceByUrl.set(verified.url, source);
        addedSources.push(source);
      }
      verifiedResults.push(verified);
    }
    return { sourceByUrl, addedSources, refreshedSources, verifiedResults, unverifiedUrls };
  };
  // 依 brief.webSearchMode 決定是否用 WebSearchProvider 抓取來源；搜尋後端不可用時優雅降級為無來源。
  // 搜尋不可默默降級成無來源，否則後續文字模型會用記憶補資料，造成看似完成但內容失真。
  const gatherWebSources = async (
    project: PresentationProject,
    query: string,
    searchFn: (
      query: string,
      limit: number,
      project: PresentationProject,
    ) => Promise<WebSearchResult[]>,
    limit = 8,
    attempts = 5,
  ): Promise<WebSearchResult[]> => {
    if (project.brief.webSearchMode === "disabled") return [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const results = await searchFn(query, limit, project);
        if (results.length > 0) return results;
      } catch {
        // Retry below; provider details remain redacted from the client.
      }
    }
    throw new SafeProviderError(
      "WEB_SEARCH_FAILED",
      "網路搜尋沒有取得候選來源，已停止生成以避免使用未查證資料。",
    );
  };
  return { capturePage, gatherWebSources, materializeWebSources, searchFor };
}

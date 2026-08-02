import type { Express } from "express";
import { z } from "zod";
import { SafeProviderError, URL_SOURCE_BATCH_LIMIT, type SourceAsset } from "@slide-maker/core";
import { assertPublicHttpUrl, isReadableWebUrl } from "@slide-maker/core/url-safety";
import { idSchema } from "../project-write-helpers.js";
import { assertSourceCapacity, sourceCapacityError } from "../sources.js";
import { isHashRouteUrl, type WebSearchResult } from "../web-capture.js";
import { webSearchOutputSchema, webSearchResultSchema } from "../web-source-pipeline.js";
import type { AppContext } from "./context.js";

/**
 * 「貼上網址」整批擷取的時間預算。
 *
 * 擷取完全外包給 render 服務（`renderOnly`）之後，最壞情況是 10 個網址 × 30 秒 render 逾時
 * ＝ 300 秒循序跑，正好等於 Cloud Run 預設的請求上限——閘道砍掉連線時資料其實已經寫進去
 * 了，使用者看到失敗卻多出一批來源。240 秒留給交易、索引與回應足夠的餘裕；超時的網址逐筆
 * 回 `WEB_SOURCE_BATCH_TIMEOUT`，使用者知道要分批再試。
 *
 * （外包前這裡還要再加上原生 fetch 的 15 秒／筆，最壞是 450 秒。上限沒跟著調鬆：真正的
 * 約束是 Cloud Run 那 300 秒，不是我們算得出來的最壞值。）
 */
const URL_SOURCES_BUDGET_MS = 240_000;

/**
 * 網頁來源的三條入口：搜尋、把搜尋結果落地成來源、使用者手動貼上網址。
 *
 * 落地一律走 ctx 的 `materializeWebSources`（`web-source-pipeline.ts` 的唯一實作），
 * 整份大綱那條也是同一個函式值；三條路的差別只在傳進去的 options。
 */
export function registerWebSourceRoutes(app: Express, ctx: AppContext): void {
  const { repository, retriever, htmlRenderer } = ctx;
  const { searchFor, materializeWebSources } = ctx;

  app.post("/api/projects/:projectId/web-search", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { query, limit } = z
      .object({
        query: z.string().trim().min(2).max(500),
        limit: z.number().int().min(1).max(20).default(8),
      })
      .parse(request.body);
    const project = await repository.loadProject(projectId);
    if (!project) throw new Error("Project not found");
    const results = await searchFor(project)(query, limit, project);
    response.json(
      webSearchOutputSchema
        .parse({ results })
        .results.filter((result) => isReadableWebUrl(result.url))
        .slice(0, limit),
    );
  });

  app.post("/api/projects/:projectId/web-sources", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { sources } = z
      .object({ sources: z.array(webSearchResultSchema).min(1).max(20) })
      .parse(request.body);
    const before = await repository.loadProject(projectId);
    if (!before) throw new Error("Project not found");
    const materialized = await materializeWebSources(projectId, before.sources, sources);
    if (materialized.verifiedResults.length === 0)
      throw new SafeProviderError(
        "WEB_SEARCH_SOURCES_UNVERIFIED",
        "選取的網頁內容皆無法讀取驗證，因此未加入專案。",
      );
    const project = await repository
      .updateProject(projectId, (current) => {
        for (const refreshed of materialized.refreshedSources) {
          const index = current.sources.findIndex((source) => source.id === refreshed.id);
          if (index >= 0) current.sources[index] = refreshed;
        }
        for (const added of materialized.addedSources) {
          if (current.sources.some((source) => source.metadata.url === added.metadata.url))
            continue;
          assertSourceCapacity(current.sources, added.sizeBytes);
          current.sources.push(added);
        }
        current.updatedAt = new Date().toISOString();
        return structuredClone(current);
      })
      .catch(async (error: unknown) => {
        // 撞上專案上限 → 整筆交易回滾，但 materialize 已把新來源資產寫到磁碟。它們永遠不會
        // 進專案，留著就是孤兒（每重試一次多一份）。比照 /url-sources 回收 addedSources；
        // refreshed 覆寫的是既有來源資產，來源仍在專案裡，不刪。
        for (const added of materialized.addedSources)
          await repository.deleteAssetDirectory(projectId, `sources/${added.id}`);
        throw error;
      });
    retriever.index(project.id, project.sources);
    response.status(201).json(project);
  });

  /**
   * 使用者手動貼上的網址 → 專案來源。
   *
   * 與 /web-sources 的差別只在入口：這裡沒有搜尋摘要可以退回，所以「抓不到正文」＝這一筆
   * 失敗（CLAUDE.md：未驗證摘要不得作為來源），而不是存成一筆只有摘要的空來源。落地、
   * 去重與索引全部走 materializeWebSources，沒有第二份實作。
   */
  app.post("/api/projects/:projectId/url-sources", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { urls } = z
      .object({
        urls: z.array(z.string().trim().min(1).max(2_000)).min(1).max(URL_SOURCE_BATCH_LIMIT),
      })
      .parse(request.body);
    const before = await repository.loadProject(projectId);
    if (!before) throw new Error("Project not found");
    const failures: { url: string; reason: string }[] = [];
    const accepted: WebSearchResult[] = [];
    const seen = new Set<string>();
    /** 正規化後的網址 → 使用者原本打的那一行。失敗清單一律回報後者。 */
    const inputByUrl = new Map<string, string>();
    for (const raw of urls) {
      try {
        // SSRF 防線在抓取之前先擋一次：這裡的網址完全由使用者輸入。
        const parsed = assertPublicHttpUrl(raw);
        // fragment 不會送到伺服器，hash routing 的網址抓回來的必然是首頁而不是使用者要的
        // 那一頁。抓得到、也有正文，只是完全另一份內容——只能明確判為失敗。
        if (isHashRouteUrl(parsed)) throw new Error("WEB_SOURCE_HASH_ROUTE_UNSUPPORTED");
        const url = parsed.toString();
        if (seen.has(url)) continue;
        seen.add(url);
        inputByUrl.set(url, raw);
        // 標題留白，由 captureWebPage 從網頁本身推導；摘要沒有來源，一律空字串。
        accepted.push({ url, title: "", summary: "" });
      } catch (reason) {
        const code = reason instanceof Error ? reason.message : "";
        failures.push({
          url: raw,
          reason: /^WEB_SOURCE_/.test(code) ? code : "WEB_SOURCE_URL_INVALID",
        });
      }
    }
    /** 使用者看到的永遠是自己打的那一行，不是我們正規化後的版本。 */
    const asTyped = (url: string) => inputByUrl.get(url) ?? url;
    const materialized = accepted.length
      ? await materializeWebSources(projectId, before.sources, accepted, {
          renderer: htmlRenderer,
          // 這條路徑的擷取完全外包給 render 服務，不做原生 fetch。原生擷取＋空殼啟發式
          // 對混合渲染頁（伺服器渲染大半、關鍵區塊留給 client 填）會判成「有正文」而收下
          // 一份含 `{{ }}` 模板殘骸、內容缺一半的來源，使用者無從察覺。
          renderOnly: true,
          requireBody: true,
          refresh: true,
          deadline: Date.now() + URL_SOURCES_BUDGET_MS,
        })
      : {
          addedSources: [] as SourceAsset[],
          refreshedSources: [] as SourceAsset[],
          unverifiedUrls: [] as { url: string; reason: string }[],
        };
    for (const unverified of materialized.unverifiedUrls)
      failures.push({ url: asTyped(unverified.url), reason: unverified.reason });
    if (!materialized.addedSources.length && !materialized.refreshedSources.length) {
      // 全軍覆沒不能回 201：前端會以為來源已經進去了。
      return response.status(400).json({
        error: "URL_SOURCES_UNVERIFIED",
        message: "沒有任何網址取得可驗證的正文，因此未加入專案。",
        failures,
      });
    }
    // 交易內排不進去的（撞到專案上限）。整批回滾會連塞得下的那一筆一起丟掉，而端點本來
    // 就有「部分成功 + 逐筆失敗」的語彙，沒有理由在這裡退回全有全無。
    const overLimit: { source: SourceAsset; code: string; message: string }[] = [];
    const project = await repository.updateProject(projectId, (current) => {
      overLimit.length = 0;
      let applied = 0;
      for (const source of [...materialized.refreshedSources, ...materialized.addedSources]) {
        const index = current.sources.findIndex(
          (candidate) =>
            candidate.id === source.id ||
            (!!candidate.metadata.url && candidate.metadata.url === source.metadata.url),
        );
        if (index >= 0) {
          current.sources[index] = source;
          applied += 1;
          continue;
        }
        const capacity = sourceCapacityError(current.sources, source.sizeBytes);
        if (capacity) {
          overLimit.push({ source, code: capacity.code, message: capacity.message });
          continue;
        }
        current.sources.push(source);
        applied += 1;
      }
      if (applied) current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    // 資產是在交易之前就落地的，排不進去的那幾筆留著就是孤兒：專案看不到、容量統計算不到，
    // 硬碟卻被佔著，而且每重試一次就多一份。
    for (const { source, code } of overLimit) {
      // 逐筆回**是哪一種上限**：份數滿了要刪幾份，容量滿了要刪大的那幾份，兩者的下一步不同。
      failures.push({ url: asTyped(source.metadata.url ?? ""), reason: code });
      if (materialized.addedSources.includes(source))
        await repository.deleteAssetDirectory(projectId, `sources/${source.id}`);
    }
    if (
      overLimit.length ===
      materialized.addedSources.length + materialized.refreshedSources.length
    ) {
      const first = overLimit[0]!;
      return response.status(409).json({
        error: first.code,
        message: `${first.message}（這一批沒有任何網址被加入）`,
        failures,
      });
    }
    retriever.index(project.id, project.sources);
    return response.status(201).json({ project, failures });
  });
}

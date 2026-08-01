import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { logWarn } from "@slide-maker/core";
import { asPersisted, idSchema } from "../project-write-helpers.js";
import { adoptVersion, staleVersionAssets, versionAssetPaths } from "../version-assets.js";
import type { AppContext } from "./context.js";

/** 版本歷史：還原、切換、刪除、改標籤，以及把某一版另存成風格參考圖。 */
export function registerVersionRoutes(app: Express, ctx: AppContext): void {
  const { repository, saveVersionStyleReference } = ctx;

  app.post(
    "/api/projects/:projectId/slides/:slideId/versions/:versionId/restore",
    async (request, response) => {
      const projectId = idSchema.parse(request.params.projectId);
      const slideId = idSchema.parse(request.params.slideId);
      const versionId = idSchema.parse(request.params.versionId);
      const project = await repository.updateProject(projectId, (current) => {
        const slide = current.slides.find((candidate) => candidate.id === slideId);
        const version = slide?.versions.find((candidate) => candidate.id === versionId);
        if (!slide || !version) throw new Error("Version not found");
        const restored = {
          ...structuredClone(version),
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          label: `Restored from ${version.id}`,
        };
        adoptVersion(slide, restored);
        // 回灌大綱與指定清單留在這裡：`adoptVersion` 只掛版本、切當前版本，其餘一概不碰
        // （`hidden` 是頁面層級的旗標，還原版本不得順手清掉它）。
        if (restored.outlineSnapshot) {
          // `pageType` 先歸零再套快照，因為 `Object.assign` 只複製**存在的鍵**：沒有頁型的
          // 快照（這個欄位加入之前的每一版，以及計畫沒表態的那幾頁——`undefined` 寫檔時就
          // 消失了）不會蓋掉頁面上現在那個值。少了這一行，「改頁型 → 生成 → 還原到舊版本」
          // 會留下新頁型卻同時標成 `outlineDirty: false`，而畫面上那張圖其實是在沒有頁型的
          // 合約下畫出來的。
          Object.assign(slide, { pageType: undefined }, structuredClone(restored.outlineSnapshot), {
            outlineDirty: false,
            // 回到舊版本＝這一頁完全回到當時的狀態，指定清單也要回到當時那一份。
            // 只夾掉越界的指定是不夠的：那樣會把「生成後才指定的來源」永久抹掉，而且不可逆；
            // 存在版本上就只是換一組指定，還原回較新的版本即可拿回來。
            pinnedSourceIds: [...(restored.pinnedSourceIds ?? [])],
          });
        } else slide.outlineDirty = true;
        current.updatedAt = restored.createdAt;
        return asPersisted(current);
      });
      return response.json(project);
    },
  );

  app.post(
    "/api/projects/:projectId/slides/:slideId/versions/:versionId/activate",
    async (request, response) => {
      const projectId = idSchema.parse(request.params.projectId);
      const slideId = idSchema.parse(request.params.slideId);
      const versionId = idSchema.parse(request.params.versionId);
      const project = await repository.updateProject(projectId, (current) => {
        const slide = current.slides.find((candidate) => candidate.id === slideId);
        const version = slide?.versions.find((candidate) => candidate.id === versionId);
        if (!slide || !version) throw new Error("Version not found");
        slide.currentVersionId = version.id;
        if (version.outlineSnapshot) {
          // 與 restore 同一套語意：切回哪一版，就用那一版當時生效的指定；`pageType` 同樣
          // 要先歸零（見 restore 那條的說明）。
          Object.assign(slide, { pageType: undefined }, structuredClone(version.outlineSnapshot), {
            outlineDirty: false,
            pinnedSourceIds: [...(version.pinnedSourceIds ?? [])],
          });
        } else slide.outlineDirty = true;
        current.updatedAt = new Date().toISOString();
        return asPersisted(current);
      });
      return response.json(project);
    },
  );

  app.delete(
    "/api/projects/:projectId/slides/:slideId/versions/:versionId",
    async (request, response) => {
      const projectId = idSchema.parse(request.params.projectId);
      const slideId = idSchema.parse(request.params.slideId);
      const versionId = idSchema.parse(request.params.versionId);
      const { project, staleAssets } = await repository.updateProject(projectId, (current) => {
        const slide = current.slides.find((candidate) => candidate.id === slideId);
        const index = slide?.versions.findIndex((candidate) => candidate.id === versionId) ?? -1;
        if (!slide || index < 0) throw new Error("Version not found");
        const version = slide.versions[index]!;
        // 匯出、edit-image、extract-text 全都以 currentVersion 為基準，刪掉它會讓這一頁
        // 進入沒有圖的狀態；要刪就先切到別的版本。
        if (version.id === slide.currentVersionId) throw new Error("VERSION_IN_USE");
        // 進行中的任務完成時要回寫這個版本（當 base，或是 extract-text 的替換目標）；
        // 先刪掉的話任務結束只會拿到一個對不上的 id。
        if (
          // 不限定 job.slideId：版本 id 是 UUID，多比幾筆沒有代價，但少了這層耦合，
          // 日後若有跨頁引用版本的任務，這道守門不會無聲地失效。
          current.jobs.some(
            (job) =>
              ["queued", "running"].includes(job.status) &&
              (job.baseVersionId === versionId ||
                job.textExtraction?.originalVersionId === versionId ||
                job.textExtraction?.replaceVersionId === versionId),
          )
        )
          throw new Error("VERSION_HAS_ACTIVE_JOB");
        // PDF 匯入與文字抽離會留下「原圖版本 A ← 可編輯文字版本 B」的配對，B 的重新抽字
        // 與原圖保真都依賴 A 還在，所以被引用的原圖版本不能單獨刪。
        if (
          current.slides.some((candidate) =>
            candidate.versions.some(
              (other) => other.id !== versionId && other.textLayer?.originalVersionId === versionId,
            ),
          )
        )
          throw new Error("VERSION_REFERENCED_BY_TEXT_LAYER");
        const staleCandidates = versionAssetPaths(version);
        slide.versions.splice(index, 1);
        current.updatedAt = new Date().toISOString();
        // restore 是 structuredClone 舊版本，多個版本共用同一個 imagePath 是常態：資產是否
        // 該刪，只能在移除之後重算全專案的引用才算得準（`staleVersionAssets` 的前提）。
        return {
          project: asPersisted(current),
          staleAssets: staleVersionAssets(current, staleCandidates),
        };
      });
      // 刪除是這批資產最後一次被算到：引用集合不會再重算，刪不掉就是永久孤兒。
      // 別的路徑（jobs、text-layer）失敗還有下一次回收，這裡沒有，所以要留得下線索。
      const reclaimed = await Promise.allSettled(
        staleAssets.map((assetPath) => repository.deleteAsset(projectId, assetPath)),
      );
      reclaimed.forEach((result, index) => {
        if (result.status === "rejected")
          logWarn(
            "version_asset_reclaim_failed",
            { projectId, slideId, versionId, assetPath: staleAssets[index] },
            result.reason,
          );
      });
      response.json(project);
    },
  );

  app.patch(
    "/api/projects/:projectId/slides/:slideId/versions/:versionId",
    async (request, response) => {
      const projectId = idSchema.parse(request.params.projectId);
      const slideId = idSchema.parse(request.params.slideId);
      const versionId = idSchema.parse(request.params.versionId);
      const { label } = z.object({ label: z.string().trim().min(1).max(120) }).parse(request.body);
      const project = await repository.updateProject(projectId, (current) => {
        const version = current.slides
          .find((slide) => slide.id === slideId)
          ?.versions.find((item) => item.id === versionId);
        if (!version) throw new Error("Version not found");
        version.label = label;
        current.updatedAt = new Date().toISOString();
        return structuredClone(current);
      });
      response.json(project);
    },
  );

  app.post(
    "/api/projects/:projectId/slides/:slideId/versions/:versionId/style-reference",
    async (request, response) => {
      const projectId = idSchema.parse(request.params.projectId);
      const slideId = idSchema.parse(request.params.slideId);
      const versionId = idSchema.parse(request.params.versionId);
      const project = await repository.loadProject(projectId);
      if (!project) throw new Error("Project not found");
      response.status(201).json(await saveVersionStyleReference(project, slideId, versionId));
    },
  );
}

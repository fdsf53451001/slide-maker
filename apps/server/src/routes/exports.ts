import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import express, { type Express } from "express";
import { z } from "zod";
import {
  exportFilename,
  exportPresentation,
  exportSlideFilename,
  exportSlidePng,
  parseProjectBundle,
  type ExportFormat,
} from "../exporters.js";
import { sendChunked } from "../http-stream.js";
import { idSchema } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/** 五種格式的整份匯出、單頁 PNG、專案封存匯入，以及專案資產的靜態取用。 */
export function registerExportRoutes(app: Express, ctx: AppContext): void {
  const { repository, retriever } = ctx;

  app.get("/api/projects/:projectId/export/:format", async (request, response) => {
    const project = await repository.loadProject(idSchema.parse(request.params.projectId));
    if (!project) throw new Error("Project not found");
    const format = z
      .enum(["pptx", "pdf", "png.zip", "slide-project", "outline.md"])
      .parse(request.params.format) as ExportFormat;
    const bytes = await exportPresentation(repository, project, format);
    const mediaTypes: Record<ExportFormat, string> = {
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      pdf: "application/pdf",
      "png.zip": "application/zip",
      "slide-project": "application/zip",
      "outline.md": "text/markdown; charset=utf-8",
    };
    response.setHeader("Content-Type", mediaTypes[format]);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(exportFilename(project, format))}`,
    );
    // 一定要走 chunked：`response.send()` 會補 Content-Length，Cloud Run 對這種
    // non-streamed 回應有 32 MiB 上限，大一點的簡報匯出必爆。詳見 sendChunked。
    // **沒有格式例外**：`outline.md` 是純文字、看起來一定很小，但 100 頁的大綱不小，
    // 而且一條路上放兩種寫法，下一個人只會抄到錯的那一種。
    await sendChunked(response, bytes);
  });

  // 單頁 PNG。刻意不塞進上面那條 `:format`：那條的 format 是專案級格式的 enum，
  // 單頁需要 slideId，掛成 query 參數會讓「哪些格式吃得下它」變成隱性知識。
  app.get("/api/projects/:projectId/slides/:slideId/export/png", async (request, response) => {
    const project = await repository.loadProject(idSchema.parse(request.params.projectId));
    if (!project) throw new Error("Project not found");
    const slideId = idSchema.parse(request.params.slideId);
    const bytes = await exportSlidePng(repository, project, slideId);
    const order = project.slides.find((slide) => slide.id === slideId)!.order;
    response.setHeader("Content-Type", "image/png");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(exportSlideFilename(project, order))}`,
    );
    // 單頁也走 chunked：無損 PNG 的 1920×1080 一般是幾 MB，但 PDF 匯入保真的原圖沒有上限，
    // 而 `response.send()` 一旦補上 Content-Length，Cloud Run 的 32 MiB 天花板就回來了。
    await sendChunked(response, bytes);
  });

  app.post(
    "/api/projects/import",
    express.raw({ type: () => true, limit: "2gb" }),
    async (request, response) => {
      const bytes =
        request.body instanceof Buffer ? new Uint8Array(request.body) : new Uint8Array();
      const bundle = parseProjectBundle(bytes);
      const id = randomUUID();
      const imported = {
        ...bundle.project,
        id,
        name: `${bundle.project.name}（匯入）`,
        jobs: [],
        // 封存可能是在描述途中做的，於是 parsing 被烘進 zip 裡。啟動修復早就跑完了，
        // 新專案 id 也沒有任何背景工作認得，留著就是前端永遠顯示「AI 分析圖片內容中…」
        // 並每 1.5 秒輪詢一次。狀態是執行期的東西，不該跟著封存跨程序旅行。
        sources: bundle.project.sources.map((source) =>
          source.status === "parsing" ? { ...source, status: "indexed" as const } : source,
        ),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      for (const [name, asset] of Object.entries(bundle.assets))
        await repository.saveAsset(id, name.replace(/^assets\//, ""), asset);
      await repository.saveProject(imported);
      retriever.index(imported.id, imported.sources);
      response.status(201).json(imported);
    },
  );

  app.get("/api/projects/:projectId/assets/*assetPath", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const assetPath = Array.isArray(request.params.assetPath)
      ? request.params.assetPath.join("/")
      : request.params.assetPath;
    const absolutePath = repository.assetPath(projectId, assetPath);
    // 缺檔是正常情形（刪掉版本後，畫面上還沒重整的舊 <img> 會再要一次），不是伺服器
    // 故障：ENOENT 的訊息是 "no such file or directory"，不加這一段會落到最後的
    // INTERNAL_SERVER_ERROR，把使用者的一般操作記成 500。
    try {
      await access(absolutePath);
    } catch {
      return response.status(404).json({ error: "ASSET_NOT_FOUND" });
    }
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.sendFile(absolutePath, { dotfiles: "allow" });
  });
}

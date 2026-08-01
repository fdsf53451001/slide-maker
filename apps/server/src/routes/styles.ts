import express, { type Express } from "express";
import { z } from "zod";
import { renderPdfPages } from "../pdf-pages.js";
import { idSchema } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/** 風格庫 CRUD、風格參考圖資產，以及「從 PDF 建立風格」的無狀態縮圖端點。 */
export function registerStyleRoutes(app: Express, ctx: AppContext): void {
  const { styles } = ctx;

  app.get("/api/styles", async (_request, response) => response.json(await styles.list()));
  app.post("/api/styles", async (request, response) =>
    response.status(201).json(await styles.create(request.body)),
  );
  app.get("/api/styles/:styleId", async (request, response) => {
    const style = await styles.get(idSchema.parse(request.params.styleId));
    if (!style) throw new Error("Style not found");
    response.json(style);
  });
  app.patch("/api/styles/:styleId", async (request, response) =>
    response.json(await styles.update(idSchema.parse(request.params.styleId), request.body)),
  );
  app.get("/api/styles/:styleId/versions", async (request, response) =>
    response.json(await styles.listVersions(idSchema.parse(request.params.styleId))),
  );
  app.post("/api/styles/:styleId/duplicate", async (request, response) =>
    response.status(201).json(await styles.duplicate(idSchema.parse(request.params.styleId))),
  );
  app.post("/api/styles/:styleId/versions/:version/restore", async (request, response) => {
    const styleId = idSchema.parse(request.params.styleId);
    const version = z.coerce.number().int().positive().parse(request.params.version);
    const historical = await styles.get(styleId, version);
    if (!historical) throw new Error("Style not found");
    response.json(
      await styles.update(styleId, {
        name: historical.name,
        description: historical.description,
        density: historical.density,
        imageDirection: historical.imageDirection,
        avoid: historical.avoid,
        promptTemplate: historical.promptTemplate,
        referenceImages: historical.referenceImages,
        coverImageId: historical.coverImageId,
      }),
    );
  });
  app.post(
    "/api/style-assets",
    express.raw({ type: () => true, limit: "16mb" }),
    async (request, response) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(255),
          mediaType: z.enum(["image/png", "image/jpeg"]),
        })
        .parse(request.query);
      const bytes =
        request.body instanceof Buffer ? new Uint8Array(request.body) : new Uint8Array();
      response.status(201).json(await styles.saveReference(input.name, input.mediaType, bytes));
    },
  );
  app.get("/api/style-assets/:assetId", async (request, response) => {
    const reference = await styles.referenceMetadata(idSchema.parse(request.params.assetId));
    if (!reference) throw new Error("Style asset not found");
    response
      .type(reference.mediaType)
      .setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.sendFile(styles.referenceAssetPath(reference.assetPath), { dotfiles: "allow" });
  });
  // 「從 PDF 建立風格」：無狀態把上傳的 PDF render 成頁面 PNG，供前端挑選；
  // 選中的頁面再走 /api/style-assets 存成正式參考圖（見 pdf-pages.ts）。
  app.post(
    "/api/pdf-pages",
    express.raw({ type: () => true, limit: "100mb" }),
    async (request, response) => {
      const bytes =
        request.body instanceof Buffer ? new Uint8Array(request.body) : new Uint8Array();
      response.json(await renderPdfPages(bytes));
    },
  );
}

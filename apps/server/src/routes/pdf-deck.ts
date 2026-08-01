import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { z } from "zod";
import { createProject, slideSpecSchema, type SlideVersion } from "@slide-maker/core";
import {
  DECK_PAGE_HEIGHT,
  DECK_PAGE_WIDTH,
  MAX_DECK_PAGES,
  inspectPdfDeck,
  renderDeckPages,
  renderDeckPreviews,
} from "../pdf-deck.js";
import { renderComposite } from "../text-layers.js";
import type { AppContext } from "./context.js";

/** 「從 PDF 匯入簡報」的檢視與匯入兩條 route（全程零模型，見 pdf-deck.ts）。 */
export function registerPdfDeckRoutes(app: Express, ctx: AppContext): void {
  const { repository } = ctx;

  // ── 從 PDF 匯入簡報 ────────────────────────────────────────────────────────
  // 與「從 PDF 建立風格」（/api/pdf-pages）完全分開：那條是 1024px 縮圖、上限 24 頁、
  // 無狀態；這條是 1920×1080、上限 150 頁、確認後專案立刻落地並保留 PDF 原檔。
  app.post(
    "/api/pdf-deck/inspect",
    express.raw({ type: () => true, limit: "100mb" }),
    async (request, response) => {
      const bytes =
        request.body instanceof Buffer ? new Uint8Array(request.body) : new Uint8Array();
      const inspection = await inspectPdfDeck(bytes);
      const preview = await renderDeckPreviews(bytes, inspection.acceptedPages);
      // inspect 階段量不到尺寸的損壞頁不在 acceptedPages 裡，preview 不會碰到它們，
      // 所以要在這裡把 inspect 的 failedPages 併進去，否則損壞頁會從回應裡無聲消失。
      const failedPages = [...new Set([...inspection.failedPages, ...preview.failedPages])].sort(
        (left, right) => left - right,
      );
      response.json({
        totalPages: inspection.totalPages,
        truncated: inspection.truncated,
        maxPages: MAX_DECK_PAGES,
        acceptedPages: inspection.acceptedPages,
        skippedPages: inspection.skippedPages,
        failedPages,
        previews: preview.previews,
      });
    },
  );

  app.post(
    "/api/pdf-deck/import",
    express.raw({ type: () => true, limit: "100mb" }),
    async (request, response) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(200),
          pages: z.string().trim().min(1).max(2_000),
        })
        .parse(request.query);
      const requested = [
        ...new Set(
          input.pages
            .split(",")
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value >= 1),
        ),
      ].sort((left, right) => left - right);
      if (!requested.length || requested.length > MAX_DECK_PAGES)
        throw new Error("PDF_PAGE_SELECTION_INVALID");
      const bytes =
        request.body instanceof Buffer ? new Uint8Array(request.body) : new Uint8Array();
      // 選檔階段已驗過比例，這裡重驗一次：請求可以被改，不能相信客戶端送來的頁碼。
      const inspection = await inspectPdfDeck(bytes);
      const accepted = new Set(inspection.acceptedPages);
      const pageNumbers = requested.filter((pageNumber) => accepted.has(pageNumber));
      if (!pageNumbers.length) throw new Error("PDF_PAGE_SELECTION_INVALID");
      // 原圖與可編輯文字層一次做完：兩個 version 在匯入當下就都建好，之後只靠既有的
      // 版本切換 UI 存取，沒有「按一顆按鈕才即時抽字」的延後路徑。
      const rendered = await renderDeckPages(bytes, pageNumbers, {}, { textLayer: true });
      if (!rendered.pages.length) throw new Error("PDF_RENDER_FAILED");
      const now = new Date().toISOString();
      const project = createProject({
        topic: input.name,
        name: input.name,
        // desiredSlideCount 的 schema 上限是 100；此欄位只在生成大綱時用，匯入專案不走那條路。
        brief: { desiredSlideCount: Math.min(rendered.pages.length, 100) },
        now,
      });
      project.canvas = { width: DECK_PAGE_WIDTH, height: DECK_PAGE_HEIGHT };
      // 分析頁是專案的一個狀態（不是前端暫存）：重新整理會回到同一頁。
      project.workflowStage = "settings";
      // 原檔與每頁 PNG 都寫在 `saveProject` 之前，中途 throw 的話 `project.json`
      // 不會存在 → 專案不在 `listProjects()` 裡，但目錄下已經躺著 100MB 的 PDF
      // 與一堆 PNG，UI 看不到也刪不掉。任一步失敗就把整個專案目錄清掉。
      try {
        const sourcePath = await repository.saveAsset(project.id, "pdf-import/source.pdf", bytes);
        // 刻意逐頁序列處理：每頁的合成要 sharp 解出兩張 1920×1080 的原始像素，
        // 150 頁一起併發會把記憶體推到 GB 等級，而寫檔本來就是瓶頸。
        const slides = [];
        for (const [order, page] of rendered.pages.entries()) {
          const slideId = randomUUID();
          const originalVersionId = randomUUID();
          const imagePath = await repository.saveAsset(
            project.id,
            `${slideId}/${originalVersionId}.png`,
            page.png,
          );
          const outlineSnapshot = {
            purpose: page.title,
            content: page.content,
            narrative: "",
            layoutHint: "",
            imagePrompt: "",
            sourceIds: [],
          };
          const originalVersion: SlideVersion = {
            id: originalVersionId,
            imagePath,
            prompt: "",
            providerId: "pdf-import",
            model: "pdf-import",
            // 保留 PDF 原檔與頁碼：日後要重抽這一頁的文字層還回得去。
            parameters: {
              pdfImport: true,
              pdfPage: page.pageNumber,
              pdfSourcePath: sourcePath,
            },
            styleVersion: project.styleSnapshot.version,
            sources: [],
            outlineSnapshot,
            createdAt: now,
            label: "原始頁面",
          };
          const versions: SlideVersion[] = [originalVersion];
          // 掃描頁沒有原生文字層，就只有原圖版本——不報錯，也不對使用者提示。
          // 其他原因抽不出來的頁同樣只有原圖，但會列進 report.textLayerFailedPages。
          if (page.textLayer) {
            const textVersionId = randomUUID();
            const backgroundPath = await repository.saveAsset(
              project.id,
              `text-layers/${originalVersionId}/background-${textVersionId}.png`,
              page.textLayer.background,
            );
            const textLayer = {
              originalVersionId,
              backgroundPath,
              compositePath: backgroundPath,
              threshold: 0.75,
              renderRevision: 0,
              boxes: page.textLayer.boxes,
              extractedAt: now,
              updatedAt: now,
            };
            textLayer.compositePath = await renderComposite(repository, project, textLayer);
            versions.push({
              ...originalVersion,
              id: textVersionId,
              imagePath: textLayer.compositePath,
              label: "可編輯文字",
              textLayer,
            });
          }
          slides.push(
            slideSpecSchema.parse({
              id: slideId,
              order,
              ...outlineSnapshot,
              dataBasis: [],
              sourceIds: [],
              // 預設顯示原圖：匯出保真，要編輯文字再從版本歷史切到「可編輯文字」。
              currentVersionId: originalVersionId,
              versions,
            }),
          );
        }
        project.slides = slides;
        await repository.saveProject(project);
      } catch (error) {
        // 這個 id 是剛剛才生出來的，目錄下只有這次匯入寫的東西，整個移除是安全的。
        await repository.deleteProject(project.id).catch(() => undefined);
        throw error;
      }
      response.status(201).json({
        project,
        report: {
          totalPages: inspection.totalPages,
          importedPages: rendered.pages.map((page) => page.pageNumber),
          skippedPages: inspection.skippedPages,
          // render 跳過的頁與 inspect 就量不到尺寸的損壞頁合併回報。
          failedPages: [...new Set([...inspection.failedPages, ...rendered.failedPages])].sort(
            (left, right) => left - right,
          ),
          // 掃描頁本來就沒有原生文字（不列出）；這裡只有非預期失敗的頁。
          textLayerFailedPages: rendered.pages
            .filter((page) => page.textLayerError)
            .map((page) => page.pageNumber),
          truncated: inspection.truncated,
        },
      });
    },
  );
}

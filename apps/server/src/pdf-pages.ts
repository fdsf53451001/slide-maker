import { pdf } from "pdf-to-img";
import sharp from "sharp";

/**
 * 把上傳的 PDF 光柵化成一組頁面 PNG，供「從 PDF 建立風格」的頁面挑選器使用。
 *
 * 設計取向（見 CLAUDE.md 與設計共識）：
 *  - 無狀態：PDF bytes 進 → 頁面 data URL 陣列出，server 不留任何暫存；使用者挑中的頁面
 *    由前端轉成 PNG File 走既有 `/api/style-assets`（`saveReference`）存成正式參考圖。
 *  - 只 render 前 `MAX_PDF_PAGES` 頁把回傳 payload 壓住；超過則回 `truncated: true`，UI 提示。
 *  - 每頁先由 pdf.js 以 `RENDER_SCALE` 放大 render，再用 sharp 縮到長邊 `PAGE_LONG_EDGE`——
 *    當風格參考圖／餵多模態分析已綽綽有餘，且單頁約數百 KB。
 *  - PPTX 不在此處理：v1 引導使用者另存為 PDF；未來 PPTX 走 env-gated `soffice` 轉 PDF 後共用本管線。
 */

const MAX_PDF_BYTES = 100 * 1024 * 1024; // 與 source ingest 上限一致
export const MAX_PDF_PAGES = 24; // picker 只顯示前 N 頁
const PAGE_LONG_EDGE = 1024; // 每頁 render 後長邊上限（px）
const RENDER_SCALE = 2; // pdf.js viewport 放大係數，之後由 sharp 縮到 PAGE_LONG_EDGE

export interface RenderedPdf {
  /** 每頁一張 `data:image/png;base64,...`（最多 `MAX_PDF_PAGES` 張）。 */
  pages: string[];
  /** PDF 實際頁數（可能大於 `pages.length`）。 */
  totalPages: number;
  /** 是否因超過 `MAX_PDF_PAGES` 而截斷。 */
  truncated: boolean;
}

/** 把 PDF bytes render 成頁面 PNG data URL 陣列。非法／加密／壞檔會 throw 具名錯誤碼。 */
export async function renderPdfPages(bytes: Uint8Array): Promise<RenderedPdf> {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) throw new Error("PDF_SIZE_INVALID");
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-")))
    throw new Error("PDF_INVALID");

  let document: Awaited<ReturnType<typeof pdf>>;
  try {
    // pdf-to-img 需要可寫的 Buffer（會 transfer underlying ArrayBuffer），故複製一份。
    document = await pdf(Buffer.from(bytes), { scale: RENDER_SCALE });
  } catch {
    // getDocument 失敗：多半是加密（需密碼）或結構損壞。
    throw new Error("PDF_RENDER_FAILED");
  }

  const totalPages = document.length;
  if (!totalPages) throw new Error("PDF_EMPTY");

  const pages: string[] = [];
  try {
    let index = 0;
    for await (const pageImage of document) {
      if (index >= MAX_PDF_PAGES) break;
      index += 1;
      const png = await sharp(pageImage)
        .resize({
          width: PAGE_LONG_EDGE,
          height: PAGE_LONG_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
      pages.push(`data:image/png;base64,${png.toString("base64")}`);
    }
  } catch {
    throw new Error("PDF_RENDER_FAILED");
  }

  return { pages, totalPages, truncated: totalPages > MAX_PDF_PAGES };
}

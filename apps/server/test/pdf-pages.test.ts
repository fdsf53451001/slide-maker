import { PDFDocument, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MAX_PDF_PAGES, renderPdfPages } from "../src/pdf-pages.js";

async function makePdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage([480, 270]);
    page.drawRectangle({ x: 0, y: 0, width: 480, height: 270, color: rgb(0.1, 0.2, 0.6) });
    page.drawText(`Slide ${index + 1}`, { x: 40, y: 130, size: 40, color: rgb(1, 1, 1) });
  }
  return doc.save();
}

describe("renderPdfPages", () => {
  it("renders every page to a PNG data URL sized to the long edge", async () => {
    const result = await renderPdfPages(await makePdf(3));
    expect(result.totalPages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.pages).toHaveLength(3);
    for (const page of result.pages) expect(page.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("caps rendered pages at MAX_PDF_PAGES and flags truncation", async () => {
    const result = await renderPdfPages(await makePdf(MAX_PDF_PAGES + 2));
    expect(result.totalPages).toBe(MAX_PDF_PAGES + 2);
    expect(result.pages).toHaveLength(MAX_PDF_PAGES);
    expect(result.truncated).toBe(true);
  });

  it("rejects empty input", async () => {
    await expect(renderPdfPages(new Uint8Array())).rejects.toThrow("PDF_SIZE_INVALID");
  });

  it("rejects bytes without a %PDF- header", async () => {
    await expect(renderPdfPages(new TextEncoder().encode("not a pdf"))).rejects.toThrow(
      "PDF_INVALID",
    );
  });

  it("fails cleanly on a corrupt PDF body", async () => {
    const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00]);
    await expect(renderPdfPages(corrupt)).rejects.toThrow("PDF_RENDER_FAILED");
  });
});

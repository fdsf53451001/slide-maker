import { expect, test } from "@playwright/test";
import {
  expectWithin,
  expectedTextBox,
  getProject,
  openEditor,
  pageNumberLabel,
  pageNumberLayout,
  rectOf,
  seedGeneratedProject,
  setPageNumber,
  type PageNumberSettings,
  type Rect,
} from "../helpers.js";

// The page-number overlay's position is derived solely from
// packages/core/src/page-number.ts. Assertions here are all computed from
// pageNumberLayout()/pageNumberLabel() — never hard-coded — and compared to the
// real DOM rects. The conversion frame is `.page-number-layer` (inset:0 inside
// the canvas content box), which cancels the canvas's 1px border.

const CANVAS = { width: 1920, height: 1080 };
const POSITIONS = ["bottom-left", "bottom-center", "bottom-right"] as const;
const JUSTIFY: Record<(typeof POSITIONS)[number], string> = {
  "bottom-left": "flex-start",
  "bottom-center": "center",
  "bottom-right": "flex-end",
};

function expectedChipBox(settings: PageNumberSettings, label: string, frame: Rect): Rect | null {
  const { chip } = pageNumberLayout(settings, CANVAS, label);
  if (!chip) return null;
  return {
    x: frame.x + (chip.x / CANVAS.width) * frame.width,
    y: frame.y + (chip.y / CANVAS.height) * frame.height,
    width: (chip.width / CANVAS.width) * frame.width,
    height: (chip.height / CANVAS.height) * frame.height,
  };
}

test.describe("page number overlay geometry", () => {
  for (const position of POSITIONS) {
    test(`position ${position} matches pageNumberLayout (text + chip, within canvas)`, async ({
      page,
      request,
    }) => {
      const seeded = await seedGeneratedProject(request, {
        topic: `頁碼-${position}`,
        slideCount: 3,
      });
      // skipFirstSlide:false so the selected cover slide (order 0) is numbered.
      const project = await setPageNumber(request, seeded.id, {
        enabled: true,
        skipFirstSlide: false,
        position,
        background: { enabled: true },
      });
      const settings = project.pageNumber;
      const label = pageNumberLabel(settings, 0, project.slides.length)!;
      expect(label).toBeTruthy();

      await openEditor(page, project.id);
      const layer = await rectOf(page, ".page-number-layer");
      const canvas = await rectOf(page, ".canvas");

      // Rendered label text is exactly what core computes.
      await expect(page.locator(".page-number-text")).toHaveText(label);

      // Text box geometry.
      const textRect = await rectOf(page, ".page-number-text");
      const expText = expectedTextBox(settings, CANVAS, label, layer);
      expect(Math.abs(textRect.x - expText.x), "text x").toBeLessThanOrEqual(1);
      expect(Math.abs(textRect.y - expText.y), "text y").toBeLessThanOrEqual(1);
      expect(Math.abs(textRect.width - expText.width), "text width").toBeLessThanOrEqual(1);
      expect(Math.abs(textRect.height - expText.height), "text height").toBeLessThanOrEqual(1);

      // Alignment contract (this is what actually moves the glyph per position).
      await expect(page.locator(".page-number-text")).toHaveCSS(
        "justify-content",
        JUSTIFY[position],
      );

      // Chip box geometry is position-dependent — a real positional check.
      const chipRect = await rectOf(page, ".page-number-chip");
      const expChip = expectedChipBox(settings, label, layer)!;
      expect(Math.abs(chipRect.x - expChip.x), "chip x").toBeLessThanOrEqual(1);
      expect(Math.abs(chipRect.y - expChip.y), "chip y").toBeLessThanOrEqual(1);
      expect(Math.abs(chipRect.width - expChip.width), "chip width").toBeLessThanOrEqual(1.5);

      // Nothing lands in a letterbox or gets clipped by the canvas.
      expectWithin(textRect, canvas);
      expectWithin(chipRect, canvas);
    });
  }

  test("format options render the labels core computes", async ({ page, request }) => {
    const seeded = await seedGeneratedProject(request, { topic: "頁碼格式", slideCount: 4 });
    for (const format of ["number", "number-total", "zh-page"] as const) {
      const project = await setPageNumber(request, seeded.id, {
        enabled: true,
        skipFirstSlide: false,
        format,
      });
      const expected = pageNumberLabel(project.pageNumber, 0, project.slides.length)!;
      await openEditor(page, project.id);
      await expect(page.locator(".page-number-text")).toHaveText(expected);
    }
  });

  test("skipFirstSlide hides the number on the cover but shows it on page 2", async ({
    page,
    request,
  }) => {
    const seeded = await seedGeneratedProject(request, { topic: "頁碼封面", slideCount: 3 });
    const project = await setPageNumber(request, seeded.id, {
      enabled: true,
      skipFirstSlide: true,
      position: "bottom-right",
    });

    await openEditor(page, project.id);
    // Cover (order 0) — pageNumberLabel returns undefined → overlay renders nothing.
    expect(pageNumberLabel(project.pageNumber, 0, project.slides.length)).toBeUndefined();
    await expect(page.locator(".page-number-text")).toHaveCount(0);

    // Switch to slide 2 (order 1).
    await page.locator(".thumbnails .thumbnail").nth(1).click();
    const label = pageNumberLabel(project.pageNumber, 1, project.slides.length)!;
    await expect(page.locator(".page-number-text")).toHaveText(label);
    const layer = await rectOf(page, ".page-number-layer");
    const canvas = await rectOf(page, ".canvas");
    const textRect = await rectOf(page, ".page-number-text");
    const expText = expectedTextBox(project.pageNumber, CANVAS, label, layer);
    expect(Math.abs(textRect.x - expText.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(textRect.y - expText.y)).toBeLessThanOrEqual(1);
    expectWithin(textRect, canvas);
  });

  test("the 設定 tab toggle turns the overlay on", async ({ page, request }) => {
    const seeded = await seedGeneratedProject(request, { topic: "頁碼開關", slideCount: 3 });
    await openEditor(page, seeded.id);

    await expect(page.locator(".page-number-text")).toHaveCount(0);
    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    await page.getByLabel("顯示頁碼").check();
    // Default skipFirstSlide:true hides it on the cover — uncheck to see it here.
    await page.getByLabel("封面不編號").uncheck();

    // Overlay is driven by optimistic local state, so it appears immediately.
    await expect(page.locator(".page-number-text")).toBeVisible();
    // The persisted settings (PATCH is async) should converge to a real label.
    await expect
      .poll(async () => {
        const project = await getProject(request, seeded.id);
        return pageNumberLabel(project.pageNumber, 0, project.slides.length);
      })
      .toBe("1");
    await expect(page.locator(".page-number-text")).toHaveText("1");
  });
});

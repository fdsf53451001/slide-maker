import { expect, test } from "@playwright/test";
import {
  assertNoLetterbox,
  assertRatio,
  expectWithin,
  expectedTextBox,
  openEditor,
  pageNumberLabel,
  rectOf,
  seedGeneratedProject,
  setPageNumber,
  stubFullscreen,
  type PresentationProject,
} from "../helpers.js";

// Presentation mode: `.presentation-stage` must be an exact canvas ratio via an
// explicit min() size, and the page number must sit on the image rect — never in
// the letterbox bars around it. Fullscreen is stubbed so the overlay stays open
// deterministically under headless Chromium.

const AR = 16 / 9;
const CANVAS = { width: 1920, height: 1080 };

test.describe("presentation mode", () => {
  let project: PresentationProject;

  test.beforeAll(async ({ request }) => {
    const seeded = await seedGeneratedProject(request, { topic: "簡報模式", slideCount: 3 });
    project = await setPageNumber(request, seeded.id, {
      enabled: true,
      skipFirstSlide: false,
      position: "bottom-right",
      background: { enabled: true },
    });
  });

  test.beforeEach(async ({ page }) => {
    await stubFullscreen(page);
  });

  for (const vp of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    test(`stage is exactly 16:9 with the page number on the image at ${vp.width}x${vp.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(vp);
      await openEditor(page, project.id);

      await page.locator(".present-button").click();
      const stage = page.locator(".presentation-stage");
      await expect(stage).toBeVisible();

      const stageRect = await rectOf(page, ".presentation-stage");
      const surface = await rectOf(page, ".presentation-surface");
      assertRatio(stageRect, AR, 0.5);
      assertNoLetterbox(stageRect, surface);

      // Page number overlay sits inside the stage (the image rect), not the bars.
      const layer = await rectOf(page, ".presentation-stage .page-number-layer");
      const label = pageNumberLabel(project.pageNumber, 0, project.slides.length)!;
      await expect(page.locator(".presentation-stage .page-number-text")).toHaveText(label);
      const textRect = await rectOf(page, ".presentation-stage .page-number-text");
      const expText = expectedTextBox(project.pageNumber, CANVAS, label, layer);
      expect(Math.abs(textRect.x - expText.x), "text x").toBeLessThanOrEqual(1);
      expect(Math.abs(textRect.y - expText.y), "text y").toBeLessThanOrEqual(1);
      expect(Math.abs(textRect.width - expText.width), "text width").toBeLessThanOrEqual(1);
      expectWithin(textRect, stageRect);
    });
  }

  test("navigation controls advance and exit", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEditor(page, project.id);
    await page.locator(".present-button").click();

    const counter = page.locator(".presentation-controls span");
    await expect(counter).toHaveText(`1 / ${project.slides.length}`);
    await page.getByRole("button", { name: "下一頁" }).click();
    await expect(counter).toHaveText(`2 / ${project.slides.length}`);

    await page.getByRole("button", { name: "離開簡報模式" }).click();
    await expect(page.locator(".presentation-mode")).toHaveCount(0);
  });
});

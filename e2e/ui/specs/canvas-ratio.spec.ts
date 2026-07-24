import { expect, test } from "@playwright/test";
import {
  assertNoLetterbox,
  assertRatio,
  openEditor,
  rectOf,
  seedGeneratedProject,
  type PresentationProject,
} from "../helpers.js";

// CLAUDE.md flags this as a regression point: `.canvas` must be an EXACT canvas
// ratio via `--ar` + container-query units, never `aspect-ratio` + max-width,
// or the page number falls into a letterbox strip. We verify the real rendered
// geometry across viewport sizes.

const AR = 16 / 9;
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1100, height: 720 }, // narrow: below the shell's comfortable width
];

test.describe("canvas aspect ratio", () => {
  let project: PresentationProject;

  test.beforeAll(async ({ request }) => {
    project = await seedGeneratedProject(request, { topic: "畫布比例", slideCount: 3 });
  });

  for (const vp of VIEWPORTS) {
    test(`.canvas is exactly 16:9 with no letterbox at ${vp.width}x${vp.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(vp);
      await openEditor(page, project.id);

      const canvas = await rectOf(page, ".canvas");
      const fit = await rectOf(page, ".canvas-fit");

      // Exact canvas ratio within ±0.5px of width.
      assertRatio(canvas, AR, 0.5);
      // The canvas maximally fills its container on one axis (no wasted bars).
      assertNoLetterbox(canvas, fit);
      // Canvas never overflows its container.
      expect(canvas.width).toBeLessThanOrEqual(fit.width + 1.5);
      expect(canvas.height).toBeLessThanOrEqual(fit.height + 1.5);
    });
  }

  test("the slide image fills the canvas (object-fit contain, same box)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEditor(page, project.id);
    const canvas = await rectOf(page, ".canvas");
    const image = await rectOf(page, ".canvas img");
    // Image box equals the canvas content box (canvas rect is border-box, +1px
    // border each side, so the content box is ~2px smaller on each axis).
    expect(Math.abs(image.width - canvas.width)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(image.height - canvas.height)).toBeLessThanOrEqual(2.5);
    // Content box ratio drifts from 16:9 by the (unequal) 2px border inset.
    assertRatio(image, AR, 2.5);
  });
});

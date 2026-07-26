import { expect, test } from "@playwright/test";
import {
  assertNoLetterbox,
  expectWithin,
  openEditor,
  rectOf,
  seedGeneratedProject,
  setPageNumber,
  stubFullscreen,
  type PresentationProject,
} from "../helpers.js";

// Hidden slides in a real browser. Three claims here cannot be checked in jsdom,
// because they are entirely about computed style and layout:
//   1. `.thumb-hidden-badge` must stay fully opaque while `.thumb-canvas` is dimmed —
//      the reason the badge is a *sibling* of the canvas and not a child (a parent's
//      `opacity` applies to every descendant, and z-index cannot undo it).
//   2. `.thumb-actions` must be displayed on a hidden thumbnail *without hover*, since
//      the un-hide button in that row is the only way back.
//   3. The presentation stage's page-number overlay must sit on the image for the
//      *visible* sequence, i.e. hidden pages neither draw a number nor consume one.

const HIDDEN_ORDER = 1;

test.describe("hidden slides", () => {
  let project: PresentationProject;

  test.beforeAll(async ({ request }) => {
    const seeded = await seedGeneratedProject(request, { topic: "隱藏頁", slideCount: 4 });
    project = await setPageNumber(request, seeded.id, {
      enabled: true,
      skipFirstSlide: false,
      position: "bottom-right",
      format: "number-total",
      background: { enabled: true },
    });
    const target = project.slides.find((slide) => slide.order === HIDDEN_ORDER)!;
    const response = await request.patch(`/api/projects/${project.id}/slides/${target.id}`, {
      data: { hidden: true },
    });
    expect(response.ok()).toBe(true);
    project = (await response.json()) as PresentationProject;
  });

  test.beforeEach(async ({ page }) => {
    await stubFullscreen(page);
  });

  test("hidden thumbnail is dimmed but its badge and action row stay readable", async ({
    page,
  }) => {
    await openEditor(page, project.id);
    const thumbs = page.locator(".thumbnail");
    await expect(thumbs).toHaveCount(4);

    const hidden = thumbs.nth(HIDDEN_ORDER);
    await expect(hidden).toHaveClass(/hidden-slide/);

    // The canvas itself is dimmed…
    const canvasOpacity = await hidden
      .locator(".thumb-canvas")
      .evaluate((node) => Number(getComputedStyle(node).opacity));
    expect(canvasOpacity).toBeLessThan(0.5);

    // …but the badge is not a descendant of it, so it renders at full opacity.
    const badge = hidden.locator(".thumb-hidden-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("已隱藏");
    const badgeOpacity = await badge.evaluate((node) => {
      // Walk up and multiply: this is exactly what a parent `opacity` would do to it.
      let effective = 1;
      let current: Element | null = node;
      while (current && !current.classList.contains("thumbnail")) {
        effective *= Number(getComputedStyle(current).opacity);
        current = current.parentElement;
      }
      return effective;
    });
    expect(badgeOpacity).toBe(1);

    // The action row is visible without hover on the hidden thumbnail…
    await expect(hidden.locator(".thumb-actions")).toBeVisible();
    // The button's accessible name carries the state on its own ("un-hide" implies
    // "currently hidden"), which is why `aria-pressed` is deliberately absent — the two
    // together get announced as "un-hide this page, pressed", a double negative.
    await expect(hidden.locator(".thumb-hide")).toHaveAttribute("aria-label", "取消隱藏此頁");
    await expect(hidden.locator(".thumb-hide")).not.toHaveAttribute("aria-pressed", /.*/);
    await expect(thumbs.nth(2).locator(".thumb-hide")).toHaveAttribute("aria-label", "隱藏此頁");
    // …and still hover-only on the others (otherwise this proves nothing).
    await expect(thumbs.nth(2).locator(".thumb-actions")).toBeHidden();
  });

  test("hidden page is still selectable and editable, and carries no page number", async ({
    page,
  }) => {
    await openEditor(page, project.id);
    await page.locator(".thumbnail").nth(HIDDEN_ORDER).click();

    // Selecting it works and the canvas shows its image — hiding is not disabling.
    await expect(page.locator(".thumbnail").nth(HIDDEN_ORDER)).toHaveClass(/selected/);
    await expect(page.locator(".canvas img")).toBeVisible();
    // Hidden pages are not numbered, so the overlay is absent entirely.
    await expect(page.locator(".canvas .page-number-layer")).toHaveCount(0);

    // Its neighbours renumber around it: order 2 becomes the 2nd visible page.
    await page.locator(".thumbnail").nth(2).click();
    await expect(page.locator(".canvas .page-number-text")).toHaveText("2 / 3");
  });

  test("presentation mode skips the hidden page and keeps the number on the image", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEditor(page, project.id);
    await page.locator(".present-button").click();

    const stage = page.locator(".presentation-stage");
    await expect(stage).toBeVisible();
    await expect(page.locator(".presentation-controls span")).toHaveText("1 / 3");
    await expect(page.locator(".presentation-stage .page-number-text")).toHaveText("1 / 3");
    await expect(page.getByLabel("上一頁")).toBeDisabled();

    // Forward once: the hidden order-1 page must not appear — we land on order 2,
    // which is the 2nd *visible* page.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".presentation-controls span")).toHaveText("2 / 3");
    await expect(page.locator(".presentation-stage .page-number-text")).toHaveText("2 / 3");

    // The number is drawn on the slide image, never in the letterbox bars.
    const stageRect = await rectOf(page, ".presentation-stage");
    const surface = await rectOf(page, ".presentation-surface");
    assertNoLetterbox(stageRect, surface);
    expectWithin(await rectOf(page, ".presentation-stage .page-number-text"), stageRect);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".presentation-controls span")).toHaveText("3 / 3");
    await expect(page.getByLabel("下一頁")).toBeDisabled();
    // No wrap-around, and no falling into the hidden page.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".presentation-controls span")).toHaveText("3 / 3");
  });

  test("un-hiding from the thumbnail rail puts the page back into the sequence", async ({
    page,
    request,
  }) => {
    // Own project so the shared one above stays in its hidden state.
    const seeded = await seedGeneratedProject(request, { topic: "取消隱藏", slideCount: 3 });
    const numbered = await setPageNumber(request, seeded.id, {
      enabled: true,
      skipFirstSlide: false,
      format: "number-total",
    });
    const target = numbered.slides.find((slide) => slide.order === 1)!;
    await request.patch(`/api/projects/${numbered.id}/slides/${target.id}`, {
      data: { hidden: true },
    });

    await openEditor(page, numbered.id);
    const thumb = page.locator(".thumbnail").nth(1);
    await expect(thumb).toHaveClass(/hidden-slide/);

    await thumb.locator(".thumb-hide").click();
    await expect(thumb).not.toHaveClass(/hidden-slide/);
    await expect(thumb.locator(".thumb-hidden-badge")).toHaveCount(0);
    // Back to three visible pages, and no orange "out of sync with the image" outline:
    // hiding never touched a pixel, so a hide → un-hide round trip must not mark the
    // page outline-dirty (`.outline-dirty` is what draws that orange field border).
    await thumb.click();
    await expect(page.locator(".canvas .page-number-text")).toHaveText("2 / 3");
    await expect(page.locator(".fields .outline-dirty")).toHaveCount(0);
  });
});

import { expect, test } from "@playwright/test";
import { makeDeckPdf } from "../helpers.js";

// Full PDF-import UI path: dashboard → modal → upload a programmatically
// generated 16:9 PDF → preview grid → page selection → confirm → analysis
// screen → editor. Zero model quota (native text layer, mock nowhere involved).

test("import a generated 16:9 PDF and land in the editor", async ({ page }) => {
  const pdf = Buffer.from(await makeDeckPdf(4));

  await page.goto("/");
  await page.getByRole("button", { name: "匯入 PDF" }).click();

  const modal = page.getByRole("dialog", { name: "從 PDF 匯入簡報" });
  await expect(modal).toBeVisible();

  await modal.locator('input[type="file"]').setInputFiles({
    name: "e2e-deck.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });

  // Preview grid appears with one tile per accepted page.
  const tiles = modal.locator(".pdf-page");
  await expect(tiles).toHaveCount(4);
  await expect(modal.locator(".pdf-deck-name span")).toHaveText("共 4 頁，已選 4 頁。");

  // Name auto-fills from the filename.
  await expect(modal.locator(".pdf-deck-name input")).toHaveValue("e2e-deck");

  const confirm = modal.getByRole("button", { name: /^匯入 \d+ 頁$/ });
  await expect(confirm).toHaveText("匯入 4 頁");

  // Toggling a page off updates the count + the confirm label, then back on.
  await tiles.nth(3).click();
  await expect(tiles.nth(3)).toHaveAttribute("aria-pressed", "false");
  await expect(confirm).toHaveText("匯入 3 頁");
  await tiles.nth(3).click();
  await expect(confirm).toHaveText("匯入 4 頁");

  await confirm.click();

  // PDF-import projects route to the analysis screen (workflowStage "settings"),
  // which deliberately has no setup stepper.
  await expect(page.locator("main.pdf-analysis")).toBeVisible();
  await expect(page.locator('.setup-steps[aria-label="建立簡報流程"]')).toHaveCount(0);

  // Enter the editor with the default style.
  await page
    .locator(".pdf-analysis-actions")
    .getByRole("button", { name: /進編輯器/ })
    .click();

  await expect(page.locator(".shell")).toBeVisible();
  await expect(page.locator(".thumbnails .thumbnail")).toHaveCount(4);
  await expect(page.locator(".canvas img").first()).toBeVisible();
});

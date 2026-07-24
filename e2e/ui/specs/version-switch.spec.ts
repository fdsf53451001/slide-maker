import { expect, test, type Page } from "@playwright/test";
import { importDeck, openEditor } from "../helpers.js";

// A PDF-import project has two versions per page: "原始頁面" (original image,
// current) and "可編輯文字" (system-font text layer). Switching to the text-layer
// version must show the one-time system-font notice; acknowledging it must
// persist (localStorage) so it never shows again.

const FONT_NOTICE = /文字會以系統字型重繪/;

/** Preview a version by its aria-label, then commit the switch and wait for it. */
async function switchToVersion(page: Page, nameRe: RegExp): Promise<void> {
  await page.getByRole("button", { name: nameRe }).first().click();
  const actions = page.locator(".version-preview-actions");
  await actions.waitFor();
  await actions.getByRole("button", { name: "切換至此版本" }).click();
  await expect(actions).toHaveCount(0);
  // The target version is now the current one.
  await expect(
    page.getByRole("button", { name: new RegExp(nameRe.source + "（目前）") }),
  ).toBeVisible();
}

test("switching to the editable-text version shows the font notice exactly once", async ({
  page,
  request,
}) => {
  const project = await importDeck(request, { name: "版本切換", pages: 2 });
  await openEditor(page, project.id);

  // Current version is the original page — no notice yet.
  await expect(page.locator(".pdf-font-notice")).toHaveCount(0);

  // Switch to the "可編輯文字" version — the notice appears.
  await switchToVersion(page, /版本 2：可編輯文字/);
  const notice = page.locator(".pdf-font-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(FONT_NOTICE);

  // Acknowledge — the notice dismisses.
  await notice.getByRole("button", { name: "知道了" }).click();
  await expect(notice).toHaveCount(0);

  // Switch away and back again: the notice must not reappear.
  await switchToVersion(page, /版本 1：原始頁面/);
  await switchToVersion(page, /版本 2：可編輯文字/);
  await page.waitForTimeout(300);
  await expect(page.locator(".pdf-font-notice")).toHaveCount(0);

  // Still gone after a full reload — persisted in localStorage. The editor
  // reopens on the current (可編輯文字) version.
  await page.reload();
  await page.locator(".shell").waitFor();
  await expect(page.getByRole("button", { name: /版本 2：可編輯文字（目前）/ })).toBeVisible();
  await expect(page.locator(".pdf-font-notice")).toHaveCount(0);
});

import { expect, test } from "@playwright/test";

// Primary end-to-end navigation through the real UI, all on the mock image
// provider: dashboard → 4-step setup wizard (brief → outline via the NODE_ENV=test
// deterministic fallback → generate) → editor → export download. No API quota.

test("create → brief → outline → generate → editor → export", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/");
  await page.getByRole("button", { name: "簡報", exact: true }).waitFor();

  // Dashboard: describe the deck and start planning.
  await page.getByLabel("簡報需求").fill("E2E 全流程：向團隊說明自動化測試策略");
  await page.getByRole("button", { name: /開始規劃/ }).click();

  // Setup wizard step 1/2 — provider + brief on one screen.
  await expect(page.locator("main.setup-page")).toBeVisible();
  // The seeded default combination uses mock-image, surfaced by this hint.
  await expect(page.locator(".setup-provider-hint")).toContainText("Mock");
  await page.getByRole("button", { name: /下一步：上傳素材/ }).click();

  // Step 3 — materials; trigger outline generation (deterministic, offline).
  await page.getByRole("button", { name: /產生 \d+ 頁大綱/ }).click();

  // Step 4 — outline review + generate.
  await expect(page.locator(".outline-review")).toBeVisible();
  await expect(page.locator(".outline-review article").first()).toBeVisible();

  const generate = page.getByRole("button", { name: /確認設定並生成 \d+ 頁簡報/ });
  // Readiness must resolve before this enables; mock-image is always ready.
  await expect(generate).toBeEnabled({ timeout: 20_000 });
  await generate.click();

  // Editor: slides render once the background mock jobs finish.
  await expect(page.locator(".shell")).toBeVisible();
  await expect(page.locator(".thumbnails .thumbnail").first()).toBeVisible();
  await expect(page.locator(".canvas img").first()).toBeVisible({ timeout: 20_000 });

  // Export: the inspector tab exposes real download links.
  await page.locator(".inspector-tabs").getByRole("button", { name: "匯出", exact: true }).click();
  const pdfLink = page.getByRole("link", { name: "下載 PDF (.pdf)" });
  await expect(pdfLink).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), pdfLink.click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
});

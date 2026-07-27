import { expect, test, type Page } from "@playwright/test";
import { getProject, openEditor, seedGeneratedProject } from "../helpers.js";

/**
 * 「在沒有抽離過的圖上手動新增可編輯文字」的端到端一趟：建立 → 打字 → 自動儲存 →
 * 切回原圖版本 → 切回文字版本 → 刪版本。
 *
 * 伺服器測試釘的是狀態與資產，這一支釘的是**使用者真的按得到、看得見**：
 * - 沒有文字層時工具列會出現，而且只有「新增文字框」按得下去；
 * - 建立後畫布的背景是**原圖版本的資產**（別名，不是合成圖），字是 DOM 疊層；
 * - 框的落點與 `x/y/width/height` 換算成畫布比例一致（合成圖與 PPTX 都照同一份幾何走，
 *   畫布歪掉就是三端一起歪）；
 * - 切走再切回來，字還在；
 * - 刪掉手動版本後原圖版本仍載得出圖（別名沒被誤刪，這是最要緊的一條）。
 */

const RAIL = ".text-layer-rail";

/**
 * 刪除某個版本。刪除鈕平時 `opacity:0; pointer-events:none`，只在滑過那張卡片時浮出來
 * （避免誤刪），所以必須先 hover 卡片本身——直接點會被卡片按鈕接走。
 */
async function deleteVersion(page: Page, label: string): Promise<string> {
  const button = page.getByRole("button", { name: label });
  const item = page.locator(".version-item").filter({ has: button });
  await item.hover();
  let message = "";
  page.once("dialog", (dialog) => {
    message = dialog.message();
    void dialog.accept();
  });
  await button.click();
  return message;
}

/** 預覽某個版本後真正切過去（與 version-switch.spec.ts 同一套流程）。 */
async function switchToVersion(page: Page, nameRe: RegExp): Promise<void> {
  await page.getByRole("button", { name: nameRe }).first().click();
  const actions = page.locator(".version-preview-actions");
  await actions.waitFor();
  await actions.getByRole("button", { name: "切換至此版本" }).click();
  await expect(actions).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: new RegExp(nameRe.source + "（目前）") }),
  ).toBeVisible();
}

test("手動新增文字框：建立版本、打字自動儲存、版本切換、刪除後原圖還在", async ({
  page,
  request,
}) => {
  const seeded = await seedGeneratedProject(request, { topic: "手動文字層", slideCount: 1 });
  const originalVersion = seeded.slides[0]!.versions[0]!;
  await openEditor(page, seeded.id);

  // 這一版沒有文字層：工具列仍然出現，但只有「新增文字框」是可按的。
  const rail = page.locator(RAIL);
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("button", { name: "新增文字框" })).toBeEnabled();
  for (const name of ["刪除文字框", "復原", "重做"]) {
    await expect(rail.getByRole("button", { name })).toBeDisabled();
  }
  // 還沒有文字層，畫布是單純的 <img>。
  await expect(page.locator(".text-layer-canvas")).toHaveCount(0);

  // 按下去 → 伺服器建立「文字編輯」版本並切過去。
  await rail.getByRole("button", { name: "新增文字框" }).click();
  const canvas = page.locator(".text-layer-canvas");
  await canvas.waitFor();
  await expect(page.getByRole("button", { name: /版本 2：文字編輯（目前）/ })).toBeVisible();

  // 畫布背景必須是**原圖版本的資產**：別名指向它，不是新的合成圖。
  const background = canvas.locator("img").first();
  await expect(background).toHaveAttribute(
    "src",
    new RegExp(originalVersion.imagePath.split("/").pop()!.replace(/\./g, "\\.")),
  );

  // 一個框、預設文字、且**已被選中**（pendingTextSelect 沒被重新播種的 effect 清掉）。
  const box = page.locator(".editable-text-box");
  await expect(box).toHaveCount(1);
  await expect(box.locator("textarea")).toHaveValue("新增文字");
  await expect(box).toHaveClass(/selected/);

  // 幾何：預設框是 x=120 y=120 w=420 h=80 於 1920×1080 畫布，DOM 落點必須等比。
  const canvasBox = (await canvas.boundingBox())!;
  const domBox = (await box.boundingBox())!;
  const scale = canvasBox.width / 1920;
  expect(Math.abs(domBox.x - (canvasBox.x + 120 * scale))).toBeLessThan(2);
  expect(Math.abs(domBox.y - (canvasBox.y + 120 * scale))).toBeLessThan(2);
  expect(Math.abs(domBox.width - 420 * scale)).toBeLessThan(2);
  expect(Math.abs(domBox.height - 80 * scale)).toBeLessThan(2);

  // 打字 → 自動儲存（debounce 650ms，伺服器重繪 composite）。
  //
  // 刻意不斷言 `.text-layer-progress` 那行「正在重繪並自動儲存…」：mock provider 的一次重繪
  // 只要幾十毫秒，那個元素可能在 Playwright 下一次輪詢之前就消失了（實測 5 次跑出 1 次紅）。
  // 真正要驗的是「字有沒有存進伺服器」，就直接等伺服器狀態。
  await box.dblclick();
  const textarea = box.locator("textarea");
  await textarea.fill("手動打的字");
  await expect
    .poll(
      async () => {
        const polled = await getProject(request, seeded.id);
        const slide = polled.slides[0]!;
        return slide.versions.find((version) => version.id === slide.currentVersionId)?.textLayer
          ?.boxes[0]?.text;
      },
      { timeout: 15_000 },
    )
    .toBe("手動打的字");

  // 伺服器上真的存下來了，而且 composite 換了新檔（renderRevision 前進）。
  const afterSave = await getProject(request, seeded.id);
  const manualVersion = afterSave.slides[0]!.versions.find(
    (version) => version.id === afterSave.slides[0]!.currentVersionId,
  )!;
  expect(manualVersion.textLayer?.origin).toBe("manual");
  expect(manualVersion.textLayer?.boxes[0]?.text).toBe("手動打的字");
  expect(manualVersion.textLayer?.renderRevision).toBeGreaterThan(0);
  expect(manualVersion.textLayer?.backgroundPath).toBe(originalVersion.imagePath);

  // 切回原圖版本：畫布回到單純的 <img>，工具列仍在（可以再建一個手動層）。
  await switchToVersion(page, /版本 1(?!.*文字編輯)/);
  await expect(page.locator(".text-layer-canvas")).toHaveCount(0);
  await expect(page.locator(".canvas img")).toBeVisible();

  // 切回文字版本：剛打的字還在。
  await switchToVersion(page, /版本 2：文字編輯/);
  await expect(page.locator(".editable-text-box textarea")).toHaveValue("手動打的字");

  // 原圖版本被文字層引用著，刪不掉（伺服器守門的錯誤要送到畫面上）。
  await deleteVersion(page, "刪除版本 1");
  const toast = page.locator(".toast.error");
  await expect(toast).toContainText("有可編輯文字版本以這一版為原圖");
  await toast.click();

  // 切回原圖後刪掉手動版本：確認文字要講「手動加上的文字會一併刪除」。
  await switchToVersion(page, /版本 1(?!.*文字編輯)/);
  const confirmText = await deleteVersion(page, "刪除版本 2");
  await expect(page.getByRole("button", { name: /版本 2/ })).toHaveCount(0);
  expect(confirmText).toContain("手動加上的文字");

  // 別名安全：原圖資產還在（畫布仍載得出圖，且 HTTP 200）。
  const afterDelete = await getProject(request, seeded.id);
  expect(afterDelete.slides[0]!.versions).toHaveLength(1);
  const assetResponse = await request.get(
    `/api/projects/${seeded.id}/assets/${originalVersion.imagePath.replace(/^assets\//, "")}`,
  );
  expect(assetResponse.status()).toBe(200);
  await expect(page.locator(".canvas img")).toBeVisible();
});

/**
 * 文字工具列「有圖就佔位」。
 *
 * 工具列與畫布分食同一列，掛載／卸載會直接改變畫布的可用空間：改成常駐之前，1440×900 下
 * 畫布在 597px ↔ 649px 之間跳約 9%，而預覽歷史版本、生成中、剛建立文字層都會觸發，
 * 使用者眼中就是圖自己忽大忽小。這條只有真瀏覽器量得出來（jsdom 沒有版面）。
 *
 * 方向自適應之後，這支的 viewport（1440×900）實測**落在橫排**（工具列在畫布下方），
 * 所以工具列吃的是畫布的**高度**不是寬度——單看寬度會變成恆真的斷言。改成兩軸都比，
 * 並額外釘住「畫布底緣到工具列頂緣」的距離不變：工具列若在預覽期間卸載，畫布會長高、
 * 這段距離會跟著變，寬度卻可能一個 px 都沒動。
 */
test("預覽歷史版本時工具列照樣佔位：畫布幾何不變，按鈕全灰", async ({ page, request }) => {
  const seeded = await seedGeneratedProject(request, { topic: "工具列佔位", slideCount: 1 });
  const slideId = seeded.slides[0]!.id;
  // 第二版才有東西可以預覽（預覽的是「不是目前版本」的那一版）。
  await request.post(`/api/projects/${seeded.id}/slides/${slideId}/generate`, {
    data: { providerId: "mock-image", acceptUnknownReadiness: true },
  });
  await expect
    .poll(async () => (await getProject(request, seeded.id)).slides[0]!.versions.length, {
      timeout: 20_000,
    })
    .toBe(2);
  await openEditor(page, seeded.id);

  const canvas = page.locator(".canvas");
  const rail = page.locator(RAIL);
  await expect(rail).toBeVisible();
  /** 畫布尺寸，外加畫布與工具列之間的距離（橫排量垂直、側排量水平）。 */
  const geometry = async () => {
    const [canvasBox, railBox] = [(await canvas.boundingBox())!, (await rail.boundingBox())!];
    const stacked = railBox.y >= canvasBox.y + canvasBox.height;
    return {
      width: canvasBox.width,
      height: canvasBox.height,
      stacked,
      distance: stacked
        ? railBox.y - (canvasBox.y + canvasBox.height)
        : railBox.x - (canvasBox.x + canvasBox.width),
    };
  };
  const before = await geometry();

  // 進入歷史版本預覽：工具列必須還在原位，畫布一個 px 都不許動。
  await page
    .getByRole("button", { name: /^版本 1/ })
    .first()
    .click();
  await expect(page.locator(".version-preview-actions")).toBeVisible();
  await expect(rail).toBeVisible();
  const during = await geometry();
  expect(Math.abs(during.width - before.width)).toBeLessThan(0.5);
  expect(Math.abs(during.height - before.height)).toBeLessThan(0.5);
  // 方向與間距都不許變：工具列卸載時畫布會往它那一軸長出去，這一條抓的就是那件事。
  expect(during.stacked).toBe(before.stacked);
  expect(Math.abs(during.distance - before.distance)).toBeLessThan(0.5);
  // 語意不變：預覽中不能加字也不能改字，所以四顆全灰。
  for (const name of ["新增文字框", "刪除文字框", "復原", "重做"]) {
    await expect(rail.getByRole("button", { name })).toBeDisabled();
  }

  // 返回目前版本後又能加字了（不是靠「整條永遠灰掉」通過的）。
  await page
    .locator(".version-preview-actions")
    .getByRole("button", { name: "返回目前版本" })
    .click();
  await expect(page.locator(".version-preview-actions")).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "新增文字框" })).toBeEnabled();
  const after = await geometry();
  expect(Math.abs(after.width - before.width)).toBeLessThan(0.5);
  expect(Math.abs(after.height - before.height)).toBeLessThan(0.5);
  expect(Math.abs(after.distance - before.distance)).toBeLessThan(0.5);
});

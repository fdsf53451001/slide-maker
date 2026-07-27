import { expect, test, type Page } from "@playwright/test";
import { openEditor, seedGeneratedProject, type PresentationProject } from "../helpers.js";

/**
 * 文字工具列的自適應方向：畫布**寬度**受限時工具列改到畫布下方，**高度**受限時留在右側。
 *
 * 決策的算式由 `apps/editor/src/canvasRowLayout.test.ts` 逐條釘住，接線由 `Editor.test.tsx`
 * 釘住——但那兩層都在 jsdom，**沒有版面也沒有 CSS**：類別掛上去之後畫面到底有沒有換方向、
 * 畫布是不是真的因此變大，只有真瀏覽器量得出來。少了這一支，`.canvas-row-stacked` 的規則
 * 整條刪掉都還是全綠。
 *
 * 另外，其餘 e2e/ui 的 viewport（1920×1080、1440×900、1280×720、1100×720）實測**全部**
 * 落在橫排，所以側排（改動之前的唯一版面）在真瀏覽器裡已經沒有任何覆蓋——那正是這裡放一個
 * 高度受限 viewport 的原因。
 */

const ROW = ".canvas-row";
const RAIL = ".text-layer-rail";
const STACKED = "canvas-row-stacked";

/** 高度被瀏覽器 chrome 吃掉的最大化視窗：`.canvas-row` 實測 1280×715，比 16:9 更扁。 */
const HEIGHT_LIMITED = { width: 1920, height: 940 };
/** 全螢幕／無 chrome：`.canvas-row` 實測 1280×855，比 16:9 更方，畫布下方空著一大條。 */
const WIDTH_LIMITED = { width: 1920, height: 1080 };

interface Geometry {
  stacked: boolean;
  row: { width: number; height: number };
  rail: { x: number; y: number; width: number; height: number };
  canvas: { x: number; y: number; width: number; height: number };
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(
    ([rowSelector, railSelector, stackedClass]) => {
      const row = document.querySelector(rowSelector!) as HTMLElement;
      const rail = document.querySelector(railSelector!) as HTMLElement;
      const canvas = document.querySelector(".canvas") as HTMLElement;
      const box = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        stacked: row.classList.contains(stackedClass!),
        // 內容盒（扣掉捲軸），與 measureCanvasRowLayout 讀的是同一組。
        row: { width: row.clientWidth, height: row.clientHeight },
        rail: box(rail),
        canvas: box(canvas),
      };
    },
    [ROW, RAIL, STACKED] as const,
  );
}

/**
 * 目前這個視窗下，兩種佈局各自能給畫布多大。
 *
 * 兩次量測放在**同一個同步 evaluate** 裡：中間不讓 React 有機會 re-render 把類別加回去，
 * 也不讓 ResizeObserver 插進來（`.canvas-row` 的尺寸不變，本來就不會觸發，但同步做最保險）。
 * 這條驗的是「決策依據與畫面對得上」——canvasRowLayout.ts 是拿面積算的預測，CSS 才是渲染。
 */
async function areaUnderBothLayouts(
  page: Page,
): Promise<{ stacked: number; side: number; stackedIsBigger: boolean }> {
  return page.evaluate(
    ([rowSelector, stackedClass]) => {
      const row = document.querySelector(rowSelector!) as HTMLElement;
      const canvas = document.querySelector(".canvas") as HTMLElement;
      const area = () => {
        const rect = canvas.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const wasStacked = row.classList.contains(stackedClass!);
      row.classList.add(stackedClass!);
      const stacked = area();
      row.classList.remove(stackedClass!);
      const side = area();
      row.classList.toggle(stackedClass!, wasStacked);
      return { stacked, side, stackedIsBigger: stacked > side };
    },
    [ROW, STACKED] as const,
  );
}

test.describe("文字工具列方向自適應", () => {
  let project: PresentationProject;

  test.beforeAll(async ({ request }) => {
    project = await seedGeneratedProject(request, { topic: "工具列方向", slideCount: 1 });
  });

  test("高度受限的視窗：工具列留在畫布右側，直排", async ({ page }) => {
    await page.setViewportSize(HEIGHT_LIMITED);
    await openEditor(page, project.id);
    await page.locator(RAIL).waitFor();
    const geo = await geometry(page);

    expect(geo.stacked).toBe(false);
    // 工具列在畫布右邊、而且是直的（四顆按鈕疊起來比它自己寬得多）。
    expect(geo.rail.x).toBeGreaterThanOrEqual(geo.canvas.x + geo.canvas.width);
    expect(geo.rail.height).toBeGreaterThan(geo.rail.width);
    // 工具列佔的是水平方向：它整個落在畫布的右邊，一點高度都沒從畫布身上拿
    // （刻意不斷言「畫布把整列高度用滿」——1280×715 只比 16:9 扁一點點，扣掉側欄之後畫布
    //  仍然是寬度受限，垂直方向本來就會剩 24px）。
    expect(geo.rail.y).toBeLessThan(geo.canvas.y + geo.canvas.height);
    expect(geo.canvas.height).toBeLessThanOrEqual(geo.row.height + 1.5);
    // 而且側排在這個視窗下真的比較大：強制換成橫排畫布會縮小。
    expect(await areaUnderBothLayouts(page)).toMatchObject({ stackedIsBigger: false });
  });

  test("寬度受限的視窗：工具列改到畫布下方，橫排，畫布拿回整列的寬度", async ({ page }) => {
    await page.setViewportSize(WIDTH_LIMITED);
    await openEditor(page, project.id);
    await page.locator(RAIL).waitFor();
    const geo = await geometry(page);

    expect(geo.stacked).toBe(true);
    // 工具列在畫布下方、而且是橫的。
    expect(geo.rail.y).toBeGreaterThanOrEqual(geo.canvas.y + geo.canvas.height);
    expect(geo.rail.width).toBeGreaterThan(geo.rail.height);
    // 這才是整個改動的目的：工具列不再從畫布寬度身上拿，畫布吃滿整列。
    expect(Math.abs(geo.canvas.width - geo.row.width)).toBeLessThanOrEqual(1.5);
  });

  test("選的真的是比較大的那一種：同一個視窗下橫排的畫布大於側排", async ({ page }) => {
    await page.setViewportSize(WIDTH_LIMITED);
    await openEditor(page, project.id);
    await page.locator(RAIL).waitFor();
    expect(await areaUnderBothLayouts(page)).toMatchObject({ stackedIsBigger: true });
  });

  test("反覆改視窗大小不會來回抖動，也不會噴 ResizeObserver 迴圈錯誤", async ({ page }) => {
    // 工具列換方向會改變它自己的兩軸；只要有一處把決策的產物餵回輸入，真瀏覽器就會每次
    // resize 都翻一次，並在 console 留下 "ResizeObserver loop completed with undelivered
    // notifications"。jsdom 沒有 ResizeObserver，這條只有這裡驗得到。
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.setViewportSize(WIDTH_LIMITED);
    await openEditor(page, project.id);
    await page.locator(RAIL).waitFor();

    const seen: boolean[] = [];
    for (let round = 0; round < 3; round += 1) {
      await page.setViewportSize(WIDTH_LIMITED);
      await expect(page.locator(ROW)).toHaveClass(new RegExp(STACKED));
      seen.push((await geometry(page)).stacked);
      await page.setViewportSize(HEIGHT_LIMITED);
      await expect(page.locator(ROW)).not.toHaveClass(new RegExp(STACKED));
      seen.push((await geometry(page)).stacked);
    }
    // 同一個尺寸每一輪都得到同一個答案（不是「最後一次剛好對」）。
    expect(seen).toEqual([true, false, true, false, true, false]);
    expect(errors.filter((message) => /ResizeObserver/i.test(message))).toEqual([]);
  });
});

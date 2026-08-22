import { describe, expect, it } from "vitest";
import type { RawOcrResult } from "../src/ocr.js";
import { boxesFromOcr } from "../src/text-layers.js";
import { refineOcrBoxes } from "../src/ocr-refine.js";

/**
 * 直書（縱向排列的 CJK 文字）。
 *
 * 實機根因（2026-08-22）：PaddleOCR 的**偵測**對直書給出正確的窄高框，但既有的
 * `boxesFromOcr` 只有橫排一種假設，字級反推（`solveBoxGeometry`）拿「寬度算出的
 * 字級」與「高度算出的字級」互相印證，兩者對直書必然對不上（寬只夠一個字、高卻是
 * 四個字疊起來），程式碼唯一認得的原因是「高度證據被污染」，於是丟掉高度、依寬度
 * 把四個字硬塞成一行小字橫排。
 *
 * 修法：PaddleOCR `return_word_box=True` 會依同一個「框高 ÷ 框寬 > 1.5」門檻自己判斷
 * 直書，並算出逐字的真實框位置——這批資料原本就在，只是我們的腳本沒有請求它。
 * `isVerticalRun()`／`buildVerticalBox()` 直接拿這些位置組框（一個框、字元間 `\n`
 * 分行），不透過只懂橫排的字墨量測。
 *
 * 座標取自實測資料（`.slide-maker-data` 專案 d56f8f92 的「活動核心」框）：
 * 偵測框 59×201，四字逐字框 (63,459)-(122,509)／(63,509)-(122,558)／
 * (63,558)-(122,607)／(63,597)-(122,646)，canvas 與偵測影像同尺寸（1920×1080，
 * scaleX=scaleY=1）。
 */

const CANVAS = { width: 1920, height: 1080 };

function verticalRaw(): RawOcrResult {
  return {
    width: 1920,
    height: 1080,
    boxes: [
      {
        text: "活動核心",
        confidence: 0.9998987913131714,
        // 偵測框（未縮放，與 canvas 同尺寸系）：寬 59、高 201，比例 3.4 > 1.5。
        polygon: [
          [63, 450],
          [122, 450],
          [122, 651],
          [63, 651],
        ],
        words: [
          { text: "活", box: [63, 459, 122, 509] },
          { text: "動", box: [63, 509, 122, 558] },
          { text: "核", box: [63, 558, 122, 607] },
          { text: "心", box: [63, 597, 122, 646] },
        ],
      },
    ],
  };
}

/** 橫排對照組：同樣有 words 資料，但長寬比例不成立（矮胖）。 */
function horizontalRawWithWords(): RawOcrResult {
  return {
    width: 1920,
    height: 1080,
    boxes: [
      {
        text: "活動核心",
        confidence: 0.99,
        polygon: [
          [100, 100],
          [300, 100],
          [300, 150],
          [100, 150],
        ],
        words: [
          { text: "活", box: [100, 100, 150, 150] },
          { text: "動", box: [150, 100, 200, 150] },
          { text: "核", box: [200, 100, 250, 150] },
          { text: "心", box: [250, 100, 300, 150] },
        ],
      },
    ],
  };
}

describe("boxesFromOcr：直書偵測", () => {
  it("窄高框＋逐字資料時，組成一個字元間以 \\n 分行的框，不是硬塞成一行橫排", () => {
    const [box] = boxesFromOcr(verticalRaw(), CANVAS, 0.75);
    expect(box!.text).toBe("活\n動\n核\n心");
  });

  it("幾何直接取自逐字框的真實位置，不經過字墨量測反推", () => {
    const [box] = boxesFromOcr(verticalRaw(), CANVAS, 0.75);
    // x/y 取逐字框的左上界，width/height 取涵蓋全部逐字框的範圍——
    // 不是偵測框本身的 59×201（那是 unclip 外擴後的粗略範圍）。
    expect(box!.x).toBe(63);
    expect(box!.y).toBe(459);
    expect(box!.width).toBe(59);
    expect(box!.height).toBeCloseTo(646 - 459, 5);
  });

  it("字級與行高換算成每行步進高度剛好等於平均逐字框高（落點貼齊原圖）", () => {
    const [box] = boxesFromOcr(verticalRaw(), CANVAS, 0.75);
    const avgCharHeight = (646 - 459) / 4;
    expect(box!.fontSize * box!.lineHeight).toBeCloseTo(avgCharHeight, 5);
    // fontSize 本身仍照既有換算基準（× 0.78），不是另立一套。
    expect(box!.fontSize).toBeCloseTo(avgCharHeight * 0.78, 5);
  });

  it("直書框水平置中，而不是沿用橫排的靠左預設", () => {
    const [box] = boxesFromOcr(verticalRaw(), CANVAS, 0.75);
    expect(box!.align).toBe("center");
  });

  it("含 \\n 的框會讓 refineOcrBoxes 整段跳過字墨量測，幾何原樣落地", async () => {
    const boxes = boxesFromOcr(verticalRaw(), CANVAS, 0.75);
    const refined = await refineOcrBoxes(boxes, { textRepair: "off" });
    expect(refined.boxes[0]!.x).toBe(boxes[0]!.x);
    expect(refined.boxes[0]!.width).toBe(boxes[0]!.width);
    expect(refined.boxes[0]!.text).toBe("活\n動\n核\n心");
  });

  it("同樣的 words 資料但長寬比例不像直書時，完全忽略逐字框、走既有橫排邏輯", () => {
    const [box] = boxesFromOcr(horizontalRawWithWords(), CANVAS, 0.75);
    expect(box!.text).toBe("活動核心");
    expect(box!.text).not.toContain("\n");
    expect(box!.align).toBe("left");
  });

  it("沒有 words 資料時，就算窄高也走既有橫排邏輯（不會無中生有猜逐字位置）", () => {
    const raw: RawOcrResult = {
      width: 1920,
      height: 1080,
      boxes: [
        {
          text: "活動核心",
          confidence: 0.99,
          polygon: [
            [63, 450],
            [122, 450],
            [122, 651],
            [63, 651],
          ],
        },
      ],
    };
    const [box] = boxesFromOcr(raw, CANVAS, 0.75);
    expect(box!.text).toBe("活動核心");
    expect(box!.text).not.toContain("\n");
  });

  it("只有一個字時不判定為直書（words 至少要 2 個才有意義）", () => {
    const raw: RawOcrResult = {
      width: 1920,
      height: 1080,
      boxes: [
        {
          text: "心",
          confidence: 0.99,
          polygon: [
            [63, 450],
            [122, 450],
            [122, 520],
            [63, 520],
          ],
        },
      ],
    };
    const [box] = boxesFromOcr(raw, CANVAS, 0.75);
    expect(box!.text).toBe("心");
  });
});

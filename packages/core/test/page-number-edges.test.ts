import { describe, expect, it } from "vitest";
import {
  pageNumberLabel,
  pageNumberLayout,
  pageNumberSettingsSchema,
  pageNumberTotal,
  pageNumberValue,
  type PageNumberSettings,
} from "../src/index.js";

const CANVAS = { width: 1920, height: 1080 };

type SettingsInput = Partial<Omit<PageNumberSettings, "background">> & {
  background?: Partial<PageNumberSettings["background"]>;
};

function settings(overrides: SettingsInput = {}): PageNumberSettings {
  return pageNumberSettingsSchema.parse({ enabled: true, ...overrides });
}

/** 整份簡報逐頁跑一次，模擬匯出端與預覽端的實際呼叫方式。 */
function deckLabels(config: PageNumberSettings, slideCount: number): (string | undefined)[] {
  return Array.from({ length: slideCount }, (_, index) =>
    pageNumberLabel(config, index, slideCount),
  );
}

describe("頁碼編號的邊界情形", () => {
  it("只有一頁且跳過封面時，整份簡報一個頁碼都沒有", () => {
    // 這是「頁碼會不會在單頁簡報上算出 0 或負數」的守門：正確答案是一個都不畫。
    const single = settings({ skipFirstSlide: true });
    expect(deckLabels(single, 1)).toEqual([undefined]);
    expect(
      deckLabels(pageNumberSettingsSchema.parse({ enabled: true, format: "number-total" }), 1),
    ).toEqual([undefined]);
  });

  it("只有一頁且不跳封面時是 1 / 1，不是 1 / 0", () => {
    const single = settings({ skipFirstSlide: false, format: "number-total" });
    expect(deckLabels(single, 1)).toEqual(["1 / 1"]);
  });

  it("兩頁且跳過封面時，唯一有頁碼的那頁是 1 / 1", () => {
    // 分母若誤用投影片張數就會變成 "1 / 2"，畫面上卻永遠不存在第 2 頁。
    expect(deckLabels(settings({ format: "number-total" }), 2)).toEqual([undefined, "1 / 1"]);
  });

  it("最後一頁的分子必然等於分母（number-total 的核心不變式）", () => {
    for (const skipFirstSlide of [true, false])
      for (const startAt of [1, 2, 7, 999])
        for (const slideCount of [1, 2, 3, 12, 150]) {
          const config = settings({ skipFirstSlide, startAt, format: "number-total" });
          const last = pageNumberLabel(config, slideCount - 1, slideCount);
          if (last === undefined) {
            // 唯一能沒有標籤的最後一頁，就是「只有封面而封面不編號」。
            expect(slideCount).toBe(1);
            expect(skipFirstSlide).toBe(true);
            continue;
          }
          const [numerator, denominator] = last.split(" / ");
          expect(numerator).toBe(denominator);
        }
  });

  it("有頁碼的頁面編號連續遞增、不跳號也不重複", () => {
    for (const skipFirstSlide of [true, false])
      for (const startAt of [1, 5]) {
        const config = settings({ skipFirstSlide, startAt });
        const values = Array.from({ length: 8 }, (_, index) =>
          pageNumberValue(config, index),
        ).filter((value): value is number => value !== undefined);
        expect(values).toEqual(
          Array.from({ length: skipFirstSlide ? 7 : 8 }, (_, offset) => startAt + offset),
        );
      }
  });

  it("startAt 大於 1 時三種格式一致地平移，且封面規則不受影響", () => {
    const shifted: SettingsInput = { startAt: 42, skipFirstSlide: true };
    expect(pageNumberLabel(settings({ ...shifted, format: "number" }), 0, 5)).toBeUndefined();
    expect(pageNumberLabel(settings({ ...shifted, format: "number" }), 1, 5)).toBe("42");
    expect(pageNumberLabel(settings({ ...shifted, format: "number-total" }), 1, 5)).toBe("42 / 45");
    expect(pageNumberLabel(settings({ ...shifted, format: "zh-page" }), 1, 5)).toBe("第 42 頁");
  });

  it("關閉時三種格式、任何位置、任何頁次都沒有標籤", () => {
    for (const format of ["number", "number-total", "zh-page"] as const) {
      const off = pageNumberSettingsSchema.parse({ enabled: false, format, startAt: 9 });
      expect(deckLabels(off, 4)).toEqual([undefined, undefined, undefined, undefined]);
      expect(pageNumberValue(off, 0)).toBeUndefined();
    }
  });

  it("total 永遠不低於 startAt，即使張數少於起算點", () => {
    expect(pageNumberTotal(settings({ startAt: 20 }), 1)).toBe(20);
    expect(pageNumberTotal(settings({ startAt: 20, skipFirstSlide: false }), 0)).toBe(20);
  });

  it("`enabled` 只由 label/value 守門，layout 本身不看它", () => {
    // 三個渲染端都必須先問過 pageNumberLabel 再畫；直接呼叫 layout 是拿得到幾何的。
    // 這條把該契約寫死，避免有人「順手」把 enabled 判斷搬進 layout 而讓某一端漏了守門。
    const off = pageNumberSettingsSchema.parse({ enabled: false });
    expect(pageNumberLayout(off, CANVAS, "7").text.text).toBe("7");
    expect(pageNumberLabel(off, 1, 4)).toBeUndefined();
  });
});

describe("頁碼版面隨畫布尺寸等比縮放", () => {
  it("邊距是畫布尺寸的固定比例，不是寫死的 px", () => {
    const big = pageNumberLayout(settings(), { width: 3840, height: 2160 }, "7").text;
    expect(big.x).toBe(Math.round(3840 * 0.033));
    expect(big.width).toBe(3840 - Math.round(3840 * 0.033) * 2);
    expect(big.y).toBe(2160 - Math.round(2160 * 0.037) - Math.round(30 * 1.2));
  });

  it("文字框永遠落在畫布內", () => {
    for (const canvas of [CANVAS, { width: 3840, height: 2160 }, { width: 1280, height: 720 }])
      for (const fontSize of [12, 30, 120]) {
        const { text } = pageNumberLayout(settings({ fontSize }), canvas, "第 12 頁");
        expect(text.x).toBeGreaterThanOrEqual(0);
        expect(text.y).toBeGreaterThanOrEqual(0);
        expect(text.x + text.width).toBeLessThanOrEqual(canvas.width);
        expect(text.y + text.height).toBeLessThanOrEqual(canvas.height);
      }
  });
});

describe("頁碼設定 schema 的守門", () => {
  it("拒絕越界與非法的數值", () => {
    const rejected = [
      { startAt: 0 },
      { startAt: 1000 },
      { startAt: 1.5 },
      { fontSize: 11 },
      { fontSize: 121 },
      { opacity: 0 },
      { opacity: 1.01 },
      { color: "#fff" },
      { color: "#GGGGGG" },
      { color: "white" },
      { position: "top-right" },
      { format: "roman" },
      { background: { color: "blue" } },
      { background: { opacity: 0 } },
      { background: { opacity: 2 } },
    ];
    for (const patch of rejected)
      expect(() => pageNumberSettingsSchema.parse(patch), JSON.stringify(patch)).toThrow();
  });

  it("接受邊界上的合法值", () => {
    expect(
      pageNumberSettingsSchema.parse({ startAt: 1, fontSize: 12, opacity: 0.05 }).opacity,
    ).toBe(0.05);
    expect(
      pageNumberSettingsSchema.parse({ startAt: 999, fontSize: 120, opacity: 1 }).startAt,
    ).toBe(999);
    expect(pageNumberSettingsSchema.parse({ color: "#AbCdEf" }).color).toBe("#AbCdEf");
  });

  it("巢狀 background 只給一個欄位時，其餘欄位補預設而非變成 undefined", () => {
    expect(pageNumberSettingsSchema.parse({ background: { enabled: true } }).background).toEqual({
      enabled: true,
      color: "#000000",
      opacity: 0.35,
    });
  });

  it("預設是關閉的：加入頁碼功能不會改變既有專案的輸出", () => {
    expect(pageNumberSettingsSchema.parse({})).toEqual({
      enabled: false,
      position: "bottom-right",
      format: "number",
      startAt: 1,
      skipFirstSlide: true,
      fontSize: 30,
      color: "#ffffff",
      opacity: 0.8,
      background: { enabled: false, color: "#000000", opacity: 0.35 },
    });
  });
});

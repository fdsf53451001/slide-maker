import { describe, expect, it } from "vitest";
import {
  pageNumberSettingsSchema,
  pageNumberSlideLabel,
  slideSpecSchema,
  type PageNumberSettings,
} from "../src/index.js";

type SettingsInput = Partial<Omit<PageNumberSettings, "background">> & {
  background?: Partial<PageNumberSettings["background"]>;
};

function settings(overrides: SettingsInput = {}): PageNumberSettings {
  return pageNumberSettingsSchema.parse({ enabled: true, ...overrides });
}

/** `hiddenOrders` 之外的頁都是可見頁；只帶 order 與 hidden，正是四個渲染端會餵進來的形狀。 */
function slides(count: number, hiddenOrders: number[] = []) {
  return Array.from({ length: count }, (_, order) => ({
    order,
    hidden: hiddenOrders.includes(order),
  }));
}

/** 整份簡報的標籤，`undefined` 用 `null` 表示，比對起來一眼看得出哪一頁沒有頁碼。 */
function labels(config: PageNumberSettings, deck: ReturnType<typeof slides>) {
  return deck.map((slide) => pageNumberSlideLabel(config, deck, slide.order) ?? null);
}

describe("頁碼只認可見頁", () => {
  it("沒有隱藏頁時與既有的 index-based 編號完全相同", () => {
    expect(labels(settings({ skipFirstSlide: false }), slides(4))).toEqual(["1", "2", "3", "4"]);
    expect(labels(settings({ skipFirstSlide: true }), slides(4))).toEqual([null, "1", "2", "3"]);
  });

  it("共 5 頁、第 3 頁隱藏：其餘四頁依序 1、2、3、4，隱藏頁沒有頁碼", () => {
    expect(labels(settings({ skipFirstSlide: false }), slides(5, [2]))).toEqual([
      "1",
      "2",
      null,
      "3",
      "4",
    ]);
  });

  it("`n / N` 的 N 也只算可見頁", () => {
    const config = settings({ format: "number-total", skipFirstSlide: false });
    expect(labels(config, slides(5, [2]))).toEqual(["1 / 4", "2 / 4", null, "3 / 4", "4 / 4"]);
  });

  it("skipFirstSlide 跳過的是第一張**可見**頁：封面被隱藏時下一頁接手當封面", () => {
    expect(labels(settings({ skipFirstSlide: true }), slides(4, [0]))).toEqual([
      null,
      null,
      "1",
      "2",
    ]);
  });

  it("startAt 與 zh-page 一樣只作用在可見序上", () => {
    const config = settings({ format: "zh-page", startAt: 10, skipFirstSlide: false });
    expect(labels(config, slides(4, [1]))).toEqual(["第 10 頁", null, "第 11 頁", "第 12 頁"]);
  });

  it("關閉頁碼時連可見頁都沒有標籤", () => {
    expect(labels(pageNumberSettingsSchema.parse({}), slides(3, [1]))).toEqual([null, null, null]);
  });

  it("全部隱藏時每一頁都是 undefined，而不是丟例外", () => {
    expect(labels(settings({ skipFirstSlide: false }), slides(3, [0, 1, 2]))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("陣列順序被打亂時仍以 order 決定可見序", () => {
    const deck = slides(4, [1]);
    const shuffled = [deck[3]!, deck[0]!, deck[2]!, deck[1]!];
    const config = settings({ skipFirstSlide: false });
    expect(shuffled.map((slide) => pageNumberSlideLabel(config, shuffled, slide.order))).toEqual([
      "3",
      "1",
      "2",
      undefined,
    ]);
  });

  it("不動到呼叫端的陣列（內部排序只作用在複本上）", () => {
    const deck = slides(3, [1]);
    const snapshot = [...deck];
    pageNumberSlideLabel(settings(), deck, 2);
    expect(deck).toEqual(snapshot);
  });

  it("order 不在清單裡（頁面已被刪除）回 undefined 而不是丟例外", () => {
    expect(pageNumberSlideLabel(settings(), slides(3), 9)).toBeUndefined();
  });

  it("直接餵 slideSpecSchema 解析出來的頁面：舊專案檔沒有 hidden 就等同全部可見", () => {
    const deck = [0, 1, 2].map((order) =>
      slideSpecSchema.parse({ id: `slide-${order}`, order, purpose: "" }),
    );
    expect(deck.every((slide) => slide.hidden === false)).toBe(true);
    const config = settings({ skipFirstSlide: false });
    expect(deck.map((slide) => pageNumberSlideLabel(config, deck, slide.order))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});

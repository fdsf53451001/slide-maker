import { describe, expect, it } from "vitest";
import {
  approximateTextWidth,
  createProject,
  pageNumberLabel,
  pageNumberLayout,
  pageNumberSettingsSchema,
  pageNumberTotal,
  pageNumberValue,
  parseProject,
  type PageNumberSettings,
} from "../src/index.js";

const CANVAS = { width: 1920, height: 1080 };

type SettingsInput = Partial<Omit<PageNumberSettings, "background">> & {
  background?: Partial<PageNumberSettings["background"]>;
};

function settings(overrides: SettingsInput = {}): PageNumberSettings {
  return pageNumberSettingsSchema.parse({ enabled: true, ...overrides });
}

describe("頁碼編號", () => {
  it("關閉時任何一頁都沒有頁碼", () => {
    const off = pageNumberSettingsSchema.parse({});
    expect(off.enabled).toBe(false);
    expect(pageNumberValue(off, 3)).toBeUndefined();
    expect(pageNumberLabel(off, 3, 10)).toBeUndefined();
  });

  it("跳過封面時第一頁無頁碼，第二頁才是 startAt", () => {
    const skip = settings({ skipFirstSlide: true, startAt: 1 });
    expect(pageNumberValue(skip, 0)).toBeUndefined();
    expect(pageNumberValue(skip, 1)).toBe(1);
    expect(pageNumberValue(skip, 5)).toBe(5);
  });

  it("不跳過封面時第一頁就是 startAt", () => {
    const all = settings({ skipFirstSlide: false, startAt: 1 });
    expect(pageNumberValue(all, 0)).toBe(1);
    expect(pageNumberValue(all, 5)).toBe(6);
  });

  it("startAt 平移整份簡報的編號", () => {
    const shifted = settings({ skipFirstSlide: true, startAt: 10 });
    expect(pageNumberValue(shifted, 1)).toBe(10);
    expect(pageNumberValue(shifted, 4)).toBe(13);
  });

  it("total 是最後一頁顯示的數字，不是投影片張數", () => {
    // 12 頁、跳封面 → 最後一頁顯示 11，"3 / 12" 會與畫面上的數字對不起來。
    expect(pageNumberTotal(settings({ skipFirstSlide: true }), 12)).toBe(11);
    expect(pageNumberTotal(settings({ skipFirstSlide: false }), 12)).toBe(12);
    expect(pageNumberTotal(settings({ skipFirstSlide: true, startAt: 5 }), 12)).toBe(15);
    // 只有封面一頁時沒有任何頁碼，total 也不該掉到 startAt 以下。
    expect(pageNumberTotal(settings({ skipFirstSlide: true }), 1)).toBe(1);
    expect(pageNumberTotal(settings({ skipFirstSlide: true, startAt: 3 }), 0)).toBe(3);
  });

  it("三種格式", () => {
    expect(pageNumberLabel(settings({ format: "number" }), 3, 12)).toBe("3");
    expect(pageNumberLabel(settings({ format: "number-total" }), 3, 12)).toBe("3 / 11");
    expect(pageNumberLabel(settings({ format: "zh-page" }), 3, 12)).toBe("第 3 頁");
  });
});

describe("頁碼版面", () => {
  it("文字框走全寬對齊，落點只取決於邊距", () => {
    const { text } = pageNumberLayout(settings(), CANVAS, "7");
    expect(text.x).toBe(63);
    expect(text.width).toBe(1920 - 63 * 2);
    expect(text.height).toBe(36);
    expect(text.y).toBe(1080 - 40 - 36);
    expect(text.verticalAlign).toBe("middle");
    expect(text.id).toBe("page-number");
    expect(text.role).toBe("presentation");
  });

  it("三種位置只差在對齊方式，框本身不動", () => {
    const boxes = (["bottom-left", "bottom-center", "bottom-right"] as const).map(
      (position) => pageNumberLayout(settings({ position }), CANVAS, "7").text,
    );
    expect(boxes.map((box) => box.align)).toEqual(["left", "center", "right"]);
    for (const box of boxes) {
      expect(box.x).toBe(boxes[0]!.x);
      expect(box.width).toBe(boxes[0]!.width);
      expect(box.y).toBe(boxes[0]!.y);
    }
  });

  it("字級與顏色透過設定傳到文字框", () => {
    const { text } = pageNumberLayout(
      settings({ fontSize: 48, color: "#AABBCC", opacity: 0.5 }),
      CANVAS,
      "7",
    );
    expect(text.fontSize).toBe(48);
    expect(text.color).toBe("#AABBCC");
    expect(text.opacity).toBe(0.5);
    expect(text.height).toBe(Math.round(48 * 1.2));
  });

  it("背景關閉時沒有色塊", () => {
    expect(pageNumberLayout(settings(), CANVAS, "7").chip).toBeUndefined();
    expect("chip" in pageNumberLayout(settings(), CANVAS, "7")).toBe(false);
  });

  it("色塊墊在文字框中線上，並依位置貼齊左右邊距", () => {
    const chipSettings = settings({ background: { enabled: true } });
    const height = Math.round(chipSettings.fontSize * 1.2);
    const padY = chipSettings.fontSize * 0.32;
    const padX = chipSettings.fontSize * 0.55;
    const marginX = Math.round(CANVAS.width * 0.033);

    const left = pageNumberLayout({ ...chipSettings, position: "bottom-left" }, CANVAS, "7").chip!;
    const centre = pageNumberLayout(
      { ...chipSettings, position: "bottom-center" },
      CANVAS,
      "7",
    ).chip!;
    const right = pageNumberLayout(
      { ...chipSettings, position: "bottom-right" },
      CANVAS,
      "7",
    ).chip!;

    expect(left.height).toBeCloseTo(height + padY * 2, 6);
    expect(left.radius).toBeCloseTo(left.height / 2, 6);
    expect(left.width).toBeCloseTo(approximateTextWidth("7", chipSettings.fontSize) + padX * 2, 6);
    // 中線對齊文字框中線。
    const textBox = pageNumberLayout(chipSettings, CANVAS, "7").text;
    expect(left.y + left.height / 2).toBeCloseTo(textBox.y + textBox.height / 2, 6);

    expect(left.x).toBeCloseTo(marginX - padX, 6);
    expect(centre.x + centre.width / 2).toBeCloseTo(CANVAS.width / 2, 6);
    expect(right.x + right.width).toBeCloseTo(CANVAS.width - marginX + padX, 6);
    // padX 也是共用幾何的一部分：PPTX 拿色塊當文字框，得靠它把文字起點推回同一條邊距。
    for (const chip of [left, centre, right]) expect(chip.padX).toBeCloseTo(padX, 6);
  });

  it("色塊左右兩緣都被夾住，不會有負的 x 或掉出右緣", () => {
    // padX 大於 marginX 的極端字級。左右必須對稱處理：只夾左緣的話，右對齊會算出
    // 超出畫布的 x（色塊有一截畫在畫布外）。
    const narrow = { width: 320, height: 180 };
    const extreme = (position: PageNumberSettings["position"], label: string) =>
      pageNumberLayout(
        settings({ position, fontSize: 120, background: { enabled: true } }),
        narrow,
        label,
      ).chip!;

    const left = extreme("bottom-left", "7");
    expect(left.x).toBe(0);

    const right = extreme("bottom-right", "7");
    expect(right.x).toBeGreaterThanOrEqual(0);
    expect(right.x + right.width).toBeLessThanOrEqual(narrow.width);

    // 色塊比畫布還寬時兩種對齊都退化成貼齊左緣，而不是一個 0、一個負值。
    for (const position of ["bottom-left", "bottom-right"] as const) {
      const chip = extreme(position, "第 12 頁");
      expect(chip.width, position).toBeGreaterThan(narrow.width);
      expect(chip.x, position).toBe(0);
    }
  });

  it("近似量測讓全形字比半形寬", () => {
    expect(approximateTextWidth("第 3 頁", 30)).toBeCloseTo((1 + 0.3 + 0.6 + 0.3 + 1) * 30, 6);
    expect(approximateTextWidth("12", 30)).toBeCloseTo(0.6 * 2 * 30, 6);
  });

  it("全形空白算 1em，不被當成半形空白", () => {
    // `/\s/` 會把 U+3000 一起吃掉，色塊因此比實際文字窄掉 0.7em。
    expect(approximateTextWidth("　", 30)).toBeCloseTo(30, 6);
    expect(approximateTextWidth(" ", 30)).toBeCloseTo(9, 6);
    expect(approximateTextWidth("\t", 30)).toBeCloseTo(9, 6);
  });
});

describe("專案上的頁碼設定", () => {
  it("新專案預設關閉，舊專案檔載入後自動補齊", () => {
    const project = createProject({ topic: "頁碼" });
    expect(project.pageNumber.enabled).toBe(false);
    expect(project.pageNumber.background.enabled).toBe(false);
    const legacy = structuredClone(project) as Record<string, unknown>;
    delete legacy.pageNumber;
    expect(parseProject(legacy).pageNumber).toEqual(project.pageNumber);
  });
});

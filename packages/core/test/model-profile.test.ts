import { describe, expect, it } from "vitest";
import {
  aspectRatioLabel,
  resolveImageProfile,
  utf8ByteLength,
  type ResolvedImageProfile,
} from "../src/model-profile.js";

/**
 * `resolveImageProfile()` 是 profile 覆寫的唯一入口：`ModelRuntime#buildImage` 與兩個
 * provider 建構子都只呼叫它一次，之後只讀 resolve 之後的物件。這裡直接測純函式的三個
 * 欄位是否**各自獨立覆寫**——這件事在 transport 層的測試裡容易被蓋過去，因為那些測試
 * 通常一次把 `sizing` 也設好，測不出「只設一個欄位、其他欄位要不要沿用 base」這個問題。
 */
describe("resolveImageProfile", () => {
  const base: ResolvedImageProfile = {
    sizing: { mode: "size", value: "1536x1024" },
    maxReferenceImages: 16,
  };

  it("沒有 override 時原樣回傳 base", () => {
    expect(resolveImageProfile(base)).toEqual(base);
  });

  it("only overriding promptMaxBytes 保留 base 的 sizing 與 maxReferenceImages", () => {
    const resolved = resolveImageProfile(base, { promptMaxBytes: 5000 });
    expect(resolved.sizing).toEqual(base.sizing);
    expect(resolved.maxReferenceImages).toBe(16);
    expect(resolved.promptMaxBytes).toBe(5000);
  });

  it("only overriding maxReferenceImages 保留 base 的 sizing，且不帶出 promptMaxBytes", () => {
    const resolved = resolveImageProfile(base, { maxReferenceImages: 4 });
    expect(resolved.sizing).toEqual(base.sizing);
    expect(resolved.maxReferenceImages).toBe(4);
    expect(resolved.promptMaxBytes).toBeUndefined();
  });

  it("only overriding sizing 保留 base 的 maxReferenceImages", () => {
    const resolved = resolveImageProfile(base, {
      sizing: { mode: "image_size", resolution: "4k" },
    });
    expect(resolved.sizing).toEqual({ mode: "image_size", resolution: "4k" });
    expect(resolved.maxReferenceImages).toBe(16);
  });

  it("override 全部欄位時三者都換成 override 的值", () => {
    const resolved = resolveImageProfile(base, {
      sizing: { mode: "none" },
      maxReferenceImages: 2,
      promptMaxBytes: 100,
    });
    expect(resolved).toEqual({
      sizing: { mode: "none" },
      maxReferenceImages: 2,
      promptMaxBytes: 100,
    });
  });

  it("base 本來就沒有 maxReferenceImages／promptMaxBytes 時，不覆寫就不會平白長出這兩個欄位", () => {
    const bareBase: ResolvedImageProfile = { sizing: { mode: "none" } };
    const resolved = resolveImageProfile(bareBase, { promptMaxBytes: 10 });
    expect(resolved).toEqual({ sizing: { mode: "none" }, promptMaxBytes: 10 });
    expect("maxReferenceImages" in resolved).toBe(false);
  });
});

describe("aspectRatioLabel", () => {
  it("1920x1080（16:9）回傳 16:9", () => {
    expect(aspectRatioLabel(1920, 1080)).toBe("16:9");
  });

  it("容差內的近似 16:9 仍算 16:9", () => {
    // 1920/1079 ≈ 1.77943，與 16/9 ≈ 1.77778 相差約 0.00165 < 0.02 的容差。
    expect(aspectRatioLabel(1920, 1079)).toBe("16:9");
  });

  it("非 16:9 的比例回傳 undefined，而不是硬塞一個錯的字串", () => {
    expect(aspectRatioLabel(1080, 1920)).toBeUndefined(); // 9:16
    expect(aspectRatioLabel(1024, 1024)).toBeUndefined(); // 1:1
  });

  it("height 為 0 或負數時回傳 undefined，不除以零", () => {
    expect(aspectRatioLabel(1920, 0)).toBeUndefined();
    expect(aspectRatioLabel(1920, -1)).toBeUndefined();
  });
});

describe("utf8ByteLength", () => {
  it("ASCII 字元一字一 byte", () => {
    expect(utf8ByteLength("abc")).toBe(3);
  });

  it("中文字元在 UTF-8 是 3 bytes，而 String.length 只算 1 個 UTF-16 碼元——兩者不能混用", () => {
    expect("中".length).toBe(1);
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("中文測試")).toBe(12);
  });
});

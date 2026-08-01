import { describe, expect, it } from "vitest";
import type { SlideVersion } from "@slide-maker/core";
import {
  adoptVersion,
  referencedVersionAssets,
  staleVersionAssets,
  versionAssetPaths,
} from "../src/version-assets.js";

/**
 * 版本資產回收的共用規則。
 *
 * 這些函式原本是三個端點（版本刪除、job 落地交易、text-layer 重繪）各抄一份的迴圈，抄本
 * 之間只差變數名。收斂後最需要被釘住的是**兩條前提**——它們不會在型別上顯現，抄錯也不會
 * 有任何端點測試變紅，只會在使用者的磁碟上把還在用的圖刪掉：
 *
 * 1. 手動文字層的 `backgroundPath` 是原圖版本 `imagePath` 的**別名**（同一個檔案），
 *    它不被誤刪靠的是重算引用時原圖版本自己還在，沒有任何顯式保護。
 * 2. 引用集合必須在**移除／替換之後**才算——在移除前算，待刪的那一版自己還在集合裡，
 *    於是每一個候選都被判定「仍被引用」，孤兒永遠留在磁碟上。
 */

const version = (
  overrides: Partial<SlideVersion> & { id: string; imagePath: string },
): SlideVersion => ({
  prompt: "",
  providerId: "mock-image",
  model: "mock",
  parameters: {},
  styleVersion: 1,
  sources: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const textLayer = (backgroundPath: string, compositePath: string) => ({
  originalVersionId: "original",
  backgroundPath,
  compositePath,
  threshold: 0.75,
  renderRevision: 0,
  boxes: [],
  extractedAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

describe("versionAssetPaths", () => {
  it("lists only the image path when there is no text layer", () => {
    expect(versionAssetPaths({ imagePath: "assets/slide/a.png" })).toEqual(["assets/slide/a.png"]);
  });

  it("lists the image, the background and the composite of a text layer", () => {
    expect(
      versionAssetPaths({
        imagePath: "assets/text-layers/original/composite-1-x.png",
        textLayer: textLayer(
          "assets/slide/background.png",
          "assets/text-layers/original/composite-1-x.png",
        ),
      }),
    ).toEqual([
      "assets/text-layers/original/composite-1-x.png",
      "assets/slide/background.png",
      "assets/text-layers/original/composite-1-x.png",
    ]);
  });
});

describe("staleVersionAssets", () => {
  it("keeps an alias path a manual text layer shares with its original version", () => {
    // 手動層：background 與原圖版本的 imagePath 是同一個檔案，composite 才是新落地的。
    const original = version({ id: "a", imagePath: "assets/slide/original.png" });
    const manual = version({
      id: "b",
      imagePath: "assets/text-layers/a/composite-0-x.png",
      textLayer: textLayer("assets/slide/original.png", "assets/text-layers/a/composite-0-x.png"),
    });
    const project = { slides: [{ versions: [original, manual] }] };

    // 刪掉手動層那一版：它的三個路徑全進候選，但別名那張仍被原圖版本引用著。
    const remaining = { slides: [{ versions: [original] }] };
    expect(staleVersionAssets(remaining, versionAssetPaths(manual))).toEqual([
      "assets/text-layers/a/composite-0-x.png",
    ]);
    // 反過來：兩版都還在時，一個都不能刪。
    expect(staleVersionAssets(project, versionAssetPaths(manual))).toEqual([]);
  });

  it("only frees an asset once the version holding it has been removed", () => {
    const slide = {
      versions: [
        version({ id: "a", imagePath: "assets/slide/a.png" }),
        version({ id: "b", imagePath: "assets/slide/b.png" }),
      ],
    };
    const candidates = ["assets/slide/b.png"];
    // 移除之前算：b 自己還在，於是「仍被引用」——這正是抄錯時會發生的事。
    expect(staleVersionAssets({ slides: [slide] }, candidates)).toEqual([]);
    slide.versions.splice(1, 1);
    expect(staleVersionAssets({ slides: [slide] }, candidates)).toEqual(["assets/slide/b.png"]);
  });

  it("looks across every slide, not just the one being edited", () => {
    // 複製頁面刻意不複製檔案，所以另一頁的版本可能引用著同一張圖。
    const shared = "assets/slide/shared.png";
    const project = {
      slides: [{ versions: [] }, { versions: [version({ id: "c", imagePath: shared })] }],
    };
    expect(staleVersionAssets(project, [shared])).toEqual([]);
  });

  it("de-duplicates candidates and preserves their order", () => {
    expect(
      staleVersionAssets({ slides: [] }, ["assets/b.png", "assets/a.png", "assets/b.png"]),
    ).toEqual(["assets/b.png", "assets/a.png"]);
  });
});

describe("referencedVersionAssets", () => {
  it("collects the image, background and composite of every version of every slide", () => {
    const project = {
      slides: [
        { versions: [version({ id: "a", imagePath: "assets/slide/a.png" })] },
        {
          versions: [
            version({
              id: "b",
              imagePath: "assets/text-layers/a/composite-0-x.png",
              textLayer: textLayer(
                "assets/slide/background.png",
                "assets/text-layers/a/composite-0-x.png",
              ),
            }),
          ],
        },
      ],
    };
    expect([...referencedVersionAssets(project)].sort()).toEqual([
      "assets/slide/a.png",
      "assets/slide/background.png",
      "assets/text-layers/a/composite-0-x.png",
    ]);
  });
});

describe("adoptVersion", () => {
  it("appends the version and points currentVersionId at it", () => {
    const slide = {
      versions: [version({ id: "a", imagePath: "assets/slide/a.png" })],
      currentVersionId: "a",
    };
    const next = version({ id: "b", imagePath: "assets/slide/b.png" });
    adoptVersion(slide, next);
    expect(slide.versions.map((candidate) => candidate.id)).toEqual(["a", "b"]);
    expect(slide.currentVersionId).toBe("b");
    // 不 clone：呼叫端拿到的是同一個物件（`updateProject` 的 callback 直接寫回這份）。
    expect(slide.versions[1]).toBe(next);
  });
});

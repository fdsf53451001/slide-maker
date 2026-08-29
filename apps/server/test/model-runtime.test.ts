import { SCHEMA_VERSION, type ModelLibrary, type ProviderKind } from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import { ModelLibraryError, ModelRuntime } from "../src/model-runtime.js";

const BASE = {
  localToolsRoot: "/tmp/slide-maker-model-runtime-test",
  defaults: {
    modelTimeoutMs: 600_000,
    ocrModelTier: "medium" as const,
    ocrDetSideLen: 1920,
  },
};

const TEXT_MODEL_NOT_FOUND_MESSAGE =
  "此組合指定的文字模型無法使用：它可能已從模型庫刪除，或它的種類（例如 mock）本來就不會產生文字。請到模型庫改掉這個組合的文字模型。";
const SEARCH_MODEL_NOT_FOUND_MESSAGE =
  "此組合指定的搜尋模型無法使用：它可能已從模型庫刪除，或它的種類（例如 mock、local）本來就不會提供搜尋。請到模型庫改掉這個組合的搜尋模型。";

type Capability = "text" | "search";
type UnavailableModel = Extract<ProviderKind, "mock" | "local"> | "dangling";

function libraryWith(
  capability: Capability,
  providerKind: UnavailableModel,
  includeRef = true,
): ModelLibrary {
  const modelRef = `${providerKind}-${capability}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: [],
    models:
      providerKind === "dangling"
        ? []
        : [
            {
              id: modelRef,
              name: `${providerKind} ${capability}`,
              capability,
              providerKind,
              model: "",
            },
          ],
    combinations: [
      {
        id: "test-combination",
        name: "測試組合",
        ...(includeRef && capability === "text" ? { textModelRef: modelRef } : {}),
        ...(includeRef && capability === "search" ? { searchModelRef: modelRef } : {}),
      },
    ],
    defaultCombinationId: "test-combination",
    system: {},
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}

function expectModelLibraryError(action: () => unknown, code: string, message: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ModelLibraryError);
  expect(thrown).toMatchObject({ name: "ModelLibraryError", code, message });
}

describe("ModelRuntime wires imageProfile through to the constructed provider", () => {
  // 這幾條釘的是 #buildImage 裡的 `entry.imageProfile ? { profile: entry.imageProfile } : {}`
  // ——沒有它，entry 上設定的 profile 只會被存進 models.json，永遠不會影響任何一次真正的
  // 生成請求（存檔驗證是另一份測試，apps/server/test/model-library.test.ts；這裡測的是
  // 執行期真的接上了）。用 `capabilities.maxReferenceImages` 當可觀測窗口：它是 profile
  // 唯一能在不打真實 HTTP 的情況下、從建好的 provider 實例上直接讀到的欄位。
  it("an openai image entry's maxReferenceImages override reaches the provider instance", () => {
    const library: ModelLibrary = {
      schemaVersion: SCHEMA_VERSION,
      connections: [],
      models: [
        {
          id: "openai-image-with-profile",
          name: "openai image with profile",
          capability: "image",
          providerKind: "openai",
          model: "vendor/unrecognised-image-model",
          imageApi: "images",
          imageProfile: { maxReferenceImages: 3 },
        },
      ],
      combinations: [],
      system: {},
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
    const runtime = new ModelRuntime(BASE, library);
    // 沒有 profile 覆寫時 images shape 的上限是 16（見 image-profile.ts 的
    // MAX_IMAGES_REFERENCES）；量到 3 才代表 entry.imageProfile 真的被讀了。
    expect(runtime.imageProvider("openai-image-with-profile").capabilities.maxReferenceImages).toBe(
      3,
    );
  });

  it("a gemini image entry's maxReferenceImages override reaches the provider instance", () => {
    const library: ModelLibrary = {
      schemaVersion: SCHEMA_VERSION,
      connections: [],
      models: [
        {
          id: "gemini-image-with-profile",
          name: "gemini image with profile",
          capability: "image",
          providerKind: "gemini",
          model: "gemini-3.1-flash-image",
          imageProfile: { maxReferenceImages: 2 },
        },
      ],
      combinations: [],
      system: {},
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
    const runtime = new ModelRuntime(BASE, library);
    // 沒有 profile 覆寫時 Gemini 原生端點的上限是 8（見 provider-gemini 的 MAX_REFERENCES）。
    expect(runtime.imageProvider("gemini-image-with-profile").capabilities.maxReferenceImages).toBe(
      2,
    );
  });

  /**
   * 並行生成數的三層優先序：entry → 系統設定 → 內建的 2。
   *
   * `maxConcurrency` 是 `jobs.ts` 排程時每個 provider 同時能跑幾個 job，也是這幾個欄位裡
   * 唯一能從建好的 provider 實例直接讀到、又不必打真實 HTTP 的。
   */
  it("takes concurrency from the entry first, then the system default, then the built-in 2", () => {
    const libraryWithConcurrency = (
      systemConcurrency: number | undefined,
      entryConcurrency: number | undefined,
    ): ModelLibrary => ({
      schemaVersion: SCHEMA_VERSION,
      connections: [],
      models: [
        {
          id: "openai-image-concurrency",
          name: "openai image",
          capability: "image",
          providerKind: "openai",
          model: "vendor/unrecognised-image-model",
          imageApi: "images",
          ...(entryConcurrency === undefined
            ? {}
            : { imageProfile: { maxConcurrency: entryConcurrency } }),
        },
      ],
      combinations: [],
      system: systemConcurrency === undefined ? {} : { imageConcurrency: systemConcurrency },
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    const concurrencyOf = (library: ModelLibrary): number | undefined =>
      new ModelRuntime(BASE, library).imageProvider("openai-image-concurrency").maxConcurrency;

    expect(concurrencyOf(libraryWithConcurrency(5, undefined))).toBe(5);
    // entry 自己填了就以 entry 為準，系統設定只是它沒填時的回退。
    expect(concurrencyOf(libraryWithConcurrency(5, 3))).toBe(3);
    expect(concurrencyOf(libraryWithConcurrency(undefined, undefined))).toBe(2);
  });

  it("without imageProfile, capabilities are unaffected (pins the pre-feature default)", () => {
    const library: ModelLibrary = {
      schemaVersion: SCHEMA_VERSION,
      connections: [],
      models: [
        {
          id: "openai-image-no-profile",
          name: "openai image no profile",
          capability: "image",
          providerKind: "openai",
          model: "gpt-image-1",
          imageApi: "images",
        },
      ],
      combinations: [],
      system: {},
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
    const runtime = new ModelRuntime(BASE, library);
    expect(runtime.imageProvider("openai-image-no-profile").capabilities.maxReferenceImages).toBe(
      16,
    );
  });
});

describe("ModelRuntime provider resolution", () => {
  it.each(["mock", "local", "dangling"] as const)(
    "search provider %s registry miss is an actionable ModelLibraryError",
    (providerKind) => {
      const runtime = new ModelRuntime(BASE, libraryWith("search", providerKind));
      expectModelLibraryError(
        () => runtime.resolveSearchProvider(undefined),
        "SEARCH_MODEL_NOT_FOUND",
        SEARCH_MODEL_NOT_FOUND_MESSAGE,
      );
    },
  );

  it("keeps a missing search ref distinct from a registry miss", () => {
    const runtime = new ModelRuntime(BASE, libraryWith("search", "dangling", false));
    expectModelLibraryError(
      () => runtime.resolveSearchProvider(undefined),
      "COMBINATION_SEARCH_MISSING",
      "此組合未設定搜尋模型。",
    );
  });

  it.each(["mock", "local", "dangling"] as const)(
    "preserves the text provider %s registry-miss contract",
    (providerKind) => {
      const runtime = new ModelRuntime(BASE, libraryWith("text", providerKind));
      expectModelLibraryError(
        () => runtime.resolveTextProvider(undefined),
        "TEXT_MODEL_NOT_FOUND",
        TEXT_MODEL_NOT_FOUND_MESSAGE,
      );
    },
  );

  it("preserves the missing text ref contract", () => {
    const runtime = new ModelRuntime(BASE, libraryWith("text", "dangling", false));
    expectModelLibraryError(
      () => runtime.resolveTextProvider(undefined),
      "COMBINATION_TEXT_MISSING",
      "此組合未設定文字模型。",
    );
  });
});

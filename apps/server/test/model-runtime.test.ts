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

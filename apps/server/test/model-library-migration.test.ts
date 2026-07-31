import { describe, expect, it } from "vitest";
import { modelLibrarySchema, SCHEMA_VERSION } from "@slide-maker/core";
import { migrateModelLibraryDocument } from "../src/model-library-migration.js";

/**
 * 這條 migration 是移除 codex 時風險最集中的一段：它排在 `modelLibrarySchema.parse()`
 * **之前**，因為 schema 已經拿不下舊值。清洗漏掉任何一種舊形狀，使用者開機看到的就是
 * 「模型庫壞了、退回 seed」——自訂的連線與組合一起消失。
 */
const legacyDocument = () => ({
  schemaVersion: SCHEMA_VERSION,
  connections: [
    {
      id: "conn-1",
      name: "我的 gateway",
      baseUrl: "http://localhost:8317/v1",
      apiKey: "secret",
      protocol: "openai",
      timeoutMs: 300_000,
    },
  ],
  models: [
    { id: "mock-image", name: "Mock", capability: "image", providerKind: "mock", model: "mock" },
    {
      id: "codex-image-spike",
      name: "Codex 影像",
      capability: "image",
      providerKind: "codex",
      model: "",
      reasoningEffort: "high",
    },
    {
      id: "codex-text",
      name: "Codex 文字",
      capability: "text",
      providerKind: "codex",
      model: "",
    },
    {
      id: "my-openai-text",
      name: "我的文字模型",
      capability: "text",
      providerKind: "openai",
      model: "gpt-5.6-terra",
      connectionRef: "conn-1",
      // openai entry 也可能帶著這個 codex 專屬旋鈕（UI 舊版對所有 kind 都存得下去）。
      reasoningEffort: "medium",
    },
  ],
  combinations: [
    {
      id: "keep-me",
      name: "自訂組合",
      imageModelRef: "mock-image",
      textModelRef: "my-openai-text",
    },
    {
      id: "points-at-codex",
      name: "舊組合",
      imageModelRef: "codex-image-spike",
      textModelRef: "codex-text",
    },
  ],
  defaultCombinationId: "keep-me",
  system: { codexTimeoutMs: 600_000, codexMaxConcurrency: 3, ocrModelTier: "medium" },
  updatedAt: new Date(0).toISOString(),
});

describe("model library migration", () => {
  it("讓舊文件通過新 schema——不遷移就整份 parse 失敗", () => {
    const legacy = legacyDocument();
    expect(() => modelLibrarySchema.parse(legacy)).toThrow();
    expect(() =>
      modelLibrarySchema.parse(migrateModelLibraryDocument(legacy).document),
    ).not.toThrow();
  });

  it("只丟掉 codex entry 與其專屬旋鈕，使用者自訂的連線與組合全數保留", () => {
    const result = migrateModelLibraryDocument(legacyDocument());
    const library = modelLibrarySchema.parse(result.document);

    expect(result.removedModelIds).toEqual(["codex-image-spike", "codex-text"]);
    expect(library.models.map((entry) => entry.id)).toEqual(["mock-image", "my-openai-text"]);
    // 連線一條都不能少：那是使用者手打的 base URL 與 key。
    expect(library.connections).toHaveLength(1);
    expect(library.connections[0]!.apiKey).toBe("secret");
    // 組合本身保留（只清 ref），否則使用者的命名與其他 ref 會一起消失。
    expect(library.combinations.map((item) => item.id)).toEqual(["keep-me", "points-at-codex"]);
    expect(library.defaultCombinationId).toBe("keep-me");
  });

  it("指向 codex 的 ref 清成未設定，其餘 ref 原樣不動", () => {
    const result = migrateModelLibraryDocument(legacyDocument());
    const library = modelLibrarySchema.parse(result.document);
    const kept = library.combinations.find((item) => item.id === "keep-me")!;
    const cleared = library.combinations.find((item) => item.id === "points-at-codex")!;

    expect(kept.imageModelRef).toBe("mock-image");
    expect(kept.textModelRef).toBe("my-openai-text");
    expect(cleared.imageModelRef).toBeUndefined();
    expect(cleared.textModelRef).toBeUndefined();
    expect(result.clearedCombinationIds).toEqual(["points-at-codex"]);

    // 清完之後不可以留下懸空 ref——那會變成生成時才爆的 TEXT_MODEL_NOT_FOUND。
    const ids = new Set(library.models.map((entry) => entry.id));
    for (const combination of library.combinations)
      for (const ref of [
        combination.imageModelRef,
        combination.textModelRef,
        combination.searchModelRef,
      ])
        if (ref !== undefined) expect(ids.has(ref)).toBe(true);
  });

  it("system 旋鈕換名保值：codexTimeoutMs → modelTimeoutMs，併發上限丟棄", () => {
    const library = modelLibrarySchema.parse(
      migrateModelLibraryDocument(legacyDocument()).document,
    );
    expect(library.system.modelTimeoutMs).toBe(600_000);
    expect(library.system.ocrModelTier).toBe("medium");
    expect(library.system).not.toHaveProperty("codexTimeoutMs");
    expect(library.system).not.toHaveProperty("codexMaxConcurrency");
  });

  it("已是新格式的文件是 no-op，不會每次開機都回寫一遍", () => {
    const modern = {
      ...legacyDocument(),
      models: [
        {
          id: "mock-image",
          name: "Mock",
          capability: "image",
          providerKind: "mock",
          model: "mock",
        },
      ],
      combinations: [{ id: "keep-me", name: "自訂組合", imageModelRef: "mock-image" }],
      system: { modelTimeoutMs: 600_000, ocrModelTier: "medium" },
    };
    const result = migrateModelLibraryDocument(modern);
    expect(result.changed).toBe(false);
    expect(result.document).toBe(modern);
  });

  it("非物件輸入原樣退回，交給 schema 去報錯", () => {
    for (const input of [null, undefined, 42, "nope", []]) {
      const result = migrateModelLibraryDocument(input);
      expect(result.changed).toBe(false);
      expect(result.document).toBe(input);
    }
  });
});

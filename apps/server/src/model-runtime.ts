import {
  ProviderRegistry,
  type ImageProvider,
  type ModelCombination,
  type ModelEntry,
  type ModelLibrary,
  type StructuredTextProvider,
  type WebSearchProvider,
} from "@slide-maker/core";
import { MockImageProvider } from "@slide-maker/provider-mock";
import {
  CodexImageSpikeProvider,
  CodexStructuredTextProvider,
  CodexWebSearchProvider,
} from "@slide-maker/provider-codex";
import {
  OpenAiCompatibleImageProvider,
  OpenAiStructuredTextProvider,
  OpenAiWebSearchProvider,
  type OpenAiClientConfig,
} from "@slide-maker/provider-openai";
import type { OcrModelTier } from "./config.js";

/** 執行環境常數（與品質無關），由 env 提供，rebuild 不變。 */
export interface ModelRuntimeBase {
  codexSandbox: boolean;
  codexImageJobsRoot: string;
  codexStructuredJobsRoot: string;
  codexWebSearchJobsRoot: string;
  defaults: {
    codexTimeoutMs: number;
    codexMaxConcurrency: number;
    ocrModelTier: OcrModelTier;
    ocrDetSideLen: number;
  };
}

export interface ResolvedSystemSettings {
  codexTimeoutMs: number;
  codexMaxConcurrency: number;
  ocrModelTier: OcrModelTier;
  ocrDetSideLen: number;
}

/** 解析出的組合：三能力對應的 entry id（可能為 undefined 表示未指定）。 */
export interface ResolvedCombination {
  combinationId: string;
  imageModelRef?: string;
  textModelRef?: string;
  searchModelRef?: string;
}

export class ModelLibraryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelLibraryError";
  }
}

/**
 * 由模型庫（資料）建構可執行的 provider registry（機器）。每個 model entry 對應
 * 一個 registered 實例，id = entry id。前端存檔後以 {@link rebuild} 原子替換。
 */
export class ModelRuntime {
  #library: ModelLibrary;
  #image = new ProviderRegistry<ImageProvider>();
  #text = new ProviderRegistry<StructuredTextProvider>();
  #search = new ProviderRegistry<WebSearchProvider>();
  #system: ResolvedSystemSettings;
  readonly #base: ModelRuntimeBase;

  constructor(base: ModelRuntimeBase, library: ModelLibrary) {
    this.#base = base;
    this.#library = library;
    this.#system = this.#resolveSystem(library);
    this.#build(library);
  }

  get library(): ModelLibrary {
    return this.#library;
  }

  get system(): ResolvedSystemSettings {
    return this.#system;
  }

  /** 供 JobRunner／readiness 使用的穩定影像來源（永遠指向當前 registry）。 */
  get imageProviders(): { get(id: string): ImageProvider; list(): ImageProvider[] } {
    return {
      get: (id: string) => this.#image.get(id),
      list: () => this.#image.list(),
    };
  }

  listImageEntries(): ModelEntry[] {
    return this.#library.models.filter((entry) => entry.capability === "image");
  }

  imageProvider(id: string): ImageProvider {
    return this.#image.get(id);
  }

  structuredText(id: string): StructuredTextProvider {
    return this.#text.get(id);
  }

  webSearch(id: string): WebSearchProvider {
    return this.#search.get(id);
  }

  /** 依新的模型庫重建三個 registry（原子替換）。 */
  rebuild(library: ModelLibrary): void {
    const image = new ProviderRegistry<ImageProvider>();
    const text = new ProviderRegistry<StructuredTextProvider>();
    const search = new ProviderRegistry<WebSearchProvider>();
    const system = this.#resolveSystem(library);
    this.#buildInto(library, system, image, text, search);
    this.#library = library;
    this.#system = system;
    this.#image = image;
    this.#text = text;
    this.#search = search;
  }

  /**
   * 解析專案綁定的組合：project.combinationId ?? library.defaultCombinationId。
   * 找不到組合時 throw；ref 是否齊全由呼叫端於生成時檢查（存檔寬鬆）。
   */
  resolveCombination(combinationId: string | undefined): ResolvedCombination {
    const id = combinationId ?? this.#library.defaultCombinationId;
    if (!id) throw new ModelLibraryError("NO_DEFAULT_COMBINATION", "模型庫尚未設定預設組合。");
    const combination = this.#library.combinations.find((item) => item.id === id);
    if (!combination) throw new ModelLibraryError("COMBINATION_NOT_FOUND", `找不到模型組合：${id}`);
    return this.#toResolved(combination);
  }

  /** 目前預設組合 id（供 lazy 綁定寫回專案）。 */
  get defaultCombinationId(): string | undefined {
    return this.#library.defaultCombinationId;
  }

  /** 解析文字 provider：無 project 時退回預設組合（如 style-analysis）。 */
  resolveTextProvider(combinationId: string | undefined): StructuredTextProvider {
    const resolved = this.resolveCombination(combinationId);
    if (!resolved.textModelRef)
      throw new ModelLibraryError("COMBINATION_TEXT_MISSING", "此組合未設定文字模型。");
    return this.#text.get(resolved.textModelRef);
  }

  resolveSearchProvider(combinationId: string | undefined): WebSearchProvider {
    const resolved = this.resolveCombination(combinationId);
    if (!resolved.searchModelRef)
      throw new ModelLibraryError("COMBINATION_SEARCH_MISSING", "此組合未設定搜尋模型。");
    return this.#search.get(resolved.searchModelRef);
  }

  resolveImageEntryId(combinationId: string | undefined): string {
    const resolved = this.resolveCombination(combinationId);
    if (!resolved.imageModelRef)
      throw new ModelLibraryError("COMBINATION_IMAGE_MISSING", "此組合未設定影像模型。");
    return resolved.imageModelRef;
  }

  #toResolved(combination: ModelCombination): ResolvedCombination {
    return {
      combinationId: combination.id,
      ...(combination.imageModelRef ? { imageModelRef: combination.imageModelRef } : {}),
      ...(combination.textModelRef ? { textModelRef: combination.textModelRef } : {}),
      ...(combination.searchModelRef ? { searchModelRef: combination.searchModelRef } : {}),
    };
  }

  #resolveSystem(library: ModelLibrary): ResolvedSystemSettings {
    const system = library.system;
    return {
      codexTimeoutMs: system.codexTimeoutMs ?? this.#base.defaults.codexTimeoutMs,
      codexMaxConcurrency: system.codexMaxConcurrency ?? this.#base.defaults.codexMaxConcurrency,
      ocrModelTier: system.ocrModelTier ?? this.#base.defaults.ocrModelTier,
      ocrDetSideLen: system.ocrDetSideLen ?? this.#base.defaults.ocrDetSideLen,
    };
  }

  #build(library: ModelLibrary): void {
    this.#buildInto(library, this.#system, this.#image, this.#text, this.#search);
  }

  #buildInto(
    library: ModelLibrary,
    system: ResolvedSystemSettings,
    image: ProviderRegistry<ImageProvider>,
    text: ProviderRegistry<StructuredTextProvider>,
    search: ProviderRegistry<WebSearchProvider>,
  ): void {
    const connectionConfig = (entry: ModelEntry): OpenAiClientConfig => {
      const connection = entry.connectionRef
        ? library.connections.find((item) => item.id === entry.connectionRef)
        : undefined;
      return {
        baseUrl: connection?.baseUrl ?? "",
        apiKey: connection?.apiKey ?? "",
        timeoutMs: connection?.timeoutMs ?? this.#base.defaults.codexTimeoutMs,
      };
    };
    for (const entry of library.models) {
      if (entry.capability === "image") {
        image.register(this.#buildImage(entry, system, connectionConfig(entry)));
      } else if (entry.capability === "text") {
        const provider = this.#buildText(entry, system, connectionConfig(entry));
        if (provider) text.register(provider);
      } else {
        const provider = this.#buildSearch(entry, system, connectionConfig(entry));
        if (provider) search.register(provider);
      }
    }
  }

  #buildImage(
    entry: ModelEntry,
    system: ResolvedSystemSettings,
    config: OpenAiClientConfig,
  ): ImageProvider {
    if (entry.providerKind === "mock") return new MockImageProvider(entry.id);
    if (entry.providerKind === "codex")
      return new CodexImageSpikeProvider({
        id: entry.id,
        allowExecution: this.#base.codexSandbox,
        workspaceRoot: this.#base.codexImageJobsRoot,
        timeoutMs: system.codexTimeoutMs,
        maxConcurrency: system.codexMaxConcurrency,
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      });
    return new OpenAiCompatibleImageProvider({
      id: entry.id,
      config,
      model: entry.model,
      ...(entry.imageApi ? { apiShape: entry.imageApi } : {}),
    });
  }

  #buildText(
    entry: ModelEntry,
    system: ResolvedSystemSettings,
    config: OpenAiClientConfig,
  ): StructuredTextProvider | undefined {
    if (entry.providerKind === "mock") return undefined;
    if (entry.providerKind === "codex")
      return new CodexStructuredTextProvider({
        id: entry.id,
        allowExecution: this.#base.codexSandbox,
        workspaceRoot: this.#base.codexStructuredJobsRoot,
        timeoutMs: system.codexTimeoutMs,
      });
    return new OpenAiStructuredTextProvider({ id: entry.id, config, model: entry.model });
  }

  #buildSearch(
    entry: ModelEntry,
    system: ResolvedSystemSettings,
    config: OpenAiClientConfig,
  ): WebSearchProvider | undefined {
    if (entry.providerKind === "mock") return undefined;
    if (entry.providerKind === "codex")
      return new CodexWebSearchProvider({
        id: entry.id,
        allowExecution: this.#base.codexSandbox,
        workspaceRoot: this.#base.codexWebSearchJobsRoot,
        timeoutMs: system.codexTimeoutMs,
      });
    return new OpenAiWebSearchProvider({ id: entry.id, config, model: entry.model });
  }
}

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
  OpenAiCompatibleImageProvider,
  OpenAiStructuredTextProvider,
  OpenAiWebSearchProvider,
  type OpenAiClientConfig,
} from "@slide-maker/provider-openai";
import {
  GeminiImageProvider,
  GeminiStructuredTextProvider,
  GeminiWebSearchProvider,
} from "@slide-maker/provider-gemini";
import type { OcrModelTier } from "./config.js";
import { LocalInpaintProvider } from "./local-inpaint.js";

/** 執行環境常數（與品質無關），由 env 提供，rebuild 不變。 */
export interface ModelRuntimeBase {
  /** 本機 provider（local-inpaint）解析 `.venv-ocr` 與 `scripts/` 的 workspace 根目錄。 */
  localToolsRoot: string;
  defaults: {
    modelTimeoutMs: number;
    ocrModelTier: OcrModelTier;
    ocrDetSideLen: number;
  };
}

export interface ResolvedSystemSettings {
  modelTimeoutMs: number;
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
    this.#buildInto(library, image, text, search);
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

  /**
   * 解析文字 provider：無 project 時退回預設組合（如 style-analysis）。
   *
   * registry miss 一定要轉成具名 {@link ModelLibraryError}：`ProviderRegistry.get()` 丟的是
   * 裸 `Error("Unknown provider: …")`，錯誤中介層對它只能落到 500 `INTERNAL_SERVER_ERROR`
   * ——沒有 message、沒有下一步，看起來像伺服器壞了。但這其實是**使用者自己改得掉的設定
   * 問題**：`#buildText` 對 `providerKind` 是 `mock`／`local` 的 entry 回 undefined（不註冊
   * 進 registry），而模型庫 UI 的種類清單含 `mock`、組合的文字下拉又只濾掉 `local`，所以
   * 建一個「能力＝文字、種類＝mock」的 entry 綁進組合就踩得到；模型被刪掉但組合還引用著
   * 也是同一條。
   */
  resolveTextProvider(combinationId: string | undefined): StructuredTextProvider {
    const resolved = this.resolveCombination(combinationId);
    if (!resolved.textModelRef)
      throw new ModelLibraryError("COMBINATION_TEXT_MISSING", "此組合未設定文字模型。");
    return this.#resolveRegisteredProvider(
      this.#text,
      resolved.textModelRef,
      "TEXT_MODEL_NOT_FOUND",
      "此組合指定的文字模型無法使用：它可能已從模型庫刪除，或它的種類（例如 mock）本來就不會產生文字。請到模型庫改掉這個組合的文字模型。",
    );
  }

  resolveSearchProvider(combinationId: string | undefined): WebSearchProvider {
    const resolved = this.resolveCombination(combinationId);
    if (!resolved.searchModelRef)
      throw new ModelLibraryError("COMBINATION_SEARCH_MISSING", "此組合未設定搜尋模型。");
    return this.#resolveRegisteredProvider(
      this.#search,
      resolved.searchModelRef,
      "SEARCH_MODEL_NOT_FOUND",
      "此組合指定的搜尋模型無法使用：它可能已從模型庫刪除，或它的種類（例如 mock、local）本來就不會提供搜尋。請到模型庫改掉這個組合的搜尋模型。",
    );
  }

  resolveImageEntryId(combinationId: string | undefined): string {
    const resolved = this.resolveCombination(combinationId);
    if (!resolved.imageModelRef)
      throw new ModelLibraryError("COMBINATION_IMAGE_MISSING", "此組合未設定影像模型。");
    return resolved.imageModelRef;
  }

  #resolveRegisteredProvider<T extends { readonly id: string }>(
    registry: ProviderRegistry<T>,
    modelRef: string,
    code: string,
    message: string,
  ): T {
    try {
      return registry.get(modelRef);
    } catch {
      throw new ModelLibraryError(code, message);
    }
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
      modelTimeoutMs: system.modelTimeoutMs ?? this.#base.defaults.modelTimeoutMs,
      ocrModelTier: system.ocrModelTier ?? this.#base.defaults.ocrModelTier,
      ocrDetSideLen: system.ocrDetSideLen ?? this.#base.defaults.ocrDetSideLen,
    };
  }

  #build(library: ModelLibrary): void {
    this.#buildInto(library, this.#image, this.#text, this.#search);
  }

  #buildInto(
    library: ModelLibrary,
    image: ProviderRegistry<ImageProvider>,
    text: ProviderRegistry<StructuredTextProvider>,
    search: ProviderRegistry<WebSearchProvider>,
  ): void {
    // 連線設定的形狀（base URL + key + timeout）在 openai 與 gemini 兩家 provider 之間
    // 完全相同，故共用同一個型別，不另立平行結構。
    const connectionConfig = (entry: ModelEntry): OpenAiClientConfig => {
      const connection = entry.connectionRef
        ? library.connections.find((item) => item.id === entry.connectionRef)
        : undefined;
      return {
        baseUrl: connection?.baseUrl ?? "",
        apiKey: connection?.apiKey ?? "",
        timeoutMs:
          connection?.timeoutMs ??
          library.system.modelTimeoutMs ??
          this.#base.defaults.modelTimeoutMs,
      };
    };
    for (const entry of library.models) {
      if (entry.capability === "image") {
        image.register(this.#buildImage(entry, connectionConfig(entry)));
      } else if (entry.capability === "text") {
        const provider = this.#buildText(entry, connectionConfig(entry));
        if (provider) text.register(provider);
      } else {
        const provider = this.#buildSearch(entry, connectionConfig(entry));
        if (provider) search.register(provider);
      }
    }
  }

  #buildImage(entry: ModelEntry, config: OpenAiClientConfig): ImageProvider {
    if (entry.providerKind === "mock") return new MockImageProvider(entry.id);
    if (entry.providerKind === "local")
      return new LocalInpaintProvider({ id: entry.id, root: this.#base.localToolsRoot });
    if (entry.providerKind === "gemini")
      return new GeminiImageProvider({ id: entry.id, config, model: entry.model });
    return new OpenAiCompatibleImageProvider({
      id: entry.id,
      config,
      model: entry.model,
      ...(entry.imageApi ? { apiShape: entry.imageApi } : {}),
    });
  }

  #buildText(entry: ModelEntry, config: OpenAiClientConfig): StructuredTextProvider | undefined {
    if (entry.providerKind === "mock" || entry.providerKind === "local") return undefined;
    if (entry.providerKind === "gemini")
      return new GeminiStructuredTextProvider({ id: entry.id, config, model: entry.model });
    return new OpenAiStructuredTextProvider({ id: entry.id, config, model: entry.model });
  }

  #buildSearch(entry: ModelEntry, config: OpenAiClientConfig): WebSearchProvider | undefined {
    if (entry.providerKind === "mock" || entry.providerKind === "local") return undefined;
    if (entry.providerKind === "gemini")
      return new GeminiWebSearchProvider({ id: entry.id, config, model: entry.model });
    return new OpenAiWebSearchProvider({ id: entry.id, config, model: entry.model });
  }
}

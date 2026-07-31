import {
  SCHEMA_VERSION,
  modelLibrarySchema,
  type ModelCombination,
  type ModelConnection,
  type ModelEntry,
  type ModelLibrary,
} from "@slide-maker/core";
import type { OcrModelTier, OpenAiImageApi } from "./config.js";

/**
 * 首次開機的 seed 素材：把目前 env 值解析結果轉成一份模型庫。
 * seeded entry 沿用既有 provider id 作為 entry id，讓 registry 與端點預設無痛接軌。
 */
export interface SeedConfig {
  now: string;
  openai?: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    imageModel?: string;
    textModel?: string;
    searchModel?: string;
    imageApi: OpenAiImageApi;
  };
  system: {
    modelTimeoutMs: number;
    ocrModelTier: OcrModelTier;
    ocrDetSideLen: number;
  };
}

const OPENAI_CONNECTION_ID = "openai-default";

/**
 * extract-text 預設引擎的內建 entry：本地 OpenCV 抹字 inpaint。
 * id 即 provider id（route 的 providerId 預設值指向它），不需要 connection。
 */
const LOCAL_INPAINT_ENTRY: ModelEntry = {
  id: "local-inpaint",
  name: "OpenCV 抹字修補（本機）",
  capability: "image",
  providerKind: "local",
  model: "opencv-inpaint-telea-v2",
};

/**
 * 既有 `models.json`（在 local-inpaint 出現之前 seed 的）補上內建 entry；
 * 已存在時回 undefined（呼叫端不需要重存）。
 */
export function withLocalInpaintEntry(library: ModelLibrary): ModelLibrary | undefined {
  if (library.models.some((entry) => entry.id === LOCAL_INPAINT_ENTRY.id)) return undefined;
  return { ...library, models: [...library.models, { ...LOCAL_INPAINT_ENTRY }] };
}

export function buildSeedLibrary(config: SeedConfig): ModelLibrary {
  const connections: ModelConnection[] = [];
  const models: ModelEntry[] = [];

  // 影像：mock 保底 + 本地 inpaint（entry id 沿用既有 provider id）。
  models.push({
    id: "mock-image",
    name: "Mock 影像（確定性佔位）",
    capability: "image",
    providerKind: "mock",
    model: "mock",
  });
  models.push({ ...LOCAL_INPAINT_ENTRY });

  // openai 家：**一律** seed 連線與三個 entry，env 有值就填進去、沒有就留空待填。
  //
  // 舊版只在 env 齊全時才 seed（理由是「避免半殘 entry」），那在還有 codex 這個「本機一定
  // 有」的後備時說得通。codex 移除後那個前提沒了：什麼都不 seed 的話，第一次開機的使用者
  // 看到的是一個幾乎空的模型庫，得自己推敲出「建連線 → 建模型 → 建組合 → 指定給專案」
  // 四層結構才能生第一份大綱；而組合缺 ref 時端點回的是 `COMBINATION_TEXT_MISSING`，
  // 對新手等於沒說。留一份待填骨架則相反：欄位就在眼前，執行期的 availability 仍是
  // unavailable，訊息會直接指出要設哪個值。
  {
    connections.push({
      id: OPENAI_CONNECTION_ID,
      name: "OpenAI 相容端點",
      baseUrl: config.openai?.baseUrl ?? "",
      apiKey: config.openai?.apiKey ?? "",
      // env 遷移路徑只涵蓋 OpenAI 相容端點；Gemini 從未有對應 env，由使用者在 UI 新增。
      protocol: "openai",
      ...(config.openai?.timeoutMs ? { timeoutMs: config.openai.timeoutMs } : {}),
    });
    models.push({
      id: "openai-image",
      name: "OpenAI 影像",
      capability: "image",
      providerKind: "openai",
      model: config.openai?.imageModel ?? "",
      connectionRef: OPENAI_CONNECTION_ID,
      ...(config.openai?.imageApi ? { imageApi: config.openai.imageApi } : {}),
    });
    models.push({
      id: "openai-text",
      name: "OpenAI 文字",
      capability: "text",
      providerKind: "openai",
      model: config.openai?.textModel ?? "",
      connectionRef: OPENAI_CONNECTION_ID,
    });
    models.push({
      id: "openai-search",
      name: "OpenAI 搜尋",
      capability: "search",
      providerKind: "openai",
      model: config.openai?.searchModel ?? config.openai?.textModel ?? "",
      connectionRef: OPENAI_CONNECTION_ID,
    });
  }

  // 預設組合：影像用不消耗配額的 mock 保底，文字／搜尋指向上面那組待填 entry。
  const defaultCombination: ModelCombination = {
    id: "default",
    name: "預設組合",
    imageModelRef: "mock-image",
    textModelRef: "openai-text",
    searchModelRef: "openai-search",
  };

  return modelLibrarySchema.parse({
    schemaVersion: SCHEMA_VERSION,
    connections,
    models,
    combinations: [defaultCombination],
    defaultCombinationId: defaultCombination.id,
    system: {
      modelTimeoutMs: config.system.modelTimeoutMs,
      ocrModelTier: config.system.ocrModelTier,
      ocrDetSideLen: config.system.ocrDetSideLen,
    },
    updatedAt: config.now,
  });
}

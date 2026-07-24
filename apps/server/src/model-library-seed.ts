import {
  SCHEMA_VERSION,
  modelLibrarySchema,
  type ModelCombination,
  type ModelConnection,
  type ModelEntry,
  type ModelLibrary,
} from "@slide-maker/core";
import type { AiEngine, CodexReasoningEffort, OcrModelTier, OpenAiImageApi } from "./config.js";

/**
 * 首次開機的 seed 素材：把目前 env 值解析結果轉成一份模型庫。
 * seeded entry 沿用既有 provider id 作為 entry id，讓 registry 與端點預設無痛接軌。
 */
export interface SeedConfig {
  now: string;
  textEngine: AiEngine;
  webSearchEngine: AiEngine;
  codex: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
  };
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
    codexTimeoutMs: number;
    codexMaxConcurrency: number;
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

  // 影像：mock 保底 + 本地 inpaint + codex（entry id 沿用既有 provider id）。
  models.push({
    id: "mock-image",
    name: "Mock 影像（確定性佔位）",
    capability: "image",
    providerKind: "mock",
    model: "mock",
  });
  models.push({ ...LOCAL_INPAINT_ENTRY });
  models.push({
    id: "codex-image-spike",
    name: "Codex 影像",
    capability: "image",
    providerKind: "codex",
    model: config.codex.model ?? "",
    ...(config.codex.reasoningEffort ? { reasoningEffort: config.codex.reasoningEffort } : {}),
  });

  // 文字／搜尋：codex 一律有。
  models.push({
    id: "codex-text",
    name: "Codex 文字",
    capability: "text",
    providerKind: "codex",
    model: config.codex.model ?? "",
    ...(config.codex.reasoningEffort ? { reasoningEffort: config.codex.reasoningEffort } : {}),
  });
  models.push({
    id: "codex-search",
    name: "Codex 搜尋",
    capability: "search",
    providerKind: "codex",
    model: config.codex.model ?? "",
  });

  // openai 家：僅在 env 有 base URL + key 時 seed（避免半殘 entry）。
  if (config.openai && config.openai.baseUrl && config.openai.apiKey) {
    connections.push({
      id: OPENAI_CONNECTION_ID,
      name: "OpenAI 相容端點",
      baseUrl: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
      // env 遷移路徑只涵蓋 OpenAI 相容端點；Gemini 從未有對應 env，由使用者在 UI 新增。
      protocol: "openai",
      timeoutMs: config.openai.timeoutMs,
    });
    models.push({
      id: "openai-image",
      name: "OpenAI 影像",
      capability: "image",
      providerKind: "openai",
      model: config.openai.imageModel ?? "",
      connectionRef: OPENAI_CONNECTION_ID,
      imageApi: config.openai.imageApi,
    });
    models.push({
      id: "openai-text",
      name: "OpenAI 文字",
      capability: "text",
      providerKind: "openai",
      model: config.openai.textModel ?? "",
      connectionRef: OPENAI_CONNECTION_ID,
    });
    models.push({
      id: "openai-search",
      name: "OpenAI 搜尋",
      capability: "search",
      providerKind: "openai",
      model: config.openai.searchModel ?? config.openai.textModel ?? "",
      connectionRef: OPENAI_CONNECTION_ID,
    });
  }

  // 預設組合：影像=mock 保底；文字／搜尋沿用 env 引擎選擇（行為保留）。
  // openai 未設定時退回 codex，避免 seed 出懸空 ref。
  const openaiSeeded = Boolean(config.openai?.baseUrl && config.openai.apiKey);
  const defaultCombination: ModelCombination = {
    id: "default",
    name: "預設組合",
    imageModelRef: "mock-image",
    textModelRef: config.textEngine === "openai" && openaiSeeded ? "openai-text" : "codex-text",
    searchModelRef:
      config.webSearchEngine === "openai" && openaiSeeded ? "openai-search" : "codex-search",
  };

  return modelLibrarySchema.parse({
    schemaVersion: SCHEMA_VERSION,
    connections,
    models,
    combinations: [defaultCombination],
    defaultCombinationId: defaultCombination.id,
    system: {
      codexTimeoutMs: config.system.codexTimeoutMs,
      codexMaxConcurrency: config.system.codexMaxConcurrency,
      ocrModelTier: config.system.ocrModelTier,
      ocrDetSideLen: config.system.ocrDetSideLen,
    },
    updatedAt: config.now,
  });
}

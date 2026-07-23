import { z } from "zod";
import { SCHEMA_VERSION } from "./schemas.js";

/**
 * 模型庫（model library）：把散落在環境變數的模型／連線／組合設定升為
 * server 端第一方資料（存於 `DATA_ROOT/models.json`）。四個區塊：
 *  - connections：OpenAI 相容端點的連線（base URL + key + timeout），可被多個 model 引用。
 *  - models：單一能力（影像／文字／搜尋）的模型 entry，選 provider kind + model 名 + 旋鈕。
 *  - combinations：一次挑三個 model entry（影像／文字／搜尋）組成的具名組合。
 *  - system：影響執行而非品質的維運旋鈕（codex timeout / 併發、OCR），有預設。
 *
 * 存檔採「寬鬆」策略（允許半成品草稿），真正的完整性檢查留到「生成」時。
 */

export const modelCapabilitySchema = z.enum(["image", "text", "search"]);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

/**
 * provider 種類：mock（確定性佔位）、codex（本機 CLI）、openai（OpenAI 相容端點）、
 * gemini（AI Studio 原生 `:generateContent`）、local（本機子程序，如 OpenCV 抹字
 * inpaint；比照 mock 不需要 connection）。
 */
export const providerKindSchema = z.enum(["mock", "codex", "openai", "gemini", "local"]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/**
 * 端點協定。屬於連線本身而非模型：同一把 key、同一個 base URL 只會說一種協定，
 * 而「列出可用模型」的請求形狀（OpenAI `GET /models` vs Gemini `ListModels`）
 * 完全不同，必須在連線層就分流。default 讓既有 `models.json` 無痛升級。
 */
export const connectionProtocolSchema = z.enum(["openai", "gemini"]);
export type ConnectionProtocol = z.infer<typeof connectionProtocolSchema>;

export const openAiImageApiSchema = z.enum(["images", "chat", "openrouter-image"]);
export type OpenAiImageApi = z.infer<typeof openAiImageApiSchema>;
export const codexReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]);
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;
// PP-OCRv6 的層級（tiny／small／medium）。v5 時代的 mobile／hybrid／server 是
// 已持久化在 models.json 的舊值，解析時映射到對應層級，讓既有資料照常載入
//（重新儲存時即以新值落地）。
export type OcrModelTier = "tiny" | "small" | "medium";
const LEGACY_OCR_MODEL_TIERS: Record<string, OcrModelTier> = {
  mobile: "small",
  hybrid: "medium",
  server: "medium",
};
export const ocrModelTierSchema = z
  .enum(["tiny", "small", "medium", "mobile", "hybrid", "server"])
  .transform((value): OcrModelTier => LEGACY_OCR_MODEL_TIERS[value] ?? (value as OcrModelTier));

/** 連線層：供 openai／gemini 兩家 HTTP 端點使用。key 於 API GET 時 redact（唯寫）。 */
export const modelConnectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().default(""),
  apiKey: z.string().default(""),
  protocol: connectionProtocolSchema.default("openai"),
  timeoutMs: z.number().int().positive().optional(),
});
export type ModelConnection = z.infer<typeof modelConnectionSchema>;

/**
 * 模型層：一個 entry 服務單一能力。openai／gemini kind 才有 connectionRef；
 * reasoningEffort 專屬 codex；imageApi 專屬 openai 影像（Gemini 只有一種 transport）。
 */
export const modelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  capability: modelCapabilitySchema,
  providerKind: providerKindSchema,
  model: z.string().trim().default(""),
  connectionRef: z.string().optional(),
  reasoningEffort: codexReasoningEffortSchema.optional(),
  imageApi: openAiImageApiSchema.optional(),
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/** 組合層：各能力挑一個 model entry。ref 可為空（草稿），生成時才要求齊全。 */
export const modelCombinationSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  imageModelRef: z.string().optional(),
  textModelRef: z.string().optional(),
  searchModelRef: z.string().optional(),
});
export type ModelCombination = z.infer<typeof modelCombinationSchema>;

/** 系統設定區：維運旋鈕，有預設、平常不動。 */
export const modelLibrarySystemSchema = z.object({
  codexTimeoutMs: z.number().int().positive().optional(),
  codexMaxConcurrency: z.number().int().min(1).optional(),
  ocrModelTier: ocrModelTierSchema.optional(),
  ocrDetSideLen: z.number().int().positive().optional(),
});
export type ModelLibrarySystem = z.infer<typeof modelLibrarySystemSchema>;

export const modelLibrarySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  connections: z.array(modelConnectionSchema).default([]),
  models: z.array(modelEntrySchema).default([]),
  combinations: z.array(modelCombinationSchema).default([]),
  defaultCombinationId: z.string().optional(),
  system: modelLibrarySystemSchema.default({}),
  updatedAt: z.string().datetime(),
});
export type ModelLibrary = z.infer<typeof modelLibrarySchema>;

const REDACTED = "••••••••" as const;

/** 是否為 redact 佔位字串（PATCH 時代表「沿用舊 key」）。 */
export function isRedactedKey(value: string): boolean {
  return value === REDACTED;
}

/** 對外輸出：把連線 apiKey 換成佔位符（有設定回佔位、未設回空字串）。 */
export function redactLibrary(library: ModelLibrary): ModelLibrary {
  return {
    ...library,
    connections: library.connections.map((connection) => ({
      ...connection,
      apiKey: connection.apiKey ? REDACTED : "",
    })),
  };
}

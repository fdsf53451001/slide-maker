import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import {
  imageModelProfileSchema,
  type ImageSizing,
  isRedactedKey,
  modelCombinationSchema,
  modelConnectionSchema,
  modelEntrySchema,
  modelLibrarySystemSchema,
  redactLibrary,
  type ModelEntry,
  type ModelLibrary,
} from "@slide-maker/core";
import {
  GEMINI_MAX_REFERENCES,
  GEMINI_SIZING_MODES,
  listGeminiModelIds,
} from "@slide-maker/provider-gemini";
import {
  listModelIds,
  MAX_REFERENCES_BY_SHAPE,
  SIZING_MODES_BY_SHAPE,
} from "@slide-maker/provider-openai";
import { ModelLibraryError, type ModelRuntime } from "../model-runtime.js";
import { idSchema } from "../project-write-helpers.js";
import type { AppContext } from "./context.js";

/**
 * model entry 的 providerKind 與其連線 protocol 必須一致。
 *
 * 兩者是各自獨立的欄位，REST API 或手改 `models.json` 都能把 `providerKind:"gemini"`
 * 的 entry 指向 `protocol:"openai"` 的連線；那樣的組合在執行期只會得到難懂的
 * `GEMINI_REQUEST_FAILED HTTP 404`（請求形狀根本不同），所以在寫入時就擋掉。
 * connectionRef 為空是允許的草稿狀態（完整性留到生成時檢查），只驗有指定的情形。
 */
function assertConnectionProtocol(draft: ModelLibrary, entry: ModelEntry): void {
  if (entry.providerKind !== "openai" && entry.providerKind !== "gemini") return;
  if (!entry.connectionRef) return;
  const connection = draft.connections.find((item) => item.id === entry.connectionRef);
  // 懸空 ref 不在這裡管：連線刪除已被 CONNECTION_IN_USE 擋住，且草稿允許半成品。
  if (!connection) return;
  if (connection.protocol !== entry.providerKind)
    throw new ModelLibraryError(
      "CONNECTION_PROTOCOL_MISMATCH",
      `模型「${entry.name}」是 ${entry.providerKind} 類型，不能引用 ${connection.protocol} 協定的連線「${connection.name}」。`,
    );
}

/**
 * 影像 profile 必須是這條 transport 表達得出來的。
 *
 * 尺寸講法是**協定**而不是偏好：`size` 是 OpenAI images 端點的欄位、`image_size` 是 Gemini
 * 系（chat translator 與原生 generateContent）的欄位，兩邊沒有對應翻譯。存下一個對不上的
 * 組合不會有任何立即症狀——transport 會靜默不送尺寸，於是模型回一張只有 1376×768 的圖，
 * 正規化放大 1.40× 後糊掉，而使用者只會覺得「這個模型畫得比較差」。
 *
 * 參考圖上限同理但方向相反：設得比端點自身的上限高不會生效（provider 會夾回去），使用者
 * 卻會以為每頁真的能附那麼多張。兩者都是現在改得掉的設定問題，所以在寫入時就擋下。
 *
 * 兩張表都**從 provider 套件 import**，不在這裡另抄一份：抄一份的話，新增一種 mode 只改了
 * 其中一邊就會通過驗證、然後在送出時靜默 no-op。
 */
const SIZING_MODE_LABEL: Record<ImageSizing["mode"], string> = {
  size: "size（像素字串，如 1536x1024）",
  aspect_ratio: "aspect_ratio（比例＋解析度檔位）",
  image_size: "image_size（解析度檔位）",
  none: "不送尺寸參數",
};

function imageTransportLimits(entry: ModelEntry): {
  name: string;
  modes: ReadonlyArray<ImageSizing["mode"]>;
  maxReferences: number;
} {
  if (entry.providerKind === "gemini")
    return { name: "gemini", modes: GEMINI_SIZING_MODES, maxReferences: GEMINI_MAX_REFERENCES };
  const shape = entry.imageApi ?? "images";
  return {
    name: shape,
    modes: SIZING_MODES_BY_SHAPE[shape],
    maxReferences: MAX_REFERENCES_BY_SHAPE[shape],
  };
}

function assertImageProfile(entry: ModelEntry): void {
  const profile = entry.imageProfile;
  if (!profile) return;
  if (entry.capability !== "image")
    throw new ModelLibraryError(
      "IMAGE_PROFILE_NOT_APPLICABLE",
      `模型「${entry.name}」不是影像模型，影像參數對它沒有作用；請改設能力為影像，或清掉這些參數。`,
    );
  if (entry.providerKind !== "openai" && entry.providerKind !== "gemini")
    throw new ModelLibraryError(
      "IMAGE_PROFILE_NOT_APPLICABLE",
      `模型「${entry.name}」是 ${entry.providerKind} 類型，不會打 HTTP 影像端點，影像參數對它沒有作用；請清掉這些參數。`,
    );
  const transport = imageTransportLimits(entry);
  if (profile.sizing && !transport.modes.includes(profile.sizing.mode))
    throw new ModelLibraryError(
      "IMAGE_PROFILE_SIZING_UNSUPPORTED",
      `模型「${entry.name}」走的是 ${transport.name} 通道，它的尺寸參數只支援：${transport.modes
        .map((mode) => SIZING_MODE_LABEL[mode])
        .join(
          "、",
        )}。請改選其中一種，或改用支援 ${SIZING_MODE_LABEL[profile.sizing.mode]} 的影像 API。`,
    );
  if (
    profile.maxReferenceImages !== undefined &&
    profile.maxReferenceImages > transport.maxReferences
  )
    throw new ModelLibraryError(
      "IMAGE_PROFILE_REFERENCE_LIMIT_TOO_HIGH",
      `模型「${entry.name}」走的是 ${transport.name} 通道，每次請求最多只能附 ${transport.maxReferences} 張圖，填 ${profile.maxReferenceImages} 不會生效。請填 ${transport.maxReferences} 以下的數字，或留空沿用端點上限。`,
    );
}

/**
 * 影像組合只能綁「能整頁生成」的模型。
 *
 * local-inpaint 這類 `fullSlideGeneration:false` 的 provider 只做遮罩去字（extract-text）；
 * 綁成組合的影像模型後，一般「生成／重新生成圖片」會在 jobs 的 readiness gate 被
 * FULL_SLIDE_GENERATION_UNSUPPORTED 擋下——等於存了一個必然失敗的組合。寫入時就擋掉。
 *
 * 權威判斷來自 runtime 已建好的 provider capabilities；provider 不在 registry（懸空 ref、
 * 或 ref 指到非影像 entry）時，退回 `providerKind === "local"`（目前唯一的非生成影像 kind）。
 * imageModelRef 為空是允許的草稿狀態，完整性留到生成時檢查。
 */
function assertGenerativeImageModel(
  runtime: ModelRuntime,
  draft: ModelLibrary,
  imageModelRef: string | undefined,
): void {
  if (!imageModelRef) return;
  const entry = draft.models.find((item) => item.id === imageModelRef);
  if (!entry) return; // 懸空 ref 屬草稿；生成時才檢查完整性
  let generative: boolean;
  try {
    generative = runtime.imageProvider(entry.id).capabilities.fullSlideGeneration;
  } catch {
    generative = entry.providerKind !== "local";
  }
  if (!generative)
    throw new ModelLibraryError(
      "IMAGE_MODEL_NOT_GENERATIVE",
      `模型「${entry.name}」只能用於遮罩去字（抽離文字），不能設為組合的影像生成模型。`,
    );
}

/** 模型庫 CRUD：單一真實來源為 DATA_ROOT/models.json，寫入一律走 ctx.applyLibrary。 */
export function registerModelLibraryRoutes(app: Express, ctx: AppContext): void {
  const { runtime, applyLibrary } = ctx;

  // ── 模型庫 CRUD ────────────────────────────────────────────────────────────
  // 單一真實來源為 DATA_ROOT/models.json。每次變更 → applyLibrary（存檔＋原子重建
  // registry＋清 readiness 快取）→ 回傳 redact 後的完整模型庫。存檔寬鬆（允許草稿），
  // 完整性（例如組合缺能力模型）留到生成時檢查；此處僅擋參照完整性（刪除仍被引用的項目）。
  const mutateLibrary = async (mutate: (draft: ModelLibrary) => void): Promise<ModelLibrary> => {
    const draft = structuredClone(runtime.library);
    mutate(draft);
    draft.updatedAt = new Date().toISOString();
    const saved = await applyLibrary(draft);
    return redactLibrary(saved);
  };
  const connectionCreateSchema = modelConnectionSchema.omit({ id: true });
  const connectionPatchSchema = modelConnectionSchema
    .omit({ id: true })
    .partial()
    .extend({ timeoutMs: z.number().int().positive().nullable().optional() });
  const modelCreateSchema = modelEntrySchema.omit({ id: true });
  // imageProfile 的 `null` 語意同連線的 timeoutMs：明確清掉這個欄位。送 undefined 的話
  // key 會在 JSON 裡消失，PATCH 就變成「不動它」，使用者永遠清不掉設過的參數。
  const modelPatchSchema = modelEntrySchema
    .omit({ id: true })
    .partial()
    .extend({ imageProfile: imageModelProfileSchema.nullable().optional() });
  const combinationCreateSchema = modelCombinationSchema.omit({ id: true });
  const combinationPatchSchema = modelCombinationSchema.omit({ id: true }).partial();

  app.get("/api/model-library", (_request, response) =>
    response.json(redactLibrary(runtime.library)),
  );

  app.post("/api/model-library/connections", async (request, response) => {
    const input = connectionCreateSchema.parse(request.body);
    const id = randomUUID();
    const library = await mutateLibrary((draft) => {
      draft.connections.push(modelConnectionSchema.parse({ ...input, id }));
    });
    response.status(201).json(library);
  });

  app.patch("/api/model-library/connections/:id", async (request, response) => {
    const connectionId = idSchema.parse(request.params.id);
    const patch = connectionPatchSchema.parse(request.body);
    const library = await mutateLibrary((draft) => {
      const connection = draft.connections.find((item) => item.id === connectionId);
      if (!connection) throw new Error("Connection not found");
      // 空字串或 redact 佔位的 apiKey 代表「沿用舊 key」；僅在給定新明文時覆寫。
      const previousProtocol = connection.protocol;
      const { apiKey, timeoutMs, ...rest } = patch;
      Object.assign(connection, rest);
      if (apiKey !== undefined && apiKey !== "" && !isRedactedKey(apiKey))
        connection.apiKey = apiKey;
      if (timeoutMs === null) delete connection.timeoutMs;
      else if (timeoutMs !== undefined) connection.timeoutMs = timeoutMs;
      // 改協定會反向弄壞既有引用（entry 的 kind 不會跟著變），故只在協定真的改變時
      // 回頭檢查引用這條連線的 entry；改名／換 key 不受影響。
      if (connection.protocol !== previousProtocol)
        for (const entry of draft.models)
          if (entry.connectionRef === connectionId) assertConnectionProtocol(draft, entry);
    });
    response.json(library);
  });

  app.delete("/api/model-library/connections/:id", async (request, response) => {
    const connectionId = idSchema.parse(request.params.id);
    const library = await mutateLibrary((draft) => {
      const index = draft.connections.findIndex((item) => item.id === connectionId);
      if (index < 0) throw new Error("Connection not found");
      if (draft.models.some((entry) => entry.connectionRef === connectionId))
        throw new ModelLibraryError("CONNECTION_IN_USE", "仍有模型引用此連線，請先移除引用。");
      draft.connections.splice(index, 1);
    });
    response.json(library);
  });

  // 列出連線端點可用模型：供模型 entry 的「模型名」下拉選單。
  // 用 server 端存的明文 key，不外洩；探測失敗回安全錯誤碼。
  // 請求形狀依連線協定分流：OpenAI 是 `GET /models` 回 `{data:[{id}]}`，
  // Gemini 是 ListModels 回 `{models:[{name:"models/…"}]}`，兩者無法共用一條路徑。
  app.get("/api/model-library/connections/:id/models", async (request, response) => {
    const connectionId = idSchema.parse(request.params.id);
    const connection = runtime.library.connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error("Connection not found");
    if (!connection.baseUrl)
      throw new ModelLibraryError("CONNECTION_BASE_URL_MISSING", "此連線尚未設定 base URL。");
    const config = {
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      timeoutMs: connection.timeoutMs ?? runtime.system.modelTimeoutMs,
    };
    const models =
      connection.protocol === "gemini"
        ? await listGeminiModelIds(config)
        : await listModelIds(config);
    response.json({ models });
  });

  app.post("/api/model-library/models", async (request, response) => {
    const input = modelCreateSchema.parse(request.body);
    const id = randomUUID();
    const library = await mutateLibrary((draft) => {
      const entry = modelEntrySchema.parse({ ...input, id });
      assertConnectionProtocol(draft, entry);
      assertImageProfile(entry);
      draft.models.push(entry);
    });
    response.status(201).json(library);
  });

  app.patch("/api/model-library/models/:id", async (request, response) => {
    const modelId = idSchema.parse(request.params.id);
    const patch = modelPatchSchema.parse(request.body);
    const library = await mutateLibrary((draft) => {
      const entry = draft.models.find((item) => item.id === modelId);
      if (!entry) throw new Error("Model not found");
      const { imageProfile, ...rest } = patch;
      Object.assign(entry, rest);
      if (imageProfile === null) delete entry.imageProfile;
      else if (imageProfile !== undefined) entry.imageProfile = imageProfile;
      assertConnectionProtocol(draft, entry);
      assertImageProfile(entry);
    });
    response.json(library);
  });

  app.delete("/api/model-library/models/:id", async (request, response) => {
    const modelId = idSchema.parse(request.params.id);
    const library = await mutateLibrary((draft) => {
      const index = draft.models.findIndex((item) => item.id === modelId);
      if (index < 0) throw new Error("Model not found");
      if (
        draft.combinations.some(
          (combination) =>
            combination.imageModelRef === modelId ||
            combination.textModelRef === modelId ||
            combination.searchModelRef === modelId,
        )
      )
        throw new ModelLibraryError("MODEL_IN_USE", "仍有組合引用此模型，請先移除引用。");
      draft.models.splice(index, 1);
    });
    response.json(library);
  });

  app.post("/api/model-library/combinations", async (request, response) => {
    const input = combinationCreateSchema.parse(request.body);
    const id = randomUUID();
    const library = await mutateLibrary((draft) => {
      assertGenerativeImageModel(runtime, draft, input.imageModelRef);
      draft.combinations.push(modelCombinationSchema.parse({ ...input, id }));
      // 第一個組合自動設為預設，避免存了組合卻無預設可用。
      if (!draft.defaultCombinationId) draft.defaultCombinationId = id;
    });
    response.status(201).json(library);
  });

  app.patch("/api/model-library/combinations/:id", async (request, response) => {
    const combinationId = idSchema.parse(request.params.id);
    const patch = combinationPatchSchema.parse(request.body);
    const library = await mutateLibrary((draft) => {
      const combination = draft.combinations.find((item) => item.id === combinationId);
      if (!combination) throw new Error("Combination not found");
      Object.assign(combination, patch);
      assertGenerativeImageModel(runtime, draft, combination.imageModelRef);
    });
    response.json(library);
  });

  app.delete("/api/model-library/combinations/:id", async (request, response) => {
    const combinationId = idSchema.parse(request.params.id);
    const library = await mutateLibrary((draft) => {
      const index = draft.combinations.findIndex((item) => item.id === combinationId);
      if (index < 0) throw new Error("Combination not found");
      if (draft.defaultCombinationId === combinationId)
        throw new ModelLibraryError(
          "DEFAULT_COMBINATION_LOCKED",
          "此組合為預設組合，請先改設其他預設再刪除。",
        );
      draft.combinations.splice(index, 1);
    });
    response.json(library);
  });

  app.put("/api/model-library/default-combination", async (request, response) => {
    const { combinationId } = z.object({ combinationId: idSchema }).parse(request.body);
    const library = await mutateLibrary((draft) => {
      if (!draft.combinations.some((item) => item.id === combinationId))
        throw new Error("Combination not found");
      draft.defaultCombinationId = combinationId;
    });
    response.json(library);
  });

  app.patch("/api/model-library/system", async (request, response) => {
    const patch = modelLibrarySystemSchema.parse(request.body);
    const library = await mutateLibrary((draft) => {
      draft.system = modelLibrarySystemSchema.parse({ ...draft.system, ...patch });
    });
    response.json(library);
  });
}

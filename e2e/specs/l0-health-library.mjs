// L0：健康檢查、provider 列表、模型庫（連線／entry／組合）CRUD、預設組合切換、
// CONNECTION_PROTOCOL_MISMATCH 守門、系統設定 PATCH。全程零 API 呼叫。
import { assert, assertEq, assertHttpError, assertIncludes } from "../lib/assert.mjs";

export const name = "l0-health-library";
export const layer = "l0";
export const needsLive = false;

export default async function run({ client }) {
  // ── health ──────────────────────────────────────────────────────────────
  const health = (await client.get("/api/health")).body;
  assertEq(health, { ok: true, schemaVersion: 1 }, "/api/health payload");

  // ── providers（已註冊的影像 provider）──────────────────────────────────────
  const providers = (await client.get("/api/providers")).body;
  const providerIds = providers.map((p) => p.id);
  assertIncludes(providerIds, "mock-image", "providers 應含 mock-image");
  assertIncludes(providerIds, "local-inpaint", "providers 應含 local-inpaint");
  const mock = providers.find((p) => p.id === "mock-image");
  assert(mock.capabilities.fullSlideGeneration === true, "mock-image 應可整頁生成");

  // ── 模型庫初始狀態（seed）──────────────────────────────────────────────────
  let library = (await client.get("/api/model-library")).body;
  assertIncludes(
    library.models.map((m) => m.id),
    "mock-image",
    "庫應含 mock-image",
  );
  assertIncludes(
    library.models.map((m) => m.id),
    "local-inpaint",
    "庫應含 local-inpaint",
  );
  assertEq(library.defaultCombinationId, "e2e-mock", "預設組合應為 e2e-mock");

  // ── 連線 CRUD ──────────────────────────────────────────────────────────────
  // 帶一個非空 apiKey：redactLibrary 對非空 key 一律換成 REDACTED 佔位符（見
  // packages/core/src/model-library.ts），庫回應**絕不可**外洩明文。舊版本連線未帶 key，
  // redact 對空 key 恆回 ""，於是 REDACTED 分支從沒被測到（斷言恆真）。
  const plaintextKey = "sk-e2e-super-secret-DO-NOT-LEAK-123";
  library = (
    await client.post("/api/model-library/connections", {
      json: {
        name: "throwaway",
        baseUrl: "http://127.0.0.1:9/v1",
        protocol: "openai",
        apiKey: plaintextKey,
      },
    })
  ).body;
  const conn = library.connections.find((c) => c.name === "throwaway");
  assert(conn, "連線建立後應出現在庫中");
  // redact：設了 key 的連線，庫回應必須是遮罩佔位符，且不得含明文。
  assertEq(conn.apiKey, "••••••••", "非空 apiKey 應被遮罩成 REDACTED 佔位符");
  assert(!conn.apiKey.includes("secret"), "遮罩後的 apiKey 不得殘留任何明文片段");

  library = (
    await client.patch(`/api/model-library/connections/${conn.id}`, {
      json: { name: "renamed-conn" },
    })
  ).body;
  assertEq(library.connections.find((c) => c.id === conn.id).name, "renamed-conn", "連線改名");

  // ── 模型 entry CRUD（引用上面的連線）───────────────────────────────────────
  library = (
    await client.post("/api/model-library/models", {
      json: {
        name: "e2e-text-entry",
        capability: "text",
        providerKind: "openai",
        model: "some-model",
        connectionRef: conn.id,
      },
    })
  ).body;
  const entry = library.models.find((m) => m.name === "e2e-text-entry");
  assert(entry, "模型 entry 建立");

  library = (
    await client.patch(`/api/model-library/models/${entry.id}`, {
      json: { name: "e2e-text-entry-2" },
    })
  ).body;
  assertEq(library.models.find((m) => m.id === entry.id).name, "e2e-text-entry-2", "模型改名");

  // ── 組合 CRUD + 預設切換 ───────────────────────────────────────────────────
  library = (
    await client.post("/api/model-library/combinations", {
      json: { name: "e2e-alt", imageModelRef: "mock-image" },
    })
  ).body;
  const combo = library.combinations.find((c) => c.name === "e2e-alt");
  assert(combo, "組合建立");

  library = (
    await client.put("/api/model-library/default-combination", {
      json: { combinationId: combo.id },
    })
  ).body;
  assertEq(library.defaultCombinationId, combo.id, "預設組合切到 e2e-alt");
  // 切回原本，避免影響後面（本 spec 用獨立 dataRoot，但保持整潔）。
  library = (
    await client.put("/api/model-library/default-combination", {
      json: { combinationId: "e2e-mock" },
    })
  ).body;
  assertEq(library.defaultCombinationId, "e2e-mock", "預設組合切回 e2e-mock");

  library = (
    await client.patch(`/api/model-library/combinations/${combo.id}`, {
      json: { name: "e2e-alt-2" },
    })
  ).body;
  assertEq(library.combinations.find((c) => c.id === combo.id).name, "e2e-alt-2", "組合改名");
  library = (await client.delete(`/api/model-library/combinations/${combo.id}`)).body;
  assert(!library.combinations.some((c) => c.id === combo.id), "組合刪除");

  // 刪除模型（先確認沒有組合引用它）與連線（沒有 entry 引用時才可刪）。
  library = (await client.delete(`/api/model-library/models/${entry.id}`)).body;
  assert(!library.models.some((m) => m.id === entry.id), "模型刪除");

  // ── CONNECTION_PROTOCOL_MISMATCH ──────────────────────────────────────────
  // 建一條 gemini 協定連線，再建一個 openai providerKind 的 entry 指向它 → 應被拒。
  library = (
    await client.post("/api/model-library/connections", {
      json: { name: "gemini-conn", baseUrl: "https://example.invalid/v1beta", protocol: "gemini" },
    })
  ).body;
  const geminiConn = library.connections.find((c) => c.name === "gemini-conn");
  await assertHttpError(
    client.rawPost("/api/model-library/models", {
      json: {
        name: "mismatch-entry",
        capability: "image",
        providerKind: "openai",
        model: "gpt-image-2",
        connectionRef: geminiConn.id,
      },
    }),
    409,
    "CONNECTION_PROTOCOL_MISMATCH",
  );

  // 現在可安全刪掉沒有 entry 引用的 throwaway 連線。
  library = (await client.delete(`/api/model-library/connections/${conn.id}`)).body;
  assert(!library.connections.some((c) => c.id === conn.id), "連線刪除");

  // ── 系統設定 PATCH ────────────────────────────────────────────────────────
  library = (await client.patch("/api/model-library/system", { json: { codexMaxConcurrency: 2 } }))
    .body;
  assertEq(library.system.codexMaxConcurrency, 2, "系統 codexMaxConcurrency PATCH");
}

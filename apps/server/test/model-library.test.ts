import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationJob, ModelLibrary, PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

// 模型庫 CRUD、redaction、熱重建與「生成流程接專案組合」的端對端契約。
describe("model library CRUD and project composition", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let unavailable = false;

  beforeAll(async () => {
    const app = await createApp(await mkdtemp(join(tmpdir(), "slide-maker-model-library-")));
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
      baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    } catch (error) {
      if (["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
        unavailable = true;
      else throw error;
    }
  });
  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }
  const send = <T>(path: string, method: string, payload?: unknown): Promise<T> =>
    json<T>(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

  it("seeds a default library and redacts connection keys on read", async (context) => {
    if (unavailable) return context.skip();
    const library = await json<ModelLibrary>("/api/model-library");
    expect(library.defaultCombinationId).toBe("default");
    expect(library.models.some((entry) => entry.id === "mock-image")).toBe(true);
    expect(library.models.some((entry) => entry.id === "codex-text")).toBe(true);
    // 種子未帶 openai env，故無連線；redaction 契約仍須成立（有 key 回佔位、無回空）。
    for (const connection of library.connections)
      expect(connection.apiKey === "" || connection.apiKey === "••••••••").toBe(true);
  });

  it("manages connections, models, combinations, default and system through CRUD", async (context) => {
    if (unavailable) return context.skip();
    // 連線：建立時明文 key，讀取時 redact。
    let library = await send<ModelLibrary>("/api/model-library/connections", "POST", {
      name: "本機 OpenAI 相容",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "super-secret-key",
    });
    const connection = library.connections.at(-1)!;
    expect(connection.apiKey).toBe("••••••••");

    // PATCH 不帶 key → 沿用舊 key，仍 redact。
    library = await send<ModelLibrary>(`/api/model-library/connections/${connection.id}`, "PATCH", {
      name: "改名端點",
    });
    expect(library.connections.find((item) => item.id === connection.id)?.name).toBe("改名端點");
    expect(library.connections.find((item) => item.id === connection.id)?.apiKey).toBe("••••••••");

    // 模型 entry（openai text，引用連線）。
    library = await send<ModelLibrary>("/api/model-library/models", "POST", {
      name: "測試文字模型",
      capability: "text",
      providerKind: "openai",
      model: "gpt-test",
      connectionRef: connection.id,
    });
    const textModel = library.models.at(-1)!;
    expect(textModel.capability).toBe("text");

    // 組合：影像=mock、文字=新模型、搜尋=codex-search。
    library = await send<ModelLibrary>("/api/model-library/combinations", "POST", {
      name: "測試組合",
      imageModelRef: "mock-image",
      textModelRef: textModel.id,
      searchModelRef: "codex-search",
    });
    const combination = library.combinations.at(-1)!;

    // 設為預設。
    library = await send<ModelLibrary>("/api/model-library/default-combination", "PUT", {
      combinationId: combination.id,
    });
    expect(library.defaultCombinationId).toBe(combination.id);

    // 系統設定。
    library = await send<ModelLibrary>("/api/model-library/system", "PATCH", {
      codexMaxConcurrency: 2,
    });
    expect(library.system.codexMaxConcurrency).toBe(2);

    // 參照完整性：連線仍被模型引用時不可刪。
    await expect(send(`/api/model-library/connections/${connection.id}`, "DELETE")).rejects.toThrow(
      "CONNECTION_IN_USE",
    );
    // 模型仍被組合引用時不可刪。
    await expect(send(`/api/model-library/models/${textModel.id}`, "DELETE")).rejects.toThrow(
      "MODEL_IN_USE",
    );
    // 預設組合不可直接刪。
    await expect(
      send(`/api/model-library/combinations/${combination.id}`, "DELETE"),
    ).rejects.toThrow("DEFAULT_COMBINATION_LOCKED");
  });

  // local-inpaint 是 fullSlideGeneration:false 的遮罩去字工具，綁進組合的影像模型後
  // 一般生成會在 readiness gate 必然失敗；寫入時就以 IMAGE_MODEL_NOT_GENERATIVE 擋掉。
  it("refuses binding a non-generative image model (local-inpaint) as a combination image ref", async (context) => {
    if (unavailable) return context.skip();
    // create：直接把 local-inpaint 設為影像 ref → 拒絕。
    await expect(
      send("/api/model-library/combinations", "POST", {
        name: "非法組合",
        imageModelRef: "local-inpaint",
      }),
    ).rejects.toThrow("IMAGE_MODEL_NOT_GENERATIVE");

    // patch：先建合法組合（mock-image），再改成 local-inpaint → 拒絕。
    const library = await send<ModelLibrary>("/api/model-library/combinations", "POST", {
      name: "先合法後改壞",
      imageModelRef: "mock-image",
    });
    const combination = library.combinations.at(-1)!;
    await expect(
      send(`/api/model-library/combinations/${combination.id}`, "PATCH", {
        imageModelRef: "local-inpaint",
      }),
    ).rejects.toThrow("IMAGE_MODEL_NOT_GENERATIVE");
  });

  it("defaults new connections to the openai protocol", async (context) => {
    if (unavailable) return context.skip();
    const library = await send<ModelLibrary>("/api/model-library/connections", "POST", {
      name: "未指定協定",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "k",
    });
    expect(library.connections.at(-1)!.protocol).toBe("openai");
  });

  /*
   * providerKind 與連線 protocol 是兩個各自獨立的欄位，湊錯了只會在執行期得到難懂的
   * `GEMINI_REQUEST_FAILED HTTP 404`（請求形狀根本不同），所以寫入時就要擋。
   */
  it("refuses a model entry whose providerKind contradicts the connection protocol", async (context) => {
    if (unavailable) return context.skip();
    let library = await send<ModelLibrary>("/api/model-library/connections", "POST", {
      name: "協定檢查用 OpenAI 端點",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "k",
      protocol: "openai",
    });
    const openaiConnection = library.connections.at(-1)!;
    library = await send<ModelLibrary>("/api/model-library/connections", "POST", {
      name: "協定檢查用 Gemini 端點",
      baseUrl: "http://127.0.0.1:9/v1beta",
      apiKey: "k",
      protocol: "gemini",
    });
    const geminiConnection = library.connections.at(-1)!;

    // 建立：gemini entry 指向 openai 連線（反向亦然）。
    await expect(
      send("/api/model-library/models", "POST", {
        name: "錯配 Gemini",
        capability: "text",
        providerKind: "gemini",
        model: "gemini-3.6-flash",
        connectionRef: openaiConnection.id,
      }),
    ).rejects.toThrow("CONNECTION_PROTOCOL_MISMATCH");
    await expect(
      send("/api/model-library/models", "POST", {
        name: "錯配 OpenAI",
        capability: "text",
        providerKind: "openai",
        model: "gpt-test",
        connectionRef: geminiConnection.id,
      }),
    ).rejects.toThrow("CONNECTION_PROTOCOL_MISMATCH");

    // PATCH：把合法 entry 改指到另一種協定的連線同樣要擋，且不得留下副作用。
    library = await send<ModelLibrary>("/api/model-library/models", "POST", {
      name: "正確 Gemini",
      capability: "text",
      providerKind: "gemini",
      model: "gemini-3.6-flash",
      connectionRef: geminiConnection.id,
    });
    const entry = library.models.at(-1)!;
    await expect(
      send(`/api/model-library/models/${entry.id}`, "PATCH", {
        connectionRef: openaiConnection.id,
      }),
    ).rejects.toThrow("CONNECTION_PROTOCOL_MISMATCH");
    // 連線改協定會反向弄壞既有引用（entry 的 kind 不會跟著變），一樣擋下。
    await expect(
      send(`/api/model-library/connections/${geminiConnection.id}`, "PATCH", {
        protocol: "openai",
      }),
    ).rejects.toThrow("CONNECTION_PROTOCOL_MISMATCH");

    const after = await json<ModelLibrary>("/api/model-library");
    expect(after.models.find((item) => item.id === entry.id)?.connectionRef).toBe(
      geminiConnection.id,
    );
    expect(after.connections.find((item) => item.id === geminiConnection.id)?.protocol).toBe(
      "gemini",
    );
    // 改名／換 key 不牽涉協定，不該被誤擋。
    await expect(
      send(`/api/model-library/connections/${geminiConnection.id}`, "PATCH", { name: "改個名字" }),
    ).resolves.toBeTruthy();

    // 這個 describe 共用同一個 server／資料目錄，殘留的 entry 會干擾後續計數。
    await send(`/api/model-library/models/${entry.id}`, "DELETE");
    await send(`/api/model-library/connections/${geminiConnection.id}`, "DELETE");
    await send(`/api/model-library/connections/${openaiConnection.id}`, "DELETE");
  });

  it("builds gemini providers into the registry for all three capabilities", async (context) => {
    if (unavailable) return context.skip();
    let library = await send<ModelLibrary>("/api/model-library/connections", "POST", {
      name: "AI Studio",
      baseUrl: "http://127.0.0.1:9/v1beta",
      apiKey: "gemini-key",
      protocol: "gemini",
    });
    const connection = library.connections.at(-1)!;
    expect(connection.protocol).toBe("gemini");

    for (const [capability, model] of [
      ["image", "gemini-3.1-flash-image"],
      ["text", "gemini-3.6-flash"],
      ["search", "gemini-3.6-flash"],
    ] as const) {
      library = await send<ModelLibrary>("/api/model-library/models", "POST", {
        name: `Gemini ${capability}`,
        capability,
        providerKind: "gemini",
        model,
        connectionRef: connection.id,
      });
    }
    const geminiEntries = library.models.filter((entry) => entry.providerKind === "gemini");
    expect(geminiEntries).toHaveLength(3);

    // registry 真的被重建：影像 entry 以 Gemini provider 註冊，文字 entry 可解析出 availability。
    const imageEntry = geminiEntries.find((entry) => entry.capability === "image")!;
    const providers = await json<{ id: string; name: string }[]>("/api/providers");
    expect(providers.find((provider) => provider.id === imageEntry.id)?.name).toBe(
      "Gemini 原生影像",
    );
    const textEntry = geminiEntries.find((entry) => entry.capability === "text")!;
    const textProviders =
      await json<{ id: string; availability: { status: string } }[]>("/api/text-providers");
    expect(
      textProviders.find((provider) => provider.id === textEntry.id)?.availability.status,
    ).toBe("available");
  });

  it("drives image generation from the project combination when no providerId is sent", async (context) => {
    if (unavailable) return context.skip();
    // 先把預設組合切回種子 default（影像=mock-image）確保可生成。
    await send("/api/model-library/default-combination", "PUT", { combinationId: "default" });
    const project = await send<PresentationProject>("/api/projects", "POST", {
      topic: "組合驅動生成",
      brief: { desiredSlideCount: 1 },
    });
    // 不帶 providerId：由專案組合（lazy 綁定預設）解析影像模型。
    const jobs = await send<GenerationJob[]>(`/api/projects/${project.id}/generate`, "POST", {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.providerId).toBe("mock-image");
    // lazy 綁定應寫回專案 combinationId。
    const bound = await json<PresentationProject>(`/api/projects/${project.id}`);
    expect(bound.combinationId).toBe("default");
  });
});

// 連線協定：舊 models.json 相容，以及「列出可用模型」依協定分流到不同端點形狀。
describe("connection protocol", () => {
  let server: Server | undefined;
  let endpoint: Server | undefined;
  let baseUrl = "";
  let endpointPort = 0;
  let endpointPaths: string[] = [];
  let unavailable = false;

  beforeAll(async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "slide-maker-protocol-"));
    // 加 protocol 欄位之前存下的 models.json：連線沒有該欄位，載入時必須套用預設值。
    await writeFile(
      join(dataRoot, "models.json"),
      JSON.stringify({
        schemaVersion: 1,
        connections: [
          { id: "legacy", name: "舊連線", baseUrl: "", apiKey: "legacy-key" },
          { id: "legacy-openai", name: "舊 OpenAI 端點", baseUrl: "", apiKey: "k" },
        ],
        models: [
          {
            id: "mock-image",
            name: "Mock",
            capability: "image",
            providerKind: "mock",
            model: "mock",
          },
        ],
        combinations: [{ id: "default", name: "預設組合", imageModelRef: "mock-image" }],
        defaultCombinationId: "default",
        system: {},
        updatedAt: new Date().toISOString(),
      }),
    );

    // 同一個 fake 端點同時提供兩種協定的模型列表回應，用路徑分辨走了哪一條。
    endpoint = createServer((request, response) => {
      endpointPaths.push(request.url ?? "");
      const gemini = (request.url ?? "").startsWith("/v1beta/models");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          gemini
            ? {
                models: [
                  {
                    name: "models/gemini-3.6-flash",
                    supportedGenerationMethods: ["generateContent"],
                  },
                  { name: "models/imagen-4.0", supportedGenerationMethods: ["predict"] },
                ],
              }
            : { data: [{ id: "gpt-image-2" }] },
        ),
      );
    });

    const app = await createApp(dataRoot);
    try {
      await new Promise<void>((resolve, reject) => {
        endpoint!.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
      endpointPort = (endpoint.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
      baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    } catch (error) {
      if (["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
        unavailable = true;
      else throw error;
    }
  });
  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (endpoint?.listening) {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint!.close(() => resolve()));
    }
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }
  const send = <T>(path: string, method: string, payload?: unknown): Promise<T> =>
    json<T>(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

  it("loads a pre-protocol models.json and backfills the openai default", async (context) => {
    if (unavailable) return context.skip();
    const library = await json<ModelLibrary>("/api/model-library");
    expect(library.connections.map((connection) => connection.protocol)).toEqual([
      "openai",
      "openai",
    ]);
  });

  it("routes the model listing to ListModels or GET /models per connection protocol", async (context) => {
    if (unavailable) return context.skip();
    endpointPaths = [];
    let library = await send<ModelLibrary>(`/api/model-library/connections/legacy`, "PATCH", {
      baseUrl: `http://127.0.0.1:${endpointPort}/v1beta`,
      protocol: "gemini",
    });
    expect(library.connections.find((item) => item.id === "legacy")?.protocol).toBe("gemini");
    const gemini = await json<{ models: string[] }>("/api/model-library/connections/legacy/models");
    // Imagen 只有 predict，不該進下拉選單；id 需剝掉 models/ 前綴。
    expect(gemini.models).toEqual(["gemini-3.6-flash"]);

    library = await send<ModelLibrary>(`/api/model-library/connections/legacy-openai`, "PATCH", {
      baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
    });
    const openai = await json<{ models: string[] }>(
      "/api/model-library/connections/legacy-openai/models",
    );
    expect(openai.models).toEqual(["gpt-image-2"]);
    expect(endpointPaths).toEqual(["/v1beta/models?pageSize=200", "/v1/models"]);
  });
});

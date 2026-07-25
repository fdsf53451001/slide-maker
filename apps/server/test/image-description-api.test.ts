import { mkdtemp } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PresentationProject, SourceAsset } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { FileProjectRepository } from "../src/repository.js";
import { IMAGE_DESCRIPTION_NOTICE } from "../src/image-description.js";

/**
 * 上傳圖片來源 → 背景產生可檢索描述的端對端行為。
 *
 * 用假的 OpenAI-compatible 端點驅動，才控制得住「模型回了什麼、什麼時候回」——這裡要驗的
 * 併發上限與失敗降級，正是只有在能操縱模型時序時才驗得到的東西。絕不呼叫真實模型。
 */
describe("圖片來源的背景內容描述", () => {
  let appServer: Server | undefined;
  let fake: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";
  let unavailable = false;
  const savedEnv: Record<string, string | undefined> = {};

  /** 模型這一輪的行為。 */
  let mode: "ok" | "fail" = "ok";
  /** 收到幾次圖片描述請求。 */
  let describeCalls = 0;
  /** 描述請求的同時在途數與其峰值。 */
  let inflight = 0;
  let peakInflight = 0;
  /** 擋住模型回覆用的閘門（預設不擋）。 */
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;
  /** 最後一次描述 prompt，用來確認送出的是抽取指令。 */
  let lastPrompt = "";

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  const flatten = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part: unknown) =>
          typeof part === "object" && part && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join("\n");
    return "";
  };

  beforeAll(async () => {
    fake = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (part: Buffer) => chunks.push(part));
      request.on("end", () => {
        void (async () => {
          if ((request.url ?? "").endsWith("/models")) {
            response.writeHead(200, { "content-type": "application/json" });
            return response.end(JSON.stringify({ data: [] }));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            messages?: Array<{ content?: unknown }>;
            response_format?: {
              json_schema?: { schema?: { properties?: Record<string, unknown> } };
            };
          };
          const properties = body.response_format?.json_schema?.schema?.properties ?? {};
          const isDescription = "fullText" in properties && "summary" in properties;
          if (!isDescription) {
            response.writeHead(200, { "content-type": "application/json" });
            return response.end(
              JSON.stringify({ choices: [{ message: { content: JSON.stringify({}) } }] }),
            );
          }
          describeCalls += 1;
          inflight += 1;
          peakInflight = Math.max(peakInflight, inflight);
          lastPrompt = (body.messages ?? []).map((message) => flatten(message.content)).join("\n");
          if (gate) await gate;
          inflight -= 1;
          if (mode === "fail") {
            response.writeHead(500, { "content-type": "application/json" });
            return response.end(JSON.stringify({ error: "boom" }));
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      title: "2025 電池成本圖",
                      summary: "長條圖，比較磷酸鐵鋰與三元電池的每度成本。",
                      fullText:
                        "Y 軸：每度成本（美元）。磷酸鐵鋰 2025 年為 56 美元，三元電池為 71 美元。資料來源：產業年報。",
                    }),
                  },
                },
              ],
            }),
          );
        })();
      });
    });
    await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", resolve));

    setEnv(
      "SLIDE_MAKER_OPENAI_BASE_URL",
      `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
    );
    setEnv("SLIDE_MAKER_OPENAI_API_KEY", "test-key");
    setEnv("SLIDE_MAKER_OPENAI_TEXT_MODEL", "gpt-5-vision");
    setEnv("SLIDE_MAKER_TEXT_ENGINE", "openai");

    dataRoot = join(await mkdtemp(join(tmpdir(), "slide-maker-image-desc-")), ".slide-maker-data");
    const app = await createApp(dataRoot);
    try {
      await new Promise<void>((resolve, reject) => {
        appServer = app.listen(0, "127.0.0.1", (error?: Error) =>
          error ? reject(error) : resolve(),
        );
      });
      baseUrl = `http://127.0.0.1:${(appServer!.address() as AddressInfo).port}`;
    } catch (error) {
      if (["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
        unavailable = true;
      else throw error;
    }
  });

  afterAll(async () => {
    if (appServer?.listening)
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    if (fake?.listening) await new Promise<void>((resolve) => fake!.close(() => resolve()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    mode = "ok";
    describeCalls = 0;
    peakInflight = 0;
    gate = undefined;
    openGate = undefined;
    lastPrompt = "";
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }

  async function newProject(topic: string): Promise<PresentationProject> {
    return json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, brief: { desiredSlideCount: 1 } }),
    });
  }

  async function png(width = 640, height = 360): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } },
    })
      .png()
      .toBuffer();
  }

  /** 上傳一張圖並回傳 201 當下的那一筆來源（尚未經過任何背景寫入）。 */
  async function uploadImage(
    projectId: string,
    name: string,
    usage: SourceAsset["usage"],
    allowModelAccess = true,
  ): Promise<SourceAsset> {
    const query = new URLSearchParams({
      name,
      mediaType: "image/png",
      usage,
      allowModelAccess: String(allowModelAccess),
    });
    const bytes = await png();
    const project = await json<PresentationProject>(
      `/api/projects/${projectId}/sources?${query.toString()}`,
      { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(bytes) },
    );
    const created = project.sources.find((source) => source.name === name);
    if (!created) throw new Error(`來源未建立：${name}`);
    return created;
  }

  /** 等到某筆來源離開 parsing（或逾時）。 */
  async function settled(projectId: string, sourceId: string): Promise<SourceAsset> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const sources = await json<SourceAsset[]>(`/api/projects/${projectId}/sources`);
      const source = sources.find((item) => item.id === sourceId);
      if (source && source.status !== "parsing") return source;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("來源一直停在 parsing");
  }

  it("視覺參考圖：上傳當下就回 201＋parsing，描述完成後寫回可檢索的全文", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("電池成本");
    const uploaded = await uploadImage(project.id, "cost.png", "visual-reference");
    // 上傳端點不等描述：回應當下還沒有任何抽取結果。
    expect(uploaded.status).toBe("parsing");
    expect(uploaded.extractedText).toBe("");

    const described = await settled(project.id, uploaded.id);
    expect(described.status).toBe("indexed");
    // 模型衍生物必須自己說清楚身分：extractedText 開頭是聲明，不是原文。
    expect(described.extractedText.startsWith(IMAGE_DESCRIPTION_NOTICE)).toBe(true);
    expect(described.extractedText).toContain("磷酸鐵鋰 2025 年為 56 美元");
    expect(described.chunks.length).toBeGreaterThan(0);
    expect(described.metadata.imageDescriptionModel).toBe("gpt-5-vision");
    expect(described.metadata.imageDescribedAt).toBeTruthy();
    // 送出的是抽取指令，且圖真的附上去了。
    expect(lastPrompt).toContain("Extract, do not caption");

    // 斷鏈的起點：圖片有了 chunk 才進得了 FTS，也才可能被大綱 prompt 撈到。
    const hits = await json<Array<{ sourceId: string; text: string }>>(
      `/api/projects/${project.id}/search?q=${encodeURIComponent("磷酸鐵鋰")}`,
    );
    expect(hits.some((hit) => hit.sourceId === uploaded.id)).toBe(true);
  });

  it("其他用途的圖片一律不跑描述：沒有下游消費者，跑了就是浪費配額", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("其他用途");
    for (const usage of ["style-reference", "direct-asset", "exclude-from-generation"] as const) {
      const uploaded = await uploadImage(project.id, `${usage}.png`, usage);
      expect(uploaded.status).toBe("indexed");
      expect(uploaded.extractedText).toBe("");
    }
    // 給背景佇列足夠的時間表現出錯誤行為（如果有的話）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(describeCalls).toBe(0);
  });

  it("模型失敗時來源維持 indexed＋空全文，上傳本身完全不受影響", async (context) => {
    if (unavailable) return context.skip();
    mode = "fail";
    const project = await newProject("模型故障");
    const uploaded = await uploadImage(project.id, "broken.png", "visual-reference");
    expect(uploaded.status).toBe("parsing");

    const released = await settled(project.id, uploaded.id);
    // 描述是加值步驟：失敗後這筆來源與加入這個功能之前一模一樣，仍可當視覺參考使用。
    expect(released.status).toBe("indexed");
    expect(released.extractedText).toBe("");
    expect(released.chunks).toEqual([]);
    expect(released.metadata.imageDescriptionModel).toBe(undefined);
    expect(describeCalls).toBe(1);
  });

  it("改用途成視覺參考時補跑描述，但只在前端明講會消耗配額並取得同意之後", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("改用途補描述");
    // 一開始是「直接素材」：不跑描述，也不該標 parsing。
    const uploaded = await uploadImage(project.id, "asset.png", "direct-asset");
    expect(uploaded.status).toBe("indexed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(describeCalls).toBe(0);

    // 只改用途、沒有帶同意旗標：行為與加入這條路之前一樣，一個模型請求都不發。
    const switched = await json<PresentationProject>(
      `/api/projects/${project.id}/sources/${uploaded.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usage: "visual-reference" }),
      },
    );
    expect(switched.sources[0]?.status).toBe("indexed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(describeCalls).toBe(0);

    // 使用者在前端的 confirm 按了「確定」才會帶 describeImage。
    const requested = await json<PresentationProject>(
      `/api/projects/${project.id}/sources/${uploaded.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usage: "visual-reference", describeImage: true }),
      },
    );
    expect(requested.sources[0]?.status).toBe("parsing");
    const described = await settled(project.id, uploaded.id);
    expect(described.extractedText).toContain("磷酸鐵鋰 2025 年為 56 美元");
    expect(describeCalls).toBe(1);

    // 冪等：已經有描述的來源再要求一次也不會重複燒配額。
    await json<PresentationProject>(`/api/projects/${project.id}/sources/${uploaded.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usage: "visual-reference", describeImage: true }),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(describeCalls).toBe(1);
  });

  it("已經在分析中的來源不得被排第二次，同一張圖不會跑兩遍", async (context) => {
    if (unavailable) return context.skip();
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const project = await newProject("重複排隊");
    const uploaded = await uploadImage(project.id, "twice.png", "visual-reference");
    expect(uploaded.status).toBe("parsing");
    for (let attempt = 0; attempt < 100 && describeCalls < 1; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));

    // 描述還在途中就把用途改走再改回來——`extractedText` 這時仍是空的，只靠它擋不住。
    for (const usage of ["direct-asset", "visual-reference"] as const)
      await json<PresentationProject>(`/api/projects/${project.id}/sources/${uploaded.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usage, describeImage: true }),
      });
    openGate?.();
    gate = undefined;

    const described = await settled(project.id, uploaded.id);
    expect(described.extractedText).toContain("磷酸鐵鋰");
    // 兩次就是兩份配額，而且第二份的結果會覆蓋第一份，使用者完全看不出來發生過。
    expect(describeCalls).toBe(1);
  });

  it("失敗原因寫進 metadata：使用者才分得出「跑過但失敗」與「從來沒跑過」", async (context) => {
    if (unavailable) return context.skip();
    mode = "fail";
    const project = await newProject("失敗原因");
    const uploaded = await uploadImage(project.id, "broken.png", "visual-reference");
    const released = await settled(project.id, uploaded.id);
    expect(released.status).toBe("indexed");
    // 假端點回 500 → 非 4xx、非逾時、非空回應，落在最後的 failed。
    expect(released.metadata.imageDescriptionFailure).toBe("failed");

    // 重試成功後這個標記要消失，否則畫面會永遠掛著一條已經不成立的警告。
    mode = "ok";
    await json<PresentationProject>(`/api/projects/${project.id}/sources/${uploaded.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usage: "visual-reference", describeImage: true }),
    });
    const described = await settled(project.id, uploaded.id);
    expect(described.extractedText).toContain("磷酸鐵鋰");
    expect(described.metadata.imageDescriptionFailure).toBe(undefined);
  });

  it("上傳時就能退出：allowModelAccess=false 一個請求都不發，也不標 parsing", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("上傳時退出");
    const uploaded = await uploadImage(project.id, "private.png", "visual-reference", false);
    expect(uploaded.allowModelAccess).toBe(false);
    expect(uploaded.status).toBe("indexed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(describeCalls).toBe(0);
  });

  it("allowModelAccess 只認 true/false，其他寫法一律擋下而不是默默當成 true", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("布林解析");
    const bytes = await png();
    for (const value of ["0", "no", ""]) {
      const query = new URLSearchParams({
        name: `coerce-${value || "empty"}.png`,
        mediaType: "image/png",
        usage: "visual-reference",
        allowModelAccess: value,
      });
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/sources?${query}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(bytes),
      });
      // 舊的 z.coerce.boolean() 會把這些全部變成 true（Boolean("0") === true），
      // 授權閘門於是永遠關不起來。寧可讓呼叫端修正寫法，也不能猜錯方向。
      expect(response.status).toBe(400);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(describeCalls).toBe(0);
  });

  it("重啟後把卡在 parsing 的來源放回 indexed，不讓前端永遠轉圈", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject("重啟修復");
    const uploaded = await uploadImage(project.id, "stalled.png", "visual-reference");
    await settled(project.id, uploaded.id);
    // 模擬「描述途中程序被砍」：背景工作沒有持久化，重啟後沒有人會接手這個狀態。
    const repository = new FileProjectRepository(dataRoot);
    await repository.updateProject(project.id, (current) => {
      current.sources[0]!.status = "parsing";
    });
    await createApp(dataRoot);
    const repaired = await repository.loadProject(project.id);
    expect(repaired?.sources[0]?.status).toBe("indexed");
  });

  it("併發上限 2：一次上傳多張圖不會同時打出多個 vision 請求", async (context) => {
    if (unavailable) return context.skip();
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const project = await newProject("併發上限");
    const uploaded = await Promise.all(
      [1, 2, 3, 4, 5].map((index) =>
        uploadImage(project.id, `batch-${index}.png`, "visual-reference"),
      ),
    );
    // 前端是 Promise.allSettled 並行上傳，五張圖的 201 全部回來了，模型端卻只該有兩個在途。
    for (const source of uploaded) expect(source.status).toBe("parsing");
    for (let attempt = 0; attempt < 100 && describeCalls < 2; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    // 多等一下，讓「上限沒生效」有機會露出第三個請求。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(peakInflight).toBe(2);
    expect(describeCalls).toBe(2);

    openGate?.();
    gate = undefined;
    const settledSources = await Promise.all(
      uploaded.map((source) => settled(project.id, source.id)),
    );
    // 排隊的三張最後也要跑完，不能被上限吃掉。
    expect(describeCalls).toBe(5);
    for (const source of settledSources) {
      expect(source.status).toBe("indexed");
      expect(source.chunks.length).toBeGreaterThan(0);
    }
  });

  it("排隊期間取消 AI 使用：輪到它時不得送出，授權以送出當下的狀態為準", async (context) => {
    if (unavailable) return context.skip();
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const project = await newProject("排隊中取消授權");
    // 逐張上傳而不是 Promise.all：排隊順序＝排入佇列的順序，而並行上傳的完成順序是隨機的，
    // 「第三張才是排隊中的那一張」就不成立（實測會隨機挑到已經在途的那張，測到的東西完全
    // 不是要測的情境）。201 本來就不等模型，逐張送一樣快。
    const uploaded: SourceAsset[] = [];
    for (const index of [1, 2, 3])
      uploaded.push(await uploadImage(project.id, `queued-${index}.png`, "visual-reference"));
    // 前兩張佔住名額，第三張在排隊——這正是使用者「拖了幾張圖後反悔」的時序。
    for (let attempt = 0; attempt < 100 && describeCalls < 2; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    // 靜候一段時間確認第三張真的還在**排隊**（而不是已經出門）：不然下面驗的就不是
    // 「排隊期間取消」，而是碰運氣的時序。
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(describeCalls).toBe(2);

    const last = uploaded[2]!;
    await json<PresentationProject>(`/api/projects/${project.id}/sources/${last.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowModelAccess: false }),
    });
    openGate?.();
    gate = undefined;

    const settledSources = await Promise.all(
      uploaded.map((source) => settled(project.id, source.id)),
    );
    // 排隊那張一個請求都不該發：沿用排隊當時的判斷等於把圖片照樣送出去。
    expect(describeCalls).toBe(2);
    const revoked = settledSources[2]!;
    expect(revoked.allowModelAccess).toBe(false);
    expect(revoked.status).toBe("indexed");
    expect(revoked.extractedText).toBe("");
    // 前兩張不受影響。
    expect(settledSources[0]!.extractedText).toContain("磷酸鐵鋰");
    expect(settledSources[1]!.extractedText).toContain("磷酸鐵鋰");
  });

  describe("SLIDE_MAKER_IMAGE_DESCRIPTION=off", () => {
    let offServer: Server | undefined;
    let offBaseUrl = "";
    const savedMode = process.env.SLIDE_MAKER_IMAGE_DESCRIPTION;

    beforeAll(async () => {
      if (unavailable) return;
      process.env.SLIDE_MAKER_IMAGE_DESCRIPTION = "off";
      const app = await createApp(
        join(await mkdtemp(join(tmpdir(), "slide-maker-image-desc-off-")), ".slide-maker-data"),
      );
      await new Promise<void>((resolve, reject) => {
        offServer = app.listen(0, "127.0.0.1", (error?: Error) =>
          error ? reject(error) : resolve(),
        );
      });
      offBaseUrl = `http://127.0.0.1:${(offServer!.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      if (offServer?.listening)
        await new Promise<void>((resolve) => offServer!.close(() => resolve()));
      if (savedMode === undefined) delete process.env.SLIDE_MAKER_IMAGE_DESCRIPTION;
      else process.env.SLIDE_MAKER_IMAGE_DESCRIPTION = savedMode;
    });

    it("整條路完全不存在：不標 parsing、不排工作、一個模型請求都不發", async (context) => {
      if (unavailable) return context.skip();
      const created = await fetch(`${offBaseUrl}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "關閉描述", brief: { desiredSlideCount: 1 } }),
      });
      const project = (await created.json()) as PresentationProject;
      const query = new URLSearchParams({
        name: "off.png",
        mediaType: "image/png",
        usage: "visual-reference",
        allowModelAccess: "true",
      });
      const response = await fetch(`${offBaseUrl}/api/projects/${project.id}/sources?${query}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(await png()),
      });
      const updated = (await response.json()) as PresentationProject;
      const source = updated.sources[0]!;
      // 行為必須與加入這個功能之前一模一樣：連 parsing 都不標，前端不會閃一下「分析中」。
      expect(source.status).toBe("indexed");
      expect(source.extractedText).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(describeCalls).toBe(0);
    });
  });
});

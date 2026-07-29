import { mkdtemp } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PresentationProject, SourceAsset } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { FileProjectRepository } from "../src/repository.js";
import { SqliteFtsRetriever } from "../src/retriever.js";
import { knownSourceContext } from "../src/source-context.js";
import { IMAGE_DESCRIPTION_NOTICE } from "../src/image-description.js";

/**
 * 圖片描述**寫回**這一段的併發與降級行為。
 *
 * 描述是在背景跑的：從「使用者按下上傳」到「描述落地」中間有十幾秒，那段時間裡使用者可以
 * 刪掉這筆來源、再上傳別的、改 usage 或取消模型存取權。背景那條路只要有一步沒守住，就會
 * 出現「刪掉的來源又活過來」「剛上傳的來源被舊快照蓋掉」「勾了不給模型看卻仍進了 prompt」
 * 這類沒有人會回報、卻默默污染資料的問題。
 *
 * 另一半是模型端的畸形輸出：非嚴格 gateway 少欄位、包 ```json 圍欄、回散文、乾脆不回。
 * 全部都必須降級成「這張圖沒有描述」而不是卡在 parsing。
 *
 * 全程用假的 OpenAI-compatible 端點，絕不呼叫真實模型。
 */

type Mode = "ok" | "fenced-partial" | "empty" | "garbage" | "hang";

const FULL_TEXT =
  "Y 軸：每度成本（美元）。磷酸鐵鋰 2025 年為 56 美元，三元電池為 71 美元。資料來源：產業年報。";

describe("圖片描述寫回與併發、降級", () => {
  let appServer: Server | undefined;
  let fake: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";
  let unavailable = false;
  const savedEnv: Record<string, string | undefined> = {};

  let mode: Mode = "ok";
  let describeCalls = 0;
  /** 擋住模型回覆的閘門與「請求已經到了」的通知。 */
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;
  let arrived: Promise<void> = Promise.resolve();
  let markArrived: (() => void) | undefined;
  /** hang 模式下掛住的回應，測試結束時要放掉，否則 server.close() 收不掉。 */
  const hung: ServerResponse[] = [];

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  function describePayload(): string {
    if (mode === "empty") return JSON.stringify({ title: "", summary: " ", fullText: "\n" });
    if (mode === "garbage") return "抱歉，我沒辦法讀這張圖片。";
    if (mode === "fenced-partial")
      // 非嚴格 gateway 的典型回應：包了 ```json 圍欄，而且只給了 schema 的一部分欄位。
      return ["```json", JSON.stringify({ fullText: FULL_TEXT }), "```"].join("\n");
    return JSON.stringify({
      title: "2025 電池成本圖",
      summary: "長條圖，比較磷酸鐵鋰與三元電池的每度成本。",
      fullText: FULL_TEXT,
    });
  }

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
            response_format?: {
              json_schema?: { schema?: { properties?: Record<string, unknown> } };
            };
          };
          const properties = body.response_format?.json_schema?.schema?.properties ?? {};
          if (!("fullText" in properties && "summary" in properties)) {
            response.writeHead(200, { "content-type": "application/json" });
            return response.end(
              JSON.stringify({ choices: [{ message: { content: JSON.stringify({}) } }] }),
            );
          }
          describeCalls += 1;
          markArrived?.();
          if (mode === "hang") {
            hung.push(response);
            return;
          }
          if (gate) await gate;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ choices: [{ message: { content: describePayload() } }] }));
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
    // 逾時案例要在測試時限內跑完；5 秒是 config 允許的下限。
    setEnv("SLIDE_MAKER_OPENAI_TIMEOUT_MS", "5000");

    dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-image-desc-races-")),
      ".slide-maker-data",
    );
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
    for (const response of hung.splice(0)) response.destroy();
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
    gate = undefined;
    openGate = undefined;
    arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
  });

  afterEach(() => {
    openGate?.();
    for (const response of hung.splice(0)) response.destroy();
  });

  /** 開閘門：呼叫後模型才會回覆。 */
  function holdModel(): void {
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
  }

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
      body: JSON.stringify({
        topic,
        brief: { desiredSlideCount: 1, webSearchMode: "disabled" },
      }),
    });
  }

  async function upload(
    projectId: string,
    options: {
      name: string;
      mediaType: string;
      usage: SourceAsset["usage"];
      allowModelAccess?: boolean;
      bytes: BodyInit;
    },
  ): Promise<SourceAsset> {
    const query = new URLSearchParams({
      name: options.name,
      mediaType: options.mediaType,
      usage: options.usage,
      allowModelAccess: String(options.allowModelAccess ?? true),
    });
    const project = await json<PresentationProject>(
      `/api/projects/${projectId}/sources?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": options.mediaType },
        body: options.bytes,
      },
    );
    const created = project.sources.find((source) => source.name === options.name);
    if (!created) throw new Error(`來源未建立：${options.name}`);
    return created;
  }

  async function pngBytes(): Promise<BodyInit> {
    return new Uint8Array(
      await sharp({ create: { width: 640, height: 360, channels: 3, background: "#0c2238" } })
        .png()
        .toBuffer(),
    );
  }

  const uploadImage = async (
    projectId: string,
    name: string,
    allowModelAccess = true,
  ): Promise<SourceAsset> =>
    upload(projectId, {
      name,
      mediaType: "image/png",
      usage: "visual-reference",
      allowModelAccess,
      bytes: await pngBytes(),
    });

  async function sources(projectId: string): Promise<SourceAsset[]> {
    return json<SourceAsset[]>(`/api/projects/${projectId}/sources`);
  }

  /** 等到某筆來源離開 parsing（或消失）。回 undefined 代表來源已經不在了。 */
  async function settled(
    projectId: string,
    sourceId: string,
    attempts = 400,
  ): Promise<SourceAsset | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const list = await sources(projectId);
      const source = list.find((item) => item.id === sourceId);
      if (!source) return undefined;
      if (source.status !== "parsing") return source;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("來源一直停在 parsing");
  }

  /** 直接讀 app 用的那份 FTS 索引，不經過端點的孤兒過濾。 */
  const rawIndex = (projectId: string, query: string) =>
    new SqliteFtsRetriever(join(dataRoot, "index", "sources.sqlite")).search(projectId, query, 100);

  describe("parsing 這個狀態的收尾出口", () => {
    it("專案封存往返之後不留 parsing：匯入的專案沒有任何背景工作會來收尾", async (context) => {
      if (unavailable) return context.skip();
      const project = await newProject("封存往返");
      const image = await uploadImage(project.id, "archived.png");
      await settled(project.id, image.id);
      // 重現「在描述途中按下備份」：封存寫的是當下的 project.json。
      const repository = new FileProjectRepository(dataRoot);
      await repository.updateProject(project.id, (current) => {
        current.sources[0]!.status = "parsing";
      });

      const archive = await fetch(`${baseUrl}/api/projects/${project.id}/export/slide-project`);
      expect(archive.ok).toBe(true);
      const bytes = new Uint8Array(await archive.arrayBuffer());
      const imported = await json<PresentationProject>("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: bytes,
      });

      // 啟動修復只在 createApp 跑過一次；匯入是在那之後才把 parsing 帶進來的，
      // 沒有任何背景工作認得這筆來源，前端會永遠停在「AI 分析圖片內容中…」。
      expect(imported.sources[0]?.status).not.toBe("parsing");
    });
  });

  describe("與其他專案寫入交錯", () => {
    it("描述完成前來源已被刪除：不復活、不留孤兒 chunk、不卡在 parsing", async (context) => {
      if (unavailable) return context.skip();
      holdModel();
      const project = await newProject("刪除競態");
      const keeper = await upload(project.id, {
        name: "notes.md",
        mediaType: "text/markdown",
        usage: "content",
        bytes: new TextEncoder().encode("# 既有筆記\n\n這一筆不該受背景寫入影響。"),
      });
      const image = await uploadImage(project.id, "doomed.png");
      expect(image.status).toBe("parsing");
      // 等模型請求真的出門，才確定描述工作已經跑起來——這正是「寫回途中」的時序。
      await arrived;

      await json<PresentationProject>(`/api/projects/${project.id}/sources/${image.id}`, {
        method: "DELETE",
      });
      openGate?.();

      // 給背景那條路充分的時間做它可能做錯的事。
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await sources(project.id);
      expect(after.map((source) => source.id)).toEqual([keeper.id]);
      // 舊快照不得把刪掉的來源寫回去，也不得把 keeper 蓋掉。
      expect(after[0]!.extractedText).toContain("既有筆記");

      // 索引也要跟著走。留下孤兒 chunk 的話，/search 的縱深防禦雖然擋得住，
      // 但 sqlite 會一直帶著一份已刪來源的模型描述。
      expect(rawIndex(project.id, "磷酸鐵鋰").some((chunk) => chunk.sourceId === image.id)).toBe(
        false,
      );
      const hits = await json<Array<{ sourceId: string }>>(
        `/api/projects/${project.id}/search?q=${encodeURIComponent("磷酸鐵鋰")}`,
      );
      expect(hits.some((hit) => hit.sourceId === image.id)).toBe(false);
    });

    it("描述寫回途中又上傳另一份來源：兩邊都在，誰也沒被舊快照蓋掉", async (context) => {
      if (unavailable) return context.skip();
      holdModel();
      const project = await newProject("同時上傳");
      const image = await uploadImage(project.id, "chart.png");
      await arrived;
      // 描述還在途中就送出第二次上傳——背景那條路手上握的是更新前的專案快照。
      const later = await upload(project.id, {
        name: "later.md",
        mediaType: "text/markdown",
        usage: "content",
        bytes: new TextEncoder().encode("# 後到的來源\n\n這一筆比描述晚寫入。"),
      });
      openGate?.();

      const described = await settled(project.id, image.id);
      expect(described?.status).toBe("indexed");
      expect(described?.extractedText).toContain("磷酸鐵鋰");
      const after = await sources(project.id);
      expect(after.map((source) => source.id).sort()).toEqual([image.id, later.id].sort());
      expect(after.find((source) => source.id === later.id)?.extractedText).toContain("後到的來源");
      // 兩筆都要在索引裡：描述那次 index 是全表重建，晚到的來源不能被它洗掉。
      expect(rawIndex(project.id, "後到的來源").some((chunk) => chunk.sourceId === later.id)).toBe(
        true,
      );
    });

    it("描述途中使用者收回模型存取權：設定不被覆寫，描述也不得進到大綱 prompt", async (context) => {
      if (unavailable) return context.skip();
      holdModel();
      const project = await newProject("收回授權");
      const image = await uploadImage(project.id, "private.png");
      await arrived;
      await json<PresentationProject>(`/api/projects/${project.id}/sources/${image.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowModelAccess: false }),
      });
      openGate?.();

      const described = await settled(project.id, image.id);
      // 使用者的設定是後寫的，背景那條路握著舊快照，不得把它翻回 true。
      expect(described?.allowModelAccess).toBe(false);
      // 描述現在還會寫回一個模型衍生欄位（`metadata.summary`，給大綱目錄用）。早退擋在整個
      // `target.metadata` 賦值之前，所以它同樣不該落地——多一個欄位就要多釘一次，否則
      // 下一次有人把賦值搬到早退前面時，這條授權閘門只會缺一角而沒有任何測試變紅。
      expect(described?.metadata.summary).toBeUndefined();
      expect(described?.metadata.imageDescriptionProvider).toBeUndefined();
      // 不論描述有沒有落地，關鍵是它不能被餵進大綱：那正是這個勾選的語意。
      const context_ = knownSourceContext(
        new SqliteFtsRetriever(join(dataRoot, "index", "sources.sqlite")),
        project.id,
        (await sources(project.id)) as SourceAsset[],
        "磷酸鐵鋰 每度成本",
      );
      expect(context_.some((chunk) => chunk.id === image.id)).toBe(false);
    });
  });

  describe("完全不觸發模型的情況", () => {
    it("非圖片來源不呼叫 vision 模型，文字照樣抽得出來", async (context) => {
      if (unavailable) return context.skip();
      const project = await newProject("非圖片");
      const markdown = await upload(project.id, {
        name: "report.md",
        mediaType: "text/markdown",
        usage: "content",
        bytes: new TextEncoder().encode("# 年報\n\n磷酸鐵鋰成本下降。"),
      });
      expect(markdown.status).toBe("indexed");
      expect(markdown.extractedText).toContain("磷酸鐵鋰成本下降");
      expect(markdown.extractedText.startsWith(IMAGE_DESCRIPTION_NOTICE)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(describeCalls).toBe(0);
    });

    it("allowModelAccess=false 的圖片一個模型請求都不發", async (context) => {
      if (unavailable) return context.skip();
      const project = await newProject("不給模型看");
      const image = await uploadImage(project.id, "secret.png", false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // 這是這個功能唯一的硬條件：使用者說了不給模型看，圖片就不得離開伺服器。
      expect(describeCalls).toBe(0);
      // 上傳端點收到的 allowModelAccess 必須真的是 false，否則上面那條守則從一開始就沒生效。
      expect(image.allowModelAccess).toBe(false);
      // 連 parsing 都不該標：標了前端會閃一下「分析中」再默默變回去。
      expect(image.status).toBe("indexed");
      expect(image.extractedText).toBe("");
    });
  });

  describe("模型輸出畸形時的降級", () => {
    it("包了 ```json 圍欄、又只給部分欄位：仍然落地成可檢索的描述", async (context) => {
      if (unavailable) return context.skip();
      mode = "fenced-partial";
      const project = await newProject("寬鬆解析");
      const image = await uploadImage(project.id, "loose.png");
      const described = await settled(project.id, image.id);
      expect(described?.status).toBe("indexed");
      // 圍欄要被剝掉：留著的話 extractedText 會以 "```json" 開頭，chunk 也跟著髒掉。
      expect(described?.extractedText).not.toContain("```");
      expect(described?.extractedText.startsWith(IMAGE_DESCRIPTION_NOTICE)).toBe(true);
      expect(described?.extractedText).toContain("磷酸鐵鋰 2025 年為 56 美元");
      expect(described?.chunks.length).toBeGreaterThan(0);
    });

    it("三欄全空：不寫一份只有聲明的空殼，來源回到沒有描述的狀態", async (context) => {
      if (unavailable) return context.skip();
      mode = "empty";
      const project = await newProject("空回應");
      const image = await uploadImage(project.id, "blank.png");
      const described = await settled(project.id, image.id);
      expect(described?.status).toBe("indexed");
      expect(described?.extractedText).toBe("");
      expect(described?.chunks).toEqual([]);
      expect(described?.metadata.imageDescriptionModel).toBe(undefined);
    });

    it("回的根本不是 JSON：重試上限內放棄，來源回到 indexed", async (context) => {
      if (unavailable) return context.skip();
      mode = "garbage";
      const project = await newProject("散文回應");
      const image = await uploadImage(project.id, "prose.png");
      const described = await settled(project.id, image.id);
      expect(described?.status).toBe("indexed");
      expect(described?.extractedText).toBe("");
      // 解析失敗在 provider 內被當成暫時性錯誤重試三次：一張圖最多花掉三次配額。
      // 這個數字若變動，代表「上傳一張圖的成本」變了，要有人明確決定。
      expect(describeCalls).toBe(3);
    });

    it("provider 遲遲不回：逾時後放回 indexed，不會永遠卡在 parsing", async (context) => {
      if (unavailable) return context.skip();
      mode = "hang";
      const project = await newProject("逾時");
      const image = await uploadImage(project.id, "slow.png");
      expect(image.status).toBe("parsing");
      // SLIDE_MAKER_OPENAI_TIMEOUT_MS=5000，留兩倍餘裕；超過就是逾時沒有生效。
      const described = await settled(project.id, image.id, 240);
      expect(described?.status).toBe("indexed");
      expect(described?.extractedText).toBe("");
      expect(described?.chunks).toEqual([]);
    }, 25_000);
  });
});

import { mkdtemp } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PresentationProject, SourceAsset } from "@slide-maker/core";
import { createApp } from "../src/app.js";
import { SqliteFtsRetriever } from "../src/retriever.js";
import { knownSourceContext } from "../src/source-context.js";
import {
  IMAGE_DESCRIPTION_CHUNK_PREFIX,
  IMAGE_DESCRIPTION_NOTICE,
} from "../src/image-description.js";

/**
 * 描述落地之後，那張圖到底有沒有真的接上檢索鏈。
 *
 * 這個功能存在的唯一理由就是這條鏈：圖片有 chunk → FTS 撈得到 → `knownSourceContext()`
 * 把它放進大綱 prompt → 模型有理由把它列進 `slide.sourceIds` → jobs.ts 才附得上參考圖。
 * 只驗「extractedText 有字」等於什麼都沒驗——中間任何一節斷掉，症狀都是「上傳的圖從來
 * 不會被引用」，而那是靜默的。
 *
 * 對照組同樣重要：沒有描述的圖在 `sourceCatalog` 裡 summary 是空的、在 `uploadedSources`
 * 裡一塊都沒有。沒有這個對照，上面那些斷言可能只是因為別的來源剛好也命中。
 */

const IMAGE_MARKER = "磷酸鐵鋰 2025 年為 56 美元";
const OUTLINE_TOPIC = "電池成本結構";

interface OutlinePayload {
  topic: string;
  sourceCatalog: { id: string; name: string; url?: string; summary: string }[];
  uploadedSources: { id: string; name: string; locator?: string; text: string }[];
  searchedSources: Record<string, unknown>[];
}

function untrustedPayload(prompt: string): OutlinePayload {
  const marker = "\nUNTRUSTED_INPUT\n";
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return JSON.parse(prompt.slice(index + marker.length)) as OutlinePayload;
}

describe("圖片描述接上檢索鏈", () => {
  let appServer: Server | undefined;
  let fake: Server | undefined;
  let baseUrl = "";
  let dataRoot = "";
  let unavailable = false;
  const savedEnv: Record<string, string | undefined> = {};
  /** 大綱那一次呼叫送出的 prompt（描述請求不會進來）。 */
  const outlinePrompts: string[] = [];

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  const flatten = (content: unknown): string =>
    Array.isArray(content)
      ? content
          .map((part: unknown) =>
            typeof part === "object" && part && "text" in part
              ? String((part as { text: unknown }).text)
              : "",
          )
          .join("\n")
      : typeof content === "string"
        ? content
        : "";

  beforeAll(async () => {
    fake = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (part: Buffer) => chunks.push(part));
      request.on("end", () => {
        if ((request.url ?? "").endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          return response.end(JSON.stringify({ data: [] }));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role: string; content?: unknown }>;
          response_format?: {
            json_schema?: { schema?: { properties?: Record<string, unknown> } };
          };
        };
        const properties = body.response_format?.json_schema?.schema?.properties ?? {};
        response.writeHead(200, { "content-type": "application/json" });
        if ("fullText" in properties && "summary" in properties)
          return response.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      title: "2025 電池成本圖",
                      summary: "長條圖，比較磷酸鐵鋰與三元電池的每度成本。",
                      fullText: `Y 軸：每度成本（美元）。${IMAGE_MARKER}，三元電池為 71 美元。`,
                    }),
                  },
                },
              ],
            }),
          );
        // 大綱那一次：記下 prompt，回一份最小合法大綱。
        const user = body.messages?.find((message) => message.role === "user");
        outlinePrompts.push(flatten(user?.content));
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    actualSlideCount: 1,
                    rationale: "以上傳來源撰寫",
                    slides: [
                      {
                        purpose: "成本概況",
                        content: "磷酸鐵鋰與三元電池的每度成本差距。",
                        narrative: "先講結論再講數字",
                        layoutHint: "單欄重點",
                        sourceUrls: [],
                      },
                    ],
                    sources: [],
                  }),
                },
              },
            ],
          }),
        );
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

    dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-image-desc-retrieval-")),
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
    if (appServer?.listening)
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    if (fake?.listening) await new Promise<void>((resolve) => fake!.close(() => resolve()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    outlinePrompts.length = 0;
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }

  async function newProject(): Promise<PresentationProject> {
    return json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: OUTLINE_TOPIC,
        // 這個檔案只驗上傳來源那條路，關掉搜尋才不會把網頁來源混進 prompt。
        brief: {
          desiredSlideCount: 1,
          webSearchMode: "disabled",
          audience: "投資人",
          purpose: "決策",
        },
      }),
    });
  }

  async function uploadImage(projectId: string, name: string): Promise<SourceAsset> {
    const query = new URLSearchParams({
      name,
      mediaType: "image/png",
      usage: "visual-reference",
      allowModelAccess: "true",
    });
    const bytes = await sharp({
      create: { width: 640, height: 360, channels: 3, background: "#0c2238" },
    })
      .png()
      .toBuffer();
    const project = await json<PresentationProject>(
      `/api/projects/${projectId}/sources?${query.toString()}`,
      { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(bytes) },
    );
    const created = project.sources.find((source) => source.name === name);
    if (!created) throw new Error(`來源未建立：${name}`);
    return created;
  }

  async function settled(projectId: string, sourceId: string): Promise<SourceAsset> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await json<SourceAsset[]>(`/api/projects/${projectId}/sources`);
      const source = list.find((item) => item.id === sourceId);
      if (source && source.status !== "parsing") return source;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("來源一直停在 parsing");
  }

  it("描述進了 FTS：/search 與 knownSourceContext 都撈得到這張圖，且片段自帶出處前綴", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject();
    const image = await uploadImage(project.id, "cost.png");
    const described = await settled(project.id, image.id);
    expect(described.chunks.length).toBeGreaterThan(0);

    const hits = await json<Array<{ sourceId: string; text: string; locator?: string }>>(
      `/api/projects/${project.id}/search?q=${encodeURIComponent("磷酸鐵鋰")}`,
    );
    const hit = hits.find((item) => item.sourceId === image.id);
    expect(hit).toBeDefined();
    // locator 要看得出這不是原文的第幾段，而是模型描述。
    expect(hit!.locator?.startsWith("image-description:")).toBe(true);

    // 大綱真正吃的是 knownSourceContext 的產物，不是 /search 的產物；兩者要分別驗。
    const retriever = new SqliteFtsRetriever(join(dataRoot, "index", "sources.sqlite"));
    const picked = knownSourceContext(
      retriever,
      project.id,
      await json<SourceAsset[]>(`/api/projects/${project.id}/sources`),
      `${OUTLINE_TOPIC} 投資人 決策`,
    );
    const mine = picked.filter((chunk) => chunk.id === image.id);
    expect(mine.length).toBeGreaterThan(0);
    // 片段是被單獨切出來餵進 prompt 的，出處標註必須跟著它進去。
    expect(mine[0]!.text.startsWith(IMAGE_DESCRIPTION_CHUNK_PREFIX)).toBe(true);
    expect(mine.map((chunk) => chunk.text).join("\n")).toContain(IMAGE_MARKER);
  });

  it("大綱 prompt：有描述的圖在 sourceCatalog 有摘要、在 uploadedSources 有內容", async (context) => {
    if (unavailable) return context.skip();
    const project = await newProject();
    const image = await uploadImage(project.id, "described.png");
    await settled(project.id, image.id);

    await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace: true }),
    });
    expect(outlinePrompts).toHaveLength(1);
    const payload = untrustedPayload(outlinePrompts[0]!);

    const catalogued = payload.sourceCatalog.find((source) => source.id === image.id);
    expect(catalogued).toBeDefined();
    // 目錄摘要取 extractedText 的前 500 字，所以第一句必須是那條「這是模型產生的」聲明——
    // 少了它，模型會把圖片描述當成與 PDF 正文同級的原文。
    expect(catalogued!.summary.startsWith(IMAGE_DESCRIPTION_NOTICE.slice(0, 20))).toBe(true);
    expect(catalogued!.summary).toContain(IMAGE_MARKER);

    const excerpts = payload.uploadedSources.filter((source) => source.id === image.id);
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts.map((source) => source.text).join("\n")).toContain(IMAGE_MARKER);
    expect(excerpts[0]!.text).toContain(IMAGE_DESCRIPTION_CHUNK_PREFIX);
  });

  it("對照組：沒有描述的圖在目錄裡摘要是空的、在節錄裡一塊都沒有", async (context) => {
    if (unavailable) return context.skip();
    const blank = await newProject();
    // style-reference 不跑描述，正是「圖片沒有描述」的既有狀態（也是這個功能之前的樣子）。
    const query = new URLSearchParams({
      name: "style.png",
      mediaType: "image/png",
      usage: "style-reference",
      allowModelAccess: "true",
    });
    const bytes = await sharp({
      create: { width: 320, height: 180, channels: 3, background: "#402010" },
    })
      .png()
      .toBuffer();
    const withStyle = await json<PresentationProject>(
      `/api/projects/${blank.id}/sources?${query.toString()}`,
      { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(bytes) },
    );
    const styleSource = withStyle.sources.find((source) => source.name === "style.png")!;
    expect(styleSource.status).toBe("indexed");
    expect(styleSource.extractedText).toBe("");

    outlinePrompts.length = 0;
    await json<PresentationProject>(`/api/projects/${blank.id}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace: true }),
    });
    const payload = untrustedPayload(outlinePrompts[0]!);
    const catalogued = payload.sourceCatalog.find((source) => source.id === styleSource.id);
    // 這正是斷鏈的樣子：模型只被告知「有這個來源」，看不到任何內容，也就沒有理由引用它。
    expect(catalogued?.summary).toBe("");
    expect(payload.uploadedSources.some((source) => source.id === styleSource.id)).toBe(false);
  });
});

import { mkdtemp } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

// Fake OpenAI-compatible endpoint driving the server's OpenAI web-search engine.
describe("OpenAI web-search engine wiring", () => {
  let appServer: Server | undefined;
  let fake: Server | undefined;
  let baseUrl = "";
  let unavailable = false;
  const savedEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string) => {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (part: Buffer) => chunks.push(part));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").endsWith("/models")) return res.end(JSON.stringify({ data: [] }));
        const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } };
        };
        const isOutline = Boolean(
          requestBody.response_format?.json_schema?.schema?.properties?.actualSlideCount,
        );
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    isOutline
                      ? {
                          actualSlideCount: 1,
                          rationale: "Offline outline",
                          slides: [
                            {
                              purpose: "說明主題",
                              content: "不使用網路搜尋也能產生大綱。",
                              narrative: "直接說明",
                              layoutHint: "單欄",
                              imagePrompt: "Minimal presentation slide",
                              sourceUrls: [],
                            },
                          ],
                          sources: [],
                        }
                      : {
                          results: [
                            { url: "https://example.com/x", title: "X", summary: "hello" },
                            { url: "https://example.com/y.pdf", title: "Y", summary: "drop me" },
                          ],
                        },
                  ),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", resolve));
    const fakePort = (fake.address() as AddressInfo).port;

    setEnv("SLIDE_MAKER_OPENAI_BASE_URL", `http://127.0.0.1:${fakePort}/v1`);
    setEnv("SLIDE_MAKER_OPENAI_API_KEY", "test-key");
    setEnv("SLIDE_MAKER_OPENAI_TEXT_MODEL", "gpt-5");
    setEnv("SLIDE_MAKER_WEB_SEARCH_ENGINE", "openai");

    const app = await createApp(await mkdtemp(join(tmpdir(), "slide-maker-openai-")));
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
    if (appServer?.listening) await new Promise<void>((r) => appServer!.close(() => r()));
    if (fake?.listening) await new Promise<void>((r) => fake!.close(() => r()));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }

  it("routes web search through the OpenAI provider and filters download links", async (context) => {
    if (unavailable) return context.skip();
    const project = await json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "測試主題" }),
    });
    const results = await json<{ url: string; title: string; summary: string }[]>(
      `/api/projects/${project.id}/web-search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "測試查詢", limit: 5 }),
      },
    );
    expect(results).toEqual([{ url: "https://example.com/x", title: "X", summary: "hello" }]);
  });

  it("generates an outline without requiring web sources when search is disabled", async (context) => {
    if (unavailable) return context.skip();
    const project = await json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "離線大綱",
        brief: { webSearchMode: "disabled", desiredSlideCount: 1 },
      }),
    });
    const outlined = await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ textEngine: "openai" }),
    });
    expect(outlined.slides).toHaveLength(1);
    expect(outlined.slides[0]?.sourceIds).toEqual([]);
  });
});

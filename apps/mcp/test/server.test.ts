import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlideMakerClient } from "../src/client.js";
import { createServer } from "../src/server.js";

afterEach(() => vi.unstubAllGlobals());

describe("Slide Maker MCP server", () => {
  it("可完成 MCP 握手、列出工具並呼叫工具", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "project-1",
              name: "MCP 簡報",
              workflowStage: "editing",
              brief: {
                topic: "MCP",
                audience: "工程師",
                purpose: "說明架構",
                language: "zh-TW",
                desiredSlideCount: 5,
                tone: "清晰",
              },
              slides: [],
              styleSnapshot: {
                id: "default",
                version: 1,
                name: "預設風格",
                description: "",
                system: true,
                density: "high",
                referenceImages: [],
                updatedAt: "2026-09-22T00:00:00.000Z",
              },
              sources: [],
              jobs: [],
              createdAt: "2026-09-22T00:00:00.000Z",
              updatedAt: "2026-09-22T01:00:00.000Z",
            },
          ]),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const server = createServer(new SlideMakerClient({ baseUrl: "http://127.0.0.1:4173" }));
    const client = new Client({ name: "slide-maker-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "create_project",
      "get_project",
      "list_styles",
      "apply_style",
      "list_sources",
      "upload_source",
      "add_url_sources",
      "update_source",
      "generate_outline",
      "generate_deck",
      "get_generation_status",
      "export_presentation",
    ]);
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      result: [{ id: "project-1", name: "MCP 簡報", topic: "MCP", slideCount: 0 }],
    });
    const rejected = await client.callTool({
      name: "get_project",
      arguments: { projectId: "../model-library?x=" },
    });
    expect(rejected.isError).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await client.close();
    await server.close();
  });

  it("把風格與素材工具映射到既有 HTTP API", async () => {
    const style = {
      id: "editorial",
      version: 2,
      name: "編輯風",
      description: "雜誌排版",
      system: false,
      density: "high",
      referenceImages: [{ id: "ref-1" }],
      updatedAt: "2026-09-22T01:00:00.000Z",
    };
    const oldSource = {
      id: "source-old",
      name: "brief.md",
      mediaType: "text/markdown",
      usage: "content",
      allowModelAccess: true,
      status: "indexed",
      sizeBytes: 4,
      metadata: {},
      createdAt: "2026-09-22T00:00:00.000Z",
    };
    const source = {
      id: "source-1",
      name: "brief.md",
      mediaType: "text/markdown",
      usage: "content",
      allowModelAccess: true,
      status: "indexed",
      sizeBytes: 5,
      metadata: {},
      createdAt: "2026-09-22T00:00:00.000Z",
    };
    const project = {
      id: "project-1",
      name: "MCP 簡報",
      workflowStage: "editing",
      brief: {
        topic: "MCP",
        audience: "工程師",
        purpose: "說明架構",
        language: "zh-TW",
        desiredSlideCount: 5,
        tone: "清晰",
      },
      slides: [],
      styleSnapshot: style,
      sources: [oldSource, source],
      jobs: [],
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T01:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/styles"))
        return new Response(JSON.stringify([style]), {
          headers: { "Content-Type": "application/json" },
        });
      if (
        url.endsWith("/style") ||
        url.endsWith("/sources/source-1") ||
        (url.includes("/sources?") && init?.method === "POST")
      )
        return new Response(JSON.stringify(project), {
          headers: { "Content-Type": "application/json" },
        });
      if (url.endsWith("/sources") && init?.method === "GET")
        return new Response(JSON.stringify([source]), {
          headers: { "Content-Type": "application/json" },
        });
      if (url.endsWith("/url-sources") && init?.body?.toString().includes("unreachable"))
        return new Response(
          JSON.stringify({
            error: "URL_SOURCES_UNVERIFIED",
            message: "沒有任何網址取得可驗證的正文",
            failures: [{ url: "https://unreachable.example", reason: "WEB_SOURCE_FETCH_FAILED" }],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      if (url.endsWith("/url-sources"))
        return new Response(JSON.stringify({ project, failures: [] }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sourceRoot = await mkdtemp(join(tmpdir(), "slide-maker-mcp-server-sources-"));
    await writeFile(join(sourceRoot, "brief.md"), "# MCP");
    const server = createServer(
      new SlideMakerClient({ baseUrl: "http://127.0.0.1:4173", sourceRoot }),
    );
    const client = new Client({ name: "slide-maker-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const styles = await client.callTool({ name: "list_styles", arguments: {} });
    expect(styles.structuredContent).toMatchObject({
      result: [{ id: "editorial", version: 2, referenceImageCount: 1 }],
    });
    await client.callTool({
      name: "apply_style",
      arguments: { projectId: "project-1", styleId: "editorial", version: 2 },
    });
    await client.callTool({ name: "list_sources", arguments: { projectId: "project-1" } });
    const uploaded = await client.callTool({
      name: "upload_source",
      arguments: {
        projectId: "project-1",
        fileName: "brief.md",
        mediaType: "text/markdown",
        usage: "outline-reference",
        allowModelAccess: false,
      },
    });
    expect(uploaded.structuredContent).toMatchObject({ result: { source: { id: "source-1" } } });
    await client.callTool({
      name: "add_url_sources",
      arguments: { projectId: "project-1", urls: ["https://example.com/report"] },
    });
    const failedUrls = await client.callTool({
      name: "add_url_sources",
      arguments: { projectId: "project-1", urls: ["https://unreachable.example"] },
    });
    expect(failedUrls.isError).toBe(true);
    expect(failedUrls.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          status: 400,
          error: "URL_SOURCES_UNVERIFIED",
          message: "沒有任何網址取得可驗證的正文",
          failures: [{ url: "https://unreachable.example", reason: "WEB_SOURCE_FETCH_FAILED" }],
        }),
      },
    ]);
    await client.callTool({
      name: "update_source",
      arguments: {
        projectId: "project-1",
        sourceId: "source-1",
        usage: "visual-reference",
        allowModelAccess: false,
        describeImage: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/projects/project-1/style",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ styleId: "editorial", version: 2 }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/projects/project-1/sources?name=brief.md&mediaType=text%2Fmarkdown&usage=outline-reference&allowModelAccess=false",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "text/markdown" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/projects/project-1/url-sources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ urls: ["https://example.com/report"] }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/projects/project-1/sources/source-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          usage: "visual-reference",
          allowModelAccess: false,
          describeImage: true,
        }),
      }),
    );

    await client.close();
    await server.close();
  });
});

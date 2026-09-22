import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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
});

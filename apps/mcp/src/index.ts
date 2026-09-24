#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { clientFromEnv } from "./config.js";
import { createServer } from "./server.js";

let client;
try {
  client = await clientFromEnv();
} catch (error) {
  console.error(
    `Slide Maker MCP 無法啟動：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
void serveStdio(() => createServer(client));
console.error("Slide Maker MCP 已透過 stdio 啟動");

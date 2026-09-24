#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { clientFromEnv } from "./config.js";
import { createServer } from "./server.js";

const client = await clientFromEnv();
void serveStdio(() => createServer(client));
console.error("Slide Maker MCP 已透過 stdio 啟動");

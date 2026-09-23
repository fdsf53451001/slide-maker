#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  NoAuthProvider,
  parseTimeoutMs,
  SlideMakerClient,
  StaticBearerAuthProvider,
} from "./client.js";
import { createServer } from "./server.js";

const bearerToken = process.env.SLIDE_MAKER_MCP_BEARER_TOKEN?.trim();
const client = new SlideMakerClient({
  baseUrl: process.env.SLIDE_MAKER_MCP_BASE_URL ?? "http://127.0.0.1:4173",
  auth: bearerToken ? new StaticBearerAuthProvider(bearerToken) : new NoAuthProvider(),
  timeoutMs: parseTimeoutMs(process.env.SLIDE_MAKER_MCP_TIMEOUT_MS),
  outlineTimeoutMs: parseTimeoutMs(
    process.env.SLIDE_MAKER_MCP_OUTLINE_TIMEOUT_MS,
    60 * 60_000,
    "SLIDE_MAKER_MCP_OUTLINE_TIMEOUT_MS",
  ),
  ...(process.env.SLIDE_MAKER_MCP_EXPORT_ROOT
    ? { exportRoot: process.env.SLIDE_MAKER_MCP_EXPORT_ROOT }
    : {}),
  ...(process.env.SLIDE_MAKER_MCP_SOURCE_ROOT
    ? { sourceRoot: process.env.SLIDE_MAKER_MCP_SOURCE_ROOT }
    : {}),
});

void serveStdio(() => createServer(client));
console.error("Slide Maker MCP 已透過 stdio 啟動");

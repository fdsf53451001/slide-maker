#!/usr/bin/env node
// 不經 MCP host，直接用同一份環境變數打一次 API，確認位址與驗證設定可用。
import { SlideMakerApiError } from "./client.js";
import { clientFromEnv } from "./config.js";

try {
  const client = await clientFromEnv();
  const projects = await client.get<unknown[]>("/api/projects");
  console.error(`連線成功：共 ${projects.length} 個專案`);
} catch (error) {
  if (error instanceof SlideMakerApiError)
    console.error(`連線失敗：HTTP ${error.status} ${error.code}：${error.message}`);
  else console.error(`連線失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

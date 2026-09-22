# Slide Maker MCP

本地 stdio MCP server，將 Slide Maker 的 HTTP API 提供給 Codex、Claude Desktop、Cursor
等 MCP host。第一版支援：

- 列出、建立及讀取專案
- 產生整份大綱
- 啟動整份或指定頁面的圖片生成
- 查詢生成 job 狀態
- 匯出 PPTX、PDF、逐頁 PNG ZIP、專案封存或 Markdown 大綱

## 啟動

先在一個終端啟動 Slide Maker：

```sh
pnpm dev
```

MCP host 使用以下 command／args 啟動本地 server：

```json
{
  "command": "pnpm",
  "args": ["--dir", "/absolute/path/to/slide-maker", "dev:mcp"],
  "env": {
    "SLIDE_MAKER_MCP_BASE_URL": "http://127.0.0.1:4173"
  }
}
```

正式使用可先執行 `pnpm build`，再把 command 改為 `node`、args 改為
`["/absolute/path/to/slide-maker/apps/mcp/dist/index.js"]`。

## 設定

| 環境變數                       | 預設值                  | 用途                                    |
| ------------------------------ | ----------------------- | --------------------------------------- |
| `SLIDE_MAKER_MCP_BASE_URL`     | `http://127.0.0.1:4173` | Slide Maker API 位址                    |
| `SLIDE_MAKER_MCP_TIMEOUT_MS`   | `300000`                | 單次 API 呼叫逾時毫秒數                 |
| `SLIDE_MAKER_MCP_BEARER_TOKEN` | 未設定                  | 選用的靜態 bearer token；本機模式不需要 |
| `SLIDE_MAKER_MCP_EXPORT_ROOT`  | `slide-maker-exports`   | 匯出工具唯一可寫入的根目錄              |

匯出工具只接受此根目錄內的單一檔名，並拒絕子目錄、symlink 逃逸與覆寫既有檔案。MCP 的 stdout 是協定通道；
診斷訊息只會寫到 stderr。

目前的 bearer token 介面是之後串接 Cloud Run IAP 的接點。IAP 需要 OAuth token 取得與更新，
不應把 client secret 或使用者 token 寫進工具參數。

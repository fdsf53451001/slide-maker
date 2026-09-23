# Slide Maker MCP

本地 stdio MCP server，將 Slide Maker 的 HTTP API 提供給 Codex、Claude Desktop、Cursor
等 MCP host。第一版支援：

模型使用 Slide Maker 設定的預設組合，MCP 不另外選擇或修改模型。

- 列出、建立及讀取專案
- 列出風格庫並將指定風格套用到專案
- 列出、上傳與更新專案素材，也可從公開網址加入來源
- 在背景產生整份大綱並查詢完成或失敗狀態
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

| 環境變數                             | 預設值                  | 用途                                    |
| ------------------------------------ | ----------------------- | --------------------------------------- |
| `SLIDE_MAKER_MCP_BASE_URL`           | `http://127.0.0.1:4173` | Slide Maker API 位址                    |
| `SLIDE_MAKER_MCP_TIMEOUT_MS`         | `300000`                | 單次 API 呼叫逾時毫秒數                 |
| `SLIDE_MAKER_MCP_OUTLINE_TIMEOUT_MS` | `3600000`               | 大綱背景請求的等待上限（毫秒）          |
| `SLIDE_MAKER_MCP_BEARER_TOKEN`       | 未設定                  | 選用的靜態 bearer token；本機模式不需要 |
| `SLIDE_MAKER_MCP_EXPORT_ROOT`        | `slide-maker-exports`   | 匯出工具唯一可寫入的根目錄              |
| `SLIDE_MAKER_MCP_SOURCE_ROOT`        | `slide-maker-sources`   | 上傳工具唯一可讀取的素材目錄            |

匯出工具只接受此根目錄內的單一檔名，並拒絕子目錄、symlink 逃逸與覆寫既有檔案。MCP 的 stdout 是協定通道；
診斷訊息只會寫到 stderr。

素材上傳也只接受素材目錄內的單一一般檔案，不會讀取子目錄或 symlink。上傳視覺參考圖且允許 AI
讀取時，Slide Maker 可能在背景呼叫預設文字模型分析圖片內容。

`generate_outline` 會立即回傳 `running`，可用 `get_outline_status` 輪詢；完成後以 `get_project`
讀取大綱。連線逾時後狀態為 `unknown`，以免把伺服器稍後寫入的結果誤判成失敗並重複送出。
任務狀態保存在目前的 MCP 程序記憶體中；若 MCP 程序重啟，狀態一律為 `unknown`，即使
`hasOutline` 為 true，現有投影片也可能屬於先前版本。請用 `get_project` 確認內容。

目前的 bearer token 介面是之後串接 Cloud Run IAP 的接點。IAP 需要 OAuth token 取得與更新，
不應把 client secret 或使用者 token 寫進工具參數。

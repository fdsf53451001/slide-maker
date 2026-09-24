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
| `SLIDE_MAKER_MCP_SA_KEY_FILE`        | 未設定                  | 連 Cloud Run IAP 用的 SA JSON key 路徑  |
| `SLIDE_MAKER_MCP_IAP_AUDIENCE`       | `<base URL origin>/*`   | IAP JWT 的 `aud`，通常不必設定          |
| `SLIDE_MAKER_MCP_EXPORT_ROOT`        | `slide-maker-exports`   | 匯出工具唯一可寫入的根目錄              |
| `SLIDE_MAKER_MCP_SOURCE_ROOT`        | `slide-maker-sources`   | 上傳工具唯一可讀取的素材目錄            |

匯出工具只接受此根目錄內的單一檔名，並拒絕子目錄、symlink 逃逸與覆寫既有檔案。MCP 的 stdout 是協定通道；
診斷訊息只會寫到 stderr。

素材上傳也只接受素材目錄內的單一一般檔案，不會讀取子目錄或 symlink。上傳視覺參考圖且允許 AI
讀取時，Slide Maker 可能在背景呼叫預設文字模型分析圖片內容。

`generate_outline` 會立即回傳 `running`，可用 `get_outline_status` 輪詢；完成後以 `get_project`
讀取大綱。連線逾時或中途斷線後狀態為 `unknown`，以免把伺服器稍後寫入的結果誤判成失敗並重複送出；
若用 `get_project` 確認那次沒有寫入大綱，可帶 `retryUnknown: true` 再送一次（會再消耗一次配額）。
連線根本沒建立（例如 Slide Maker 未啟動）時則確定沒有送達，狀態為 `failed`、錯誤碼 `MCP_CONNECTION_FAILED`。
任務狀態保存在目前的 MCP 程序記憶體中；若 MCP 程序重啟，狀態一律為 `unknown`，即使
`hasOutline` 為 true，現有投影片也可能屬於先前版本。請用 `get_project` 確認內容。

## 連線到 Cloud Run（IAP）

MCP 仍在本機以 stdio 執行，只是把 API 請求改送到雲端；雲端資料集與本機是分開的兩份。
驗證走 service account 自簽 JWT：MCP 以本機的 SA key 簽出 IAP 接受的 JWT（有效 1 小時、
到期前 5 分鐘自動換新），不呼叫任何 Google API，所以不需要 `gcloud auth login`、
Token Creator 或 OAuth client。

1. 建立專用 SA，只在 IAP 上授予 `roles/iap.httpsResourceAccessor`（不要給專案層級角色）。
2. 建立該 SA 的 JSON key，放在 repo 之外並 `chmod 600`。任何拿到這個檔案的人都能以該 SA
   通過 IAP，請定期輪替。組織若啟用 `iam.disableServiceAccountKeyCreation` 則無法建立。
3. 先不經 MCP host 驗證設定（key 路徑必須是絕對路徑）：

```sh
SLIDE_MAKER_MCP_BASE_URL=https://<service>.run.app \
SLIDE_MAKER_MCP_SA_KEY_FILE=/absolute/path/to/key.json \
pnpm --filter @slide-maker/mcp check-connection
```

4. 成功後把同樣兩個環境變數放進 MCP host 設定的 `env`。

`SLIDE_MAKER_MCP_BEARER_TOKEN` 與 `SLIDE_MAKER_MCP_SA_KEY_FILE` 只能擇一。IAP 拒絕時
（非 JSON 的 401/403）工具回報 `MCP_AUTH_REJECTED`；最常見原因是 SA 沒有 IAP 存取權，
或 audience 與實際呼叫的網址不符——Cloud Run 有兩種網址，`aud` 由 `SLIDE_MAKER_MCP_BASE_URL`
推導，換網址時不需另外改。

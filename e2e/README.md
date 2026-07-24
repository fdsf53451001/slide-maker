# Live E2E 測試套件

以 in-process 方式起真正的 Express server（`createApp` from `apps/server/dist/app.js`），
用真實 HTTP 打端點，端到端驗證後端行為。分三層，依「燒多少配額」切開。

## 快速開始

```bash
# 先確保建置產物存在（E2E 從 dist 載入 server 與 core）
npx pnpm@10.13.1 build

pnpm e2e:l0          # 零配額，安全，隨時可跑
node e2e/run.mjs --layers l0
```

## 分層與配額

| 指令          | 層   | 配額     | 說明                                                                                                              |
| ------------- | ---- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm e2e:l0` | L0   | **零**   | mock-image + 本地 OCR/inpaint，無任何外部 HTTP。可安全反覆跑。                                                    |
| `pnpm e2e:l1` | L1   | **消耗** | 需 live OpenAI 相容連線（真實影像/文字/搜尋）。                                                                   |
| `pnpm e2e:l2` | L2   | **消耗** | 更完整的組合矩陣 / 跨 provider。                                                                                  |
| `pnpm e2e`    | 全部 | **消耗** | 預設 = L0+L1+L2。                                                                                                 |
| `pnpm e2e:ui` | UI   | —        | 瀏覽器層（Playwright，`@slide-maker/e2e-ui`，由另一個 agent 於 `e2e/ui` 實作；此 script 代理到該套件的 `test`）。 |

> ⚠️ **`e2e`、`e2e:l1`、`e2e:l2` 會消耗 Codex/OpenAI/Gemini 配額，絕不可放進 `pnpm check`。**
> `pnpm check` 只跑 typecheck/test/build；`.mjs` 不進 vitest、也不進 tsc。
> L0 是唯一零配額層，但同樣不預設進 `check`（它需要先 `build` 出 dist）。

## L0 涵蓋（零 API 呼叫）

| Spec                | 重點                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `l0-health-library` | `/api/health`、`/api/providers`、模型庫連線/entry/組合 CRUD、預設組合切換、`CONNECTION_PROTOCOL_MISMATCH`、系統設定 PATCH                                                                              |
| `l0-project-crud`   | 專案 CRUD、投影片新增/複製/刪除/reorder、來源上傳（txt/md/png）+ PATCH/DELETE + `/search`                                                                                                              |
| `l0-pdf-import`     | PDF 匯入：accepted/skipped、每頁兩 version（A 原圖無 textLayer、B `textLayer.originalVersionId→A`、current→A）、`assets/pdf-import/source.pdf`、掃描頁只有 A、>150 頁與非 16:9 拒絕                    |
| `l0-export`         | 四格式匯出：chunked（**無 `Content-Length`**）、`png.zip` 與原圖 byte-identical、`pptx`/`pdf` 內嵌 JPEG、`slide-project` 可重新匯入                                                                    |
| `l0-page-number`    | 開啟頁碼後與原圖不再 byte-identical、頁碼像素落在 `pageNumberLayout()` 區域、排除頁無頁碼、位置/格式/startAt/skipFirstSlide 全覆蓋（預期值一律由 `core` 的 `pageNumberLabel()/Layout()/Value()` 推導） |
| `l0-text-layer`     | 文字層編輯、版本 activate、restore、版本刪除（含 `VERSION_IN_USE`、`VERSION_REFERENCED_BY_TEXT_LAYER` 邊界）                                                                                           |
| `l0-local-inpaint`  | `/api/ocr/status`；OCR 可用時以 `local-inpaint` 跑 `extract-text` 驗證 textLayer + 零模型；不可用則 **skip**（不算失敗）                                                                               |
| `l0-jobs`           | mock 生成的 job 生命週期（queued→running→completed）、取消、並行度上限、觀測欄位                                                                                                                       |

## L1 涵蓋（文字／搜尋層，**消耗配額**，`needsLive=true`、組合 `e2e-gpt`）

每支開頭註解標明預期呼叫次數；斷言只驗結構與不變式，不對模型自由文字做脆弱比對。

| Spec                | 重點                                                                                                                                                             | 預期 API 呼叫                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `l1-outline`        | 整份大綱：頁數落在 `[desired-2, desired+2]`、每頁 purpose/content/narrative/layoutHint 非空、sourceIds 連到上傳來源、workflowStage→settings                      | 文字 1（超長重寫 ≤3）。**刻意 `webSearchMode:"disabled"` 省掉搜尋** |
| `l1-slide-outline`  | 單頁重生（用 `createProject` 決定性佔位大綱當底，零 setup 配額）：目標頁 content 變、purpose 不變、其他頁不動                                                    | 文字 1（≤3 重試）                                                   |
| `l1-style-analysis` | 上傳 1 張 PNG 成 style-asset → `/style-analysis`：designSystem 非空且含「色票」段、avoid 為陣列                                                                  | 文字 1                                                              |
| `l1-web-search`     | `/web-search` 候選結構（url 為 http(s)、title/summary 非空、筆數 ≤ limit）。**此端點只回候選、不抓正文**，verified 語意屬 `/web-sources`／outline 的 materialize | 搜尋 1                                                              |

## L2 涵蓋（影像層，**消耗配額**，`needsLive=true`、組合 `e2e-gpt`）

大綱一律用 `createProject` 決定性佔位頁或 PDF 匯入（零文字配額），配額集中在影像。**L2 由 QA 在使用者批准後才實跑。**

| Spec                 | 重點                                                                                                                                                                             | 預期 API 呼叫                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `l2-generate`        | `gpt-image-2` 生成全部頁 → 輪詢至 completed、每頁有 version 且 imagePath 存在、抓回是 1920×1080 PNG，存 artifacts                                                                | 影像 = 頁數（預設 3）                   |
| `l2-regenerate-edit` | 單頁生成 + `/edit-image` 局部遮罩編輯。**不**斷言模型遵守遮罩（CLIProxyAPI 忽略 mask）；只斷言 server `compositeMaskedEdit` 保證的「遮罩外像素與 base 逐像素相同」，存 artifacts | 影像 2（生成 1 + 編輯 1）               |
| `l2-extract-text`    | 用**生圖模型**（`gpt-image-2`，非 local-inpaint）跑 `extract-text`，base 取自 PDF 匯入的原生文字頁。驗證 textLayer + 抹字 backgroundPath。OCR 不可用則 **skip**                  | 影像 1（抹字）＋ 文字 1（可選樣式精修） |

## 環境需求

- **一律**：先 `pnpm build`（E2E 從 `apps/server/dist` 與 `packages/core/dist` 載入）。
- **L0**：無外部依賴。`l0-local-inpaint` 需 `.venv-ocr`（`pnpm setup:ocr`）才會實跑，否則 skip。
- **L1/L2**：需 live OpenAI 相容連線憑證，來源優先序：
  1. env `SLIDE_MAKER_OPENAI_BASE_URL` + `SLIDE_MAKER_OPENAI_API_KEY`
  2. `SLIDE_MAKER_E2E_SOURCE_LIBRARY`（預設 `<repo>/.slide-maker-data/models.json`）中
     `protocol==="openai"` 且 baseUrl 含 `8317` 的連線（如本機 CLIProxyAPI）。
     憑證**只**寫進隔離 dataRoot 的 `models.json`，**絕不**落進 artifacts 或印到終端。

## 隔離與產物

- 每個 spec 用獨立 `SLIDE_MAKER_DATA_ROOT = <repo>/.e2e-data/<runId>/<spec>`，跑完刪除
  （`--keep-data` 保留）。**絕不**碰 `.slide-maker-data` / `.data`。
- 產物寫到 `<repo>/artifacts/e2e/<runId>/<spec>/`（匯出的 pptx/pdf/zip、生成的 PDF 等）。
  報告最後印出 runId 的 artifacts 目錄。
- L0 模式下 harness 攔截 global `fetch`，只放行測試 server 的確切 origin；任何指向別處
  （含本機 8317 gateway）的請求都會 throw——藉此**證明** L0 全程零配額。

## 參數

```
--layers l0[,l1,l2]      要跑的層（預設全部；L1/L2 需 --yes 才真跑）
--yes, -y                確認執行 L1/L2 live 測試（會消耗配額）
--slides <N>             L1/L2：生成頁數
--combination <id>       L1/L2：指定模型組合
--keep-data              保留隔離 dataRoot（除錯用）
```

L1/L2 需 `--yes`（或 `SLIDE_MAKER_E2E_LIVE=1`）才會執行——無此旗標時 runner 只印預估配額並以 exit code 2 停下，不燒配額。

> ⚠️ **`--keep-data` 與憑證**：`needsLive` 模式會把模型連線的 apiKey 以明文（檔案權限 0600）寫進隔離 `dataRoot` 的 `models.json`，正常跑完即刪。搭配 `--keep-data` 時該檔會殘留於 `.e2e-data/<runId>/`（已 gitignore，但仍是磁碟上的明文金鑰）——除錯完請自行清除。

環境變數 `E2E_VERBOSE=1` 可放行 server 的結構化 INFO/WARNING log（預設靜音，只保留 ERROR）。

## 給 L1/L2 作者的介面

`e2e/lib/harness.mjs` 的 `startHarness({ runId, needsLive, zeroQuota, keepData })` 回傳：

```
{ runId, dataRoot, artifactsDir, baseUrl, client, library, needsLive, writeArtifact, close }
```

- `client`：`e2e/lib/client.mjs` 的 HTTP 包裝（`get/post/put/patch/delete` 成功即回、
  `rawGet/...` 回 `{status,headers,body,bytes}` 供斷言拒絕路徑）。
- `needsLive:true` 時 `seedLibrary` 會建 `e2e-gpt` 組合（image=`gpt-image-2`、
  text/search=`gpt-5.6-luna`），並自 env 或來源庫解析憑證。
- spec 模組契約：`export const name`、`export const layer`（`"l1"`/`"l2"`）、
  `export const needsLive = true`、`export default async function run(harness)`。
  丟 `SkipSignal`（`skip()`）= 跳過；其餘 throw = 失敗。
- `harness.options = { slides, combination }` 帶入 CLI 參數。

```

```

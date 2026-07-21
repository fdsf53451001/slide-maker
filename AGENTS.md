# Shared agent instructions

Edit this file; it is the single source of truth synced to every CLI.

## 指令

- 安裝依賴：`npx pnpm@10.13.1 install`（pnpm 版本固定為 10.13.1）
- **完整驗證閘門（完成程式碼變更後必跑）**：`pnpm check`（= `pnpm typecheck && pnpm test && pnpm build`）
- 單一套件測試：`pnpm --filter @slide-maker/server test`；單一測試檔：`pnpm --filter @slide-maker/server exec vitest run test/config.test.ts`
- 開發伺服器：`pnpm dev`（長時間執行；先 build 全部套件再啟動 server，網址 http://localhost:4173）；純 UI 開發用 `pnpm dev:web`（Vite）
- 格式化：`pnpm format`（Prettier）

## 注意事項

- `smoke:*` 腳本（`smoke:image:codex`、`smoke:deck:grok` 等）是 live 端對端測試，**會消耗 Codex/Grok 配額**，已排除在 `pnpm check` 之外——除非使用者明確要求，否則絕不執行（使用者可用 `/smoke` skill 觸發）。
- 開發模式依賴 `NODE_OPTIONS=--conditions=development` 搭配 tsconfig 的 `customConditions: ["development"]`，讓 workspace 套件解析到 `src/*.ts` 原始碼；少了這個條件會解析到 `dist/` 舊建置產物。
- TypeScript 開啟 `noUncheckedIndexedAccess` 與 `exactOptionalPropertyTypes`——索引存取結果須處理 `undefined`，optional property 不可顯式指定 `undefined`。
- Codex 圖片 provider 預設關閉；需設 `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1` 才啟用（軟隔離、非安全邊界，且消耗 Codex 配額）。伺服器環境變數皆定義於 `apps/server/src/config.ts`（如 `SLIDE_MAKER_DATA_ROOT`、`SLIDE_MAKER_CODEX_TIMEOUT_MS`），非法值會在啟動時 throw。可選用 `SLIDE_MAKER_CODEX_MODEL`（任意非空字串，如 `gpt-5.6-terra`）與 `SLIDE_MAKER_CODEX_REASONING_EFFORT`（`minimal`/`low`/`medium`/`high`）覆寫 Codex CLI 的模型與推理強度；未設定時不會加上覆寫旗標，回退到 Codex CLI 自身設定。
- OpenAI-compatible 端點（CLIProxyAPI、OpenAI 官方、LiteLLM 等皆為不同 base URL）由 `packages/provider-openai` 支援，涵蓋三個能力：影像生成（`openai-image` provider）、結構化文字生成、網路搜尋。以環境變數設定：`SLIDE_MAKER_OPENAI_BASE_URL`（http/https，如 `http://localhost:8317/v1`）、`SLIDE_MAKER_OPENAI_API_KEY`、`SLIDE_MAKER_OPENAI_IMAGE_MODEL`、`SLIDE_MAKER_OPENAI_TEXT_MODEL`、`SLIDE_MAKER_OPENAI_SEARCH_MODEL`（可選，預設同 text）、`SLIDE_MAKER_OPENAI_TIMEOUT_MS`。文字與搜尋各自以 `SLIDE_MAKER_TEXT_ENGINE`、`SLIDE_MAKER_WEB_SEARCH_ENGINE`（`codex` 預設｜`openai`）選擇引擎。網路搜尋已從文字推理解耦（先由 `WebSearchProvider` 取得來源，再餵給純推理的 `StructuredTextProvider`）；CLIProxyAPI 的 Gemini Chat translator 必須收到 `tools: [{ google_search: {} }]` 才會轉成原生 `googleSearch`，不可送 OpenAI typed `web_search`。搜尋候選必須成功抓取網頁正文才可進入生成 prompt，模型產生的搜尋摘要不得作為已驗證來源。三條圖片通道共用 `packages/core/src/image-contract.ts` 的 Codex-baseline 合約，transport adapter 不得另立內容／風格／reference 規則：Codex app-server；`SLIDE_MAKER_OPENAI_IMAGE_API=chat`（`/chat/completions`，CLIProxyAPI 的 GPT tool image 或原生 `gemini-3.1-flash-image`，可帶有序參考圖）；`SLIDE_MAKER_OPENAI_IMAGE_API=images`（預設，`/images/generations`＋`/images/edits`，如 `gpt-image-2`，參考圖生成透過 `/images/edits` 的 `image[]` 陣列，edit base/mask 亦走此端點）。三者輸出皆正規化成 canvas 尺寸 PNG。`gemini-3-flash-agent` 不視為可用圖片輸出模型。非嚴格 gateway（尤其 Gemini 系）不遵守 `json_schema`，故文字/搜尋 provider 會加 JSON-only system 指令並寬鬆解析（去 ` ```json ` 圍欄）。
- PDF 有**三條互不共用的路徑**，用途不同、參數不同，不要互相重用：①「風格參考圖」`apps/server/src/pdf-pages.ts`（長邊 1024、上限 24 頁、無狀態回 data URL，只餵風格庫縮圖）；②「來源素材」`apps/server/src/sources.ts` 的 `parsePdf`（純文字抽取）；③「匯入成簡報專案」`apps/server/src/pdf-deck.ts`＋`pdf-text.ts`＋`pdf-text-layer.ts`（1920×1080 落地存檔）。
- PDF 匯入簡報（③）全程**零模型**，不得退回 OCR＋inpaint：文字取自 PDF 原生文字層（`getTextContent()`），抹字背景靠**二次渲染過濾 text operator** 取得，而非 `extract-text` 那條 PaddleOCR＋生圖模型 masked edit 的路。受理條件為 16:9（每頁長寬比 1.70–1.82，混比例以第一頁為準）、150 頁上限；render 需有單頁與總時限，且不得長時間阻塞 event loop。匯入時**同時建立兩個 version**：version A 是原圖（`currentVersionId` 指向它，無 `textLayer`），version B 是可編輯文字（`textLayer.originalVersionId` 指向 A），兩者靠既有的版本切換 UI 存取；掃描頁沒有原生文字層，就只有 A。PDF 原檔一併保留於 `assets/pdf-import/source.pdf`。停在 A 時畫布與三種匯出皆為原圖保真；切到 B 會以系統字型重繪文字（內嵌字型在瀏覽器與伺服器都不存在），前端對此有一次性提示。
- `apps/server` 直接相依 `pdfjs-dist`（版本鎖定）：`pdf-to-img` 只提供「render page → PNG」，viewport 尺寸、`getTextContent()` 與 operator list 都必須直接用 pdf.js。無文字背景需掛 pdf.js 內部掛點 `page._renderPageChunk`（無公開 API 可渲染過濾後的 operator list），升級 `pdfjs-dist` 會使對應測試失敗而非靜默失效。
- `.data/`、`.slide-maker-data/`、`artifacts/`、`.venv-ocr/` 為執行期／生成資料，不要編輯或提交。

## 結構

pnpm monorepo（`apps/*`、`packages/*`，內部相依用 `workspace:*`）：`apps/server`（Express 5 API + job runner）、`apps/editor`（React 19 + Vite，雙重 build：app + library）、`packages/core`（zod schemas 與 provider 合約）、`packages/provider-mock`（預設的確定性圖片 provider）、`packages/provider-codex`（實驗性，pin Codex 0.144.4 協定）、`packages/provider-openai`（OpenAI-compatible 影像／文字／搜尋 provider）。

## Git 慣例

- Commit 訊息採用 Conventional Commits 格式（`feat:`、`fix:`、`chore:` 等）。

## 開發規範

重大修改要起feature branch，完成功能在merge回去
一般任務，要起dev agent作開發，review agent檢查，qa agent作測試

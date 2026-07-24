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
- Gemini 官方 API 走 `packages/provider-gemini` 的原生 `:generateContent`（AI Studio，base URL 形如 `https://generativelanguage.googleapis.com/v1beta`，認證用 `x-goog-api-key` header），不走 Google 的 OpenAI compat 層——實測該 compat 層無法序列化影像輸出（400 `Unhandled generated data mime type: image/jpeg`）、沒有 `/images/edits`、也拒絕所有 Google Search grounding 語法。三能力都在原生端點上可用：影像 `generationConfig.responseModalities:["IMAGE"]`＋依序 `inlineData` 參考圖（**Gemini 沒有獨立 edit/mask 端點，遮罩就是「再多一張圖」**，語意仍全由 `image-contract.ts` 承擔），回傳影像的 mimeType **因模型而異**（2026-07-22 實測 `gemini-2.5-flash-image` 回 `image/png`，其餘三個影像模型回 `image/jpeg`），一律讀 `inlineData.mimeType` 再交給 `rasterToCanvasPng()` 正規化成 canvas PNG；文字只送 `responseMimeType:"application/json"`，**不可送 `responseSchema`**（只吃 OpenAPI subset，塞完整 JSON Schema 會 400）；搜尋送 `tools:[{googleSearch:{}}]`（不可與 `responseMimeType` 並用），來源直接讀 `groundingMetadata` 而非要模型輸出 JSON。回應 part 可能夾帶 `thoughtSignature`，解析時只認 `text`／`inlineData` 鍵。grounding 的 `web` 只有 uri 與網域名 title、**沒有 summary**，summary 由 `groundingSupports` 的 segment 反向聚合，組不出來的 chunk 一律捨棄；uri 是有時效的 302 中繼網址，provider 內會先解成真實網址（安全檢查共用 `packages/core/src/url-safety.ts`，與 `web-capture.ts` 同一份）。連線層的 `protocol` 欄位（`openai`｜`gemini`，預設 `openai`）決定「列出可用模型」走 `GET /models` 還是 `ListModels`；model entry 的 `providerKind` 必須與所引用連線的 `protocol` 一致，不符時 server 於寫入時丟 `CONNECTION_PROTOCOL_MISMATCH`（否則執行期只會看到難懂的 HTTP 404）。grounding 的 `groundingChunkIndices` 是**多對一**語意（一段輸出可同時被多個 chunk 支撐），只有專屬單一 chunk 的段落才算該頁摘要，多重支撐段落降級為加註前綴的補充；重導向解析對整批候選併發進行並套用共用預算，解析後的網址會去重與再驗一次安全性（起點 uri 就不合法者整筆捨棄，不可退回原 uri——下游 `captureWebPage` 對這種網址是直接 throw）。
- 本地抹字（`scripts/local_inpaint.py`，`local-inpaint` provider 服務 extract-text）的背景定義是**「從遮罩框外做容差 flood 能連續蔓延進來的顏色」**，不是「ROI 灰階眾數 ± 門檻」：要保留的東西（底色、漸層、紋理、軸線、格線、卡片邊框、色塊交界）在框外都有本體，文字則被 `textMask` 的 padding 完整包住、框外沒有延續。三條不變量不可退回：①膨脹後的字墨一律 `&= region`，**遮罩外零改動**（舊版 7×7 膨脹 2 次會外擴 6px，正是圖表線被咬斷的根因）；②穿過遮罩的結構原樣保留；③被文字蓋住的水平／垂直線由「抹除帶兩端同色則線性插值」接回，否則留給 Telea。`FLOOD_TOLERANCE=6` 是實測甜蜜點（太大沿反鋸齒爬進低對比字造成殘字，太小則顆粒背景蔓延不進去被誤判成墨），JPEG q95／q88／q75 往返後仍成立。三條不變量由 `apps/server/test/local-inpaint-pixels.test.ts` 逐像素釘住（需 `.venv-ocr`，未安裝時整組 skip）。
- PDF 有**三條互不共用的路徑**，用途不同、參數不同，不要互相重用：①「風格參考圖」`apps/server/src/pdf-pages.ts`（長邊 1024、上限 24 頁、無狀態回 data URL，只餵風格庫縮圖）；②「來源素材」`apps/server/src/sources.ts` 的 `parsePdf`（純文字抽取）；③「匯入成簡報專案」`apps/server/src/pdf-deck.ts`＋`pdf-text.ts`＋`pdf-text-layer.ts`（1920×1080 落地存檔）。
- PDF 匯入簡報（③）全程**零模型**，不得退回 OCR＋inpaint：文字取自 PDF 原生文字層（`getTextContent()`），抹字背景靠**二次渲染過濾 text operator** 取得，而非 `extract-text` 那條 PaddleOCR＋生圖模型 masked edit 的路。受理條件為 16:9（每頁長寬比 1.70–1.82，混比例以第一頁為準）、150 頁上限；render 需有單頁與總時限，且不得長時間阻塞 event loop。匯入時**同時建立兩個 version**：version A 是原圖（`currentVersionId` 指向它，無 `textLayer`），version B 是可編輯文字（`textLayer.originalVersionId` 指向 A），兩者靠既有的版本切換 UI 存取；掃描頁沒有原生文字層，就只有 A。PDF 原檔一併保留於 `assets/pdf-import/source.pdf`。停在 A 時畫布與 `png.zip`／`slide-project` 匯出為原圖保真（無損 PNG 原封不動搬過去；**限頁碼關閉或該頁不編號時**——`withPageNumber()` 會 resize 後重新編碼），`pptx`／`pdf` 則為了體積走 `exporters.ts` 的 `compressSlideImage()` 轉成 JPEG q88 4:4:4（不做色度次取樣，保住彩色細字與細線；先 flatten 到黑底再編碼，因為 JPEG 沒有 alpha，sharp 是丟棄而非合成通道）；切到 B 會以系統字型重繪文字（內嵌字型在瀏覽器與伺服器都不存在），前端對此有一次性提示。
- `apps/server` 直接相依 `pdfjs-dist`（版本鎖定）：`pdf-to-img` 只提供「render page → PNG」，viewport 尺寸、`getTextContent()` 與 operator list 都必須直接用 pdf.js。無文字背景需掛 pdf.js 內部掛點 `page._renderPageChunk`（無公開 API 可渲染過濾後的 operator list），升級 `pdfjs-dist` 會使對應測試失敗而非靜默失效。
- Cloud Run 的 HTTP/1 回應在未使用 `Transfer-Encoding: chunked`／串流機制時上限 32 MiB，超過直接回 "Response size was too large."。`png.zip`／`slide-project` 內嵌無損 PNG，二十頁上下就會撞線（`pptx`／`pdf` 轉 JPEG 後才拉開餘裕，但不足以當作保證），故匯出端點一律走 `apps/server/src/http-stream.ts` 的 `sendChunked()`，不得「簡化」回 `response.send()`（`send()` 會補 `Content-Length`，回應即屬 non-streamed）。
- 頁碼是**專案級系統合成物**：`packages/core/src/page-number.ts` 是編號規則與版面幾何的唯一真相，伺服器 SVG 合成（`exporters.ts` 的 `withPageNumber()`）、編輯器 DOM overlay（`PageNumberOverlay`）、PPTX 文字框三端都必須呼叫 `pageNumberLabel()`／`pageNumberLayout()`，不得各自寫死邊距、字級或色塊內距（`chip.padX` 就是為了讓 PPTX 把文字起點推回同一條邊距而回傳的）。影像合約明文禁止模型自己畫頁碼（`DECK CHROME IS NOT YOURS TO DRAW`），頁碼一律事後合成；`slide-project` 封存也只帶設定、不烘進素材，否則再匯出會疊出第二個頁碼。編輯器的畫布與簡報舞台都必須是**精確的畫布比例**（`.canvas` 用 `--ar` + 容器查詢單位、`.presentation-stage` 用顯式 `min()` 尺寸），用 `aspect-ratio` 搭 `max-width`／`height:100%` 會失效，頁碼就會落進 letterbox 邊條或被裁掉。
- `.data/`、`.slide-maker-data/`、`artifacts/`、`.venv-ocr/` 為執行期／生成資料，不要編輯或提交。

## 結構

pnpm monorepo（`apps/*`、`packages/*`，內部相依用 `workspace:*`）：`apps/server`（Express 5 API + job runner）、`apps/editor`（React 19 + Vite，雙重 build：app + library）、`packages/core`（zod schemas 與 provider 合約）、`packages/provider-mock`（預設的確定性圖片 provider）、`packages/provider-codex`（實驗性，pin Codex 0.144.4 協定）、`packages/provider-openai`（OpenAI-compatible 影像／文字／搜尋 provider）、`packages/provider-gemini`（Gemini AI Studio 原生 `:generateContent` 影像／文字／搜尋 provider）。

## Git 慣例

- Commit 訊息採用 Conventional Commits 格式（`feat:`、`fix:`、`chore:` 等）。

## 開發規範

重大修改要起worktree和feature branch，完成功能在merge回去
一般任務，要起dev agent作開發，review agent檢查，qa agent作測試。沒有特別說就用opus模型

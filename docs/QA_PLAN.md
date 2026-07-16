# QA 驗收策略與測試矩陣

狀態：首個 vertical slice 已執行，隨後續 MVP 實作持續更新  
規格基線：`PRODUCT_INTERVIEW.md`（2026-07-14）

## 1. 目的與範圍

本文件定義 MVP 的獨立驗收策略。QA 驗證 library 契約、reference app 的核心使用流程、資料持久性、安全邊界與四種匯出格式；不把真實 Codex 額度、第三方服務可用性或非 MVP 功能視為一般 CI 的必要條件。

測試分成五層：

1. 靜態品質：workspace、TypeScript、lint、package exports 與依賴邊界。
2. 單元與契約：schema、registry、provider capability、版本與狀態轉移。
3. 整合：檔案專案、來源解析與檢索、風格 repository、job queue、exporter。
4. 端到端：本機 server + React UI 的主要使用流程。
5. Milestone 0 spike：真實 Codex 圖片生成與 Web Search；獨立於離線 CI，需保存人工可稽核證據。

## 2. 驗收原則

- 測試必須可重現；一般 CI 使用 deterministic fake providers，不消耗外部額度。
- provider、source parser、retriever、repository、storage 與 exporter 都應有共用 contract suite，第三方靜態套件可套用相同測試。
- 所有持久化測試使用獨立暫存目錄；不得讀寫使用者家目錄或其他專案。
- 不只檢查 API 成功，也檢查磁碟產物、重啟後狀態與失敗復原。
- fixtures 不含真實憑證、個資或不可再散布素材。
- 網路測試預設關閉；有網路、Codex 登入或 API key 的測試必須有明確 opt-in 標記。
- 每個缺陷記錄可重現命令、預期、實際、影響範圍、證據路徑與規格條目。

## 3. 建議品質閘門

合併前必要閘門：

- 鎖檔安裝成功。
- typecheck、unit、integration、build 全數通過。
- 核心 library 與公開 package 可由乾淨 consumer fixture 匯入。
- 無誤提交生成產物、暫存專案、來源文件或 secret。

MVP 發布前額外閘門：

- Chromium 端到端核心流程通過。
- Windows/WSL 與 Linux 至少各一次完整驗證。
- 四種輸出均經結構與可開啟性檢查。
- 100 來源與約 1 GB 上限行為經邊界測試；不要求 CI 固定提交 1 GB fixture。
- Milestone 0 有成功證據，或已有 Image API provider fallback 的明確決策紀錄。
- Critical/High 缺陷為 0；Medium 缺陷須有接受紀錄。

## 4. 測試資料集

最小 fixtures 應涵蓋：

- 有文字與圖片的 PDF、PPTX、DOCX。
- UTF-8 Markdown/TXT，含繁中、英文、emoji、長段落與空文件。
- PNG/JPG，含 16:9、非 16:9、透明 PNG、過大尺寸與損壞檔案。
- 重複檔名、特殊字元、路徑穿越樣式檔名與不支援副檔名。
- Web Search fake results，含 URL、標題、擷取時間、引用與惡意 prompt injection 文字。
- deterministic 1920x1080 測試圖片，以及會 timeout、失敗、中斷、回傳非法資料的 fake providers。

大型資料採測試期間生成或稀疏檔案，避免把大 fixture 提交到 repository。

## 5. 功能測試矩陣

優先級：P0 為 MVP 阻斷；P1 為發布前必要；P2 為強化項目。

| ID | 優先級 | 規格領域 | 驗證情境 | 主要層級 | 通過標準 |
|---|---|---|---|---|---|
| QA-ARCH-001 | P0 | Monorepo/library | 各公開 package 可獨立 build，乾淨 consumer 可依 exports 匯入 | build | 無 source-path 偶合或未宣告依賴 |
| QA-ARCH-002 | P0 | 擴充架構 | 靜態註冊各類 provider，重複 ID、未知 ID、契約不符時可預期失敗 | unit/contract | 七類擴充點均有穩定介面與明確錯誤 |
| QA-SCHEMA-001 | P0 | Schema-first | Brief、outline、SlideSpec、citation、generation plan 合法/非法輸入 | unit | Zod schema 版本化且拒絕未驗證資料 |
| QA-SCHEMA-002 | P1 | 遷移 | 舊版 project manifest 遷移；未知未來版本拒絕 | integration | 遷移不遺失已知資料，錯誤可行動 |
| QA-PROJ-001 | P0 | 專案格式 | 建立、保存、關閉、重開 `project.json` + `assets/` | integration | round-trip 等價且資產引用有效 |
| QA-PROJ-002 | P0 | 專案包 | `.slide-project` export/import | integration | 可重開；不得包含 secret 或衍生索引 |
| QA-PROJ-003 | P1 | 安全 | ZIP slip、symlink、絕對路徑與越界 asset reference | security | 無法寫出專案 workspace |
| QA-SRC-001 | P0 | 來源 provider | PDF/PPTX/DOCX/MD/TXT/PNG/JPG 正常與損壞輸入 | contract | 狀態、metadata、抽取內容及錯誤一致 |
| QA-SRC-002 | P0 | 來源用途 | 文件預設 content、圖片預設 visual-reference；五種用途可切換 | unit/UI | 預設與持久化符合規格 |
| QA-SRC-003 | P0 | 傳送權限 | exclude-from-generation 或未允許內容不進模型請求 | integration | fake provider 捕獲的 payload 不含被排除資料 |
| QA-SRC-004 | P1 | 來源管理 | 上傳、改名、分類、搜尋、預覽、刪除警告、錯誤顯示 | E2E | UI 與重啟後狀態一致 |
| QA-SRC-005 | P0 | 追蹤 | 刪除原來源後，既有 slide version 仍保留來源快照 | integration | attribution 可檢視，無懸空不可讀引用 |
| QA-SRC-006 | P1 | 容量 | 第 100 個來源成功；第 101 個與超過約 1 GB 有明確政策 | integration | 不崩潰、不產生半寫入狀態 |
| QA-RET-001 | P0 | SQLite FTS | 切塊、穩定 source ID、繁中/英文檢索、刪除與重建索引 | integration | 重建前後同查詢結果語意等價 |
| QA-RET-002 | P1 | Retriever 契約 | 替換 fake/FTS retriever，不改核心流程 | contract | 介面可靜態註冊，結果含可追蹤 chunk ID |
| QA-WEB-001 | P0 | Web Search | creative 預設 cached，可選 live/disabled | unit/UI | 設定正確送入 provider 並持久化 |
| QA-WEB-002 | P0 | 不可信網頁 | 搜尋結果含指令注入字串 | integration | 內容僅作資料，不改變工具、路徑或安全設定 |
| QA-STYLE-001 | P0 | StylePreset | 建立、讀取、更新、刪除、版本、資產與可選 style board | integration/UI | server-side repository round-trip 正確 |
| QA-STYLE-002 | P0 | 快照 | 全域 style 更新不改既有 project snapshot | integration | 舊專案 hash/版本不變 |
| QA-STYLE-003 | P1 | 繼承 | 全域、專案、單頁覆寫解析 | unit | precedence 明確、結果 deterministic |
| QA-IMG-001 | P0 | ImageProvider | capability 宣告、必備 full-slide、支援尺寸/參考圖/seed | contract | UI/核心只呼叫已宣告能力 |
| QA-IMG-002 | P0 | 標準畫布 | 非 16:9 provider 結果裁切或補邊為 1920x1080 | integration | 像素尺寸正確且無非預期變形 |
| QA-IMG-003 | P1 | Provider UI | 進階設定依 provider schema 顯示與驗證 | UI | 無隱藏簡化 preset；非法參數不能提交 |
| QA-FLOW-001 | P0 | 建立流程 | 僅輸入一句需求，取得可修改 Brief，再產生 outline/SlideSpec | E2E | 每階段可停、修改、保存後繼續 |
| QA-FLOW-002 | P0 | 自由頁型 | SlideSpec 不要求固定 slide type enum | schema/E2E | 自由 purpose/content/layoutHint 可保存與生成 |
| QA-FLOW-003 | P0 | 逐頁編輯 | 排序、複製、刪除、修改 spec、重生單頁 | E2E | 只影響目標頁，順序與引用正確 |
| QA-VERS-001 | P0 | 不可變版本 | 生成/重生/修改建立版本；命名、比較、回復 | integration/UI | 回復新增狀態，不刪除後續歷史 |
| QA-VERS-002 | P0 | 版本 metadata | 圖片、prompt、model、參數、style、來源、時間齊全 | unit | schema 與磁碟皆完整 |
| QA-JOB-001 | P0 | Job 狀態 | queued/running/completed/failed/cancelled 合法轉移 | unit | 非法轉移拒絕且錯誤明確 |
| QA-JOB-002 | P0 | 持久與恢復 | 執行中強制終止 server 後重開 | integration | 工作可判定、重試；完成結果不重複 |
| QA-JOB-003 | P0 | 局部成果 | 多頁生成中一頁失敗 | integration | 成功頁立即保存；失敗頁可獨立重試 |
| QA-JOB-004 | P1 | 並行/取消 | provider concurrency limit 與 queued cancel | integration | 最大同時執行數不超限；取消不呼叫 provider |
| QA-EXP-001 | P0 | PPTX | 全版圖、順序、16:9、可選 notes/來源 | integration | OPC 結構有效；每頁單一全版圖片且 notes 正確 |
| QA-EXP-002 | P0 | PDF | 頁數、順序、尺寸與可開啟性 | integration | parser 可讀且頁面為 16:9 |
| QA-EXP-003 | P0 | PNG ZIP | 每頁 PNG、命名、順序與 1920x1080 | integration | ZIP 可解壓且所有圖片有效 |
| QA-EXP-004 | P0 | Project export | 完整專案重新匯入 | integration | 見 QA-PROJ-002 |
| QA-SEC-001 | P0 | Secret | project、project bundle、job/error log 不含 canary API key | security | 對所有產物全文搜尋無 canary |
| QA-SEC-002 | P0 | Sandbox | Codex 僅可寫 project workspace；allowlist module 唯讀 | integration | 越界寫入被拒絕並留安全錯誤 |
| QA-SEC-003 | P0 | 資料揭露 | 送往 provider 的資料範圍可在 UI 查知 | UI/integration | 顯示內容與實際 fake payload 一致 |
| QA-SEC-004 | P1 | 無隱性網路 | 離線核心流程不發出未宣告網路請求 | integration | 封鎖網路時 deterministic 流程通過 |
| QA-UI-001 | P0 | 編輯器布局 | 縮圖區、預覽、頁面設定/來源/生成操作、版本歷史 | E2E | 核心功能鍵盤可達且主要狀態可辨識 |
| QA-UI-002 | P0 | Capability gating | 不支援 edit/inpaint 時 UI 不顯示或停用 | E2E | 不會向 provider 發送不支援操作 |
| QA-UI-003 | P1 | 錯誤復原 | parser/provider/exporter 失敗訊息與重試 | E2E | 不丟失已完成工作，錯誤可行動 |
| QA-M0-001 | P0 | Codex spike | 單頁生成、style/content refs、圖片與紀錄 | manual/integration | 保存命令、環境、輸入、輸出與時間 |
| QA-M0-002 | P0 | Codex spike | 中斷判定、連續多頁、額度限制 | manual/integration | 有可重現結論與 fallback 決策 |

## 6. 非功能與邊界測試

### 效能與資源

- 100 個小型來源完成 ingest/index/search，記錄總時間、峰值 RSS 與索引大小。
- 一次排入至少 20 頁，fake provider 下驗證並行限制、UI 回應與結果增量持久化。
- 重建索引不能修改 `project.json` 的核心內容或 slide history。
- 大檔、空檔、損壞檔與磁碟空間不足時，不留下「成功」狀態。

效能基準在取得可跑實作後量測並固定；在此之前不虛設毫無根據的秒數門檻。

### 相容性

- Node 與 pnpm 版本以 repository 宣告為準。
- MVP 至少驗證 Chromium；Firefox/WebKit 視 package 支援列為 P1/P2。
- 檔案路徑涵蓋 Windows 分隔符、繁中、空白與長檔名。

### 可及性最低要求

- 主要流程可用鍵盤完成。
- 圖示按鈕具有 accessible name；表單錯誤可由輔助技術辨識。
- focus 不被 modal、拖曳排序或 job 更新意外吞掉。
- 狀態不能只依靠顏色表達。

## 7. Milestone 0 證據清單

真實 Codex spike 不納入無條件 CI。執行者應保存：

- 日期、OS、Node/Codex 版本與登入方式（不得保存 token）。
- 完整可重現命令與非敏感設定。
- 單頁、多頁、參考圖、style board 的輸入摘要。
- 圖片輸出、尺寸、job log、耗時與已知額度訊息。
- 生成中止後重啟的狀態與是否會重複扣用量。
- 成功率與錯誤分類。
- 結論：Codex provider 可作預設，或切換 Image API fallback。

## 8. 預計驗證命令

實際 script 名稱以 repository `package.json` 為準。若採訪談建議，QA 依序執行：

```bash
corepack pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm exec playwright test
```

若 scripts 不存在，不以臨時自訂命令掩蓋缺口；先記錄為測試基礎設施缺陷，再使用 package 級命令定位問題。

## 9. 執行紀錄

| 日期 | Revision | 命令 | 結果 | 備註/缺陷 |
|---|---|---|---|---|
| 2026-07-14 | initial core/providers scaffold | `corepack pnpm install --frozen-lockfile` | BLOCKED | 執行環境沒有 `corepack`/`pnpm`；改以 packageManager 鎖定的 `npx pnpm@10.13.1` |
| 2026-07-14 | initial core/providers scaffold | `npx --yes pnpm@10.13.1 install --frozen-lockfile` | FAIL | 初次執行時尚無 `pnpm-lock.yaml`（`ERR_PNPM_NO_LOCKFILE`）；以 `--no-frozen-lockfile` 安裝後產生 lockfile |
| 2026-07-14 | core + mock + Codex provider | `pnpm typecheck` | PASS | 3 個實作 package 通過 |
| 2026-07-14 | core + mock + Codex provider | `pnpm test` | PASS | 6/6；Codex child-process 測試須在 managed sandbox 外執行，sandbox 會清空 child stdout |
| 2026-07-14 | core + mock + Codex provider | `pnpm build` | PASS | 3 個實作 package 通過 |
| 2026-07-14 | server batch 1 | `pnpm --filter @slide-maker/server test` | PASS | 原有 2/2；加入 QA job persistence/redaction/recovery 後 5/5 |
| 2026-07-14 | server batch 1 | `pnpm --filter @slide-maker/server typecheck` | FAIL | `app.ts:45` 違反 `exactOptionalPropertyTypes`，`name` 可為 undefined |
| 2026-07-14 | server batch 1 | `pnpm --filter @slide-maker/server build` | FAIL | 同上；另 `app.ts:20` TS2742，`createApp` inferred return type 不可攜 |
| 2026-07-14 | editor batch 1 | `pnpm --filter @slide-maker/editor test` | PASS (empty) | 以 `--passWithNoTests` 結束；實際沒有 editor 測試 |
| 2026-07-14 | editor batch 1 | `pnpm --filter @slide-maker/editor typecheck` | FAIL | `Editor.tsx:141` 使用目前 TS lib 不支援的 `toReversed`，並衍生 callback implicit any |
| 2026-07-14 | editor batch 1 | `pnpm --filter @slide-maker/editor build` | FAIL | 同 typecheck；Vite build 未執行 |
| 2026-07-14 | final clean verification | `/tmp` 乾淨副本：`pnpm install --frozen-lockfile` | PASS | lockfile 最新；6 個 workspace projects 可重現安裝 |
| 2026-07-14 | final clean verification | `/tmp` 乾淨副本：`pnpm check` | PASS | typecheck 全過；13/13 tests；app + embeddable editor library + server/packages build 全過 |
| 2026-07-14 | final workspace verification | workspace：`pnpm check` | PASS | 與乾淨副本一致；server HTTP vertical tests 2/2 通過 |
| 2026-07-14 | production smoke | production server + local HTTP | PASS | health、create、patch、mock generate、poll completed、serve SVG、immutable restore、惡意 Origin 403 均符合預期 |
| 2026-07-14 | package dry run（初次） | core/mock/Codex/editor：`npm pack --dry-run --json` | PASS/WARN | exports、runtime 與 type artifacts 皆入包；當時缺 Apache-2.0 LICENSE，後續批次已修復 |
| 2026-07-14 | final security/concurrency batch | workspace：`pnpm check` | PASS | typecheck 全過；16/16 tests（含 HTTP、concurrency、invalid provider output）；app/library/server build 全過 |
| 2026-07-14 | final package/license | 4 public packages：`npm pack --dry-run --json` + `sha256sum` | PASS | 全部 tarball 明確包含 `LICENSE`；root 與四份 package LICENSE SHA256 皆為 `7505b489…3df1ab` |
| 2026-07-14 | `Cannot GET /` regression | repository root：`npx --yes pnpm@10.13.1 dev` | PASS | `GET /` 200 `text/html`；首頁引用 JS asset 200 `text/javascript`；`GET /api/health` 200 JSON |
| 2026-07-14 | runtime cwd regression | `/tmp`：`node /absolute/path/apps/server/dist/index.js` | PASS | 從 repository 外 cwd 啟動仍正確解析 editor dist；首頁、同一靜態 asset與 health 均 200 |
| 2026-07-14 | runtime path final check | workspace：`pnpm check` | PASS | typecheck/build 全過；19/19 tests，含 runtime path 2、HTTP editor root 1 與既有 integration/security tests |
| 2026-07-14 | Codex soft-isolation provider | fake executables：`pnpm --filter @slide-maker/provider-codex test` | PASS | 19/19；opt-in、argv/cwd/flags、untrusted input、JSONL、timeout/cancel/SIGKILL、symlink/outside、PNG size/chunks/CRC/dimensions與 secret-safe process error |
| 2026-07-14 | Codex server job flow | fake `codex` on PATH：`qa-codex-flow.test.ts` | PASS | opt-in off unavailable/拒絕 enqueue；on available+warning；success completed/version；failure只保存 `CODEX_PROCESS_FAILED_9`，不含 Bearer secret |
| 2026-07-14 | Codex soft-isolation final check | workspace：`pnpm check` | PASS | typecheck/build 全過；36/36 tests（provider 19、server 14、core 2、mock 1）；editor test script仍為 0 tests |
| 2026-07-14 | dev startup status | root `pnpm dev`（opt-in off）+ server dev（opt-in on） | PASS | off 顯示 mock 與 Codex disabled；on 顯示 enabled、quota 與 soft-isolation 非安全邊界警告；兩者 `/api/providers` 均與 console 狀態一致且 watch process 持續服務 |
| 2026-07-14 | job observability | `pnpm --filter @slide-maker/server test`（managed sandbox 外） | PASS | 9 files、35/35；phase/event 順序與持久化、reload、elapsed/remaining、delayed JSONL API、cancel/跨專案 cancel、timeout 無重試、安全錯誤分類、結構化 log 去敏、舊 schema migration、mock lifecycle |
| 2026-07-14 | timeout/process regression | `pnpm --filter @slide-maker/provider-codex test`（managed sandbox 外） | PASS | 2 files、32/32；10 分鐘 default、30 秒至 30 分鐘 bounds/invalid、slow fake、usage/auth classification、cancel、timeout、SIGKILL 與 grandchild process-group heartbeat 終止 |
| 2026-07-14 | observability final gate | workspace：`pnpm check`（managed sandbox 外） | PASS | exit 0；typecheck/build 全過；71/71 tests（core 3、mock 1、Codex 32、server 35；editor 0 tests） |
| 2026-07-14 | Codex 0.144.4 schema provenance | `codex app-server generate-json-schema --out /tmp/slide-maker-codex-schema --experimental` + `sha256sum` | PASS | 未啟動 model turn；版本、產生指令、bundle 與關鍵 schema hashes 記錄於 `CODEX_APP_SERVER_SCHEMA_PROVENANCE.md` |
| 2026-07-14 | app-server/readiness gate | provider/server targeted Vitest suites（managed sandbox 外） | PASS | app-server 33/33；provider readiness 9/9；readiness service 12/12；server app-server API flow 2/2。涵蓋完整 schema、effective policy、correlation、limits、savedPath、secret redaction、Web Search fail-closed 與 SIGKILL |
| 2026-07-14 | graceful shutdown gate | `pnpm --filter @slide-maker/server exec vitest run test/qa-shutdown.test.ts` | PASS | 7/7；active/queued 持久化為 `SERVER_SHUTDOWN`、hard deadline、重入、第一/第二 signal exit 0/1、restart recovery、cancel 不偽造 child exit |
| 2026-07-14 | app-server/readiness/shutdown final gate | workspace：`pnpm check`（managed sandbox 外） | PASS | exit 0；typecheck/build 全過；132/132 tests（core 3、mock 1、Codex 74、server 54；editor 0 tests） |

### 本輪結論

首個垂直切片可驗收：可建立專案、編輯單頁規格、以 deterministic mock provider 非同步生成、保存資產與不可變版本、重啟恢復 running job、提供 production editor，且 Codex provider 預設不可執行以避免未隔離的額度與檔案風險。

這不代表完整 MVP 已完成。以下仍是後續 P0/P1 驗收缺口：

- editor 尚無 component/E2E 測試，`test` 目前以 0 tests 通過；本輪 phase、進度、elapsed/remaining、取消與安全錯誤 UI 已通過 TypeScript/Vite build，且 delayed fake 的 API contract 已驗證，但仍缺真正 DOM/瀏覽器 assertion；Playwright 尚未配置。
- 來源上傳/管理與七種格式 parser、100 來源容量、SQLite FTS、Web Search 尚未實作驗收。
- server-side StyleRepository 與風格 CRUD/快照重套用尚未實作驗收。
- PPTX、PDF、PNG ZIP、`.slide-project` exporter 尚未實作驗收。
- Codex 0.144.4 app-server stdio transport、非生成 readiness、read-only effective policy、artifact schema、安全 limits 與 graceful shutdown fake integration 已通過；真實 Codex 仍須明確 opt-in。本輪未執行真實圖片生成，因此尚無圖片品質、額度、參考圖與中斷扣量證據。
- UI 已具 readiness 狀態、experimental warning、unknown 明確確認、provider warning、CSS 與 API gate，且 production build 通過；editor 仍沒有 browser/component test，因此尚無 DOM 層 assertion。
- Codex Web Search 已明確留給未來 LLM/SourceProvider 的內容規劃；ImageProvider turn 對任何 `webSearch` item fail-closed，不把 prompt 文字當作安全邊界。
- 靜態第三方 provider/source/retriever/storage/exporter consumer contract suite 尚未完成。

## 10. 缺陷分級

- Critical：資料不可逆損毀、secret 外洩、sandbox escape、惡意來源可執行指令。
- High：P0 核心流程不可完成、持久化後無法恢復、輸出不可開啟或錯誤引用。
- Medium：有替代路徑但重要行為偏離規格、明顯可及性或錯誤處理缺口。
- Low：不影響正確性的視覺、文案或診斷改善。

## 11. 明確不驗收為 MVP 功能

帳號/權限、多人協作、雲端同步、runtime plugin 市場、固定 slide type、自由物件畫布、圖片內文字直接編輯、分層可編輯 PPTX、跨專案知識庫、Google Slides 與 Keynote 匯出均不作為 MVP 通過條件。

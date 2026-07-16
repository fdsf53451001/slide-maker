# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- Codex 圖片 provider 預設關閉；需設 `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1` 才啟用（軟隔離、非安全邊界，且消耗 Codex 配額）。伺服器環境變數皆定義於 `apps/server/src/config.ts`（如 `SLIDE_MAKER_DATA_ROOT`、`SLIDE_MAKER_CODEX_TIMEOUT_MS`），非法值會在啟動時 throw。
- `.data/`、`.slide-maker-data/`、`artifacts/`、`.venv-ocr/` 為執行期／生成資料，不要編輯或提交。

## 結構

pnpm monorepo（`apps/*`、`packages/*`，內部相依用 `workspace:*`）：`apps/server`（Express 5 API + job runner）、`apps/editor`（React 19 + Vite，雙重 build：app + library）、`packages/core`（zod schemas 與 provider 合約）、`packages/provider-mock`（預設的確定性圖片 provider）、`packages/provider-codex`（實驗性，pin Codex 0.144.4 協定）。

## Git 慣例

- Commit 訊息採用 Conventional Commits 格式（`feat:`、`fix:`、`chore:` 等）。

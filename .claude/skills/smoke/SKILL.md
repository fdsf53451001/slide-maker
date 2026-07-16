---
name: smoke
description: 執行會消耗 Codex/Grok 配額的 live smoke 測試（端對端腳本）。這些腳本已排除在 pnpm check 之外，只能由使用者手動觸發。
disable-model-invocation: true
---

執行本專案的 live smoke 測試。這些腳本會呼叫真實的外部服務並**消耗 Codex/Grok 配額**，因此獨立於 `pnpm check` 之外。

可用的 smoke 目標（定義於根目錄 package.json）：

| 目標              | 指令                         | 用途                         |
| ----------------- | ---------------------------- | ---------------------------- |
| `image:codex`     | `pnpm smoke:image:codex`     | Codex 圖片 provider 單張生成 |
| `deck:grok`       | `pnpm smoke:deck:grok`       | Grok 完整簡報建置端對端      |
| `style-reference` | `pnpm smoke:style-reference` | 風格參考端對端               |
| `parallel`        | `pnpm smoke:parallel`        | Codex 並行生成端對端         |

流程：

1. 解析 `$ARGUMENTS`：若指定了上表其中一個目標，只跑該目標；若為空，先用 AskUserQuestion 問使用者要跑哪個（提供上表選項，可複選），不要預設全跑。
2. Codex 相關的 smoke 需要 `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1`；執行前確認並提醒使用者這會消耗配額。
3. 逐一在前景執行選定的指令（這些是長時間執行的腳本，適當拉高 timeout）。
4. 回報每個目標的結果：成功／失敗、關鍵輸出路徑（例如 `artifacts/` 下的產物）、失敗時附上錯誤摘要。

$ARGUMENTS

# 簡報生成管理平台：Grilling 訪談紀錄

- 日期：2026-07-14
- 狀態：訪談結束，MVP 範圍已確認
- 專案定位：開源、local-first、以 library 為核心的圖片式簡報生成與管理平台
- 授權：Apache-2.0

## 1. 產品目標

建立一套可嵌入其他產品的簡報生成 library，並提供可實際操作的編輯介面。系統使用 Codex 規劃簡報內容、處理參考資料與執行 Web Search，再透過圖片 provider 生成每一頁完整的投影片圖片。

第一版重點是：

- 參考資料上傳與來源管理
- 簡報大綱與逐頁規格生成
- 風格管理
- 批次圖片生成
- 單頁獨立修改與版本回復
- 可恢復的生成任務
- PPTX、PDF、PNG 與專案檔匯出

## 2. 專案與套件邊界

專案採 TypeScript monorepo，預計使用：

- pnpm workspace
- TypeScript
- React 編輯器
- 本機 Node.js server 與 CLI
- Zod schema validation
- Vitest
- Playwright

套件分成三個主要層次：

1. Headless 核心 library：負責專案模型、生成流程、風格、來源、版本及匯出。
2. React 編輯器套件：提供可嵌入其他應用程式的 UI。
3. Reference app：啟動本機 Node.js server，並在瀏覽器中開啟編輯器。

第一版不製作 Electron 或 Tauri 桌面包裝，但保留未來封裝的可能性。

## 3. 擴充架構

核心功能必須以介面與 registry 解耦，至少包含：

- `LLMProvider`
- `ImageProvider`
- `SourceProvider`
- `Retriever`
- `StyleRepository`
- `StorageAdapter`
- `Exporter`

擴充模組採 npm package 靜態安裝與程式碼註冊。第一版不做外掛市場、UI 動態安裝或 runtime plugin sandbox。

Codex 可讀取每個專案的隔離 workspace，以及已安裝且明確列入 allowlist 的模組目錄。模組目錄預設唯讀，只有專案 workspace 可寫。

## 4. Codex 與圖片生成

預定分工如下：

- Codex：理解需求、解析與檢索資料、執行 Web Search、生成 `PresentationBrief`、大綱、`SlideSpec` 與圖片提示詞。
- Image provider：實際生成或修改投影片圖片。

初期希望使用 Codex 方案內含的圖片生成能力，但不把「免費生成」當成平台承諾。官方資料顯示，Codex 內建圖片生成會消耗一般 Codex 使用額度；程式化的大量生成則可能需要 Image Generation API。

因此，Milestone 0 必須先完成技術驗證：

- Node server 能透過 Codex 觸發單頁圖片生成。
- 能傳入風格圖與內容參考圖。
- 能可靠取得生成圖片與執行紀錄。
- 中斷後能判斷工作成功或失敗。
- 能驗證連續多頁生成及使用額度限制。
- 若無法穩定自動化，改用 Image API provider，不阻塞其他核心架構。

參考：

- [Codex Image generation](https://learn.chatgpt.com/docs/image-generation.md)
- [Codex Pricing](https://learn.chatgpt.com/docs/pricing.md)
- [Codex Web Search](https://learn.chatgpt.com/docs/web-search.md)

## 5. 簡報資料模型

每頁最終成品是完整生成的圖片，包含文字。第一版不要求把文字、圖表或圖形拆成可編輯物件。

圖片不能是唯一的資料來源。每頁仍須保存結構化 `SlideSpec`，至少包含：

- 頁面目的
- 自由形式的內容描述
- 敘事順序
- 構圖提示 `layoutHint`
- 圖表或數據依據
- 圖片生成提示詞
- 使用的風格及其版本
- 使用的來源
- 當前圖片
- 歷史版本

Codex 所產生的 `PresentationBrief`、大綱、`SlideSpec`、引用與生成計畫都必須符合版本化 schema。library 使用 Zod 驗證；驗證失敗時先嘗試讓 Codex 修復。未驗證的自由文字輸出不得直接寫入正式專案狀態。

第一版不設固定的頁面類型或 enum。模型在生成大綱時自由決定每頁的目的與構圖。

## 6. 專案格式與儲存

標準專案格式採可攜式結構：

- `project.json`：簡報、頁面、來源、風格、版本與任務資料。
- `assets/`：上傳文件、抽取素材、生成圖片及必要快照。
- `.slide-project`：將完整專案打包成 ZIP，以便分享與重新開啟。

library 必須提供讀取、驗證、遷移、儲存與打包 API。

檢索索引是衍生快取，可以刪除並重建，不是專案的核心真相。

## 7. 建立簡報流程

使用者只需輸入一句主題或需求即可開始。以下欄位皆為可選：

- 目標觀眾
- 簡報目的
- 語言
- 預計頁數
- 演講時間
- 語氣
- 參考資料
- 風格資產

Codex 先產生 `PresentationBrief` 並顯示推定值供使用者修改，再執行以下流程：

1. 解析參考資料。
2. 產生簡報大綱與各頁 `SlideSpec`。
3. 使用者確認或修改頁數、順序與內容。
4. 平行生成各頁圖片。
5. 使用者逐頁重生、修改或回復版本。
6. 匯出結果。

可提供「一鍵完成」，但底層仍使用相同的可暫停、可恢復任務流程。

## 8. 內容與 Web Search

內容模式預設為 `creative`，允許 Codex 根據模型知識與 Web Search 補充敘事。另提供 `grounded` 模式，要求事實、數字與結論由來源支持。

Web Search 行為：

- 預設使用 Codex `cached` 搜尋。
- 使用者可改用 `live` 搜尋處理新聞、價格、法規等時效性內容。
- 使用者可完全關閉搜尋。
- 搜尋結果會轉換成標準來源，保存 URL、標題、擷取時間及引用關聯。
- 網頁內容一律視為不可信資料，其中的指令不得控制 Codex 或平台行為。

## 9. 參考資料與來源管理

第一版支援本機上傳：

- PDF
- PPTX
- DOCX
- Markdown
- 純文字
- PNG
- JPG

Google Drive、Notion、網頁爬取與雲端同步不在第一版範圍；之後可透過新的 `SourceProvider` 加入。

每個來源可以設定用途：

- `content`：事實與內容依據
- `visual-reference`：畫面或構圖參考
- `style-reference`：只影響視覺風格
- `direct-asset`：允許直接放入投影片
- `exclude-from-generation`：保存但不送入模型

預設文件用途為 `content`，圖片用途為 `visual-reference`。只有使用者明確允許時，才直接重用原始圖片。

來源管理器包含：

- 上傳、重新命名、分類、搜尋、預覽與刪除
- 顯示解析及索引狀態
- 顯示處理錯誤
- 管理來源用途與模型傳送權限
- 顯示哪些大綱或頁面使用該來源
- 查看抽取文字、圖片及網頁 metadata
- 刪除被引用來源前提出警告

已生成頁面的歷史版本須保留來源快照，不能因原始來源刪除而失去追蹤資訊。

每頁保存使用過的文件、頁碼、段落或網頁，並可選擇在 PPTX 的講者備註中輸出來源。

## 10. 檢索

第一版目標支援單一專案約 100 個來源檔案，預設總量上限可先設定為約 1 GB。

檢索設計：

- 提供可替換的 `Retriever` 介面。
- 預設使用本機 SQLite FTS 全文索引。
- 文件解析後切塊，為每段建立穩定的 source ID。
- 先檢索相關片段，再交給 Codex 規劃大綱或單頁內容。
- 索引為可重建快取。
- Embedding 與向量檢索是選用 provider，不作為第一版必要依賴。

第一版不建立跨專案企業知識庫。

## 11. 風格管理

`StylePreset` 是正式、結構化且版本化的一級資料模型，不只是提示詞。內容可包含：

- 色盤
- 字體與字體感
- 留白與版面密度
- 圖像風格
- 禁止事項
- 生成提示模板
- Logo
- 背景
- 參考圖片
- 可選的風格基準圖或 style board

風格基準圖是一項可選資產：使用者可以上傳；未提供時，系統可以協助生成。

風格繼承包含：

- 全域預設
- 專案覆寫
- 單頁覆寫

風格庫保存在本機 Node server 端，透過可替換的 `StyleRepository` 管理。建立專案時，將所選風格的不可變版本快照存入專案。修改 server-side 全域風格時，不會默默改變舊專案；使用者可以明確重新套用新版，並選擇要重新生成的頁面。

## 12. 圖片 Provider 能力

每個 `ImageProvider` 必須宣告 capabilities，例如：

- 整頁生成
- 參考圖生成
- 圖片編輯
- 遮罩局部重繪
- 多張參考圖
- 支援尺寸
- 是否回傳 seed 或其他可重現參數

核心流程只強制要求整頁生成。編輯器只顯示目前 provider 確實支援的其他操作。

所有 provider 設定直接使用進階介面，不另外建立快速、平衡、高品質等簡化模式。provider 可提供自己的設定 schema 與 UI 欄位。

## 13. 編輯器

第一版採頁面工作流，不做 PowerPoint 式自由畫布：

- 左側：頁面縮圖、拖曳排序、複製與刪除。
- 中央：目前投影片預覽。
- 右側：頁面意圖、提示詞、風格、來源與生成操作。
- 側欄或底部：版本歷史。
- 可逐頁重生。
- provider 支援時才顯示局部重繪。

不做任意圖層、物件拖拉、對齊工具或圖片內文字直接編輯。

## 14. 版本管理

第一版只做單頁不可變版本歷史：

- 每次生成、重生或修改都建立新版本。
- 保存圖片、提示詞、模型、參數、風格版本、來源與時間。
- 版本可以比較、命名與回復。
- 回復會建立新狀態，不刪除後續歷史。
- 不做整個專案的分支與合併。

## 15. 任務佇列

每一頁生成都是獨立、可持久化的 job。狀態至少包含：

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

工作結果應立即寫入專案，不等待整套簡報完成。重開專案後可以重試未完成或失敗的頁面；尚未執行的工作可以取消。並行數由 provider 設定限制。

## 16. 尺寸與輸出

第一版只保證 16:9 投影片品質，預設輸出 1920×1080。專案模型仍保存寬高比與解析度，並為 4:3、直式與自訂尺寸保留擴充點。

生成後需統一裁切或補邊到標準畫布。

第一版正式輸出：

- `.pptx`：每頁使用全版圖片，可附講者備註及來源。
- `.pdf`
- 每頁 `.png` 的 ZIP。
- `.slide-project`

第一版 PPTX 是圖片式簡報，不承諾圖片內文字、圖表或圖形可編輯。未來可使用保存的 `SlideSpec` 發展物件化重建。

Google Slides、Keynote、影片與公開分享連結不在第一版範圍。

## 17. 安全、隱私與憑證

- 專案與來源預設保存在本機。
- 執行生成時，可以把必要內容送往使用者選擇的模型 provider。
- UI 必須顯示或說明哪些資料會送往模型。
- 核心 library 不應偷偷上傳遙測或文件。
- API key 不得寫入 `project.json` 或 `.slide-project`。
- 憑證由本機 server 的環境變數或使用者層級 secret store 提供。
- job 紀錄與錯誤訊息必須遮蔽敏感值。
- Codex 子程序只取得當次工作需要的憑證。

第一版不承諾完全離線，但 provider 架構允許未來加入本機模型。

## 18. 明確不做的功能

MVP 不包含：

- 帳號系統
- 權限管理
- 多人協作
- 即時共同編輯
- 雲端專案同步
- 外掛市場或 runtime plugin 安裝
- 固定頁面類型
- PowerPoint 式物件編輯
- 圖片內文字直接編輯
- 分層或完全可編輯 PPTX
- 跨專案企業知識庫
- Google Slides 或 Keynote 匯出

## 19. MVP 完成標準

當使用者能完成以下完整流程時，MVP 視為完成：

1. 在本機 Node server 與 React UI 中建立專案。
2. 輸入一句需求並取得可修改的 `PresentationBrief`。
3. 上傳、管理及檢索最多約 100 份參考資料。
4. 使用 Codex Web Search 補充內容。
5. 建立或選擇 server-side `StylePreset`。
6. 產生並修改大綱與每頁 `SlideSpec`。
7. 批次生成一套 16:9 全圖片簡報。
8. 逐頁重生、查看來源並回復歷史版本。
9. 中斷後恢復未完成工作。
10. 匯出 PPTX、PDF、PNG ZIP 與 `.slide-project`。
11. 以靜態安裝方式加入新的 provider、source parser、retriever、storage 或 exporter。

## 20. 首要技術風險

目前最大的技術風險是 Codex 方案內圖片生成能否被本機 Node server 穩定、批次且可恢復地自動化。此項風險必須在其他大規模建置前，以 Milestone 0 spike 驗證。

若 spike 失敗，平台架構不變，只將預設圖片實作切換成 Image Generation API provider。

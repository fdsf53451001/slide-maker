# Slide Maker

**本機優先、以圖像為單位的簡報生成工具。** Slide Maker 把一份需求說明、你自己的素材文件，以及可重複使用的視覺風格，變成一整份簡報——每頁是一張由你指定的影像模型生成的圖片——並提供以「頁」為中心的編輯器，讓你檢視、重生成、局部修圖與匯出。

一切都跑在你的機器上：Express API 與 React 編輯器由同一個 port 提供，專案、風格、版本與工作佇列都以純檔案存在 `.data/` 底下。

English documentation: [README.md](README.md)

---

## 為什麼是「圖像式」簡報

傳統簡報生成器輸出的是圖形與文字框，視覺品質天花板就是版型能表達的範圍。Slide Maker 改為把每一頁視為**一張 1920×1080 的圖片**，由影像模型依照一份 provider 中立的合約產出，所以版面可以長成設計師會畫的任何樣子；而模型不該自己畫的東西（頁碼、可編輯文字）則由系統事後合成疊上去。

代價是刻意選擇的：頁面就是像素，所以修改靠的是重新生成、遮罩編輯，或抽出的文字層——而不是拖拉文字框。

## 功能

**製作流程**

- 兩段式且會持久化的流程：**需求 → 大綱**，再來 **設定 → 生成簡報**。確認後的大綱決定頁數；確認第二步會一次把每一頁排入生成佇列。
- 由模型撰寫大綱，可選擇搭配即時網路搜尋；每一筆引用都必須來自「正文真的抓得到」的網頁——模型自己寫的搜尋摘要不算已驗證來源。
- 每頁可編輯標題、條列、講稿備註、版面意圖，以及該頁要用哪些素材。
- 頁面新增、複製、刪除與拖曳排序。

**素材來源**

- 可上傳 PDF、PPTX、DOCX、Markdown、純文字、PNG 與 JPEG。文字會在專案本機抽取成穩定的 chunk（PDF 抽取在能判別表格框線時，會把表格還原成 Markdown pipe table）。
- 以 SQLite FTS5（trigram tokenizer）對 chunk 做全文檢索，索引每次啟動時從專案重建。
- 網頁來源在能被引用之前，會先經過共用的網址安全檢查再抓取。

**風格**

- 伺服器端的風格庫，版本不可變，可複製與還原。
- 支援參考圖，包含「把 PDF 前幾頁抓成風格縮圖」。
- 風格分析：把上傳的參考圖轉成風格 preset。
- 每個專案帶著自己的**風格快照**，之後改風格不會動到已經生成的簡報。

**生成**

- 每頁一個持久化 job，具備 provider 併發上限、取消、當機復原與批次生成。跟著伺服器一起死掉的 job 會在下次啟動時被重新分類（`SERVER_SHUTDOWN`／`SERVER_RESTARTED`），不會永遠卡著。
- 每頁的圖片歷史不可變：每次生成、編輯與還原都是新版本，可以隨時切回去；版本可刪除並回收其資產。
- 在 transport 支援的前提下，提供遮罩編輯（「只改這一塊」）與指令式編輯。

**從像素回到文字**

- **抽出文字**：以 PaddleOCR 找出生成頁面上的文字，把文字提升成可編輯的 DOM 層，背景則做 inpaint——預設走本機 OpenCV inpaint（快、零配額），也可以改由影像模型以遮罩編輯處理。
- **PDF 匯入簡報**：把既有的 16:9 PDF 匯入成專案，全程**零模型**。文字取自 PDF 自己的文字層，乾淨背景則靠「過濾掉文字 operator 後二次渲染」取得。每頁會同時建立兩個版本——未經修改的原圖，以及可編輯文字的版本——所以你永遠可以退回像素級保真的原稿。

**頁面裝飾與匯出**

- 專案級頁碼由系統合成，而非模型畫上去：位置、格式（`7`、`7 / 20`、`第 7 頁`）、起始數字、封面不編號、字級、顏色、透明度，以及可選的底色塊。畫布 overlay、匯出圖片與 PPTX 文字框三端共用同一份幾何模組，所以結果一致。
- 可匯出 **PPTX**、**PDF**、依序命名的 **PNG ZIP**，或可攜的 **`.slide-project`** 封存檔（能匯入到另一個實例）。需要保真的地方保留無損 PNG；PPTX／PDF 內嵌 quality-88 4:4:4 JPEG 以控制檔案大小。
- 編輯器內建簡報模式。

**Provider**

- 預設是確定性的 **mock** 影像 provider：不連網、不吃配額，開發與測試都靠它。
- 正式 transport 涵蓋 OpenAI 相容端點（CLIProxyAPI、OpenAI、LiteLLM、OpenRouter⋯）、Gemini 原生（AI Studio），以及實驗性的 Codex app-server。
- UI 內建**模型庫**：連線（base URL + key + protocol）、依能力分開的模型 entry（影像／文字／搜尋），以及可綁定到專案的具名組合。API key 在讀取時會被遮蔽。
- 成本最低的實用組合是本機 CLIProxyAPI 搭 `gpt-image-2`，見[串接模型 provider](#串接模型-provider)。

## 環境需求

|          |                                                                       |
| -------- | --------------------------------------------------------------------- |
| Node.js  | **24 以上**——搜尋索引使用內建的 `node:sqlite`                         |
| pnpm     | **10.13.1**（版本固定；用 `npx pnpm@10.13.1` 就不必全域安裝）         |
| 作業系統 | macOS 或 Linux（`sharp` 與 `@resvg/resvg-js` 會下載預編譯的原生模組） |
| Python   | 選用，**3.9–3.12**，只有 OCR／本機 inpaint 才需要                     |

不需要任何 API key 就能啟動：mock provider 離線就能產出確定性的頁面。

## 快速開始

```bash
npx pnpm@10.13.1 install
npx pnpm@10.13.1 dev
```

開啟 <http://localhost:4173>。本機伺服器同時提供 React 編輯器與 API。`pnpm dev` 是長時間執行的程序，會一直佔著終端機直到你停掉它（`Ctrl+C`）；啟動訊息會告訴你哪些 provider 可用，而且不會印出任何憑證。

只想改 UI 的話，另開一個終端機跑 `pnpm dev:web`，改開 Vite 的網址。

專案資料預設寫在 `.data/`（可用 `SLIDE_MAKER_DATA_ROOT` 覆寫），並刻意被 Git 忽略。

### 選用：OCR 與本機 inpaint

只有對生成頁面做「抽出文字」時才需要，PDF 匯入簡報用不到。

```bash
pnpm setup:ocr     # 建立 .venv-ocr，安裝 paddlepaddle + paddleocr，並預先下載模型權重
```

腳本會挑選現有最新的 `python3.12`⋯`python3.9`。裝完重啟伺服器；`GET /api/ocr/status` 會回報可用狀態。

## 串接模型 provider

有四種方式可以把影像模型接上 Slide Maker，差別在成本、設定成本與能拿到哪些能力。

| #   | 串接方式                                                                            | 設定                               | 適用                                |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------- |
| 1   | **Mock provider**（預設）                                                           | 不用設定                           | 開發、測試、離線試流程              |
| 2   | **OpenAI 相容 gateway**——CLIProxyAPI（CLI2Proxy）、LiteLLM、OpenRouter、OpenAI 官方 | 起一個 gateway，UI 建一條連線      | **實際做簡報的推薦做法**            |
| 3   | **Gemini AI Studio 原生**                                                           | 一把 AI Studio API key             | 不經 gateway 直接用 Gemini 影像模型 |
| 4   | **Codex CLI app-server**                                                            | 本機已登入的 Codex CLI，並開啟旗標 | 實驗性質，請先看安全性說明          |

### 推薦：CLIProxyAPI + `gpt-image-2`

**成本最低又能產出像樣簡報**的組合，是本機 **CLIProxyAPI（CLI2Proxy）** gateway 搭 **`gpt-image-2`**，走 Images API transport。它沿用你既有的 CLI 訂閱，而不是按張數計費的 API；而 `gpt-image-2` 在 `/images/generations` + `/images/edits` 上涵蓋完整功能面——生成、參考圖（以 edit 端點的 `image[]` 陣列傳入）與遮罩編輯。

在模型庫建立：

- **連線**——protocol 選 `openai`，base URL 填 `http://localhost:8317/v1`（你的 gateway 實際監聽位址），API key 依設定填入。
- **影像模型**——kind `openai`、model `gpt-image-2`、image API 選 `images`。
- **文字／搜尋模型**——指到同一條連線，或維持走 Codex。
- **組合**——把三者綁成一組並設為預設。

若偏好用設定檔起手，等效的首次啟動環境變數：

```bash
SLIDE_MAKER_OPENAI_BASE_URL=http://localhost:8317/v1 \
SLIDE_MAKER_OPENAI_API_KEY=... \
SLIDE_MAKER_OPENAI_IMAGE_MODEL=gpt-image-2 \
SLIDE_MAKER_OPENAI_IMAGE_API=images \
SLIDE_MAKER_OPENAI_TEXT_MODEL=... \
pnpm dev
```

有理由時再換 transport：`chat` 走 GPT tool image 或原生 `gemini-3.1-flash-image`（最多 8 張有序參考圖）、`openrouter-image` 走 OpenRouter 的 `/images` 形狀，或改用 Gemini 原生 provider 以取得 Gemini 影像模型與 Google Search grounding。

## 設定模型

UI 是主要途徑。在編輯器打開**模型庫**，依序建立：

1. **連線**——base URL、API key，以及 protocol（OpenAI 相容一律選 `openai`，AI Studio 原生端點選 `gemini`）；
2. **模型**——每個能力（`image`、`text`、`search`）各一筆 entry，各自引用一條連線；
3. **組合**——影像＋文字＋搜尋各挑一個，綁到專案或設為預設。

設定存於 `SLIDE_MAKER_DATA_ROOT/models.json`，該檔一旦存在就是唯一真相。環境變數只在該檔不存在時於首次啟動 seed 一次，之後再改環境變數不會有任何效果——請改在 UI 編輯模型庫。

> `models.json` 以明文保存 API key，請據此保護資料目錄。

### 影像 transport

所有 transport 共用 `@slide-maker/core` 裡那份 provider 中立的 **Codex-baseline 影像合約**：畫布、完整投影片欄位、風格快照、資訊密度、編輯／遮罩語意、有序的參考圖角色、直接素材保真度、不可信資料邊界，以及「模型不得自己畫頁面裝飾」的明文禁令。adapter 只補上自己的呼叫方式與回應格式規則；每一張被接受的點陣圖都會正規化成畫布尺寸的 PNG。

| Transport                 | 模組                                | 端點                                   | 範例模型                                  | 參考圖                           |
| ------------------------- | ----------------------------------- | -------------------------------------- | ----------------------------------------- | -------------------------------- |
| OpenAI Images API（預設） | `provider-openai/src/image-api.ts`  | `/images/generations`、`/images/edits` | `gpt-image-2`                             | 走 `/images/edits`，支援遮罩編輯 |
| OpenAI 相容 Chat          | `provider-openai/src/image-chat.ts` | `/chat/completions`                    | `gpt-5.6-terra`、`gemini-3.1-flash-image` | 支援，有序，最多 8 張            |
| OpenRouter images         | `provider-openai`                   | `/images`                              | 依供應商而定                              | 支援，走 `input_references`      |
| Gemini 原生               | `@slide-maker/provider-gemini`      | `:generateContent`                     | `gemini-2.5-flash-image`                  | 支援，有序 inline data           |
| Codex app-server          | `@slide-maker/provider-codex`       | Codex CLI app-server                   | 所設定的 Codex 影像模型                   | 支援                             |
| Mock                      | `@slide-maker/provider-mock`        | 無                                     | —                                         | —                                |

實測得到的注意事項：

- Google 的 **OpenAI 相容層不能用來生圖**：它無法序列化影像輸出、沒有 `/images/edits`，也拒絕所有 Google Search grounding 語法。請改用 Gemini 原生 provider。
- Gemini 沒有獨立的 edit／mask 端點——遮罩就是「再多送一張圖」，語意全由影像合約承擔。
- `gemini-3-flash-agent` 在這條流程裡不算可用的影像輸出模型。

### 文字與網路搜尋

文字生成與網路搜尋已經解耦：先由 `WebSearchProvider` 取得並驗證來源，再交給純推理的 `StructuredTextProvider`。非嚴格的 gateway（尤其 Gemini 系）不遵守 `json_schema`，所以這些 provider 會加上 JSON-only 的 system 指令並寬鬆解析。

### 環境變數

伺服器的環境變數全部定義在 `apps/server/src/config.ts`，並於啟動時驗證——非法值會直接 throw，而不是安靜降級。

| 變數                                                                                                                   | 用途                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `PORT`、`HOST`                                                                                                         | 監聽位址（預設 `127.0.0.1:4173`）                                                      |
| `SLIDE_MAKER_DATA_ROOT`                                                                                                | 專案資料目錄（預設 `.data/`）                                                          |
| `SLIDE_MAKER_SEARCH_INDEX_PATH`                                                                                        | 把 SQLite FTS 索引移出資料目錄                                                         |
| `SLIDE_MAKER_TRUSTED_HOSTS`                                                                                            | 額外放行的主機名；未設時只服務 localhost                                               |
| `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX`                                                                                | 設 `1` 才啟用 Codex 影像 provider（見下方說明）                                        |
| `SLIDE_MAKER_CODEX_TIMEOUT_MS`                                                                                         | 30 000 – 1 800 000，預設 600 000                                                       |
| `SLIDE_MAKER_CODEX_MAX_CONCURRENCY`                                                                                    | 1 – 4，預設 3                                                                          |
| `SLIDE_MAKER_CODEX_MODEL`、`SLIDE_MAKER_CODEX_REASONING_EFFORT`                                                        | 覆寫 Codex CLI 自身的模型與推理強度設定                                                |
| `SLIDE_MAKER_OPENAI_BASE_URL`、`_API_KEY`、`_IMAGE_MODEL`、`_TEXT_MODEL`、`_SEARCH_MODEL`、`_IMAGE_API`、`_TIMEOUT_MS` | OpenAI 相容端點的首次啟動 seed                                                         |
| `SLIDE_MAKER_TEXT_ENGINE`、`SLIDE_MAKER_WEB_SEARCH_ENGINE`                                                             | `codex`（預設）或 `openai`                                                             |
| `SLIDE_MAKER_OCR_MODEL_TIER`、`_OCR_DET_SIDE_LEN`、`_OCR_PYTHON`、`_OCR_SCRIPT`                                        | PaddleOCR 層級（`tiny`／`small`／`medium`，預設 `medium`）、偵測邊長、直譯器與腳本路徑 |
| `SLIDE_MAKER_INPAINT_PYTHON`、`_INPAINT_SCRIPT`                                                                        | 本機 OpenCV inpaint 的路徑                                                             |
| `SLIDE_MAKER_LOG_EGRESS_IP`                                                                                            | 設 `1` 會在啟動時記錄對外 IP                                                           |

## 開發

```bash
pnpm install          # 沒裝 pnpm 就用 npx pnpm@10.13.1 install
pnpm dev              # 先建置所有套件，再於 :4173 啟動伺服器
pnpm dev:web          # 純 UI 開發用的 Vite dev server
pnpm check            # typecheck + test + build，完整驗證閘門
pnpm test             # 跑所有套件的 vitest
pnpm format           # Prettier
```

單一套件測試用 `pnpm --filter @slide-maker/server test`；單一測試檔用 `pnpm --filter @slide-maker/server exec vitest run test/config.test.ts`。

動手改之前有兩件事要知道：

- 開發模式依賴 `NODE_OPTIONS=--conditions=development` 搭配 tsconfig 的 `customConditions: ["development"]`，讓 workspace 套件解析到 `src/*.ts`。少了這個條件會安靜地解析到過時的 `dist/`。
- TypeScript 開啟 `noUncheckedIndexedAccess` 與 `exactOptionalPropertyTypes`：索引存取的結果會是 `undefined`，optional property 不可顯式指定 `undefined`。

`smoke:*` 腳本（`smoke:image:codex`、`smoke:deck:grok`⋯）是**live** 端對端測試，會消耗真實模型配額，因此刻意排除在 `pnpm check` 之外。

## 專案結構

pnpm monorepo，內部相依用 `workspace:*`。

| 套件                       | 職責                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `apps/server`              | Express 5 API、job runner、匯出器、OCR／inpaint 橋接、PDF 流程        |
| `apps/editor`              | React 19 + Vite 編輯器。雙重 build：獨立 app 與可嵌入的 library       |
| `packages/core`            | zod schemas、專案 helper、provider 合約、影像合約、頁碼幾何、網址安全 |
| `packages/provider-mock`   | 確定性、零成本的影像 provider（預設）                                 |
| `packages/provider-openai` | OpenAI 相容的影像／結構化文字／網路搜尋 adapter                       |
| `packages/provider-gemini` | Gemini AI Studio 原生 `:generateContent` adapter                      |
| `packages/provider-codex`  | 實驗性 Codex app-server，pin 協定 `0.144.4`                           |

凡是三端必須取得共識的東西——影像語意、頁碼幾何、網址安全——`packages/core` 就是唯一真相，不要在 adapter 裡另寫一份。

### 嵌入編輯器

`@slide-maker/editor` 也會建置成 library：

```tsx
import { Editor, ModelLibrary } from "@slide-maker/editor";
import "@slide-maker/editor/styles.css";

export default function App() {
  return <Editor />;
}
```

編輯器以同源的相對路徑呼叫 API，所以必須與 `apps/server` 由同一個 origin 提供。React 19 是 peer dependency。

## 部署

`infra/` 內含把服務部署到 Cloud Run 的 Terraform，資料目錄以 gcsfuse 掛載 Cloud Storage bucket，前面擋 IAP，規模設定為「少數受信任使用者共用一份資料」。其中幾項設定——單一 instance、CPU 恆常配置、bucket 必須開 hierarchical namespace——是正確性要求，而非可調參數。

完整步驟與踩雷紀錄見 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

## 安全性說明

- 除非你在 `SLIDE_MAKER_TRUSTED_HOSTS` 明確列出主機名，API 會拒絕任何非 localhost 的請求（`LOCAL_HOST_REQUIRED`）。它本身沒有任何身分驗證——要對外開放請在前面擺一層 proxy。
- API key 以明文存在資料目錄的 `models.json`。
- **Codex 影像 provider 預設關閉**（需 `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1`），而且提供的是**軟隔離，不是安全邊界**。它 pin 實驗性的 Codex `0.144.4` app-server 協定，並要求唯讀檔案系統政策、不需核可、關閉該回合的網路存取與 ephemeral thread，拒絕檔案變更、MCP 呼叫、非 `exec` 的動態工具、網路搜尋、非預期的回應政策與無法對應的事件。即便如此，app-server 仍會載入真正的 `CODEX_HOME` 設定與工具面，所以惡意的參考素材或 prompt 依然可能造成 prompt injection、本機資料外洩、既設工具的副作用或配額消耗。請只在沒有機密、沒有特權工具的拋棄式帳號或容器裡執行。
- 模型輸出一律視為不可信：Codex 的結果必須是 job 工作目錄內、非符號連結的一般 PNG 檔，並檢查大小、尺寸、chunk 邊界、必要的 IHDR/IDAT/IEND chunk 與 CRC，之後重新渲染成精確的 1920×1080 並再驗一次。素材文件與網頁在 prompt 中都被標記為不可信資料。

## 授權

[Apache-2.0](LICENSE)。

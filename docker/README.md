# Docker 部署（推薦做法）

一份 `docker compose` 同時起 **Slide Maker** 與 **CLIProxyAPI（CLI2Proxy）**，用你既有的
**ChatGPT／Codex 訂閱額度**生圖與寫大綱，而不是按張計費的 API key。

CLIProxyAPI 的角色是：把 Codex CLI 那套 OAuth 登入態，包成一個 OpenAI 相容端點
（`/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits`）。Slide Maker 只知道
自己在跟一個 OpenAI 相容 gateway 說話，額度則記在你的訂閱上。

---

## 前置需求

| 項目            |                                                                                  |
| --------------- | -------------------------------------------------------------------------------- |
| Docker          | 含 Compose v2（`docker compose`，不是舊的 `docker-compose`）                     |
| 訂閱            | 一個能登入 Codex 的 ChatGPT 帳號                                                 |
| 磁碟            | 約 6 GB：Slide Maker 映像含 PaddleOCR 與模型權重                                 |
| 首次 build 時間 | 10–25 分鐘（裝依賴、`pnpm -r build`、下載 OCR 權重），之後改程式碼只重跑最後幾層 |

映像會用**你機器的原生架構**建置（Apple Silicon 就是 arm64），不需要跨架構模擬。
`eceasy/cli-proxy-api` 同時有 amd64 與 arm64。

---

## 四個步驟

### 1. 準備 gateway 設定

```bash
cp docker/cliproxy/config.example.yaml docker/cliproxy/config.yaml
```

> 這一步不能跳過。Docker 對「來源不存在」的 bind mount 會**建一個同名目錄**，
> CLIProxyAPI 讀設定時看到目錄就會啟動失敗。

想換掉預設的 api-key（`slide-maker-local`）現在就改，並在 `.env` 的 `CLI_PROXY_API_KEY`
填同一把（`cp .env.example .env`）。兩邊不一致的話 gateway 回 401，而 Slide Maker 那頭
只會顯示「生成失敗」。

### 2. 登入 Codex

```bash
docker compose --profile login run --rm --service-ports codex-login
```

終端機會印出一段 `https://auth.openai.com/oauth/authorize?...` 授權網址——貼到你自己的
瀏覽器完成授權。OAuth 會 callback 回 `localhost:1455`，由 compose 轉進容器。完成後容器
自己結束，憑證留在 `docker/cliproxy/auths/`（**等同你的登入態，不要提交、不要外流**）。

它同時會印一段「To authenticate from a remote machine, an SSH tunnel may be required」
連同 `ssh -L 1455:...` 指令。那是給「Docker 跑在遠端伺服器」的情境用的，在自己機器上
跑可以直接忽略。

刪掉 `docker/cliproxy/auths/` 等於登出，重跑這個指令即可。

**已經有一份 CLIProxyAPI 在跑的話**（步驟 3 會以 `Bind for 127.0.0.1:8317 failed: port is
already allocated` 失敗），把舊的憑證搬過來就不必重新授權：

```bash
docker stop <舊容器名>                                   # 讓出 8317
cp -R /path/to/CLIProxyAPI/auths/. docker/cliproxy/auths/  # 沿用登入態
```

不想動舊的那份，就讓 compose 換一個 port（`.env` 的 `CLI_PROXY_PORT=18317`）。注意
Slide Maker 走的是 compose 內部網路，不受這個 port 影響——它連的一直是
`http://cli-proxy-api:8317/v1`。

### 3. 起服務

```bash
docker compose up -d --build
```

```bash
docker compose logs -f slide-maker    # 看啟動狀態
docker compose ps                     # 健康檢查結果
```

驗證 gateway 真的接上了訂閱（順便看看實際可用的模型 slug）：

```bash
curl -H "Authorization: Bearer slide-maker-local" http://localhost:8317/v1/models
```

- 回 `401` → api-key 不對（見步驟 1）。
- 回 `{"data":[],"object":"list"}` → key 對了，但**還沒登入**（gateway 啟動 log 會寫
  `0 clients`）。回到步驟 2。
- 回一長串含 `gpt-image-2`、`gpt-5.6-*` 的清單 → 成功。

### 4. 把影像模型接上

開 <http://localhost:4173>，進**模型庫**。首次啟動已經 seed 好一條指向 gateway 的連線、
以及影像／文字／搜尋三個模型 entry，但**預設組合的影像模型是 mock**（離線用的確定性
假圖）——這是刻意的保底，你必須手動改：

> 模型庫 → 組合 → 預設組合 → 影像模型改成「OpenAI 影像」 → 儲存

不改的話簡報照樣生得出來，只是每一頁都是 mock 圖。

---

## 之後怎麼改設定

`docker-compose.yml` 裡那幾個 `SLIDE_MAKER_OPENAI_*` 變數**只在 `models.json` 還不存在時
seed 一次**。該檔一旦寫出來就是唯一真相，之後改環境變數不會有任何效果——請改在 UI 的
模型庫裡編輯（base URL、key、模型名、超時都在那裡）。

其餘變數（port、OCR 層級、render 引擎、trusted hosts）每次啟動都會讀，改完
`docker compose up -d` 即可。

---

## 資料在哪裡

專案、風格、版本歷史、`models.json` 全在具名 volume `slide-maker-data`（容器內 `/data`）。

```bash
# 備份
docker run --rm -v slide-maker_slide-maker-data:/data -v "$PWD":/out \
  alpine tar czf /out/slide-maker-backup.tar.gz -C /data .

# 還原
docker run --rm -v slide-maker_slide-maker-data:/data -v "$PWD":/in \
  alpine tar xzf /in/slide-maker-backup.tar.gz -C /data
```

`docker compose down` 不會動到資料；`docker compose down -v` 會**連同專案一起刪掉**。

想改成看得見的目錄，把 compose 裡的 `slide-maker-data:/data` 換成 `./.data-docker:/data`
即可（Linux 上檔案會是 root 所有）。

---

## 更新

```bash
git pull
docker compose build slide-maker
docker compose pull cli-proxy-api
docker compose up -d
```

---

## 安全性

兩個 port 都只綁 `127.0.0.1`：

- **Slide Maker 沒有任何登入機制**，而資料目錄裡就是你的專案全文與來源檔案。
- **gateway 那個 port 背後是你的訂閱額度**，`config.yaml` 的 api-key 是唯一的門。

要從區網其他機器連，除了改 port 綁定，還得設 `SLIDE_MAKER_TRUSTED_HOSTS`（伺服器預設
只服務 localhost），並自行在前面補一層驗證。

`models.json` 以明文保存 API key，`docker/cliproxy/auths/` 是你的 OAuth 憑證——兩者都已
在 `.gitignore` 裡，但備份檔請比照辦理。

---

## 疑難排解

| 症狀                                      | 原因與處理                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| gateway 起不來，log 提到 config 是目錄    | 漏了步驟 1 的 `cp`。刪掉被自動建出來的 `docker/cliproxy/config.yaml` 目錄，改成複製檔案。                       |
| 生成失敗，gateway log 顯示 401            | `config.yaml` 的 `api-keys` 與 `.env` 的 `CLI_PROXY_API_KEY` 不一致；`models.json` 已存在時要改在 UI 的模型庫。 |
| 每一頁都是同樣風格的假圖                  | 預設組合的影像模型還停在 mock，見步驟 4。                                                                       |
| 生成失敗，訊息提到找不到模型              | 模型 slug 過期。用上面那行 `curl .../v1/models` 查實際清單，在模型庫改掉。                                      |
| 大綱一直失敗                              | 模型庫裡的文字模型沒指到 gateway 那條連線，或那個 slug 已經不在 `/v1/models` 清單裡。                           |
| 網路搜尋沒有結果                          | 搜尋能不能用取決於 gateway／模型有沒有接 `web_search` 工具，不保證普遍可用。做大綱時不勾網路搜尋即可。          |
| `port is already allocated`（8317／1455） | 你已經有一份手動跑的 CLIProxyAPI。停掉它並搬憑證，或改 `CLI_PROXY_PORT`——見步驟 2 末段。                        |
| `/v1/models` 回空陣列                     | key 對了但還沒登入（gateway log 會寫 `0 clients`）。回步驟 2。                                                  |
| 生圖逾時                                  | 調大 `SLIDE_MAKER_OPENAI_TIMEOUT_MS`（上限 1800000）。已 seed 過的話改模型庫裡那條連線的超時。                  |
| 抽出文字很慢                              | PaddleOCR 走 CPU，medium 層級每頁 6–8 秒。可把 `SLIDE_MAKER_OCR_MODEL_TIER` 改 `small`。                        |

---

## 不用 Docker 的話

本機開發流程見 [README.zh-TW.md](../README.zh-TW.md)：`pnpm install && pnpm dev`，
gateway 自己另外跑一份即可（base URL 改成 `http://localhost:8317/v1`）。

# syntax=docker/dockerfile:1.7
#
# Cloud Run（linux/amd64）用的映像。分層原則：變動最少的放最前面，讓改程式碼
# 只重跑最後一層——這在本機 buildx 跨架構模擬下是唯一能忍受的做法。
#
# 建置：docker buildx build --platform linux/amd64 -t <IMAGE> --push .

########################################
# 1. 依賴層：只有 manifest 變動才會重跑
########################################
FROM node:24-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# .npmrc 有 manage-package-manager-versions=false，corepack 不會代管，明確裝版本。
RUN npm install -g pnpm@10.13.1
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/editor/package.json apps/editor/
COPY packages/core/package.json packages/core/
COPY packages/provider-mock/package.json packages/provider-mock/
COPY packages/provider-codex/package.json packages/provider-codex/
COPY packages/provider-openai/package.json packages/provider-openai/
COPY packages/provider-gemini/package.json packages/provider-gemini/
# 新增 workspace 套件時，這份清單必須跟著加一行——漏掉的話 pnpm install 不認得該
# 套件，node_modules 不會建立，直到 `pnpm -r build` 才以「Cannot find module」爆掉。
# `pnpm check` 涵蓋不到映像建置，本機全綠也擋不住。
# --store-dir 必須明講：pnpm 預設 store 在 ~/.local/share/pnpm/store，
# 不指過來的話下面這個 cache mount 等於沒作用。
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

########################################
# 2. 建置層：tsc + vite
########################################
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
# pnpm -r 依拓撲順序建置：core → providers → editor → server。
RUN pnpm -r build

########################################
# 3. OCR 層：PaddleOCR venv，模型權重在 build 時抓好
########################################
FROM node:24-bookworm-slim AS ocr
# libgomp1 給 paddlepaddle；libgl1/libglib2.0-0 給 paddleocr 依賴的 opencv。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip libgomp1 libgl1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/setup-ocr.sh scripts/setup-ocr.sh
COPY scripts/paddle_ocr.py scripts/paddle_ocr.py
# setup-ocr.sh 的 --self-test 會把模型權重下載到 $HOME/.paddlex，一併烘進映像；
# 少了這步，雲端第一次 OCR 請求會現場下載數百 MB 而逾時。
# mkdir 是為了讓下游的 COPY 一定有東西可抄：模型快取目錄名稱隨 PaddleOCR 版本
# 而異，缺任一個都會讓 COPY 在建置最後一刻失敗。
RUN sh scripts/setup-ocr.sh && mkdir -p /root/.paddlex /root/.paddleocr

########################################
# 4. 執行層
########################################
FROM node:24-bookworm-slim AS runtime
# fontconfig + Noto（含 CJK）給 server 端 SVG 文字渲染（text-layers.ts 的合成圖與
# OCR 字級幾何實測）用：slim 基底一套字型都沒有，中文會整片 tofu 方框，且字級
# 重解量到 tofu 寬度而全面失準。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv libgomp1 libgl1 libglib2.0-0 ca-certificates \
      fontconfig fonts-noto-core fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# runtime-paths.ts 以模組位置相對解析 editorDist（apps/server/dist/../../editor/dist），
# PaddleOcrAdapter 以 process.cwd() 找 .venv-ocr 與 scripts——所以 monorepo 目錄結構
# 與 WORKDIR=/app 都不能動。
WORKDIR /app
COPY --from=build /app /app
COPY --from=ocr /app/.venv-ocr /app/.venv-ocr
COPY --from=ocr /root/.paddlex /root/.paddlex
COPY --from=ocr /root/.paddleocr /root/.paddleocr
COPY scripts scripts

ENV NODE_ENV=production \
    # Cloud Run 要求監聽 0.0.0.0；index.ts 預設是 127.0.0.1，不覆寫會健康檢查失敗。
    HOST=0.0.0.0 \
    PORT=8080 \
    # 對應 Cloud Run 的 GCS volume mount。
    SLIDE_MAKER_DATA_ROOT=/data

EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]

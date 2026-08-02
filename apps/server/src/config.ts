interface BoundedIntegerEnvOptions {
  name: string;
  defaultValue: number;
  min: number;
  max: number;
  integerUnit?: string;
}

function parseBoundedIntegerEnv(
  value: string | undefined,
  { name, defaultValue, min, max, integerUnit = "" }: BoundedIntegerEnvOptions,
): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer${integerUnit}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

/**
 * 模型呼叫的預設逾時：連線自己沒設 `timeoutMs` 時的回退值，三家 provider 共用。
 * 上下限沿用原本 codex 通道的值（30 秒～30 分），那是實際跑過長簡報生成校準出來的。
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 10 * 60_000;
export const MIN_MODEL_TIMEOUT_MS = 30_000;
export const MAX_MODEL_TIMEOUT_MS = 30 * 60_000;

export function parseModelTimeoutMs(value: string | undefined): number {
  return parseBoundedIntegerEnv(value, {
    name: "SLIDE_MAKER_MODEL_TIMEOUT_MS",
    defaultValue: DEFAULT_MODEL_TIMEOUT_MS,
    min: MIN_MODEL_TIMEOUT_MS,
    max: MAX_MODEL_TIMEOUT_MS,
    integerUnit: " in milliseconds",
  });
}

// PP-OCRv6 的層級命名（tiny 1.5M／small 7.7M／medium 34.5M 參數）。
// medium 在 CPU 上實測 6–8 秒/頁（1920 全解析度），且辨識精度比 v5 server 高 5.1%，
// 空格、全形分隔線與繁體輸出都顯著改善，故為預設。
export const OCR_MODEL_TIERS = ["tiny", "small", "medium"] as const;
export type OcrModelTier = (typeof OCR_MODEL_TIERS)[number];
export const DEFAULT_OCR_MODEL_TIER: OcrModelTier = "medium";
// v5 時代的層級名（mobile／hybrid／server）映射到對應的 v6 層級，
// 讓已設定舊值的環境升級後照常啟動，而不是直接 throw。
const LEGACY_OCR_MODEL_TIERS: Record<string, OcrModelTier> = {
  mobile: "small",
  hybrid: "medium",
  server: "medium",
};
export const DEFAULT_OCR_DET_SIDE_LEN = 1920;
export const MIN_OCR_DET_SIDE_LEN = 512;
export const MAX_OCR_DET_SIDE_LEN = 4096;

export function parseOcrModelTier(value: string | undefined): OcrModelTier {
  if (value === undefined || value.trim() === "") return DEFAULT_OCR_MODEL_TIER;
  const legacy = LEGACY_OCR_MODEL_TIERS[value];
  if (legacy) return legacy;
  if (!(OCR_MODEL_TIERS as readonly string[]).includes(value))
    throw new Error(`SLIDE_MAKER_OCR_MODEL_TIER must be one of: ${OCR_MODEL_TIERS.join(", ")}`);
  return value as OcrModelTier;
}

export function parseOcrDetSideLen(value: string | undefined): number {
  return parseBoundedIntegerEnv(value, {
    name: "SLIDE_MAKER_OCR_DET_SIDE_LEN",
    defaultValue: DEFAULT_OCR_DET_SIDE_LEN,
    min: MIN_OCR_DET_SIDE_LEN,
    max: MAX_OCR_DET_SIDE_LEN,
  });
}

/** 永遠放行的主機名。這三個以外一律要靠 SLIDE_MAKER_TRUSTED_HOSTS 明確列出。 */
export const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "::1"] as const;

/**
 * 額外放行的主機名（逗號分隔），用於雲端部署。未設時回空陣列，行為與過去完全
 * 相同——本機開發的防護不因這個選項而改變。
 *
 * 刻意不接受萬用字元：這份白名單是 API 對外的唯一防線，放行範圍必須逐一寫死。
 */
export function parseTrustedHosts(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  if (hosts.length === 0)
    throw new Error("SLIDE_MAKER_TRUSTED_HOSTS must list at least one hostname when set");
  for (const host of hosts) {
    if (host.includes("*"))
      throw new Error(
        "SLIDE_MAKER_TRUSTED_HOSTS must not contain wildcards; list hostnames one by one",
      );
    if (!/^[a-z0-9._:-]+$/.test(host))
      throw new Error(`SLIDE_MAKER_TRUSTED_HOSTS contains an invalid hostname: ${host}`);
  }
  return hosts;
}

export const DEFAULT_OPENAI_TIMEOUT_MS = 120_000;
export const MIN_OPENAI_TIMEOUT_MS = 5_000;
export const MAX_OPENAI_TIMEOUT_MS = 30 * 60_000;

export const OPENAI_IMAGE_APIS = ["images", "chat", "openrouter-image"] as const;
export type OpenAiImageApi = (typeof OPENAI_IMAGE_APIS)[number];

/**
 * 影像端點型態：`images`（CLI2Proxy `/images/generations`＋`/images/edits`，gpt-image 系，預設）、
 * `chat`（CLI2Proxy `/chat/completions`，GPT tool / Gemini native）、`openrouter-image`
 * （OpenRouter 專用 `/images` 端點，`input_references` 帶參考圖）。
 */
export function parseOpenAiImageApi(value: string | undefined): OpenAiImageApi {
  if (value === undefined || value.trim() === "") return "images";
  if (!(OPENAI_IMAGE_APIS as readonly string[]).includes(value))
    throw new Error(`SLIDE_MAKER_OPENAI_IMAGE_API must be one of: ${OPENAI_IMAGE_APIS.join(", ")}`);
  return value as OpenAiImageApi;
}

/** OpenAI-compatible 端點根位址（http/https），未設回 undefined，非法值 throw。 */
export function parseOpenAiBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("SLIDE_MAKER_OPENAI_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("SLIDE_MAKER_OPENAI_BASE_URL must be an http(s) URL");
  return trimmed;
}

/** 非空字串（API key / 模型名），未設回 undefined。 */
export function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

export function parseOpenAiTimeoutMs(value: string | undefined): number {
  return parseBoundedIntegerEnv(value, {
    name: "SLIDE_MAKER_OPENAI_TIMEOUT_MS",
    defaultValue: DEFAULT_OPENAI_TIMEOUT_MS,
    min: MIN_OPENAI_TIMEOUT_MS,
    max: MAX_OPENAI_TIMEOUT_MS,
    integerUnit: " in milliseconds",
  });
}

export const WEB_RENDER_ENGINES = ["jina", "none"] as const;
export type WebRenderEngine = (typeof WEB_RENDER_ENGINES)[number];
export const DEFAULT_WEB_RENDER_ENGINE: WebRenderEngine = "jina";
export const DEFAULT_WEB_RENDER_TIMEOUT_MS = 30_000;
export const MIN_WEB_RENDER_TIMEOUT_MS = 1_000;
export const MAX_WEB_RENDER_TIMEOUT_MS = 10 * 60_000;

/**
 * 「貼上網址」通道在原生擷取只拿到空殼時，用哪個外部 render 服務補抓正文。
 *
 * `jina`（預設）＝ `https://r.jina.ai/`，`none` ＝ 完全停用、只走原生 fetch。
 *
 * **隱私取捨（設定前務必知道）**：選 `jina` 等於把「使用者貼的網址」與「該網址的內容」
 * 送到第三方服務（Jina AI）處理。觸發條件只有一個——使用者**手動**貼上網址，那條路徑的
 * 擷取完全外包給它（`renderOnly`），每一筆都會送出去。既有的網路搜尋擷取路徑
 * （`materializeWebSources` → `captureWebPage`）不帶 renderer，行為完全不變——搜尋結果
 * 是模型給的網址，使用者沒有逐筆同意把它們送去第三方。
 *
 * 外包掉的原因是原生擷取＋空殼啟發式看不出**混合渲染**：頁面伺服器渲染了大半內容、關鍵
 * 區塊留給 client 填，`looksLikeEmptyShell()` 會判成「有正文」而收下一份缺一半、還夾著
 * `{{ }}` 模板殘骸的來源（見 `CapturePageOptions.renderOnly` 的實測數字）。代價是這條路徑
 * 對第三方有硬相依：設 `none` 時它不會退回原生擷取，而是明確回 `WEB_SOURCE_RENDER_UNAVAILABLE`。
 *
 * 無金鑰模式約 20 RPM（Jina 的免費配額，依對方政策可能變動），設 `SLIDE_MAKER_JINA_API_KEY`
 * 可提高上限。另外，免費模式**預設回快取快照**，所以 adapter 一律送 `x-no-cache`——更慢、
 * 更容易撞限流，但「現在去抓這一頁」才是手動貼上網址的語意。
 *
 * 設成 `none` 只是「不呼叫第三方」，不會順帶放寬驗收標準：需要 JavaScript 的頁面會改以
 * `WEB_SOURCE_RENDER_UNAVAILABLE` 明確失敗，而不是把 `<title>` 殘骸當成一份來源收下。
 */
export function parseWebRenderEngine(value: string | undefined): WebRenderEngine {
  if (value === undefined || value.trim() === "") return DEFAULT_WEB_RENDER_ENGINE;
  if (!(WEB_RENDER_ENGINES as readonly string[]).includes(value))
    throw new Error(
      `SLIDE_MAKER_WEB_RENDER_ENGINE must be one of: ${WEB_RENDER_ENGINES.join(", ")}`,
    );
  return value as WebRenderEngine;
}

/**
 * 外部 render 服務的單次逾時（毫秒，正整數）。預設 30 秒：render 服務要自己開瀏覽器跑完
 * SPA，遠比純 fetch 慢，沿用 `captureWebPage` 的 15 秒會在動態頁上幾乎必逾時。
 */
export function parseWebRenderTimeoutMs(value: string | undefined): number {
  return parseBoundedIntegerEnv(value, {
    name: "SLIDE_MAKER_WEB_RENDER_TIMEOUT_MS",
    defaultValue: DEFAULT_WEB_RENDER_TIMEOUT_MS,
    min: MIN_WEB_RENDER_TIMEOUT_MS,
    max: MAX_WEB_RENDER_TIMEOUT_MS,
    integerUnit: " in milliseconds",
  });
}

export const IMAGE_DESCRIPTION_MODES = ["on", "off"] as const;
export type ImageDescriptionMode = (typeof IMAGE_DESCRIPTION_MODES)[number];

/**
 * 上傳的視覺參考圖要不要在背景跑一次 vision 內容抽取（預設 `on`）。
 *
 * 這是整條路唯一的部署層開關，關掉之後行為與加入這個功能之前完全相同：不標 `parsing`、
 * 不排任何工作、一個模型請求都不發。之所以需要它：這是**唯一由「上傳檔案」自動觸發**的
 * 模型呼叫，而佇列長度沒有上限（拖一百張圖就是一百次呼叫）。配額敏感或完全離線的部署
 * 必須有辦法整條關掉，而不是靠使用者逐張取消勾選。
 */
export function parseImageDescriptionMode(value: string | undefined): ImageDescriptionMode {
  if (value === undefined || value.trim() === "") return "on";
  const normalized = value.trim().toLowerCase();
  if (!(IMAGE_DESCRIPTION_MODES as readonly string[]).includes(normalized))
    throw new Error(
      `SLIDE_MAKER_IMAGE_DESCRIPTION must be one of: ${IMAGE_DESCRIPTION_MODES.join(", ")}`,
    );
  return normalized as ImageDescriptionMode;
}

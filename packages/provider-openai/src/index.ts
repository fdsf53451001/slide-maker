export {
  type OpenAiClientConfig,
  listModelIds,
  parseLooseJson,
  readImageAsDataUrl,
} from "./http.js";
export {
  OpenAiCompatibleImageProvider,
  type OpenAiImageApiShape,
  type OpenAiImageOptions,
} from "./image.js";
export { generateViaOpenRouter, extractOpenRouterImage } from "./image-openrouter.js";
// 影像後處理與 data URI 解析是 transport 無關的工具，provider-gemini 直接沿用，
// 避免第二套 cover 正規化／PNG 驗證規則（遮罩攤平同理）。
export {
  flattenMaskToBlack,
  maskAwareDataUrl,
  parseDataUri,
  rasterToCanvasPng,
} from "./image-util.js";
export { OpenAiStructuredTextProvider, type OpenAiStructuredTextOptions } from "./structured.js";
export { OpenAiWebSearchProvider, type OpenAiWebSearchOptions } from "./web-search.js";

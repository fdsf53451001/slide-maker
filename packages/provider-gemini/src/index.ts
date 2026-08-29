export { type GeminiClientConfig, listGeminiModelIds } from "./http.js";
export {
  GeminiImageProvider,
  type GeminiImageOptions,
  MAX_REFERENCES as GEMINI_MAX_REFERENCES,
  extractInlineImage,
} from "./image.js";
// 「這個模型可調什麼」的宣告：伺服器把它交給前端渲染，前端不自己算（那必然漂移）。
export { geminiImageOptionSet, geminiNativeOptionSet } from "./image-options.js";
export { GeminiStructuredTextProvider, type GeminiStructuredTextOptions } from "./structured.js";
export { GeminiWebSearchProvider, type GeminiWebSearchOptions } from "./web-search.js";
export { parseGeminiUsage } from "./usage.js";

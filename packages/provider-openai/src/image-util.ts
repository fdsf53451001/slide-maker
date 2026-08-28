import { Resvg } from "@resvg/resvg-js";
import { SafeProviderError, type ImageGenerationRequest } from "@slide-maker/core";
import { validatePngStructure } from "@slide-maker/core/png-canvas";
import sharp from "sharp";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const SUPPORTED_RASTER = ["image/png", "image/jpeg", "image/webp"];

/** 解析 `data:<mediaType>;base64,<data>` URI 成 mediaType + bytes。 */
export function parseDataUri(uri: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(uri.trim());
  if (!match?.[1] || !match[2])
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "影像資料 URI 格式不正確。");
  const bytes = new Uint8Array(Buffer.from(match[2], "base64"));
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES)
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "影像資料大小不合法。");
  return { mediaType: match[1].toLowerCase(), bytes };
}

/** 以 resvg 把 canvas 尺寸的 SVG 內容 render 成 PNG，並做大小與結構的健全性檢查。 */
function renderCanvasSvgToPng(
  inner: string,
  width: number,
  height: number,
  failureMessage: string,
  requireVisible = false,
): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>`;
  let rendered: ReturnType<Resvg["render"]>;
  try {
    rendered = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
  } catch {
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", failureMessage);
  }
  if (requireVisible && !hasVisiblePixel(rendered.pixels))
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "影像正規化後沒有可見像素。");
  const png = new Uint8Array(rendered.asPng());
  if (png.byteLength <= 0 || png.byteLength > MAX_IMAGE_BYTES)
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "正規化後 PNG 大小不合法。");
  validatePngStructure(Buffer.from(png), width, height);
  return png;
}

function hasVisiblePixel(pixels: Buffer): boolean {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return true;
  return false;
}

/** resvg 解不了 WebP（data URI 會靜默畫成全透明畫布）；先轉 PNG 再走既有 cover 正規化。 */
async function webpToPng(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const png = await sharp(Buffer.from(bytes)).png().toBuffer();
    if (png.byteLength <= 0 || png.byteLength > MAX_IMAGE_BYTES)
      throw new SafeProviderError("OPENAI_IMAGE_INVALID", "影像正規化失敗。");
    return new Uint8Array(png);
  } catch (error) {
    if (error instanceof SafeProviderError) throw error;
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "影像正規化失敗。");
  }
}

function assertSupportedRaster(mediaType: string): void {
  if (!SUPPORTED_RASTER.includes(mediaType))
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", `不支援的影像格式：${mediaType}`);
}

/** 把任意 raster（png/jpeg/webp）以 cover 方式正規化成 canvas 尺寸的 PNG。 */
export async function rasterToCanvasPng(
  bytes: Uint8Array,
  mediaType: string,
  width: number,
  height: number,
): Promise<Uint8Array> {
  assertSupportedRaster(mediaType);
  let raster = bytes;
  let type = mediaType;
  const fromWebp = type === "image/webp";
  if (fromWebp) {
    raster = await webpToPng(raster);
    type = "image/png";
  }
  const dataUri = `data:${type};base64,${Buffer.from(raster).toString("base64")}`;
  return renderCanvasSvgToPng(
    `<image href="${dataUri}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`,
    width,
    height,
    "影像正規化失敗。",
    fromWebp,
  );
}

/**
 * 把「白色矩形＋透明底」的遮罩 PNG 攤平成「不透明黑底＋白色矩形」的 PNG。
 *
 * 視覺通道（chat image_url、Gemini inlineData、OpenRouter input_references）的模型
 * 會把透明底攤成白色——整張遮罩看起來全白，模型完全看不到遮罩矩形在哪，抹字因此
 * 失敗。攤成黑底後與共用合約的描述一致（white areas mark text to erase;
 * black/transparent areas must remain unchanged）。
 */
export function flattenMaskToBlack(
  bytes: Uint8Array,
  mediaType: string,
  width: number,
  height: number,
): Uint8Array {
  assertSupportedRaster(mediaType);
  const dataUri = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  // preserveAspectRatio="none"（拉伸）而非 slice（cover／裁切）：遮罩最終要與
  // compositeMaskedEdit 的 fit:"fill" 對齊，兩邊的重取樣語意必須相同。遮罩目前都已在
  // 存檔時正規化成 canvas 尺寸、這裡是 no-op，但那個不變式一旦破例（出現非 canvas 比例的
  // 遮罩），slice 會讓模型看到的區域與 composite 實際切的區域無聲地錯開。
  return renderCanvasSvgToPng(
    `<rect width="${width}" height="${height}" fill="black"/><image href="${dataUri}" width="${width}" height="${height}" preserveAspectRatio="none"/>`,
    width,
    height,
    "遮罩攤平失敗。",
  );
}

/**
 * 視覺通道用：若 index 是 masked edit 的遮罩，把 data URL 換成攤平後的黑底 PNG；
 * 其餘影像（含 base 圖）原樣回傳。
 *
 * 判斷仍以 `edit.maskImageIndex` 為準而非 `role === "mask"`：index 是 provider 驗證與
 * 傳輸層一路使用的唯一指標（`validateEditReferences` 也看它），role 只是合約用來寫說明
 * 文字的中繼資料。兩者若不一致，攤平錯一張圖等於把真正的素材塗黑。
 */
export function maskAwareDataUrl(
  url: string,
  index: number,
  request: ImageGenerationRequest,
): string {
  if (request.edit?.maskImageIndex !== index) return url;
  const { mediaType, bytes } = parseDataUri(url);
  const flattened = flattenMaskToBlack(bytes, mediaType, request.width, request.height);
  return `data:image/png;base64,${Buffer.from(flattened).toString("base64")}`;
}

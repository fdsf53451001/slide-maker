import { Resvg } from "@resvg/resvg-js";
import { SafeProviderError } from "@slide-maker/core";
import { validatePngStructure } from "@slide-maker/provider-codex";

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

/** 把任意 raster（png/jpeg/webp）以 cover 方式正規化成 canvas 尺寸的 PNG。 */
export function rasterToCanvasPng(
  bytes: Uint8Array,
  mediaType: string,
  width: number,
  height: number,
): Uint8Array {
  if (!SUPPORTED_RASTER.includes(mediaType))
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", `不支援的影像格式：${mediaType}`);
  const dataUri = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="${dataUri}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/></svg>`;
  let png: Uint8Array;
  try {
    png = new Uint8Array(
      new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng(),
    );
  } catch {
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "影像正規化失敗。");
  }
  if (png.byteLength <= 0 || png.byteLength > MAX_IMAGE_BYTES)
    throw new SafeProviderError("OPENAI_IMAGE_INVALID", "正規化後 PNG 大小不合法。");
  validatePngStructure(Buffer.from(png), width, height);
  return png;
}

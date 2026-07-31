/**
 * 生成影像的 PNG 結構驗證與畫布尺寸正規化。
 *
 * 這兩個函式原本住在 `packages/provider-codex`，但使用者是**三條影像通道**：
 * `provider-openai` 的 images／chat／openrouter transport 與 `provider-gemini` 都在用它，
 * codex 反而只是其中一個呼叫端。放在某個 provider 裡等於讓其他 provider 相依一條與自己
 * 無關的通道——移除 codex 時會發現刪不掉，正是這個相依把它釘住的。
 *
 * 刻意不從 `index.ts` re-export，改走 `@slide-maker/core/png-canvas` 子路徑：editor 會把
 * core 的主入口打進瀏覽器 bundle，而 `@resvg/resvg-js` 是原生模組，沒有瀏覽器實作。
 * 理由與 `url-safety.ts` 同一條。
 *
 * 錯誤一律是裸 `Error` 且訊息不含來源路徑或回應內容。呼叫端據此分類：`jobs.ts` 的
 * `safeFailure()` 用 `/PNG|output|image size|image format|dimensions|…/i` 落到
 * `OUTPUT_VALIDATION_FAILED`，所以**訊息裡的 `PNG`／`output`／`dimensions` 字樣是介面的
 * 一部分**，改寫時不要拿掉。
 */
import { Resvg } from "@resvg/resvg-js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 逐 chunk 驗證 PNG：簽章、chunk 表完整性、每個 chunk 的 CRC、IHDR 必須是第一個且唯一、
 * 必須有 IDAT、IEND 必須落在檔尾。給了 `width`／`height` 就一併驗尺寸。
 *
 * 這不是「看起來像 PNG 就好」的檢查：位元組來自模型輸出或本機檔案，後續會被寫進專案資產
 * 並回傳給瀏覽器，所以寧可嚴格。
 */
export function validatePngStructure(
  buffer: Buffer,
  width?: number,
  height?: number,
): { width: number; height: number } {
  if (buffer.length < 57 || !PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) {
    throw new Error("Generated output is not a complete PNG");
  }
  let offset = 8;
  let chunkCount = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < buffer.length) {
    if (buffer.length - offset < 12 || chunkCount >= 10_000)
      throw new Error("Generated PNG has a truncated chunk table");
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_IMAGE_BYTES || length > buffer.length - offset - 12)
      throw new Error("Generated PNG has an invalid chunk length");
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const type = buffer.subarray(typeStart, dataStart).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("Generated PNG has an invalid chunk type");
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    if (crc32(buffer.subarray(typeStart, crcOffset)) !== expectedCrc)
      throw new Error("Generated PNG chunk CRC mismatch");
    if (chunkCount === 0) {
      if (type !== "IHDR" || length !== 13)
        throw new Error("Generated PNG must start with a 13-byte IHDR");
      if (
        width !== undefined &&
        height !== undefined &&
        (buffer.readUInt32BE(dataStart) !== width || buffer.readUInt32BE(dataStart + 4) !== height)
      ) {
        throw new Error(`Generated PNG dimensions must be ${width}x${height}`);
      }
      if (
        buffer[dataStart + 10] !== 0 ||
        buffer[dataStart + 11] !== 0 ||
        ![0, 1].includes(buffer[dataStart + 12]!)
      ) {
        throw new Error(
          "Generated PNG uses unsupported compression, filtering, or interlace settings",
        );
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      throw new Error("Generated PNG contains multiple IHDR chunks");
    }
    if (type === "IDAT") {
      if (length === 0) throw new Error("Generated PNG contains empty image data");
      sawImageData = true;
    }
    if (type === "IEND") {
      if (length !== 0 || crcOffset + 4 !== buffer.length)
        throw new Error("Generated PNG has an invalid IEND chunk");
      sawEnd = true;
    }
    offset = crcOffset + 4;
    chunkCount += 1;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawImageData || !sawEnd || offset !== buffer.length)
    throw new Error("Generated output is not a complete PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * 把任意尺寸的 PNG 正規化成畫布尺寸，語意是 `xMidYMid slice`（等比覆蓋後置中裁切），
 * 不是拉伸——影像模型不保證吐出畫布尺寸，而變形比裁掉邊緣難看得多。
 *
 * 尺寸已經吻合時原樣回傳（不重新編碼），所以原生就出畫布尺寸的通道零損失。
 */
export function normalizePngToCanvas(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const source = Buffer.from(bytes);
  const dimensions = validatePngStructure(source);
  if (dimensions.width === width && dimensions.height === height) return bytes;
  if (
    dimensions.width < 256 ||
    dimensions.height < 256 ||
    dimensions.width > 8_192 ||
    dimensions.height > 8_192
  ) {
    throw new Error("Generated image dimensions are outside the normalization limit");
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:image/png;base64,${source.toString("base64")}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/></svg>`;
  const normalized = new Uint8Array(
    new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng(),
  );
  if (normalized.byteLength <= 0 || normalized.byteLength > MAX_IMAGE_BYTES)
    throw new Error("Normalized PNG output has an invalid size");
  validatePngStructure(Buffer.from(normalized), width, height);
  return normalized;
}

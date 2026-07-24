// 斷言工具：無依賴、丟 Error 即代表 spec 失敗。訊息務必帶「實際 vs 預期」，
// 因為終端報告只印 error.message，診斷全靠這一行。
import { fflate, sharp } from "./deps.mjs";

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

/** spec 主動判定「這個環境不具備前置條件」時丟出，report 記為 skipped 而非 failed。 */
export class SkipSignal extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SkipSignal";
  }
}

export function skip(reason) {
  throw new SkipSignal(reason);
}

export function assert(condition, message) {
  if (!condition) throw new AssertionError(message ?? "assertion failed");
}

export function assertEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${message ?? "values differ"} — expected ${e}, got ${a}`);
}

export function assertDeepEq(actual, expected, message) {
  assertEq(actual, expected, message);
}

export function assertMatch(value, regex, message) {
  if (typeof value !== "string" || !regex.test(value))
    throw new AssertionError(
      `${message ?? "no match"} — ${regex} did not match ${JSON.stringify(value)}`,
    );
}

export function assertIncludes(collection, item, message) {
  const arr = Array.isArray(collection) ? collection : [...collection];
  if (!arr.includes(item))
    throw new AssertionError(
      `${message ?? "missing item"} — ${JSON.stringify(item)} not in ${JSON.stringify(arr)}`,
    );
}

export function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance)
    throw new AssertionError(
      `${message ?? "value out of tolerance"} — expected ${expected}±${tolerance}, got ${actual}`,
    );
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** PNG 簽章 + 可選尺寸。回傳 { width, height }。 */
export function assertPng(bytes, expected = {}, message = "asset") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length < 33 || !PNG_SIGNATURE.every((b, i) => view[i] === b))
    throw new AssertionError(`${message} is not a PNG`);
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  if (expected.width !== undefined && width !== expected.width)
    throw new AssertionError(`${message} width expected ${expected.width}, got ${width}`);
  if (expected.height !== undefined && height !== expected.height)
    throw new AssertionError(`${message} height expected ${expected.height}, got ${height}`);
  return { width, height };
}

/** JPEG SOI 標記 0xFFD8。 */
export function assertJpeg(bytes, message = "asset") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length < 3 || view[0] !== 0xff || view[1] !== 0xd8)
    throw new AssertionError(`${message} is not a JPEG`);
}

/** ZIP 本地檔頭 "PK\\x03\\x04"。 */
export function assertZip(bytes, message = "asset") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length < 4 || view[0] !== 0x50 || view[1] !== 0x4b)
    throw new AssertionError(`${message} is not a ZIP`);
}

/** "%PDF-" 簽章。 */
export function assertPdf(bytes, message = "asset") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (new TextDecoder().decode(view.subarray(0, 5)) !== "%PDF-")
    throw new AssertionError(`${message} is not a PDF`);
}

/** 解開 zip 回傳 { name: Uint8Array }。 */
export function unzip(bytes) {
  return fflate.unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/**
 * 斷言 zip 至少含這些 entry；`predicate` 可對每個名稱做額外檢查（如副檔名）。
 * 回傳解開後的檔案表，供呼叫端進一步比對內容。
 */
export function assertZipEntries(bytes, expectedNames, message = "zip") {
  const files = unzip(bytes);
  const names = Object.keys(files);
  for (const name of expectedNames)
    if (!names.includes(name))
      throw new AssertionError(
        `${message} missing entry ${JSON.stringify(name)} — has ${JSON.stringify(names)}`,
      );
  return files;
}

/** 兩段位元組是否逐 byte 相同。 */
export function bytesEqual(a, b) {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

export function assertBytesEqual(a, b, message = "bytes") {
  if (!bytesEqual(a, b))
    throw new AssertionError(
      `${message} are not byte-identical (${a.length} vs ${b.length} bytes)`,
    );
}

export function assertBytesDiffer(a, b, message = "bytes") {
  if (bytesEqual(a, b)) throw new AssertionError(`${message} are unexpectedly byte-identical`);
}

/**
 * 取一張影像在 (x,y,w,h) 區域的平均 RGB（0–255）。頁碼像素檢查用：
 * 傳入 `pageNumberLayout()` 算出的幾何，避免任何寫死座標。
 */
export async function averageColor(pngBytes, region) {
  const left = Math.max(0, Math.round(region.x));
  const top = Math.max(0, Math.round(region.y));
  const width = Math.max(1, Math.round(region.width));
  const height = Math.max(1, Math.round(region.height));
  const { data, info } = await sharp(Buffer.from(pngBytes))
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = info.width * info.height;
  for (let i = 0; i < pixels; i += 1) {
    r += data[i * channels];
    g += data[i * channels + 1];
    b += data[i * channels + 2];
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
}

/** 一個 HTTP 請求應以特定 status（與可選 error code）失敗。 */
export async function assertHttpError(promise, expectedStatus, expectedCode) {
  let result;
  try {
    result = await promise;
  } catch (error) {
    throw new AssertionError(
      `expected HTTP ${expectedStatus} rejection but call threw: ${error.message}`,
    );
  }
  const { status, body } = result;
  if (status !== expectedStatus)
    throw new AssertionError(
      `expected HTTP ${expectedStatus}, got ${status} — body ${JSON.stringify(body).slice(0, 300)}`,
    );
  if (expectedCode !== undefined && body?.error !== expectedCode)
    throw new AssertionError(
      `expected error code ${expectedCode}, got ${JSON.stringify(body?.error)} — ${JSON.stringify(body).slice(0, 300)}`,
    );
  return result;
}

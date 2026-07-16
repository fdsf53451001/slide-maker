import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { createSourceInputSchema, type SourceAsset } from "@slide-maker/core";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const TEXT_TYPES = new Set(["text/plain", "text/markdown"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const TYPE_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};

function xmlText(xml: string): string {
  return xml.replace(/<a:br\s*\/?\s*>|<w:br\s*\/?\s*>/g, "\n")
    .replace(/<\/a:p>|<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseOffice(bytes: Uint8Array, kind: "docx" | "pptx"): string {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error("SOURCE_ARCHIVE_INVALID"); }
  const names = kind === "docx"
    ? ["word/document.xml"]
    : Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parts = names.map((name) => files[name]).filter((value): value is Uint8Array => !!value).map((value) => xmlText(strFromU8(value)));
  if (!parts.some(Boolean)) throw new Error("SOURCE_TEXT_NOT_FOUND");
  return parts.join("\n\n");
}

function parsePdf(bytes: Uint8Array): string {
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) throw new Error("SOURCE_PDF_INVALID");
  const raw = Buffer.from(bytes).toString("latin1");
  const strings = [...raw.matchAll(/\(((?:\\.|[^()\\]){2,})\)\s*(?:Tj|'|\")/g)].map((match) => match[1]!
    .replace(/\\([()\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\r/g, ""));
  return strings.join(" ").replace(/\s+/g, " ").trim();
}

export function safeFilename(name: string): string {
  const value = name.normalize("NFC").replace(/[\u0000-\u001f/\\:]/g, "_").replace(/^\.+/, "").trim();
  return (value || "source").slice(0, 180);
}

export function detectSourceMediaType(name: string, declared: string, bytes: Uint8Array): string {
  const expected = TYPE_BY_EXTENSION[extname(name).toLowerCase()];
  if (!expected) throw new Error("SOURCE_TYPE_UNSUPPORTED");
  if (declared && declared !== "application/octet-stream" && declared !== expected
    && !(expected === "text/markdown" && declared === "text/plain")) throw new Error("SOURCE_MEDIA_TYPE_MISMATCH");
  if (expected === "image/png" && !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("SOURCE_CONTENT_INVALID");
  if (expected === "image/jpeg" && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)) throw new Error("SOURCE_CONTENT_INVALID");
  if ((expected.endsWith("document") || expected.endsWith("presentation")) && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error("SOURCE_CONTENT_INVALID");
  return expected;
}

function chunks(sourceId: string, text: string): SourceAsset["chunks"] {
  const result: SourceAsset["chunks"] = [];
  for (let start = 0, index = 0; start < text.length; start += 1200, index += 1) {
    const value = text.slice(start, start + 1600).trim();
    if (!value) continue;
    result.push({ id: createHash("sha256").update(`${sourceId}:${index}:${value}`).digest("hex").slice(0, 24), text: value, locator: `chunk:${index + 1}` });
  }
  return result;
}

export function ingestSource(input: unknown, bytes: Uint8Array, assetPath: string, now = new Date().toISOString()): SourceAsset {
  const parsed = createSourceInputSchema.parse(input);
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error("SOURCE_SIZE_INVALID");
  const mediaType = detectSourceMediaType(parsed.name, parsed.mediaType, bytes);
  let extractedText = "";
  if (TEXT_TYPES.has(mediaType)) extractedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  else if (mediaType === "application/pdf") extractedText = parsePdf(bytes);
  else if (mediaType.endsWith("wordprocessingml.document")) extractedText = parseOffice(bytes, "docx");
  else if (mediaType.endsWith("presentationml.presentation")) extractedText = parseOffice(bytes, "pptx");
  const id = randomUUID();
  return {
    id, name: parsed.name, mediaType,
    usage: parsed.usage ?? (IMAGE_TYPES.has(mediaType) ? "visual-reference" : "content"),
    allowModelAccess: parsed.allowModelAccess,
    status: "indexed", assetPath, sizeBytes: bytes.length, extractedText,
    chunks: chunks(id, extractedText), metadata: {}, createdAt: now, updatedAt: now,
  };
}

export function searchSources(sources: readonly SourceAsset[], query: string, limit = 20) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return sources.flatMap((source) => source.chunks.map((chunk) => {
    const haystack = `${source.name} ${chunk.text}`.toLocaleLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { sourceId: source.id, sourceName: source.name, ...chunk, score };
  })).filter((item) => item.score > 0).sort((left, right) => right.score - left.score).slice(0, limit);
}

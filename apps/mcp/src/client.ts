import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { link, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_TIMEOUT_MS = 2_147_483_647;

export function parseTimeoutMs(
  value: string | undefined,
  fallback = 300_000,
  name = "SLIDE_MAKER_MCP_TIMEOUT_MS",
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS)
    throw new Error(`${name} 必須是 1 到 ${MAX_TIMEOUT_MS} 的整數`);
  return parsed;
}

export interface AuthProvider {
  readonly sendsCredentials: boolean;
  headers(): Promise<Record<string, string>>;
}

export class NoAuthProvider implements AuthProvider {
  readonly sendsCredentials = false;

  async headers(): Promise<Record<string, string>> {
    return {};
  }
}

export class StaticBearerAuthProvider implements AuthProvider {
  readonly sendsCredentials = true;

  constructor(private readonly token: string) {}

  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.token}` };
  }
}

export interface SlideMakerClientOptions {
  baseUrl: string;
  auth?: AuthProvider;
  timeoutMs?: number;
  exportRoot?: string;
  sourceRoot?: string;
  outlineTimeoutMs?: number;
}

export class SlideMakerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly failures?: Array<{ url: string; reason: string }>,
  ) {
    super(message);
    this.name = "SlideMakerApiError";
  }
}

// 只收語意上必然發生在連線建立之前的錯誤：請求確定沒有送達伺服器。EHOSTUNREACH／ENETUNREACH
// 刻意不列——長請求中途換網路或 VPN 斷線時，既有 socket 也可能回這兩個碼，那時可能已送達。
const CONNECT_FAILURE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function connectFailureCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as unknown) : undefined;
  if (!cause || typeof cause !== "object") return undefined;
  // localhost 同時解析到 ::1 與 127.0.0.1 時，Node 會包成 AggregateError，逐一的錯誤放在 errors。
  const nested = "errors" in cause && Array.isArray(cause.errors) ? cause.errors : [];
  for (const candidate of [cause, ...nested]) {
    const code =
      candidate && typeof candidate === "object" && "code" in candidate
        ? candidate.code
        : undefined;
    if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) return code;
  }
  return undefined;
}

function normalizedBaseUrl(value: string, sendsCredentials: boolean): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("SLIDE_MAKER_MCP_BASE_URL 必須是 http 或 https 網址");
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
  if (sendsCredentials && url.protocol !== "https:" && !loopback)
    throw new Error("使用驗證資訊時，SLIDE_MAKER_MCP_BASE_URL 必須是 HTTPS 或本機網址");
  return url.toString().replace(/\/$/, "");
}

export class SlideMakerClient {
  private readonly baseUrl: string;
  private readonly auth: AuthProvider;
  private readonly timeoutMs: number;
  private readonly exportRoot: string;
  private readonly sourceRoot: string;
  private readonly outlineTimeoutMs: number;

  constructor(options: SlideMakerClientOptions) {
    this.auth = options.auth ?? new NoAuthProvider();
    this.baseUrl = normalizedBaseUrl(options.baseUrl, this.auth.sendsCredentials);
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.exportRoot = resolve(options.exportRoot ?? resolve(process.cwd(), "slide-maker-exports"));
    this.sourceRoot = resolve(options.sourceRoot ?? resolve(process.cwd(), "slide-maker-sources"));
    this.outlineTimeoutMs = options.outlineTimeoutMs ?? 60 * 60_000;
  }

  async get<T>(path: string): Promise<T> {
    return this.requestJson<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async postOutline<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.outlineTimeoutMs,
    );
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async uploadSource<T>(
    path: string,
    fileName: string,
    mediaType: string,
  ): Promise<{ response: T; bytes: number }> {
    if (
      !fileName ||
      fileName === "." ||
      fileName === ".." ||
      fileName.includes("/") ||
      fileName.includes("\\")
    )
      throw new Error("fileName 只能是素材目錄內的單一檔名");
    const absolutePath = resolve(this.sourceRoot, fileName);
    // O_NONBLOCK 讓 FIFO／device 不會在 fstat 前卡住；regular file 的讀取行為不受影響。
    const handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const file = await handle.stat();
      if (!file.isFile()) throw new Error("素材必須是一般檔案，不能是 symlink");
      if (file.size > 100 * 1024 * 1024) throw new Error("素材超過 100MB 上限");
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const response = await this.requestJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": mediaType },
      // Node fetch 接受 Buffer；轉成 Uint8Array.from() 會讓合法的 100MB 檔案再複製一份。
      body: bytes as unknown as BodyInit,
    });
    return { response, bytes: bytes.byteLength };
  }

  async exportToFile(path: string, outputPath: string): Promise<{ path: string; bytes: number }> {
    if (isAbsolute(outputPath)) throw new Error("outputPath 必須是匯出目錄內的相對路徑");
    // 只接受單一檔名：若允許子目錄，root 內預先存在的 symlink 可把寫入導向 root 外。
    if (outputPath.includes("/") || outputPath.includes("\\"))
      throw new Error("outputPath 只能是匯出目錄內的單一檔名");
    const absolutePath = resolve(this.exportRoot, outputPath);
    const pathWithinRoot = relative(this.exportRoot, absolutePath);
    if (!pathWithinRoot || pathWithinRoot.startsWith("..") || isAbsolute(pathWithinRoot))
      throw new Error("outputPath 必須指向匯出目錄內的檔案");
    await mkdir(dirname(absolutePath), { recursive: true });
    const targetExists = await stat(absolutePath).then(
      () => true,
      (error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return false;
        throw error;
      },
    );
    if (targetExists) throw new Error(`匯出檔案已存在：${absolutePath}`);
    const response = await this.request(path, { method: "GET" });
    if (!response.body) throw new Error("Slide Maker API 的匯出回應沒有內容");
    // 專案封存可能接近 GiB；直接 arrayBuffer() 會讓整份檔案同時留在 heap。
    // 暫存檔放在目標旁，完成後 rename，避免中途失敗留下看似完整的成品。
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
        createWriteStream(temporaryPath, { flags: "wx" }),
      );
      const { size } = await stat(temporaryPath);
      // hard link 是同檔案系統上的原子「只在目標不存在時建立」；EEXIST 時不覆寫。
      await link(temporaryPath, absolutePath);
      await unlink(temporaryPath);
      return { path: absolutePath, bytes: size };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
        throw new Error(`匯出檔案已存在：${absolutePath}`);
      throw error;
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const response = await this.request(path, init, timeoutMs);
    return (await response.json()) as T;
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const authHeaders = await this.auth.headers();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, ...authHeaders },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new SlideMakerApiError(
          504,
          "MCP_REQUEST_TIMEOUT",
          `Slide Maker API 超過 ${timeoutMs} 毫秒未完成。`,
        );
      const connectCode = connectFailureCode(error);
      if (connectCode)
        throw new SlideMakerApiError(
          503,
          "MCP_CONNECTION_FAILED",
          `無法連線到 Slide Maker API（${connectCode}），請確認 Slide Maker 已啟動且 SLIDE_MAKER_MCP_BASE_URL 正確。`,
        );
      throw error;
    }
    if (response.ok) return response;

    const fallback = `Slide Maker API 回傳 HTTP ${response.status}`;
    let code = "HTTP_ERROR";
    let message = fallback;
    let failures: Array<{ url: string; reason: string }> | undefined;
    try {
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
        failures?: unknown;
      };
      if (typeof body.error === "string") code = body.error;
      if (typeof body.message === "string") message = body.message;
      else if (typeof body.error === "string") message = body.error;
      failures = Array.isArray(body.failures)
        ? body.failures.flatMap((item) => {
            if (
              !item ||
              typeof item !== "object" ||
              !("url" in item) ||
              !("reason" in item) ||
              typeof item.url !== "string" ||
              typeof item.reason !== "string"
            )
              return [];
            return [{ url: item.url, reason: item.reason }];
          })
        : undefined;
    } catch {
      // 非 JSON 的代理層錯誤（例如 IAP HTML）只回狀態，不把整頁內容送進模型。
      if (response.status === 401 || response.status === 403) {
        code = "MCP_AUTH_REJECTED";
        message = this.auth.sendsCredentials
          ? `Slide Maker 前方的驗證層拒絕了這個請求（HTTP ${response.status}）。請確認 service account 有這個服務的 IAP 存取權（roles/iap.httpsResourceAccessor），以及 SLIDE_MAKER_MCP_IAP_AUDIENCE 與 SLIDE_MAKER_MCP_BASE_URL 相符。`
          : `Slide Maker 前方的驗證層拒絕了這個請求（HTTP ${response.status}），但目前沒有設定任何驗證資訊。連 Cloud Run IAP 需設定 SLIDE_MAKER_MCP_SA_KEY_FILE。`;
      }
    }
    throw new SlideMakerApiError(
      response.status,
      code,
      message,
      failures?.length ? failures : undefined,
    );
  }
}

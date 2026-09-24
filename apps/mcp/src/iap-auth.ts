import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AuthProvider } from "./client.js";

// IAP 對 service account 自簽 JWT 的上限是 1 小時；提早 5 分鐘換新，
// 避免一個跑得比較久的請求在 IAP 驗證時剛好過期。
const TOKEN_LIFETIME_SECONDS = 3600;
const REFRESH_MARGIN_SECONDS = 300;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKeyId: string;
  privateKey: KeyObject;
}

/**
 * 解析 SA JSON key。錯誤訊息一律不帶檔案內容：Node 的 JSON.parse 錯誤會引用原文片段，
 * 而這份檔案的原文就是私鑰。
 */
export function parseServiceAccountKey(text: string): ServiceAccountKey {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("SLIDE_MAKER_MCP_SA_KEY_FILE 不是合法的 JSON");
  }
  if (!raw || typeof raw !== "object")
    throw new Error("SLIDE_MAKER_MCP_SA_KEY_FILE 不是 service account JSON key");
  const record = raw as Record<string, unknown>;
  const { type, client_email, private_key, private_key_id } = record;
  if (
    type !== "service_account" ||
    typeof client_email !== "string" ||
    typeof private_key !== "string" ||
    typeof private_key_id !== "string"
  )
    throw new Error(
      "SLIDE_MAKER_MCP_SA_KEY_FILE 不是 service account JSON key（需要 type、client_email、private_key、private_key_id）",
    );
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(private_key);
  } catch {
    throw new Error("SLIDE_MAKER_MCP_SA_KEY_FILE 的 private_key 無法解析");
  }
  return { clientEmail: client_email, privateKeyId: private_key_id, privateKey };
}

export async function loadServiceAccountKey(path: string): Promise<ServiceAccountKey> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("SLIDE_MAKER_MCP_SA_KEY_FILE 必須指向一般檔案");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    console.error(
      `警告：SLIDE_MAKER_MCP_SA_KEY_FILE 可被其他使用者讀取（權限 ${(info.mode & 0o777).toString(8)}），建議 chmod 600`,
    );
  return parseServiceAccountKey(await readFile(path, "utf8"));
}

/** IAP 接受「資源網址＋萬用字元路徑」當 audience，一個 token 可打同一服務的所有路徑。 */
export function defaultIapAudience(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function signIapJwt(key: ServiceAccountKey, audience: string, nowSeconds: number): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.privateKeyId };
  const payload = {
    iss: key.clientEmail,
    sub: key.clientEmail,
    aud: audience,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * 以本機的 SA key 自簽 JWT 通過 Cloud Run 前方的 IAP。本機簽章，不呼叫任何 Google API，
 * 所以不需要 gcloud 登入、Token Creator 或 OAuth client。
 */
export class ServiceAccountJwtAuthProvider implements AuthProvider {
  readonly sendsCredentials = true;
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly audience: string,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async headers(): Promise<Record<string, string>> {
    const now = this.nowSeconds();
    if (!this.cached || this.cached.expiresAt - now <= REFRESH_MARGIN_SECONDS)
      this.cached = {
        token: signIapJwt(this.key, this.audience, now),
        expiresAt: now + TOKEN_LIFETIME_SECONDS,
      };
    return { Authorization: `Bearer ${this.cached.token}` };
  }
}

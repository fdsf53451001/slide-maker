import { generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlideMakerApiError, SlideMakerClient, StaticBearerAuthProvider } from "../src/client.js";
import { authFromEnv, clientFromEnv } from "../src/config.js";
import {
  defaultIapAudience,
  parseServiceAccountKey,
  ServiceAccountJwtAuthProvider,
} from "../src/iap-auth.js";

afterEach(() => vi.unstubAllGlobals());

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyJson = JSON.stringify({
  type: "service_account",
  client_email: "mcp@example.iam.gserviceaccount.com",
  private_key_id: "key-123",
  private_key: privatePem,
});

function decode(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString()),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature!, "base64url"),
  };
}

async function tokenFrom(provider: ServiceAccountJwtAuthProvider): Promise<string> {
  const { Authorization } = await provider.headers();
  expect(Authorization).toMatch(/^Bearer /);
  return Authorization!.slice("Bearer ".length);
}

async function keyFile(content = keyJson): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "mcp-sa-")), "key.json");
  await writeFile(path, content);
  await chmod(path, 0o600);
  return path;
}

describe("ServiceAccountJwtAuthProvider", () => {
  it("簽出 IAP 要求的 RS256 JWT，並能以公鑰驗證", async () => {
    const provider = new ServiceAccountJwtAuthProvider(
      parseServiceAccountKey(keyJson),
      "https://slides.example.run.app/*",
      () => 1_000_000,
    );
    const jwt = decode(await tokenFrom(provider));
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT", kid: "key-123" });
    expect(jwt.payload).toEqual({
      iss: "mcp@example.iam.gserviceaccount.com",
      sub: "mcp@example.iam.gserviceaccount.com",
      aud: "https://slides.example.run.app/*",
      iat: 1_000_000,
      exp: 1_003_600,
    });
    expect(verify("sha256", Buffer.from(jwt.signingInput), publicKey, jwt.signature)).toBe(true);
  });

  it("有效期內沿用同一張，剩不到 5 分鐘才換新", async () => {
    let now = 1_000_000;
    const provider = new ServiceAccountJwtAuthProvider(
      parseServiceAccountKey(keyJson),
      "https://a.example/*",
      () => now,
    );
    const first = await tokenFrom(provider);
    now += 3600 - 301;
    expect(await tokenFrom(provider)).toBe(first);
    now += 1;
    const second = await tokenFrom(provider);
    expect(second).not.toBe(first);
    expect(decode(second).payload.iat).toBe(now);
  });

  it("audience 預設為服務網址加萬用字元路徑", () => {
    expect(defaultIapAudience("https://slides.example.run.app/some/path")).toBe(
      "https://slides.example.run.app/*",
    );
  });

  it("解析失敗時錯誤訊息不帶檔案內容", () => {
    const broken = keyJson.slice(0, -10);
    const errors = [
      () => parseServiceAccountKey(broken),
      () =>
        parseServiceAccountKey(
          JSON.stringify({ type: "authorized_user", private_key: privatePem }),
        ),
      () =>
        parseServiceAccountKey(
          JSON.stringify({
            ...JSON.parse(keyJson),
            private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n",
          }),
        ),
    ].map((fn) => {
      try {
        fn();
      } catch (error) {
        return error as Error;
      }
      throw new Error("應該要失敗");
    });
    for (const error of errors) {
      expect(error.message).not.toContain("PRIVATE KEY");
      expect(error.message).not.toContain("MIIE");
    }
  });
});

describe("authFromEnv", () => {
  it("SA key 與靜態 token 只能擇一", async () => {
    await expect(
      authFromEnv(
        { SLIDE_MAKER_MCP_BEARER_TOKEN: "t", SLIDE_MAKER_MCP_SA_KEY_FILE: await keyFile() },
        "https://a.example",
      ),
    ).rejects.toThrow(/只能擇一/);
  });

  it("audience 沒有搭配 SA key 時拒絕啟動", async () => {
    await expect(
      authFromEnv({ SLIDE_MAKER_MCP_IAP_AUDIENCE: "https://a.example/*" }, "https://a.example"),
    ).rejects.toThrow(/需搭配/);
  });

  it("SA key 模式以 base URL 推導 audience，並要求 HTTPS", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = await clientFromEnv({
      SLIDE_MAKER_MCP_BASE_URL: "https://slides.example.run.app",
      SLIDE_MAKER_MCP_SA_KEY_FILE: await keyFile(),
    });
    await client.get("/api/projects");
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(decode(headers.Authorization!.slice(7)).payload.aud).toBe(
      "https://slides.example.run.app/*",
    );
    await expect(
      clientFromEnv({
        SLIDE_MAKER_MCP_BASE_URL: "http://slides.example.run.app",
        SLIDE_MAKER_MCP_SA_KEY_FILE: await keyFile(),
      }),
    ).rejects.toThrow(/HTTPS/);
  });
});

describe("IAP 拒絕", () => {
  it("非 JSON 的 401/403 轉成可判讀的 MCP_AUTH_REJECTED，且不帶 HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>Invalid IAP credentials: JWT audience doesn't match</html>", {
          status: 401,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );
    const client = new SlideMakerClient({
      baseUrl: "https://slides.example.run.app",
      auth: new StaticBearerAuthProvider("t"),
    });
    const error = await client.get("/api/projects").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlideMakerApiError);
    expect((error as SlideMakerApiError).code).toBe("MCP_AUTH_REJECTED");
    expect((error as SlideMakerApiError).message).not.toContain("<html>");
  });

  it("伺服器自己回的 JSON 403 維持原本的錯誤碼", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "FORBIDDEN", message: "不行" }, { status: 403 })),
    );
    const client = new SlideMakerClient({ baseUrl: "http://127.0.0.1:4173" });
    const error = (await client.get("/x").catch((e: unknown) => e)) as SlideMakerApiError;
    expect(error.code).toBe("FORBIDDEN");
  });
});

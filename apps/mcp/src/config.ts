import {
  type AuthProvider,
  NoAuthProvider,
  parseTimeoutMs,
  SlideMakerClient,
  StaticBearerAuthProvider,
} from "./client.js";
import {
  defaultIapAudience,
  loadServiceAccountKey,
  ServiceAccountJwtAuthProvider,
} from "./iap-auth.js";

export const DEFAULT_BASE_URL = "http://127.0.0.1:4173";

type Env = Record<string, string | undefined>;

export async function authFromEnv(env: Env, baseUrl: string): Promise<AuthProvider> {
  const bearerToken = env.SLIDE_MAKER_MCP_BEARER_TOKEN?.trim();
  const keyFile = env.SLIDE_MAKER_MCP_SA_KEY_FILE?.trim();
  const audience = env.SLIDE_MAKER_MCP_IAP_AUDIENCE?.trim();
  if (bearerToken && keyFile)
    throw new Error("SLIDE_MAKER_MCP_BEARER_TOKEN 與 SLIDE_MAKER_MCP_SA_KEY_FILE 只能擇一設定");
  if (audience && !keyFile)
    throw new Error("SLIDE_MAKER_MCP_IAP_AUDIENCE 需搭配 SLIDE_MAKER_MCP_SA_KEY_FILE");
  if (keyFile)
    return new ServiceAccountJwtAuthProvider(
      await loadServiceAccountKey(keyFile),
      audience || defaultIapAudience(baseUrl),
    );
  return bearerToken ? new StaticBearerAuthProvider(bearerToken) : new NoAuthProvider();
}

export async function clientFromEnv(env: Env = process.env): Promise<SlideMakerClient> {
  const baseUrl = env.SLIDE_MAKER_MCP_BASE_URL ?? DEFAULT_BASE_URL;
  return new SlideMakerClient({
    baseUrl,
    auth: await authFromEnv(env, baseUrl),
    timeoutMs: parseTimeoutMs(env.SLIDE_MAKER_MCP_TIMEOUT_MS),
    outlineTimeoutMs: parseTimeoutMs(
      env.SLIDE_MAKER_MCP_OUTLINE_TIMEOUT_MS,
      60 * 60_000,
      "SLIDE_MAKER_MCP_OUTLINE_TIMEOUT_MS",
    ),
    ...(env.SLIDE_MAKER_MCP_EXPORT_ROOT ? { exportRoot: env.SLIDE_MAKER_MCP_EXPORT_ROOT } : {}),
    ...(env.SLIDE_MAKER_MCP_SOURCE_ROOT ? { sourceRoot: env.SLIDE_MAKER_MCP_SOURCE_ROOT } : {}),
  });
}

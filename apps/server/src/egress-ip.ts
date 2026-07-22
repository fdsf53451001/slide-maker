import { isIP } from "node:net";

/**
 * 啟動時把對外連線的來源位址寫進 log。
 *
 * 唯一的用途是雲端部署：Cloud Run 沒有 NAT 時 egress 位址取自 Google 的共用位址池，
 * 服務本身無從得知，而需要把位址加進第三方 API 白名單（如 AI Studio key 的 IP 限制）
 * 時只能靠這種外部回聲服務問出來。
 *
 * 位址每次冷啟動都可能不同——這裡印出的是「這個執行個體此刻的位址」，不是穩定值。
 * 真的需要固定出口只能走 Cloud NAT；這條 log 的價值在於讓人知道當下是哪個位址，
 * 而不是拿來當長期白名單的來源。
 *
 * 預設關閉：這會在啟動時對外發請求，本機開發沒有理由付這個代價。
 */

const PROBES = [
  { label: "IPv4", url: "https://api.ipify.org" },
  { label: "IPv6", url: "https://api6.ipify.org" },
] as const;

const PROBE_TIMEOUT_MS = 5_000;
/** 回應長度上限：IPv6 最長 45 字元，超出的一律視為不是位址。 */
const MAX_ADDRESS_LENGTH = 64;

export function egressLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SLIDE_MAKER_LOG_EGRESS_IP === "1";
}

async function probe(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await fetcher(url, { signal, redirect: "error" });
  if (!response.ok) return undefined;
  const text = (await response.text()).trim();
  // 回聲服務的內容是外部輸入，未經驗證不可寫進 log——只接受看起來就是位址的短字串。
  if (text.length > MAX_ADDRESS_LENGTH || isIP(text) === 0) return undefined;
  return text;
}

/**
 * 探測並輸出 egress 位址。永不 throw、永不阻斷啟動：探測失敗只留一行 log。
 */
export async function logEgressAddresses(
  log: (message: string) => void = console.log,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  await Promise.all(
    PROBES.map(async ({ label, url }) => {
      try {
        const address = await probe(url, fetcher, signal);
        log(
          address ? `Egress ${label}: ${address}` : `Egress ${label}: 回聲服務未回傳可辨識的位址。`,
        );
      } catch {
        // 位址探測是輔助資訊，任何失敗（逾時、離線、DNS）都不該影響服務啟動。
        log(`Egress ${label}: 探測失敗（逾時或無法連線）。`);
      }
    }),
  );
}

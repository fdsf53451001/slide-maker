import {
  ProviderRegistry,
  type ImageProvider,
  type ProviderPreflightStatus,
} from "@slide-maker/core";

const READINESS_MESSAGES: Record<ProviderPreflightStatus, string> = {
  ready: "Provider 已通過非生成 readiness 檢查。",
  ready_experimental: "Codex CLI 與登入狀態可用；圖片產物使用版本鎖定的實驗性 app-server 契約。",
  disabled: "Provider 尚未啟用。",
  cli_missing: "找不到 Codex CLI，請先完成本機安裝。",
  incompatible: "Codex CLI 缺少此 provider 需要的固定參數，請升級 CLI。",
  auth_required: "Codex CLI 尚未登入，請先執行 codex login。",
  timeout: "Codex readiness 檢查逾時，請確認 CLI 能正常啟動後再試。",
  artifact_unsupported: "目前 Codex CLI 沒有可安全依賴的圖片產物契約；已阻止生成以避免消耗額度。",
  unknown: "無法確認 provider readiness；若仍要繼續，必須明確接受風險。",
};
const READINESS_STATUSES = new Set<ProviderPreflightStatus>(
  Object.keys(READINESS_MESSAGES) as ProviderPreflightStatus[],
);

export interface ProviderReadiness {
  providerId: string;
  status: ProviderPreflightStatus;
  blocking: boolean;
  requiresAcknowledgement: boolean;
  message: string;
  checkedAt: string;
  expiresAt: string;
}

export class ProviderReadinessGateError extends Error {
  constructor(readonly readiness: ProviderReadiness) {
    super("PROVIDER_PREFLIGHT_BLOCKED");
    this.name = "ProviderReadinessGateError";
  }
}

export class ProviderReadinessService {
  readonly #cache = new Map<string, { expiresAtMs: number; value: ProviderReadiness }>();
  readonly #inflight = new Map<string, Promise<ProviderReadiness>>();
  #shuttingDown = false;

  constructor(
    private readonly providers: ProviderRegistry<ImageProvider>,
    private readonly ttlMs = 30_000,
    private readonly checkTimeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000)
      throw new Error("Readiness ttlMs is out of range");
    if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1_000 || checkTimeoutMs > 30_000)
      throw new Error("Readiness checkTimeoutMs is out of range");
  }

  async check(providerId: string): Promise<ProviderReadiness> {
    if (this.#shuttingDown) return this.#value(providerId, "disabled");
    const now = Date.now();
    const cached = this.#cache.get(providerId);
    if (cached && cached.expiresAtMs > now) return cached.value;
    const existing = this.#inflight.get(providerId);
    if (existing) return existing;
    const check = this.#perform(providerId)
      .then((value) => {
        this.#cache.set(providerId, { expiresAtMs: Date.parse(value.expiresAt), value });
        return value;
      })
      .finally(() => this.#inflight.delete(providerId));
    this.#inflight.set(providerId, check);
    return check;
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
    this.#cache.clear();
  }

  async assertCanGenerate(
    providerId: string,
    acceptUnknownReadiness: boolean,
  ): Promise<ProviderReadiness> {
    const readiness = await this.check(providerId);
    if (
      ["ready", "ready_experimental"].includes(readiness.status) ||
      (readiness.status === "unknown" && acceptUnknownReadiness)
    )
      return readiness;
    throw new ProviderReadinessGateError(readiness);
  }

  async #perform(providerId: string): Promise<ProviderReadiness> {
    const provider = this.providers.get(providerId);
    let status: ProviderPreflightStatus;
    if (provider.availability.status === "unavailable") {
      status = "disabled";
    } else if (!provider.preflight) {
      status = provider.artifactContract === "unsupported" ? "artifact_unsupported" : "ready";
    } else {
      status = await this.#boundedStatus(provider);
      if (status === "ready" && provider.artifactContract === "unsupported")
        status = "artifact_unsupported";
    }
    return this.#value(providerId, status);
  }

  #value(providerId: string, status: ProviderPreflightStatus): ProviderReadiness {
    const checkedAtMs = Date.now();
    return {
      providerId,
      status,
      blocking: !["ready", "ready_experimental", "unknown"].includes(status),
      requiresAcknowledgement: status === "unknown",
      message: READINESS_MESSAGES[status],
      checkedAt: new Date(checkedAtMs).toISOString(),
      expiresAt: new Date(checkedAtMs + this.ttlMs).toISOString(),
    };
  }

  async #boundedStatus(provider: ImageProvider): Promise<ProviderPreflightStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provider.preflight!()
          .then((result) => (READINESS_STATUSES.has(result.status) ? result.status : "unknown"))
          .catch(() => "unknown" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.checkTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

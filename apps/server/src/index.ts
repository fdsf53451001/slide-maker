import { logError } from "@slide-maker/core";
import { createApp } from "./app.js";
import { egressLoggingEnabled, logEgressAddresses } from "./egress-ip.js";
import { formatStartupStatus } from "./startup-status.js";
import type { JobRunner } from "./jobs.js";
import type { ProviderReadinessService } from "./readiness.js";
import { installShutdownHandlers } from "./shutdown.js";

process.on("uncaughtException", (error) => {
  logError("uncaught_exception", {}, error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled_rejection", {}, reason);
  process.exit(1);
});

const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const host = process.env.HOST ?? "127.0.0.1";
const dataRoot = process.env.SLIDE_MAKER_DATA_ROOT;
const codexSoftSandboxEnabled = process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX === "1";

const app = dataRoot ? await createApp(dataRoot) : await createApp();
const server = app.listen(port, host, () => {
  for (const message of formatStartupStatus({
    baseUrl: `http://${host}:${port}`,
    codexSoftSandboxEnabled,
  }))
    console.log(message);
  // 不 await：位址探測要打外網，不該讓它決定服務何時開始收請求。
  if (egressLoggingEnabled()) void logEgressAddresses();
});
installShutdownHandlers(
  server,
  app.locals.jobRunner as JobRunner,
  app.locals.providerReadiness as ProviderReadinessService,
);

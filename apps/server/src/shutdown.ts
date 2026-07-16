import type { Server } from "node:http";
import type { JobRunner } from "./jobs.js";
import type { ProviderReadinessService } from "./readiness.js";

export class ShutdownDeadlineExceeded extends Error {
  constructor() {
    super("SERVER_SHUTDOWN_DEADLINE_EXCEEDED");
    this.name = "ShutdownDeadlineExceeded";
  }
}

export async function gracefulShutdown(
  server: Server,
  jobs: JobRunner,
  readiness: ProviderReadinessService,
  graceMs = 3_000,
): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 100 || graceMs > 30_000) throw new Error("Shutdown graceMs is out of range");
  readiness.beginShutdown();
  const serverClosed = new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  const jobsStopped = jobs.shutdown(graceMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), graceMs); });
  let result: "closed" | "deadline";
  try {
    result = await Promise.race([
      Promise.all([serverClosed, jobsStopped]).then(() => "closed" as const),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result === "deadline") {
    server.closeAllConnections?.();
    throw new ShutdownDeadlineExceeded();
  }
}

export function installShutdownHandlers(
  server: Server,
  jobs: JobRunner,
  readiness: ProviderReadinessService,
  graceMs = 3_000,
  runtime: Pick<NodeJS.Process, "on" | "removeListener" | "exit"> = process,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const dispose = () => {
    runtime.removeListener("SIGINT", onSignal);
    runtime.removeListener("SIGTERM", onSignal);
  };
  const trigger = () => {
    shutdown ??= gracefulShutdown(server, jobs, readiness, graceMs).catch((error: unknown) => {
      console.error("Graceful shutdown failed", { name: error instanceof Error ? error.name : "UnknownError" });
      server.closeAllConnections?.();
      throw error;
    }).finally(dispose);
    return shutdown;
  };
  let signalCount = 0;
  const onSignal = () => {
    signalCount += 1;
    if (signalCount > 1) {
      server.closeAllConnections?.();
      runtime.exit(1);
      return;
    }
    void trigger().then(
      () => runtime.exit(0),
      () => runtime.exit(1),
    );
  };
  runtime.on("SIGINT", onSignal);
  runtime.on("SIGTERM", onSignal);
  return trigger;
}

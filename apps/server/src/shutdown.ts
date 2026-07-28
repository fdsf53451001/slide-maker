import type { Server } from "node:http";
import type { JobRunner } from "./jobs.js";
import type { ProviderReadinessService } from "./readiness.js";

export class ShutdownDeadlineExceeded extends Error {
  constructor() {
    super("SERVER_SHUTDOWN_DEADLINE_EXCEEDED");
    this.name = "ShutdownDeadlineExceeded";
  }
}

/**
 * 除了 job runner 之外、也要跟著關機收尾的背景工作（目前是圖片描述佇列與 OCR 佇列）。
 *
 * 型別刻意只要求 `shutdown()`：這裡不該知道那是什麼佇列，而 `app.locals` 取出來的東西
 * 是 `any`，用最小介面接住才不會把整個型別讓掉。
 */
export interface BackgroundWork {
  shutdown(): Promise<void>;
}

/**
 * 把多個背景工作併成一個 `BackgroundWork`。
 *
 * 刻意用組合而不是讓 `gracefulShutdown` 收一個陣列：那支的每一步（先 abort 再等、與
 * job runner 併行、期限競賽）都是有理由的既有語意，多背景工作跟它無關，不值得為此動它
 * 的簽名與流程。
 *
 * 兩件事必須守住：①**併行**送出（依序 await 等於讓後面的工作晚幾秒才收到 abort，而總
 * 預算只有 graceMs）；②用 `allSettled` 吞掉失敗——`BackgroundWork` 的契約就是「自己吞掉
 * 所有失敗、不把關機拖成 reject」，組合物件不能把成員的例外放出去，否則原本 exit(0) 的
 * 關機會變成 exit(1)。
 */
export function combineBackgroundWork(...works: readonly BackgroundWork[]): BackgroundWork {
  return {
    shutdown: async () => {
      await Promise.allSettled(works.map((work) => work.shutdown()));
    },
  };
}

export async function gracefulShutdown(
  server: Server,
  jobs: JobRunner,
  readiness: ProviderReadinessService,
  graceMs = 3_000,
  background?: BackgroundWork,
): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 100 || graceMs > 30_000)
    throw new Error("Shutdown graceMs is out of range");
  readiness.beginShutdown();
  const serverClosed = new Promise<void>((resolve, reject) =>
    server.close((error?: Error) => (error ? reject(error) : resolve())),
  );
  // 先 abort 再等：背景工作的 in-flight 請求收到 signal 後才可能在期限內收尾。
  // 它自己吞掉所有失敗，故不會把整個關機流程拖成 reject；真的收不掉就由下面的期限接手。
  const backgroundStopped = background?.shutdown() ?? Promise.resolve();
  const jobsStopped = jobs.shutdown(graceMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), graceMs);
  });
  let result: "closed" | "deadline";
  try {
    result = await Promise.race([
      Promise.all([serverClosed, jobsStopped, backgroundStopped]).then(() => "closed" as const),
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
  background?: BackgroundWork,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const dispose = () => {
    runtime.removeListener("SIGINT", onSignal);
    runtime.removeListener("SIGTERM", onSignal);
  };
  const trigger = () => {
    shutdown ??= gracefulShutdown(server, jobs, readiness, graceMs, background)
      .catch((error: unknown) => {
        console.error("Graceful shutdown failed", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
        server.closeAllConnections?.();
        throw error;
      })
      .finally(dispose);
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

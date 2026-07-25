import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { JobRunner } from "../src/jobs.js";
import type { ProviderReadinessService } from "../src/readiness.js";
import { type BackgroundWork, gracefulShutdown } from "../src/shutdown.js";

/**
 * 「圖片描述佇列有跟著關機收尾」這件事的**接線**測試。
 *
 * `ImageDescriptionQueue` 自己的 abort 行為在 image-description.test.ts 已經釘住了，但那
 * 驗不到接線：`index.ts` 是以**第六個位置參數**把佇列交給 `installShutdownHandlers()` 的
 * （中間兩個 undefined），而佇列本身是掛在 `app.locals` 上、型別是 any。這兩處只要有一邊
 * 改了順序或改了鍵名，關機時就再也不會 abort 進行中的 vision 請求——沒有任何測試會紅，
 * 症狀只是 Cloud Run 收到 SIGTERM 後多掛著一個第三方請求直到期限到。
 */

function fakeParts(): {
  server: Server;
  jobs: JobRunner;
  readiness: ProviderReadinessService;
  order: string[];
} {
  const order: string[] = [];
  const server = {
    close: vi.fn((callback: () => void) => {
      order.push("server-close");
      setTimeout(callback, 10);
    }),
    closeAllConnections: vi.fn(),
  } as unknown as Server;
  const jobs = {
    shutdown: vi.fn(() => {
      order.push("jobs-shutdown");
      return new Promise<void>((resolve) => setTimeout(resolve, 10));
    }),
  } as unknown as JobRunner;
  const readiness = { beginShutdown: vi.fn() } as unknown as ProviderReadinessService;
  return { server, jobs, readiness, order };
}

describe("關機時的圖片描述佇列接線", () => {
  it("gracefulShutdown 會叫背景工作收尾，而且在等 job runner 之前就先叫", async () => {
    const { server, jobs, readiness, order } = fakeParts();
    const background: BackgroundWork = {
      shutdown: vi.fn(() => {
        order.push("background-shutdown");
        return new Promise<void>((resolve) => setTimeout(resolve, 10));
      }),
    };

    await gracefulShutdown(server, jobs, readiness, 1_000, background);

    expect(background.shutdown).toHaveBeenCalledTimes(1);
    // 先 abort 再等：反過來的話，進行中的 vision 請求要到 job runner 收完才收到 signal，
    // 期限內根本來不及收尾。
    expect(order.indexOf("background-shutdown")).toBeLessThan(order.indexOf("jobs-shutdown"));
  });

  it("背景工作收不掉時仍然撞期限，不會把關機拖成永遠等待", async () => {
    const { server, jobs, readiness } = fakeParts();
    const background: BackgroundWork = {
      // provider 不理會 abort 的情形：這個 promise 永遠不 settle。
      shutdown: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const startedAt = Date.now();
    await expect(gracefulShutdown(server, jobs, readiness, 200, background)).rejects.toThrow(
      "SERVER_SHUTDOWN_DEADLINE_EXCEEDED",
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("createApp 把佇列掛在 app.locals.imageDescriptions 上，且它就是 index.ts 要的那個介面", async () => {
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-image-desc-wiring-")),
      ".slide-maker-data",
    );
    const app = await createApp(dataRoot);
    const queue = app.locals.imageDescriptions as BackgroundWork | undefined;
    expect(queue).toBeDefined();
    expect(typeof queue!.shutdown).toBe("function");
    // 真的收得掉：關機流程 await 的就是這個 promise。
    await expect(queue!.shutdown()).resolves.toBeUndefined();
  });
});

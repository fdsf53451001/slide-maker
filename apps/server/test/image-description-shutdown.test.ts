import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ImageDescriptionQueue } from "../src/image-description.js";
import type { JobRunner } from "../src/jobs.js";
import type { OcrQueue } from "../src/ocr-queue.js";
import type { ProviderReadinessService } from "../src/readiness.js";
import { combineBackgroundWork, type BackgroundWork, gracefulShutdown } from "../src/shutdown.js";

/**
 * 「背景佇列有跟著關機收尾」這件事的**接線**測試。
 *
 * 各佇列自己的 abort 行為在 image-description.test.ts／ocr-queue 的測試已經釘住了，但那
 * 驗不到接線：`index.ts` 是以**第六個位置參數**把 `app.locals.backgroundWork` 交給
 * `installShutdownHandlers()` 的（中間兩個 undefined），而它掛在 `app.locals` 上、型別是
 * any。這兩處只要有一邊改了順序或改了鍵名，關機時就再也不會 abort 進行中的 vision 請求、
 * 也不會放行排隊中的 OCR——沒有任何測試會紅，症狀只是 Cloud Run 收到 SIGTERM 後多掛著一個
 * 第三方請求直到期限到。
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

  it("createApp 把組合後的背景工作掛在 app.locals.backgroundWork 上，且它涵蓋兩個佇列", async () => {
    const dataRoot = join(
      await mkdtemp(join(tmpdir(), "slide-maker-image-desc-wiring-")),
      ".slide-maker-data",
    );
    const app = await createApp(dataRoot);
    const background = app.locals.backgroundWork as BackgroundWork | undefined;
    expect(background).toBeDefined();
    expect(typeof background!.shutdown).toBe("function");
    // 真的收得掉：關機流程 await 的就是這個 promise。
    await expect(background!.shutdown()).resolves.toBeUndefined();
    // 兩個佇列都真的被收了：只要有一個沒被組進去，關機就只收掉另一個，而測試依然全綠。
    const imageDescriptions = app.locals.imageDescriptions as ImageDescriptionQueue;
    let described = false;
    await imageDescriptions.enqueue(async () => {
      described = true;
    });
    expect(described).toBe(false);
    const ocrQueue = app.locals.ocrQueue as OcrQueue;
    await expect(ocrQueue.run(async () => "ran")).rejects.toThrow("OCR_QUEUE_SHUTDOWN");
  });
});

/**
 * `combineBackgroundWork()` 的兩條不變量。
 *
 * 兩條壞掉都不會讓任何既有測試變紅，症狀卻都在關機那一刻：依序 await 會讓後面的佇列晚
 * 幾秒才收到 abort（而總預算只有 graceMs，等於白等），而讓成員的例外漏出去會把原本
 * exit(0) 的關機變成 `ShutdownDeadlineExceeded` 與 exit(1)。
 */
describe("combineBackgroundWork", () => {
  it("併行送出，不是一個等完再送下一個", async () => {
    const started: string[] = [];
    const gates = ["a", "b", "c"].map((name) => {
      let release!: () => void;
      const work: BackgroundWork = {
        shutdown: () =>
          new Promise<void>((resolve) => {
            started.push(name);
            release = resolve;
          }),
      };
      return { work, release: () => release() };
    });
    const combined = combineBackgroundWork(...gates.map((gate) => gate.work));
    const done = combined.shutdown();
    // 一個都還沒放行，三個就都已經被叫過了。依序 await 的寫法在這裡只會有 ["a"]。
    expect(started).toEqual(["a", "b", "c"]);
    for (const gate of gates) gate.release();
    await expect(done).resolves.toBeUndefined();
  });

  it("成員丟例外時仍然 resolve，而且其他成員照樣被收", async () => {
    const collected: string[] = [];
    const combined = combineBackgroundWork(
      {
        shutdown: async () => {
          collected.push("throws");
          throw new Error("provider 不理會 abort");
        },
      },
      {
        shutdown: async () => {
          collected.push("ok");
        },
      },
    );
    await expect(combined.shutdown()).resolves.toBeUndefined();
    expect(collected).toEqual(["throws", "ok"]);
  });

  it("零個成員也是合法的（收尾立刻完成）", async () => {
    await expect(combineBackgroundWork().shutdown()).resolves.toBeUndefined();
  });
});

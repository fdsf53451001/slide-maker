import { describe, expect, it } from "vitest";
import { OcrQueue } from "../src/ocr-queue.js";

/** 手動控制何時結束的假 OCR 工作。 */
const defer = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * OCR 併發閘門的行為。
 *
 * 這一組釘的是「省下 4 GB」那件事的每一個前提：名額只有一個、名額配發是同步的（不會在
 * await 的空窗被兩個呼叫端看到同一個）、排隊滿了立刻回絕而不是無限堆積、失敗也要還名額、
 * 關機時排隊項目當場放行。任何一條壞掉的症狀都一樣——並行 spawn PaddleOCR、在 Cloud Run
 * （2 GiB）上 OOM，連帶毀掉 jobs.ts 記憶體裡的 job 追蹤。
 */
describe("OcrQueue", () => {
  it("同時只跑一個，其餘排隊，滿了回 BUSY", async () => {
    const queue = new OcrQueue();
    const a = defer<string>();
    const first = queue.run(() => a.promise);
    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(0);
    const second = queue.run(async () => "second");
    const third = queue.run(async () => "third");
    expect(queue.queuedCount).toBe(2);
    await expect(queue.run(async () => "fourth")).rejects.toThrow("OCR_QUEUE_BUSY");
    a.resolve("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    await expect(third).resolves.toBe("third");
    expect(queue.activeCount).toBe(0);
  });

  it("原樣傳遞例外，且失敗後名額有還回來", async () => {
    const queue = new OcrQueue();
    await expect(
      queue.run(async () => {
        throw new Error("OCR_NO_TEXT");
      }),
    ).rejects.toThrow("OCR_NO_TEXT");
    expect(queue.activeCount).toBe(0);
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
  });

  it("shutdown 當場放行排隊項目，之後 run 一律 reject", async () => {
    const queue = new OcrQueue();
    const a = defer<string>();
    const first = queue.run(() => a.promise);
    const second = queue.run(async () => "second");
    const shutdown = queue.shutdown();
    await expect(second).rejects.toThrow("OCR_QUEUE_SHUTDOWN");
    // 不等進行中的那一筆：shutdown 本身要立刻回來。
    await expect(shutdown).resolves.toBeUndefined();
    await expect(queue.run(async () => "later")).rejects.toThrow("OCR_QUEUE_SHUTDOWN");
    a.resolve("first");
    await expect(first).resolves.toBe("first");
  });

  it("建構子拒收不合法的上限", () => {
    expect(() => new OcrQueue(0)).toThrow();
    expect(() => new OcrQueue(1.5)).toThrow();
    expect(() => new OcrQueue(1, -1)).toThrow();
    expect(() => new OcrQueue(1, 1.5)).toThrow();
    // maxQueued 的下限是 1：`0`（完全不排隊）不是一個支援的設定，要在啟動時就吵起來，
    // 而不是讓 `run()` 為了它多帶一個恆真的合取。
    expect(() => new OcrQueue(1, 0)).toThrow();
  });
});

/**
 * 上面那組看的是佇列自己的計數器（`activeCount`／`queuedCount`），這一組看的是**任務有沒有
 * 真的重疊執行**。
 *
 * 兩者不是同一件事：計數器是佇列自己記的帳，如果哪天有人把名額配發改成跨越 `await`
 * （例如在 `#pump` 裡先 `await something()` 再 `#active += 1`），帳面上的數字可能一路正確，
 * 實際卻已經有兩個 PaddleOCR 子程序在跑。會 OOM 的是後者。
 */
describe("OcrQueue 的執行重疊", () => {
  /** 記錄同時執行中的峰值。 */
  const overlapTracker = () => {
    let running = 0;
    let peak = 0;
    return {
      get peak() {
        return peak;
      },
      wrap:
        <T>(task: () => Promise<T>) =>
        async () => {
          running += 1;
          peak = Math.max(peak, running);
          try {
            return await task();
          } finally {
            running -= 1;
          }
        },
    };
  };

  it("大量任務輪流跑完，任何時刻都只有一個在執行，且順序是先進先出", async () => {
    // maxQueued 開大只是為了讓這條測試專心驗序列化；正式的 429 門檻另有測試。
    const queue = new OcrQueue(1, 50);
    const tracker = overlapTracker();
    const finished: number[] = [];
    const started: number[] = [];
    const gates = Array.from({ length: 8 }, () => defer<void>());
    const runs = gates.map((gate, index) =>
      queue.run(
        tracker.wrap(async () => {
          started.push(index);
          await gate.promise;
          finished.push(index);
          return index;
        }),
      ),
    );
    // 第一筆同步就開跑，其餘全在等待區——沒有人「偷跑」。
    expect(started).toEqual([0]);
    expect(queue.queuedCount).toBe(7);
    // 逐一放行；每放行一筆，下一筆才會開始（而且只會開始一筆）。
    //
    // 每一步之間跨一次 macrotask：`#pump()` 掛在 `start().finally(…)` 上，只 await run 本身
    // 的話那個 finally 還沒輪到，這裡量到的會是上一刻的狀態。setImmediate 保證微任務佇列
    // 已經排空，不是在賭時間。
    for (const [index, gate] of gates.entries()) {
      gate.resolve();
      await runs[index];
      await new Promise((resolve) => setImmediate(resolve));
      expect(started).toEqual(Array.from({ length: Math.min(index + 2, 8) }, (_, i) => i));
    }
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 先進先出：排隊順序就是完成順序（抽字是使用者按下去的順序，插隊沒有道理）。
    expect(finished).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tracker.peak).toBe(1);
    expect(queue.activeCount).toBe(0);
  });

  it("任務失敗與正常完成混在一起時，仍然沒有任何一刻重疊", async () => {
    const queue = new OcrQueue(1, 50);
    const tracker = overlapTracker();
    const gate = defer<string>();
    const results: string[] = [];

    const first = queue.run(tracker.wrap(() => gate.promise));
    const failing = queue.run(
      tracker.wrap(async () => {
        throw new Error("OCR_TIMEOUT");
      }),
    );
    const last = queue.run(tracker.wrap(async () => "last"));
    expect(queue.queuedCount).toBe(2);

    gate.resolve("first");
    results.push(await first);
    // 失敗那條也要把名額還回去：不還的話後面整條佇列就此卡死。
    await expect(failing).rejects.toThrow("OCR_TIMEOUT");
    results.push(await last);

    expect(results).toEqual(["first", "last"]);
    expect(tracker.peak).toBe(1);
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });

  it("被 BUSY 擋下的那一筆不留任何痕跡：不排隊、不改變佇列狀態", async () => {
    const queue = new OcrQueue();
    const gate = defer<string>();
    const first = queue.run(() => gate.promise);
    const second = queue.run(async () => "second");
    const third = queue.run(async () => "third");
    expect(queue.queuedCount).toBe(2);

    await expect(queue.run(async () => "busy")).rejects.toThrow("OCR_QUEUE_BUSY");
    expect(queue.queuedCount).toBe(2);
    expect(queue.activeCount).toBe(1);

    gate.resolve("first");
    expect(await Promise.all([first, second, third])).toEqual(["first", "second", "third"]);
  });

  it("關機後，進行中的那一筆跑完不會把佇列重新啟動", async () => {
    const queue = new OcrQueue();
    const gate = defer<string>();
    let extraRan = false;
    const inflight = queue.run(() => gate.promise);
    const queued = queue.run(async () => {
      extraRan = true;
      return "queued";
    });
    await queue.shutdown();
    await expect(queued).rejects.toThrow("OCR_QUEUE_SHUTDOWN");

    gate.resolve("first");
    await expect(inflight).resolves.toBe("first");
    // 進行中那筆收尾時會呼叫 #pump()：關機之後它不得撿起任何東西，名額也要歸零。
    expect(extraRan).toBe(false);
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
    await expect(queue.run(async () => "after")).rejects.toThrow("OCR_QUEUE_SHUTDOWN");
    // 重複關機是安全的（SIGTERM／SIGINT 可能都送到）。
    await expect(queue.shutdown()).resolves.toBeUndefined();
  });
});

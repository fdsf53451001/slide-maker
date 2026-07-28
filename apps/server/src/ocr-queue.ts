import type { BackgroundWork } from "./shutdown.js";

/**
 * 同時最多幾個 OCR。
 *
 * 只能是 1：`PaddleOcrAdapter.recognize()` 會 spawn 一個 `.venv-ocr` 的 python，實測
 * （macOS arm64、1920×1080）單一程序峰值 RSS 約 4.3 GB、耗時約 7 秒，而且並行時記憶體
 * **完全線性成長**（2 個並行 = 8.9 GB，零共享）。而 OCR 本身是 CPU-bound 的單執行緒工作，
 * 在 1 vCPU 的 Cloud Run（2 GiB）上開 2 個吞吐零增益、記憶體翻倍——換來的是 OOM，
 * 而 OOM 連帶毀掉 `jobs.ts` 記在記憶體裡的所有 job 追蹤。
 */
export const OCR_CONCURRENCY = 1;

/**
 * 名額滿載時最多讓幾筆排隊，超過就直接回 429。
 *
 * 抽字是同步請求：排越久，使用者那邊看到的就是一個不會動的按鈕。2 筆（約 15 秒）是
 * 「順手連點兩頁」還等得下去、再多就該叫他等的分界。
 */
export const OCR_MAX_QUEUED = 2;

/** 佇列滿載：呼叫端要回 429。 */
export const OCR_QUEUE_BUSY = "OCR_QUEUE_BUSY";
/** 關機中，不再受理。 */
export const OCR_QUEUE_SHUTDOWN = "OCR_QUEUE_SHUTDOWN";

interface QueueItem {
  /** 真正開跑。內部已吞掉例外（結果都交給 `run()` 回傳的 promise），故永不 reject。 */
  start: () => Promise<void>;
  /** 還沒開跑就被丟掉（關機）。 */
  cancel: (reason: Error) => void;
}

/**
 * OCR 的併發閘門：先進先出、同時最多 {@link OCR_CONCURRENCY} 個、最多 {@link OCR_MAX_QUEUED}
 * 筆排隊。
 *
 * 與 `ImageDescriptionQueue` 的差別在**呼叫端是 HTTP handler**：這裡不吞任何失敗，`run()`
 * 原樣傳遞 task 的回傳值與例外，抽字端點既有的同步 4xx 錯誤契約（`OCR_NO_TEXT`、
 * `OCR_NO_PRESENTATION_TEXT`、`TEXT_LAYER_BOX_LIMIT`）才不會被這一層改寫。
 *
 * 刻意**沒有**取消機制。抽字的產物是持久化的：OCR 之後 handler 會一路做完樣式精修、產遮罩、
 * `jobs.enqueue()` 把抹字 job 寫進 project.json，202 的 body 只是那個 job 物件。所以 client
 * 中途走掉時這一次 OCR 一點都沒白費——job 照建、版本照落地，使用者回來就看到抽好的文字層。
 * 反過來為了「省一次 OCR」而在斷線時取消，等於把算到一半的成果當場銷毀，使用者回來發現什麼
 * 都沒發生只好再按一次，真正的結果是多一次 4 GB 的 OCR。
 */
export class OcrQueue implements BackgroundWork {
  readonly #limit: number;
  readonly #maxQueued: number;
  readonly #queue: QueueItem[] = [];
  #active = 0;
  #stopped = false;

  constructor(limit: number = OCR_CONCURRENCY, maxQueued: number = OCR_MAX_QUEUED) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("OCR concurrency limit invalid");
    // 下限是 1 而不是 0：`maxQueued = 0`（名額滿載時第二筆立刻 429、完全不排隊）沒有呼叫端
    // 要用，而支援它就得在 `run()` 的滿載判斷多掛一個「名額是不是也滿了」的合取——那個合取
    // 在 maxQueued >= 1 時恆真，只會讓讀的人以為自己漏看了什麼情境。
    if (!Number.isInteger(maxQueued) || maxQueued < 1)
      throw new Error("OCR queue capacity invalid");
    this.#limit = limit;
    this.#maxQueued = maxQueued;
  }

  /** 進行中的工作數。 */
  get activeCount(): number {
    return this.#active;
  }

  /** 排隊中、尚未開跑的工作數。 */
  get queuedCount(): number {
    return this.#queue.length;
  }

  /**
   * 取得一個名額後執行 `task`，並原樣回傳它的結果或例外。
   *
   * 名額滿載且佇列也滿了就**立即** reject `OCR_QUEUE_BUSY`——不排隊，因為呼叫端在等一個
   * 同步回應，排到天荒地老不如馬上告訴他「等一下再按」。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    // 這個 early return 同時維持了 `#pump()` 依賴的不變量：stopped 之後不會再有東西進佇列。
    if (this.#stopped) return Promise.reject(new Error(OCR_QUEUE_SHUTDOWN));
    // 比的是**等待區**的長度（「前面還有幾個人在排」），不含正在跑的那一個。
    if (this.#queue.length >= this.#maxQueued) return Promise.reject(new Error(OCR_QUEUE_BUSY));
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<T>((resolveFn, rejectFn) => {
      resolve = resolveFn;
      reject = rejectFn;
    });
    this.#queue.push({
      start: async () => {
        try {
          resolve(await task());
        } catch (error) {
          // 呼叫端要拿到**真正的**錯誤：抽字端點的 4xx 契約全靠它。
          reject(error);
        }
      },
      cancel: (reason) => reject(reason),
    });
    this.#pump();
    return done;
  }

  /**
   * 關機收尾。
   *
   * 刻意**不等**進行中的那一筆：OCR 子程序約 7 秒起跳（`PaddleOcrAdapter` 的逾時上限是
   * 5 分鐘），而 `gracefulShutdown` 的預算是 3 秒——等下去必定超時，把原本的 exit(0)
   * 換成 `ShutdownDeadlineExceeded` 與 exit(1)。子程序有自己的逾時，行程結束時也會跟著
   * 收掉，沒有需要在這裡守的狀態。
   */
  async shutdown(): Promise<void> {
    this.#stopped = true;
    // 排隊中的一律當場放行，**不能**交給 #pump()：它的外層是 `while (#active < #limit)`，
    // 名額滿載時（關機的常態）一圈都不會跑，排隊項目就留在佇列裡永遠不 settle，等它的
    // HTTP handler 跟著掛住，關機一路吊到 gracefulShutdown 的期限、丟
    // ShutdownDeadlineExceeded 並 exit(1)。
    //
    // 設旗標與清空之間沒有 await，所以「stopped 之後佇列必為空」成立（見 #pump）。
    for (const item of this.#queue.splice(0)) item.cancel(new Error(OCR_QUEUE_SHUTDOWN));
  }

  /**
   * 名額調度全部集中在這裡且**同步**完成，`#active` 才不會在 await 的空窗被兩個呼叫端
   * 同時看到同一個名額（那正是「限 1 個」會悄悄變成 2 個、記憶體跟著翻倍的典型寫法）。
   *
   * 這裡不需要再檢查 `#stopped`：`run()` 在 stopped 之後不再入列、`shutdown()` 又是同步地
   * 設旗標後立刻清空，兩者合起來保證 stopped 時佇列是空的，`shift()` 會先回 undefined 而
   * 提早 return。（實測過：名額滿載時關機、task 內部呼叫 shutdown、shutdown 與 run 同 tick
   * 交錯、reject handler 裡再排一筆、limit > 1 多筆在途——五種時序都走不到那個分支。）
   */
  #pump(): void {
    while (this.#active < this.#limit) {
      const item = this.#queue.shift();
      if (!item) return;
      this.#active += 1;
      // `start()` 內部已經接住例外，這裡的 finally 只負責還名額。
      void item.start().finally(() => {
        this.#active -= 1;
        this.#pump();
      });
    }
  }
}

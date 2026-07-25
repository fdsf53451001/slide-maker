import { spawn, type SpawnOptions } from "node:child_process";

/**
 * 子行程收屍的共用狀態機（OCR 與本地抹字兩條路共用）。
 *
 * 收屍的關鍵不變量：SIGTERM 之後排定的 SIGKILL 計時器**只有在子程序真的
 * close/exit 時才清除**。若在 reject 的同步區塊裡就把它清掉（舊版兩處的 bug），
 * 剛排定的 SIGKILL callback 永遠不會觸發——升級形同死碼，忽略 SIGTERM 或卡在
 * 原生呼叫的子程序就永遠不會被強制收屍。
 */

/** SIGTERM 後等這麼久仍未退出就 SIGKILL 強制收屍。 */
export const DEFAULT_SIGKILL_GRACE_MS = 5_000;

export interface ReapableChildOptions {
  command: string;
  args: readonly string[];
  spawnOptions?: SpawnOptions;
  /** 逾時上限；到點先 SIGTERM，寬限期內未退出再 SIGKILL，並以 onTimeout() reject。 */
  timeoutMs: number;
  /** SIGTERM 後的 SIGKILL 寬限期，預設 DEFAULT_SIGKILL_GRACE_MS。 */
  sigkillGraceMs?: number;
  /** 外部取消訊號；abort 時比照逾時收屍，並以 onAbort() reject。 */
  signal?: AbortSignal;
  /** 逾時要 reject 的錯誤（具名，與其他失敗可區分）。 */
  onTimeout: () => Error;
  /** abort 要 reject 的錯誤；預設 DOMException("Generation cancelled", "AbortError")。 */
  onAbort?: () => Error;
}

export interface ReapableChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function abortError(options: ReapableChildOptions): Error {
  return options.onAbort?.() ?? new DOMException("Generation cancelled", "AbortError");
}

/**
 * spawn 一個子程序並保證收屍：逾時／abort 先送 SIGTERM，寬限期內未退出再送 SIGKILL，
 * 且不論如何 promise 最終都會 settle（成功→resolve、失敗/逾時/abort→reject）。
 * stdout／stderr 只在被 pipe 時才收集，未 pipe 的那一路回空字串。
 */
export function runReapableChild(options: ReapableChildOptions): Promise<ReapableChildResult> {
  const grace = options.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(abortError(options));
      return;
    }
    const child = spawn(options.command, [...options.args], options.spawnOptions ?? {});
    let stdout = "";
    let stderr = "";
    let settled = false;
    // 只在子程序真的 close/exit 時才清（見檔頭）。
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const requestTermination = (reason: () => Error) => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), grace);
      killTimer.unref?.();
      // 主逾時計時器與 abort listener 在這裡就可以收（子程序仍由 killTimer 顧著），
      // 但 killTimer 本身要留到 close/exit。
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", handleAbort);
      settle(() => reject(reason()));
    };
    const handleAbort = () => requestTermination(() => abortError(options));
    const timer = setTimeout(() => requestTermination(options.onTimeout), options.timeoutMs);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // close／error 代表子程序已真的退出：這裡是唯一該清 killTimer 的地方。正常結束時
    // 主計時器尚在、killTimer 從未排定，一併清除不留 timer。
    const finalize = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", handleAbort);
    };
    child.once("error", (error) => {
      finalize();
      settle(() => reject(error));
    });
    child.once("close", (code) => {
      finalize();
      settle(() => resolvePromise({ code, stdout, stderr }));
    });
  });
}

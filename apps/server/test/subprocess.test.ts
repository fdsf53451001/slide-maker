import { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReapableChild } from "../src/subprocess.js";

/**
 * 子行程收屍狀態機的單元測試。刻意只用 `/bin/sh`（不需要 `.venv-ocr`），這樣在
 * 任何機器上都跑得動，不會被 skip。核心要釘住的行為：
 *  - 逾時／abort 一定 reject（不會永久 pending）；
 *  - SIGTERM 無效時，寬限期後真的補送 SIGKILL（升級不是死碼）；
 *  - 正常結束或 SIGTERM 有效時，不會多送一記 SIGKILL、也不留 timer。
 */

/** 記錄本行程內所有子程序收到的訊號（spy 仍呼叫原本的 kill，子程序照樣被砍）。 */
function spyOnKills(): { signals: () => string[]; restore: () => void } {
  const spy = vi.spyOn(ChildProcess.prototype, "kill");
  return {
    signals: () => spy.mock.calls.map((call) => String(call[0] ?? "SIGTERM")),
    restore: () => spy.mockRestore(),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("runReapableChild", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("成功路徑：收集 stdout／stderr 並以 exit code resolve", async () => {
    const result = await runReapableChild({
      command: "/bin/sh",
      args: ["-c", "printf hello; printf oops 1>&2; exit 0"],
      spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
      timeoutMs: 5_000,
      onTimeout: () => new Error("SHOULD_NOT_TIME_OUT"),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("oops");
  });

  it("非零結束碼仍以 resolve 回報（不 reject）", async () => {
    const result = await runReapableChild({
      command: "/bin/sh",
      args: ["-c", "exit 3"],
      spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
      timeoutMs: 5_000,
      onTimeout: () => new Error("SHOULD_NOT_TIME_OUT"),
    });
    expect(result.code).toBe(3);
  });

  it("逾時且子程序忽略 SIGTERM：reject 具名逾時錯，且寬限期後補送 SIGKILL", async () => {
    const kills = spyOnKills();
    try {
      const promise = runReapableChild({
        // trap '' TERM 讓 shell 忽略 SIGTERM，只有 SIGKILL 收得掉它。
        command: "/bin/sh",
        args: ["-c", "trap '' TERM; sleep 5"],
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
        timeoutMs: 100,
        sigkillGraceMs: 150,
        onTimeout: () => new Error("REAPABLE_TIMEOUT"),
      });
      await expect(promise).rejects.toThrow("REAPABLE_TIMEOUT");
      // reject 之後，SIGKILL 升級仍要在寬限期後真的發生。
      await waitUntil(() => kills.signals().includes("SIGKILL"));
      expect(kills.signals()[0]).toBe("SIGTERM");
      expect(kills.signals()).toContain("SIGKILL");
    } finally {
      kills.restore();
    }
  });

  it("abort 且子程序忽略 SIGTERM：reject AbortError，且補送 SIGKILL", async () => {
    const kills = spyOnKills();
    const controller = new AbortController();
    try {
      const promise = runReapableChild({
        command: "/bin/sh",
        args: ["-c", "trap '' TERM; sleep 5"],
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
        timeoutMs: 60_000,
        sigkillGraceMs: 150,
        signal: controller.signal,
        onTimeout: () => new Error("SHOULD_NOT_TIME_OUT"),
      });
      setTimeout(() => controller.abort(), 50);
      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      await waitUntil(() => kills.signals().includes("SIGKILL"));
      expect(kills.signals()[0]).toBe("SIGTERM");
    } finally {
      kills.restore();
    }
  });

  it("SIGTERM 有效時不多送 SIGKILL，也不留 timer", async () => {
    const kills = spyOnKills();
    try {
      const promise = runReapableChild({
        // 沒有 trap：預設 SIGTERM 直接把 shell 收掉，close 後應清掉 SIGKILL 計時器。
        command: "/bin/sh",
        args: ["-c", "sleep 5"],
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
        timeoutMs: 100,
        sigkillGraceMs: 150,
        onTimeout: () => new Error("REAPABLE_TIMEOUT"),
      });
      await expect(promise).rejects.toThrow("REAPABLE_TIMEOUT");
      // 等到「若 killTimer 沒被清、SIGKILL 早就該發」的時間點之後再斷言它沒被送出。
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(kills.signals()).toContain("SIGTERM");
      expect(kills.signals()).not.toContain("SIGKILL");
    } finally {
      kills.restore();
    }
  });

  it("傳入已 abort 的 signal 時立即 reject，不 spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const kills = spyOnKills();
    try {
      await expect(
        runReapableChild({
          command: "/bin/sh",
          args: ["-c", "exit 0"],
          spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
          timeoutMs: 5_000,
          signal: controller.signal,
          onTimeout: () => new Error("SHOULD_NOT_TIME_OUT"),
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(kills.signals()).toHaveLength(0);
    } finally {
      kills.restore();
    }
  });
});

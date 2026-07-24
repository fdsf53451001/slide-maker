import { describe, expect, it } from "vitest";
import { ProviderRegistry, type ImageProvider } from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import type { FileProjectRepository } from "../src/repository.js";

/**
 * fix #1（AbortController 洩漏）的回歸測試。
 *
 * `run()` 在首個 `updateProject` 之前就把 job 的 AbortController 註冊進 `#controllers`
 * （取消才能在 queued→running 轉換期間 abort 到它）。若這個 `updateProject` 拋出——
 * 例如 job 還在排隊時專案被刪——run() 不會進到底部的 finally 清理，controller 會永遠
 * 留在 map 裡。這裡用一個「updateProject 直接拋錯」的假 repository 直接驅動 run()
 * （私有方法，經型別轉換呼叫），斷言收場後 map 是空的。
 */

type RunAccess = { run(projectId: string, jobId: string): Promise<void> };

describe("JobRunner controller lifecycle", () => {
  it("首個 updateProject 拋出（排隊中專案被刪）時不殘留 controller", async () => {
    let calls = 0;
    const repository = {
      updateProject: async () => {
        calls += 1;
        throw new Error("PROJECT_DELETED");
      },
    } as unknown as FileProjectRepository;
    const runner = new JobRunner(repository, new ProviderRegistry<ImageProvider>());

    await expect((runner as unknown as RunAccess).run("project", "job")).rejects.toThrow(
      "PROJECT_DELETED",
    );
    expect(calls).toBe(1);
    // 修法前：controller 在 updateProject 之前註冊、拋出後洩漏，這裡會是 1。
    expect(runner.activeControllerCount()).toBe(0);
  });

  it("首個 updateProject 回 undefined（job 已非 queued）時也不殘留 controller", async () => {
    const repository = {
      updateProject: async () => undefined,
    } as unknown as FileProjectRepository;
    const runner = new JobRunner(repository, new ProviderRegistry<ImageProvider>());

    await (runner as unknown as RunAccess).run("project", "job");
    expect(runner.activeControllerCount()).toBe(0);
  });
});

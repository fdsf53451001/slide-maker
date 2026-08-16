import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProject, ProviderRegistry, type ImageProvider } from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

/*
 * 主畫面「最近簡報」照 `project.updatedAt` 由新到舊排（`sortProjectsByUpdatedAt()`），所以
 * 那個欄位的語意只有一個：**使用者最後一次修改這份專案的時間**。程序生命週期的動作——關機
 * 終止進行中的工作、開機把中斷的工作標成失敗——都不是修改，動了它就會打亂排序。
 *
 * 這一組釘的是實際踩過的災情：舊版 `performShutdown()` 對**每一份**專案都跑 `updateProject`
 * 並無條件寫 `current.updatedAt = now`，於是每重啟一次伺服器，所有專案的最後修改時間就被
 * 抹平成同一個關機戳記（實測 21 份專案全等於 `2026-08-16T06:31:52.975Z`），主畫面因此完全
 * 沒有排序信號、每張卡片都印同一個時間。
 *
 * mtime 的斷言不是多餘的：只看 `updatedAt` 的話，「照樣把整份 project.json 讀進來、驗證、
 * 重寫一遍，只是沒改那個欄位」也會過關——而那正是關機寬限期內最不該做的事（21 份專案 ×
 * 每次 SIGTERM）。mtime 才分得出「跳過」與「寫了一份一模一樣的」。
 */

const OLD = "2026-07-14T01:00:00.000Z";

async function fixture(jobStatus: "queued" | "running") {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-updated-at-"));
  const repository = new FileProjectRepository(root);
  const busy = createProject({ topic: "有進行中的工作" });
  busy.jobs.push({
    id: `${jobStatus}-job`,
    projectId: busy.id,
    slideId: busy.slides[0]!.id,
    providerId: "qa-image",
    status: jobStatus,
    operation: "generate",
    attempt: 1,
    createdAt: OLD,
    updatedAt: OLD,
  });
  busy.updatedAt = OLD;
  const idle = createProject({ topic: "沒有任何工作" });
  idle.updatedAt = OLD;
  await repository.saveProject(busy);
  await repository.saveProject(idle);
  const idlePath = join(repository.projectRoot(idle.id), "project.json");
  const idleMtime = (await stat(idlePath)).mtimeMs;
  const runner = new JobRunner(repository, new ProviderRegistry<ImageProvider>());
  return { repository, runner, busy, idle, idlePath, idleMtime };
}

describe("專案的 updatedAt 只跟著使用者的修改走", () => {
  it("關機終止工作時，不動任何專案的 updatedAt，也不重寫沒有工作的專案", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { repository, runner, busy, idle, idlePath, idleMtime } = await fixture("queued");

    await runner.shutdown(200);

    const stopped = await repository.loadProject(busy.id);
    // 工作真的被終止了（否則下面的 updatedAt 斷言會因為「整段沒跑」而恆真）。
    expect(stopped?.jobs[0]).toMatchObject({ status: "failed", errorCode: "SERVER_SHUTDOWN" });
    expect(stopped?.updatedAt).toBe(OLD);
    const untouched = await repository.loadProject(idle.id);
    expect(untouched?.updatedAt).toBe(OLD);
    expect((await stat(idlePath)).mtimeMs).toBe(idleMtime);
  });

  it("開機把中斷的工作標成失敗時，同樣不動 updatedAt", async () => {
    const { repository, runner, busy, idle, idlePath, idleMtime } = await fixture("running");

    await runner.recoverInterruptedJobs();

    const recovered = await repository.loadProject(busy.id);
    expect(recovered?.jobs[0]).toMatchObject({ status: "failed", errorCode: "SERVER_RESTARTED" });
    expect(recovered?.updatedAt).toBe(OLD);
    const untouched = await repository.loadProject(idle.id);
    expect(untouched?.updatedAt).toBe(OLD);
    expect((await stat(idlePath)).mtimeMs).toBe(idleMtime);
  });
});

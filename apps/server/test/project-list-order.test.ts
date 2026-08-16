import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createProject } from "@slide-maker/core";
import { FileProjectRepository } from "../src/repository.js";

/**
 * `listProjects()` 回的順序就是主畫面「最近簡報」的順序：`updatedAt` 由新到舊。
 *
 * 規則本身由 `packages/core` 的 `sortProjectsByUpdatedAt()` 單元測試釘住，這裡釘的是
 * **這一端真的有排**——磁碟上的專案來自 `readdir`，那個順序既不是修改時間也沒有任何保證，
 * 排序被拿掉時使用者看到的是一份「看起來隨機」的清單。前端只有在開頁時抓這一次，
 * 之後全靠本機狀態維護，所以這一趟排錯了，重新整理之前都不會自己好。
 */
describe("專案清單的順序", () => {
  let repository: FileProjectRepository;

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-list-order-")),
      ".slide-maker-data",
    );
    repository = new FileProjectRepository(root);
    await repository.initialize();
    // id 直接給定而不是用產生的 uuid：目錄名決定 `readdir` 的順序，隨機 id 有六分之一
    // 的機率碰巧就是正確順序，那樣「排序被拿掉」的變異有時抓不到。
    // 字典序是 aaa → bbb → ccc，期待的順序是 bbb → ccc → aaa，兩者沒有共同前綴。
    for (const [id, updatedAt] of [
      ["aaa", "2026-01-01T00:00:00.000Z"],
      ["bbb", "2026-08-16T10:00:00.000Z"],
      ["ccc", "2026-05-05T05:05:05.000Z"],
    ] as const) {
      const project = createProject({ topic: `專案 ${id}` });
      project.id = id;
      project.updatedAt = updatedAt;
      await repository.saveProject(project);
    }
  });

  it("照 updatedAt 由新到舊回，而不是磁碟上的目錄順序", async () => {
    const listed = await repository.listProjects();
    expect(listed.map((project) => project.id)).toEqual(["bbb", "ccc", "aaa"]);
    // 順序與時間戳一致——這正是使用者在卡片上看得到的那一欄。
    expect(listed.map((project) => project.updatedAt)).toEqual([
      "2026-08-16T10:00:00.000Z",
      "2026-05-05T05:05:05.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });
});

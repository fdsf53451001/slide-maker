import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * SPA fallback 對「部署路徑上有點開頭目錄」的情形。
 *
 * `res.sendFile()` 底下的 `send` 預設是 `dotfiles:"ignore"`，而它檢查的是**整條絕對路徑**的
 * 每一個分段——只要有任何一層是 `.foo`（git worktree 的 `.claude/worktrees/…`、
 * `~/.local/share/…`、CI 的 `.cache/…`），對存在的 index.html 也會丟
 * `NotFoundError("Not Found")`，而那個訊息又正好落進錯誤中介層的 `/not found/i` 分支。
 *
 * 症狀特別難認：首頁打得開（那是 `express.static` 服務的，它的 dotfile 檢查只看 root 以下的
 * 相對路徑），但重新整理任何子頁面都變成一段 `{"error":"NOT_FOUND"}` 的 JSON。2026-08-29 在
 * `.claude/worktrees/…` 的 worktree 上實測到，`/` 回 200、`/models` 回那段 JSON。
 *
 * 既有的 qa-api 測試只打 `/`，所以擋不住這件事——那條路徑由 static 接走，永遠是綠的。
 */
describe("編輯器 SPA fallback", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("部署路徑含點開頭目錄時，子路由仍回得出 index.html", async (context) => {
    const base = await mkdtemp(join(tmpdir(), "slide-maker-editor-shell-"));
    const editorDist = join(base, ".worktrees", "editor", "dist");
    await mkdir(editorDist, { recursive: true });
    await writeFile(join(editorDist, "index.html"), '<div id="root"></div>');

    const app = await createApp(join(base, ".slide-maker-data"), editorDist);
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      // 沙箱不給 bind 時跳過，比照其他會 listen 的測試。
      if (["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
        return context.skip();
      throw error;
    }
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    // 前端路由（/models、/projects/... 之類）在重新整理時是一個真的 GET，必須拿到 shell。
    const spa = await fetch(`${baseUrl}/models`);
    expect(spa.status).toBe(200);
    await expect(spa.text()).resolves.toContain('<div id="root"></div>');

    // `/` 由 static 服務，修正前後都是綠的——留著是為了讓「只有 static 那條會過」這件事
    // 在測試裡看得見。
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);

    // API 的 404 不受影響：它必須維持 JSON，前端靠這個分辨「打錯端點」與「頁面不存在」。
    const api = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(api.status).toBe(404);
    await expect(api.json()).resolves.toEqual({ error: "NOT_FOUND" });
  });
});

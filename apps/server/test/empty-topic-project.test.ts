import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNTITLED_PROJECT_NAME, type PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

/*
  主畫面的「開始規劃」不強迫先想好主題：空著也能建立專案，需求留到精靈的 STEP 2 補填
  （欄位空著時以橘色外框標示）。真正擋住的是「產生大綱」——沒有主題就沒有東西可以規劃——
  而不是建立專案本身，否則使用者連上傳素材、挑模型組合都做不了。

  端點層必須自己有測試：`topic` 的 `min(1)` 在 core 的 brief schema 與這個端點的輸入 schema
  上**各有一份**，只放寬其中一邊，另一邊照樣回 400（而前端送出後只會看到一句 zod 的英文
  錯誤，沒有下一步）。補主題時的改名也一樣：`name` 是 `min(1)`，空主題的專案叫
  UNTITLED_PROJECT_NAME，若改名規則只認得「名稱等於舊主題」，這份專案會永遠叫「未命名簡報」。
*/
describe("空白主題的專案", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-empty-topic-")),
      ".slide-maker-data",
    );
    const app = await createApp(root);
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        bindUnavailable = true;
        return;
      }
      throw error;
    }
    if (!server) throw new Error("Local test server did not initialize");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const create = async (body: unknown): Promise<PresentationProject> => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as PresentationProject;
  };

  const patch = async (
    path: string,
    projectId: string,
    body: unknown,
  ): Promise<PresentationProject> => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as PresentationProject;
  };

  it("不填需求也能建立，主題留空、名稱補成未命名", async () => {
    if (bindUnavailable) return;
    const project = await create({ topic: "" });
    expect(project.brief.topic).toBe("");
    expect(project.name).toBe(UNTITLED_PROJECT_NAME);
    expect(project.workflowStage).toBe("requirements");
    // 重新讀回來也要活得下去：`name` 的 min(1) 在每次載入專案時都會再驗一次。
    const reloaded = (await (
      await fetch(`${baseUrl}/api/projects/${project.id}`)
    ).json()) as PresentationProject;
    expect(reloaded.name).toBe(UNTITLED_PROJECT_NAME);
  });

  it("之後在精靈補上需求時，未命名的專案跟著改名", async () => {
    if (bindUnavailable) return;
    const project = await create({ topic: "" });
    const named = await patch("brief", project.id, { topic: "導入計畫說明" });
    expect(named.brief.topic).toBe("導入計畫說明");
    expect(named.name).toBe("導入計畫說明");
  });

  it("使用者自己取過的名字不會被補主題蓋掉", async () => {
    if (bindUnavailable) return;
    const project = await create({ topic: "" });
    const renamed = await patch("name", project.id, { name: "給董事會的版本" });
    expect(renamed.name).toBe("給董事會的版本");

    const withTopic = await patch("brief", project.id, { topic: "導入計畫說明" });
    expect(withTopic.brief.topic).toBe("導入計畫說明");
    expect(withTopic.name).toBe("給董事會的版本");
  });

  it("名稱剛好等於未命名字樣、但主題本來就有內容時，改主題不動名稱", async () => {
    if (bindUnavailable) return;
    // 跟著主題走的規則綁在「舊主題是空的」上，而不是只看名稱長什麼樣——否則使用者刻意
    // 把專案改名成這四個字，就再也保不住這個名字。
    const project = await create({ topic: "原本的主題" });
    const renamed = await patch("name", project.id, { name: UNTITLED_PROJECT_NAME });
    expect(renamed.name).toBe(UNTITLED_PROJECT_NAME);

    const withTopic = await patch("brief", project.id, { topic: "換過的主題" });
    expect(withTopic.name).toBe(UNTITLED_PROJECT_NAME);
  });
});

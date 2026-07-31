import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

/*
  PATCH /brief 的 merge 語意是**編輯器那個自動搜尋勾選框的地基**。

  `webSearchMode` 是專案設定（多人共用同一台伺服器，server 端沒有 session／user 概念），
  所以前端的規則是「只有勾選框可以寫它，其他寫 brief 的動作一律不送這個欄位」
  （`Editor.tsx` 的 `briefPatchWithoutWebSearch`）——**少送＝不要動它**。

  這條規則整個押在伺服器身上：`presentationBriefSchema.partial().parse(body)` 之後
  `{ ...current.brief, ...patch }`。兩件事各自都會無聲毀掉它：
  ① `.partial()` 被拿掉或換成整份 parse → 缺欄位會被 `.default()` 補成 "cached"，
     於是「儲存 Brief」會把別人剛關掉的搜尋倒回開啟；
  ② 改成整份取代而非 merge → 同上。

  而且這兩種回退**前端一個測試都抓不到**：Editor.test.tsx 的 fetch mock 自己實作了
  `{ ...project.brief, ...patch }`，伺服器怎麼變它都照樣綠。所以這一份必須在 server 端。
*/
describe("PATCH /brief 的 partial merge 語意", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let projectId = "";

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-brief-patch-merge-")),
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
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "brief merge" }),
    });
    projectId = ((await created.json()) as PresentationProject).id;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const patchBrief = async (body: unknown): Promise<PresentationProject> => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/brief`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as PresentationProject;
  };

  it("只送 webSearchMode 就能改它，其餘 brief 欄位一個都沒動", async () => {
    if (bindUnavailable) return;
    const before = (
      (await (await fetch(`${baseUrl}/api/projects/${projectId}`)).json()) as PresentationProject
    ).brief;
    expect(before.webSearchMode).toBe("cached");

    const after = (await patchBrief({ webSearchMode: "disabled" })).brief;

    expect(after.webSearchMode).toBe("disabled");
    expect({ ...after, webSearchMode: null }).toEqual({
      ...before,
      webSearchMode: null,
    });
  });

  it("body 裡沒有 webSearchMode 時保留現值，不會被 schema 的預設值補成 cached", async () => {
    if (bindUnavailable) return;
    // 承上，專案現在是 disabled。這正是「儲存 Brief／精靈下一步／產生大綱」送出的形狀：
    // 整份草稿、但剝掉 webSearchMode。
    const after = (
      await patchBrief({
        topic: "改過的主題",
        audience: "工程團隊",
        purpose: "決策",
        language: "zh-TW",
        desiredSlideCount: 7,
        tone: "沉穩",
        contentMode: "creative",
      })
    ).brief;

    expect(after.topic).toBe("改過的主題");
    expect(after.desiredSlideCount).toBe(7);
    // 少送這個欄位＝不要動它。補成 default("cached") 等於把別人剛關掉的自動搜尋打開。
    expect(after.webSearchMode).toBe("disabled");
  });

  it("空 patch 不會把任何欄位重設成預設值", async () => {
    if (bindUnavailable) return;
    // 先把幾個帶 `.default()` 的欄位都推離預設值，空 patch 才有東西可以打壞——全部停在預設值
    // 上時，「保留現值」與「重設成預設值」產出一模一樣的結果，這條就會是永遠綠的假測試。
    const before = (
      await patchBrief({ webSearchMode: "disabled", desiredSlideCount: 9, tone: "冷靜" })
    ).brief;
    expect(before.webSearchMode).toBe("disabled");

    expect((await patchBrief({})).brief).toEqual(before);
  });

  it("cached 原樣保留，不會被伺服器正規化成 live", async () => {
    if (bindUnavailable) return;
    // 舊專案存的就是 "cached"；伺服器端只有 "disabled" 會跳過搜尋，但把 cached 改寫成 live
    // 會讓「這份專案到底被誰改過」變得不可判讀，前端也刻意不做這件事。
    expect((await patchBrief({ webSearchMode: "cached" })).brief.webSearchMode).toBe("cached");
    expect((await patchBrief({ topic: "又改一次" })).brief.webSearchMode).toBe("cached");
  });
});

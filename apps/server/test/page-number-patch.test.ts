import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

describe("頁碼 PATCH 的部分更新語意", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let projectId = "";

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-page-number-patch-")),
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
      body: JSON.stringify({ topic: "頁碼部分更新" }),
    });
    projectId = ((await created.json()) as PresentationProject).id;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const patch = async (body: unknown, id = projectId) =>
    fetch(`${baseUrl}/api/projects/${id}/page-number`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const settings = async () =>
    ((await (await fetch(`${baseUrl}/api/projects/${projectId}`)).json()) as PresentationProject)
      .pageNumber;

  it("先把每個欄位都設成非預設值，作為後續部分更新的對照基準", async () => {
    if (bindUnavailable) return;
    const body = {
      enabled: true,
      position: "bottom-center",
      format: "zh-page",
      startAt: 7,
      skipFirstSlide: false,
      fontSize: 44,
      color: "#abcdef",
      opacity: 0.45,
      background: { enabled: true, color: "#123456", opacity: 0.6 },
    };
    expect((await patch(body)).ok).toBe(true);
    expect(await settings()).toEqual(body);
  }, 60_000);

  it("只送 position 時，其餘八個欄位一個都不動", async () => {
    if (bindUnavailable) return;
    const before = await settings();
    const updated = (
      (await (await patch({ position: "bottom-left" })).json()) as PresentationProject
    ).pageNumber;
    // 逐欄位比對而非只看 position：漏掉的欄位被預設值洗掉正是這個端點最容易犯的錯。
    expect(updated).toEqual({ ...before, position: "bottom-left" });
  }, 60_000);

  it("只送 background.opacity 時，background.enabled 與 color 都留著", async () => {
    if (bindUnavailable) return;
    const before = await settings();
    const updated = (
      (await (await patch({ background: { opacity: 0.9 } })).json()) as PresentationProject
    ).pageNumber;
    expect(updated).toEqual({ ...before, background: { ...before.background, opacity: 0.9 } });
  }, 60_000);

  it("空 patch 是 no-op，不會把任何欄位打回預設", async () => {
    if (bindUnavailable) return;
    const before = await settings();
    expect(((await (await patch({})).json()) as PresentationProject).pageNumber).toEqual(before);
    expect(
      ((await (await patch({ background: {} })).json()) as PresentationProject).pageNumber,
    ).toEqual(before);
  }, 60_000);

  it("未知欄位被忽略，不會寫進專案", async () => {
    if (bindUnavailable) return;
    const before = await settings();
    const updated = (
      (await (
        await patch({ position: "bottom-right", verticalOffset: 999, background: { blur: 4 } })
      ).json()) as PresentationProject
    ).pageNumber;
    expect(updated).toEqual({ ...before, position: "bottom-right" });
    expect(updated).not.toHaveProperty("verticalOffset");
    expect(updated.background).not.toHaveProperty("blur");
  }, 60_000);

  it("每一種非法值都被擋在 400，且不留下部分寫入", async () => {
    if (bindUnavailable) return;
    const before = await settings();
    const rejected: unknown[] = [
      { startAt: 0 },
      { startAt: 1000 },
      { startAt: 1.5 },
      { fontSize: 11 },
      { fontSize: 121 },
      { opacity: 0 },
      { opacity: 1.5 },
      { color: "red" },
      { color: "#fff" },
      { color: "#12345g" },
      { position: "top-left" },
      { format: "roman" },
      { enabled: "yes" },
      { skipFirstSlide: 1 },
      { background: { color: "blue" } },
      { background: { opacity: 0 } },
      { background: { opacity: 2 } },
      { background: null },
      // 合法欄位搭配非法欄位：整筆必須被拒，不能只寫入前者。
      { position: "bottom-left", opacity: 9 },
    ];
    for (const body of rejected) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: "INVALID_REQUEST",
      });
    }
    expect(await settings()).toEqual(before);
  }, 60_000);

  it("不存在的專案回 404 而不是靜默建立一份設定", async () => {
    if (bindUnavailable) return;
    const response = await patch({ enabled: true }, "00000000-0000-4000-8000-000000000000");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  }, 60_000);
});

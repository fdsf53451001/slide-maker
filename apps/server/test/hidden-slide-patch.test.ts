import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

describe("隱藏頁的 PATCH 語意", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let bindUnavailable = false;
  let projectId = "";

  beforeAll(async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), "slide-maker-hidden-slide-patch-")),
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
      body: JSON.stringify({ topic: "隱藏頁" }),
    });
    projectId = ((await created.json()) as PresentationProject).id;
  }, 60_000);

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const load = async () =>
    (await (await fetch(`${baseUrl}/api/projects/${projectId}`)).json()) as PresentationProject;

  const patchSlide = async (slideId: string, body: unknown) =>
    fetch(`${baseUrl}/api/projects/${projectId}/slides/${slideId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("新專案的每一頁預設都是可見的", async () => {
    if (bindUnavailable) return;
    const project = await load();
    expect(project.slides.every((slide) => slide.hidden === false)).toBe(true);
  });

  it("只送 hidden 就能來回切換，其餘欄位一個都沒動", async () => {
    if (bindUnavailable) return;
    const before = (await load()).slides[1]!;
    const hidden = (
      (await (await patchSlide(before.id, { hidden: true })).json()) as PresentationProject
    ).slides[1]!;
    expect(hidden.hidden).toBe(true);
    expect({ ...hidden, hidden: false }).toEqual(before);

    const shown = (
      (await (await patchSlide(before.id, { hidden: false })).json()) as PresentationProject
    ).slides[1]!;
    expect(shown).toEqual(before);
  });

  it("隱藏不是大綱變更：不會把這一頁標成與圖不同步", async () => {
    if (bindUnavailable) return;
    // hidden 一個像素都沒動到圖，列進 outlineFields 會讓「先隱藏再取消隱藏」留下橘框。
    const slideId = (await load()).slides[2]!.id;
    await patchSlide(slideId, { hidden: true });
    expect((await load()).slides[2]!.outlineDirty).toBe(false);
  });

  it("同一筆 PATCH 裡與大綱欄位並存時，大綱那一半仍照常標記", async () => {
    if (bindUnavailable) return;
    const slideId = (await load()).slides[3]!.id;
    await patchSlide(slideId, { hidden: true, purpose: "改過的目的" });
    const slide = (await load()).slides[3]!;
    expect(slide.hidden).toBe(true);
    expect(slide.purpose).toBe("改過的目的");
    expect(slide.outlineDirty).toBe(true);
  });

  it("非布林值的 hidden 被擋下來，不會寫進專案", async () => {
    if (bindUnavailable) return;
    const slideId = (await load()).slides[4]!.id;
    const response = await patchSlide(slideId, { hidden: "yes" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await load()).slides[4]!.hidden).toBe(false);
  });
});

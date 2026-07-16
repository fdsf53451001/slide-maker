import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationJob, PresentationProject, StylePreset } from "@slide-maker/core";
import { createApp } from "../src/app.js";

describe("MVP end-to-end local workflow", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let unavailable = false;

  beforeAll(async () => {
    const app = await createApp(await mkdtemp(join(tmpdir(), "slide-maker-mvp-")));
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
      baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    } catch (error) {
      if (["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
        unavailable = true;
      else throw error;
    }
  });
  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body;
  }

  it("manages brief, sources, styles, slides, batch generation, exports and project import", async (context) => {
    if (unavailable) return context.skip();
    let project = await json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "本機 AI 簡報",
        brief: { desiredSlideCount: 4, audience: "工程團隊" },
      }),
    });
    expect(project.workflowStage).toBe("requirements");
    project = await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace: true }),
    });
    expect(project.workflowStage).toBe("settings");
    expect(project.slides).toHaveLength(project.brief.desiredSlideCount);
    const confirmedSlideCount = project.slides.length;

    project = await json<PresentationProject>(
      `/api/projects/${project.id}/sources?name=${encodeURIComponent("資料.md")}&mediaType=text%2Fmarkdown&usage=content&allowModelAccess=true`,
      {
        method: "POST",
        headers: { "content-type": "text/markdown" },
        body: "# 關鍵資料\nSlide Maker 支援可恢復的本機工作流程。",
      },
    );
    expect(project.sources[0]).toMatchObject({ status: "indexed", usage: "content" });
    const sourceId = project.sources[0]!.id;
    const found = await json<Array<{ sourceId: string }>>(
      `/api/projects/${project.id}/search?q=${encodeURIComponent("可恢復")}`,
    );
    expect(found[0]?.sourceId).toBe(sourceId);

    project = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${project.slides[0]!.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceIds: [sourceId] }),
      },
    );
    const style = await json<StylePreset>("/api/styles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "QA Light", colors: ["#ffffff", "#111111", "#3355ff"] }),
    });
    project = await json<PresentationProject>(`/api/projects/${project.id}/style`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ styleId: style.id }),
    });
    expect(project.styleSnapshot.id).toBe(style.id);

    project = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${project.slides[0]!.id}/duplicate`,
      { method: "POST" },
    );
    expect(project.slides).toHaveLength(confirmedSlideCount + 1);
    const reordered = [...project.slides].reverse().map((slide) => slide.id);
    project = await json<PresentationProject>(`/api/projects/${project.id}/slides/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slideIds: reordered }),
    });
    expect(project.slides.map((slide) => slide.id)).toEqual(reordered);
    project = await json<PresentationProject>(
      `/api/projects/${project.id}/slides/${project.slides[0]!.id}`,
      { method: "DELETE" },
    );
    expect(project.slides).toHaveLength(confirmedSlideCount);

    const jobs = await json<GenerationJob[]>(`/api/projects/${project.id}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "mock-image" }),
    });
    expect(jobs).toHaveLength(confirmedSlideCount);
    const deadline = Date.now() + 4_000;
    do {
      project = await json<PresentationProject>(`/api/projects/${project.id}`);
      if (
        project.jobs
          .filter((job) => jobs.some((queued) => queued.id === job.id))
          .every((job) => job.status === "completed")
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    expect(project.slides.every((slide) => !!slide.currentVersionId)).toBe(true);
    expect(project.workflowStage).toBe("editing");

    const editedSlide = project.slides[0]!;
    const versionCount = editedSlide.versions.length;
    const editJob = await json<GenerationJob>(
      `/api/projects/${project.id}/slides/${editedSlide.id}/edit-image`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "mock-image",
          instruction: "把右上角重點色改為藍色，其餘維持不變",
        }),
      },
    );
    const editDeadline = Date.now() + 4_000;
    do {
      project = await json<PresentationProject>(`/api/projects/${project.id}`);
      if (project.jobs.find((job) => job.id === editJob.id)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < editDeadline);
    expect(project.jobs.find((job) => job.id === editJob.id)).toMatchObject({
      status: "completed",
      operation: "edit",
    });
    expect(project.slides[0]!.versions).toHaveLength(versionCount + 1);
    expect(project.slides[0]!.versions.at(-1)?.label).toMatch(/^Edited:/);

    for (const [format, signature] of [
      ["pdf", "%PDF"],
      ["pptx", "PK"],
      ["png.zip", "PK"],
      ["slide-project", "PK"],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/export/${format}`);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(Buffer.from(bytes.subarray(0, signature.length)).toString()).toBe(signature);
      if (format === "png.zip")
        expect(Object.keys(unzipSync(bytes))).toEqual(
          Array.from(
            { length: confirmedSlideCount },
            (_, index) => `${String(index + 1).padStart(3, "0")}.png`,
          ),
        );
    }
    const bundle = await fetch(`${baseUrl}/api/projects/${project.id}/export/slide-project`).then(
      (response) => response.arrayBuffer(),
    );
    const imported = await json<PresentationProject>("/api/projects/import", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: bundle,
    });
    expect(imported.id).not.toBe(project.id);
    expect(imported.slides).toHaveLength(confirmedSlideCount);
    expect(imported.jobs).toHaveLength(0);
  }, 60_000);
});

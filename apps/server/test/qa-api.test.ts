import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

describe("QA local API vertical flow", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let bindUnavailable = false;

  beforeAll(async () => {
    const root = join(await mkdtemp(join(tmpdir(), "slide-maker-qa-api-")), ".slide-maker-data");
    const app = await createApp(root, undefined, {
      webSearch: async (query, limit) => [{ url: "https://example.com/guide", title: `${query} Guide`, summary: "Search result summary" }].slice(0, limit),
      captureWebPage: async (found, capturedAt = new Date().toISOString()) => ({
        text: `# ${found.title}\n\nURL: ${found.url}\n\n## 簡介\n\n${found.summary}\n\n## 全文\n\nComplete captured article.`,
        metadata: { url: found.url, title: found.title, summary: found.summary, capturedAt, contentStatus: "full" },
      }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve());
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
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  });

  async function json<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = await response.json() as T;
    return { response, body };
  }

  it("creates, edits, generates, serves, and immutably restores one slide", async (context) => {
    if (bindUnavailable) return context.skip();
    const created = await json<PresentationProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "QA API flow" }),
    });
    expect(created.response.status).toBe(201);
    const projectId = created.body.id;
    const slideId = created.body.slides[0]!.id;

    const patched = await json<PresentationProject>(`/api/projects/${projectId}/slides/${slideId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "QA edited content" }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.slides[0]?.content).toBe("QA edited content");

    const queued = await json<{ id: string }>(`/api/projects/${projectId}/slides/${slideId}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "mock-image" }),
    });
    expect(queued.response.status).toBe(202);

    let completed: PresentationProject | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const loaded = await json<PresentationProject>(`/api/projects/${projectId}`);
      if (loaded.body.jobs.find((job) => job.id === queued.body.id)?.status === "completed") {
        completed = loaded.body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed).toBeDefined();
    const version = completed!.slides[0]!.versions[0]!;
    expect(version.outlineSnapshot?.content).toBe("QA edited content");
    expect(completed!.slides[0]!.outlineDirty).toBe(false);

    const imagePath = version.imagePath.replace(/^assets\//, "").split("/").map(encodeURIComponent).join("/");
    const asset = await fetch(`${baseUrl}/api/projects/${projectId}/assets/${imagePath}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("image/svg+xml");
    expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(100);

    const restored = await json<PresentationProject>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${version.id}/restore`,
      { method: "POST" },
    );
    expect(restored.body.slides[0]?.versions).toHaveLength(2);
    expect(restored.body.slides[0]?.currentVersionId).not.toBe(version.id);
    expect(restored.body.slides[0]?.versions[1]?.label).toBe(`Restored from ${version.id}`);

    const draftChanged = await json<PresentationProject>(`/api/projects/${projectId}/slides/${slideId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Unsaved next-image draft" }),
    });
    expect(draftChanged.body.slides[0]?.outlineDirty).toBe(true);

    const activated = await json<PresentationProject>(
      `/api/projects/${projectId}/slides/${slideId}/versions/${version.id}/activate`,
      { method: "POST" },
    );
    expect(activated.body.slides[0]?.versions).toHaveLength(2);
    expect(activated.body.slides[0]?.currentVersionId).toBe(version.id);
    expect(activated.body.slides[0]?.content).toBe("QA edited content");
    expect(activated.body.slides[0]?.outlineDirty).toBe(false);
  });

  it("rejects a non-local browser origin", async (context) => {
    if (bindUnavailable) return context.skip();
    const response = await fetch(`${baseUrl}/api/health`, { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "LOCAL_ORIGIN_REQUIRED" });
  });

  it("keeps search results temporary until confirmed, then stores captured full text", async (context) => {
    if (bindUnavailable) return context.skip();
    const created = await json<PresentationProject>("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "Web source flow" }),
    });
    const projectId = created.body.id;
    const searched = await json<Array<{ url: string; title: string; summary: string }>>(`/api/projects/${projectId}/web-search`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "Agent building", limit: 8 }),
    });
    expect(searched.response.status).toBe(200);
    expect(searched.body).toHaveLength(1);
    expect((await json<PresentationProject>(`/api/projects/${projectId}`)).body.sources).toHaveLength(0);

    const saved = await json<PresentationProject>(`/api/projects/${projectId}/web-sources`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sources: searched.body }),
    });
    expect(saved.response.status).toBe(201);
    expect(saved.body.sources).toHaveLength(1);
    expect(saved.body.sources[0]?.metadata.contentStatus).toBe("full");
    expect(saved.body.sources[0]?.extractedText).toContain("Complete captured article.");
    expect(saved.body.sources[0]?.chunks.length).toBeGreaterThan(0);

    const slide = saved.body.slides[0]!;
    const regenerated = await json<PresentationProject>(`/api/projects/${projectId}/slides/${slide.id}/outline`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(regenerated.response.status).toBe(200);
    expect(regenerated.body.slides[0]?.purpose).toBe(slide.purpose);
    expect(regenerated.body.slides[0]?.content).toContain("補充來源證據與具體細節");
    expect(regenerated.body.slides[0]?.sourceIds).toContain(saved.body.sources[0]?.id);
    expect(regenerated.body.slides[0]?.outlineDirty).toBe(true);
  });

  it("serves the editor shell from the root route", async (context) => {
    if (bindUnavailable) return context.skip();
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('<div id="root"></div>');
  });
});

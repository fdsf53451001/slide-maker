import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../apps/server/dist/app.js";

if (process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX !== "1" || !process.env.CODEX_HOME || !process.env.SLIDE_MAKER_DATA_ROOT) {
  throw new Error("Set SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1, CODEX_HOME and SLIDE_MAKER_DATA_ROOT");
}
const referencePath = resolve(process.env.SLIDE_MAKER_REFERENCE_IMAGE ?? "artifacts/grok-build-e2e-final-20260715/slide-01.png");
const app = await createApp(process.env.SLIDE_MAKER_DATA_ROOT);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); if (!address || typeof address === "string") throw new Error("server bind failed");
const base = `http://127.0.0.1:${address.port}`;
const request = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, init);
  if (!response.ok) throw new Error(`${response.status} ${path}: ${(await response.text()).slice(0, 500)}`);
  return response;
};

try {
  const referenceBytes = await readFile(referencePath);
  const reference = await (await request(`/api/style-assets?${new URLSearchParams({ name: "Grok Build visual language.png", mediaType: "image/png" })}`, {
    method: "POST", headers: { "content-type": "image/png" }, body: referenceBytes,
  })).json();
  const style = await (await request("/api/styles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    name: "Live reference E2E", description: "Actual Codex localImage reference test", density: "high",
    imageDirection: "Use the attached image only for visual language, spacing, contrast and glow treatment.",
    promptTemplate: "Create a polished 16:9 presentation slide.", avoid: ["copying source text", "logos", "watermarks"],
    referenceImages: [reference], coverImageId: reference.id,
  }) })).json();
  let project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    topic: "風格參考圖實測", styleId: style.id, brief: { desiredSlideCount: 1, webSearchMode: "disabled" },
  }) })).json();
  project = await (await request(`/api/projects/${project.id}/slides/${project.slides[0].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
    purpose: "驗證風格參考圖", content: "Style reference pipeline verified", narrative: "以不同主題驗證視覺語言參考，不複製原圖文字。",
    layoutHint: "單一中央驗證節點與明確層級", imagePrompt: "Create a new verification slide using the attached STYLE reference visual language only. Do not copy its subject or text.", sourceIds: [],
  }) })).json();
  const job = await (await request(`/api/projects/${project.id}/slides/${project.slides[0].id}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "codex-image-spike" }) })).json();
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    project = await (await request(`/api/projects/${project.id}`)).json();
    const current = project.jobs.find((item) => item.id === job.id);
    if (current?.status === "completed") break;
    if (current && ["failed", "cancelled"].includes(current.status)) throw new Error(`reference job ${current.errorCode ?? current.status}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  const slide = project.slides[0]; const version = slide.versions.find((item) => item.id === slide.currentVersionId);
  if (!version || version.styleVersion !== style.version) throw new Error("style version was not recorded");
  const asset = new Uint8Array(await (await request(`/api/projects/${project.id}/assets/${version.imagePath.replace(/^assets\//, "")}`)).arrayBuffer());
  if (asset[0] !== 0x89 || asset[1] !== 0x50) throw new Error("reference output is not PNG");
  const workspaces = await readdir(resolve(process.env.SLIDE_MAKER_DATA_ROOT, "codex-jobs"));
  const referenceCopies = (await Promise.all(workspaces.map(async (name) => {
    try { return (await readdir(resolve(process.env.SLIDE_MAKER_DATA_ROOT, "codex-jobs", name, "references"))).length; } catch { return 0; }
  }))).reduce((sum, count) => sum + count, 0);
  if (referenceCopies < 1) throw new Error("no trusted reference copy reached the Codex workspace");
  console.log(JSON.stringify({ ok: true, projectId: project.id, styleId: style.id, referenceId: reference.id, referenceCopies, outputBytes: asset.length }, null, 2));
} finally { await new Promise((resolvePromise) => server.close(resolvePromise)); }

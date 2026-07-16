import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GenerationJob, PresentationProject } from "@slide-maker/core";
import { createApp } from "../src/app.js";

type ProviderSummary = {
  id: string;
  availability: { status: "available"; warning?: string } | { status: "unavailable"; reason: string };
};

async function fakeCodex(bin: string, mode: "success" | "secret-failure" | "delayed"): Promise<void> {
  const path = join(bin, "codex");
  await writeFile(path, `#!/usr/bin/env node
import { createReadStream, writeSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const out = (value) => writeSync(1, value);
if (args.length === 1 && args[0] === "--version") { out("codex-cli 0.144.4\\n"); process.exit(0); }
if (args[0] === "app-server" && args[1] === "--help") { out("--stdio generate-json-schema\\n"); process.exit(0); }
if (args[0] === "login" && args[1] === "--help") { out("  status  Show login status\\n"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { out("Logged in using ChatGPT\\n"); process.exit(0); }
if (args[0] !== "app-server" || args[1] !== "--stdio") process.exit(90);
const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const name = Buffer.from(type, "ascii"); const header = Buffer.alloc(4); header.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([header, name, data, crc]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1920, 0); ihdr.writeUInt32BE(1080, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([1])), chunk("IEND", Buffer.alloc(0))]);
const send = (message) => out(JSON.stringify(message) + "\\n");
const turn = (status) => ({ id: "turn-1", items: [], status });
const image = { type: "imageGeneration", id: "image-1", status: "completed", revisedPrompt: null, result: png.toString("base64") };
process.on("SIGTERM", () => process.exit(0));
createInterface({ input: createReadStream("", { fd: 0 }) }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { codexHome: process.env.CODEX_HOME ?? (process.env.HOME + "/.codex"), platformFamily: "unix", platformOs: "linux", userAgent: "codex-cli/0.144.4 (QA)" } });
  } else if (message.method === "thread/start") {
    const now = Math.floor(Date.now() / 1000);
    send({ id: message.id, result: {
      approvalPolicy: "never", approvalsReviewer: "user", cwd: process.cwd(), model: "qa-image", modelProvider: "openai",
      sandbox: { type: "readOnly", networkAccess: false }, instructionSources: [], runtimeWorkspaceRoots: [process.cwd()],
      thread: { id: "thread-1", cliVersion: "0.144.4", createdAt: now, cwd: process.cwd(), ephemeral: true, modelProvider: "openai", path: null, preview: "", sessionId: "session-1", source: "appServer", status: { type: "idle" }, turns: [], updatedAt: now },
    } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: turn("inProgress") } });
    if (mode === "secret-failure") {
      writeSync(2, "Bearer qa-server-codex-secret");
      process.exit(9);
    }
    const finish = () => {
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: image } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { ...turn("completed"), items: [image] } } });
    };
    if (mode === "delayed") setTimeout(finish, 500); else finish();
  }
});
`, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function listen(app: Awaited<ReturnType<typeof createApp>>): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve(candidate));
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function json<T>(baseUrl: string, path: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as T };
}

async function createProject(baseUrl: string): Promise<PresentationProject> {
  const result = await json<PresentationProject>(baseUrl, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: "QA fake Codex server flow" }),
  });
  expect(result.response.status).toBe(201);
  return result.body;
}

async function generate(baseUrl: string, project: PresentationProject): Promise<{ response: Response; body: GenerationJob | { error: string } }> {
  return json(baseUrl, `/api/projects/${project.id}/slides/${project.slides[0]!.id}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "codex-image-spike" }),
  });
}

async function terminalProject(baseUrl: string, projectId: string, jobId: string): Promise<PresentationProject> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const loaded = await json<PresentationProject>(baseUrl, `/api/projects/${projectId}`);
    if (loaded.body.jobs.some((job) => job.id === jobId && ["completed", "failed", "cancelled"].includes(job.status))) return loaded.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex job ${jobId} did not settle`);
}

describe("QA server Codex soft-isolation flow", () => {
  it("gates opt-in, exposes the UI warning contract, completes fake generation, and redacts failure details", async (context) => {
    const previousEnable = process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX;
    const previousPath = process.env.PATH;
    const servers: Server[] = [];
    try {
      delete process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX;
      let off;
      try {
        off = await listen(await createApp(await mkdtemp(join(tmpdir(), "slide-maker-codex-off-"))));
      } catch (error) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
        throw error;
      }
      servers.push(off.server);
      const offProviders = await json<ProviderSummary[]>(off.baseUrl, "/api/providers");
      expect(offProviders.body.find((provider) => provider.id === "codex-image-spike")?.availability).toMatchObject({ status: "unavailable" });
      const offProject = await createProject(off.baseUrl);
      const rejected = await generate(off.baseUrl, offProject);
      expect(rejected.response.status).toBe(409);
      expect(rejected.body).toMatchObject({ error: "PROVIDER_PREFLIGHT_BLOCKED", readiness: { status: "disabled" } });
      await close(off.server);

      const bin = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-bin-"));
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX = "1";
      await fakeCodex(bin, "success");
      const on = await listen(await createApp(await mkdtemp(join(tmpdir(), "slide-maker-codex-on-"))));
      servers.push(on.server);
      const onProviders = await json<ProviderSummary[]>(on.baseUrl, "/api/providers");
      const enabled = onProviders.body.find((provider) => provider.id === "codex-image-spike")?.availability;
      expect(enabled).toMatchObject({ status: "available", warning: expect.stringMatching(/軟隔離|資料外洩|額度/) });
      const onProject = await createProject(on.baseUrl);
      const queued = await generate(on.baseUrl, onProject);
      expect(queued.response.status).toBe(202);
      const completed = await terminalProject(on.baseUrl, onProject.id, (queued.body as GenerationJob).id);
      const completedJob = completed.jobs.at(-1);
      expect(completedJob?.status, completedJob?.error).toBe("completed");
      expect(completed.slides[0]?.versions.at(-1)).toMatchObject({ providerId: "codex-image-spike", model: "codex-imagegen" });
      await close(on.server);

      await fakeCodex(bin, "secret-failure");
      const failedApp = await listen(await createApp(await mkdtemp(join(tmpdir(), "slide-maker-codex-failed-"))));
      servers.push(failedApp.server);
      const failedProject = await createProject(failedApp.baseUrl);
      const failedQueued = await generate(failedApp.baseUrl, failedProject);
      const failed = await terminalProject(failedApp.baseUrl, failedProject.id, (failedQueued.body as GenerationJob).id);
      expect(failed.jobs.at(-1)).toMatchObject({
        status: "failed",
        errorCode: "CODEX_PROCESS_FAILED",
        error: "Codex 執行失敗，請檢查 CLI 狀態後重試。",
      });
      expect(JSON.stringify(failed)).not.toContain("qa-server-codex-secret");
    } finally {
      await Promise.all(servers.map(close));
      if (previousEnable === undefined) delete process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX;
      else process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX = previousEnable;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("exposes delayed JSONL waiting state and elapsed/remaining inputs through the API, then cancels", async (context) => {
    const previousEnable = process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX;
    const previousPath = process.env.PATH;
    let server: Server | undefined;
    try {
      const bin = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-delayed-bin-"));
      await fakeCodex(bin, "delayed");
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX = "1";
      let running;
      try {
        running = await listen(await createApp(await mkdtemp(join(tmpdir(), "slide-maker-codex-delayed-"))));
      } catch (error) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
        throw error;
      }
      server = running.server;
      const project = await createProject(running.baseUrl);
      const queued = await generate(running.baseUrl, project);
      expect(queued.response.status).toBe(202);
      const jobId = (queued.body as GenerationJob).id;
      const deadline = Date.now() + 2_000;
      let waiting: GenerationJob | undefined;
      while (Date.now() < deadline) {
        const loaded = await json<PresentationProject>(running.baseUrl, `/api/projects/${project.id}`);
        waiting = loaded.body.jobs.find((job) => job.id === jobId && job.phase === "waiting_for_codex" && job.providerEventCode === "turn_started");
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toMatchObject({
        status: "running",
        phase: "waiting_for_codex",
        providerEventCode: "turn_started",
        progress: { step: 4, total: 6 },
        timeoutMs: 600_000,
      });
      const started = Date.parse(waiting!.startedAt!);
      const elapsed1 = Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const reloaded = await json<PresentationProject>(running.baseUrl, `/api/projects/${project.id}`);
      const apiJob = reloaded.body.jobs.find((job) => job.id === jobId)!;
      const elapsed2 = Date.now() - Date.parse(apiJob.startedAt!);
      expect(elapsed2).toBeGreaterThan(elapsed1);
      expect(apiJob.timeoutMs! - elapsed2).toBeGreaterThan(0);

      const cancelled = await json<GenerationJob>(running.baseUrl, `/api/projects/${project.id}/jobs/${jobId}/cancel`, { method: "POST" });
      expect(cancelled.response.status).toBe(200);
      expect(cancelled.body).toMatchObject({ status: "cancelled", phase: "cancelled", errorCode: "CANCELLED", attempt: 1 });
      const terminal = await terminalProject(running.baseUrl, project.id, jobId);
      expect(terminal.jobs.find((job) => job.id === jobId)?.status).toBe("cancelled");
    } finally {
      if (server) await close(server);
      if (previousEnable === undefined) delete process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX;
      else process.env.SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX = previousEnable;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

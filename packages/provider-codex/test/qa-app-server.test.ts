import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, type ImageGenerationRequest } from "@slide-maker/core";
import { runAppServerArtifact } from "../src/app-server.js";
import { CodexImageSpikeProvider } from "../src/index.js";

type Mode = "inline" | "saved" | "rpc-error" | "malformed" | "oversize-line" | "oversize-base64"
  | "bad-status" | "bad-magic" | "duplicate" | "reorder" | "wrong-id" | "no-image" | "exit" | "long"
  | "spoof-image-line" | "too-many-lines" | "unsolicited" | "wrong-init-version" | "unsafe-thread"
  | "failed-turn" | "response-order" | "delayed-close" | "incomplete-init" | "incomplete-thread"
  | "incomplete-turn" | "unsafe-policy" | "unsafe-cwd" | "omitted-instruction-sources" | "global-instruction-source"
  | "foreign-instruction-source" | "long-ignore-term" | "web-search"
  | "read-command" | "code-mode-exec" | "other-dynamic-tool" | "scaled-image";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width = 1920, height = 1080): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([1])), chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function fakeServer(mode: Mode, inline: string, savedPath?: string) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-app-server-"));
  const executable = join(root, "codex");
  const audit = join(root, "requests.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, createReadStream, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
const mode = ${JSON.stringify(mode)};
const inline = ${JSON.stringify(inline)};
const savedPath = ${JSON.stringify(savedPath)};
const audit = ${JSON.stringify(audit)};
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && cliArgs[0] === "--version") { writeSync(1, "codex-cli 0.144.4\\n"); process.exit(0); }
if (cliArgs[0] === "app-server" && cliArgs[1] === "--help") { writeSync(1, "--stdio generate-json-schema\\n"); process.exit(0); }
if (cliArgs[0] === "login" && cliArgs[1] === "--help") { writeSync(1, "  status  Show login status\\n"); process.exit(0); }
if (cliArgs[0] === "login" && cliArgs[1] === "status") { writeSync(1, "Logged in using ChatGPT\\n"); process.exit(0); }
const send = (message) => writeSync(1, JSON.stringify(message) + "\\n");
const image = (status = "completed") => ({ type: "imageGeneration", id: "img-1", status, revisedPrompt: "REVISED-PROMPT-CANARY", ...(mode === "saved" ? { result: "", savedPath } : { result: mode === "bad-magic" ? Buffer.from("not a png").toString("base64") : inline }) });
const now = Math.floor(Date.now() / 1000);
const thread = (path = null, cwd = process.cwd()) => ({ id: "thread-1", cliVersion: "0.144.4", createdAt: now, cwd, ephemeral: true, modelProvider: "openai", path, preview: "", sessionId: "session-1", source: "appServer", status: { type: "idle" }, turns: [], updatedAt: now });
const turn = (status = "inProgress") => ({ id: "turn-1", items: [], status });
process.on("SIGTERM", () => {
  if (mode === "long-ignore-term") return;
  if (mode === "delayed-close") setTimeout(() => process.exit(0), 180);
  else process.exit(0);
});
const input = createInterface({ input: createReadStream(null, { fd: 0 }) });
input.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(audit, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    if (mode === "rpc-error") send({ id: message.id, error: { code: -32000, message: "RAW-STDERR-CANARY" } });
    else if (mode === "response-order") send({ id: 2, result: { thread: { id: "thread-1", ephemeral: true, path: null, cliVersion: "0.144.4" }, instructionSources: [] } });
    else send({ id: message.id, result: mode === "incomplete-init"
      ? { userAgent: "codex-cli/0.144.4 (fake QA server)" }
      : { codexHome: process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"), platformFamily: "unix", platformOs: "linux", userAgent: mode === "wrong-init-version" ? "codex-cli/0.145.0" : "codex-cli/0.144.4 (fake QA server)" } });
  } else if (message.method === "thread/start") {
    const responseCwd = mode === "unsafe-cwd" ? "/tmp" : process.cwd();
    const safeThread = thread(mode === "unsafe-thread" ? "/tmp/persisted-thread" : null, responseCwd);
    const instructionSources = mode === "global-instruction-source"
      ? [join(process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"), "AGENTS.md")]
      : mode === "foreign-instruction-source" ? [join(process.cwd(), "AGENTS.md")] : [];
    send({ id: message.id, result: mode === "incomplete-thread"
      ? { thread: safeThread, instructionSources: [] }
      : { approvalPolicy: mode === "unsafe-policy" ? "on-request" : "never", approvalsReviewer: "user", cwd: responseCwd, model: "qa-image", modelProvider: "openai", sandbox: mode === "unsafe-policy" ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false }, thread: safeThread, ...(mode === "omitted-instruction-sources" ? {} : { instructionSources }), runtimeWorkspaceRoots: [process.cwd()] } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: mode === "incomplete-turn" ? { id: "turn-1" } : turn() } });
    if (mode === "malformed") writeSync(1, "{bad-json\\n");
    else if (mode === "oversize-line") writeSync(1, JSON.stringify({ method: "noise", params: { value: "A".repeat(70 * 1024) } }) + "\\n");
    else if (mode === "spoof-image-line") writeSync(1, JSON.stringify({ method: "noise", params: { decoy: { type: "imageGeneration" }, value: "A".repeat(70 * 1024) } }) + "\\n");
    else if (mode === "too-many-lines") for (let index = 0; index < 1001; index += 1) send({ method: "noise", params: { index } });
    else if (mode === "unsolicited") send({ id: 99, method: "approval/request", params: { prompt: "TOKEN-CANARY" } });
    else if (mode === "web-search") {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: turn() } });
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "webSearch", id: "web-1", query: "must remain forbidden in image provider" } } });
    }
    else if (mode === "oversize-base64") {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "imageGeneration", id: "img-big", status: "completed", revisedPrompt: null, result: Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64") } } });
    }
    else if (mode === "exit") process.exit(7);
    else if (mode !== "long" && mode !== "long-ignore-term") {
      const started = { method: "turn/started", params: { threadId: "thread-1", turn: turn() } };
      const item = { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: image(mode === "bad-status" ? "inProgress" : "completed") } };
      if (mode === "reorder") { send(item); send(started); }
      else {
        send(mode === "wrong-id" ? { ...started, params: { ...started.params, threadId: "wrong" } } : started);
        if (mode === "read-command") {
          const command = { type: "commandExecution", id: "command-1", command: "sed -n 1,260p input.json", commandActions: [], cwd: process.cwd(), status: "completed", aggregatedOutput: "{}", durationMs: 1, exitCode: 0, processId: null, source: "agent" };
          send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { ...command, status: "inProgress" } } });
          send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: command } });
        }
        if (mode === "code-mode-exec" || mode === "other-dynamic-tool") {
          const dynamic = { type: "dynamicToolCall", id: "dynamic-1", tool: mode === "code-mode-exec" ? "exec" : "arbitrary", arguments: {}, namespace: null, status: "completed", contentItems: null, durationMs: 1, success: true };
          send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { ...dynamic, status: "inProgress", durationMs: null, success: null } } });
          send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: dynamic } });
        }
        if (mode !== "no-image" && mode !== "wrong-id") send(item);
      }
      if (mode === "duplicate") send(item);
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { ...turn(mode === "failed-turn" ? "failed" : "completed"), items: [image()] } } });
    }
  }
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable, audit };
}

async function fixture(mode: Mode, setupSaved?: "inside" | "outside" | "symlink") {
  const workspace = await mkdtemp(join(tmpdir(), "slide-maker-qa-app-workspace-"));
  const home = await mkdtemp(join(tmpdir(), "slide-maker-qa-app-home-"));
  const generated = join(home, "generated_images");
  await mkdir(generated);
  let savedPath: string | undefined;
  if (setupSaved === "inside") {
    savedPath = join(generated, "slide.png"); await writeFile(savedPath, png());
  } else if (setupSaved === "outside") {
    savedPath = join(home, "outside.png"); await writeFile(savedPath, png());
  } else if (setupSaved === "symlink") {
    const outside = join(home, "outside.png"); await writeFile(outside, png());
    savedPath = join(generated, "slide.png"); await symlink(outside, savedPath);
  }
  const inline = mode === "scaled-image" ? png(1672, 941).toString("base64") : png().toString("base64");
  const fake = await fakeServer(mode, inline, savedPath);
  const controller = new AbortController();
  const run = () => runAppServerArtifact({
    executable: fake.executable,
    workspace,
    prompt: "PROMPT-CANARY",
    timeoutMs: 6_000,
    expectedVersion: "0.144.4",
    signal: controller.signal,
    environment: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH },
  });
  return { ...fake, workspace, home, controller, run };
}

async function requests(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function generationRequest(): ImageGenerationRequest {
  const project = createProject({ topic: "Provider app-server final validation" });
  return {
    projectId: project.id,
    slide: project.slides[0]!,
    style: project.styleSnapshot,
    width: 1920,
    height: 1080,
    references: [],
    model: "qa-app-server",
    parameters: {},
  };
}

describe("QA version-pinned app-server artifact protocol", () => {
  it.each([
    ["inline", undefined],
    ["saved", "inside"],
    ["omitted-instruction-sources", undefined],
    ["global-instruction-source", undefined],
    ["read-command", undefined],
    ["code-mode-exec", undefined],
  ] as const)("accepts one correlated %s ImageGeneration result", async (mode, saved) => {
    const fake = await fixture(mode, saved);
    const result = await fake.run();
    expect(Buffer.from(result.bytes)).toEqual(png());
    expect(result.eventCount).toBe(["read-command", "code-mode-exec"].includes(mode) ? 4 : 3);
    const inbound = await requests(fake.audit);
    expect(inbound.map((message) => [message.method, message.id])).toEqual([
      ["initialize", 1], ["initialized", undefined], ["thread/start", 2], ["turn/start", 3],
    ]);
    expect(inbound[0]).toEqual({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "slide-maker", title: "Slide Maker", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: [],
        },
      },
    });
    expect(inbound[2]).toMatchObject({
      method: "thread/start",
      params: { approvalPolicy: "never", sandbox: "read-only", ephemeral: true, environments: [], dynamicTools: [] },
    });
    expect(inbound[3]).toMatchObject({
      method: "turn/start",
      params: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false }, environments: [] },
    });
    expect(JSON.stringify(result)).not.toMatch(/base64|REVISED-PROMPT-CANARY|PROMPT-CANARY|savedPath/i);
  });

  it.each([
    ["rpc-error", /RPC_ERROR/],
    ["malformed", /MALFORMED_JSONL/],
    ["oversize-line", /EVENT_TOO_LARGE/],
    ["oversize-base64", /IMAGE_RESULT_INVALID|EVENT_TOO_LARGE/],
    ["bad-status", /IMAGE_SCHEMA_INVALID/],
    ["duplicate", /DUPLICATE_IMAGE/],
    ["reorder", /EVENT_(?:ORDER|CORRELATION)_FAILED/],
    ["wrong-id", /EVENT_CORRELATION_FAILED/],
    ["no-image", /NO_IMAGE/],
    ["exit", /PROCESS_FAILED/],
    ["spoof-image-line", /EVENT_TOO_LARGE/],
    ["too-many-lines", /EVENT_LIMIT/],
    ["unsolicited", /UNSOLICITED_REQUEST/],
    ["wrong-init-version", /INITIALIZE_FAILED/],
    ["unsafe-thread", /THREAD_UNSAFE/],
    ["foreign-instruction-source", /THREAD_UNSAFE_INSTRUCTIONS/],
    ["failed-turn", /EVENT_CORRELATION_FAILED/],
    ["response-order", /THREAD_START_FAILED/],
    ["incomplete-init", /INITIALIZE_FAILED/],
    ["incomplete-thread", /THREAD_START_FAILED|THREAD_UNSAFE/],
    ["incomplete-turn", /TURN_START_FAILED/],
    ["unsafe-policy", /THREAD_UNSAFE/],
    ["unsafe-cwd", /THREAD_UNSAFE/],
    ["web-search", /FORBIDDEN_WEB_SEARCH/],
    ["other-dynamic-tool", /FORBIDDEN_DYNAMIC_TOOL/],
  ] as const)("rejects fake protocol mode %s", { timeout: 12_000 }, async (mode, expected) => {
    await expect((await fixture(mode)).run()).rejects.toThrow(expected);
  });

  it.each(["outside", "symlink"] as const)("rejects a %s savedPath", async (saved) => {
    await expect((await fixture("saved", saved)).run()).rejects.toThrow(/SAVED_PATH_INVALID/);
  });

  it("sends one correlated turn/interrupt before terminating an aborted process", async () => {
    const fake = await fixture("long");
    const generation = fake.run();
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try {
        const inbound = await requests(fake.audit);
        if (inbound.some((message) => message.method === "turn/start")) break;
      } catch { /* audit is created after the first request */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fake.controller.abort();
    await expect(generation).rejects.toThrow(/ABORTED/);
    const inbound = await requests(fake.audit);
    expect(inbound.filter((message) => message.method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", id: 4, params: { threadId: "thread-1", turnId: "turn-1" } },
    ]);
  });

  it("does not resolve a successful result until the app-server process closes", async () => {
    const fake = await fixture("delayed-close");
    const startedAt = Date.now();
    await fake.run();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  it("force-kills an aborted app-server that ignores SIGTERM, then rejects only after close", async () => {
    const fake = await fixture("long-ignore-term");
    const generation = fake.run();
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try {
        if ((await requests(fake.audit)).some((message) => message.method === "turn/start")) break;
      } catch { /* audit is created after the first request */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const abortedAt = Date.now();
    fake.controller.abort();
    await expect(generation).rejects.toThrow(/ABORTED/);
    const elapsed = Date.now() - abortedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_050);
    expect(elapsed).toBeLessThan(2_500);
  }, 5_000);

  it("runs the pinned provider transport and returns only validated final PNG metadata", async () => {
    const fake = await fixture("inline");
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      executable: fake.executable,
      workspaceRoot: join(fake.root, "jobs"),
    });
    const result = await provider.generate(generationRequest());
    expect(Buffer.from(result.bytes)).toEqual(png());
    expect(result.parameters).toEqual({ eventCount: 3, softSandbox: true, transport: "app-server-0.144.4" });
    expect(JSON.stringify(result.parameters)).not.toMatch(/base64|REVISED-PROMPT-CANARY|PROMPT-CANARY|savedPath/i);
    const turnRequest = (await requests(fake.audit)).find((message) => message.method === "turn/start");
    const serializedTurn = JSON.stringify(turnRequest);
    expect(serializedTurn).toContain("Information density requirement: HIGH");
    expect(serializedTurn).toContain("slide.content field is the authoritative visible copy");
    expect(serializedTurn).toContain("supporting imagery must not dominate");
    expect(serializedTurn).toContain("STYLE FIDELITY CONTRACT FOR NEW GENERATION");
    expect(serializedTurn).toContain("style overrides slide.imagePrompt and generic model defaults");
    expect(serializedTurn).toContain("Resolve every slot from slide.purpose");
    expect(serializedTurn).toContain("Every entry in style.avoid is a mandatory negative constraint");
    expect(serializedTurn).toContain("do not fall back to generic presentation aesthetics");
  });

  it("preserves the existing visual style during image edits instead of applying the new-generation style contract", async () => {
    const fake = await fixture("inline");
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      executable: fake.executable,
      workspaceRoot: join(fake.root, "jobs"),
    });
    await provider.generate({
      ...generationRequest(),
      edit: { instruction: "只調整框選區域", baseImageIndex: 0 },
    });
    const turnRequest = (await requests(fake.audit)).find((message) => message.method === "turn/start");
    const serializedTurn = JSON.stringify(turnRequest);
    expect(serializedTurn).not.toContain("STYLE FIDELITY CONTRACT FOR NEW GENERATION");
    expect(serializedTurn).toContain("preserve the current image's established visual style");
  });

  it("normalizes a valid 16:9-ish generated PNG to the project canvas", async () => {
    const fake = await fixture("scaled-image");
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      executable: fake.executable,
      workspaceRoot: join(fake.root, "jobs"),
    });
    const result = await provider.generate(generationRequest());
    const bytes = Buffer.from(result.bytes);
    expect(bytes.readUInt32BE(16)).toBe(1920);
    expect(bytes.readUInt32BE(20)).toBe(1080);
  });

  it("rejects an inline artifact with bad PNG magic during final provider validation", async () => {
    const fake = await fixture("bad-magic");
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      executable: fake.executable,
      workspaceRoot: join(fake.root, "jobs"),
    });
    await expect(provider.generate(generationRequest())).rejects.toThrow(/complete PNG/);
  });
});

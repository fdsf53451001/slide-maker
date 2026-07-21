import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const MAX_JSONL_LINE_BYTES = 24 * 1024 * 1024;
const MAX_STDOUT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ORDINARY_LINE_BYTES = 64 * 1024;
const MAX_ORDINARY_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_DECODED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_LINES = 1_000;

type ExitClass = "success" | "nonzero" | "timeout" | "aborted";
type ProtocolState = "initializing" | "thread_starting" | "turn_starting" | "running" | "completed";

export interface AppServerArtifactOptions {
  executable: string;
  workspace: string;
  prompt: string;
  localImagePaths?: readonly string[];
  width?: number;
  height?: number;
  timeoutMs: number;
  expectedVersion?: string;
  signal?: AbortSignal;
  environment: NodeJS.ProcessEnv;
  model?: string;
  reasoningEffort?: string;
  onSpawned?: () => void;
  onAllowedEvent?: (event: "turn_started" | "item_completed" | "turn_completed") => void;
  /** Emits only fixed internal protocol codes; intended for opt-in local diagnostics. */
  onProtocolFailure?: (code: string) => void;
  onExited?: (exitClass: ExitClass) => void;
}

export interface AppServerArtifactResult {
  bytes: Uint8Array;
  eventCount: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && ownKeys(value, required);
}

function samePath(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const normalizeDarwinAlias = (value: string) => {
    const resolved = resolve(value);
    if (process.platform !== "darwin") return resolved;
    if (resolved === "/var" || resolved.startsWith("/var/")) return `/private${resolved}`;
    if (resolved === "/tmp" || resolved.startsWith("/tmp/")) return `/private${resolved}`;
    return resolved;
  };
  return normalizeDarwinAlias(left) === normalizeDarwinAlias(right);
}

function readOnlyPolicy(value: unknown): boolean {
  return (
    object(value) &&
    exactKeys(value, ["type", "networkAccess"]) &&
    value.type === "readOnly" &&
    value.networkAccess === false
  );
}

function allowedCodeModeExec(value: Record<string, unknown>): boolean {
  // item/started is a partial projection in the pinned runtime even though the
  // generated completed-item schema marks arguments as required. Authenticate
  // the security-relevant identity fields and leave payload bounding to the
  // JSONL line/total limits above.
  return (
    value.type === "dynamicToolCall" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.tool === "exec" &&
    (value.namespace === undefined || value.namespace === null) &&
    ["inProgress", "completed", "failed"].includes(String(value.status))
  );
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function decodeInlinePng(result: string | null | undefined): Uint8Array | undefined {
  if (!result) return undefined;
  const base64 = result.startsWith("data:image/png;base64,")
    ? result.slice("data:image/png;base64,".length)
    : result;
  if (
    !base64 ||
    base64.length > MAX_JSONL_LINE_BYTES ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  ) {
    throw new Error("CODEX_APP_SERVER_IMAGE_RESULT_INVALID");
  }
  const bytes = Buffer.from(base64, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_DECODED_IMAGE_BYTES ||
    bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")
  ) {
    throw new Error("CODEX_APP_SERVER_IMAGE_RESULT_INVALID");
  }
  return new Uint8Array(bytes);
}

function generatedImagesRoot(environment: NodeJS.ProcessEnv): string {
  return join(codexHomeRoot(environment), "generated_images");
}

function codexHomeRoot(environment: NodeJS.ProcessEnv): string {
  return environment.CODEX_HOME
    ? resolve(environment.CODEX_HOME)
    : resolve(environment.HOME ?? homedir(), ".codex");
}

function allowedInstructionSources(value: unknown, environment: NodeJS.ProcessEnv): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  // Codex always loads the user's global AGENTS.md when present. The provider
  // already warns that CODEX_HOME instructions are part of this soft-isolated
  // execution. Accept that one exact source, but reject project/workspace docs
  // and every additional source.
  return value.length === 1 && samePath(value[0], join(codexHomeRoot(environment), "AGENTS.md"));
}

async function configFingerprint(environment: NodeJS.ProcessEnv): Promise<string> {
  const codexHome = environment.CODEX_HOME
    ? resolve(environment.CODEX_HOME)
    : resolve(environment.HOME ?? homedir(), ".codex");
  const path = join(codexHome, "config.toml");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error("CODEX_APP_SERVER_CONFIG_CANARY_FAILED");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 1024 * 1024)
    throw new Error("CODEX_APP_SERVER_CONFIG_CANARY_FAILED");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== metadata.size)
      throw new Error("CODEX_APP_SERVER_CONFIG_CANARY_FAILED");
    return createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
  } finally {
    await handle.close();
  }
}

async function readSavedArtifact(
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<Uint8Array> {
  if (!isAbsolute(path)) throw new Error("CODEX_APP_SERVER_SAVED_PATH_INVALID");
  const root = generatedImagesRoot(environment);
  const rootBefore = await lstat(root);
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory())
    throw new Error("CODEX_APP_SERVER_SAVED_PATH_INVALID");
  const canonicalRoot = await realpath(root);
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > MAX_DECODED_IMAGE_BYTES
  ) {
    throw new Error("CODEX_APP_SERVER_SAVED_PATH_INVALID");
  }
  const canonicalPath = await realpath(path);
  if (!inside(canonicalRoot, canonicalPath)) throw new Error("CODEX_APP_SERVER_SAVED_PATH_INVALID");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const rootAfter = await lstat(root);
    if (
      rootAfter.isSymbolicLink() ||
      !rootAfter.isDirectory() ||
      (await realpath(root)) !== canonicalRoot
    ) {
      throw new Error("CODEX_APP_SERVER_SAVED_PATH_INVALID");
    }
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== metadata.size)
      throw new Error("CODEX_APP_SERVER_SAVED_PATH_INVALID");
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function isImageBearingMessage(message: Record<string, unknown>): boolean {
  if (!object(message.params)) return false;
  if (message.method === "item/completed" && object(message.params.item)) {
    return message.params.item.type === "imageGeneration";
  }
  if (
    message.method === "turn/completed" &&
    object(message.params.turn) &&
    Array.isArray(message.params.turn.items)
  ) {
    return message.params.turn.items.some(
      (item) => object(item) && item.type === "imageGeneration",
    );
  }
  return false;
}

/** Version-pinned Codex app-server stdio client. It never exposes raw JSONL or stderr. */
function runAppServerArtifactProcess(
  options: AppServerArtifactOptions,
): Promise<AppServerArtifactResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const expectedVersion = options.expectedVersion ?? "0.144.4";
    const child = spawn(
      options.executable,
      [
        "app-server",
        ...(options.model ? ["-c", `model=${JSON.stringify(options.model)}`] : []),
        ...(options.reasoningEffort
          ? ["-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`]
          : []),
        "--stdio",
      ],
      {
        cwd: options.workspace,
        env: options.environment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let state: ProtocolState = "initializing";
    let threadId: string | undefined;
    let turnId: string | undefined;
    let turnStarted = false;
    let artifact: Uint8Array | undefined;
    let artifactId: string | undefined;
    let artifactHash: string | undefined;
    let eventCount = 0;
    let spawned = false;
    let closed = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let normalShutdown = false;
    let terminationStarted = false;
    let pendingError: Error | undefined;
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let ordinaryBytes = 0;
    let stderrBytes = 0;
    let lineCount = 0;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (message: Record<string, unknown>) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const terminate = () => {
      if (terminationStarted || closed) return;
      terminationStarted = true;
      if (threadId && turnId)
        send({ method: "turn/interrupt", id: 4, params: { threadId, turnId } });
      interruptTimer = setTimeout(() => terminateProcessTree(child, "SIGTERM"), 150);
      forceKill = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1_150);
    };
    const fail = (error: Error) => {
      if (settled || pendingError) return;
      pendingError = error;
      if (/^CODEX_APP_SERVER_[A-Z_]+$/.test(error.message))
        options.onProtocolFailure?.(error.message);
      terminate();
    };
    const rejectServerRequest = (message: Record<string, unknown>) => {
      send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
      fail(new Error("CODEX_APP_SERVER_UNSOLICITED_REQUEST"));
    };
    const acceptArtifact = async (item: Record<string, unknown>) => {
      if (
        !ownKeys(item, ["type", "id", "status", "revisedPrompt", "result", "savedPath"]) ||
        !["type", "id", "status", "revisedPrompt", "result"].every((key) =>
          Object.hasOwn(item, key),
        )
      ) {
        throw new Error("CODEX_APP_SERVER_IMAGE_SCHEMA_INVALID");
      }
      if (
        item.type !== "imageGeneration" ||
        typeof item.id !== "string" ||
        !item.id ||
        item.status !== "completed"
      ) {
        throw new Error("CODEX_APP_SERVER_IMAGE_SCHEMA_INVALID");
      }
      if (item.revisedPrompt !== null && typeof item.revisedPrompt !== "string") {
        throw new Error("CODEX_APP_SERVER_IMAGE_SCHEMA_INVALID");
      }
      if (typeof item.result !== "string") throw new Error("CODEX_APP_SERVER_IMAGE_SCHEMA_INVALID");
      if (item.savedPath !== undefined && typeof item.savedPath !== "string")
        throw new Error("CODEX_APP_SERVER_IMAGE_SCHEMA_INVALID");
      const inline = decodeInlinePng(typeof item.result === "string" ? item.result : undefined);
      const saved =
        typeof item.savedPath === "string"
          ? await readSavedArtifact(item.savedPath, options.environment)
          : undefined;
      if (!inline && !saved) throw new Error("CODEX_APP_SERVER_IMAGE_RESULT_INVALID");
      if (inline && saved && !Buffer.from(inline).equals(Buffer.from(saved)))
        throw new Error("CODEX_APP_SERVER_IMAGE_RESULT_MISMATCH");
      const bytes = inline ?? saved!;
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (artifact)
        throw new Error(
          artifactId === item.id && artifactHash === hash
            ? "CODEX_APP_SERVER_DUPLICATE_IMAGE"
            : "CODEX_APP_SERVER_MULTIPLE_IMAGES",
        );
      artifact = bytes;
      artifactId = item.id;
      artifactHash = hash;
    };
    const handleMessage = async (message: Record<string, unknown>) => {
      if (pendingError) return;
      if ("id" in message && "method" in message && typeof message.method === "string")
        return rejectServerRequest(message);
      if ("error" in message) throw new Error("CODEX_APP_SERVER_RPC_ERROR");
      if (message.id === 1) {
        const codexHome = generatedImagesRoot(options.environment).slice(
          0,
          -"generated_images".length - 1,
        );
        if (
          state !== "initializing" ||
          !object(message.result) ||
          !exactKeys(message.result, ["userAgent", "codexHome", "platformFamily", "platformOs"]) ||
          typeof message.result.userAgent !== "string" ||
          !samePath(message.result.codexHome, codexHome) ||
          typeof message.result.platformFamily !== "string" ||
          !message.result.platformFamily ||
          typeof message.result.platformOs !== "string" ||
          !message.result.platformOs ||
          !new RegExp(`(?:^|[/ ])${expectedVersion.replaceAll(".", "\\.")}(?:$|[ )])`).test(
            message.result.userAgent,
          )
        ) {
          throw new Error("CODEX_APP_SERVER_INITIALIZE_FAILED");
        }
        state = "thread_starting";
        send({ method: "initialized", params: {} });
        send({
          method: "thread/start",
          id: 2,
          params: {
            cwd: options.workspace,
            modelProvider: "openai",
            runtimeWorkspaceRoots: [options.workspace],
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
            environments: [],
            dynamicTools: [],
            experimentalRawEvents: false,
          },
        });
        return;
      }
      if (message.id === 2) {
        if (
          state !== "thread_starting" ||
          !object(message.result) ||
          !object(message.result.thread)
        )
          throw new Error("CODEX_APP_SERVER_THREAD_START_FAILED");
        const thread = message.result.thread;
        if (message.result.approvalPolicy !== "never" || !readOnlyPolicy(message.result.sandbox)) {
          throw new Error("CODEX_APP_SERVER_THREAD_UNSAFE_POLICY");
        }
        if (message.result.modelProvider !== "openai" || thread.modelProvider !== "openai") {
          throw new Error("CODEX_APP_SERVER_THREAD_UNSAFE_PROVIDER");
        }
        if (
          !samePath(message.result.cwd, options.workspace) ||
          !samePath(thread.cwd, options.workspace)
        ) {
          throw new Error("CODEX_APP_SERVER_THREAD_UNSAFE_CWD");
        }
        if (
          thread.ephemeral !== true ||
          thread.path !== null ||
          thread.cliVersion !== expectedVersion ||
          typeof thread.id !== "string" ||
          !thread.id
        ) {
          throw new Error("CODEX_APP_SERVER_THREAD_UNSAFE_METADATA");
        }
        if (!allowedInstructionSources(message.result.instructionSources, options.environment)) {
          throw new Error("CODEX_APP_SERVER_THREAD_UNSAFE_INSTRUCTIONS");
        }
        threadId = thread.id;
        state = "turn_starting";
        send({
          method: "turn/start",
          id: 3,
          params: {
            threadId,
            input: [
              { type: "text", text: options.prompt, text_elements: [] },
              ...(options.localImagePaths ?? []).map((path) => ({
                type: "localImage",
                path,
                detail: null,
              })),
            ],
            cwd: options.workspace,
            runtimeWorkspaceRoots: [options.workspace],
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            environments: [],
          },
        });
        return;
      }
      if (message.id === 3) {
        if (
          state !== "turn_starting" ||
          !object(message.result) ||
          !exactKeys(message.result, ["turn"]) ||
          !object(message.result.turn) ||
          typeof message.result.turn.id !== "string" ||
          !Array.isArray(message.result.turn.items) ||
          message.result.turn.items.length !== 0 ||
          message.result.turn.status !== "inProgress"
        ) {
          throw new Error("CODEX_APP_SERVER_TURN_START_FAILED");
        }
        turnId = message.result.turn.id;
        state = "running";
        return;
      }
      if (message.id === 4 && terminationStarted) return;
      if ("id" in message && message.id !== undefined)
        throw new Error("CODEX_APP_SERVER_RESPONSE_ID_INVALID");
      if (typeof message.method !== "string" || !object(message.params)) return;
      if (message.method === "turn/started") {
        if (
          state !== "running" ||
          turnStarted ||
          message.params.threadId !== threadId ||
          !object(message.params.turn) ||
          message.params.turn.id !== turnId
        ) {
          throw new Error("CODEX_APP_SERVER_EVENT_CORRELATION_FAILED");
        }
        turnStarted = true;
        eventCount += 1;
        options.onAllowedEvent?.("turn_started");
        return;
      }
      if (message.method === "item/started" || message.method === "item/completed") {
        if (
          state !== "running" ||
          !turnStarted ||
          message.params.threadId !== threadId ||
          message.params.turnId !== turnId ||
          !object(message.params.item)
        ) {
          throw new Error("CODEX_APP_SERVER_EVENT_CORRELATION_FAILED");
        }
        const itemType = message.params.item.type;
        // The built-in imagegen skill reads its own SKILL.md and the job's
        // input.json through Codex's shell tool before invoking image
        // generation. The thread is already pinned to readOnly with network
        // disabled and approvals set to never, so command lifecycle items are
        // expected here. Mutating, remote, and client-defined tools remain
        // fail-closed.
        if (itemType === "dynamicToolCall" && !allowedCodeModeExec(message.params.item)) {
          throw new Error("CODEX_APP_SERVER_FORBIDDEN_DYNAMIC_TOOL");
        }
        if (itemType === "fileChange") throw new Error("CODEX_APP_SERVER_FORBIDDEN_FILE_CHANGE");
        if (itemType === "mcpToolCall") throw new Error("CODEX_APP_SERVER_FORBIDDEN_MCP_TOOL");
        if (itemType === "webSearch") throw new Error("CODEX_APP_SERVER_FORBIDDEN_WEB_SEARCH");
        if (message.method === "item/completed") {
          eventCount += 1;
          options.onAllowedEvent?.("item_completed");
          if (itemType === "imageGeneration") await acceptArtifact(message.params.item);
        }
        return;
      }
      if (message.method === "turn/completed") {
        if (
          state !== "running" ||
          !turnStarted ||
          message.params.threadId !== threadId ||
          !object(message.params.turn) ||
          message.params.turn.id !== turnId ||
          message.params.turn.status !== "completed"
        ) {
          throw new Error("CODEX_APP_SERVER_EVENT_CORRELATION_FAILED");
        }
        if (!artifact) throw new Error("CODEX_APP_SERVER_NO_IMAGE");
        state = "completed";
        normalShutdown = true;
        eventCount += 1;
        options.onAllowedEvent?.("turn_completed");
        terminateProcessTree(child, "SIGTERM");
        forceKill = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1_000);
      }
    };

    let processing: Promise<void> = Promise.resolve();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || pendingError) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_TOTAL_BYTES)
        return fail(new Error("CODEX_APP_SERVER_EVENT_LIMIT"));
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer) > MAX_JSONL_LINE_BYTES)
        return fail(new Error("CODEX_APP_SERVER_EVENT_TOO_LARGE"));
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      const messages: Record<string, unknown>[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        lineCount += 1;
        if (lineCount > MAX_LINES) return fail(new Error("CODEX_APP_SERVER_EVENT_LIMIT"));
        const lineBytes = Buffer.byteLength(line);
        if (lineBytes > MAX_JSONL_LINE_BYTES)
          return fail(new Error("CODEX_APP_SERVER_EVENT_TOO_LARGE"));
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return fail(new Error("CODEX_APP_SERVER_MALFORMED_JSONL"));
        }
        if (!object(parsed)) return fail(new Error("CODEX_APP_SERVER_MESSAGE_INVALID"));
        if (!isImageBearingMessage(parsed)) {
          if (lineBytes > MAX_ORDINARY_LINE_BYTES)
            return fail(new Error("CODEX_APP_SERVER_EVENT_TOO_LARGE"));
          ordinaryBytes += lineBytes;
          if (ordinaryBytes > MAX_ORDINARY_TOTAL_BYTES)
            return fail(new Error("CODEX_APP_SERVER_EVENT_LIMIT"));
        }
        messages.push(parsed);
      }
      child.stdout.pause();
      processing = processing.then(async () => {
        for (const message of messages) await handleMessage(message);
      });
      processing.then(
        () => child.stdout.resume(),
        (error: unknown) =>
          fail(error instanceof Error ? error : new Error("CODEX_APP_SERVER_FAILED")),
      );
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) fail(new Error("CODEX_APP_SERVER_STDERR_LIMIT"));
    });
    child.once("spawn", () => {
      spawned = true;
      options.onSpawned?.();
      send({
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
    });
    child.stdin.on("error", (error) => fail(error));
    child.once("error", (error) => fail(error));
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const abort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (interruptTimer) clearTimeout(interruptTimer);
      options.signal?.removeEventListener("abort", abort);
      if (settled) return;
      processing
        .then(() => {
          if (stdoutBuffer.trim() && !pendingError)
            pendingError = new Error("CODEX_APP_SERVER_MALFORMED_JSONL");
          const exitClass: ExitClass = timedOut
            ? "timeout"
            : aborted
              ? "aborted"
              : normalShutdown
                ? "success"
                : "nonzero";
          if (spawned) options.onExited?.(exitClass);
          if (pendingError) throw pendingError;
          if (timedOut) throw new Error("CODEX_APP_SERVER_TIMEOUT");
          if (aborted) throw new Error("CODEX_APP_SERVER_ABORTED");
          if (!normalShutdown || !artifact)
            throw new Error(
              code === 0 ? "CODEX_APP_SERVER_NO_IMAGE" : "CODEX_APP_SERVER_PROCESS_FAILED",
            );
          settled = true;
          resolvePromise({ bytes: artifact, eventCount });
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          rejectPromise(error instanceof Error ? error : new Error("CODEX_APP_SERVER_FAILED"));
        });
    });
  });
}

export async function runAppServerArtifact(
  options: AppServerArtifactOptions,
): Promise<AppServerArtifactResult> {
  const before = await configFingerprint(options.environment);
  let result: AppServerArtifactResult | undefined;
  let failure: unknown;
  try {
    result = await runAppServerArtifactProcess(options);
  } catch (error) {
    failure = error;
  }
  const after = await configFingerprint(options.environment);
  if (before !== after) throw new Error("CODEX_APP_SERVER_CONFIG_MUTATED");
  if (failure) throw failure;
  return result!;
}

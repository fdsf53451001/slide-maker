import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, type ImageGenerationRequest } from "@slide-maker/core";
import {
  CodexImageSpikeProvider,
  informationDensityInstruction,
  spawnWithArgv,
} from "../src/index.js";

function request(parameters: Record<string, unknown> = {}): ImageGenerationRequest {
  const project = createProject({ topic: "Codex 軟隔離測試" });
  return {
    projectId: project.id,
    slide: project.slides[0]!,
    style: project.styleSnapshot,
    width: 1920,
    height: 1080,
    references: [],
    model: "codex-imagegen-test",
    parameters,
  };
}

async function fakeCodex(root: string, mode = "success"): Promise<string> {
  const path = join(root, `fake-codex-${mode}.py`);
  await writeFile(
    path,
    `#!/usr/bin/python3
import binascii, json, os, signal, struct, sys, time, zlib
args = sys.argv[1:]
try:
    workspace = args[args.index("-C") + 1]
except (ValueError, IndexError):
    sys.exit(21)
with open(os.path.join(workspace, "argv.json"), "w", encoding="utf-8") as handle:
    json.dump(args, handle)
with open(os.path.join(workspace, "input.json"), "r", encoding="utf-8") as handle:
    input_data = json.load(handle)
output_dir = os.path.join(workspace, "output")
output = os.path.join(output_dir, "slide.png")
mode = ${JSON.stringify(mode)}
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)
def png_bytes(width, height):
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    image_data = zlib.compress(b"\\x00\\x00\\x00\\x00\\x00")
    return bytes([137,80,78,71,13,10,26,10]) + chunk(b"IHDR", header) + chunk(b"IDAT", image_data) + chunk(b"IEND", b"")
if mode == "delay":
    time.sleep(10)
elif mode == "ignore-term":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(10)
else:
    if mode == "symlink":
        os.symlink("/etc/passwd", output)
    elif mode == "header-only":
        png = bytearray(24)
        png[0:8] = bytes([137,80,78,71,13,10,26,10])
        png[12:16] = b"IHDR"
        png[16:20] = int(input_data["canvas"]["width"]).to_bytes(4, "big")
        png[20:24] = int(input_data["canvas"]["height"]).to_bytes(4, "big")
        with open(output, "wb") as handle: handle.write(png)
    elif mode == "parent-symlink":
        outside = os.path.join(${JSON.stringify(root)}, "outside")
        os.mkdir(outside)
        os.rmdir(output_dir)
        os.symlink(outside, output_dir)
        output = os.path.join(output_dir, "slide.png")
        with open(output, "wb") as handle: handle.write(png_bytes(input_data["canvas"]["width"], input_data["canvas"]["height"]))
    else:
        with open(output, "wb") as handle: handle.write(png_bytes(input_data["canvas"]["width"], input_data["canvas"]["height"]))
    if mode == "malformed-json": print("{not-json", flush=True)
    else: print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 1}}), flush=True)
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

describe("Codex image soft sandbox", () => {
  it("turns high density into concrete information and layout requirements", () => {
    const instruction = informationDensityInstruction("high");
    expect(instruction).toContain("detailed and substantive");
    expect(instruction).toContain("rather than hitting a fixed character or unit count");
    expect(instruction).toContain("50-65% of the canvas");
    expect(instruction).toContain("takeaway line only when the slide genuinely needs one");
    expect(instruction).toContain("not to copy them onto the slide verbatim");
    expect(instruction).toContain("Never invent unsupported facts");
  });

  it("recognizes the required flags in an installed Codex CLI without running a turn", async (context) => {
    let result;
    try {
      result = await spawnWithArgv("codex", ["exec", "--help"], { timeoutMs: 5_000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return context.skip();
      throw error;
    }
    expect(result.exitCode).toBe(0);
    for (const flag of [
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "--cd",
    ]) {
      expect(result.stdout).toContain(flag);
    }
  });

  it("is quota-safe and unavailable by default", async () => {
    const provider = new CodexImageSpikeProvider();
    expect(provider.availability.status).toBe("unavailable");
    expect(provider.maxConcurrency).toBe(3);
    await expect(provider.generate(request())).rejects.toThrow("CODEX_IMAGE_SOFT_SANDBOX_DISABLED");
  });

  it("bounds configured Codex parallelism", () => {
    expect(new CodexImageSpikeProvider({ maxConcurrency: 1 }).maxConcurrency).toBe(1);
    expect(new CodexImageSpikeProvider({ maxConcurrency: 4 }).maxConcurrency).toBe(4);
    expect(() => new CodexImageSpikeProvider({ maxConcurrency: 0 })).toThrow(/between 1 and 4/);
    expect(() => new CodexImageSpikeProvider({ maxConcurrency: 5 })).toThrow(/between 1 and 4/);
  });

  it("passes metacharacters as argv data, not shell syntax", async () => {
    const result = await spawnWithArgv(process.execPath, [
      "-e",
      "process.exit(process.argv[1] === '$(touch nope);`id`' ? 0 : 2)",
      "$(touch nope);`id`",
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("uses the required CLI argv, JSONL, dedicated workspace and validated PNG", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-"));
    const fixture = await fakeCodex(root);
    const workspaceRoot = join(root, "jobs");
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      experimentalWorkspaceArtifactContract: true,
      executable: fixture,
      workspaceRoot,
      timeoutMs: 30_000,
    });
    const image = await provider.generate(request());
    expect(image.mediaType).toBe("image/png");
    expect(image.parameters).toEqual({ eventCount: 1, softSandbox: true });
    const [jobDirectory] = await readdir(workspaceRoot);
    const argv = JSON.parse(
      await readFile(join(workspaceRoot, jobDirectory!, "argv.json"), "utf8"),
    ) as string[];
    expect(argv.slice(0, 11)).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      join(workspaceRoot, jobDirectory!),
      expect.stringContaining("$imagegen"),
    ]);
    expect(argv).not.toContain("--search");
    expect(argv[10]).toContain("style object as a mandatory visual contract");
    expect(argv[10]).toContain("Resolve brace-delimited placeholders");
    expect(argv[10]).toContain("style.avoid is a mandatory negative constraint");
    const input = await readFile(join(workspaceRoot, jobDirectory!, "input.json"), "utf8");
    expect(input).toContain("untrusted presentation data");
    expect(input).not.toContain("versions");
    expect(input).not.toContain("assetPaths");
  });

  it("rejects symlink output before reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-link-"));
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      experimentalWorkspaceArtifactContract: true,
      executable: await fakeCodex(root, "symlink"),
      workspaceRoot: join(root, "jobs"),
      timeoutMs: 30_000,
    });
    await expect(provider.generate(request())).rejects.toThrow(/regular file|symlink/);
  });

  it("rejects an output directory replaced by an outside symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-parent-link-"));
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      experimentalWorkspaceArtifactContract: true,
      executable: await fakeCodex(root, "parent-symlink"),
      workspaceRoot: join(root, "jobs"),
      timeoutMs: 30_000,
    });
    await expect(provider.generate(request())).rejects.toThrow(/output directory/);
  });

  it("rejects a header-only PNG without IDAT and IEND chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-header-"));
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      experimentalWorkspaceArtifactContract: true,
      executable: await fakeCodex(root, "header-only"),
      workspaceRoot: join(root, "jobs"),
      timeoutMs: 30_000,
    });
    await expect(provider.generate(request())).rejects.toThrow(/complete PNG/);
  });

  it("rejects malformed Codex JSONL events", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-jsonl-"));
    const provider = new CodexImageSpikeProvider({
      allowExecution: true,
      experimentalWorkspaceArtifactContract: true,
      executable: await fakeCodex(root, "malformed-json"),
      workspaceRoot: join(root, "jobs"),
      timeoutMs: 30_000,
    });
    await expect(provider.generate(request())).rejects.toThrow(/malformed JSONL/);
  });

  it("terminates timed-out and cancelled jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-timeout-"));
    const delayFixture = await fakeCodex(root, "delay");
    const timed = await spawnWithArgv("/usr/bin/python3", ["-c", "import time; time.sleep(10)"], {
      timeoutMs: 100,
    });
    expect(timed.timedOut).toBe(true);

    const cancelledProvider = new CodexImageSpikeProvider({
      allowExecution: true,
      experimentalWorkspaceArtifactContract: true,
      executable: delayFixture,
      workspaceRoot: join(root, "cancelled"),
      timeoutMs: 30_000,
    });
    const controller = new AbortController();
    const generation = cancelledProvider.generate(request(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(generation).rejects.toMatchObject({ name: "AbortError" });
  });

  it("escalates timeout to SIGKILL when the child ignores SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-fake-codex-kill-"));
    const startedAt = Date.now();
    const result = await spawnWithArgv(
      "/usr/bin/python3",
      ["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(10)"],
      { timeoutMs: 100 },
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.each([0, Number.POSITIVE_INFINITY, 29_999, 1_800_001])(
    "rejects unsafe public timeout %s",
    (timeoutMs) => {
      expect(() => new CodexImageSpikeProvider({ timeoutMs })).toThrow(/between 30000 and 1800000/);
    },
  );
});

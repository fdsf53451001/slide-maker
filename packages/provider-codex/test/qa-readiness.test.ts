import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexImageSpikeProvider } from "../src/index.js";

type Mode = "ready" | "unknown-version" | "incompatible" | "auth_required" | "unknown" | "timeout";

async function fakeCodex(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-qa-readiness-"));
  const executable = join(root, "codex");
  const audit = join(root, "argv.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(audit)}, JSON.stringify(args) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "timeout" && args[0] === "--version") setInterval(() => {}, 1000);
else if (args.length === 1 && args[0] === "--version") writeSync(1, mode === "unknown-version" ? "codex-cli 999.0.0\\n" : "codex-cli 0.144.4\\n");
else if (args[0] === "app-server" && args[1] === "--help") {
  if (mode === "incompatible") writeSync(1, "app-server\\n");
  else writeSync(1, "--stdio generate-json-schema\\n");
} else if (args[0] === "login" && args[1] === "--help") {
  if (mode === "unknown") { writeSync(2, "RAW-STDERR-UNKNOWN TOKEN-CANARY"); process.exit(8); }
  writeSync(1, "  status  Show login status\\n");
} else if (args[0] === "login" && args[1] === "status") {
  if (mode === "auth_required") { writeSync(2, "Bearer AUTH-SECRET login required"); process.exit(1); }
  writeSync(1, "Logged in using ChatGPT\\n");
} else {
  writeSync(2, "UNEXPECTED MODEL TURN OR PROMPT");
  process.exit(97);
}
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable, audit };
}

async function argv(audit: string): Promise<string[][]> {
  return (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

describe("QA Codex non-generating readiness", () => {
  it("returns disabled without executing the configured CLI", async () => {
    const fake = await fakeCodex("ready");
    const provider = new CodexImageSpikeProvider({ allowExecution: false, executable: fake.executable });
    await expect(provider.preflight()).resolves.toEqual({ status: "disabled" });
    await expect(readFile(fake.audit, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies a missing executable", async () => {
    const provider = new CodexImageSpikeProvider({ allowExecution: true, executable: join(tmpdir(), `missing-codex-${Date.now()}`) });
    await expect(provider.preflight()).resolves.toEqual({ status: "cli_missing" });
  });

  it.each([
    ["incompatible", "incompatible"],
    ["auth_required", "auth_required"],
    ["unknown", "unknown"],
    ["ready", "ready_experimental"],
  ] as const)("classifies fake CLI mode %s as %s without exposing process output", async (mode, status) => {
    const fake = await fakeCodex(mode);
    const provider = new CodexImageSpikeProvider({ allowExecution: true, executable: fake.executable });
    const result = await provider.preflight();
    expect(result).toEqual({ status });
    expect(Object.keys(result)).toEqual(["status"]);
    expect(JSON.stringify(result)).not.toMatch(/stderr|Bearer|SECRET|TOKEN|path|prompt/i);
  });

  it("classifies a bounded preflight timeout distinctly", { timeout: 8_000 }, async () => {
    const fake = await fakeCodex("timeout");
    const provider = new CodexImageSpikeProvider({ allowExecution: true, executable: fake.executable });
    await expect(provider.preflight()).resolves.toEqual({ status: "timeout" });
  });

  it("uses help/status only and never starts a Codex model turn or image generation", async () => {
    const fake = await fakeCodex("ready");
    const provider = new CodexImageSpikeProvider({ allowExecution: true, executable: fake.executable });
    await expect(provider.preflight()).resolves.toEqual({ status: "ready_experimental" });
    const invocations = await argv(fake.audit);
    expect(invocations).toEqual([
      ["--version"],
      ["app-server", "--help"],
      ["login", "--help"],
      ["login", "status"],
    ]);
    const serialized = JSON.stringify(invocations);
    expect(serialized).not.toContain("$imagegen");
    expect(invocations.some((args) => args[0] === "exec")).toBe(false);
    expect(invocations.every((args) => args.length <= 2)).toBe(true);
  });

  it("fails an unknown CLI version before starting app-server, exec, or any model turn", async () => {
    const fake = await fakeCodex("unknown-version");
    const provider = new CodexImageSpikeProvider({ allowExecution: true, executable: fake.executable });
    await expect(provider.preflight()).resolves.toEqual({ status: "artifact_unsupported" });
    expect(await argv(fake.audit)).toEqual([["--version"]]);
  });
});

import type { TestContext } from "vitest";
import { spawnWithArgv, type ProcessResult } from "../../src/index.js";

/**
 * Shared responsiveness probe for the *real* Codex CLI.
 *
 * A handful of tests spawn the installed `codex` binary rather than a fake
 * fixture. On some machines the CLI is present on PATH but never answers (e.g.
 * a macOS TCC / ~/Downloads authorization gap makes `codex exec --help` hang
 * indefinitely — see CLAUDE.md). Left unguarded, those tests fail with an
 * opaque "Test timed out" instead of skipping, which also aborts the rest of
 * the `pnpm -r test` run.
 *
 * This probe spawns `codex exec --help` once (quota-safe: `--help` never runs a
 * model turn) with a short timeout, classifies the outcome, and caches the
 * result for the whole test-process lifetime so no test waits on the probe more
 * than once. It only decides *reachability*; it never inspects exit codes or
 * flags, so a responsive-but-wrong CLI still reaches the test's assertions.
 */

/** Probe timeout in ms. Overridable for slow/fast hosts. Default 3s. */
export const CODEX_PROBE_TIMEOUT_MS = ((): number => {
  const raw = process.env.SLIDE_MAKER_CODEX_PROBE_TIMEOUT_MS;
  if (raw === undefined) return 3_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3_000;
})();

export type CodexCliProbe =
  | { readonly status: "responsive"; readonly result: ProcessResult }
  | { readonly status: "missing" }
  | { readonly status: "unresponsive"; readonly reason: string };

let cachedProbe: Promise<CodexCliProbe> | undefined;

async function runProbe(): Promise<CodexCliProbe> {
  let result: ProcessResult;
  try {
    result = await spawnWithArgv("codex", ["exec", "--help"], {
      timeoutMs: CODEX_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unresponsive", reason: `codex CLI failed to spawn: ${message}` };
  }
  if (result.timedOut) {
    return {
      status: "unresponsive",
      reason: `codex CLI unresponsive: no reply to \`codex exec --help\` within ${CODEX_PROBE_TIMEOUT_MS}ms (environment issue, see CLAUDE.md)`,
    };
  }
  return { status: "responsive", result };
}

/** Probe the real Codex CLI once; the result is cached across the test run. */
export function probeCodexCli(): Promise<CodexCliProbe> {
  return (cachedProbe ??= runProbe());
}

/**
 * Resolve to the probe's captured `codex exec --help` result when the CLI is
 * reachable, or skip the current test with an explicit reason when the CLI is
 * missing or unresponsive. Reused so every real-CLI test skips identically.
 */
export async function requireResponsiveCodexCli(context: TestContext): Promise<ProcessResult> {
  const probe = await probeCodexCli();
  if (probe.status === "missing") {
    return context.skip("codex CLI is not installed (ENOENT)");
  }
  if (probe.status === "unresponsive") {
    return context.skip(probe.reason);
  }
  return probe.result;
}

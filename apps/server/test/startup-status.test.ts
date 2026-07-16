import { describe, expect, it } from "vitest";
import { formatStartupStatus } from "../src/startup-status.js";

describe("startup provider status", () => {
  it("reports Codex as disabled without opt-in", () => {
    const messages = formatStartupStatus({ baseUrl: "http://127.0.0.1:4173", codexSoftSandboxEnabled: false });
    expect(messages.join("\n")).toContain("Codex image provider is disabled");
    expect(messages.join("\n")).not.toContain("Codex image provider is ENABLED");
  });

  it("reports enabled soft-isolation risk without echoing environment values", () => {
    const messages = formatStartupStatus({ baseUrl: "http://127.0.0.1:4173", codexSoftSandboxEnabled: true });
    const output = messages.join("\n");
    expect(output).toContain("Codex image provider is ENABLED");
    expect(output).toContain("not a read or tool security boundary");
    expect(output).not.toContain("SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1");
  });
});


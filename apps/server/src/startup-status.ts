export interface StartupStatusInput {
  baseUrl: string;
  codexSoftSandboxEnabled: boolean;
}

export function formatStartupStatus(input: StartupStatusInput): string[] {
  const messages = [
    `Slide Maker is running at ${input.baseUrl}`,
    "Mock image provider is active and does not consume model quota.",
  ];
  if (input.codexSoftSandboxEnabled) {
    messages.push(
      "Codex image provider is ENABLED with soft isolation and may consume Codex quota.",
      "WARNING: read-only restricts writes but is not a read or tool security boundary; app-server still loads CODEX_HOME configuration and tool surfaces, so prompt injection and local data leakage remain possible.",
    );
  } else {
    messages.push("Codex image provider is disabled. Set SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1 to opt in.");
  }
  return messages;
}

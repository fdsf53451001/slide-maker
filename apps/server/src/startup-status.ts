export interface StartupStatusInput {
  baseUrl: string;
}

export function formatStartupStatus(input: StartupStatusInput): string[] {
  return [
    `Slide Maker is running at ${input.baseUrl}`,
    "Mock image provider is active and does not consume model quota.",
  ];
}

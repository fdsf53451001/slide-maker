import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  type GeneratedImage,
  type ImageProvider,
  type ProviderPreflightStatus,
} from "@slide-maker/core";
import { ProviderReadinessGateError, ProviderReadinessService } from "../src/readiness.js";

const capabilities = {
  fullSlideGeneration: true as const,
  referenceImages: false,
  imageEditing: false,
  maskedEditing: false,
  multipleReferenceImages: false,
  supportedSizes: [{ width: 1920, height: 1080 }],
  reproducibleParameters: [] as string[],
};

function provider(
  input: {
    status?: ProviderPreflightStatus;
    artifactContract?: "supported" | "unsupported";
    preflight?: () => Promise<{ status: ProviderPreflightStatus }>;
    availability?: ImageProvider["availability"];
  } = {},
): ImageProvider {
  return {
    id: "qa-readiness",
    name: "QA readiness",
    availability: input.availability ?? { status: "available" },
    artifactContract: input.artifactContract ?? "supported",
    capabilities,
    preflight: input.preflight ?? (async () => ({ status: input.status ?? "ready" })),
    async generate(): Promise<GeneratedImage> {
      throw new Error("preflight must never generate");
    },
  };
}

function service(imageProvider: ImageProvider) {
  return new ProviderReadinessService(
    new ProviderRegistry<ImageProvider>().register(imageProvider),
  );
}

describe("QA provider readiness service", () => {
  it("singleflights concurrent checks and caches the safe result", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const imageProvider = provider({
      preflight: async () => {
        calls += 1;
        await blocked;
        return { status: "ready" };
      },
    });
    const readiness = service(imageProvider);
    const first = readiness.check(imageProvider.id);
    const second = readiness.check(imageProvider.id);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(await readiness.check(imageProvider.id)).toEqual(left);
    expect(calls).toBe(1);
  });

  it.each([
    ["ready", false, false],
    ["ready_experimental", false, false],
    ["disabled", true, false],
    ["cli_missing", true, false],
    ["incompatible", true, false],
    ["auth_required", true, false],
    ["timeout", true, false],
    ["artifact_unsupported", true, false],
    ["unknown", false, true],
  ] as const)(
    "returns a safe allowlisted %s contract",
    async (status, blocking, requiresAcknowledgement) => {
      const result = await service(provider({ status })).check("qa-readiness");
      expect(result).toMatchObject({
        providerId: "qa-readiness",
        status,
        blocking,
        requiresAcknowledgement,
      });
      expect(Object.keys(result).sort()).toEqual([
        "blocking",
        "checkedAt",
        "expiresAt",
        "message",
        "providerId",
        "requiresAcknowledgement",
        "status",
      ]);
      expect(result.message.length).toBeGreaterThan(5);
      expect(JSON.stringify(result)).not.toMatch(
        /pid|path|prompt|stderr|Bearer|TOKEN-CANARY|base64|revised_prompt/i,
      );
    },
  );

  it("fail-closes a ready CLI when its image artifact contract is unsupported", async () => {
    const result = await service(
      provider({ status: "ready", artifactContract: "unsupported" }),
    ).check("qa-readiness");
    expect(result).toMatchObject({
      status: "artifact_unsupported",
      blocking: true,
      requiresAcknowledgement: false,
    });
  });

  it("only allows the explicit unknown-risk acknowledgement and never bypasses blocking states", async () => {
    const unknownService = service(provider({ status: "unknown" }));
    await expect(unknownService.assertCanGenerate("qa-readiness", false)).rejects.toBeInstanceOf(
      ProviderReadinessGateError,
    );
    await expect(unknownService.assertCanGenerate("qa-readiness", true)).resolves.toMatchObject({
      status: "unknown",
    });

    const blockedService = service(provider({ status: "auth_required" }));
    await expect(blockedService.assertCanGenerate("qa-readiness", true)).rejects.toMatchObject({
      name: "ProviderReadinessGateError",
      readiness: { status: "auth_required", blocking: true },
    });
  });
});

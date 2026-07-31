import { STYLE_REFERENCE_IMAGE_LIMIT } from "@slide-maker/core";
import { describe, expect, it } from "vitest";
import { projectStyleAnalysisInputSchema } from "../src/app.js";

describe("project style-analysis reference limit", () => {
  const input = (count: number) => ({
    slideIds: Array.from({ length: count }, (_, index) => `slide-${index}`),
  });

  it("accepts the core limit and rejects one more", () => {
    expect(
      projectStyleAnalysisInputSchema.safeParse(input(STYLE_REFERENCE_IMAGE_LIMIT)).success,
    ).toBe(true);
    expect(
      projectStyleAnalysisInputSchema.safeParse(input(STYLE_REFERENCE_IMAGE_LIMIT + 1)).success,
    ).toBe(false);
  });
});

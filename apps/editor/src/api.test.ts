import { describe, expect, it } from "vitest";
import { imageUrl } from "./api.js";

describe("imageUrl", () => {
  it("encodes the asset path and adds a stable cache-busting version", () => {
    expect(imageUrl("project id", "assets/slide id/version 1.png")).toBe(
      "/api/projects/project%20id/assets/slide%20id/version%201.png?v=version%201.png",
    );
  });
});

import { describe, expect, it } from "vitest";
import { createProject } from "@slide-maker/core";
import { MockImageProvider } from "../src/index.js";

describe("MockImageProvider", () => {
  it("returns a full slide without external calls", async () => {
    const project = createProject({ topic: "測試主題" });
    const image = await new MockImageProvider().generate({
      projectId: project.id,
      slide: project.slides[0]!,
      style: project.styleSnapshot,
      width: project.canvas.width,
      height: project.canvas.height,
      references: [],
      model: "mock-svg-v1",
      parameters: {},
    });
    expect(image.mediaType).toBe("image/svg+xml");
    expect(new TextDecoder().decode(image.bytes)).toContain("測試主題");
  });
});


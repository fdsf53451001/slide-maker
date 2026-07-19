import { describe, expect, it } from "vitest";
import {
  buildImageGenerationContract,
  imageGenerationInput,
  type ImageGenerationRequest,
} from "../src/index.js";

function request(): ImageGenerationRequest {
  return {
    projectId: "project-secret-id",
    slide: {
      id: "slide-1",
      order: 0,
      purpose: "解釋代理式 AI",
      content: "標題、三項證據與結論",
      narrative: "由問題走向解法",
      layoutHint: "左文右圖",
      dataBasis: ["採用率 80%"],
      imagePrompt: "明亮企業攝影",
      sourceIds: ["source-1"],
      outlineDirty: false,
      versions: [],
    },
    style: {
      schemaVersion: 1,
      id: "style-1",
      version: 1,
      name: "清爽風",
      description: "大量白色留白",
      system: false,
      density: "high",
      imageDirection: "模組化資訊卡",
      avoid: ["深色漸層"],
      promptTemplate: "以 {subject} 為主體",
      referenceImages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    width: 1920,
    height: 1080,
    references: [
      { path: "/trusted/style.png", mediaType: "image/png", role: "style", name: "Style A" },
      {
        path: "/trusted/panel.png",
        mediaType: "image/png",
        role: "direct-asset",
        name: "Source panel",
      },
    ],
    model: "image-model",
    parameters: {},
  };
}

describe("shared image-generation contract", () => {
  it("carries the full slide/style contract and labelled reference semantics", () => {
    const prompt = buildImageGenerationContract(request());
    expect(prompt).toContain("Information density requirement: HIGH");
    expect(prompt).toContain("slide.content field is the authoritative visible copy");
    expect(prompt).toContain("DIRECT-ASSET FIDELITY CONTRACT");
    expect(prompt).toContain('role=style; name="Style A"');
    expect(prompt).toContain('role=direct-asset; name="Source panel"');
    expect(prompt).toContain('"layoutHint": "左文右圖"');
    expect(prompt).toContain('"description": "大量白色留白"');
    expect(prompt).toContain('"promptTemplate": "以 {subject} 為主體"');
  });

  it("keeps provider and persistence metadata out of the model input", () => {
    const input = imageGenerationInput(request());
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("project-secret-id");
    expect(serialized).not.toContain("source-1");
    expect(serialized).not.toContain("versions");
    expect(serialized).not.toContain("/trusted/style.png");
  });

  it("uses the text-removal contract without asking the model to repaint content", () => {
    const input = request();
    input.edit = {
      instruction: "Remove masked text",
      baseImageIndex: 0,
      maskImageIndex: 1,
      purpose: "text-removal",
    };
    const prompt = buildImageGenerationContract(input);
    expect(prompt).toContain("TEXT REMOVAL CONTRACT");
    expect(prompt).toContain("Do not re-render text from slide.content");
    expect(prompt).not.toContain("Information density requirement");
    expect(prompt).not.toContain("slide.content field is the authoritative visible copy");
  });
});

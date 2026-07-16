import type {
  GeneratedImage,
  ImageGenerationContext,
  ImageGenerationRequest,
  ImageProvider,
} from "@slide-maker/core";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(value: string, width = 27): string[] {
  const compact = value.trim().replace(/\s+/g, " ");
  const result: string[] = [];
  for (let index = 0; index < compact.length; index += width) {
    result.push(compact.slice(index, index + width));
  }
  return result.slice(0, 4);
}

export class MockImageProvider implements ImageProvider {
  readonly id = "mock-image";
  readonly name = "Mock image (no quota)";
  readonly availability = { status: "available" as const };
  readonly maxConcurrency = 2;
  readonly capabilities = {
    fullSlideGeneration: true as const,
    referenceImages: true,
    imageEditing: true,
    maskedEditing: false,
    multipleReferenceImages: true,
    supportedSizes: [{ width: 1920, height: 1080 }],
    reproducibleParameters: ["palette"],
  };

  async generate(
    request: ImageGenerationRequest,
    context?: ImageGenerationContext,
  ): Promise<GeneratedImage> {
    if (context?.signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
    const [background, foreground, accent] = ["#0b1020", "#f5f1e8", "#ff7a45"];
    const lines = wrap(request.slide.content);
    const body = lines
      .map(
        (line, index) =>
          `<text x="150" y="${520 + index * 74}" font-family="system-ui, sans-serif" font-size="44" fill="${escapeXml(foreground)}" opacity="0.9">${escapeXml(line)}</text>`,
      )
      .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${request.width}" height="${request.height}" viewBox="0 0 ${request.width} ${request.height}">
      <defs><radialGradient id="g" cx="82%" cy="18%" r="80%"><stop offset="0" stop-color="${escapeXml(accent)}" stop-opacity=".52"/><stop offset="1" stop-color="${escapeXml(background)}" stop-opacity="0"/></radialGradient></defs>
      <rect width="100%" height="100%" fill="${escapeXml(background)}"/><rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="1580" cy="280" r="190" fill="none" stroke="${escapeXml(accent)}" stroke-width="4" opacity=".7"/><circle cx="1580" cy="280" r="95" fill="${escapeXml(accent)}" opacity=".18"/>
      <text x="150" y="145" font-family="system-ui, sans-serif" font-size="24" letter-spacing="6" fill="${escapeXml(accent)}">SLIDE ${String(request.slide.order + 1).padStart(2, "0")}</text>
      <text x="150" y="340" font-family="system-ui, sans-serif" font-size="86" font-weight="700" fill="${escapeXml(foreground)}">${escapeXml(request.slide.purpose)}</text>
      <rect x="150" y="418" width="110" height="8" rx="4" fill="${escapeXml(accent)}"/>${body}
      <text x="150" y="980" font-family="system-ui, sans-serif" font-size="22" fill="${escapeXml(foreground)}" opacity=".48">${escapeXml(request.style.name)} · deterministic mock</text>
    </svg>`;
    return {
      bytes: new TextEncoder().encode(svg),
      mediaType: "image/svg+xml",
      extension: "svg",
      model: "mock-svg-v1",
      parameters: { ...request.parameters, deterministic: true },
    };
  }
}

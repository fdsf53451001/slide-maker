import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import {
  SCHEMA_VERSION,
  createDefaultStyle,
  stylePresetInputSchema,
  stylePresetSchema,
  styleReferenceImageSchema,
  type StylePreset,
  type StyleReferenceImage,
} from "@slide-maker/core";

const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;

function safeReferenceName(name: string): string {
  return (
    basename(name)
      .normalize("NFC")
      .replace(/[\u0000-\u001f/\\:]/g, "_")
      .trim() || "reference"
  ).slice(0, 180);
}

function validateReferenceBytes(
  mediaType: StyleReferenceImage["mediaType"],
  bytes: Uint8Array,
): void {
  if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES)
    throw new Error("STYLE_REFERENCE_SIZE_INVALID");
  if (
    mediaType === "image/png" &&
    !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("STYLE_REFERENCE_CONTENT_INVALID");
  }
  if (
    mediaType === "image/jpeg" &&
    !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)
  ) {
    throw new Error("STYLE_REFERENCE_CONTENT_INVALID");
  }
}

export class FileStyleRepository {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(id: string, version: number) {
    return join(this.root, `${id}.v${version}.json`);
  }
  private assetsRoot() {
    return join(this.root, "assets");
  }
  private metadataPath(id: string) {
    return join(this.assetsRoot(), `${id}.json`);
  }

  async initialize() {
    await mkdir(this.assetsRoot(), { recursive: true });
    if (!(await this.get("ai-free-design"))) await this.write(createDefaultStyle());
  }

  private async write(style: StylePreset) {
    const path = this.path(style.id, style.version);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(style, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  async list(): Promise<StylePreset[]> {
    await mkdir(this.root, { recursive: true });
    const names = await readdir(this.root);
    const styles = (
      await Promise.all(
        names
          .filter((name) => /^[\w-]+\.v\d+\.json$/.test(name))
          .map(async (name) => {
            try {
              return stylePresetSchema.parse(
                JSON.parse(await readFile(join(this.root, name), "utf8")),
              );
            } catch {
              return undefined;
            }
          }),
      )
    ).filter((style): style is StylePreset => !!style);
    const latest = new Map<string, StylePreset>();
    for (const style of styles)
      if (!latest.has(style.id) || latest.get(style.id)!.version < style.version)
        latest.set(style.id, style);
    return [...latest.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async get(id: string, version?: number): Promise<StylePreset | undefined> {
    const all = await this.listVersions(id);
    return version ? all.find((style) => style.version === version) : all.at(-1);
  }

  async listVersions(id: string): Promise<StylePreset[]> {
    if (!/^[\w-]+$/.test(id)) throw new Error("INVALID_STYLE_ID");
    await mkdir(this.root, { recursive: true });
    const names = (await readdir(this.root)).filter(
      (name) => name.startsWith(`${id}.v`) && name.endsWith(".json"),
    );
    return (
      await Promise.all(
        names.map(async (name) => {
          try {
            return stylePresetSchema.parse(
              JSON.parse(await readFile(join(this.root, name), "utf8")),
            );
          } catch {
            return undefined;
          }
        }),
      )
    )
      .filter((style): style is StylePreset => !!style)
      .sort((left, right) => left.version - right.version);
  }

  private async validateReferences(
    referenceImages: StyleReferenceImage[],
    coverImageId?: string,
  ): Promise<void> {
    if (
      referenceImages.length > 4 ||
      new Set(referenceImages.map((image) => image.id)).size !== referenceImages.length
    ) {
      throw new Error("STYLE_REFERENCE_LIMIT");
    }
    if (coverImageId && !referenceImages.some((image) => image.id === coverImageId))
      throw new Error("STYLE_COVER_INVALID");
    for (const image of referenceImages) {
      const parsed = styleReferenceImageSchema.parse(image);
      const stored = await this.referenceMetadata(parsed.id);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(parsed))
        throw new Error("STYLE_REFERENCE_INVALID");
      await open(
        this.referenceAssetPath(parsed.assetPath),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      ).then((handle) => handle.close());
    }
  }

  async create(input: unknown): Promise<StylePreset> {
    const value = stylePresetInputSchema.parse(input);
    const referenceImages = value.referenceImages ?? [];
    const coverImageId = value.coverImageId ?? referenceImages[0]?.id;
    await this.validateReferences(referenceImages, coverImageId);
    const now = new Date().toISOString();
    const style = stylePresetSchema.parse({
      ...value,
      referenceImages,
      ...(coverImageId ? { coverImageId } : {}),
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      system: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.write(style);
    return style;
  }

  async update(id: string, input: unknown): Promise<StylePreset> {
    const previous = await this.get(id);
    if (!previous) throw new Error("Style not found");
    if (previous.system) throw new Error("SYSTEM_STYLE_READ_ONLY");
    const patch = stylePresetInputSchema.partial().parse(input);
    const referenceImages = patch.referenceImages ?? previous.referenceImages;
    const requestedCover = patch.coverImageId ?? previous.coverImageId;
    const coverImageId = referenceImages.some((image) => image.id === requestedCover)
      ? requestedCover
      : referenceImages[0]?.id;
    const merged = {
      ...previous,
      ...patch,
      referenceImages,
      ...(coverImageId ? { coverImageId } : { coverImageId: undefined }),
    };
    await this.validateReferences(merged.referenceImages, merged.coverImageId);
    const now = new Date().toISOString();
    const style = stylePresetSchema.parse({
      ...merged,
      version: previous.version + 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.write(style);
    return style;
  }

  async duplicate(id: string): Promise<StylePreset> {
    const source = await this.get(id);
    if (!source) throw new Error("Style not found");
    return this.create({
      name: `${source.name} 複本`,
      description: source.description,
      density: source.density,
      imageDirection: source.imageDirection,
      avoid: source.avoid,
      promptTemplate: source.promptTemplate,
      referenceImages: source.referenceImages,
      coverImageId: source.coverImageId,
    });
  }

  async saveReference(
    name: string,
    mediaType: StyleReferenceImage["mediaType"],
    bytes: Uint8Array,
  ): Promise<StyleReferenceImage> {
    validateReferenceBytes(mediaType, bytes);
    const id = randomUUID();
    const extension = mediaType === "image/png" ? ".png" : ".jpg";
    const assetPath = `assets/${id}${extension}`;
    const target = this.referenceAssetPath(assetPath);
    const reference = styleReferenceImageSchema.parse({
      id,
      name: safeReferenceName(name),
      mediaType,
      assetPath,
      createdAt: new Date().toISOString(),
    });
    await mkdir(this.assetsRoot(), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    await writeFile(this.metadataPath(id), `${JSON.stringify(reference, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return reference;
  }

  async referenceMetadata(id: string): Promise<StyleReferenceImage | undefined> {
    if (!/^[\w-]+$/.test(id)) throw new Error("INVALID_STYLE_REFERENCE_ID");
    try {
      return styleReferenceImageSchema.parse(
        JSON.parse(await readFile(this.metadataPath(id), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  referenceAssetPath(assetPath: string): string {
    if (!/^assets\/[a-zA-Z0-9_-]+\.(png|jpg)$/.test(assetPath) || extname(assetPath) === "")
      throw new Error("STYLE_REFERENCE_PATH_INVALID");
    const path = resolve(this.root, assetPath);
    if (!path.startsWith(`${this.assetsRoot()}${sep}`))
      throw new Error("STYLE_REFERENCE_PATH_INVALID");
    return path;
  }
}

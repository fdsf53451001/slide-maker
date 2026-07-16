import type { z } from "zod";
import type {
  PresentationBrief,
  PresentationProject,
  SlideSpec,
  SourceAsset,
  SourceCitation,
  StylePreset,
} from "./schemas.js";

export interface ImageProviderCapabilities {
  fullSlideGeneration: true;
  referenceImages: boolean;
  imageEditing: boolean;
  maskedEditing: boolean;
  multipleReferenceImages: boolean;
  supportedSizes: ReadonlyArray<{ width: number; height: number }>;
  reproducibleParameters: ReadonlyArray<string>;
}

export type ProviderAvailability =
  | { status: "available"; warning?: string }
  | { status: "unavailable"; reason: string };

export interface ImageGenerationRequest {
  projectId: string;
  slide: SlideSpec;
  style: StylePreset;
  width: number;
  height: number;
  references: ReadonlyArray<{ path: string; mediaType: string; role: "style" | "content"; name?: string }>;
  model: string;
  parameters: Record<string, unknown>;
  edit?: { instruction: string; baseImageIndex: number; maskImageIndex?: number };
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mediaType: string;
  extension: string;
  model: string;
  parameters: Record<string, unknown>;
}

export type GenerationPhase = "launching" | "waiting_for_codex" | "validating_output";

export interface ImageGenerationProgress {
  phase: GenerationPhase;
  eventCode?: "turn_started" | "item_completed" | "turn_completed";
}

export type ChildExitClass = "success" | "nonzero" | "timeout" | "aborted" | "server_shutdown";

export type ImageGenerationLifecycleEvent =
  | { type: "spawned" }
  | { type: "exited"; exitClass: Exclude<ChildExitClass, "server_shutdown"> };

export type ProviderPreflightStatus = "ready" | "ready_experimental" | "disabled" | "cli_missing" | "incompatible" | "auth_required" | "timeout" | "artifact_unsupported" | "unknown";

export interface ProviderPreflightResult {
  status: ProviderPreflightStatus;
}

export interface ImageGenerationContext {
  signal?: AbortSignal;
  onProgress?: (progress: ImageGenerationProgress) => void | Promise<void>;
  onLifecycle?: (event: ImageGenerationLifecycleEvent) => void | Promise<void>;
}

export class SafeProviderError extends Error {
  constructor(readonly code: string, readonly safeMessage: string) {
    super(code);
    this.name = "SafeProviderError";
  }
}

export interface ImageProvider {
  readonly id: string;
  readonly name: string;
  readonly availability: ProviderAvailability;
  /** Maximum jobs this process may execute concurrently for this provider. */
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
  readonly artifactContract?: "supported" | "unsupported";
  readonly capabilities: ImageProviderCapabilities;
  readonly settingsSchema?: z.ZodType;
  /** A bounded, non-generating readiness check. It must never expose raw process output. */
  preflight?(): Promise<ProviderPreflightResult>;
  generate(request: ImageGenerationRequest, context?: ImageGenerationContext): Promise<GeneratedImage>;
}

export interface LLMProvider {
  readonly id: string;
  createBrief(input: string): Promise<PresentationBrief>;
  createOutline(brief: PresentationBrief, context: ReadonlyArray<SourceCitation>): Promise<SlideSpec[]>;
}

export interface SourceProvider {
  readonly id: string;
  readonly supportedMediaTypes: ReadonlyArray<string>;
  parse(source: SourceAsset, absolutePath: string): Promise<ReadonlyArray<SourceChunk>>;
}

export interface SourceChunk {
  id: string;
  sourceId: string;
  text: string;
  locator?: string;
}

export interface Retriever {
  readonly id: string;
  index(projectId: string, chunks: ReadonlyArray<SourceChunk>): Promise<void>;
  search(projectId: string, query: string, limit: number): Promise<ReadonlyArray<SourceChunk>>;
}

export interface StyleRepository {
  list(): Promise<StylePreset[]>;
  get(id: string, version?: number): Promise<StylePreset | undefined>;
  save(style: StylePreset): Promise<void>;
}

export interface StorageAdapter {
  listProjects(): Promise<PresentationProject[]>;
  loadProject(id: string): Promise<PresentationProject | undefined>;
  saveProject(project: PresentationProject): Promise<void>;
  saveAsset(projectId: string, relativePath: string, bytes: Uint8Array): Promise<string>;
}

export interface Exporter {
  readonly id: string;
  readonly mediaType: string;
  export(project: PresentationProject): Promise<Uint8Array>;
}

export class ProviderRegistry<T extends { readonly id: string }> {
  readonly #providers = new Map<string, T>();

  register(provider: T): this {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
    return this;
  }

  get(id: string): T {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  list(): T[] {
    return [...this.#providers.values()];
  }
}

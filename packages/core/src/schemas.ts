import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const contentModeSchema = z.enum(["creative", "grounded"]);
export const webSearchModeSchema = z.enum(["cached", "live", "disabled"]);
export const sourceUsageSchema = z.enum([
  "content",
  "visual-reference",
  "style-reference",
  "direct-asset",
  "exclude-from-generation",
]);

export const presentationBriefSchema = z.object({
  topic: z.string().trim().min(1),
  audience: z.string().trim().default("一般觀眾"),
  purpose: z.string().trim().default("清楚傳達主題"),
  language: z.string().trim().default("zh-TW"),
  desiredSlideCount: z.number().int().min(1).max(100).default(5),
  durationMinutes: z.number().positive().optional(),
  tone: z.string().trim().default("清晰、現代"),
  contentMode: contentModeSchema.default("creative"),
  webSearchMode: webSearchModeSchema.default("cached"),
});

export const sourceCitationSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  locator: z.string().optional(),
  url: z.string().url().optional(),
  excerpt: z.string().optional(),
  capturedAt: z.string().datetime(),
});

export const sourceAssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  usage: sourceUsageSchema,
  allowModelAccess: z.boolean(),
  status: z.enum(["pending", "parsing", "indexed", "failed"]),
  assetPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  extractedText: z.string().default(""),
  chunks: z.array(z.object({
    id: z.string().min(1),
    text: z.string(),
    locator: z.string().optional(),
  })).default([]),
  metadata: z.record(z.string()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export const styleReferenceImageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.enum(["image/png", "image/jpeg"]),
  assetPath: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const stylePresetSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().default(""),
  system: z.boolean().default(false),
  density: z.enum(["low", "medium", "high"]).default("high"),
  imageDirection: z.string().default(""),
  avoid: z.array(z.string()).default([]),
  promptTemplate: z.string().default(""),
  referenceImages: z.array(styleReferenceImageSchema).max(4).default([]),
  coverImageId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const slideOutlineSnapshotSchema = z.object({
  purpose: z.string().min(1),
  content: z.string().min(1),
  narrative: z.string().default(""),
  layoutHint: z.string().default(""),
  imagePrompt: z.string().min(1),
  sourceIds: z.array(z.string()).default([]),
});

export const editableTextBoxSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  fontFamily: z.string().min(1).default("Arial"),
  fontSize: z.number().positive(),
  fontWeight: z.number().int().min(100).max(900).default(400),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  opacity: z.number().min(0).max(1).default(1),
  lineHeight: z.number().positive().default(1.2),
  letterSpacing: z.number().default(0),
  align: z.enum(["left", "center", "right"]).default("left"),
  verticalAlign: z.enum(["top", "middle", "bottom"]).default("top"),
  rotation: z.number().min(-180).max(180).default(0),
  confidence: z.number().min(0).max(1),
  role: z.enum(["presentation", "logo", "incidental"]).default("presentation"),
});

export const editableTextLayerSchema = z.object({
  originalVersionId: z.string().min(1),
  backgroundPath: z.string().min(1),
  compositePath: z.string().min(1),
  threshold: z.number().min(0.5).max(0.95).default(0.75),
  renderRevision: z.number().int().nonnegative().default(0),
  boxes: z.array(editableTextBoxSchema).max(500),
  extractedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const slideVersionSchema = z.object({
  id: z.string().min(1),
  imagePath: z.string().min(1),
  prompt: z.string(),
  providerId: z.string().min(1),
  model: z.string().min(1),
  parameters: z.record(z.unknown()),
  styleVersion: z.number().int().positive(),
  sources: z.array(sourceCitationSchema),
  outlineSnapshot: slideOutlineSnapshotSchema.optional(),
  createdAt: z.string().datetime(),
  label: z.string().optional(),
  textLayer: editableTextLayerSchema.optional(),
});

export const slideSpecSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  purpose: z.string().min(1),
  content: z.string().min(1),
  narrative: z.string().default(""),
  layoutHint: z.string().default(""),
  dataBasis: z.array(z.string()).default([]),
  imagePrompt: z.string().min(1),
  styleOverride: stylePresetSchema.partial().optional(),
  sourceIds: z.array(z.string()).default([]),
  outlineDirty: z.boolean().default(false),
  versions: z.array(slideVersionSchema).default([]),
  currentVersionId: z.string().optional(),
});

export const generationJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  slideId: z.string().min(1),
  providerId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  lifecycleVersion: z.literal(1).optional(),
  phase: z.enum(["queued", "preparing", "launching", "waiting_for_codex", "validating_output", "persisting", "completed", "failed", "cancelled"]).optional(),
  progress: z.object({ step: z.number().int().min(0), total: z.number().int().positive() }).optional(),
  providerEventCode: z.enum(["turn_started", "item_completed", "turn_completed"]).optional(),
  childLifecycle: z.object({
    spawnedAt: z.string().datetime().optional(),
    lastAllowedEventAt: z.string().datetime().optional(),
    cancelRequestedAt: z.string().datetime().optional(),
    shutdownRequestedAt: z.string().datetime().optional(),
    recoveredAt: z.string().datetime().optional(),
    exitedAt: z.string().datetime().optional(),
    exitClass: z.enum(["success", "nonzero", "timeout", "aborted", "server_shutdown"]).optional(),
  }).optional(),
  timeoutMs: z.number().int().positive().optional(),
  attempt: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  phaseUpdatedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/).optional(),
  error: z.string().optional(),
  resultVersionId: z.string().optional(),
  operation: z.enum(["generate", "edit", "extract-text"]).default("generate"),
  editInstruction: z.string().optional(),
  baseVersionId: z.string().optional(),
  maskPath: z.string().optional(),
  textExtraction: z.object({
    originalVersionId: z.string().min(1),
    replaceVersionId: z.string().min(1).optional(),
    threshold: z.number().min(0.5).max(0.95),
    boxes: z.array(editableTextBoxSchema).max(500),
  }).optional(),
});

export const presentationProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  workflowStage: z.enum(["requirements", "settings", "editing"]).default("requirements"),
  outlineRationale: z.string().optional(),
  brief: presentationBriefSchema,
  canvas: z.object({
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
  }),
  styleSnapshot: stylePresetSchema,
  slides: z.array(slideSpecSchema),
  sources: z.array(sourceAssetSchema),
  jobs: z.array(generationJobSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createSourceInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(120),
  usage: sourceUsageSchema.optional(),
  allowModelAccess: z.boolean().default(true),
});

export const stylePresetInputSchema = stylePresetSchema.omit({
  schemaVersion: true,
  id: true,
  version: true,
  system: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  description: true,
  density: true,
  imageDirection: true,
  avoid: true,
  promptTemplate: true,
  referenceImages: true,
  coverImageId: true,
}).extend({ name: z.string().trim().min(1).max(120) });

export type PresentationBrief = z.infer<typeof presentationBriefSchema>;
export type StylePreset = z.infer<typeof stylePresetSchema>;
export type StyleReferenceImage = z.infer<typeof styleReferenceImageSchema>;
export type SlideSpec = z.infer<typeof slideSpecSchema>;
export type SlideOutlineSnapshot = z.infer<typeof slideOutlineSnapshotSchema>;
export type SlideVersion = z.infer<typeof slideVersionSchema>;
export type EditableTextBox = z.infer<typeof editableTextBoxSchema>;
export type EditableTextLayer = z.infer<typeof editableTextLayerSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type PresentationProject = z.infer<typeof presentationProjectSchema>;
export type SourceAsset = z.infer<typeof sourceAssetSchema>;
export type SourceCitation = z.infer<typeof sourceCitationSchema>;

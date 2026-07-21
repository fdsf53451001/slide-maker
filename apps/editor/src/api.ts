import type {
  EditableTextBox,
  GenerationJob,
  ModelCombination,
  ModelConnection,
  ModelEntry,
  ModelLibrary,
  ModelLibrarySystem,
  PresentationBrief,
  PresentationProject,
  SlideSpec,
  SourceAsset,
  StylePreset,
  StyleReferenceImage,
} from "@slide-maker/core";

export interface ProviderSummary {
  id: string;
  name: string;
  availability:
    { status: "available"; warning?: string } | { status: "unavailable"; reason: string };
  capabilities: {
    fullSlideGeneration: boolean;
    imageEditing?: boolean;
    maskedEditing?: boolean;
    referenceImages?: boolean;
    multipleReferenceImages?: boolean;
  };
  timeoutMs?: number;
}

export interface ProviderReadiness {
  providerId: string;
  status:
    | "ready"
    | "ready_experimental"
    | "disabled"
    | "cli_missing"
    | "incompatible"
    | "auth_required"
    | "timeout"
    | "artifact_unsupported"
    | "unknown";
  blocking: boolean;
  requiresAcknowledgement: boolean;
  message: string;
  checkedAt: string;
  expiresAt: string;
}

export interface WebSearchResult {
  url: string;
  title: string;
  summary: string;
}

export interface TextProviderSummary {
  id: string;
  name: string;
  availability:
    { status: "available"; warning?: string } | { status: "unavailable"; reason: string };
  isDefault: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json()) as T | { error?: string };
  if (!response.ok)
    throw new Error(
      "error" in (body as object)
        ? ((body as { error?: string }).error ?? response.statusText)
        : response.statusText,
    );
  return body as T;
}

export const api = {
  listProjects: () => request<PresentationProject[]>("/api/projects"),
  getProject: (id: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (topic: string, styleId?: string) =>
    request<PresentationProject>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ topic, styleId }),
    }),
  updateBrief: (projectId: string, patch: Partial<PresentationBrief>) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/brief`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  updateProjectName: (projectId: string, name: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteProject: (projectId: string) =>
    request<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
  textProviders: () => request<TextProviderSummary[]>("/api/text-providers"),
  regenerateOutline: (projectId: string, replace = false, textEngine?: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/outline`, {
      method: "POST",
      body: JSON.stringify({ replace, ...(textEngine ? { textEngine } : {}) }),
    }),
  styles: () => request<StylePreset[]>("/api/styles"),
  getStyle: (styleId: string) => request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}`),
  styleVersions: (styleId: string) =>
    request<StylePreset[]>(`/api/styles/${encodeURIComponent(styleId)}/versions`),
  createStyle: (input: Partial<StylePreset> & { name: string }) =>
    request<StylePreset>("/api/styles", { method: "POST", body: JSON.stringify(input) }),
  updateStyle: (styleId: string, input: Partial<StylePreset>) =>
    request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  duplicateStyle: (styleId: string) =>
    request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}/duplicate`, {
      method: "POST",
    }),
  restoreStyle: (styleId: string, version: number) =>
    request<StylePreset>(`/api/styles/${encodeURIComponent(styleId)}/versions/${version}/restore`, {
      method: "POST",
    }),
  applyStyle: (projectId: string, styleId: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/style`, {
      method: "POST",
      body: JSON.stringify({ styleId }),
    }),
  providers: () => request<ProviderSummary[]>("/api/providers"),
  readiness: (providerId: string) =>
    request<ProviderReadiness>(`/api/providers/${encodeURIComponent(providerId)}/readiness`),
  updateSlide: (
    projectId: string,
    slideId: string,
    patch: Pick<
      SlideSpec,
      "purpose" | "content" | "narrative" | "layoutHint" | "imagePrompt" | "sourceIds"
    >,
  ) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    ),
  // providerId 省略時，server 依專案組合（或預設組合）解析影像模型。
  generate: (
    projectId: string,
    slideId: string,
    providerId: string | undefined,
    acceptUnknownReadiness = false,
  ) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/generate`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(providerId ? { providerId } : {}),
          acceptUnknownReadiness,
        }),
      },
    ),
  generateAll: (
    projectId: string,
    providerId: string | undefined,
    acceptUnknownReadiness = false,
  ) =>
    request<GenerationJob[]>(`/api/projects/${encodeURIComponent(projectId)}/generate`, {
      method: "POST",
      body: JSON.stringify({
        ...(providerId ? { providerId } : {}),
        acceptUnknownReadiness,
      }),
    }),
  editSlideImage: (
    projectId: string,
    slideId: string,
    providerId: string,
    instruction: string,
    maskDataUrl?: string,
    acceptUnknownReadiness = false,
  ) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/edit-image`,
      {
        method: "POST",
        body: JSON.stringify({
          providerId,
          instruction,
          ...(maskDataUrl ? { maskDataUrl } : {}),
          acceptUnknownReadiness,
        }),
      },
    ),
  ocrStatus: () => request<{ available: boolean; message: string }>("/api/ocr/status"),
  extractText: (
    projectId: string,
    slideId: string,
    providerId: string,
    threshold = 0.75,
    acceptUnknownReadiness = false,
  ) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/extract-text`,
      { method: "POST", body: JSON.stringify({ providerId, threshold, acceptUnknownReadiness }) },
    ),
  updateTextLayer: (
    projectId: string,
    slideId: string,
    versionId: string,
    boxes: EditableTextBox[],
    threshold?: number,
  ) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/text-layer`,
      {
        method: "PUT",
        body: JSON.stringify({ boxes, ...(threshold === undefined ? {} : { threshold }) }),
      },
    ),
  addSlide: (
    projectId: string,
    input?: Partial<
      Pick<
        SlideSpec,
        "purpose" | "content" | "narrative" | "layoutHint" | "imagePrompt" | "sourceIds"
      >
    > & { afterSlideId?: string },
  ) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/slides`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  addAiSlide: (projectId: string, purpose: string, afterSlideId?: string, textEngine?: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/slides/ai`, {
      method: "POST",
      body: JSON.stringify({ purpose, afterSlideId, ...(textEngine ? { textEngine } : {}) }),
    }),
  regenerateSlideOutline: (projectId: string, slideId: string, textEngine?: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/outline`,
      { method: "POST", body: JSON.stringify(textEngine ? { textEngine } : {}) },
    ),
  duplicateSlide: (projectId: string, slideId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/duplicate`,
      { method: "POST" },
    ),
  deleteSlide: (projectId: string, slideId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}`,
      { method: "DELETE" },
    ),
  reorderSlides: (projectId: string, slideIds: string[]) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/slides/reorder`, {
      method: "POST",
      body: JSON.stringify({ slideIds }),
    }),
  updateSource: (
    projectId: string,
    sourceId: string,
    patch: Partial<Pick<SourceAsset, "name" | "usage" | "allowModelAccess">>,
  ) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),
  deleteSource: (projectId: string, sourceId: string, force = false) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}?force=${force}`,
      { method: "DELETE" },
    ),
  uploadSource: async (projectId: string, file: File): Promise<PresentationProject> => {
    const query = new URLSearchParams({
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      allowModelAccess: "true",
    });
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/sources?${query}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    );
    const body = (await response.json()) as PresentationProject | { error?: string };
    if (!response.ok)
      throw new Error("error" in body ? (body.error ?? response.statusText) : response.statusText);
    return body as PresentationProject;
  },
  searchWebSources: (projectId: string, query: string, limit = 8, textEngine?: string) =>
    request<WebSearchResult[]>(`/api/projects/${encodeURIComponent(projectId)}/web-search`, {
      method: "POST",
      body: JSON.stringify({ query, limit, ...(textEngine ? { textEngine } : {}) }),
    }),
  addWebSources: (projectId: string, sources: WebSearchResult[]) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/web-sources`, {
      method: "POST",
      body: JSON.stringify({ sources }),
    }),
  uploadStyleReference: async (file: File): Promise<StyleReferenceImage> => {
    const mediaType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const query = new URLSearchParams({ name: file.name, mediaType });
    const response = await fetch(`/api/style-assets?${query}`, {
      method: "POST",
      headers: { "Content-Type": mediaType },
      body: file,
    });
    const body = (await response.json()) as StyleReferenceImage | { error?: string };
    if (!response.ok)
      throw new Error("error" in body ? (body.error ?? response.statusText) : response.statusText);
    return body as StyleReferenceImage;
  },
  renderPdfPages: async (
    file: File,
  ): Promise<{ pages: string[]; totalPages: number; truncated: boolean }> => {
    const response = await fetch("/api/pdf-pages", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    const body = (await response.json()) as
      { pages: string[]; totalPages: number; truncated: boolean } | { error?: string };
    if (!response.ok)
      throw new Error("error" in body ? (body.error ?? response.statusText) : response.statusText);
    return body as { pages: string[]; totalPages: number; truncated: boolean };
  },
  versionToStyleReference: (projectId: string, slideId: string, versionId: string) =>
    request<StyleReferenceImage>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/style-reference`,
      { method: "POST" },
    ),
  analyzeStyle: (referenceIds: string[], combinationId?: string) =>
    request<{ designSystem: string; avoid: string[] }>("/api/style-analysis", {
      method: "POST",
      body: JSON.stringify({ referenceIds, ...(combinationId ? { combinationId } : {}) }),
    }),
  cancel: (projectId: string, jobId: string) =>
    request<GenerationJob>(
      `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    ),
  restore: (projectId: string, slideId: string, versionId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: "POST" },
    ),
  activateVersion: (projectId: string, slideId: string, versionId: string) =>
    request<PresentationProject>(
      `/api/projects/${encodeURIComponent(projectId)}/slides/${encodeURIComponent(slideId)}/versions/${encodeURIComponent(versionId)}/activate`,
      { method: "POST" },
    ),
  setProjectCombination: (projectId: string, combinationId: string) =>
    request<PresentationProject>(`/api/projects/${encodeURIComponent(projectId)}/combination`, {
      method: "PATCH",
      body: JSON.stringify({ combinationId }),
    }),
  // ── 模型庫 ──────────────────────────────────────────────────────────────
  modelLibrary: () => request<ModelLibrary>("/api/model-library"),
  connectionModels: (connectionId: string) =>
    request<{ models: string[] }>(
      `/api/model-library/connections/${encodeURIComponent(connectionId)}/models`,
    ),
  createConnection: (input: Omit<ModelConnection, "id">) =>
    request<ModelLibrary>("/api/model-library/connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateConnection: (id: string, patch: Partial<Omit<ModelConnection, "id">>) =>
    request<ModelLibrary>(`/api/model-library/connections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteConnection: (id: string) =>
    request<ModelLibrary>(`/api/model-library/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  createModel: (input: Omit<ModelEntry, "id">) =>
    request<ModelLibrary>("/api/model-library/models", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateModel: (id: string, patch: Partial<Omit<ModelEntry, "id">>) =>
    request<ModelLibrary>(`/api/model-library/models/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteModel: (id: string) =>
    request<ModelLibrary>(`/api/model-library/models/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  createCombination: (input: Omit<ModelCombination, "id">) =>
    request<ModelLibrary>("/api/model-library/combinations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateCombination: (id: string, patch: Partial<Omit<ModelCombination, "id">>) =>
    request<ModelLibrary>(`/api/model-library/combinations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteCombination: (id: string) =>
    request<ModelLibrary>(`/api/model-library/combinations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  setDefaultCombination: (combinationId: string) =>
    request<ModelLibrary>("/api/model-library/default-combination", {
      method: "PUT",
      body: JSON.stringify({ combinationId }),
    }),
  updateModelLibrarySystem: (patch: Partial<ModelLibrarySystem>) =>
    request<ModelLibrary>("/api/model-library/system", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

export const styleAssetUrl = (id: string) => `/api/style-assets/${encodeURIComponent(id)}`;

export function projectAssetUrl(projectId: string, assetPath: string): string {
  const path = assetPath.startsWith("assets/") ? assetPath.slice("assets/".length) : assetPath;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const cacheKey = path.split("/").at(-1) ?? path;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/${encodedPath}?v=${encodeURIComponent(cacheKey)}`;
}

export const imageUrl = projectAssetUrl;

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { SlideMakerApiError, SlideMakerClient } from "./client.js";

interface Job {
  id: string;
  slideId: string;
  providerId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase?: string;
  progress?: { step: number; total: number };
  errorCode?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface Project {
  id: string;
  name: string;
  workflowStage: string;
  brief: {
    topic: string;
    audience: string;
    purpose: string;
    language: string;
    desiredSlideCount: number;
    tone: string;
  };
  slides: Array<{
    id: string;
    order: number;
    title: string;
    content: string;
    narrative: string;
    hidden: boolean;
    currentVersionId?: string;
    versions: unknown[];
  }>;
  styleSnapshot: StylePreset;
  sources: Source[];
  jobs: Job[];
  createdAt: string;
  updatedAt: string;
}

interface StylePreset {
  id: string;
  version: number;
  name: string;
  description: string;
  system: boolean;
  density: "low" | "medium" | "high";
  referenceImages: unknown[];
  updatedAt: string;
}

interface Source {
  id: string;
  name: string;
  mediaType: string;
  usage:
    | "content"
    | "outline-reference"
    | "visual-reference"
    | "style-reference"
    | "direct-asset"
    | "exclude-from-generation";
  allowModelAccess: boolean;
  status: "pending" | "parsing" | "indexed" | "failed";
  sizeBytes: number;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
  error?: string;
}

interface OutlineTask {
  projectId: string;
  status: "running" | "completed" | "failed" | "unknown";
  startedAt: string;
  finishedAt?: string;
  slideCount?: number;
  error?: { code: string; message: string; status?: number };
}

const exportFormat = z.enum(["pptx", "pdf", "png.zip", "slide-project", "outline.md"]);
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const sourceUsageSchema = z.enum([
  "content",
  "outline-reference",
  "visual-reference",
  "style-reference",
  "direct-asset",
  "exclude-from-generation",
]);
const pathId = (id: string) => encodeURIComponent(id);

function styleSummary(style: StylePreset) {
  return {
    id: style.id,
    version: style.version,
    name: style.name,
    description: style.description,
    system: style.system,
    density: style.density,
    referenceImageCount: style.referenceImages.length,
    updatedAt: style.updatedAt,
  };
}

function sourceSummary(source: Source) {
  return {
    id: source.id,
    name: source.name,
    mediaType: source.mediaType,
    usage: source.usage,
    allowModelAccess: source.allowModelAccess,
    status: source.status,
    sizeBytes: source.sizeBytes,
    ...(source.metadata?.url ? { url: source.metadata.url } : {}),
    ...(source.error ? { error: source.error } : {}),
    createdAt: source.createdAt,
    ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
  };
}

function projectSummary(project: Project) {
  return {
    id: project.id,
    name: project.name,
    topic: project.brief.topic,
    workflowStage: project.workflowStage,
    slideCount: project.slides.length,
    generatedSlideCount: project.slides.filter((slide) => slide.currentVersionId).length,
    sourceCount: project.sources.length,
    style: {
      id: project.styleSnapshot.id,
      version: project.styleSnapshot.version,
      name: project.styleSnapshot.name,
    },
    activeJobCount: project.jobs.filter(
      (job) => job.status === "queued" || job.status === "running",
    ).length,
    updatedAt: project.updatedAt,
  };
}

function projectDetail(project: Project) {
  return {
    ...projectSummary(project),
    brief: project.brief,
    slides: project.slides
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((slide) => ({
        id: slide.id,
        order: slide.order,
        title: slide.title,
        content: slide.content,
        narrative: slide.narrative,
        hidden: slide.hidden,
        generated: Boolean(slide.currentVersionId),
        versionCount: slide.versions.length,
      })),
    sources: project.sources.map(sourceSummary),
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    // MCP structuredContent 的根節點必須是 object；陣列與純量統一放在 result。
    structuredContent: { result: value },
  };
}

function toolError(error: unknown) {
  if (error instanceof SlideMakerApiError)
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: error.status,
            error: error.code,
            message: error.message,
            ...(error.failures ? { failures: error.failures } : {}),
          }),
        },
      ],
    };
  const message = error instanceof Error ? error.message : "未知錯誤";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function safely<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    return toolError(error);
  }
}

export function createServer(client: SlideMakerClient): McpServer {
  const outlineTasks = new Map<string, OutlineTask>();
  const outlineBaselines = new Map<string, string>();
  const server = new McpServer(
    { name: "slide-maker", version: "0.1.0" },
    {
      instructions:
        "先用 list_projects 或 create_project 取得 projectId。模型使用 Slide Maker 的預設組合；可在產生大綱前套用風格並加入素材。generate_outline 會立即回傳任務狀態，請用 get_outline_status 等待完成，然後用 get_project 讀取大綱。生成圖片也非同步，請用 get_generation_status 追蹤。匯出前確認所有需要的頁面均已完成。",
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "列出簡報專案",
      description: "列出 Slide Maker 中的專案及生成進度摘要。",
      inputSchema: z.object({}),
    },
    () =>
      safely(async () =>
        textResult((await client.get<Project[]>("/api/projects")).map(projectSummary)),
      ),
  );

  server.registerTool(
    "create_project",
    {
      title: "建立簡報專案",
      description: "依主題和簡報需求建立一個新的 Slide Maker 專案。",
      inputSchema: z.object({
        topic: z.string().trim().min(1).max(500).describe("簡報主題"),
        name: z.string().trim().min(1).max(200).optional().describe("專案名稱"),
        audience: z.string().trim().optional().describe("目標觀眾"),
        purpose: z.string().trim().optional().describe("簡報目的"),
        language: z.string().trim().optional().describe("語言，例如 zh-TW"),
        desiredSlideCount: z.number().int().min(1).max(100).optional().describe("期望頁數"),
        tone: z.string().trim().optional().describe("語氣與調性"),
        contentMode: z.enum(["creative", "grounded"]).optional(),
        webSearchMode: z.enum(["cached", "live", "disabled"]).optional(),
      }),
    },
    (input) =>
      safely(async () => {
        const { topic, name, ...brief } = input;
        const project = await client.post<Project>("/api/projects", {
          topic,
          ...(name ? { name } : {}),
          ...(Object.keys(brief).length ? { brief } : {}),
        });
        return textResult(projectSummary(project));
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "讀取簡報專案",
      description: "讀取專案需求、逐頁大綱、來源與目前生成狀態。",
      inputSchema: z.object({ projectId: idSchema }),
    },
    ({ projectId }) =>
      safely(async () =>
        textResult(projectDetail(await client.get<Project>(`/api/projects/${pathId(projectId)}`))),
      ),
  );

  server.registerTool(
    "list_styles",
    {
      title: "列出風格庫",
      description: "列出 Slide Maker 風格庫中可套用的風格與版本摘要。",
      inputSchema: z.object({}),
    },
    () =>
      safely(async () =>
        textResult((await client.get<StylePreset[]>("/api/styles")).map(styleSummary)),
      ),
  );

  server.registerTool(
    "apply_style",
    {
      title: "套用風格",
      description: "將風格庫中的指定風格版本套用到簡報專案。未指定版本時使用最新版。",
      inputSchema: z.object({
        projectId: idSchema,
        styleId: idSchema,
        version: z.number().int().positive().optional(),
      }),
    },
    ({ projectId, styleId, version }) =>
      safely(async () => {
        const project = await client.post<Project>(`/api/projects/${pathId(projectId)}/style`, {
          styleId,
          ...(version === undefined ? {} : { version }),
        });
        return textResult(projectSummary(project));
      }),
  );

  server.registerTool(
    "list_sources",
    {
      title: "列出素材庫",
      description: "列出專案的來源素材、用途、AI 讀取授權與處理狀態。",
      inputSchema: z.object({ projectId: idSchema }),
    },
    ({ projectId }) =>
      safely(async () =>
        textResult(
          (await client.get<Source[]>(`/api/projects/${pathId(projectId)}/sources`)).map(
            sourceSummary,
          ),
        ),
      ),
  );

  server.registerTool(
    "upload_source",
    {
      title: "上傳本機素材",
      description:
        "從 SLIDE_MAKER_MCP_SOURCE_ROOT 指定的素材目錄上傳單一檔案。視覺參考圖若允許 AI 讀取，可能在背景呼叫預設文字模型並消耗配額。",
      inputSchema: z.object({
        projectId: idSchema,
        fileName: z.string().trim().min(1).max(255).describe("素材目錄內的單一檔名"),
        mediaType: z.string().trim().min(1).max(120),
        usage: sourceUsageSchema.default("content"),
        allowModelAccess: z.boolean().default(true),
      }),
    },
    ({ projectId, fileName, mediaType, usage, allowModelAccess }) =>
      safely(async () => {
        const query = new URLSearchParams({
          name: fileName,
          mediaType,
          usage,
          allowModelAccess: String(allowModelAccess),
        });
        const { response: project, bytes } = await client.uploadSource<Project>(
          `/api/projects/${pathId(projectId)}/sources?${query.toString()}`,
          fileName,
          mediaType,
        );
        // 上傳端點固定把新來源 append 到尾端；由後往前找可避開同名、同毫秒的舊來源。
        const uploaded = project.sources
          .slice()
          .reverse()
          .find((source) => source.name === fileName);
        return textResult({
          project: projectSummary(project),
          bytes,
          ...(uploaded ? { source: sourceSummary(uploaded) } : {}),
        });
      }),
  );

  server.registerTool(
    "add_url_sources",
    {
      title: "加入網址素材",
      description: "擷取一到十個公開網址的正文，加入專案素材庫，並逐筆回報失敗原因。",
      inputSchema: z.object({
        projectId: idSchema,
        urls: z.array(z.url()).min(1).max(10),
      }),
    },
    ({ projectId, urls }) =>
      safely(async () => {
        const result = await client.post<{ project: Project; failures: unknown[] }>(
          `/api/projects/${pathId(projectId)}/url-sources`,
          { urls },
        );
        return textResult({ project: projectSummary(result.project), failures: result.failures });
      }),
  );

  server.registerTool(
    "update_source",
    {
      title: "更新素材設定",
      description:
        "更新專案素材的名稱、用途或 AI 讀取授權。describeImage=true 會為符合條件的視覺參考圖呼叫預設文字模型補做內容描述並消耗配額。",
      inputSchema: z
        .object({
          projectId: idSchema,
          sourceId: idSchema,
          name: z.string().trim().min(1).max(255).optional(),
          usage: sourceUsageSchema.optional(),
          allowModelAccess: z.boolean().optional(),
          describeImage: z.boolean().default(false),
        })
        .refine(
          ({ name, usage, allowModelAccess, describeImage }) =>
            name !== undefined ||
            usage !== undefined ||
            allowModelAccess !== undefined ||
            describeImage,
          { message: "至少提供一個要更新的欄位" },
        ),
    },
    ({ projectId, sourceId, name, usage, allowModelAccess, describeImage }) =>
      safely(async () => {
        const project = await client.patch<Project>(
          `/api/projects/${pathId(projectId)}/sources/${pathId(sourceId)}`,
          {
            ...(name === undefined ? {} : { name }),
            ...(usage === undefined ? {} : { usage }),
            ...(allowModelAccess === undefined ? {} : { allowModelAccess }),
            ...(describeImage ? { describeImage: true } : {}),
          },
        );
        const source = project.sources.find((item) => item.id === sourceId);
        return textResult({
          project: projectSummary(project),
          ...(source ? { source: sourceSummary(source) } : {}),
        });
      }),
  );

  server.registerTool(
    "generate_outline",
    {
      title: "產生簡報大綱",
      description:
        "開始在背景產生整份大綱，立即回傳狀態；請用 get_outline_status 查詢。相同專案執行中或結果尚無法確認時不會重複送出。replace=true 會覆蓋現有大綱；已有生成圖片時仍可能被伺服器拒絕。",
      inputSchema: z.object({
        projectId: idSchema,
        replace: z.boolean().default(false),
      }),
    },
    ({ projectId, replace }) =>
      safely(async () => {
        const existing = outlineTasks.get(projectId);
        if (existing?.status === "running" || existing?.status === "unknown")
          return textResult(existing);
        // 先確認專案存在，避免為無效 id 建立一個永遠失敗的背景任務。
        const project = await client.get<Project>(`/api/projects/${pathId(projectId)}`);
        const concurrent = outlineTasks.get(projectId);
        if (concurrent?.status === "running" || concurrent?.status === "unknown")
          return textResult(concurrent);
        const task: OutlineTask = {
          projectId,
          status: "running",
          startedAt: new Date().toISOString(),
        };
        outlineTasks.set(projectId, task);
        outlineBaselines.set(projectId, JSON.stringify(project.slides.map((slide) => slide.id)));
        void client
          .postOutline<Project>(`/api/projects/${pathId(projectId)}/outline`, { replace })
          .then((project) => {
            task.status = "completed";
            task.slideCount = project.slides.length;
            task.finishedAt = new Date().toISOString();
          })
          .catch((error: unknown) => {
            task.status =
              error instanceof SlideMakerApiError
                ? error.code === "MCP_REQUEST_TIMEOUT" || error.status === 504
                  ? "unknown"
                  : "failed"
                : "unknown";
            task.finishedAt = new Date().toISOString();
            task.error =
              error instanceof SlideMakerApiError
                ? { code: error.code, message: error.message, status: error.status }
                : error instanceof Error && error.name === "TimeoutError"
                  ? { code: "MCP_REQUEST_TIMEOUT", message: "大綱請求等待逾時。" }
                  : { code: "MCP_REQUEST_FAILED", message: "大綱請求失敗，請檢查伺服器紀錄。" };
          });
        return textResult(task);
      }),
  );

  server.registerTool(
    "get_outline_status",
    {
      title: "查詢大綱進度",
      description: "查詢目前 MCP 程序送出的大綱任務；完成後使用 get_project 讀取內容。",
      inputSchema: z.object({ projectId: idSchema }),
    },
    ({ projectId }) =>
      safely(async () => {
        const task = outlineTasks.get(projectId);
        if (task) {
          if (task.status === "unknown") {
            try {
              const project = await client.get<Project>(`/api/projects/${pathId(projectId)}`);
              const currentIds = JSON.stringify(project.slides.map((slide) => slide.id));
              if (project.slides.length > 0 && currentIds !== outlineBaselines.get(projectId)) {
                task.status = "completed";
                task.slideCount = project.slides.length;
                delete task.error;
              }
            } catch {
              // 保留原始失敗原因；查詢專案暫時失敗不能覆蓋它。
            }
          }
          return textResult(task);
        }
        const project = await client.get<Project>(`/api/projects/${pathId(projectId)}`);
        return textResult({
          projectId,
          status: "unknown",
          hasOutline: project.slides.length > 0,
          slideCount: project.slides.length,
          message:
            "MCP 程序沒有這次大綱任務的紀錄；現有投影片可能屬於先前版本，請用 get_project 確認內容。",
          project: projectSummary(project),
        });
      }),
  );

  server.registerTool(
    "generate_deck",
    {
      title: "生成簡報圖片",
      description: "將整份大綱或指定頁面加入非同步生成佇列，回傳 job 清單。",
      inputSchema: z.object({
        projectId: idSchema,
        slideIds: z.array(idSchema).min(1).optional(),
        acceptUnknownReadiness: z.boolean().default(false),
      }),
    },
    ({ projectId, ...options }) =>
      safely(async () => {
        const jobs = await client.post<Job[]>(
          `/api/projects/${pathId(projectId)}/generate`,
          options,
        );
        return textResult({ projectId, jobs });
      }),
  );

  server.registerTool(
    "get_generation_status",
    {
      title: "查詢生成進度",
      description: "取得專案內生成工作的狀態、階段、進度與錯誤碼。",
      inputSchema: z.object({
        projectId: idSchema,
        jobIds: z.array(idSchema).optional(),
      }),
    },
    ({ projectId, jobIds }) =>
      safely(async () => {
        const project = await client.get<Project>(`/api/projects/${pathId(projectId)}`);
        const selected = jobIds
          ? project.jobs.filter((job) => jobIds.includes(job.id))
          : project.jobs;
        const jobs = selected.map((job) => ({
          id: job.id,
          slideId: job.slideId,
          providerId: job.providerId,
          status: job.status,
          ...(job.phase ? { phase: job.phase } : {}),
          ...(job.progress ? { progress: job.progress } : {}),
          ...(job.errorCode ? { errorCode: job.errorCode } : {}),
          ...(job.error ? { error: job.error } : {}),
          updatedAt: job.updatedAt,
        }));
        return textResult({ projectId, jobs });
      }),
  );

  server.registerTool(
    "export_presentation",
    {
      title: "匯出簡報",
      description: "將簡報匯出為指定格式，並寫入本機檔案。",
      inputSchema: z.object({
        projectId: idSchema,
        format: exportFormat,
        outputPath: z.string().min(1).describe("匯出目錄內的單一檔名"),
      }),
    },
    ({ projectId, format, outputPath }) =>
      safely(async () =>
        textResult(
          await client.exportToFile(
            `/api/projects/${pathId(projectId)}/export/${encodeURIComponent(format)}`,
            outputPath,
          ),
        ),
      ),
  );

  return server;
}

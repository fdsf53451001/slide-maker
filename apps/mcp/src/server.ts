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
  sources: Array<{ id: string; name: string; mediaType: string; status: string }>;
  jobs: Job[];
  createdAt: string;
  updatedAt: string;
}

const exportFormat = z.enum(["pptx", "pdf", "png.zip", "slide-project", "outline.md"]);
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const pathId = (id: string) => encodeURIComponent(id);

function projectSummary(project: Project) {
  return {
    id: project.id,
    name: project.name,
    topic: project.brief.topic,
    workflowStage: project.workflowStage,
    slideCount: project.slides.length,
    generatedSlideCount: project.slides.filter((slide) => slide.currentVersionId).length,
    sourceCount: project.sources.length,
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
    sources: project.sources,
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
          text: JSON.stringify({ status: error.status, error: error.code, message: error.message }),
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
  const server = new McpServer(
    { name: "slide-maker", version: "0.1.0" },
    {
      instructions:
        "先用 list_projects 或 create_project 取得 projectId。產生大綱後才可生成整份簡報；生成是非同步的，請用 get_generation_status 追蹤。匯出前確認所有需要的頁面均已完成。",
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
    "generate_outline",
    {
      title: "產生簡報大綱",
      description:
        "依專案需求與來源產生整份大綱。replace=true 會覆蓋現有大綱；已有生成圖片時仍可能被伺服器拒絕。",
      inputSchema: z.object({
        projectId: idSchema,
        replace: z.boolean().default(false),
      }),
    },
    ({ projectId, replace }) =>
      safely(async () =>
        textResult(
          projectDetail(
            await client.post<Project>(`/api/projects/${pathId(projectId)}/outline`, { replace }),
          ),
        ),
      ),
  );

  server.registerTool(
    "generate_deck",
    {
      title: "生成簡報圖片",
      description: "將整份大綱或指定頁面加入非同步生成佇列，回傳 job 清單。",
      inputSchema: z.object({
        projectId: idSchema,
        slideIds: z.array(idSchema).min(1).optional(),
        providerId: z.string().min(1).optional(),
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

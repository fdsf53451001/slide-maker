import { randomUUID } from "node:crypto";
import {
  SCHEMA_VERSION,
  presentationBriefSchema,
  presentationProjectSchema,
  stylePresetSchema,
  type PresentationBrief,
  type PresentationProject,
  type SlideSpec,
  type StylePreset,
} from "./schemas.js";

export function createDefaultStyle(now = new Date().toISOString()): StylePreset {
  return stylePresetSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: "ai-free-design",
    version: 1,
    name: "AI 自由設計",
    description: "依主題、觀眾與內容自行決定視覺語言的系統預設風格。",
    system: true,
    density: "high",
    imageDirection:
      "Choose an original, coherent visual direction that best supports the presentation topic and audience.",
    avoid: ["watermarks", "tiny unreadable labels", "visual clutter"],
    promptTemplate:
      "Create a coherent 16:9 presentation slide with strong hierarchy and production-ready spacing.",
    referenceImages: [],
    createdAt: now,
    updatedAt: now,
  });
}

function slide(order: number, purpose: string, content: string, layoutHint: string): SlideSpec {
  return {
    id: randomUUID(),
    order,
    purpose,
    content,
    narrative: content,
    layoutHint,
    dataBasis: [],
    // 視覺方向來自 style；imagePrompt 留空，只在使用者要單頁微調時才填。
    imagePrompt: "",
    sourceIds: [],
    pinnedSourceIds: [],
    outlineDirty: false,
    hidden: false,
    versions: [],
  };
}

/**
 * 主題空白時，專案列表與精靈標題上的替代名稱。
 *
 * `brief.topic` 可以是空字串（主畫面允許不填就開始），但 `project.name` 是 `min(1)` 的——
 * 它是列表卡片上唯一認得出這份專案的字。伺服器的 brief 更新也讀這個常數：使用者稍後把
 * 主題補上時，還叫這個名字的專案要跟著改名。
 */
export const UNTITLED_PROJECT_NAME = "未命名簡報";

export function createSlidesFromBrief(brief: PresentationBrief): SlideSpec[] {
  const count = brief.desiredSlideCount;
  // 主題可以空白（稍後在精靈補填），佔位大綱因此需要一個讀得通的代稱——直接內插空字串會
  // 產出「說明  為何值得…」這種句子，而這些文字會被送進生成大綱的 prompt。
  const topic = brief.topic.trim() || "這份簡報";
  const templates = [
    ["建立期待", topic, "主題置中，單一強烈視覺，留有大量呼吸空間"],
    [
      "建立脈絡",
      `說明 ${topic} 為何值得 ${brief.audience} 現在關注`,
      "以情境畫面和一句核心判斷建立脈絡",
    ],
    ["提出核心觀點", `拆解 ${topic} 的關鍵觀點與影響`, "不對稱編排，以一個主視覺串連重點"],
    ["提供證據", `用可追蹤的事實、案例或數據支持 ${topic}`, "大型數字或證據卡片，來源清楚可辨"],
    ["說明方法", `提出可執行的步驟，協助 ${brief.audience} 採取行動`, "由左至右的清楚流程與里程碑"],
    ["處理疑慮", `回應推動 ${topic} 時最常見的風險與取捨`, "正反對照，讓風險與對策一一對應"],
    ["展示未來", `描繪採取行動後可達成的具體成果`, "具有前進感的願景畫面，成果成為焦點"],
    ["促成下一步", `總結 ${topic} 並提出清楚的行動方向`, "有方向感的收束畫面，行動句成為視覺焦點"],
  ] as const;
  return Array.from({ length: count }, (_, order) => {
    const position = count === 1 ? 7 : Math.round((order * (templates.length - 1)) / (count - 1));
    const [purpose, content, layout] = templates[position]!;
    return slide(order, purpose, content, layout);
  });
}

export function createProject(input: {
  topic: string;
  name?: string;
  brief?: Partial<PresentationBrief>;
  style?: StylePreset;
  now?: string;
}): PresentationProject {
  const now = input.now ?? new Date().toISOString();
  const brief = presentationBriefSchema.parse({ topic: input.topic, ...input.brief });
  const project = {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    name: input.name?.trim() || input.topic.trim() || UNTITLED_PROJECT_NAME,
    workflowStage: "requirements" as const,
    brief,
    canvas: { width: 1920, height: 1080 },
    styleSnapshot: input.style ?? createDefaultStyle(now),
    slides: createSlidesFromBrief(brief),
    sources: [],
    jobs: [],
    createdAt: now,
    updatedAt: now,
  };
  return presentationProjectSchema.parse(project);
}

export function parseProject(value: unknown): PresentationProject {
  const migrated = structuredClone(value) as {
    workflowStage?: unknown;
    styleSnapshot?: Record<string, unknown>;
    slides?: Array<{ versions?: unknown[] }>;
    jobs?: Array<Record<string, unknown>>;
  };
  if (migrated.styleSnapshot) {
    const style = migrated.styleSnapshot;
    if (!["low", "medium", "high"].includes(String(style.density))) {
      style.density =
        style.density === "airy" ? "low" : style.density === "balanced" ? "medium" : "high";
    }
    style.system ??= style.id === "ai-free-design";
    style.referenceImages ??= [];
    delete style.colors;
    delete style.fonts;
    delete style.assetPaths;
    delete style.styleBoardPath;
  }
  if (migrated.workflowStage === undefined) {
    const hasGeneration =
      (migrated.jobs?.length ?? 0) > 0 ||
      migrated.slides?.some((slide) => (slide.versions?.length ?? 0) > 0);
    migrated.workflowStage = hasGeneration ? "editing" : "requirements";
  }
  if (Array.isArray(migrated?.jobs)) {
    for (const job of migrated.jobs) {
      if (job.lifecycleVersion === undefined) job.lifecycleVersion = 1;
      if (job.phase === undefined)
        job.phase = job.status === "running" ? "waiting_for_codex" : job.status;
      if (job.progress === undefined) {
        const terminal = ["completed", "failed", "cancelled"].includes(String(job.status));
        job.progress = { step: terminal ? 6 : job.status === "running" ? 4 : 1, total: 6 };
      }
      if (job.phaseUpdatedAt === undefined) job.phaseUpdatedAt = job.updatedAt;
      if (job.startedAt === undefined && job.status !== "queued") job.startedAt = job.createdAt;
      if (
        job.finishedAt === undefined &&
        ["completed", "failed", "cancelled"].includes(String(job.status))
      )
        job.finishedAt = job.updatedAt;
    }
  }
  return presentationProjectSchema.parse(migrated);
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  createProject,
  sourceAttachesReferenceImage,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageProvider,
  type ImageReferenceRole,
  ProviderRegistry,
  type SourceAsset,
} from "@slide-maker/core";
import { JobRunner, limitReferences } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";

/**
 * provider 宣告的參考圖上限是**第二層防護**：大綱那端的 schema 上限只是「請模型配合」
 * （非嚴格 gateway 不遵守 json_schema），使用者手動指定來源時正常路徑也湊得出超額。
 *
 * 沒有這一層時，超額會在 transport 的最後一刻整個 job 失敗——2026-07-29 線上一份 20 頁
 * 專案就是這樣每一頁都掛在 `GEMINI_IMAGE_REFERENCES_LIMIT`（3 張風格圖 + 12 張內容圖）。
 */

const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/** 檔名帶著使用者的機密字樣：截斷 log 一個字都不該記到它。 */
const SECRET_NAME_MARKER = "機密客戶名單";

class LimitedProvider implements ImageProvider {
  readonly id = "limited-image";
  readonly name = "Limited reference provider";
  readonly availability = { status: "available" as const };
  readonly capabilities = {
    fullSlideGeneration: true as const,
    referenceImages: true,
    imageEditing: true,
    maskedEditing: true,
    multipleReferenceImages: true,
    maxReferenceImages: 4,
    supportedSizes: [{ width: 1920, height: 1080 }],
    reproducibleParameters: [] as string[],
  };

  captured: ImageGenerationRequest | undefined;

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    this.captured = request;
    const bytes = await sharp({
      create: { width: request.width, height: request.height, channels: 4, background: "#101010" },
    })
      .png()
      .toBuffer();
    return {
      bytes: new Uint8Array(bytes),
      mediaType: "image/png",
      extension: "png",
      model: "limited-v1",
      parameters: {},
    };
  }
}

async function waitForTerminalJob(
  repository: FileProjectRepository,
  projectId: string,
  jobId: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const project = await repository.loadProject(projectId);
    const job = project?.jobs.find((candidate) => candidate.id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return { project, job };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state`);
}

const makeSource = (id: string, usage: SourceAsset["usage"], name: string): SourceAsset => ({
  id,
  name,
  mediaType: "image/png",
  usage,
  allowModelAccess: true,
  status: "indexed",
  assetPath: `assets/${id}.png`,
  sizeBytes: TINY_PNG.length,
  extractedText: "",
  chunks: [],
  metadata: {},
  createdAt: "2026-07-29T00:00:00.000Z",
});

async function fixture(provider: ImageProvider) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-reference-limit-"));
  const repository = new FileProjectRepository(root);
  const project = createProject({ topic: "參考圖上限", now: "2026-07-29T00:00:00.000Z" });
  await repository.saveProject(project);
  const providers = new ProviderRegistry<ImageProvider>().register(provider);
  return { root, repository, project, runner: new JobRunner(repository, providers) };
}

const captureWarnings = (): { read: () => Record<string, unknown>[]; restore: () => void } => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return {
    read: () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
    restore: () => spy.mockRestore(),
  };
};

describe("附圖判準只有一份", () => {
  it("jobs.ts 附成參考圖的 usage，與大綱算影像額度的 usage 完全一致", async () => {
    // 兩邊各寫一份條件正是 2026-07-29 那次事故的成因。下一個人新增 usage（例如
    // `logo-asset`）時只改 predicate、忘了改 jobs.ts 的字串陣列，大綱會以為「這不是圖、
    // 不佔 3 張額度」而 jobs.ts 照附——同一個失敗形狀再來一次，而且靜默。
    const provider = new LimitedProvider();
    const { repository, project, runner } = await fixture(provider);
    const usages = [
      "content",
      "visual-reference",
      "style-reference",
      "direct-asset",
    ] as const satisfies readonly SourceAsset["usage"][];
    const sources = usages.map((usage, index) =>
      makeSource(`usage-${index}`, usage, `${usage}.png`),
    );
    for (const source of sources)
      await repository.saveAsset(project.id, `${source.id}.png`, TINY_PNG);
    project.sources.push(...sources);
    project.slides[0]!.sourceIds = sources.map((source) => source.id);
    await repository.saveProject(project);

    const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    const { job } = await waitForTerminalJob(repository, project.id, queued.id);
    expect(job.status).toBe("completed");

    // 真的被附成參考圖的那幾份 ↔ predicate 說會附圖的那幾份，必須逐一相等。
    const attached = new Set(provider.captured?.references.map((reference) => reference.name));
    const predicted = new Set(
      sources
        .filter((source) => sourceAttachesReferenceImage(source.usage))
        .map((source) => source.name),
    );
    expect(attached).toEqual(predicted);
    // 正向對照：predicate 不是恆真也不是恆假，否則上面的相等沒有意義。
    expect(predicted.size).toBe(3);
    expect(attached.has("content.png")).toBe(false);
  });
});

describe("limitReferences", () => {
  const ref = (role: ImageReferenceRole) => ({ role });

  it("沒有宣告上限時原樣放行", () => {
    const references = [ref("style"), ref("content"), ref("content")];
    expect(limitReferences(references, undefined)).toEqual({
      keptIndices: [0, 1, 2],
      droppedIndices: [],
    });
  });

  it("風格參考圖優先於內容參考圖，內容依原順序砍尾", () => {
    // 少一張資料圖只是少一份佐證；少了風格圖整頁會長得不像這份簡報。
    const references = [ref("content"), ref("style"), ref("content"), ref("style")];
    const limited = limitReferences(references, 3);
    expect(limited.keptIndices).toEqual([0, 1, 3]);
    expect(limited.droppedIndices).toEqual([2]);
  });

  it("base 與 mask 一張都不砍，即使它們排在受限額度之外", () => {
    // 砍掉受保護的那兩張會讓 edit.baseImageIndex 指到別的角色——那是無聲的失敗。
    const references = [ref("base"), ref("mask"), ref("style"), ref("content"), ref("content")];
    const limited = limitReferences(references, 3, [0, 1]);
    expect(limited.keptIndices).toEqual([0, 1, 2]);
    expect(limited.droppedIndices).toEqual([3, 4]);
  });

  it("受保護的張數就已經超過上限時，補充參考圖全砍、受保護的仍全留", () => {
    const references = [ref("base"), ref("mask"), ref("content")];
    const limited = limitReferences(references, 1, [0, 1]);
    expect(limited.keptIndices).toEqual([0, 1]);
    expect(limited.droppedIndices).toEqual([2]);
  });
});

describe("生成時依 provider 宣告的上限截斷參考圖", () => {
  it("超過上限時砍掉尾端的內容參考圖，風格參考圖留下，並記下數字與 id", async () => {
    const provider = new LimitedProvider();
    const { repository, project, runner } = await fixture(provider);
    const sources = [
      makeSource("src-content-1", "visual-reference", `${SECRET_NAME_MARKER}-1.png`),
      makeSource("src-content-2", "visual-reference", `${SECRET_NAME_MARKER}-2.png`),
      makeSource("src-style-1", "style-reference", "style-1.png"),
      makeSource("src-content-3", "visual-reference", `${SECRET_NAME_MARKER}-3.png`),
      makeSource("src-style-2", "style-reference", "style-2.png"),
      makeSource("src-content-4", "visual-reference", `${SECRET_NAME_MARKER}-4.png`),
    ];
    for (const source of sources)
      await repository.saveAsset(project.id, `${source.id}.png`, TINY_PNG);
    project.sources.push(...sources);
    // **刻意與 project.sources 的順序不同**：sourceIds 是模型的優先序，project.sources 是
    // 上傳順序。兩者一致的話，這個測試分不出實作是照哪一個排的——而照上傳順序排的話，
    // 「20 張舊截圖之後才加的 2 張關鍵圖表」會在超限時被砍掉，正好砍掉模型真正要的那兩張。
    project.slides[0]!.sourceIds = [
      "src-content-4",
      "src-content-3",
      "src-style-2",
      "src-content-2",
      "src-content-1",
      "src-style-1",
    ];
    await repository.saveProject(project);
    const warnings = captureWarnings();

    try {
      const queued = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
      const { job } = await waitForTerminalJob(repository, project.id, queued.id);
      expect(job.status).toBe("completed");
    } finally {
      warnings.restore();
    }

    // 上限 4：兩張風格圖一定留下，內容圖依 **sourceIds** 的順序補到滿——模型最先挑的
    // content-4／content-3 留下，排在後面的 content-2／content-1 被砍。
    expect(provider.captured?.references.map((reference) => reference.name)).toEqual([
      `${SECRET_NAME_MARKER}-4.png`,
      `${SECRET_NAME_MARKER}-3.png`,
      "style-2.png",
      "style-1.png",
    ]);
    const truncated = warnings
      .read()
      .filter((entry) => entry.event === "image_references_truncated");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({
      projectId: project.id,
      slideId: project.slides[0]!.id,
      providerId: provider.id,
      maxReferenceImages: 4,
      requestedCount: 6,
      keptCount: 4,
      droppedCount: 2,
      droppedRoles: ["content", "content"],
      droppedSourceIds: ["src-content-2", "src-content-1"],
    });
    // 只記 id 與數字：檔名（使用者的檔案名稱常含人名／公司名）一個字都不進 log。
    expect(JSON.stringify(truncated[0])).not.toContain(SECRET_NAME_MARKER);
  });

  it("編輯任務截斷後，base 與 mask 仍在 edit 指到的位置上", async () => {
    const provider = new LimitedProvider();
    const { repository, project, runner } = await fixture(provider);
    const sources = Array.from({ length: 5 }, (_, index) =>
      makeSource(`edit-content-${index}`, "visual-reference", `content-${index}.png`),
    );
    for (const source of sources)
      await repository.saveAsset(project.id, `${source.id}.png`, TINY_PNG);
    project.sources.push(...sources);
    project.slides[0]!.sourceIds = sources.map((source) => source.id);
    await repository.saveProject(project);

    const first = await runner.enqueue(project.id, project.slides[0]!.id, provider.id);
    const generated = await waitForTerminalJob(repository, project.id, first.id);
    expect(generated.job.status).toBe("completed");

    const maskBytes = await sharp({
      create: {
        width: project.canvas.width,
        height: project.canvas.height,
        channels: 4,
        background: "#ffffff",
      },
    })
      .png()
      .toBuffer();
    const maskPath = await repository.saveAsset(
      project.id,
      "edit-masks/mask.png",
      new Uint8Array(maskBytes),
    );
    const warnings = captureWarnings();
    try {
      const edited = await runner.enqueue(project.id, project.slides[0]!.id, provider.id, {
        instruction: "只改遮罩標到的那張卡片",
        baseVersionId: generated.job.resultVersionId!,
        maskPath,
      });
      const { job } = await waitForTerminalJob(repository, project.id, edited.id);
      expect(job.status).toBe("completed");
    } finally {
      warnings.restore();
    }

    const captured = provider.captured!;
    expect(captured.references).toHaveLength(4);
    // index 與 role 分歧會是無聲的：模型會同時收到「Image 1 是你要編輯的投影片」與
    // 「Image 1 是參考圖」兩句互相打架的話。
    expect(captured.edit?.baseImageIndex).toBe(0);
    expect(captured.edit?.maskImageIndex).toBe(1);
    expect(captured.references.map((reference) => reference.role)).toEqual([
      "base",
      "mask",
      "content",
      "content",
    ]);
    const truncated = warnings
      .read()
      .filter((entry) => entry.event === "image_references_truncated");
    expect(truncated[0]).toMatchObject({ requestedCount: 7, keptCount: 4, droppedCount: 3 });
  });
});

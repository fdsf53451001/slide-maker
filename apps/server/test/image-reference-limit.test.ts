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
import { FileStyleRepository } from "../src/styles.js";

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

/** 帶風格庫的版本：只有它組得出真正的 `role: "style"` 參考圖（來源那條走的是 usage）。 */
async function styledFixture(provider: ImageProvider) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-deck-frame-"));
  const repository = new FileProjectRepository(root);
  const styles = new FileStyleRepository(join(root, "styles"));
  await styles.initialize();
  const project = createProject({ topic: "框架範本", now: "2026-08-15T00:00:00.000Z" });
  project.styleSnapshot.referenceImages = [
    {
      id: "style-ref-1",
      name: "Deck style A",
      mediaType: "image/png",
      assetPath: "assets/style-ref-1.png",
      createdAt: "2026-08-15T00:00:00.000Z",
    },
  ];
  await repository.saveProject(project);
  const providers = new ProviderRegistry<ImageProvider>().register(provider);
  return { root, repository, project, runner: new JobRunner(repository, providers, styles) };
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
      // 「大綱參考」是**結構指示**，不是畫面素材：使用者把大綱拍成照片丟進來時，那張圖對
      // 「這一頁要長什麼樣」沒有貢獻，卻會吃掉每頁 3 張的參考圖額度、把真正要附的圖表擠掉。
      // 它的結構早就以純文字整份進了大綱 prompt（`buildOutlineReference()`）。
      "outline-reference",
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
    // 逐一點名這兩個「是圖片、也被選進 sourceIds、但不該附上去」的 usage：只比對兩個集合
    // 相等的話，predicate 與 jobs.ts 一起改錯（兩邊都開始附大綱參考）仍然是綠的。
    expect(attached.has("outline-reference.png")).toBe(false);
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

  it("框架範本與風格參考圖同一優先級，被砍的仍是內容圖的尾巴", () => {
    // 少了範本這一頁會長得不像同一份簡報，與少了風格圖是同一類損失，所以同級。
    const references = [ref("style"), ref("deck-frame"), ref("content"), ref("content")];
    const limited = limitReferences(references, 3);
    expect(limited.keptIndices).toEqual([0, 1, 2]);
    expect(limited.droppedIndices).toEqual([3]);
  });

  it("同優先級維持原順序：風格圖仍排在範本前面", () => {
    // 「同一優先級」不可退化成「範本插隊」——jobs.ts 組出的順序（style → deck-frame →
    // content）就是合約裡 Image N 的順序，換位等於換了每張圖的說明。
    const references = [ref("content"), ref("style"), ref("deck-frame")];
    const limited = limitReferences(references, 2);
    expect(limited.keptIndices).toEqual([1, 2]);
    expect(limited.droppedIndices).toEqual([0]);
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

/**
 * 上一頁當作框架範本。
 *
 * 每頁都是單次無狀態生成，附給模型的圖原本只有風格庫參考圖與該頁自己的來源圖，跨頁一致性
 * 全靠 designSystem 的文字描述重現——實測兩頁的標頭樣式因此不一致。這組測試釘的是「哪一張
 * 圖會被挑成範本、放在哪個位置、什麼時候不附」。
 *
 * **不變量：沒有範本可附時，送出的合約字串與加這個功能前逐字元相同。** 那由
 * `packages/core/test/contract-modes.test.ts` 的快照承擔（CASES 刻意沒有 deck-frame 情境）。
 * 做法是先做完 deck chrome 那一半、更新快照，再加這個功能並確認快照**沒有第二次變動**；
 * 這裡的「第一頁完全不含 deck-frame」則是同一件事在 jobs.ts 這一端的對照。
 */
describe("上一頁當作框架範本", () => {
  const DECK_FRAME_NAME = "Previous slide in this deck";

  /** 生成某一頁並回傳它落地的版本；`captured` 是那次呼叫真正送出的請求。 */
  async function generateSlide(
    context: Awaited<ReturnType<typeof styledFixture>>,
    provider: LimitedProvider,
    order: number,
  ) {
    const project = (await context.repository.loadProject(context.project.id))!;
    const slide = project.slides.find((candidate) => candidate.order === order)!;
    const queued = await context.runner.enqueue(project.id, slide.id, provider.id);
    const { job } = await waitForTerminalJob(context.repository, project.id, queued.id);
    expect(job.status).toBe("completed");
    return { slideId: slide.id, versionId: job.resultVersionId!, jobId: job.id };
  }

  const roles = (provider: LimitedProvider) =>
    provider.captured?.references.map((reference) => reference.role);

  const deckFrame = (provider: LimitedProvider) =>
    provider.captured?.references.find((reference) => reference.name === DECK_FRAME_NAME);

  /** 那一頁目前版本的圖在磁碟上的絕對路徑——用來確認範本挑到的是哪一頁。 */
  async function currentImagePath(
    context: Awaited<ReturnType<typeof styledFixture>>,
    slideId: string,
  ) {
    const project = (await context.repository.loadProject(context.project.id))!;
    const slide = project.slides.find((candidate) => candidate.id === slideId)!;
    const version = slide.versions.find((entry) => entry.id === slide.currentVersionId)!;
    return context.repository.resolveAsset(project.id, version.imagePath);
  }

  it("上一頁已生成時附成 deck-frame，排在風格參考圖之後、內容參考圖之前", async () => {
    const provider = new LimitedProvider();
    const context = await styledFixture(provider);
    const source = makeSource("frame-content", "visual-reference", "chart.png");
    await context.repository.saveAsset(context.project.id, `${source.id}.png`, TINY_PNG);
    await context.repository.updateProject(context.project.id, (project) => {
      project.sources.push(source);
      project.slides.find((slide) => slide.order === 1)!.sourceIds = [source.id];
    });

    const first = await generateSlide(context, provider, 0);
    // 第一頁自己沒有範本可用（同一份 deck 前面沒有已生成的頁）。
    expect(roles(provider)).toEqual(["style"]);

    await generateSlide(context, provider, 1);
    // 順序即合約裡 Image N 的順序：style → deck-frame → content。
    expect(roles(provider)).toEqual(["style", "deck-frame", "content"]);
    expect(deckFrame(provider)?.path).toBe(await currentImagePath(context, first.slideId));
    expect(deckFrame(provider)?.mediaType).toBe("image/png");
  });

  it("第一頁完全不附範本", async () => {
    const provider = new LimitedProvider();
    const context = await styledFixture(provider);
    await generateSlide(context, provider, 0);
    expect(roles(provider)).toEqual(["style"]);
    expect(deckFrame(provider)).toBeUndefined();
  });

  it("上一頁還沒生成時往前找，取到再上一頁那張", async () => {
    // 前面幾頁還沒生成是正常狀態（使用者從中間開始生成），就地放棄等於整份 deck 都拿不到
    // 範本。
    const provider = new LimitedProvider();
    const context = await styledFixture(provider);
    const first = await generateSlide(context, provider, 0);
    await generateSlide(context, provider, 2);
    expect(roles(provider)).toEqual(["style", "deck-frame"]);
    expect(deckFrame(provider)?.path).toBe(await currentImagePath(context, first.slideId));
  });

  it("隱藏頁照樣可以當範本", async () => {
    // `hidden` 的語意是「這一頁不上場」，不是「這一頁不算數」——它的視覺框架仍然是這份
    // deck 的，跳過它只會讓後面那一頁莫名其妙地少一張範本。
    const provider = new LimitedProvider();
    const context = await styledFixture(provider);
    const first = await generateSlide(context, provider, 0);
    await context.repository.updateProject(context.project.id, (project) => {
      project.slides.find((slide) => slide.id === first.slideId)!.hidden = true;
    });

    await generateSlide(context, provider, 1);
    expect(roles(provider)).toEqual(["style", "deck-frame"]);
    expect(deckFrame(provider)?.path).toBe(await currentImagePath(context, first.slideId));
  });

  it("編輯與抹字任務都不附範本", async () => {
    // 這兩種任務是在既有像素上動刀，一致性來自底圖本身；多附一張「別頁長這樣」只會變成
    // 重排整張投影片的理由（916fa47 的形狀）。
    const provider = new LimitedProvider();
    const context = await styledFixture(provider);
    await generateSlide(context, provider, 0);
    const second = await generateSlide(context, provider, 1);
    // 前置條件：這一頁在全新生成時**確實**拿得到範本，否則下面兩個斷言恆真。
    expect(roles(provider)).toContain("deck-frame");

    const edited = await context.runner.enqueue(context.project.id, second.slideId, provider.id, {
      instruction: "把右側卡片換成藍色",
      baseVersionId: second.versionId,
    });
    const editJob = await waitForTerminalJob(context.repository, context.project.id, edited.id);
    expect(editJob.job.status).toBe("completed");
    expect(roles(provider)).toEqual(["base", "style"]);

    const extracted = await context.runner.enqueue(
      context.project.id,
      second.slideId,
      provider.id,
      {
        instruction: "Remove text",
        baseVersionId: second.versionId,
        textExtraction: { originalVersionId: second.versionId, threshold: 0.75, boxes: [] },
      },
    );
    const extractJob = await waitForTerminalJob(
      context.repository,
      context.project.id,
      extracted.id,
    );
    expect(extractJob.job.status).toBe("completed");
    expect(roles(provider)).toEqual(["base", "style"]);
  });

  it("provider 不吃參考圖時略過範本，生成照樣完成並留下一行原因", async () => {
    // 範本是純加分項，**絕不可讓原本跑得動的生成變成失敗**。實測（jobs-security 的併發
    // 測試）：無條件附上時，宣告 `referenceImages: false` 的 provider 第一頁照常完成、
    // 第二頁起每一頁都 STYLE_REFERENCES_UNSUPPORTED——序列跑的第二頁正好拿得到範本。
    const provider = new LimitedProvider();
    Object.defineProperty(provider, "capabilities", {
      value: { ...provider.capabilities, referenceImages: false, multipleReferenceImages: false },
    });
    const context = await styledFixture(provider);
    await context.repository.updateProject(context.project.id, (project) => {
      // 風格參考圖也一併拿掉：這個 provider 連一張補充參考圖都不吃。
      project.styleSnapshot.referenceImages = [];
    });
    await generateSlide(context, provider, 0);
    const warnings = captureWarnings();
    try {
      await generateSlide(context, provider, 1);
    } finally {
      warnings.restore();
    }
    expect(provider.captured?.references).toEqual([]);
    // 略過是降級，不能靜默：跨頁樣式不一致回報進來時，這一行是唯一能分辨「沒附範本」與
    // 「附了但模型沒理」的證據。
    const skipped = warnings
      .read()
      .filter((entry) => entry.event === "deck_frame_reference_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      projectId: context.project.id,
      providerId: provider.id,
      reason: "REFERENCE_IMAGES_UNSUPPORTED",
    });
  });

  it("上一頁不是 PNG／JPEG 時不附，也不猜一個 mediaType", async () => {
    // 內建 mock provider 落地的是 `.svg`；把它標成 image/png 送給真的影像模型換來的是整頁
    // 失敗。同一份專案先用 mock 跑、之後換成真模型是真實路徑（使用者換模型組合）。
    const provider = new LimitedProvider();
    const context = await styledFixture(provider);
    const first = await generateSlide(context, provider, 0);
    await context.repository.updateProject(context.project.id, (project) => {
      const slide = project.slides.find((candidate) => candidate.id === first.slideId)!;
      const version = slide.versions.find((entry) => entry.id === slide.currentVersionId)!;
      version.imagePath = version.imagePath.replace(/\.png$/i, ".svg");
    });
    const warnings = captureWarnings();
    try {
      await generateSlide(context, provider, 1);
    } finally {
      warnings.restore();
    }
    expect(roles(provider)).toEqual(["style"]);
    expect(
      warnings.read().filter((entry) => entry.event === "deck_frame_reference_skipped")[0],
    ).toMatchObject({ reason: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("provider 只吃一張參考圖時，風格圖優先，範本讓位並記下原因", async () => {
    // 「只能一張」的名額已經被風格圖佔走：硬塞第二張會撞 MULTIPLE_REFERENCES_UNSUPPORTED，
    // 整頁失敗換一張範本不是划算的交易。
    const provider = new LimitedProvider();
    Object.defineProperty(provider, "capabilities", {
      value: { ...provider.capabilities, multipleReferenceImages: false },
    });
    const context = await styledFixture(provider);
    await generateSlide(context, provider, 0);
    const warnings = captureWarnings();
    try {
      await generateSlide(context, provider, 1);
    } finally {
      warnings.restore();
    }
    expect(roles(provider)).toEqual(["style"]);
    expect(
      warnings.read().filter((entry) => entry.event === "deck_frame_reference_skipped")[0],
    ).toMatchObject({ reason: "MULTIPLE_REFERENCES_UNSUPPORTED" });
  });
});

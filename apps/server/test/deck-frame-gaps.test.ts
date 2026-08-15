import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  createProject,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageProvider,
  ProviderRegistry,
} from "@slide-maker/core";
import { MockImageProvider } from "@slide-maker/provider-mock";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";
import { FileStyleRepository } from "../src/styles.js";

/**
 * QA 補洞：`deck-frame`（上一頁當框架範本）在既有測試沒有走到的那幾條路。
 *
 * 既有的 `image-reference-limit.test.ts` 用的 stub **完全不讀** `reference.path`，所以它證得了
 * 「哪一張圖被挑成範本」，證不了「那張圖真的送得出去」。三條真實通道（`image-api.ts` 的
 * `readImageBytes`／`imageBlob`、`image-chat.ts`／`image-openrouter.ts` 的
 * `readImageAsDataUrl`、`provider-gemini/src/image.ts` 的 `inlineReference`）都會逐張把檔案讀
 * 進來，所以這裡的 stub 也讀——磁碟上少一個檔案的後果只有這樣才看得見。
 */

const CANVAS = { width: 1920, height: 1080 };

/** 與三條真實通道同形：逐張把附圖讀進來，讀不到就 throw。 */
class ReadingProvider implements ImageProvider {
  readonly id = "reading-image";
  readonly name = "Reference-reading provider";
  readonly availability = { status: "available" as const };
  readonly capabilities: ImageProvider["capabilities"];

  captured: ImageGenerationRequest | undefined;
  readPaths: string[] = [];

  constructor(overrides: Partial<ImageProvider["capabilities"]> = {}) {
    this.capabilities = {
      fullSlideGeneration: true as const,
      referenceImages: true,
      imageEditing: true,
      maskedEditing: true,
      multipleReferenceImages: true,
      supportedSizes: [CANVAS],
      reproducibleParameters: [] as string[],
      ...overrides,
    };
  }

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    this.captured = request;
    for (const reference of request.references) {
      await readFile(reference.path);
      this.readPaths.push(reference.path);
    }
    const bytes = await sharp({
      create: { ...CANVAS, channels: 4, background: "#101010" },
    })
      .png()
      .toBuffer();
    return {
      bytes: new Uint8Array(bytes),
      mediaType: "image/png",
      extension: "png",
      model: "reading-v1",
      parameters: {},
    };
  }
}

async function waitForTerminalJob(
  repository: FileProjectRepository,
  projectId: string,
  jobId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const project = await repository.loadProject(projectId);
    const job = project?.jobs.find((candidate) => candidate.id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state`);
}

async function fixture(provider: ImageProvider, options: { styleName?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-deck-frame-gap-"));
  const repository = new FileProjectRepository(root);
  const styles = new FileStyleRepository(join(root, "styles"));
  await styles.initialize();
  const project = createProject({ topic: "框架範本缺口", now: "2026-08-15T00:00:00.000Z" });
  project.styleSnapshot.referenceImages = [
    {
      id: "style-ref-1",
      name: options.styleName ?? "Deck style A",
      mediaType: "image/png",
      assetPath: "assets/style-ref-1.png",
      createdAt: "2026-08-15T00:00:00.000Z",
    },
  ];
  await repository.saveProject(project);
  // 風格參考圖住在風格庫，不在專案資產底下；`ReadingProvider` 會真的去讀它，所以檔案要在。
  const stylePath = styles.referenceAssetPath("assets/style-ref-1.png");
  await mkdir(dirname(stylePath), { recursive: true });
  await writeFile(
    stylePath,
    await sharp({ create: { ...CANVAS, channels: 4, background: "#fff" } })
      .png()
      .toBuffer(),
  );
  return {
    root,
    repository,
    styles,
    projectId: project.id,
    runner: new JobRunner(
      repository,
      new ProviderRegistry<ImageProvider>().register(provider),
      styles,
    ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function slideIdAt(context: Fixture, order: number) {
  const project = (await context.repository.loadProject(context.projectId))!;
  return project.slides.find((slide) => slide.order === order)!.id;
}

async function generate(context: Fixture, providerId: string, order: number) {
  const slideId = await slideIdAt(context, order);
  const queued = await context.runner.enqueue(context.projectId, slideId, providerId);
  return {
    slideId,
    job: await waitForTerminalJob(context.repository, context.projectId, queued.id),
  };
}

async function currentVersion(context: Fixture, slideId: string) {
  const project = (await context.repository.loadProject(context.projectId))!;
  const slide = project.slides.find((candidate) => candidate.id === slideId)!;
  return slide.versions.find((entry) => entry.id === slide.currentVersionId)!;
}

const roles = (provider: ReadingProvider) =>
  provider.captured?.references.map((reference) => reference.role);
const frame = (provider: ReadingProvider) =>
  provider.captured?.references.find((reference) => reference.role === "deck-frame");

const captureWarnings = () => {
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
    raw: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
};

describe("deck-frame：上一頁的圖在磁碟上不見了", () => {
  it("範本檔案不存在時繼續往前找，生成照常完成", async () => {
    // 這一條原本是「[缺口] 整個生成任務失敗」：`chooseDeckFrame()` 當時只確認 version 物件
    // 還在 `versions` 陣列裡，四條真實 transport 卻都會無條件把每一張參考圖讀進來，於是
    // 少一個檔案就是整頁 failed——而且 ENOENT 訊息帶著 `.png`，會命中 `safeFailure` 的 PNG
    // 分支，使用者被告知「生成圖片未通過安全或格式驗證」，真正的原因卻是**另一頁**的檔案。
    //
    // 可達路徑：`parseProjectBundle()` 只驗 zip 路徑安全與 `project.json` 的 schema，
    // **不比對每個 `version.imagePath` 是否真的在 `assets/` 裡**，所以一份被手改過／截斷的
    // `.slide-project` 匯進來之後，第 N 頁的圖不見了，受害的卻是第 N+1 頁的生成。
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    const first = await generate(context, provider.id, 0);
    expect(first.job.status).toBe("completed");

    // 對照組：檔案還在的時候，第二頁生得出來，而且範本確實被讀了進去。
    const second = await generate(context, provider.id, 1);
    expect(second.job.status).toBe("completed");
    expect(roles(provider)).toContain("deck-frame");

    // 把第二頁那張圖從磁碟上拿掉（其餘專案資料完全不動）。
    const version = await currentVersion(context, second.slideId);
    await rm(context.repository.resolveAsset(context.projectId, version.imagePath));

    const third = await generate(context, provider.id, 2);
    // 這一頁自己的內容、風格參考圖、來源全都完好，別頁少一個檔案不該讓它失敗。
    expect(third.job.status).toBe("completed");
    // 而且**會退回去用第一頁那張還在的圖**：檢查在迴圈裡，不合格就繼續往前找，不是選定
    // 第一張有 version 物件的頁就 commit。
    const firstVersion = await currentVersion(context, first.slideId);
    expect(frame(provider)?.path).toBe(
      context.repository.resolveAsset(context.projectId, firstVersion.imagePath),
    );
    expect(frame(provider)?.path).not.toBe(
      context.repository.resolveAsset(context.projectId, version.imagePath),
    );
  });

  it("一張可用的都沒有時仍然完成，並記下 FRAME_ASSET_MISSING", async () => {
    // 三種略過（能力不足、只吃一張、副檔名不認得）都記 `deck_frame_reference_skipped`，
    // 「檔案不見了」也必須有自己的原因碼：使用者回報「相鄰兩頁還是不一致」時，這一行是
    // 伺服器上唯一能指出「你的專案少了一個資產檔」的東西。
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    const first = await generate(context, provider.id, 0);
    const version = await currentVersion(context, first.slideId);
    await rm(context.repository.resolveAsset(context.projectId, version.imagePath));

    const warnings = captureWarnings();
    try {
      const second = await generate(context, provider.id, 1);
      expect(second.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    expect(roles(provider)).toEqual(["style"]);
    const skipped = warnings
      .read()
      .filter((entry) => entry.event === "deck_frame_reference_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ reason: "FRAME_ASSET_MISSING" });
    // 這一行也不得夾帶檔名（那是唯一靠近使用者資料的欄位）。
    expect(JSON.stringify(skipped[0])).not.toContain(".png");
  });
});

describe("deck-frame：往前找的邊界", () => {
  it("currentVersionId 指到不存在的 version 時繼續往前找，不是就地放棄", async () => {
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    const first = await generate(context, provider.id, 0);
    const second = await generate(context, provider.id, 1);
    expect(second.job.status).toBe("completed");

    // 第二頁的 currentVersionId 指到一個不在 versions 裡的 id（手改過的 project.json、
    // 或未來某個把 version 抽走卻忘了改指標的路徑）。
    await context.repository.updateProject(context.projectId, (project) => {
      project.slides.find((slide) => slide.id === second.slideId)!.currentVersionId =
        "00000000-0000-4000-8000-000000000000";
    });

    const third = await generate(context, provider.id, 2);
    expect(third.job.status).toBe("completed");
    const firstVersion = await currentVersion(context, first.slideId);
    expect(frame(provider)?.path).toBe(
      context.repository.resolveAsset(context.projectId, firstVersion.imagePath),
    );
  });

  it("一路往前都找不到可用的頁時記 NO_PREVIOUS_GENERATED_SLIDE，第一頁則不記", async () => {
    // 這一條原本是「[缺口] 無聲不附，與『這是第一頁』分不出來」：兩種狀態的伺服器紀錄完全
    // 相同（都沒有 log），而那才是最常見的「沒附範本」路徑（批次最前面兩頁、只重生某頁而
    // 前面還沒生成、version 指標損壞）。現在前者記一行、後者仍然安靜——第一頁沒有「找不到」
    // 可言，記了只是每一份專案的第一頁都多一行雜訊。
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    const first = await generate(context, provider.id, 0);
    await context.repository.updateProject(context.projectId, (project) => {
      project.slides.find((slide) => slide.id === first.slideId)!.currentVersionId =
        "00000000-0000-4000-8000-000000000000";
    });

    const warnings = captureWarnings();
    try {
      const second = await generate(context, provider.id, 1);
      expect(second.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    expect(roles(provider)).toEqual(["style"]);
    const skipped = warnings
      .read()
      .filter((entry) => entry.event === "deck_frame_reference_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      reason: "NO_PREVIOUS_GENERATED_SLIDE",
      slideId: await slideIdAt(context, 1),
    });
  });

  it("第一頁不記 log——那不是降級，是這個功能本來就不適用", async () => {
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    const warnings = captureWarnings();
    try {
      const first = await generate(context, provider.id, 0);
      expect(first.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    expect(roles(provider)).toEqual(["style"]);
    expect(
      warnings.read().filter((entry) => entry.event === "deck_frame_reference_skipped"),
    ).toHaveLength(0);
  });

  it("風格改版後，還沒重生的舊頁不會被當成範本", async () => {
    // 改了風格 → 只重生第 12 頁 → 第 11 頁還是舊風格 → 範本把新的 designSystem 往回拉。
    // 副作用正好是對的：改完風格重生整份時第一頁沒有範本，之後每頁從新生成的頁接續。
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    const first = await generate(context, provider.id, 0);
    const version = await currentVersion(context, first.slideId);
    expect(version.styleVersion).toBe(1);
    await context.repository.updateProject(context.projectId, (project) => {
      project.styleSnapshot.version += 1;
    });

    const warnings = captureWarnings();
    try {
      const second = await generate(context, provider.id, 1);
      expect(second.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    expect(roles(provider)).toEqual(["style"]);
    expect(
      warnings.read().find((entry) => entry.event === "deck_frame_reference_skipped"),
    ).toMatchObject({ reason: "STYLE_VERSION_STALE" });

    // 用新風格生成過的頁隨即又可以當範本——這條檢查擋的是「舊風格」，不是「所有前頁」。
    const third = await generate(context, provider.id, 2);
    expect(third.job.status).toBe("completed");
    expect(roles(provider)).toEqual(["style", "deck-frame"]);
    const secondVersion = await currentVersion(context, await slideIdAt(context, 1));
    expect(frame(provider)?.path).toBe(
      context.repository.resolveAsset(context.projectId, secondVersion.imagePath),
    );
  });

  it("order 不連續時取「order 最大且小於本頁」的那一頁，不是 order-1", async () => {
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    await context.repository.updateProject(context.projectId, (project) => {
      // 0, 1, 2, … → 0, 7, 9…：中間整段空掉。
      project.slides.forEach((slide, index) => {
        slide.order = index === 0 ? 0 : index * 7;
      });
    });
    const first = await generate(context, provider.id, 0);
    const third = await generate(context, provider.id, 14);
    expect(third.job.status).toBe("completed");
    // 第 7 那頁還沒生成，所以要落到第 0 頁。
    const firstVersion = await currentVersion(context, first.slideId);
    expect(frame(provider)?.path).toBe(
      context.repository.resolveAsset(context.projectId, firstVersion.imagePath),
    );
  });

  it("order 重複時取 slides 陣列裡排在前面的那一頁（穩定排序的結果）", async () => {
    // schema 對 order 沒有唯一性約束（`z.number().int().nonnegative()`），而
    // `deckFrameImagePath()` 是 `filter(order <)` + `sort` ——同分時由 V8 的穩定排序決定。
    // 這裡把那個「決定」釘住：換成不穩定的排法會讓同一份專案兩次生成挑到不同的範本。
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    await context.repository.updateProject(context.projectId, (project) => {
      project.slides[0]!.order = 0;
      project.slides[1]!.order = 0;
      project.slides[2]!.order = 5;
    });
    const project = (await context.repository.loadProject(context.projectId))!;
    const [firstOfTie, secondOfTie, target] = project.slides;

    // 兩頁都生成，讓它們都成為候選。
    for (const slide of [firstOfTie!, secondOfTie!]) {
      const queued = await context.runner.enqueue(context.projectId, slide.id, provider.id);
      const job = await waitForTerminalJob(context.repository, context.projectId, queued.id);
      expect(job.status).toBe("completed");
    }

    const queued = await context.runner.enqueue(context.projectId, target!.id, provider.id);
    const job = await waitForTerminalJob(context.repository, context.projectId, queued.id);
    expect(job.status).toBe("completed");
    const tieVersion = await currentVersion(context, firstOfTie!.id);
    expect(frame(provider)?.path).toBe(
      context.repository.resolveAsset(context.projectId, tieVersion.imagePath),
    );
  });

  it("挑的是使用者看到的合成圖（imagePath），不是抹過字的背景（backgroundPath）", async () => {
    // `jobs.ts` 明講「用 version 的 imagePath（使用者現在看到的那張，含文字層的合成結果）」。
    // 拿 backgroundPath 的話，範本會是一張沒有字的底圖，標頭位置與字級全部量不到。
    const provider = new ReadingProvider();
    const context = await fixture(provider);
    const first = await generate(context, provider.id, 0);
    const version = await currentVersion(context, first.slideId);
    const backgroundPath = await context.repository.saveAsset(
      context.projectId,
      "text-layers/background.png",
      new Uint8Array(
        await sharp({ create: { ...CANVAS, channels: 4, background: "#222" } })
          .png()
          .toBuffer(),
      ),
    );
    const compositePath = await context.repository.saveAsset(
      context.projectId,
      "text-layers/composite.png",
      new Uint8Array(
        await sharp({ create: { ...CANVAS, channels: 4, background: "#333" } })
          .png()
          .toBuffer(),
      ),
    );
    await context.repository.updateProject(context.projectId, (project) => {
      const slide = project.slides.find((candidate) => candidate.id === first.slideId)!;
      const target = slide.versions.find((entry) => entry.id === version.id)!;
      target.imagePath = compositePath;
      target.textLayer = {
        originalVersionId: version.id,
        backgroundPath,
        compositePath,
        threshold: 0.75,
        renderRevision: 0,
        boxes: [],
        extractedAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
      };
    });

    const second = await generate(context, provider.id, 1);
    expect(second.job.status).toBe("completed");
    expect(frame(provider)?.path).toBe(
      context.repository.resolveAsset(context.projectId, compositePath),
    );
    expect(frame(provider)?.path).not.toBe(
      context.repository.resolveAsset(context.projectId, backgroundPath),
    );
  });
});

describe("deck-frame：撞到 provider 張數上限", () => {
  it("上限剛好砍到內容圖時，被丟掉的是內容圖的尾巴，範本與風格圖都留下", async () => {
    const provider = new ReadingProvider({ maxReferenceImages: 3 });
    const context = await fixture(provider);
    const tiny = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 4, background: "#888" } })
        .png()
        .toBuffer(),
    );
    await generate(context, provider.id, 0);
    await context.repository.updateProject(context.projectId, (project) => {
      project.sources.push(
        ...["a", "b"].map((suffix) => ({
          id: `content-${suffix}`,
          name: `chart-${suffix}.png`,
          mediaType: "image/png",
          usage: "visual-reference" as const,
          allowModelAccess: true,
          status: "indexed" as const,
          assetPath: `assets/content-${suffix}.png`,
          sizeBytes: tiny.length,
          extractedText: "",
          chunks: [],
          metadata: {},
          createdAt: "2026-08-15T00:00:00.000Z",
        })),
      );
      project.slides.find((slide) => slide.order === 1)!.sourceIds = ["content-a", "content-b"];
    });
    for (const suffix of ["a", "b"])
      await context.repository.saveAsset(context.projectId, `content-${suffix}.png`, tiny);

    const warnings = captureWarnings();
    try {
      const second = await generate(context, provider.id, 1);
      expect(second.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    // 上限 3：使用者選中的兩張內容圖都留下，讓位的是範本。
    expect(roles(provider)).toEqual(["style", "content", "content"]);
    expect(
      warnings.read().find((entry) => entry.event === "image_references_truncated"),
    ).toMatchObject({ droppedRoles: ["deck-frame"], droppedCount: 1 });
  });

  it("上限低到只容得下風格圖時，範本被砍掉——而且記下它自己那一行", async () => {
    // 這一條原本是「[風險] 無聲砍掉」：通用的 `image_references_truncated` 帶得出
    // `droppedRoles`，但宣告 `maxReferenceImages: 1` 的通道（或風格庫塞滿 4 張而上限是 4）
    // 會讓範本**每一頁**都被丟掉，整個功能靜默變成 no-op，而使用者只看得到「這個功能沒效」。
    const provider = new ReadingProvider({ maxReferenceImages: 1 });
    const context = await fixture(provider);
    await generate(context, provider.id, 0);
    const warnings = captureWarnings();
    try {
      const second = await generate(context, provider.id, 1);
      expect(second.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    expect(roles(provider)).toEqual(["style"]);
    expect(
      warnings.read().find((entry) => entry.event === "image_references_truncated"),
    ).toMatchObject({ droppedRoles: ["deck-frame"] });
    expect(
      warnings.read().find((entry) => entry.event === "deck_frame_reference_skipped"),
    ).toMatchObject({ reason: "REFERENCE_BUDGET_EXCEEDED" });
  });
});

describe("deck-frame：真的用內建 mock provider 跑一次", () => {
  it("mock 落地的是 .svg，所以第二頁不會拿到範本，並留下 UNSUPPORTED_MEDIA_TYPE", async () => {
    // 這條路的前提（「內建 mock provider 落地的是 `.svg`」）在既有測試裡是用「把 imagePath
    // 的副檔名改掉」模擬的。這裡用真的 `MockImageProvider` 端到端跑一次，確認那個前提還成立
    // ——mock 哪天改成輸出 PNG，`UNSUPPORTED_MEDIA_TYPE` 這條分支就再也走不到了。
    const provider = new MockImageProvider();
    const root = await mkdtemp(join(tmpdir(), "slide-maker-deck-frame-mock-"));
    const repository = new FileProjectRepository(root);
    const project = createProject({ topic: "mock 範本", now: "2026-08-15T00:00:00.000Z" });
    await repository.saveProject(project);
    const runner = new JobRunner(
      repository,
      new ProviderRegistry<ImageProvider>().register(provider),
    );
    const context = { repository, projectId: project.id, runner } as unknown as Fixture;

    const first = await generate(context, provider.id, 0);
    expect(first.job.status).toBe("completed");
    const version = await currentVersion(context, first.slideId);
    expect(version.imagePath.endsWith(".svg")).toBe(true);

    const warnings = captureWarnings();
    try {
      const second = await generate(context, provider.id, 1);
      expect(second.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    expect(
      warnings.read().find((entry) => entry.event === "deck_frame_reference_skipped"),
    ).toMatchObject({ reason: "UNSUPPORTED_MEDIA_TYPE" });
  });
});

describe("deck_frame_reference_skipped 的 log 不得夾帶正文或檔名", () => {
  const MARKER = "機密客戶名單2026Q3";

  /**
   * 讓**每一個可能被順手記進去的東西**都帶著同一個標記：頁面正文、來源檔名、風格參考圖名
   * 稱、專案名稱，以及最關鍵的——範本圖自己的檔名（那是 `deckFramePath` 的內容，也是這行
   * log 唯一真正靠近使用者資料的欄位）。用不含正文的形狀去測（例如只檢查 `reason`）的話，
   * 有人把 `deckFramePath` 加進 fields 也不會變紅。
   */
  async function leakyFixture(provider: ReadingProvider) {
    const context = await fixture(provider, { styleName: `${MARKER}-style.png` });
    await context.repository.updateProject(context.projectId, (project) => {
      project.name = `${MARKER} 專案`;
      project.brief.topic = `${MARKER} 的營收拆解`;
      for (const slide of project.slides) {
        slide.content = `${MARKER}：第一季 41.2 億`;
        slide.purpose = `說明 ${MARKER}`;
        slide.narrative = MARKER;
        slide.imagePrompt = MARKER;
      }
    });
    return context;
  }

  /** 把上一頁的圖搬到一個檔名帶標記、副檔名不被接受的位置，逼出 UNSUPPORTED_MEDIA_TYPE。 */
  async function renameFrameTo(context: Fixture, slideId: string, relativePath: string) {
    const version = await currentVersion(context, slideId);
    const bytes = new Uint8Array(
      await readFile(context.repository.resolveAsset(context.projectId, version.imagePath)),
    );
    const stored = await context.repository.saveAsset(context.projectId, relativePath, bytes);
    await context.repository.updateProject(context.projectId, (project) => {
      const slide = project.slides.find((candidate) => candidate.id === slideId)!;
      slide.versions.find((entry) => entry.id === version.id)!.imagePath = stored;
    });
  }

  it("UNSUPPORTED_MEDIA_TYPE：範本的檔名帶著使用者的機密字樣，log 一個字都不記", async () => {
    const provider = new ReadingProvider();
    const context = await leakyFixture(provider);
    const first = await generate(context, provider.id, 0);
    await renameFrameTo(context, first.slideId, `generated/${MARKER}-封面.svg`);
    // **這個測試不是空的**：`deckFramePath` 在 log 那一行的作用域裡，而它的值就是下面這個
    // 字串。也就是說「把 deckFramePath 加進 fields」一定會讓下面的斷言變紅——拿一個不含正文
    // 的檔名（`slide-2.png`）去測的話，加了也不會紅，等於沒測。
    expect((await currentVersion(context, first.slideId)).imagePath).toContain(MARKER);

    const warnings = captureWarnings();
    try {
      const second = await generate(context, provider.id, 1);
      expect(second.job.status).toBe("completed");
    } finally {
      warnings.restore();
    }
    const skipped = warnings
      .read()
      .filter((entry) => entry.event === "deck_frame_reference_skipped");
    expect(skipped).toHaveLength(1);
    // 正向對照：確實抓到了那一行，而且它帶著可判讀的 id 與原因。
    expect(skipped[0]).toMatchObject({
      projectId: context.projectId,
      providerId: provider.id,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
    expect(skipped[0]!.slideId).toBe(await slideIdAt(context, 1));
    // 序列化之後一個字都不含正文、檔名、專案名稱。
    expect(JSON.stringify(skipped[0])).not.toContain(MARKER);
    // 整份 warn 輸出也不含（別的事件順手記進去一樣是洩漏）。
    expect(warnings.raw()).not.toContain(MARKER);
  });

  it("REFERENCE_IMAGES_UNSUPPORTED 與 MULTIPLE_REFERENCES_UNSUPPORTED 兩條路同樣不夾帶", async () => {
    for (const [reason, capabilities] of [
      ["REFERENCE_IMAGES_UNSUPPORTED", { referenceImages: false, multipleReferenceImages: false }],
      ["MULTIPLE_REFERENCES_UNSUPPORTED", { multipleReferenceImages: false }],
    ] as const) {
      const provider = new ReadingProvider(capabilities);
      const context = await leakyFixture(provider);
      if (reason === "REFERENCE_IMAGES_UNSUPPORTED")
        await context.repository.updateProject(context.projectId, (project) => {
          project.styleSnapshot.referenceImages = [];
        });
      const first = await generate(context, provider.id, 0);
      expect(first.job.status).toBe("completed");
      // 範本的檔名也帶標記，但副檔名合法——這樣走到的才是能力那兩道檢查。
      await renameFrameTo(context, first.slideId, `generated/${MARKER}-封面.png`);
      // 同上：證明 log 那一行的作用域裡真的有一個含正文的字串可以被誤記。
      expect((await currentVersion(context, first.slideId)).imagePath, reason).toContain(MARKER);

      const warnings = captureWarnings();
      try {
        const second = await generate(context, provider.id, 1);
        expect(second.job.status, reason).toBe("completed");
      } finally {
        warnings.restore();
      }
      const skipped = warnings
        .read()
        .filter((entry) => entry.event === "deck_frame_reference_skipped");
      expect(skipped, reason).toHaveLength(1);
      expect(skipped[0], reason).toMatchObject({ reason });
      expect(JSON.stringify(skipped[0]), reason).not.toContain(MARKER);
      expect(warnings.raw(), reason).not.toContain(MARKER);
    }
  });
});

describe("deck-frame 對 edit／extract-text 完全不作用", () => {
  it("兩條路都不附範本，也不會記下任何 deck_frame 的 log", async () => {
    // 略過的判斷（能力宣告、副檔名）在 generate 之外一律不可產生 log：多一行只會讓抹字的
    // 診斷多一個永遠為真的雜訊。
    const provider = new ReadingProvider({
      referenceImages: false,
      multipleReferenceImages: false,
    });
    const context = await fixture(provider);
    await context.repository.updateProject(context.projectId, (project) => {
      project.styleSnapshot.referenceImages = [];
    });
    await generate(context, provider.id, 0);
    const second = await generate(context, provider.id, 1);
    expect(second.job.status).toBe("completed");
    const baseVersionId = (await currentVersion(context, second.slideId)).id;

    const warnings = captureWarnings();
    try {
      for (const extra of [
        { instruction: "把右側卡片換成藍色", baseVersionId },
        {
          instruction: "Remove text",
          baseVersionId,
          textExtraction: { originalVersionId: baseVersionId, threshold: 0.75, boxes: [] },
        },
      ]) {
        const queued = await context.runner.enqueue(
          context.projectId,
          second.slideId,
          provider.id,
          extra,
        );
        const job = await waitForTerminalJob(context.repository, context.projectId, queued.id);
        expect(job.status).toBe("completed");
        expect(roles(provider)).toEqual(["base"]);
      }
    } finally {
      warnings.restore();
    }
    expect(
      warnings.read().filter((entry) => entry.event === "deck_frame_reference_skipped"),
    ).toHaveLength(0);
  });
});

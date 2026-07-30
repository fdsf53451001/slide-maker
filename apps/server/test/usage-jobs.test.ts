import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProject,
  type GeneratedImage,
  type ImageProvider,
  ProviderRegistry,
  SafeProviderError,
} from "@slide-maker/core";
import { JobRunner } from "../src/jobs.js";
import { FileProjectRepository } from "../src/repository.js";
import { UsageLedger } from "../src/usage-ledger.js";

/**
 * 影像那條的記帳接線（`JobRunner`），與文字四條完全不同的一份程式碼。
 *
 * 這裡釘的是**失敗**那一半：影像通道最貴又零產出的失敗是「模型回了、只是解不出圖」
 * （選到不支援圖片輸出的模型時就是這個形狀）——往返成功、token 全燒掉、產物是零。
 * usage 就掛在 `SafeProviderError` 上，接不起來的話帳本只會留下一筆 `reported:false`，
 * 與「這個 gateway 不回報用量」分不出來。
 */

const CAPABILITIES = {
  fullSlideGeneration: true as const,
  referenceImages: false,
  imageEditing: false,
  maskedEditing: false,
  multipleReferenceImages: false,
  supportedSizes: [{ width: 1920, height: 1080 }],
  reproducibleParameters: [] as string[],
};

class FailsAfterRoundTripProvider implements ImageProvider {
  readonly id = "fails-after-round-trip";
  readonly name = "回了東西但解不出圖";
  readonly availability = { status: "available" as const };
  readonly capabilities = CAPABILITIES;

  async generate(): Promise<GeneratedImage> {
    throw new SafeProviderError("OPENAI_IMAGE_MISSING", "回應缺少 raster 圖片資料。", {
      usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1_020, reported: true },
      requests: 1,
    });
  }
}

class PlainlyBrokenProvider implements ImageProvider {
  readonly id = "plainly-broken";
  readonly name = "連不上";
  readonly availability = { status: "available" as const };
  readonly capabilities = CAPABILITIES;

  async generate(): Promise<GeneratedImage> {
    throw new SafeProviderError("OPENAI_REQUEST_FAILED", "無法連線。");
  }
}

async function fixture(provider: ImageProvider) {
  const root = await mkdtemp(join(tmpdir(), "slide-maker-usage-jobs-"));
  const repository = new FileProjectRepository(root);
  const project = createProject({ topic: "影像記帳", now: "2026-07-29T00:00:00.000Z" });
  await repository.saveProject(project);
  const ledger = new UsageLedger(repository);
  const runner = new JobRunner(
    repository,
    new ProviderRegistry<ImageProvider>().register(provider),
    undefined,
    {
      ledger,
      modelFields: (providerId) => ({
        modelEntryId: providerId,
        model: "test-image-model",
        providerKind: "openai",
      }),
    },
  );
  return { repository, project, runner, ledger };
}

async function waitForTerminalJob(
  repository: FileProjectRepository,
  projectId: string,
  jobId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const project = await repository.loadProject(projectId);
    const job = project?.jobs.find((candidate) => candidate.id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state`);
}

describe("影像 job 的失敗記帳", () => {
  it("解不出圖時記 ok:false，但錯誤身上的用量一個 token 都不掉", async () => {
    const { repository, project, runner, ledger } = await fixture(
      new FailsAfterRoundTripProvider(),
    );
    const slide = project.slides[0]!;
    const queued = await runner.enqueue(project.id, slide.id, "fails-after-round-trip");
    await waitForTerminalJob(repository, project.id, queued.id);
    await ledger.idle();

    const { records } = await ledger.readProject(project.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      capability: "image",
      operation: "generate",
      slideId: slide.id,
      ok: false,
      requests: 1,
    });
    expect(records[0]!.usage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      totalTokens: 1_020,
      reported: true,
    });
    // 失敗但有回報：這筆的 token 必須進總數，否則「最貴又零產出」的呼叫等於不存在。
    const summary = await ledger.summarizeProject(project.id);
    expect(summary.failedCalls).toBe(1);
    expect(summary.reportedCalls).toBe(1);
    expect(summary.totals.totalTokens).toBe(1_020);
  });

  /**
   * 反面：連不上時**沒有**用量可言。少了這一條，把 usage 亂編一個常數的實作也會通過上面
   * 那一條。
   */
  it("連不上時落成 reported:false，不編造數字", async () => {
    const { repository, project, runner, ledger } = await fixture(new PlainlyBrokenProvider());
    const slide = project.slides[0]!;
    const queued = await runner.enqueue(project.id, slide.id, "plainly-broken");
    await waitForTerminalJob(repository, project.id, queued.id);
    await ledger.idle();

    const { records } = await ledger.readProject(project.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false });
    expect(records[0]!.usage).toEqual({ reported: false });
    expect((await ledger.summarizeProject(project.id)).totals.totalTokens).toBe(0);
  });
});

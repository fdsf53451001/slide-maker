import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultStyle } from "@slide-maker/core";
import type { GenerationJob, ImageGenerationRequest, PresentationProject } from "@slide-maker/core";
import { LocalInpaintProvider } from "../src/local-inpaint.js";
import { withLocalInpaintEntry } from "../src/model-library-seed.js";
import { createApp } from "../src/app.js";
import type { RawOcrResult } from "../src/ocr.js";

/**
 * 以假 python（shell script）驗證 local-inpaint provider 的合約：
 * 機器輸出走「輸出檔案 + exit code」，成功時回 PNG bytes、失敗時帶 stderr 丟明確錯誤
 * （比照 ocr-adapter.test.ts 的 SLIDE_MAKER_* env 覆寫模式）。
 */
async function withFakeEngine<T>(scriptBody: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "slide-maker-fake-inpaint-"));
  const script = join(dir, "fake-inpaint.sh");
  await writeFile(script, `#!/bin/sh\n${scriptBody}\n`, "utf8");
  await chmod(script, 0o755);
  const previousPython = process.env.SLIDE_MAKER_INPAINT_PYTHON;
  const previousScript = process.env.SLIDE_MAKER_INPAINT_SCRIPT;
  process.env.SLIDE_MAKER_INPAINT_PYTHON = "/bin/sh";
  process.env.SLIDE_MAKER_INPAINT_SCRIPT = script;
  try {
    return await run(dir);
  } finally {
    if (previousPython === undefined) delete process.env.SLIDE_MAKER_INPAINT_PYTHON;
    else process.env.SLIDE_MAKER_INPAINT_PYTHON = previousPython;
    if (previousScript === undefined) delete process.env.SLIDE_MAKER_INPAINT_SCRIPT;
    else process.env.SLIDE_MAKER_INPAINT_SCRIPT = previousScript;
    await rm(dir, { recursive: true, force: true });
  }
}

async function smallPng(dir: string): Promise<string> {
  const path = join(dir, "result.png");
  await writeFile(
    path,
    await sharp({ create: { width: 4, height: 2, channels: 4, background: "#3355ff" } })
      .png()
      .toBuffer(),
  );
  return path;
}

function maskedEditRequest(basePath: string, maskPath: string): ImageGenerationRequest {
  return {
    projectId: "project",
    slide: {
      id: "slide",
      order: 0,
      purpose: "測試",
      content: "測試內容",
      narrative: "",
      layoutHint: "",
      imagePrompt: "",
      sourceIds: [],
      pinnedSourceIds: [],
      dataBasis: [],
      outlineDirty: false,
      versions: [],
    },
    style: createDefaultStyle(),
    width: 1920,
    height: 1080,
    references: [
      { path: basePath, mediaType: "image/png", role: "content" },
      { path: maskPath, mediaType: "image/png", role: "content" },
    ],
    model: "opencv-inpaint-telea-v2",
    parameters: {},
    edit: {
      instruction: "erase text",
      baseImageIndex: 0,
      maskImageIndex: 1,
      purpose: "text-removal",
    },
  };
}

describe("LocalInpaintProvider", () => {
  it("成功路徑：spawn 假 python 產出檔案並回傳 PNG bytes", async () => {
    await withFakeEngine("", async (dir) => {
      const png = await smallPng(dir);
      // argv = [script, base, mask, out]：對 /bin/sh 而言 $1=base、$2=mask、$3=out。
      await writeFile(join(dir, "fake-inpaint.sh"), `#!/bin/sh\ncp "${png}" "$3"\n`, "utf8");
      const provider = new LocalInpaintProvider({ root: dir });
      const result = await provider.generate(maskedEditRequest(png, png));
      expect(result.mediaType).toBe("image/png");
      expect(result.extension).toBe("png");
      expect(result.model).toBe("opencv-inpaint-telea-v2");
      // PNG magic bytes：jobs.ts 的 validatedOutput 也用同一個檢查。
      expect([...result.bytes.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
    });
  });

  it("python 失敗時丟出帶 stderr 的明確錯誤", async () => {
    await withFakeEngine(`echo "cv2 exploded" >&2\nexit 3`, async (dir) => {
      const png = await smallPng(dir);
      const provider = new LocalInpaintProvider({ root: dir });
      await expect(provider.generate(maskedEditRequest(png, png))).rejects.toThrow(
        /LOCAL_INPAINT_FAILED:.*cv2 exploded/,
      );
    });
  });

  it("拒絕非遮罩編輯請求（無 edit 或無 maskImageIndex）", async () => {
    await withFakeEngine("", async (dir) => {
      const png = await smallPng(dir);
      const provider = new LocalInpaintProvider({ root: dir });
      const { edit, ...requestWithoutEdit } = maskedEditRequest(png, png);
      await expect(provider.generate(requestWithoutEdit)).rejects.toThrow(
        /LOCAL_INPAINT_REQUIRES_MASKED_EDIT/,
      );
      const { maskImageIndex: _dropped, ...editWithoutMask } = edit!;
      await expect(
        provider.generate({ ...requestWithoutEdit, edit: editWithoutMask }),
      ).rejects.toThrow(/LOCAL_INPAINT_REQUIRES_MASKED_EDIT/);
    });
  });

  it("capabilities：只做遮罩編輯，不可整頁生成", async () => {
    await withFakeEngine("", async (dir) => {
      const provider = new LocalInpaintProvider({ root: dir });
      expect(provider.capabilities.fullSlideGeneration).toBe(false);
      expect(provider.capabilities.imageEditing).toBe(true);
      expect(provider.capabilities.maskedEditing).toBe(true);
    });
  });

  it("preflight：python 與腳本存在時 ready，缺一則 disabled", async () => {
    await withFakeEngine("", async (dir) => {
      const provider = new LocalInpaintProvider({ root: dir });
      expect((await provider.preflight()).status).toBe("ready");
    });
    const missing = new LocalInpaintProvider({ root: "/nonexistent-slide-maker-root" });
    expect((await missing.preflight()).status).toBe("disabled");
  });
});

describe("withLocalInpaintEntry migration", () => {
  it("為缺少 local-inpaint 的既有模型庫補上內建 entry，一次即冪等", () => {
    const library = {
      schemaVersion: 1 as const,
      connections: [],
      models: [],
      combinations: [],
      system: {},
      updatedAt: new Date().toISOString(),
    };
    const migrated = withLocalInpaintEntry(library);
    expect(migrated?.models.map((entry) => entry.id)).toEqual(["local-inpaint"]);
    expect(migrated?.models[0]).toMatchObject({ providerKind: "local", capability: "image" });
    expect(withLocalInpaintEntry(migrated!)).toBeUndefined();
  });
});

describe("extract-text route with local-inpaint (default engine)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  const fakeOcr = {
    status: async () => ({ available: true, message: "ok" }),
    recognize: async (): Promise<RawOcrResult> => ({
      width: 1920,
      height: 1080,
      boxes: [
        {
          text: "測試標題",
          confidence: 0.92,
          polygon: [
            [120, 120],
            [520, 120],
            [520, 190],
            [120, 190],
          ],
        },
      ],
    }),
  };

  it("不帶 providerId 時預設走 local-inpaint 並產出文字層版本", async () => {
    await withFakeEngine("", async (dir) => {
      const png = await smallPng(dir);
      await writeFile(join(dir, "fake-inpaint.sh"), `#!/bin/sh\ncp "${png}" "$3"\n`, "utf8");
      const app = await createApp(
        await mkdtemp(join(tmpdir(), "slide-maker-inpaint-route-")),
        stubEditorDist(),
        {
          ocr: fakeOcr,
        },
      );
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
      });
      const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
        const response = await fetch(`${baseUrl}${path}`, init);
        const body = (await response.json()) as T & { error?: string };
        if (!response.ok) throw new Error(body.error ?? String(response.status));
        return body;
      };
      let project = await json<PresentationProject>("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "本地抹字", brief: { desiredSlideCount: 1 } }),
      });
      await json<PresentationProject>(`/api/projects/${project.id}/outline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replace: true }),
      });
      const slideId = (await json<PresentationProject>(`/api/projects/${project.id}`)).slides[0]!
        .id;
      // 先用 mock-image 生一版當 base。
      await json<GenerationJob>(`/api/projects/${project.id}/slides/${slideId}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "mock-image" }),
      });
      await waitFor(async () => {
        project = await json<PresentationProject>(`/api/projects/${project.id}`);
        return project.slides[0]!.versions.length === 1;
      });

      const job = await json<GenerationJob>(
        `/api/projects/${project.id}/slides/${slideId}/extract-text`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      expect(job.providerId).toBe("local-inpaint");
      expect(job.operation).toBe("extract-text");
      await waitFor(async () => {
        project = await json<PresentationProject>(`/api/projects/${project.id}`);
        return project.jobs.find((item) => item.id === job.id)?.status === "completed";
      });
      const slide = project.slides[0]!;
      const extracted = slide.versions.find((version) => version.id === slide.currentVersionId);
      expect(extracted?.providerId).toBe("local-inpaint");
      expect(extracted?.textLayer?.boxes.length).toBeGreaterThan(0);
      expect(extracted?.textLayer?.boxes[0]?.text).toBeTruthy();

      // fullSlideGeneration=false：一般「重新生成圖片」不能用 local-inpaint。
      const denied = await fetch(
        `${baseUrl}/api/projects/${project.id}/slides/${slideId}/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "local-inpaint" }),
        },
      );
      expect(denied.status).toBe(409);
      expect(((await denied.json()) as { error?: string }).error).toBe(
        "FULL_SLIDE_GENERATION_UNSUPPORTED",
      );
    });
  }, 30_000);
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

function stubEditorDist(): string {
  // 路由測試不需要 editor build；指到不存在的目錄讓 createApp 走 503 分支。
  return join(tmpdir(), "slide-maker-no-editor-dist");
}

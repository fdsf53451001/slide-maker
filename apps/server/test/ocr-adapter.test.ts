import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaddleOcrAdapter } from "../src/ocr.js";

/**
 * 以假 python（shell script）驗證 recognize() 的 stdout 合約：
 * stdout 必須是單一行機器 JSON，任何污染都要嚴格丟 OCR_OUTPUT_INVALID
 * （合約由 scripts/paddle_ocr.py 的 fd 層級重導守住，server 端不做寬容解析）。
 */
async function createAdapter(scriptBody: string): Promise<{
  adapter: PaddleOcrAdapter;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "slide-maker-fake-ocr-"));
  const script = join(dir, "fake-ocr.sh");
  await writeFile(script, `#!/bin/sh\n${scriptBody}\n`, "utf8");
  await chmod(script, 0o755);
  const previousPython = process.env.SLIDE_MAKER_OCR_PYTHON;
  const previousScript = process.env.SLIDE_MAKER_OCR_SCRIPT;
  process.env.SLIDE_MAKER_OCR_PYTHON = "/bin/sh";
  process.env.SLIDE_MAKER_OCR_SCRIPT = script;
  try {
    return {
      adapter: new PaddleOcrAdapter(dir),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } finally {
    if (previousPython === undefined) delete process.env.SLIDE_MAKER_OCR_PYTHON;
    else process.env.SLIDE_MAKER_OCR_PYTHON = previousPython;
    if (previousScript === undefined) delete process.env.SLIDE_MAKER_OCR_SCRIPT;
    else process.env.SLIDE_MAKER_OCR_SCRIPT = previousScript;
  }
}

describe("PaddleOcrAdapter.recognize stdout contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("接受單行機器 JSON 的 stdout", async () => {
    const { adapter, cleanup } = await createAdapter(
      `echo '{"width":1920,"height":1080,"boxes":[{"text":"hi","confidence":0.9,"polygon":[[0,0],[10,0],[10,10],[0,10]]}]}'`,
    );
    try {
      const result = await adapter.recognize("ignored.png");
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.boxes).toHaveLength(1);
      expect(result.boxes[0]?.text).toBe("hi");
    } finally {
      await cleanup();
    }
  });

  it("stdout 前面帶垃圾行時嚴格丟 OCR_OUTPUT_INVALID，並記錄 stdout/stderr 預覽", async () => {
    // 重現 linux/amd64 上 Paddle C++／oneDNN 層直接對 OS fd 1 printf 的污染。
    const { adapter, cleanup } = await createAdapter(
      [
        `echo "ReduceMeanCheckIfOneDNNSupport"`,
        `echo "ReduceMeanCheckIfOneDNNSupport"`,
        `echo '{"width":1920,"height":1080,"boxes":[]}'`,
        `echo "some diagnostic" >&2`,
      ].join("\n"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(adapter.recognize("ignored.png")).rejects.toThrow("OCR_OUTPUT_INVALID");
      const logged = consoleError.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("ocr_output_invalid"));
      expect(logged).toBeDefined();
      const payload = JSON.parse(logged ?? "{}") as {
        stdoutPreview?: string;
        stderrPreview?: string;
      };
      expect(payload.stdoutPreview).toContain("ReduceMeanCheckIfOneDNNSupport");
      expect(payload.stderrPreview).toContain("some diagnostic");
    } finally {
      await cleanup();
    }
  });
});

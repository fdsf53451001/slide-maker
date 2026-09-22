import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TIMEOUT_MS,
  parseTimeoutMs,
  SlideMakerApiError,
  SlideMakerClient,
  StaticBearerAuthProvider,
} from "../src/client.js";

afterEach(() => vi.unstubAllGlobals());
const execFileAsync = promisify(execFile);

describe("SlideMakerClient", () => {
  it("拒絕 Node 無法正確排程的 timeout", () => {
    expect(parseTimeoutMs(undefined)).toBe(300_000);
    expect(parseTimeoutMs(String(MAX_TIMEOUT_MS))).toBe(MAX_TIMEOUT_MS);
    expect(() => parseTimeoutMs(String(MAX_TIMEOUT_MS + 1))).toThrow(/1 到 2147483647/);
    expect(() => parseTimeoutMs("0")).toThrow(/1 到 2147483647/);
  });

  it("呼叫 API 時合併 JSON 與驗證標頭", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "project-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlideMakerClient({
      baseUrl: "http://127.0.0.1:4173/",
      auth: new StaticBearerAuthProvider("secret-token"),
    });

    await expect(client.post("/api/projects", { topic: "MCP" })).resolves.toEqual({
      id: "project-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ topic: "MCP" }),
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      }),
    );
  });

  it("bearer token 只允許 HTTPS 或 loopback", () => {
    expect(
      () =>
        new SlideMakerClient({
          baseUrl: "http://api.example.com",
          auth: new StaticBearerAuthProvider("secret-token"),
        }),
    ).toThrow(/HTTPS 或本機網址/);
    expect(
      () =>
        new SlideMakerClient({
          baseUrl: "https://api.example.com",
          auth: new StaticBearerAuthProvider("secret-token"),
        }),
    ).not.toThrow();
    expect(
      () =>
        new SlideMakerClient({
          baseUrl: "http://localhost:4173",
          auth: new StaticBearerAuthProvider("secret-token"),
        }),
    ).not.toThrow();
  });

  it("保留 API 錯誤碼與可操作訊息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "TEXT_MODEL_NOT_FOUND",
            message: "請先設定文字模型",
            failures: [
              { url: "https://example.com", reason: "WEB_SOURCE_TIMEOUT" },
              { url: 123, reason: "invalid and must be dropped" },
            ],
            internal: "不可向 MCP 洩漏的任意欄位",
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    const client = new SlideMakerClient({ baseUrl: "http://127.0.0.1:4173" });

    const error = await client.post("/api/projects/p1/outline", {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(SlideMakerApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "TEXT_MODEL_NOT_FOUND",
      message: "請先設定文字模型",
      failures: [{ url: "https://example.com", reason: "WEB_SOURCE_TIMEOUT" }],
    });
  });

  it("只從素材根目錄上傳一般檔案", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slide-maker-mcp-sources-"));
    await writeFile(join(directory, "brief.md"), "# MCP");
    await symlink(join(directory, "brief.md"), join(directory, "linked.md"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "project-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlideMakerClient({
      baseUrl: "http://127.0.0.1:4173",
      sourceRoot: directory,
    });

    await expect(
      client.uploadSource("/api/projects/p1/sources?name=brief.md", "brief.md", "text/markdown"),
    ).resolves.toEqual({ response: { id: "project-1" }, bytes: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/projects/p1/sources?name=brief.md",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "text/markdown" },
        body: Buffer.from("# MCP"),
      }),
    );
    await expect(
      client.uploadSource("/api/projects/p1/sources", "../brief.md", "text/markdown"),
    ).rejects.toThrow(/單一檔名/);
    await expect(
      client.uploadSource("/api/projects/p1/sources", "linked.md", "text/markdown"),
    ).rejects.toThrow();
    if (process.platform !== "win32") {
      await execFileAsync("mkfifo", [join(directory, "pipe")]);
      await expect(
        client.uploadSource("/api/projects/p1/sources", "pipe", "application/octet-stream"),
      ).rejects.toThrow(/一般檔案/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("串流回應可寫入指定匯出檔", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
    const directory = await mkdtemp(join(tmpdir(), "slide-maker-mcp-"));
    const outputPath = "deck.pptx";
    const absolutePath = join(directory, outputPath);
    const client = new SlideMakerClient({
      baseUrl: "http://127.0.0.1:4173",
      exportRoot: directory,
    });

    await expect(client.exportToFile("/api/projects/p1/export/pptx", outputPath)).resolves.toEqual({
      path: absolutePath,
      bytes: 3,
    });
    expect(await readFile(absolutePath)).toEqual(Buffer.from([1, 2, 3]));
    await expect(client.exportToFile("/api/projects/p1/export/pptx", outputPath)).rejects.toThrow(
      /匯出檔案已存在/,
    );
  });

  it("匯出路徑不能逃出設定的根目錄", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const directory = await mkdtemp(join(tmpdir(), "slide-maker-mcp-root-"));
    const client = new SlideMakerClient({
      baseUrl: "http://127.0.0.1:4173",
      exportRoot: directory,
    });

    await expect(
      client.exportToFile("/api/projects/p1/export/pptx", "../outside.pptx"),
    ).rejects.toThrow(/匯出目錄內/);
    await expect(
      client.exportToFile("/api/projects/p1/export/pptx", "linked/escaped.pptx"),
    ).rejects.toThrow(/單一檔名/);
    await expect(
      client.exportToFile("/api/projects/p1/export/pptx", join(directory, "absolute.pptx")),
    ).rejects.toThrow(/相對路徑/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

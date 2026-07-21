import { afterEach, describe, expect, it, vi } from "vitest";
import { api, imageUrl } from "./api.js";

afterEach(() => vi.restoreAllMocks());

describe("imageUrl", () => {
  it("encodes the asset path and adds a stable cache-busting version", () => {
    expect(imageUrl("project id", "assets/slide id/version 1.png")).toBe(
      "/api/projects/project%20id/assets/slide%20id/version%201.png?v=version%201.png",
    );
  });
});

describe("request failures", () => {
  const failWith = (body: unknown, status = 400) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status })),
    );

  it("shows the server's sentence rather than the bare error code", async () => {
    // `PDF_ASPECT_UNSUPPORTED` 在匯入對話框（新使用者的第一個畫面）等於什麼都沒說。
    failWith({
      error: "PDF_ASPECT_UNSUPPORTED",
      message: "只能匯入 16:9 的簡報：這份 PDF 第一頁不是 16:9。",
    });
    await expect(api.getProject("p1")).rejects.toThrow(
      "只能匯入 16:9 的簡報：這份 PDF 第一頁不是 16:9。",
    );
    await expect(api.getProject("p1")).rejects.not.toThrow(/PDF_ASPECT_UNSUPPORTED/);
  });

  it("falls back to the code when the server has nothing to explain", async () => {
    failWith({ error: "NOT_FOUND" }, 404);
    await expect(api.getProject("p1")).rejects.toThrow("NOT_FOUND");
  });

  it("flattens zod issues so the user knows which field is invalid", async () => {
    failWith({
      error: "INVALID_REQUEST",
      issues: [{ path: ["purpose"], message: "String must contain at most 200 character(s)" }],
    });
    await expect(api.getProject("p1")).rejects.toThrow(/purpose: String must contain at most 200/);
  });
});

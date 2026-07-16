// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultStyle, type StylePreset, type StyleReferenceImage } from "@slide-maker/core";
import { StyleEditor } from "./StyleEditor.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("StyleEditor cover", () => {
  it("automatically selects the first uploaded image as the cover", async () => {
    const now = new Date().toISOString();
    const reference: StyleReferenceImage = {
      id: "first-reference",
      name: "first.png",
      mediaType: "image/png",
      assetPath: "assets/first-reference.png",
      createdAt: now,
    };
    let submitted: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path.startsWith("/api/style-assets")) return Response.json(reference, { status: 201 });
      if (path === "/api/styles" && init?.method === "POST") {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          ...createDefaultStyle(now),
          ...submitted,
          id: "custom-style",
          name: "測試風格",
          system: false,
          referenceImages: [reference],
          createdAt: now,
          updatedAt: now,
        } satisfies StylePreset, { status: 201 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<StyleEditor onSaved={vi.fn()} onExit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "測試風格" } });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "first.png", { type: "image/png" })] } });

    expect(await screen.findByAltText("first.png")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "設為卡片封面" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "建立風格" }));

    await waitFor(() => expect(submitted?.coverImageId).toBe(reference.id));
  });
});

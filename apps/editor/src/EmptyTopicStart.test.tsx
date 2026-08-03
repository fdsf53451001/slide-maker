// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProject, createDefaultStyle, type PresentationProject } from "@slide-maker/core";
import { Editor } from "./Editor.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

/*
  主畫面的「開始規劃」在需求空著時**不再停用**：想好了就先寫是捷徑，不是必填閘門。空著
  開始的專案直接進精靈，需求欄位在 STEP 2 以橘色外框標示尚未填寫，而「產生大綱」仍然
  擋著——沒有主題就沒有東西可以規劃。

  停用那顆按鈕的成本是使用者連專案都建不了：素材上傳、模型組合、風格挑選全都在專案裡面。
*/
const stubFetch = (
  onCreate: (body: Record<string, unknown>) => PresentationProject,
  seen: { body?: Record<string, unknown> },
) => {
  const now = new Date().toISOString();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    if (path === "/api/projects" && init?.method === "POST") {
      seen.body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json(onCreate(seen.body), { status: 201 });
    }
    if (path === "/api/projects") return Response.json([]);
    if (path === "/api/providers")
      return Response.json([
        {
          id: "mock-image",
          name: "Mock",
          availability: { status: "available" },
          capabilities: { fullSlideGeneration: true },
        },
      ]);
    if (path === "/api/styles") return Response.json([createDefaultStyle(now)]);
    if (path === "/api/model-library")
      return Response.json({ models: [], combinations: [], connections: [] });
    if (path.includes("/readiness"))
      return Response.json({
        providerId: "mock-image",
        status: "ready",
        blocking: false,
        requiresAcknowledgement: false,
        message: "Ready",
        checkedAt: now,
        expiresAt: now,
      });
    return Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("不填需求也能開始", () => {
  it("需求空著時「開始規劃」照樣可按，並以空白主題建立專案", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    stubFetch(() => createProject({ topic: "" }), seen);

    render(<Editor />);
    const start = await screen.findByRole("button", { name: "開始規劃 →" });
    // 這一顆以前在空白時是 disabled，使用者於是無法先建專案再去上傳素材。
    expect(start).toHaveProperty("disabled", false);
    // 空白時的說明要講出「可以直接開始」，否則看起來只是壞掉的必填欄位。
    expect(screen.getByText(/還沒想好也可以直接開始/)).toBeTruthy();

    fireEvent.click(start);
    await waitFor(() => expect(seen.body).toMatchObject({ topic: "" }));
    // 建完直接進精靈的需求步驟。
    await screen.findByText("STEP 2 · 需求");
  });

  it("精靈的簡報需求欄位空著時標成橘框並擋住下一步，填了就放行", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    stubFetch(() => createProject({ topic: "" }), seen);

    render(<Editor />);
    fireEvent.click(await screen.findByRole("button", { name: "開始規劃 →" }));
    // 主畫面那一格也叫「簡報需求」，等精靈出現再取，否則抓到的是還沒被換掉的舊畫面。
    await screen.findByText("STEP 2 · 需求");

    const topicField = screen.getByLabelText("簡報需求") as HTMLTextAreaElement;
    expect(topicField.value).toBe("");
    // 提示句在 label 外面，欄位的無障礙名稱因此仍然只是「簡報需求」。
    expect(topicField.closest(".field-needs-input")).toBeTruthy();
    // 停用的按鈕不會說明自己為什麼停用，提示句要在欄位旁邊、而且讀得到。
    const hint = screen.getByText(/尚未填寫：描述這份簡報要說什麼/);
    expect(topicField.getAttribute("aria-describedby")).toBe(hint.id);
    const next = screen.getByRole("button", { name: /下一步：上傳素材/ });
    expect(next).toHaveProperty("disabled", true);

    fireEvent.change(topicField, { target: { value: "向主管說明導入計畫" } });
    expect(topicField.closest(".field-needs-input")).toBeNull();
    expect(screen.queryByText(/尚未填寫：描述這份簡報要說什麼/)).toBeNull();
    expect(screen.getByRole("button", { name: /下一步：上傳素材/ })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("從步驟列跳到上傳素材時，缺需求的原因仍然講得出來", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    stubFetch(() => createProject({ topic: "" }), seen);

    render(<Editor />);
    fireEvent.click(await screen.findByRole("button", { name: "開始規劃 →" }));
    await screen.findByText("STEP 2 · 需求");

    // 步驟列在有大綱（建立專案時就有佔位頁）時每一步都點得到，所以 STEP 3 進得去。
    fireEvent.click(
      screen.getAllByRole("button").find((button) => button.textContent === "3上傳素材")!,
    );
    await screen.findByText("STEP 3 · 上傳素材");

    const hint = screen.getByText(/尚未填寫簡報需求，請回到「需求」步驟補上/);
    const generate = screen.getByRole("button", { name: /產生 .* 頁大綱/ });
    expect(generate).toHaveProperty("disabled", true);
    expect(generate.getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
  });
});

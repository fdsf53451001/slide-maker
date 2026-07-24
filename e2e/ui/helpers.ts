import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  pageNumberLabel,
  pageNumberLayout,
  type PageNumberSettings,
  type PresentationProject,
} from "@slide-maker/core";

export { pageNumberLabel, pageNumberLayout };
export type { PageNumberSettings, PresentationProject };

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../..");

// pdf-lib is a dependency of @slide-maker/server, not the editor. Resolve it
// from the server package rather than adding a heavy new devDependency.
const requireFromServer = createRequire(resolve(repoRoot, "apps/server/") + "/");

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function json<T>(
  request: APIRequestContext,
  method: "get" | "post" | "patch" | "put" | "delete",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await request[method](path, body === undefined ? {} : { data: body });
  if (!response.ok()) {
    throw new Error(
      `${method.toUpperCase()} ${path} -> ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/** Create a project. Slides are created eagerly from the brief (no network). */
export async function createProject(
  request: APIRequestContext,
  options: { topic?: string; slideCount?: number } = {},
): Promise<PresentationProject> {
  return json<PresentationProject>(request, "post", "/api/projects", {
    topic: options.topic ?? "E2E 主題",
    brief: { desiredSlideCount: options.slideCount ?? 3, webSearchMode: "disabled" },
  });
}

/** Poll the project until every slide has a current version and no job is active. */
export async function waitForGeneration(
  request: APIRequestContext,
  projectId: string,
  timeoutMs = 20_000,
): Promise<PresentationProject> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const project = await json<PresentationProject>(request, "get", `/api/projects/${projectId}`);
    const jobs = project.jobs ?? [];
    const active = jobs.some((job) => job.status === "queued" || job.status === "running");
    const failed = jobs.filter((job) => job.status === "failed");
    if (failed.length) {
      throw new Error(`Generation job failed: ${failed.map((j) => j.errorCode ?? "?").join(", ")}`);
    }
    const allHaveVersions = project.slides.every((slide) => Boolean(slide.currentVersionId));
    if (!active && allHaveVersions) return project;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForGeneration timed out; active=${active} slidesWithVersion=` +
          `${project.slides.filter((s) => s.currentVersionId).length}/${project.slides.length}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Create a project, generate every slide with mock-image, and wait for completion. */
export async function seedGeneratedProject(
  request: APIRequestContext,
  options: { topic?: string; slideCount?: number } = {},
): Promise<PresentationProject> {
  const project = await createProject(request, options);
  await json(request, "post", `/api/projects/${project.id}/generate`, {
    acceptUnknownReadiness: true,
  });
  return waitForGeneration(request, project.id);
}

export async function setPageNumber(
  request: APIRequestContext,
  projectId: string,
  patch: Partial<PageNumberSettings> & { background?: Partial<PageNumberSettings["background"]> },
): Promise<PresentationProject> {
  return json<PresentationProject>(
    request,
    "patch",
    `/api/projects/${projectId}/page-number`,
    patch,
  );
}

export async function getProject(
  request: APIRequestContext,
  projectId: string,
): Promise<PresentationProject> {
  return json<PresentationProject>(request, "get", `/api/projects/${projectId}`);
}

/** Build a deterministic N-page 16:9 (1280x720, ratio 1.7778) PDF with real text. */
export async function makeDeckPdf(pages = 4): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = requireFromServer("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const W = 1280;
  const H = 720;
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.1, 0.12 + i * 0.08, 0.32) });
    page.drawText(`E2E Deck Page ${i}`, { x: 120, y: 480, size: 60, font, color: rgb(1, 1, 1) });
    page.drawText(`Body content for page ${i}`, {
      x: 120,
      y: 360,
      size: 30,
      font,
      color: rgb(0.9, 0.9, 0.9),
    });
  }
  return doc.save();
}

/** Import a deck PDF through the real server route; returns the created project. */
export async function importDeck(
  request: APIRequestContext,
  options: { name?: string; pages?: number } = {},
): Promise<PresentationProject> {
  const pageCount = options.pages ?? 4;
  const bytes = await makeDeckPdf(pageCount);
  const response = await request.post("/api/pdf-deck/import", {
    headers: { "content-type": "application/pdf" },
    params: {
      name: options.name ?? "E2E 匯入簡報",
      pages: Array.from({ length: pageCount }, (_, i) => i + 1).join(","),
    },
    data: Buffer.from(bytes),
  });
  if (!response.ok()) {
    throw new Error(`import deck failed ${response.status()}: ${await response.text()}`);
  }
  const project = ((await response.json()) as { project: PresentationProject }).project;
  // Imports land in the "settings" analysis screen; move to "editing" so a
  // deep link opens the editor shell directly.
  return json<PresentationProject>(request, "patch", `/api/projects/${project.id}/workflow-stage`, {
    workflowStage: "editing",
  });
}

/**
 * The px→DOM frame for page-number geometry is the `.page-number-layer`
 * element, which is `inset:0` inside the canvas *content* box. Using that rect
 * (rather than `.canvas`'s border-box) cancels the canvas's 1px border so the
 * conversion is exact.
 */
export function expectedTextBox(
  settings: PageNumberSettings,
  canvas: { width: number; height: number },
  label: string,
  frame: Rect,
): Rect {
  const { text } = pageNumberLayout(settings, canvas, label);
  return {
    x: frame.x + (text.x / canvas.width) * frame.width,
    y: frame.y + (text.y / canvas.height) * frame.height,
    width: (text.width / canvas.width) * frame.width,
    height: (text.height / canvas.height) * frame.height,
  };
}

/** Read a client rect for a selector, relative to the viewport. */
export async function rectOf(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  return box;
}

export function assertRatio(rect: Rect, expected: number, tolerancePx = 0.5): void {
  const idealWidth = rect.height * expected;
  expect(
    Math.abs(rect.width - idealWidth),
    `ratio ${(rect.width / rect.height).toFixed(5)} vs ${expected.toFixed(5)} ` +
      `(w=${rect.width.toFixed(2)} h=${rect.height.toFixed(2)}, width off by ${(rect.width - idealWidth).toFixed(3)}px)`,
  ).toBeLessThanOrEqual(tolerancePx);
}

/** One axis must fill its container to prove there is no wasted letterbox. */
export function assertNoLetterbox(inner: Rect, container: Rect, tolerancePx = 1.5): void {
  const fillsWidth = Math.abs(inner.width - container.width) <= tolerancePx;
  const fillsHeight = Math.abs(inner.height - container.height) <= tolerancePx;
  expect(
    fillsWidth || fillsHeight,
    `expected inner ${inner.width.toFixed(1)}x${inner.height.toFixed(1)} to fill one axis of ` +
      `${container.width.toFixed(1)}x${container.height.toFixed(1)}`,
  ).toBeTruthy();
}

export function expectWithin(rect: Rect, container: Rect, tolerancePx = 1.5): void {
  expect(rect.x, "left edge inside container").toBeGreaterThanOrEqual(container.x - tolerancePx);
  expect(rect.y, "top edge inside container").toBeGreaterThanOrEqual(container.y - tolerancePx);
  expect(rect.x + rect.width, "right edge inside container").toBeLessThanOrEqual(
    container.x + container.width + tolerancePx,
  );
  expect(rect.y + rect.height, "bottom edge inside container").toBeLessThanOrEqual(
    container.y + container.height + tolerancePx,
  );
}

/**
 * Neutralize the Fullscreen API so presentation mode stays open deterministically
 * under headless Chromium. We test DOM layout, not the browser's fullscreen; the
 * app's own fullscreenchange listener would otherwise close the overlay when a
 * headless requestFullscreen resolves without a real fullscreen element.
 */
export async function stubFullscreen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).requestFullscreen = function () {
      return Promise.resolve();
    };
    Object.defineProperty(document, "exitFullscreen", {
      value: () => Promise.resolve(),
      configurable: true,
    });
  });
}

/** Open a project directly in the editor and wait for the shell + a rendered image. */
export async function openEditor(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await page.locator(".shell").waitFor();
  await page.locator(".canvas img").first().waitFor();
}

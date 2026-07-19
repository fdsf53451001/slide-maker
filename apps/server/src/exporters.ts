import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { PDFDocument } from "pdf-lib";
import PptxGenJS from "pptxgenjs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { parseProject, type PresentationProject } from "@slide-maker/core";
import type { FileProjectRepository } from "./repository.js";

export type ExportFormat = "pptx" | "pdf" | "png.zip" | "slide-project";

type PptxGenJSConstructor = typeof PptxGenJS;

export function resolvePptxConstructor(candidate: unknown): PptxGenJSConstructor {
  let current = candidate;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === "function") return current as PptxGenJSConstructor;
    if (!current || typeof current !== "object" || !("default" in current)) break;
    current = (current as { default: unknown }).default;
  }
  throw new Error("PPTX_EXPORTER_UNAVAILABLE");
}

function currentVersions(project: PresentationProject) {
  return [...project.slides]
    .sort((a, b) => a.order - b.order)
    .map((slide) => {
      const version = slide.versions.find((candidate) => candidate.id === slide.currentVersionId);
      if (!version) throw new Error(`SLIDE_VERSION_MISSING:${slide.order + 1}`);
      return { slide, version };
    });
}

async function pngFor(
  repository: FileProjectRepository,
  project: PresentationProject,
  imagePath: string,
): Promise<Uint8Array> {
  const relativePath = imagePath.replace(/^assets\//, "");
  const bytes = new Uint8Array(await readFile(repository.assetPath(project.id, relativePath)));
  if (imagePath.toLowerCase().endsWith(".svg")) {
    return new Resvg(Buffer.from(bytes), { fitTo: { mode: "width", value: project.canvas.width } })
      .render()
      .asPng();
  }
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return bytes;
  throw new Error("EXPORT_IMAGE_UNSUPPORTED");
}

async function exportPngZip(
  repository: FileProjectRepository,
  project: PresentationProject,
): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const { slide, version } of currentVersions(project))
    entries[`${String(slide.order + 1).padStart(3, "0")}.png`] = await pngFor(
      repository,
      project,
      version.imagePath,
    );
  return zipSync(entries, { level: 6 });
}

async function exportPdf(
  repository: FileProjectRepository,
  project: PresentationProject,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const { version } of currentVersions(project)) {
    const bytes = await pngFor(repository, project, version.imagePath);
    const image = await pdf.embedPng(bytes);
    const page = pdf.addPage([960, 540]);
    page.drawImage(image, { x: 0, y: 0, width: 960, height: 540 });
  }
  pdf.setTitle(project.name);
  pdf.setCreator("Slide Maker");
  return pdf.save({ useObjectStreams: false });
}

export async function compressPptxImage(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(bytes).jpeg({ quality: 88, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer(),
  );
}

async function exportPptx(
  repository: FileProjectRepository,
  project: PresentationProject,
): Promise<Uint8Array> {
  const PptxConstructor = resolvePptxConstructor(PptxGenJS);
  const pptx = new PptxConstructor();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Slide Maker";
  pptx.subject = project.brief.topic;
  pptx.title = project.name;
  for (const { version } of currentVersions(project)) {
    const backgroundPath = version.textLayer?.backgroundPath ?? version.imagePath;
    const bytes = await pngFor(repository, project, backgroundPath);
    // Full-slide artwork is opaque. JPEG is dramatically smaller than the
    // generated PNG while 4:4:4 preserves coloured text and fine UI lines.
    const compressed = await compressPptxImage(bytes);
    const slide = pptx.addSlide();
    slide.background = { color: "000000" };
    slide.addImage({
      data: `data:image/jpeg;base64,${Buffer.from(compressed).toString("base64")}`,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
    });
    if (version.textLayer) {
      const scaleX = 13.333 / project.canvas.width;
      const scaleY = 7.5 / project.canvas.height;
      for (const box of version.textLayer.boxes.filter(
        (candidate) => candidate.role === "presentation",
      )) {
        const fontSizePt = box.fontSize * scaleY * 72;
        // 框寬是貼齊字墨的緊框，而 PowerPoint 的 CJK 字型 advance 比量測略寬，
        // 原寬會觸發自動換行讓整段文字跑版：加 1em 餘裕並關閉換行。
        // center/right 對齊時餘裕要往左補回，否則錨點跟著位移。
        const extraWidth = box.fontSize * scaleX;
        const shiftX =
          box.align === "center" ? extraWidth / 2 : box.align === "right" ? extraWidth : 0;
        slide.addText(box.text, {
          x: Math.max(0, box.x * scaleX - shiftX),
          y: box.y * scaleY,
          w: box.width * scaleX + extraWidth,
          h: box.height * scaleY,
          fontFace: box.fontFamily,
          fontSize: fontSizePt,
          bold: box.fontWeight >= 600,
          color: box.color.slice(1),
          transparency: Math.round((1 - box.opacity) * 100),
          align: box.align,
          valign: box.verticalAlign,
          margin: 0,
          breakLine: false,
          wrap: false,
          // 行距鎖定為編輯器的 CSS line-height 模型；不設的話 PowerPoint 用
          // 字型自身行距（CJK 字型常達 1.3–1.4 em），多行文字會越排越低。
          lineSpacing: fontSizePt * box.lineHeight,
          rotate: box.rotation,
          charSpacing: box.letterSpacing * scaleX * 72,
          // 不用 fit:"shrink"——autofit 在 PowerPoint／Keynote／LibreOffice 的
          // 縮放行為不一致，是文字跑版的另一來源。
        });
      }
    }
    if (version.sources.length)
      slide.addNotes(
        version.sources
          .map(
            (source) =>
              `${source.title}${source.locator ? ` — ${source.locator}` : ""}${source.url ? ` — ${source.url}` : ""}`,
          )
          .join("\n"),
      );
  }
  const output = await pptx.write({ outputType: "nodebuffer" });
  return new Uint8Array(output as ArrayBuffer);
}

async function collectFiles(
  root: string,
  directory = root,
  entries: Record<string, Uint8Array> = {},
): Promise<Record<string, Uint8Array>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectFiles(root, path, entries);
    else if (entry.isFile())
      entries[relative(root, path).split(sep).join("/")] = new Uint8Array(await readFile(path));
  }
  return entries;
}

async function exportProject(
  repository: FileProjectRepository,
  project: PresentationProject,
): Promise<Uint8Array> {
  const entries = await collectFiles(repository.projectRoot(project.id));
  entries["project.json"] = strToU8(`${JSON.stringify(project, null, 2)}\n`);
  return zipSync(entries, { level: 6 });
}

export async function exportPresentation(
  repository: FileProjectRepository,
  project: PresentationProject,
  format: ExportFormat,
): Promise<Uint8Array> {
  if (format === "png.zip") return exportPngZip(repository, project);
  if (format === "pdf") return exportPdf(repository, project);
  if (format === "pptx") return exportPptx(repository, project);
  return exportProject(repository, project);
}

export function parseProjectBundle(bytes: Uint8Array): {
  project: PresentationProject;
  assets: Record<string, Uint8Array>;
} {
  if (bytes.length > 2 * 1024 * 1024 * 1024) throw new Error("PROJECT_BUNDLE_TOO_LARGE");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("PROJECT_BUNDLE_INVALID");
  }
  const projectFile = files["project.json"];
  if (!projectFile) throw new Error("PROJECT_BUNDLE_INVALID");
  for (const name of Object.keys(files)) {
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))
      throw new Error("PROJECT_BUNDLE_UNSAFE_PATH");
  }
  const project = parseProject(JSON.parse(Buffer.from(projectFile).toString("utf8")));
  const assets = Object.fromEntries(
    Object.entries(files).filter(([name]) => name.startsWith("assets/") && !name.endsWith("/")),
  );
  return { project, assets };
}

export function exportFilename(project: PresentationProject, format: ExportFormat): string {
  const safe =
    basename(project.name)
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "presentation";
  return `${safe}.${format}`;
}

import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { PDFDocument } from "pdf-lib";
import PptxGenJS from "pptxgenjs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import sharp, { type Sharp } from "sharp";
import {
  pageNumberLabel,
  pageNumberLayout,
  parseProject,
  type PresentationProject,
} from "@slide-maker/core";
import { textElements } from "./text-layers.js";
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

/**
 * 系統合成頁碼的疊圖（PNG zip 與 PDF 共用）。
 *
 * 幾何與文字都來自 core 的 `pageNumberLayout`，與編輯器預覽及 PPTX 用的是同一份計算；
 * 這裡只負責把它翻成 SVG。這一頁不編號時回傳 `undefined`，呼叫端據此完全跳過 sharp。
 */
export function pageNumberSvg(project: PresentationProject, order: number): Buffer | undefined {
  const label = pageNumberLabel(project.pageNumber, order, project.slides.length);
  if (!label) return undefined;
  const { text, chip } = pageNumberLayout(project.pageNumber, project.canvas, label);
  const rect = chip
    ? `<rect x="${chip.x}" y="${chip.y}" width="${chip.width}" height="${chip.height}" rx="${chip.radius}" ry="${chip.radius}" fill="${chip.color}" fill-opacity="${chip.opacity}"/>`
    : "";
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${project.canvas.width}" height="${project.canvas.height}" viewBox="0 0 ${project.canvas.width} ${project.canvas.height}">${rect}${textElements([text])}</svg>`,
  );
}

/**
 * 把頁碼疊圖接到底圖上，但**不決定輸出編碼**——由呼叫端接 `.png()` 或 `compressSlideImage()`
 * 收尾，避免「先編一次 PNG 再解開重編 JPEG」那份立刻被丟棄的中間產物。
 */
function compositePageNumber(project: PresentationProject, bytes: Uint8Array, svg: Buffer): Sharp {
  return (
    sharp(bytes)
      // 幾何是畫布座標系的，底圖必須先對齊畫布尺寸——比 renderComposite 少這一步的話，
      // 尺寸不符的素材會讓 sharp 直接以「疊圖比底圖大」報錯，而不是畫歪一點。
      .resize(project.canvas.width, project.canvas.height, { fit: "fill" })
      .composite([{ input: svg, blend: "over" }])
  );
}

/**
 * 把系統合成的頁碼疊到整版圖上並輸出 PNG（`png.zip` 專用）。
 *
 * 這一頁不編號時**原樣回傳同一批位元組**，連 sharp 都不會走一趟：`png.zip` 對「沒有頁碼」
 * 的頁面是原圖保真（PDF 匯入的原圖保真承諾就靠這條），不能退化成「一律過一次 sharp」。
 */
export async function withPageNumber(
  project: PresentationProject,
  order: number,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const svg = pageNumberSvg(project, order);
  if (!svg) return bytes;
  return new Uint8Array(await compositePageNumber(project, bytes, svg).png().toBuffer());
}

async function exportPngZip(
  repository: FileProjectRepository,
  project: PresentationProject,
): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const { slide, version } of currentVersions(project))
    entries[`${String(slide.order + 1).padStart(3, "0")}.png`] = await withPageNumber(
      project,
      slide.order,
      await pngFor(repository, project, version.imagePath),
    );
  return zipSync(entries, { level: 6 });
}

async function exportPdf(
  repository: FileProjectRepository,
  project: PresentationProject,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const { slide, version } of currentVersions(project)) {
    // 這裡刻意用 version.imagePath 而非 PPTX 的 textLayer.backgroundPath：PDF 沒有可編輯
    // 文字物件，頁面要的是含文字的合成圖，不是抹字後的背景。
    const bytes = await pngFor(repository, project, version.imagePath);
    const svg = pageNumberSvg(project, slide.order);
    // 比照 PPTX：整版圖以 JPEG 內嵌，體積差一個數量級。有頁碼時把疊圖併進同一條 sharp
    // pipeline 收尾——PDF 只要最後那份 JPEG，先編一份 PNG 再解開重編是白做的
    // （1920×1080 實測每頁多花 73 ms 與一份 2.3 MB 暫存 buffer，輸出位元完全相同）。
    const image = await pdf.embedJpg(
      await compressSlideImage(svg ? compositePageNumber(project, bytes, svg) : bytes),
    );
    const page = pdf.addPage([960, 540]);
    page.drawImage(image, { x: 0, y: 0, width: 960, height: 540 });
  }
  pdf.setTitle(project.name);
  pdf.setCreator("Slide Maker");
  return pdf.save({ useObjectStreams: false });
}

/**
 * 整版投影片圖的匯出用壓縮（PPTX 與 PDF 共用）。
 *
 * JPEG 沒有 alpha 通道，sharp 遇到帶 alpha 的來源會直接**丟棄**通道而非合成，等於拿沒有
 * 預乘的 RGB 當結果；因此先顯式 flatten 到黑底再編碼。選黑是為了對齊 PPTX 既有的選擇
 * （每張投影片都墊 `background = { color: "000000" }`），而 PDF 頁面預設是白底——不顯式
 * flatten 的話，同一張半透明圖在兩種格式會落在不同底色上。
 *
 * 4:4:4 不做色度次取樣：投影片滿是彩色細字與細線，次取樣會讓它們糊掉。
 *
 * 收 `Sharp` pipeline 是為了讓 PDF 那條「先疊頁碼再壓縮」的路能共用同一份 flatten／JPEG 參數，
 * 而不是在呼叫端手抄第二份——參數只該有這一個定義點。
 */
export async function compressSlideImage(source: Uint8Array | Sharp): Promise<Uint8Array> {
  return new Uint8Array(
    await (source instanceof Uint8Array ? sharp(source) : source)
      .flatten({ background: "#000000" })
      .jpeg({ quality: 88, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer(),
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
  for (const { slide: spec, version } of currentVersions(project)) {
    const backgroundPath = version.textLayer?.backgroundPath ?? version.imagePath;
    const bytes = await pngFor(repository, project, backgroundPath);
    const compressed = await compressSlideImage(bytes);
    const slide = pptx.addSlide();
    slide.background = { color: "000000" };
    slide.addImage({
      data: `data:image/jpeg;base64,${Buffer.from(compressed).toString("base64")}`,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
    });
    const scaleX = 13.333 / project.canvas.width;
    const scaleY = 7.5 / project.canvas.height;
    if (version.textLayer) {
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
        // 底色是獨立的矩形，畫在文字之前，用框的**原始**幾何。不能改用 addText 的 fill：
        // 文字框為了防 CJK 自動換行加了 extraWidth 餘裕與 shiftX 位移，直接填色會讓色塊
        // 變寬且水平偏移，與 SVG／DOM 兩端對不上。
        //
        // 已知限制（未旋轉時不存在，因此保留現狀）：OOXML 的 rot 是繞各自框的中心轉，
        // 而上面那道單邊加寬讓文字框中心離開了框中心 extraWidth/2（left 往右、right 往左，
        // 只有 center 剛好抵銷），所以**旋轉**的框在 PPTX 裡底色與文字會脫開
        //（位移 Δ·2·sin(θ/2)，1920 畫布、72px 字、90° 約 51px）；SVG 與 DOM 兩端則共用
        // 框中心、不受影響。目前編輯器沒有旋轉控制項，boxesFromOcr／PDF 匯入／「＋文字框」
        // 一律給 rotation: 0，只有手改 project.json 才碰得到。要修的話得把餘裕改成左右對稱
        // 再用 margin 把文字起點推回邊上——那會改動已被 ocr-geometry-roundtrip 與
        // pdf-import-qa 釘住的文字落點模型（兩者都假設 margin 為 0），必須連同真機驗證
        // 一起做，不是這裡順手改得動的。
        if (box.backgroundColor) {
          slide.addShape("rect", {
            x: box.x * scaleX,
            y: box.y * scaleY,
            w: box.width * scaleX,
            h: box.height * scaleY,
            rotate: box.rotation,
            fill: {
              color: box.backgroundColor.slice(1),
              transparency: Math.round((1 - (box.backgroundOpacity ?? 1)) * 100),
            },
          });
        }
        slide.addText(box.text, {
          // 不夾到 0：貼著畫布左緣的 center／right 框，往左補回的餘裕會被夾掉，
          // 錨點整個右移（實測 60px 字級的框偏 41px）。OOXML 的 a:off 允許負值，
          // 框超出投影片左緣不影響文字落點。
          x: box.x * scaleX - shiftX,
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
    // 頁碼是專案級的系統合成物，與這一頁有沒有可編輯文字層無關，因此獨立於上面的迴圈。
    const pageLabel = pageNumberLabel(project.pageNumber, spec.order, project.slides.length);
    if (pageLabel) {
      const { text, chip } = pageNumberLayout(project.pageNumber, project.canvas, pageLabel);
      const fontSizePt = text.fontSize * scaleY * 72;
      // 有色塊時直接用色塊幾何當文字框——色塊是看得見的東西，寬度必須與 SVG／DOM 兩端
      // 逐點一致，所以這裡不加 extraWidth 餘裕（那會讓填色跟著變寬）。
      // 沒有色塊時框是隱形的，就沿用文字層那套全寬對齊＋1em 餘裕防換行的規則。
      const extraWidth = chip ? 0 : text.fontSize * scaleX;
      const shiftX =
        text.align === "center" ? extraWidth / 2 : text.align === "right" ? extraWidth : 0;
      // 文字對齊方式三端一律相同。色塊只是依「近似」字寬往外墊 padX，若這裡改成置中，
      // 近似寬與 PowerPoint 真實字寬的落差（Arial 實測 8–17%）就會直接變成水平位移；
      // 沿用 text.align 再把色塊內距補回去，文字起點才會落回和 SVG／DOM 相同的邊距上。
      // pptxgenjs 4.0.1 的 margin 陣列實際順序是 [左, 右, 下, 上]（與其 JSDoc 不符，
      // 見 dist/pptxgen.cjs.js 的 lIns/rIns/bIns/tIns 指派）；上下取 0，避免壓縮字框高度。
      const marginPt = chip ? chip.padX * scaleX * 72 : 0;
      slide.addText(pageLabel, {
        x: (chip ? chip.x : text.x) * scaleX - shiftX,
        y: (chip ? chip.y : text.y) * scaleY,
        w: (chip ? chip.width : text.width) * scaleX + extraWidth,
        h: (chip ? chip.height : text.height) * scaleY,
        fontFace: text.fontFamily,
        fontSize: fontSizePt,
        color: text.color.slice(1),
        transparency: Math.round((1 - text.opacity) * 100),
        align: text.align,
        valign: "middle",
        margin: [marginPt, marginPt, 0, 0],
        breakLine: false,
        wrap: false,
        lineSpacing: fontSizePt * text.lineHeight,
        ...(chip
          ? {
              shape: "roundRect" as const,
              // rectRadius 的單位是英吋（pptxgenjs 換算成 roundRect 的 adj 比例）。
              rectRadius: (chip.height / 2) * scaleY,
              fill: {
                color: chip.color.slice(1),
                transparency: Math.round((1 - chip.opacity) * 100),
              },
            }
          : {}),
      });
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

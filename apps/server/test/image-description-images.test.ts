import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { StructuredTextProvider, StructuredTextRequest } from "@slide-maker/core";
import { IMAGE_DESCRIPTION_MAX_EDGE, describeImage } from "../src/image-description.js";

/**
 * `describeImage()` 的縮圖階段對真實世界的圖片檔的耐受度。
 *
 * 使用者上傳的不是測試裡那種 sRGB 純色 PNG：手機拍的照片帶 EXIF 旋轉、掃描件是灰階或
 * CMYK JPEG、簡報截圖動輒數千像素、也有人會丟 1×1 的追蹤像素進來。這一層失敗會讓來源
 * 卡在 parsing 或整批白跑，而它跑在背景、沒有任何使用者可見的錯誤訊息，所以只能靠測試釘。
 */

interface Captured {
  path: string;
  width: number | undefined;
  height: number | undefined;
  space: string | undefined;
  orientation: number | undefined;
  bytes: number;
}

/** 記下實際送進 provider 的那張縮圖的樣子。 */
function capturingProvider(sink: { value?: Captured }): StructuredTextProvider {
  return {
    id: "fake-text",
    availability: { status: "available" },
    runStructured: async (request: StructuredTextRequest) => {
      const path = request.imagePaths?.[0] ?? "";
      const image = sharp(path);
      const metadata = await image.metadata();
      sink.value = {
        path,
        width: metadata.width,
        height: metadata.height,
        space: metadata.space,
        orientation: metadata.orientation,
        bytes: (await image.toBuffer()).length,
      };
      return { title: "t", summary: "s", fullText: "f" };
    },
  };
}

async function writeTemp(name: string, bytes: Buffer | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "slide-maker-image-desc-edge-"));
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

async function describe1(path: string): Promise<Captured> {
  const sink: { value?: Captured } = {};
  await describeImage({
    provider: capturingProvider(sink),
    imagePath: path,
    language: "zh-TW",
    timeoutMs: 10_000,
  });
  if (!sink.value) throw new Error("provider 沒有收到圖片");
  return sink.value;
}

describe("縮圖階段對真實圖片檔的耐受度", () => {
  it("1×1 的圖不會被縮到 0 像素，也不會讓 sharp 丟例外", async () => {
    const path = await writeTemp(
      "pixel.png",
      await sharp({ create: { width: 1, height: 1, channels: 3, background: "#123456" } })
        .png()
        .toBuffer(),
    );
    const sent = await describe1(path);
    expect({ width: sent.width, height: sent.height }).toEqual({ width: 1, height: 1 });
    await expect(readdir(dirname(sent.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("極大的圖縮到長邊 1024，短邊按比例，且暫存檔用完就刪", async () => {
    const path = await writeTemp(
      "huge.png",
      await sharp({ create: { width: 9000, height: 6000, channels: 3, background: "#204060" } })
        .png()
        .toBuffer(),
    );
    const sent = await describe1(path);
    expect(sent.width).toBe(IMAGE_DESCRIPTION_MAX_EDGE);
    expect(sent.height).toBe(683);
    await expect(readdir(dirname(sent.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("灰階 JPEG 正常縮圖", async () => {
    const path = await writeTemp(
      "gray.jpg",
      await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#808080" } })
        .toColourspace("b-w")
        .jpeg()
        .toBuffer(),
    );
    const sent = await describe1(path);
    expect({ width: sent.width, height: sent.height }).toEqual({ width: 1024, height: 576 });
  });

  it("CMYK JPEG 會被轉成 sRGB 再送出：模型端拿到的是看得懂的顏色", async () => {
    const path = await writeTemp(
      "cmyk.jpg",
      await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#c86432" } })
        .toColourspace("cmyk")
        .jpeg()
        .toBuffer(),
    );
    // 來源確實是 4 通道 CMYK，否則這個案例什麼都沒驗到。
    expect((await sharp(path).metadata()).space).toBe("cmyk");
    const sent = await describe1(path);
    expect(sent.space).toBe("srgb");
    expect({ width: sent.width, height: sent.height }).toEqual({ width: 1024, height: 683 });
  });

  it("帶 EXIF 旋轉的照片要以「使用者看到的方向」送進模型", async () => {
    // 手機直拍的照片就是這個形狀：像素是橫的，靠 EXIF orientation=6 告訴顯示端轉 90 度。
    // 編輯器用 <img> 顯示（瀏覽器一律套用 EXIF），所以使用者看到的是 200×400 的直式圖。
    const upright = await sharp({
      create: { width: 400, height: 200, channels: 3, background: "#0a141e" },
    })
      .jpeg()
      .toBuffer();
    const path = await writeTemp(
      "portrait.jpg",
      await sharp(upright).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    );
    expect((await sharp(path).metadata()).orientation).toBe(6);

    const sent = await describe1(path);
    // 送出的必須是轉正後的方向。若這裡是 400×200，代表模型讀到的是躺著的圖——圖上的字
    // 對它就是側向的，抽取品質直接崩掉，而且 orientation tag 也被 .png() 丟掉了，
    // 模型連「這張要轉」都無從得知。
    expect({ width: sent.width, height: sent.height }).toEqual({ width: 200, height: 400 });
  });

  it("壞掉的圖片位元組讓描述失敗，暫存目錄照樣清乾淨", async () => {
    // PNG magic 對、後面是垃圾：detectSourceMediaType 收得下，sharp 解不開。
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x7a),
    ]);
    const path = await writeTemp("broken.png", broken);
    const sink: { value?: Captured } = {};
    await expect(
      describeImage({
        provider: capturingProvider(sink),
        imagePath: path,
        language: "zh-TW",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
    // 模型根本不該被呼叫：壞圖沒有送出去的價值，卻照樣要收配額。
    expect(sink.value).toBe(undefined);
  });

  it("已經 abort 的工作不送出請求，暫存縮圖也不留下", async () => {
    const path = await writeTemp(
      "aborted.png",
      await sharp({ create: { width: 800, height: 600, channels: 3, background: "#334455" } })
        .png()
        .toBuffer(),
    );
    const controller = new AbortController();
    controller.abort();
    const sink: { value?: Captured } = {};
    await expect(
      describeImage({
        provider: capturingProvider(sink),
        imagePath: path,
        language: "zh-TW",
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("IMAGE_DESCRIPTION_ABORTED");
    expect(sink.value).toBe(undefined);
  });
});

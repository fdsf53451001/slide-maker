import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStyleRepository } from "../src/styles.js";

const PNG_HEADER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("FileStyleRepository covers", () => {
  it("uses the first reference as cover and replaces a removed cover", async () => {
    const repository = new FileStyleRepository(await mkdtemp(join(tmpdir(), "slide-maker-styles-")));
    await repository.initialize();
    const first = await repository.saveReference("first.png", "image/png", PNG_HEADER);
    const second = await repository.saveReference("second.png", "image/png", PNG_HEADER);

    const created = await repository.create({ name: "有封面的風格", referenceImages: [first, second] });
    expect(created.coverImageId).toBe(first.id);

    const updated = await repository.update(created.id, { referenceImages: [second] });
    expect(updated.coverImageId).toBe(second.id);

    const emptied = await repository.update(created.id, { referenceImages: [] });
    expect(emptied.coverImageId).toBeUndefined();
  });
});

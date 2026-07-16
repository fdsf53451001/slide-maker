import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexStructured } from "../src/structured.js";

describe("Codex structured output", () => {
  it("terminates variadic image arguments before the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "slide-maker-structured-"));
    const executable = join(root, "fake-codex.py");
    const imagePath = join(root, "reference.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeFile(executable, `#!/usr/bin/python3
import json, os, sys
args = sys.argv[1:]
workspace = args[args.index("-C") + 1]
with open(os.path.join(workspace, "argv.json"), "w", encoding="utf-8") as handle:
    json.dump(args, handle)
if "--" not in args:
    print("No prompt provided via stdin.", file=sys.stderr)
    sys.exit(2)
output = args[args.index("--output-last-message") + 1]
with open(output, "w", encoding="utf-8") as handle:
    json.dump({"imageDirection": "方向", "promptTemplate": "模板", "avoid": []}, handle)
`, { mode: 0o700 });
    await chmod(executable, 0o700);

    const prompt = "Analyze the attached reference image.";
    const workspaceRoot = join(root, "jobs");
    await expect(runCodexStructured({
      executable,
      workspaceRoot,
      imagePaths: [imagePath],
      prompt,
      outputSchema: { type: "object" },
    })).resolves.toEqual({ imageDirection: "方向", promptTemplate: "模板", avoid: [] });

    const [jobDirectory] = await readdir(workspaceRoot);
    const argv = JSON.parse(await readFile(join(workspaceRoot, jobDirectory!, "argv.json"), "utf8")) as string[];
    const imageIndex = argv.indexOf("-i");
    const delimiterIndex = argv.indexOf("--");
    expect(imageIndex).toBeGreaterThan(-1);
    expect(delimiterIndex).toBeGreaterThan(imageIndex);
    expect(argv[delimiterIndex + 1]).toBe(prompt);
  });
});

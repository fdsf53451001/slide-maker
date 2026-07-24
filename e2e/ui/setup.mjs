// Idempotent prerequisite check for the UI E2E suite.
//
// The suite lives outside the pnpm workspace globs (apps/*, packages/*), so it
// has no node_modules of its own. Its specs import `@playwright/test` and
// `@slide-maker/core` as bare specifiers, and ESM resolves those by file
// location — which walks up from e2e/ui and finds nothing. We bridge that by
// symlinking e2e/ui/node_modules → apps/editor/node_modules (which has both,
// and exposes @slide-maker/core's ESM `import` export). node_modules is
// gitignored, so this must be (re)created on a fresh checkout.

import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const editorModules = resolve(repoRoot, "apps/editor/node_modules");
const link = resolve(here, "node_modules");

if (!existsSync(editorModules)) {
  console.error(
    `[e2e/ui] apps/editor/node_modules is missing.\n` + `Run: npx pnpm@10.13.1 install`,
  );
  process.exit(1);
}

// If @playwright/test already resolves under e2e/ui/node_modules — whether via
// our symlink OR because the user promoted e2e/ui to a real workspace package —
// there is nothing to do. We must never clobber a real node_modules directory.
const resolvable = existsSync(resolve(link, "@playwright/test"));

if (!resolvable) {
  let isSymlink = false;
  try {
    isSymlink = lstatSync(link).isSymbolicLink();
  } catch {
    isSymlink = false;
  }
  if (isSymlink) unlinkSync(link); // stale/broken symlink — safe to replace
  if (existsSync(link) && !isSymlink) {
    console.error(
      `[e2e/ui] ${link} exists but @playwright/test is not resolvable there.\n` +
        `Run: npx pnpm@10.13.1 install`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(here, editorModules), link, "dir");
  console.log(`[e2e/ui] linked node_modules → ${relative(repoRoot, editorModules)}`);
}

// Ensure the two workspace builds the suite depends on are present.
for (const [label, probe] of [
  ["editor build", resolve(repoRoot, "apps/editor/dist/index.html")],
  ["server build", resolve(repoRoot, "apps/server/dist/index.js")],
  ["core build", resolve(repoRoot, "packages/core/dist/index.js")],
]) {
  if (!existsSync(probe)) {
    console.error(`[e2e/ui] ${label} not found at ${probe}.\nRun: pnpm -r build`);
    process.exit(1);
  }
}

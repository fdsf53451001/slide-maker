# UI E2E (Playwright, real browser, zero quota)

Real-browser end-to-end tests driven with Playwright + headless Chromium. They
boot the **already-built** server (`apps/server/dist`) against an **isolated
data root** with the **mock image provider only**, so they consume **no
Codex/Grok/OpenAI/Gemini quota** and never touch the network.

These tests target things the API layer can't see — pure CSS/DOM invariants:
exact canvas aspect ratio, page-number overlay geometry vs. `page-number.ts`,
version switching, the PDF-import modal, the main create→generate→export flow,
and presentation mode.

## What's covered

| Spec                           | Verifies                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specs/canvas-ratio.spec.ts`   | `.canvas` is exactly 16:9 (±0.5px) with no letterbox, at 1920×1080 / 1440×900 / 1280×720 / narrow 1100×720. (CLAUDE.md regression point.)                                                                                                                                                                             |
| `specs/page-number.spec.ts`    | `PageNumberOverlay` text + chip boxes match `pageNumberLayout()` converted to canvas px (±1px), for every position; labels match `pageNumberLabel()` for every format; `skipFirstSlide`; nothing clipped or in a letterbox; the 設定-tab toggle. All expected values come from `@slide-maker/core`, never hard-coded. |
| `specs/version-switch.spec.ts` | Switching to the PDF-import "可編輯文字" version shows the one-time system-font notice; acknowledging persists (localStorage) so it never returns.                                                                                                                                                                    |
| `specs/pdf-import.spec.ts`     | `PdfDeckImportModal`: upload a programmatically generated 16:9 PDF → preview grid → page (de)selection → confirm → analysis screen → editor.                                                                                                                                                                          |
| `specs/workflow.spec.ts`       | Dashboard → 4-step wizard (brief → outline via the `NODE_ENV=test` deterministic fallback → generate on `mock-image`) → editor → export download.                                                                                                                                                                     |
| `specs/presentation.spec.ts`   | `.presentation-stage` is exactly 16:9 with no letterbox; page number sits on the image rect (not the bars); prev/next/exit controls.                                                                                                                                                                                  |

## Prerequisites

```bash
# 1. install workspace deps (pinned pnpm)
npx pnpm@10.13.1 install

# 2. build all workspace packages (the suite runs the BUILT server + editor)
pnpm -r build

# 3. download the Chromium browser for Playwright (~150MB, one-time)
npx playwright install chromium
```

If Chromium is missing the suite fails fast with a clear message pointing at
step 3 (it does not crash deep in a worker). `setup.mjs` likewise fails fast if
the builds from step 2 are missing.

## Running

```bash
# from the repo root
node e2e/ui/setup.mjs \
  && ./apps/editor/node_modules/.bin/playwright test --config e2e/ui/playwright.config.ts
```

The Playwright binary is invoked directly from the repo root (not via
`pnpm --filter … exec`, which would `cd` into `apps/editor` and break the
repo-relative `--config` path).

`setup.mjs` is an idempotent prerequisite step: it (re)creates
`e2e/ui/node_modules` as a symlink to `apps/editor/node_modules` and checks the
builds exist. It's required because this suite sits outside the pnpm workspace
globs, so ESM has no other way to resolve `@playwright/test` and
`@slide-maker/core` (whose `import`-only export the specs rely on). The symlink
is under `node_modules`, so it is gitignored and must be recreated on a fresh
checkout — hence running `setup.mjs` first.

Filter to a subset the usual way, e.g.:

```bash
./apps/editor/node_modules/.bin/playwright test \
  --config e2e/ui/playwright.config.ts page-number presentation
```

### Open the HTML report

```bash
./apps/editor/node_modules/.bin/playwright show-report artifacts/e2e-ui/html
```

## Scripts for the root `package.json`

(I did **not** edit the root `package.json` — that's yours to own.)

A concurrent agent already added this line to the root `package.json`:

```jsonc
"e2e:ui": "pnpm --filter @slide-maker/e2e-ui test"
```

That targets **this** package (`e2e/ui/package.json` is named
`@slide-maker/e2e-ui` and now has a `test` script). It will work **once
`e2e/ui` is a pnpm workspace member** — i.e. add `"e2e/ui"` to
`pnpm-workspace.yaml` and run `npx pnpm@10.13.1 install`. That's the cleanest
wiring: pnpm then creates a real `e2e/ui/node_modules` and `setup.mjs` becomes a
no-op (it detects the deps are already resolvable and leaves the dir alone). I
did **not** touch `pnpm-workspace.yaml` — it's a shared root file outside my
assigned scope, so this last step is your call.

**Until then** (no workspace membership), use this equivalent, which works today
with zero root/workspace changes (it self-bootstraps the resolution symlink):

```jsonc
{
  "scripts": {
    "test:e2e:ui": "node e2e/ui/setup.mjs && ./apps/editor/node_modules/.bin/playwright test --config e2e/ui/playwright.config.ts",
    "test:e2e:ui:report": "./apps/editor/node_modules/.bin/playwright show-report artifacts/e2e-ui/html",
  },
}
```

Both assume `pnpm -r build` and `npx playwright install chromium` have been run
(see Prerequisites). This suite is intentionally **excluded from `pnpm check`**
— it needs a built tree + a downloaded browser — but it consumes zero model
quota, so it is safe to run in CI once those two prerequisites are met (unlike
the `smoke:*` scripts).

## How it stays quota-free & isolated

- **Own server launcher** (`server.mjs`) — spawns `apps/server/dist/index.js`
  with `NODE_ENV=test`, `HOST=127.0.0.1`, its own `PORT` (default `4188`), and a
  dedicated `SLIDE_MAKER_DATA_ROOT` under `.e2e-data/ui-<runId>`. It never
  touches `.slide-maker-data` / `.data`. All Codex/OpenAI/egress env is blanked.
- **Mock image provider** — the server auto-seeds `models.json` with the default
  combination already pointing at `mock-image` (deterministic SVG, ready, no
  quota). Nothing pre-writes `models.json`; it's mock out of the box.
- **Deterministic outlines** — with `NODE_ENV=test` and no Codex/OpenAI creds,
  the outline endpoint falls back to `createSlidesFromBrief` (local, offline).
- **Host allow-list** — `baseURL` is `http://127.0.0.1:<PORT>`, which the
  server's `LOCAL_HOSTNAMES` check accepts.

The suite does **not** depend on any other agent's harness (`e2e/lib`,
`e2e/specs`, `e2e/run.mjs`) — it self-hosts via Playwright's `webServer`.

## Artifacts

- `retries: 0` (surface flakiness, don't hide it).
- On failure: screenshot + trace under
  `artifacts/e2e-ui/<runId>/test-results/<test>/`.
- HTML report: `artifacts/e2e-ui/html/` (`reporter` = `list` + `html`).
- `<runId>` defaults to a timestamp; override with `SLIDE_MAKER_E2E_RUN_ID`.

## Files

```
e2e/ui/
  playwright.config.ts   config: webServer, reporters, viewport, artifacts, browser-guard
  server.mjs             isolated server launcher (used by webServer)
  setup.mjs              idempotent prereq: node_modules symlink + build checks
  helpers.ts             API seeding, PDF generation, geometry assertions
  specs/*.spec.ts        the tests
  README.md              this file
```

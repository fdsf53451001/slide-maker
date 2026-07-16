# Slide Maker

Local-first, image-based presentation generation as a TypeScript library and a page-oriented editor.

## Run the local application

```bash
npx pnpm@10.13.1 install
npx pnpm@10.13.1 dev
```

Open `http://localhost:4173`. The local server serves the React editor and API together. During UI development, run `pnpm dev:web` in another terminal and open Vite's URL.

The local MVP supports:

- editable presentation briefs and Codex-generated outlines with optional Live Web Search citations;
- page add, duplicate, delete, drag reorder, per-page source selection and immutable image history;
- PDF, PPTX, DOCX, Markdown, text, PNG and JPEG source upload with project-local extraction, stable chunks and SQLite FTS5 search;
- versioned server-side styles with immutable project snapshots;
- persistent per-slide jobs, bounded provider concurrency, cancellation, recovery and batch generation;
- compressed full-slide PPTX, PDF, ordered PNG ZIP and portable `.slide-project` export/import;
- a safe-by-default deterministic mock image provider and the separately opt-in Codex experimental provider.

Run the complete gate with:

```bash
pnpm check
```

`pnpm dev` starts a long-running development server and remains attached to the terminal until you stop it (normally with `Ctrl+C`). Its startup messages report whether the mock and Codex providers are active; they never print credentials.

On `SIGINT`/`SIGTERM`, the server stops accepting work, records queued/running jobs as `SERVER_SHUTDOWN`, aborts active children, and drains lifecycle writes within a bounded grace period. A second signal or an expired deadline forces a non-zero exit; that forced cutoff may leave the final terminal persistence incomplete, so recovery reclassifies any remaining running record on the next start.

Codex image jobs default to a 10-minute timeout. Set `SLIDE_MAKER_CODEX_TIMEOUT_MS` to an integer from `30000` (30 seconds) through `1800000` (30 minutes) before starting the server. Timed-out image jobs fail once with `CODEX_TIMEOUT`; they are never retried automatically.

Codex image jobs default to a concurrency of `3`. Set `SLIDE_MAKER_CODEX_MAX_CONCURRENCY=1` for strictly sequential generation, or an integer up to `4` when the account and machine can support it. PPTX export keeps project PNG assets untouched but embeds quality-88, 4:4:4 JPEG copies to reduce deck size while retaining fine text edges.

The default `mock-image` provider creates deterministic SVG slide images without using network access or model quota. The Codex image provider is disabled unless the local server is started with `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1`. Enabling it consumes Codex quota and accepts **soft isolation, not a security boundary (H1 risk)**. The provider pins the experimental Codex `0.144.4` app-server protocol and requests read-only filesystem policy, no approvals, no turn network access, and an ephemeral thread. It permits the read-only command lifecycle and Codex's built-in code-mode `exec` wrapper required by the installed image-generation skill, while rejecting file changes, MCP calls, non-`exec` dynamic tools, Web Search, unexpected response policies, and uncorrelated events.

Those checks do not create a complete read or tool boundary. App-server still loads the real `CODEX_HOME` configuration, instructions and configured tool surfaces, and Codex may read other files available to the local account. A malicious reference or prompt can therefore still cause prompt injection, local-data disclosure, configured-tool side effects, or quota consumption before a forbidden event is observed. Run the spike only in a disposable OS account/container with no secrets or privileged tools. A hard server crash can also leave detached descendants for the OS supervisor to reap. Each job otherwise receives a dedicated workspace; its bounded presentation JSON is marked as untrusted data in the app-server prompt and also recorded in `input.json` for local auditability.

The image provider intentionally rejects observed `webSearch` items. Future Web Search support belongs in a separate content-planning/source provider with its own source records and trust policy; it is not part of the image artifact transport.

Codex output is restricted to a regular, non-symlink PNG inside that job workspace and checked for size, dimensions, chunk bounds, required IHDR/IDAT/IEND chunks, and CRCs. Valid model PNGs are decoded and re-rendered with `@resvg/resvg-js` when necessary so the persisted slide is exactly 1920×1080, then structurally validated again.

The live smoke is deliberately separate from `pnpm check` because it consumes quota. Use an isolated authenticated `CODEX_HOME` and a dedicated data directory, then run `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1 SLIDE_MAKER_DATA_ROOT=/path/to/smoke-data pnpm smoke:image:codex`.

## Packages

- `@slide-maker/core`: versioned schemas, project helpers, provider contracts and registry.
- `@slide-maker/provider-mock`: deterministic no-cost image provider.
- `@slide-maker/provider-codex`: opt-in Codex process spike with argument-only process spawning.
- `@slide-maker/server`: local persistent API and job runner.
- `@slide-maker/editor`: embeddable React page-workflow editor and reference UI.

Project data is written to `.data/` by default and is intentionally ignored by Git.

New projects use a persisted two-step flow: **需求 → 大綱**, then **設定 → 生成簡報**. The confirmed outline determines the page count; confirming step two immediately queues every outline page through the selected image provider and opens the editor to show progress and completed versions.

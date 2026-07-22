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
- a safe-by-default deterministic mock image provider plus three maintained production image transports.

Run the complete gate with:

```bash
pnpm check
```

`pnpm dev` starts a long-running development server and remains attached to the terminal until you stop it (normally with `Ctrl+C`). Its startup messages report whether the mock and Codex providers are active; they never print credentials.

On `SIGINT`/`SIGTERM`, the server stops accepting work, records queued/running jobs as `SERVER_SHUTDOWN`, aborts active children, and drains lifecycle writes within a bounded grace period. A second signal or an expired deadline forces a non-zero exit; that forced cutoff may leave the final terminal persistence incomplete, so recovery reclassifies any remaining running record on the next start.

Codex image jobs default to a 10-minute timeout. Set `SLIDE_MAKER_CODEX_TIMEOUT_MS` to an integer from `30000` (30 seconds) through `1800000` (30 minutes) before starting the server. Timed-out image jobs fail once with `CODEX_TIMEOUT`; they are never retried automatically.

Codex image jobs default to a concurrency of `3`. Set `SLIDE_MAKER_CODEX_MAX_CONCURRENCY=1` for strictly sequential generation, or an integer up to `4` when the account and machine can support it. PPTX export keeps project PNG assets untouched but embeds quality-88, 4:4:4 JPEG copies to reduce deck size while retaining fine text edges.

The default `mock-image` provider creates deterministic SVG slide images without using network access or model quota. The Codex image provider is disabled unless the local server is started with `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1`. Enabling it consumes Codex quota and accepts **soft isolation, not a security boundary (H1 risk)**. The provider pins the experimental Codex `0.144.4` app-server protocol and requests read-only filesystem policy, no approvals, no turn network access, and an ephemeral thread. It permits the read-only command lifecycle and Codex's built-in code-mode `exec` wrapper required by the installed image-generation skill, while rejecting file changes, MCP calls, non-`exec` dynamic tools, Web Search, unexpected response policies, and uncorrelated events.

### Image generation transports

All three production transports use the same provider-neutral **Codex-baseline image contract** from `@slide-maker/core`: canvas, complete slide fields, style snapshot, information density, edit/mask semantics, ordered reference roles, direct-asset fidelity, and the untrusted-data boundary. Each transport adapter only adds its invocation and response-format rules, and every accepted raster result is normalized to the project canvas as PNG.

| Transport              | Module                              | Endpoint / protocol                    | Suitable CLIProxyAPI model                                                            | Supplemental references                 |
| ---------------------- | ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| Codex app-server       | `@slide-maker/provider-codex`       | Codex app-server image generation      | configured Codex image-capable model                                                  | Yes                                     |
| OpenAI-compatible Chat | `provider-openai/src/image-chat.ts` | `/chat/completions`                    | `gpt-5.6-terra` through injected image generation, or native `gemini-3.1-flash-image` | Yes, ordered; up to 8                   |
| OpenAI Images API      | `provider-openai/src/image-api.ts`  | `/images/generations`, `/images/edits` | `gpt-image-2`                                                                         | No; edit base and mask remain supported |

For an OpenAI-compatible endpoint, set `SLIDE_MAKER_OPENAI_BASE_URL`, `SLIDE_MAKER_OPENAI_API_KEY`, and `SLIDE_MAKER_OPENAI_IMAGE_MODEL`, then choose `SLIDE_MAKER_OPENAI_IMAGE_API=chat` or `images`. `gemini-3-flash-agent` is not an image-output model for this flow; use `gemini-3.1-flash-image` on the Chat transport instead.

Those checks do not create a complete read or tool boundary. App-server still loads the real `CODEX_HOME` configuration, instructions and configured tool surfaces, and Codex may read other files available to the local account. A malicious reference or prompt can therefore still cause prompt injection, local-data disclosure, configured-tool side effects, or quota consumption before a forbidden event is observed. Run the spike only in a disposable OS account/container with no secrets or privileged tools. A hard server crash can also leave detached descendants for the OS supervisor to reap. Each job otherwise receives a dedicated workspace; its bounded presentation JSON is marked as untrusted data in the app-server prompt and also recorded in `input.json` for local auditability.

The image provider intentionally rejects observed `webSearch` items. Future Web Search support belongs in a separate content-planning/source provider with its own source records and trust policy; it is not part of the image artifact transport.

Codex output is restricted to a regular, non-symlink PNG inside that job workspace and checked for size, dimensions, chunk bounds, required IHDR/IDAT/IEND chunks, and CRCs. Valid model PNGs are decoded and re-rendered with `@resvg/resvg-js` when necessary so the persisted slide is exactly 1920×1080, then structurally validated again.

The live smoke is deliberately separate from `pnpm check` because it consumes quota. Use an isolated authenticated `CODEX_HOME` and a dedicated data directory, then run `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1 SLIDE_MAKER_DATA_ROOT=/path/to/smoke-data pnpm smoke:image:codex`.

## Cloud deployment (Cloud Run + Cloud Storage)

`infra/` deploys the server to Cloud Run with its data directory backed by a Cloud Storage
bucket mounted through gcsfuse. It is sized for a handful of trusted users sharing one data
set, fronted by IAP.

### Constraints that are not tuning knobs

- **`max_instance_count = 1` is a correctness requirement.** Job state lives in an in-memory
  `Map` in `jobs.ts`, and gcsfuse has no file locking. A second instance corrupts both.
- **CPU must stay allocated** (`cpu_idle = false`). The job runner does its work in the
  background _after_ the HTTP response returns; a throttled instance stalls mid-generation.
- **The bucket must have hierarchical namespace enabled.** `repository.ts` and
  `model-library-repository.ts` write a temporary file and `rename` it for atomicity. On a
  flat bucket that rename is copy-then-delete.
- `min_instance_count = 0` keeps the bill near zero but costs a 20–60s cold start, and Cloud
  Run reclaims idle instances after at most 15 minutes — that interval is not configurable.
  Closing the browser tab during a long job lets the instance go away; `recoverInterruptedJobs()`
  marks such jobs `SERVER_RESTARTED` on the next boot so they can be retried.

### Manual steps Terraform does not cover

1. Create the project, link billing, and create the state-free prerequisites yourself.
2. **Configure IAP by hand in the console.** The IAP OAuth Admin APIs were shut down in
   March 2026, and OAuth clients cannot be created programmatically in a project without an
   organization. Terraform deliberately leaves `iap_enabled` and all IAP IAM alone so it
   never fights the console configuration.
3. Add users to the IAP access list (`roles/iap.httpsResourceAccessor`).

Until IAP is configured the service simply rejects everyone: no `roles/run.invoker` binding is
granted to `allUsers`, so unauthenticated requests get a 403.

### Deploy

```sh
# 1. Build and push (linux/amd64; Cloud Run does not run arm64).
IMAGE=asia-east1-docker.pkg.dev/<project>/slide-maker/server:$(date +%Y-%m-%d)
docker buildx build --platform linux/amd64 -t "$IMAGE" --push .

# 2. Apply. The Cloud Run hostname is not known until the service exists, so the first
#    apply leaves trusted_hosts empty and every request is refused; fill in the hostname
#    from the service_url output and apply again.
cd infra
cp terraform.tfvars.example terraform.tfvars   # then edit it
terraform init
terraform apply -var="image=$IMAGE"
```

The first build takes 30–60 minutes because the amd64 layers are emulated and the image
bundles the PaddleOCR virtualenv plus its pre-downloaded model weights (~2GB total). Later
builds only re-run the source layer.

### Two environment variables exist only for this deployment

`SLIDE_MAKER_TRUSTED_HOSTS` (comma-separated) widens the host guard in `app.ts`, which
otherwise answers `LOCAL_HOST_REQUIRED` to anything that is not localhost. Unset, the server
behaves exactly as it always has. Listing a hostname hands that defence over to whatever sits
in front of the service, so do not list one until IAP is actually configured. Wildcards are
rejected on purpose.

Cloud Run assigns **two** hostnames to a service — `<service>-<project-number>.<region>.run.app`
and `<service>-<hash>-<code>.a.run.app` — and both must be listed, or whichever one you left
out answers `LOCAL_HOST_REQUIRED`. `gcloud run services describe` reports only one of them in
`status.url`; use the `service_urls` Terraform output for the full list.

`SLIDE_MAKER_SEARCH_INDEX_PATH` moves the SQLite FTS index off `SLIDE_MAKER_DATA_ROOT`.
gcsfuse provides no POSIX file locking, and SQLite in WAL mode on such a mount corrupts
silently. The index is derived data — `createApp` rebuilds it from `project.sources` on every
boot — so pointing it at container-local disk loses nothing. Note that Cloud Run's local disk
is memory, so the index counts against the instance memory limit.

Always pass an explicit tag or digest. Cloud Run does not create a new revision when the
image reference is unchanged.

### Configuring models

No AI environment variables are set in the deployment. `app.ts` only seeds a model library
from the environment on first boot when `models.json` is absent; after that
`SLIDE_MAKER_DATA_ROOT/models.json` is the single source of truth. Add connections and API
keys through the editor UI.

That file holds those API keys in plaintext on the bucket, which is why the bucket enforces
uniform bucket-level access, blocks public access, and is readable only by the runtime
service account.

### Known gaps

- Codex providers are present in the code but the Codex CLI is not installed in the image, so
  they report unavailable.
- Google's OpenAI-compatibility endpoint cannot return images from Gemini image models, has no
  `/images/edits`, and rejects `google_search` grounding. Style references, mask edits and web
  search need a different transport.
- API keys with an IP address restriction do not work: Cloud Run's egress IP is not stable.

## Packages

- `@slide-maker/core`: versioned schemas, project helpers, provider contracts and registry.
- `@slide-maker/provider-mock`: deterministic no-cost image provider.
- `@slide-maker/provider-codex`: opt-in Codex process spike with argument-only process spawning.
- `@slide-maker/provider-openai`: modular OpenAI-compatible Chat, Images, structured-text and web-search adapters.
- `@slide-maker/server`: local persistent API and job runner.
- `@slide-maker/editor`: embeddable React page-workflow editor and reference UI.

Project data is written to `.data/` by default and is intentionally ignored by Git.

New projects use a persisted two-step flow: **需求 → 大綱**, then **設定 → 生成簡報**. The confirmed outline determines the page count; confirming step two immediately queues every outline page through the selected image provider and opens the editor to show progress and completed versions.

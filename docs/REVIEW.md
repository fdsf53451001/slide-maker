# Change Review

- Date: 2026-07-14
- Scope: the first vertical slice plus the opt-in Codex provider, version-pinned experimental app-server transport, provider readiness gate/UI, graceful shutdown, persistent job runner, React editor, packaging, and related tests.
- Method: static Fortify change review. The reviewer inspected code, protocol provenance, and test artifacts but did not execute the application, builds, tests, or a generation job. Runtime results belong to QA's separate report.
- Independent verification: the final QA gate reports repository-wide `pnpm check` passing: all five implementation workspaces typecheck, all builds pass, and 132/132 tests pass (core 3, mock 1, provider-codex 74, server 54; editor 0). Targeted results include app-server 33/33, provider readiness 9/9, readiness service 12/12, server app-server API 2/2, and shutdown 7/7.
- Outcome: no open Critical or blocking code finding was identified. The local mock-provider path remains the safe default. The Codex path may proceed to one explicitly authorized, non-sensitive real-image smoke, but it retains H-1: an in-process Codex read/tool/config boundary is not a security sandbox.

## Open findings

### High

#### H-1 — Codex soft isolation cannot enforce a local read or tool allowlist

Locations: `packages/provider-codex/src/index.ts:16`, `packages/provider-codex/src/app-server.ts:252`, `apps/server/src/app.ts:34`

The provider clearly warns that this mode is not a security boundary and is disabled unless the server operator sets `SLIDE_MAKER_ENABLE_CODEX_SOFT_SANDBOX=1`. It separates fixed task text from a minimized `input.json`, uses a dedicated job workspace, pins `codex-cli 0.144.4`, requests read-only/no-approval/no-turn-network policy, rejects widened effective response policy, and fails closed on observed command, file, MCP, dynamic-tool, or Web Search items.

Those controls do not prevent Codex from reading other files already readable by the local account. App-server still loads real `CODEX_HOME` configuration, instructions, hooks, and configured tool surfaces; rejecting a forbidden event after it is observed cannot prove that no side effect already occurred. A slide or style field can therefore contain indirect prompt injection that asks the agent or a configured tool to disclose local data. Prompt wording, read-only policy, and warnings reduce risk but do not break that attack path.

Recommendation: keep this mode explicitly opt-in and label it development-only. Do not use it with untrusted presentation content or on a workstation containing sensitive readable files. A production-capable provider needs an OS/container boundary that mounts only the per-job workspace plus the minimum authentication material, denies network and unrelated tools, and terminates the entire process tree on every outcome. Keeping the provider unavailable remains the safe configuration.

### Medium

#### M-1 — Provider result metadata lacks a secret-free allowlist

Locations: `apps/server/src/jobs.ts:30`, `apps/server/src/jobs.ts:315`

Exception handling is now server-owned: unknown provider messages collapse to a fixed error and Codex raw stderr is not persisted. `GeneratedImage.model` and the keys/values in `GeneratedImage.parameters` still have no secret-free allowlist; the runner checks only image/JSON shape and total metadata size before persisting them in a slide version. A future provider that mistakenly returns credentials in those fields can therefore place them in `project.json`, the project API, or future project bundles.

Recommendation: define an allowlisted result-metadata contract. Validate `model` as a bounded identifier, recursively reject sensitive parameter keys/credential patterns, and add nested canary tests for API-key headers, Basic authorization, query tokens, and provider-specific token formats.

#### M-2 — The real Codex image-generation contract has been demonstrated

Locations: `packages/provider-codex/src/app-server.ts:143`, `docs/CODEX_APP_SERVER_SCHEMA_PROVENANCE.md:1`

The experimental v2 schema was generated locally from `codex-cli 0.144.4` without a model turn; its bundle and security-relevant files have recorded SHA-256 hashes. On 2026-07-14, the separately authorized non-sensitive live smoke then completed the full HTTP API → job runner → app-server → built-in `imageGeneration` → PNG normalization → version persistence path. The completed job took 50,185 ms and produced a visually inspected 2,253,789-byte 1920×1080 PNG with the requested Traditional Chinese title. No quota, authentication, or protocol failure occurred.

Recommendation: keep `0.144.4` as an exact compatibility pin. Keep the live smoke separately authorized and non-default, use only a non-sensitive fixture in a disposable environment, and record only safe summaries, generated PNG properties, duration, quota result, and fixed failure class. Never run it automatically in CI or installation.

### Low

#### L-1 — Soft-isolation negative coverage is not exhaustive

Locations: `packages/provider-codex/test/qa-app-server.test.ts:155`, `packages/provider-codex/src/app-server.ts:143`

Coverage now includes exact-version readiness, schema-required responses, widened effective policy/cwd rejection, RPC ordering/correlation, unsolicited reverse requests, malformed/oversized/amplified streams, duplicate/failed turns, inline and saved artifacts, outside/symlink paths, secret suppression, abort/timeout, and forced SIGKILL after ignored SIGTERM. Direct cases remain limited for config mutation/restoration races, saved-path parent replacement, malformed compressed pixel data, hard-crash orphan descendants, and Windows process-tree behavior.

Recommendation: add deterministic negative tests where practical. Treat the structural PNG parser as a bounded format gate rather than proof that every accepted IDAT stream is decodable; decode/re-encode with a maintained image library before enabling a remote or untrusted provider.

#### L-2 — Codex job inputs and outputs have no retention lifecycle

Location: `packages/provider-codex/src/index.ts:275`

Each attempt leaves its minimized `input.json`, JSONL-related workspace files, and generated output under `.data/codex-jobs`. This is server-side storage as intended, but repeated generation duplicates presentation text indefinitely, increases local privacy exposure, and can consume disk without a quota.

Recommendation: define retention and size limits, remove failed/cancelled workspaces after bounded diagnostics are collected, and garbage-collect completed workspaces once the validated asset is persisted. Document any retention needed for reproducibility.

## Findings fixed during review

- Codex execution is disabled by default and requires an exact server-side environment opt-in. Provider availability and the soft-sandbox warning are exposed through the API and editor.
- Process execution uses an argument array with `shell: false`; user content cannot add flags or shell syntax, and the earlier arbitrary extra-argument option was removed.
- Trusted instructions are fixed in code. Slide/style content is minimized into a size-limited `input.json`, marked as untrusted data, and excludes project versions, asset paths, references, and provider parameters.
- The child receives a small environment allowlist. The adapter requests read-only/no-approval/no-turn-network policy and rejects observed command/file/MCP/dynamic-tool/Web Search items, but real `CODEX_HOME` configuration and tool surfaces remain in scope under H-1.
- Timeout and cancellation send SIGTERM and then SIGKILL to the POSIX process group. The AbortSignal registration race now checks the signal immediately after listener installation.
- Output validation rejects replaced workspaces, parent-directory symlinks, final-file symlinks, realpath escapes, non-regular files, oversized files, changed files, and wrong dimensions. It opens the final file with `O_NOFOLLOW` and validates PNG signature, chunk bounds/types, CRCs, IHDR, non-empty IDAT, and terminal IEND.
- Codex stdout/stderr are bounded. JSONL must be non-empty and parseable, while persisted failures use stable messages rather than raw stderr; provider- and server-level tests confirm a Bearer canary from stderr is absent from the thrown/persisted error.
- The generic job runner validates provider output again before asset persistence, bounds metadata, serializes project mutations, prevents cancelled jobs from publishing versions, and enforces bounded per-provider concurrency.
- Local Host/Origin checks, stable HTTP errors, module-relative runtime paths, terminal `/api` JSON 404 handling, a non-disclosing missing-editor response, externalized React library packaging, and local-only fonts remain in place from the earlier hardening review.

## Architecture and API notes

- Codex Web Search is intentionally disabled in this execution spike despite the product's future Web Search requirement. Add Web Search later as a separately reviewable source provider with citation capture, domain/network policy, content limits, and explicit untrusted-data boundaries.
- Source upload/management, retrieval, style repository UI, outline generation, export formats, and `.slide-project` import/export remain future milestones. Upload and archive work will require content-based validation, realpath/symlink checks, quotas, and Zip Slip defenses.
- The editor library API client remains fixed to same-origin `/api`; embedding into a host with a different route will require an injected client or base URL.
- The SPA fallback serves only the fixed editor `index.html`. Preserve the terminal `/api` handler before any fallback route.

## Job progress, logging, and error-classification follow-up

- Scope: job lifecycle schema/migration, provider progress callback, structured phase logging, safe error classification, configurable timeout/remaining-time UI, cancellation, and their immediate API/repository callers.
- Method: static Fortify review using the authorization, logging/audit, and AI-agent safety checks. This reviewer did not execute the changed code or tests. QA independently reports 71/71 tests plus typecheck/build passing, including cross-project cancellation, timeout/no-retry, process-group termination, structured-log and persistence canaries, safe usage/auth classification, lifecycle migration, and mock/Codex phase coverage.
- Outcome: the review found three concrete boundary defects while Dev was implementing this batch. Dev corrected all three and added focused negative tests. No new Flagged finding remains in this batch; the previously documented Codex read/tool-scope risk remains Flagged.

### Data-flow conclusions

- Codex JSONL is reduced to three fixed event codes. Duplicate event types are emitted at most once, so model output cannot create an unbounded progress-promise array or one repository write per repeated event.
- Progress observers are best-effort and non-blocking. Callback rejection or delay cannot hold the provider before process launch, defer timeout/cancel classification, or convert an otherwise valid image into a failed job.
- The server validates progress phases and event codes at runtime, rejects backwards/duplicate state updates, binds callbacks to the closure's `projectId` and `jobId`, and ignores progress after a job leaves `running`.
- Cancellation now validates the job inside the requested project before aborting a controller stored under a composite project/job key. A guessed job ID under another project cannot stop the victim job.
- Phase logs are JSON records containing only job/project/slide/provider IDs, phase, bounded progress, elapsed milliseconds, and an allowlisted error code. They do not include prompts, style/source content, paths, stdout/stderr, authorization headers, tokens, provider messages, or image bytes. JSON encoding also prevents newline log forging.
- The server owns the error-code/message mapping. Unknown `SafeProviderError` codes and provider-authored messages collapse to `PROVIDER_FAILED`; raw stderr is used only for in-memory classification inside the Codex provider and is never returned through console, API, job records, or UI.
- Timeout configuration is a safe integer bounded from 30 seconds through 30 minutes in both the server environment parser and public provider constructor. The default is 10 minutes, the UI estimates remaining time only after `startedAt`, and timeout produces one terminal failed job without automatic image retry.
- Cancel/complete races cannot publish a version after cancellation. A cancellation during asset persistence can still leave an unreferenced asset, which is covered by the existing workspace/asset retention recommendation rather than a disclosure finding.

### Fortify Change Review
Code Changes Reviewed: generation lifecycle schema and migration; provider progress/event reduction; job progress persistence and structured audit logging; server-owned error classification; configurable bounded timeout and remaining-time UI; cancellation ownership/race handling; and focused test artifacts.

Security Checks:
- Access Control
- Privacy Violation, Log Forging, and System Information Leak
- Prompt Injection, Excessive Agency, and Insecure Tool Calling

Findings:
| Category | Status | Location | Attack Path | Recommendation |
|---|---|---|---|---|
| Access Control | Fixed | `apps/server/src/jobs.ts:108` | Before the fix, a caller-supplied `jobId` aborted the globally keyed controller before membership in the supplied `projectId` was checked, allowing a guessed ID under another project to cancel the victim job. | The job is now verified and marked within the requested project first, controllers use a composite project/job key, and a cross-project cancellation regression test confirms the victim completes. |
| Privacy Violation / System Information Leak | Fixed | `apps/server/src/jobs.ts:19` | Before the fix, a provider could label attacker-derived stderr or prompt text as a `SafeProviderError` message/code and have it persisted to the project/API or included in audit fields. | The server now accepts only known codes and maps them to server-owned fixed messages; unknown codes/messages collapse to `PROVIDER_FAILED`, with a Bearer/newline canary regression test. |
| Excessive Agency / Unbounded Resource Consumption | Fixed | `packages/provider-codex/src/index.ts:327` | Before the fix, repeated model-authored JSONL events created one callback promise and serialized project/log write per event, allowing bounded stdout to amplify into tens of thousands of state mutations. | Progress notification is now non-blocking, limited to three allowlisted event types emitted once each, and server updates reject invalid, duplicate, backwards, terminal, or wrong-job progress. |
| Prompt Injection / Excessive Agency | Flagged | `packages/provider-codex/src/app-server.ts:252` | Untrusted slide/style fields are still read by a broadly capable Codex process; read-only limits writes but does not restrict other account-readable files, real `CODEX_HOME` configuration, or every configured tool surface. | Retain explicit insecure opt-in for trusted local experiments only; require an OS/container read boundary, minimum tool set, denied network, and whole-process-tree lifecycle control before production use. |

Fixes Applied: Dev bound cancellation to the requested project; added composite controller keys and a cross-project negative test; capped/deduplicated progress events; made progress observers non-blocking; added runtime phase/event and monotonic-state validation; replaced provider-authored error text with a server-owned allowlist; added secret/newline canary tests; bounded timeout configuration in both server and library entry points; aligned remaining-time display with `startedAt`; and kept timeout terminal with no automatic retry.

Residual Risk: Codex soft isolation still cannot enforce project-only reads or a complete tool allowlist and is therefore not a secure sandbox. The real `$imagegen` output contract remains unverified because the prior platform usage limit blocked the spike. Cancellation during asset persistence may leave an unreferenced file until retention cleanup exists, and Windows process-tree behavior remains less complete than POSIX process-group termination.

Be sure to perform a comprehensive Fortify SAST, SCA and/or DAST as part of your DevOps pipeline.

## Graceful shutdown, readiness, and pinned app-server follow-up

- Scope: SIGINT/SIGTERM coordination, bounded HTTP/job shutdown, terminal job and child lifecycle persistence, provider readiness API/UI, non-generating Codex preflight, and the pinned `0.144.4` stdio app-server adapter.
- Method: static Fortify review using logging/audit, AI-agent safety, unsafe-deserialization/command-injection, and file-path checks. Runtime execution remained with QA, which reports the 132/132 final gate above.
- Outcome: no blocking code finding remains. During implementation, review found and Dev fixed shutdown classification/persistence races, fabricated child-exit evidence, swallowed shutdown failures, unbounded/ambiguous protocol handling, unsafe effective-policy acceptance, stale security disclosures, and a temporary debug-log disclosure. H-1, M-1, M-2, retention, hard-crash orphaning, and Windows process-tree limitations remain documented risks.

### Data-flow conclusions

- Readiness executes only four fixed, no-shell commands: exact CLI version, app-server help, login help, and login status. It never starts app-server, a model turn, `$imagegen`, or Web Search. Results are reduced to an allowlisted status/message contract, cached for 30 seconds, singleflighted per registered provider, bounded by command/service timeouts, and rechecked immediately before enqueue.
- The editor displays readiness, disables blocking states, and requires a fresh explicit checkbox acknowledgement only for `unknown`. The server independently enforces the same rule, and shutdown flips readiness to disabled before HTTP draining and rejects enqueue races inside the repository mutation.
- The app-server transport uses fixed argv and JSONL over stdio. It validates the pinned initialize/thread/turn responses and effective `openai`, read-only, no-approval, workspace cwd policy; correlates request IDs, thread IDs, turn IDs, event order, and terminal status; rejects reverse server requests and forbidden item types; and accepts exactly one completed image item.
- JSONL lines, total stdout, ordinary-event bytes, stderr, line count, decoded image size, and process lifetime are bounded. Parsing is serialized with stream backpressure; errors and stderr collapse to fixed provider/server codes and are never persisted or logged raw.
- Inline base64 is canonicalized and capped. Saved artifacts must be absolute regular non-symlink files beneath canonical `CODEX_HOME/generated_images`; the root and file are rechecked after `O_NOFOLLOW` open, and inline/saved dual results must match. The provider then writes a fixed job output and independently validates complete PNG structure, dimensions, CRCs, and containment before the job runner validates again.
- Shutdown stops readiness and HTTP acceptance, marks queued/running jobs `SERVER_SHUTDOWN`, aborts active controllers, drains observed lifecycle writes, and bounds the graceful wait. Actual `exitedAt` is written only from a provider close event; cancel/recovery record request/recovery timestamps without fabricating an exit. Deadline, close, or persistence failure closes connections and exits nonzero; a second signal forces immediate nonzero exit.

### Fortify Change Review

Code Changes Reviewed: graceful shutdown and signal handling; terminal job/child lifecycle persistence; provider readiness API/cache/gate/UI; exact-version no-model preflight; pinned app-server JSON-RPC state machine; stream/base64 limits; saved-artifact confinement; process-tree interruption; safe logging/errors; schema provenance; README/startup disclosures; and focused test artifacts.

Security Checks:
- Privacy Violation, Log Forging, and System Information Leak
- Prompt Injection, Excessive Agency, and Insecure Tool Calling
- Dynamic Code Evaluation: Unsafe Deserialization and Command Injection
- Directory Traversal and Dangerous File Inclusion

Findings:
| Category | Status | Location | Attack Path | Recommendation |
|---|---|---|---|---|
| Job/process lifecycle integrity | Fixed | `apps/server/src/jobs.ts:256`, `apps/server/src/shutdown.ts:12` | Abort callbacks could race terminal persistence, overwrite `SERVER_SHUTDOWN` with `CANCELLED`, or fabricate `exitedAt`; shutdown failure/deadline paths could also look clean. | Shutdown intent is now authoritative, actual close evidence is tracked separately and drained, cancel/recovery never invent an exit, failures propagate, the hard deadline exits nonzero, and repeated signals escalate. |
| Unsafe deserialization / resource consumption | Fixed | `packages/provider-codex/src/app-server.ts:143` | Untrusted JSONL could replay/out-of-order IDs, request privileged client actions, duplicate images, spoof a large image-bearing line, or amplify buffered/async work. | The adapter uses a strict phase/correlation machine, rejects reverse requests and duplicates, synchronously accounts bounded input before serialized parsing, pauses the stream during processing, and waits for process close before settling. |
| Path manipulation / dangerous file inclusion | Fixed | `packages/provider-codex/src/app-server.ts:119` | A model-controlled `savedPath` or symlink/parent replacement could read outside the intended generated-image directory. | Require absolute canonical containment, reject symlinks/non-files/oversize content, use `O_NOFOLLOW`, recheck the canonical root and file descriptor, compare dual artifacts, and retain final job-workspace PNG validation. |
| Privacy / system information leak | Fixed | `packages/provider-codex/src/app-server.ts:351`, `apps/server/src/readiness.ts:7` | Raw RPC errors, stderr, paths, prompts, revised prompts, base64, or temporary debug state could reach logs, API responses, or project records. | Only byte counts, fixed statuses/messages, IDs, phase, elapsed time, and allowlisted error codes cross those boundaries; opt-in protocol diagnostics emit fixed internal codes only, and canary tests cover persisted/API/log output. |
| Insecure effective configuration | Fixed | `packages/provider-codex/src/app-server.ts:240` | A valid-version app-server could return a widened cwd, approval policy, sandbox, model provider, persistent thread, or non-empty instruction sources inconsistent with the requested boundary. | Validate the version-specific required response shape and fail closed unless the returned provider is `openai`, policy is read-only/no-network/no-approval, cwd matches the job workspace, the thread is ephemeral/pathless, and instruction sources are absent or empty. |
| Prompt injection / excessive agency | Flagged | `packages/provider-codex/src/app-server.ts:252`, `packages/provider-codex/src/index.ts:16` | App-server loads real account-readable configuration, instructions, hooks, and tool surfaces; untrusted deck data may induce reads, tool side effects, or disclosure before a forbidden event is observed. | Keep default-disabled and development-only. Run the single authorized smoke only with non-sensitive data in a disposable OS account/container; require OS-level mounts, network policy, minimum tools, and supervisor cleanup before production. |
| Live experimental artifact fidelity | Fixed | `scripts/live-codex-image-smoke.mjs` | Exact schema provenance and fake protocol coverage did not prove the live `$imagegen` event/artifact, quota, normalization, or image-quality behavior. | The separately authorized one-image smoke completed in 50,185 ms and verified a persisted, visually inspected 1920×1080 PNG; keep it non-default and retain the exact `0.144.4` pin. |

Fixes Applied: Dev added fail-closed exact-version/schema/effective-policy gates; bounded and serialized JSONL; canonical base64 and saved-path validation; correlated interruption and process-group TERM/KILL; config mutation canary; fixed secret-free Codex result metadata; cached/singleflight readiness and editor acknowledgement; terminal shutdown persistence, lifecycle drain, hard deadline, signal escalation, and safe nonzero failure; accurate warnings; and extensive negative tests.

Residual Risk: H-1 remains High because read-only is not a read/config/tool sandbox. A hard crash may leave detached descendants until an OS supervisor reaps them; a forced deadline/second signal can terminate before every pending write and therefore exits nonzero. M-1, server-side workspace/generated-image retention, Windows process-tree behavior, and editor DOM/browser coverage remain open.

Be sure to perform a comprehensive Fortify SAST, SCA and/or DAST as part of your DevOps pipeline.

### Fortify Change Review
Code Changes Reviewed: opt-in Codex soft-isolation process integration; provider availability/warning contract; fixed argv and untrusted-data handoff; process timeout/cancellation; workspace and PNG validation; server registration; manual smoke gate; editor warning surface; README disclosure; and associated test artifacts, together with the previously reviewed local vertical slice.

Security Checks:
- Command Injection and Unsafe Deserialization
- Path Manipulation
- Prompt Injection, Excessive Agency, and Insecure Tool Calling

Findings:
| Category | Status | Location | Attack Path | Recommendation |
|---|---|---|---|---|
| Prompt Injection / Excessive Agency | Flagged | `packages/provider-codex/src/app-server.ts:252` | Untrusted slide/style fields are read by a broadly capable Codex process; read-only limits writes but does not constrain other account-readable files, user configuration, or every configured tool surface. | Retain explicit insecure opt-in only for trusted local experiments; require an OS/container read boundary, minimum tool set, denied network, and whole-tree lifecycle control before production use. |
| Command Injection / Unsafe Deserialization | Fixed | `packages/provider-codex/src/index.ts:43` | Earlier extensibility could have allowed unsafe argument growth; the current child process uses `shell: false`, a fixed argv, trusted executable configuration, bounded streams, and plain data-only `JSON.parse` results that are never dispatched as actions. | Preserve the fixed argv boundary; never accept executable arguments, commands, module names, or tool calls from project/API data. |
| Path Manipulation | Fixed | `packages/provider-codex/src/index.ts:189` | A Codex-controlled output or parent symlink could otherwise redirect the image read outside the job workspace; the current flow checks directory/file type, canonical containment, post-open parent stability, file identity, and uses `O_NOFOLLOW`. | Retain adversarial symlink/replacement tests and move to an OS-isolated workspace to eliminate same-account race and background-descendant assumptions. |
| Insecure Tool Calling | Fixed | `packages/provider-codex/src/index.ts:142` | Malformed or mislabeled agent output could flow into asset persistence; the provider now performs bounded PNG structure/dimension validation and the job runner independently validates provider results before saving. | Keep both validation layers and use trusted decode/re-encode when expanding accepted formats or trust levels. |

Fixes Applied: Dev added explicit opt-in and risk disclosure; fixed no-shell argv execution; removed arbitrary extra arguments; minimized and separated untrusted content; restricted environment/configuration; added bounded output capture, timeout, cancellation, and kill escalation; added realpath/symlink/file-identity checks; added structural PNG and JSONL validation; stopped raw stderr persistence; and added focused negative test artifacts. The earlier repository, HTTP, packaging, and local-first hardening remains effective.

Residual Risk: Codex soft isolation still cannot enforce project-only reads or a complete tool allowlist and is therefore not a secure sandbox. The real `$imagegen` output contract remains unverified because the platform usage limit blocked Spike A and the gated Spike B was not started. Structured secret-free diagnostics for future providers, comprehensive process-tree behavior across platforms, decodable-image validation, and workspace retention remain open. Future uploads, archives, Web Search/RAG, and project import require new focused reviews.

Be sure to perform a comprehensive Fortify SAST, SCA and/or DAST as part of your DevOps pipeline.

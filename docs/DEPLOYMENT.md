# Deployment (Cloud Run + Cloud Storage)

`infra/` deploys the server to Cloud Run with its data directory backed by a Cloud Storage
bucket mounted through gcsfuse. It is sized for a handful of trusted users sharing one data
set, fronted by IAP.

Nothing here is required to run Slide Maker locally — see the [README](../README.md) for that.

## Constraints that are not tuning knobs

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

## Manual steps Terraform does not cover

1. Create the project, link billing, and create the state-free prerequisites yourself.
2. **Configure IAP by hand in the console.** The IAP OAuth Admin APIs were shut down in
   March 2026, and OAuth clients cannot be created programmatically in a project without an
   organization. Terraform deliberately leaves `iap_enabled` and all IAP IAM alone so it
   never fights the console configuration.
3. Add users to the IAP access list (`roles/iap.httpsResourceAccessor`).

Until IAP is configured the service simply rejects everyone: no `roles/run.invoker` binding is
granted to `allUsers`, so unauthenticated requests get a 403.

## Deploy

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

Always pass an explicit tag or digest. Cloud Run does not create a new revision when the
image reference is unchanged.

## Two environment variables exist only for this deployment

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

## Configuring models

No AI environment variables are set in the deployment. `app.ts` only seeds a model library
from the environment on first boot when `models.json` is absent; after that
`SLIDE_MAKER_DATA_ROOT/models.json` is the single source of truth. Add connections and API
keys through the editor UI.

That file holds those API keys in plaintext on the bucket, which is why the bucket enforces
uniform bucket-level access, blocks public access, and is readable only by the runtime
service account.

## Known gaps

- Codex providers are present in the code but the Codex CLI is not installed in the image, so
  they report unavailable.
- Google's OpenAI-compatibility endpoint cannot return images from Gemini image models, has no
  `/images/edits`, and rejects `google_search` grounding. Style references, mask edits and web
  search need a different transport — use the native Gemini provider instead.
- API keys with an IP address restriction do not work: Cloud Run's egress IP is not stable.

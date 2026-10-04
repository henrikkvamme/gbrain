# Existing-brain product runtime

Build from the existing fork pin plus this branch. This package runs the brain and
its deterministic ingestion in Dokploy. It carries no agent executable, agent
login, SSH key, GitHub credential, or development checkout. The fork's Codex
provider and embedding support remain in the source unchanged.

This is an existing-brain migration. Startup never invokes `init`, `reinit-pglite`,
`upgrade`, `apply-migrations`, `config set`, `ollama pull`, or re-embedding. It
requires an existing PGlite store, config and source repositories, sufficient
free disk, and the already installed embedding model. It reads `/api/tags`
without calling inference. Configuration stored inside the DB is preserved with
the DB, including search mode, model tiers, OAuth clients and token state.

## Image and persistence

```sh
docker build -f deploy/runtime/Dockerfile -t your-registry/brain:reviewed-commit .
```

Bun and its dependency lock match the deployed product. Install scripts are
blocked because the package postinstall can migrate a brain. The source runtime
keeps dynamic imports, schema SQL, WASM assets and embedded admin assets available.
Root supplies the digest of the [verified Nix-closure Ollama image](ollama/README.md),
preserving the existing CPU runtime rather than resolving a release tag. No
model bootstrap download runs in this deployment.

`compose.yaml` is a Dokploy Compose template. Root supplies these settings:

| Key | Purpose |
| --- | --- |
| `GBRAIN_DATA_ROOT` | Existing product directory, mounted at the identical absolute path |
| `GBRAIN_HOST_WRITER_LOCK` | Existing shared host flock file, mounted at `/run/brain/writer.lock` |
| `GBRAIN_UID`, `GBRAIN_GID` | Existing storage owner, defaults 1001:1001 |
| `OLLAMA_IMAGE` | Verified closure image pinned by registry manifest digest |
| `OLLAMA_MODEL_PATH`, `OLLAMA_MODEL` | Existing model store and exact model tag |
| `GBRAIN_PUBLIC_URL` | Private HTTPS issuer URL for existing OAuth/MCP clients |
| `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` | Preserved or root-provisioned admin secret; never printed |
| `GBRAIN_HTTP_CORS_ORIGIN` | Existing allowed browser origins, if any |
| `GBRAIN_ENABLE_SEAFILE`, `GBRAIN_ENABLE_GMAIL_APPLY` | Explicit opt-in schedule flags, both default false |
| `SEAFILE_HOST`, `SEAFILE_SINCE`, `SEAFILE_GBRAIN_REPO_TOKEN` | Existing vault origin, selection boundary and read-only token |
| `PLANET_EXPRESS_URL`, `PLANET_EXPRESS_TOKEN` | Existing optional run/health reporting transport |

The data mount includes `gbrain-runtime`, `gbrain-repo`, `gbrain-sources` and
`gbrain-ingestion`, including all backups, projection Git history, import ledgers
and Gmail state. Do not mount an agent home or a whole machine credential store.
Preserve Gmail OAuth files, keyring password, collector state, preparation state,
reply ledger and seed snapshot separately for the Mac collector handoff. The
server bundle consumer does not need Gmail credentials.

Do not change the data's absolute path during initial cutover. Both
`config.database_path` and DB `sources.local_path` may contain that path. To move
storage physically, bind a cold copy to the original container path. Any logical
path change requires a separately verified migration. Compose refuses missing
bind sources rather than making an empty brain directory.

## Single writer and schedules

One runtime owns the existing external flock inode for its whole lifetime. Its
HTTP child owns the PGlite engine while serving. Before any ingestion, the
supervisor terminates the HTTP process group, waits for exit, kills and drains
remaining descendants, then runs the ingestion CLI sequentially. The supervisor
never opens the DB itself. Its HTTP worker closes the listener and disconnects
the engine before exit; an unclean exit prevents the next ingestion owner. After
ingestion exits and its descendants are verified drained, HTTP restarts, including
after an ordinary failed ingestion. Failed inspection, signalling or drain keeps
the cleanup owner and blocks both HTTP restart and later ingestion. Shutdown
retries that cleanup while retaining the external lock. Linux process-group
signals are fenced by the child's captured birth time and session identity;
cleanup never adopts a recycled PID. If cleanup remains uncertain, root must
verify termination before replacing the container or force-stopping it.
HTTP requests
are temporarily unavailable during maintenance. This tradeoff keeps the existing
PGlite engine and provider choices; do not run sidecar CLI writers or replicas.
All host-side legacy writers must still be stopped and fenced before cutover.

The container health probe checks the DB-backed HTTP health endpoint while
serving; during scheduled maintenance it reports supervisor liveness. `lastJob`
reports the last schedule outcome separately. This is not proof of ingestion
success, model inference, or retrieval quality. No raw job output or page content
is emitted to container logs.

Schedules retain hourly Seafile and 15-minute Gmail application, with a five
minute boot delay. Seafile runs five minutes after the hour; Gmail two minutes
after each quarter hour. This replaces randomized systemd delays with fixed
staggering. Persistent slot state catches one missed slot after restart; it does
not replay every historical timer tick. A failed slot retries at the next slot.
Timeouts are 15 minutes for Seafile and 30 minutes per Gmail bundle. The DB-backed
HTTP process may take time to reopen after a job. Watch job state, not only
container health.

Bootstrap is validation on every startup rather than the old destructive
initialization/repair timer. No source registration or index normalization is
performed: existing source registration, federation flags and content must be
verified by root before activation.

## Mac producer and client contract

Gmail collection uses the existing subscription-backed curation provider and
therefore runs on the Mac. The Mac producer must retain the existing collector
and preparation ledgers. It must produce the existing `gmail-threads` manifest
schema with the legacy `bender-communications` source identifier, content hashes,
complete replacement snapshot and retrieval fixture. Preserve source identifiers
and `.bender-ingestion` checkpoints; renaming them breaks replacement ownership.

The product transfer owner provides a restricted authenticated file transfer,
with write access only to an upload directory. Upload outside `ready`, finish all
files, and atomically rename the directory to
`gbrain-ingestion/gmail/ready/<run-id>` on the same filesystem. Run identifiers
contain only letters, digits, `_` and `-`. Never modify a published directory. The
consumer validates generation, source, hashes, evaluation and file confinement.
It advances its scheduler watermark only after sync, extraction and evaluation
succeed. If a crash occurs before that watermark, the same bundle is retried; the
existing importer checkpoints and content-based sync support replay. Keep all
published bundles until root verifies replay/rollback and sets retention. A
lower generation is ignored after a successful newer generation; an equal
generation with a different revision fails closed.

The transfer account, Mac job registration, and collector split are owned by the
fleet/product owner. This repository adds no unauthenticated upload route and
ships no server SSH credential. The current collector's `run` combines curation,
application, attention publication and reply drafting. Its owner must split
application/transport while preserving attention and draft approval behavior.
Do not just run that command on the Mac with a thin-client binary: `sync` and
`extract` require the server-local source/engine.

Ordinary Mac agents use the existing OAuth-authenticated `/mcp` HTTP transport,
with `remote_mcp.mcp_url`, `remote_mcp.oauth_client_id` and
`remote_mcp.oauth_client_secret` (or `GBRAIN_REMOTE_CLIENT_SECRET`) configured in
their existing thin-client installation. Preserve the public issuer and scoped
source grants. Do not mount the live PGlite directory on Macs.

Native `dream` is CLI-local and cannot be scheduled remotely by pointing a thin
client at `/mcp`. Its protected phase handlers are unavailable to untrusted
remote callers. Do not weaken that boundary. The fleet owner must supply a
verified Mac execution/maintenance transport, or a Mac pipeline producing
supported authenticated writes, before retiring these jobs:

| Old work | Destination and preserved cadence |
| --- | --- |
| Gmail collection/curation | Mac, 15-minute incremental cadence, 5-minute boot delay, up to 2-minute jitter |
| Gmail reconciliation plus communication-source dream | Mac, 20:30 Europe/Oslo, persistent, up to 5-minute jitter |
| Behavioral deep review | Mac session owner, 21:30 Europe/Oslo, persistent, up to 5-minute jitter |
| Native dream | Mac, 22:15 Europe/Oslo, after deep review, persistent, up to 5-minute jitter |

Provider/model identifiers and reasoning levels remain those already configured.
Server attempts to invoke the subscription provider fail with a Mac-handoff
message instead of falling back to another provider. The container does not
supply credentials for a new paid provider. Ordinary server operations requiring
subscription generation remain unavailable until the Mac transport is verified.
This is a cutover prerequisite, not permission to discard those features.

## Root cutover and rollback

1. Inventory all callers, source paths, ownership, active jobs, existing DB schema,
   search/model settings, OAuth grants and Ollama model blob digests. Record only
   non-secret metadata. Verify Mac transport and scheduled work before retirement.
2. Stop and disable all old timers/writers, including active jobs and detached
   engine processes. Verify no process owns PGlite or its external lock. Preserve
   old code, units, credentials and complete data. Do not manually remove engine
   locks as a substitute for quiescence.
3. Take a cold, restorable backup of the complete data tree and external ledgers.
   Keep the original untouched until copied/reused persistence is verified. If
   copying, retain UID/GID and bind the copy at the original container path.
4. Test host/container flock contention in both directions on the VPS filesystem.
   Verify UID/GID and lock inode. Local VM-backed bind mounts do not prove host
   Linux locking. Use one replica and stop-first replacement, never rolling
   overlap or auto-deploy before review.
5. Set mounts/environment through Dokploy; start with schedules disabled. Compare
   config bytes, schema, DB row counts, embedding dimensions/digests, source
   registration/federation, OAuth client/token continuity and private HTTP/MCP
   auth/scope behavior. Do not upgrade or re-embed to make acceptance pass.
6. Enable one schedule at a time. Verify actual bundle application, unchanged
   embeddings for unchanged content, retrieval fixtures and successful repeated
   generation replay. Confirm Mac collector, reconciliation, review and dream
   outcomes separately. Only then retire old runtime dependencies.
7. For rollback, stop the new runtime and fence its schedules; verify all process
   groups exited and locks released. Prefer restarting the old pinned runtime on
   the same current data/ledgers when it is compatible. If restoring a snapshot,
   restore DB, projections, ingestion/collector ledgers and scheduler watermark
   together and retain every post-cutover bundle/write for reconciliation. Never
   combine a pre-cutover DB with a newer `state.gmail` watermark. No concurrent
   old and new writers. Do not delete original data or model blobs.

## Local verification

```sh
bun test test/runtime
bunx tsc --project deploy/runtime/tsconfig.json
bash tests/heavy/runtime-container-smoke.sh
```

The smoke test creates a disposable fixture, synthetic model-inventory service
and Linux containers. It proves HTTP health, independent lock contention, stop,
config-byte preservation and page/search-mode/embedding/OAuth-token persistence
without inference.
It never opens the user's brain. Run repository `verify` and broader checks
before integration. Root still owns deployment, live filesystem contention,
OAuth acceptance, real ingestion and Mac schedule verification.

The deterministic ingestion adapter, credential detector and Seafile snapshotter
were imported from the existing product source at
`e3ac9f92f42c924f68449477e404d77250f4d2f8`. Changes here are local import paths,
generic commit identity, path-limited commits and bundle symlink rejection. The
manifest and checkpoint schema, selection rules, lifecycle source IDs, retrieval
gate and reporting protocol remain compatible.

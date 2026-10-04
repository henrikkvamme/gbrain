#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${GBRAIN_DATA_ROOT:?Set the existing product data root}"
: "${GBRAIN_WRITER_LOCK:?Mount the existing writer lock file}"
export GBRAIN_HOME="$GBRAIN_DATA_ROOT/gbrain-runtime"
export HOME="$GBRAIN_HOME/home"
export GBRAIN_RETRIEVAL_REFLEX=false
export GBRAIN_CODEX_BIN=/app/deploy/runtime/mac-only.sh
# This lock stays held across HTTP shutdown, ingestion, and HTTP restart.
# Use the SAME inode as legacy jobs. No replicas or rolling overlap.
exec flock --exclusive --nonblock --no-fork "$GBRAIN_WRITER_LOCK" \
  bun /app/deploy/runtime/supervisor.ts

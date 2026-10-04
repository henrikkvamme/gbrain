#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$GBRAIN_DATA_ROOT"
ingestion="$root/gbrain-ingestion"
case "${1:-}" in
  seafile)
    : "${SEAFILE_HOST:?Preserve the existing Seafile host}"
    : "${SEAFILE_GBRAIN_REPO_TOKEN:?Seafile token is missing}"
    : "${SEAFILE_SINCE:?Preserve the existing selection boundary}"
    export SEAFILE_REPO_TOKEN="$SEAFILE_GBRAIN_REPO_TOKEN"
    bun /app/deploy/runtime/ingestion/gbrain-ingestion.ts prepare-seafile \
      --host "$SEAFILE_HOST" \
      --vault "$ingestion/sources/seafile-obsidian-vault" \
      --bundle "$ingestion/bundles/obsidian-notes" \
      --state "$ingestion/seafile-obsidian-notes.json" \
      --seed-repo "$root/gbrain-sources/bender-authored" \
      --since "$SEAFILE_SINCE" > /dev/null
    unset SEAFILE_REPO_TOKEN
    bun /app/deploy/runtime/ingestion/gbrain-ingestion.ts apply \
      --bundle "$ingestion/bundles/obsidian-notes" \
      --repo "$root/gbrain-sources/bender-authored" \
      --gbrain-bin /app/deploy/runtime/gbrain.sh > /dev/null
    ;;
  apply-gmail)
    : "${2:?Published immutable bundle directory is required}"
    bun /app/deploy/runtime/ingestion/gbrain-ingestion.ts apply \
      --bundle "$2" --repo "$root/gbrain-sources/bender-communications" \
      --gbrain-bin /app/deploy/runtime/gbrain.sh > /dev/null
    ;;
  *) printf '%s\n' 'Usage: jobs.sh seafile|apply-gmail <bundle>' >&2; exit 2 ;;
esac

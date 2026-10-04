#!/usr/bin/env sh
# Internal child of the lock-owning supervisor only. Never docker exec this.
exec bun /app/src/cli.ts "$@"

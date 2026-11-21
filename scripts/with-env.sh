#!/usr/bin/env bash
# ============================================================
# with-env.sh — run a command with .env applied with OVERRIDE
# semantics.
#
# Why: the sandbox harness injects a stale DATABASE_URL (a SQLite
# file path) into the process environment of every command — and
# periodically rewrites .env AND .env.local itself (session
# restarts also wipe dev.log, pgdata, and all processes). Both the
# Prisma CLI and Next.js give precedence to existing process env
# over .env files, so the injected value silently wins and breaks
# the PostgreSQL datasource.
#
# Sourcing order (last wins):
#   1. .env                          — repo default (harness-managed)
#   2. .env.local                    — repo local override (harness
#                                      wipes this on restarts too)
#   3. ~/.config/tweetfess-controller/env — OUTSIDE the repo, so it
#                                      survives harness resets. This
#                                      is the sandbox-resilience
#                                      layer; keep the real secrets
#                                      here.
#
# When none of the files exist (e.g. production builds on Vercel,
# where the platform injects the real values), the wrapper is a
# transparent pass-through.
#
# Usage: bash scripts/with-env.sh <command> [args…]
#   e.g. bash scripts/with-env.sh prisma db push
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_FILES=(
  "$ROOT_DIR/.env"
  "$ROOT_DIR/.env.local"
  "${HOME:-/home/z}/.config/tweetfess-controller/env"
)

for env_file in "${ENV_FILES[@]}"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done

exec "$@"

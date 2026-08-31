#!/usr/bin/env bash
#
# Pull and redeploy.
#
#   bash deploy/update.sh                      # normal update
#   bash deploy/update.sh --accept-data-loss   # when the schema drops a column
#
# The point of this script is the database step. The obvious update -- pull,
# build, restart -- is wrong whenever prisma/schema.prisma has changed, and it
# fails in a way that does not look like a database problem at all: the
# generated Prisma client is what validates a query, so a stale client rejects
# the write itself, with an error naming a column that no longer exists in the
# schema you are looking at. Regenerating is not optional and is easy to forget,
# so it lives here instead of in a list of steps.
#
# The server is still never compiled -- PM2 runs the TypeScript through tsx.
# Only the client is built.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()  { printf '    \033[32m%s\033[0m\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1"; }

ACCEPT_DATA_LOSS=""
if [ "${1:-}" = "--accept-data-loss" ]; then
  ACCEPT_DATA_LOSS="--accept-data-loss"
fi

say "Pulling"
git pull
ok "$(git log -1 --format='%h %s')"

say "Installing dependencies"
pnpm install --frozen-lockfile

# --- database --------------------------------------------------------------
# Backed up before the schema is touched, not after. `db push` can rewrite a
# table, and on the one deploy where that goes wrong the backup is the only
# copy of everyone's match history.
say "Database"
DB_PATH="$ROOT/data/nmu.db"
if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "$DB_PATH.bak"
  ok "backed up to $(basename "$DB_PATH").bak"
fi

# Regenerates the client as its final step, which is the part that a plain
# pull-and-restart misses.
if ! ( cd apps/server && pnpm exec prisma db push $ACCEPT_DATA_LOSS ); then
  warn "prisma db push failed"
  warn "If it refused because the change drops data, re-run:"
  warn "    bash deploy/update.sh --accept-data-loss"
  warn "Your database is unchanged, and $(basename "$DB_PATH").bak holds a copy."
  exit 1
fi
ok "schema and Prisma client are in sync"

say "Building the client"
pnpm --filter @nmu/web build
ok "client -> apps/web/dist"

say "Restarting"
pm2 restart no-mercy-uno
pm2 save >/dev/null 2>&1 || true

say "Done"
ok "pm2 logs no-mercy-uno   # to watch it"

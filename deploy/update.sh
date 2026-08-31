#!/usr/bin/env bash
#
# Pull and redeploy.
#
#   bash deploy/update.sh                      # normal update
#   bash deploy/update.sh --accept-data-loss   # schema drops a column
#   bash deploy/update.sh --force-reset        # schema adds a required column
#                                              # to a populated table; ALL DATA GOES
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

# Two different escape hatches, for two different refusals:
#
#   --accept-data-loss  a column or table is going away and Prisma wants it
#                       said out loud.
#   --force-reset       the schema adds a REQUIRED column with no default to a
#                       table that already has rows. There is no value Prisma
#                       could put in the existing rows, so no amount of
#                       "accept data loss" helps -- the only way through is to
#                       drop the database and recreate it empty.
#
# Neither is passed by default. A schema mistake should stop the deploy.
DB_FLAG=""
case "${1:-}" in
  "") ;;
  --accept-data-loss|--force-reset) DB_FLAG="$1" ;;
  *) echo "unknown option: $1 (expected --accept-data-loss or --force-reset)" >&2; exit 2 ;;
esac

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
if ! ( cd apps/server && pnpm exec prisma db push $DB_FLAG ); then
  warn "prisma db push failed -- read which of the two it is:"
  warn ""
  warn "  \"cannot be executed ... without a default value\", with rows in the table"
  warn "      A new required column has no value for the rows already there."
  warn "      --accept-data-loss will NOT help: this is impossible, not forbidden."
  warn "      Clear the offending table and re-run -- no destructive flag needed,"
  warn "      and every other table survives. For the User table:"
  warn "          cd apps/server"
  warn "          echo 'DELETE FROM User;' | pnpm exec prisma db execute --stdin \\"
  warn "              --schema prisma/schema.prisma"
  warn "          cd .. && bash deploy/update.sh"
  warn "      Only if that is not enough:  bash deploy/update.sh --force-reset"
  warn "      (--force-reset drops EVERYTHING, every table.)"
  warn ""
  warn "  \"you may lose data\" / a column or table is being dropped"
  warn "          bash deploy/update.sh --accept-data-loss"
  warn ""
  warn "Your database is untouched. $(basename "$DB_PATH").bak holds a copy."
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

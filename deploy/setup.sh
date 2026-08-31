#!/usr/bin/env bash
#
# One-shot setup for a plain Ubuntu box.
#
#   bash deploy/setup.sh
#
# Adds swap if missing, installs, builds the client, writes a .env, creates the
# database, and starts the server under PM2 on port 3000. Safe to re-run: it
# skips anything already done and never overwrites an existing .env.
#
# It does NOT touch nginx -- it prints the block to paste at the end.
#
# The server is NOT compiled. PM2 runs the TypeScript directly through tsx, so
# there is nothing to rebuild after a git pull. Only the client is built, and
# that is not avoidable: browsers cannot load .tsx files, so something has to
# turn them into JS. Doing it once here beats running Vite's dev server
# permanently, which would hold the whole module graph in memory and make every
# page load hundreds of requests instead of two.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()  { printf '    \033[32m%s\033[0m\n' "$1"; }

# --- 1. swap ---------------------------------------------------------------
# A 2 GB box has none by default and the install gets OOM-killed, which shows
# up as a bare "Killed" with no explanation.
say "Swap"
if [ "$(swapon --show --noheadings | wc -l)" -gt 0 ]; then
  ok "already present"
else
  ok "adding 2G swapfile (needed or the install gets killed)"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# --- 2. install and build the client ---------------------------------------
say "Installing dependencies"
pnpm install --frozen-lockfile

say "Building the client"
pnpm --filter @nmu/server exec prisma generate
pnpm --filter @nmu/web build
ok "client -> apps/web/dist (the server serves these files)"

# --- 3. config -------------------------------------------------------------
say "Configuration"
ENV_FILE="$ROOT/apps/server/.env"

if [ -f "$ENV_FILE" ]; then
  ok ".env already exists, leaving it alone"
else
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  cat > "$ENV_FILE" <<EOF
# Written by deploy/setup.sh

# development keeps the name-only sign-in enabled, so nobody has to set up
# Google OAuth. Anyone who can reach the site can sign in as any name -- fine
# for a private game, not fine if the URL gets out.
NODE_ENV=development

PORT=3000
HOST=127.0.0.1

DATABASE_URL=file:$ROOT/data/nmu.db
WEB_DIST=$ROOT/apps/web/dist

SESSION_SECRET=$SECRET

# Set this to the address you actually type in the browser.
CORS_ORIGINS=http://localhost:3000

# Leave empty to hide the Google button entirely.
GOOGLE_CLIENT_ID=

# Voice needs HTTPS (browsers refuse the microphone otherwise) and a TURN
# relay to work across different networks. Neither is set up here.
STUN_URLS=stun:stun.l.google.com:19302
EOF
  ok "wrote apps/server/.env with a generated SESSION_SECRET"
fi

say "Database"
mkdir -p "$ROOT/data"
( cd apps/server && pnpm exec prisma db push --skip-generate >/dev/null )
ok "SQLite ready at $ROOT/data/nmu.db"

# --- 4. run ----------------------------------------------------------------
say "Starting under PM2"
sudo mkdir -p /var/log/no-mercy-uno
sudo chown "$USER" /var/log/no-mercy-uno

pm2 delete no-mercy-uno >/dev/null 2>&1 || true

# node --import tsx runs the TypeScript straight from src. One instance only:
# rooms live in an in-process Map with no Redis adapter, so a second worker
# would put players from the same room on different processes.
pm2 start src/index.ts \
  --name no-mercy-uno \
  --cwd "$ROOT/apps/server" \
  --interpreter node \
  --interpreter-args "--import tsx" \
  -i 1 \
  --time \
  --max-memory-restart 600M
pm2 save >/dev/null

sleep 3
if curl -fsS -m 5 http://127.0.0.1:3000/api/health >/dev/null; then
  ok "server is up on 127.0.0.1:3000"
else
  printf '\n\033[31m    server did not answer on :3000 — run: pm2 logs no-mercy-uno\033[0m\n'
  exit 1
fi

# --- 5. nginx ---------------------------------------------------------------
cat <<'NGINX'

==> Last step: nginx

Paste this into your nginx config (a new server block, or swap the location
into an existing one), then reload:

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 24h;
        proxy_buffering off;
    }

    sudo nginx -t && sudo systemctl reload nginx

The Upgrade/Connection lines and the long timeout are not optional -- without
them the websocket never connects, or everyone is dropped 60 seconds after the
table goes quiet.

Then set CORS_ORIGINS in apps/server/.env to the address you actually open in
the browser (e.g. http://uno.bunkcode.online) and run: pm2 restart no-mercy-uno

NGINX

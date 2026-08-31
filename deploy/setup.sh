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

# Work out how the browser will address this box. On Lightsail the instance
# only knows its private IP, so ask the metadata service (and fall back to a
# public echo) for the address people will actually type.
PUBLIC_IP="$(curl -fsS -m 5 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I | awk '{print $1}')"
SITE_URL="http://$PUBLIC_IP"
ok "this box looks like $SITE_URL"

if [ -f "$ENV_FILE" ]; then
  ok ".env already exists, leaving it alone"
  # One exception: if CORS_ORIGINS is still the placeholder we wrote, point it
  # at this box. Getting it wrong means every API call is refused, and it is
  # the single most likely thing to be left unedited.
  if grep -q '^CORS_ORIGINS=http://localhost:3000$' "$ENV_FILE"; then
    sed -i "s|^CORS_ORIGINS=http://localhost:3000$|CORS_ORIGINS=$SITE_URL|" "$ENV_FILE"
    ok "updated CORS_ORIGINS to $SITE_URL"
  fi
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

# The address the browser uses. Detected from this instance.
CORS_ORIGINS=$SITE_URL

# Anyone with this code can create an account. Change it and restart to stop
# new signups; accounts that already exist are not affected.
SIGNUP_CODE=94997749

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
say "Last step: nginx"
cat <<EOF

Install the site config and reload:

    sudo cp deploy/nginx.conf /etc/nginx/sites-available/no-mercy-uno
    sudo ln -sf /etc/nginx/sites-available/no-mercy-uno /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx

Then open:  $SITE_URL

The shipped config already has server_name $PUBLIC_IP. If you put a domain on
this later, change that line and run certbot -- HTTPS is what makes voice chat
possible, since browsers refuse the microphone on a plain http:// origin.

EOF

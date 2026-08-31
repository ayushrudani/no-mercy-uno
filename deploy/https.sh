#!/usr/bin/env bash
#
# Put the site on a domain with HTTPS, without losing access on the bare IP.
#
#   bash deploy/https.sh uno.bunkcode.online
#
# Safe to re-run: it reuses a certificate that is still valid and only reissues
# when there is not one.
#
# What you end up with:
#
#   https://uno.bunkcode.online   real certificate, and the only one where the
#                                 microphone works -- browsers refuse
#                                 getUserMedia on an insecure origin
#   http://uno.bunkcode.online    redirected to HTTPS
#   http://<public ip>            still served, plain HTTP, no redirect
#
# The IP deliberately does NOT redirect to HTTPS. No public CA will issue a
# certificate for a bare IP address, so redirecting there would send people to
# a URL that can only ever show a certificate warning. Plain HTTP on the IP is
# the honest fallback: everything works except voice.

set -euo pipefail

DOMAIN="${1:-uno.bunkcode.online}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/server/.env"
WEBROOT=/var/www/certbot
SITE=/etc/nginx/sites-available/no-mercy-uno
SNIPPET=/etc/nginx/snippets/no-mercy-uno-proxy.conf

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$1" >&2; exit 1; }

case "$DOMAIN" in
  -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
  *.*) ;;
  *) die "that does not look like a domain: $DOMAIN" ;;
esac

# --- 1. does the domain actually point here? -------------------------------
#
# Checked before anything is installed. Let's Encrypt validates by fetching a
# file over HTTP from whatever the name resolves to, so a domain pointing
# somewhere else fails at the last and slowest step. Better to say so now.
say "Checking DNS"
PUBLIC_IP="$(curl -fsS -m 5 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I | awk '{print $1}')"
ok "this box is $PUBLIC_IP"

RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -z "$RESOLVED" ]; then
  die "$DOMAIN does not resolve yet. DNS can take a while -- wait and re-run."
elif [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  warn "$DOMAIN resolves to $RESOLVED, but this box is $PUBLIC_IP"
  warn "Certificate issuance will fail unless that A record points here."
  read -r -p "    Carry on anyway? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "stopped"
else
  ok "$DOMAIN -> $PUBLIC_IP"
fi

# --- 2. packages ------------------------------------------------------------
say "Packages"
NEEDED=()
command -v nginx   >/dev/null || NEEDED+=(nginx)
command -v certbot >/dev/null || NEEDED+=(certbot)
if [ ${#NEEDED[@]} -gt 0 ]; then
  sudo apt-get update -qq
  sudo apt-get install -y "${NEEDED[@]}"
  ok "installed: ${NEEDED[*]}"
else
  ok "nginx and certbot already present"
fi

sudo mkdir -p "$WEBROOT" /etc/nginx/snippets
sudo chmod 755 "$WEBROOT"

# --- 3. the proxy rules, written once and included by every server block ----
#
# In a snippet rather than repeated three times. The websocket timeouts are the
# part that must not drift between blocks: nginx defaults proxy_read_timeout to
# 60s, and with that every player is silently dropped a minute after the table
# goes quiet, which looks exactly like a flaky connection.
say "nginx"
sudo tee "$SNIPPET" >/dev/null <<'SNIP'
# Written by deploy/https.sh -- included by the No Mercy UNO server blocks.

client_max_body_size 1m;

gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;
gzip_min_length 1024;

# Socket.IO holds a connection open for a whole game night: HTTP/1.1 upgrade
# headers, buffering off, and a timeout measured in hours. Must come before the
# catch-all location.
location /socket.io/ {
    proxy_pass http://127.0.0.1:3000;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
}

# The Node process serves the built client itself, including the SPA fallback
# and the /api 404s, so nginx proxies the lot rather than duplicating that.
location / {
    proxy_pass http://127.0.0.1:3000;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 120s;
}
SNIP

# --- 4. HTTP-only config, so the ACME challenge can be answered -------------
#
# The certificate does not exist yet, so a config referencing it would stop
# nginx from starting at all. This intermediate step exists purely to serve
# /.well-known/acme-challenge/ over port 80.
write_http_only() {
  sudo tee "$SITE" >/dev/null <<CONF
# Written by deploy/https.sh -- do not hand-edit, re-run the script instead.

# The bare IP, and anything else pointed at this box. Plain HTTP on purpose:
# no CA issues certificates for an IP, so there is nothing to redirect to.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    include $SNIPPET;

    access_log /var/log/nginx/no-mercy-uno.access.log;
    error_log  /var/log/nginx/no-mercy-uno.error.log;
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root $WEBROOT; }

    include $SNIPPET;

    access_log /var/log/nginx/no-mercy-uno.access.log;
    error_log  /var/log/nginx/no-mercy-uno.error.log;
}
CONF
}

write_https() {
  sudo tee "$SITE" >/dev/null <<CONF
# Written by deploy/https.sh -- do not hand-edit, re-run the script instead.

# --- the bare IP, and anything else pointed at this box --------------------
#
# Plain HTTP, and deliberately not redirected. No public CA will issue a
# certificate for an IP address, so a redirect here could only ever land on a
# certificate warning. Everything works except the microphone, which browsers
# refuse to open on an insecure origin.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    include $SNIPPET;

    access_log /var/log/nginx/no-mercy-uno.access.log;
    error_log  /var/log/nginx/no-mercy-uno.error.log;
}

# --- the domain on HTTP: renewals, then redirect ---------------------------
#
# The ACME location sits above the redirect on purpose. Let's Encrypt fetches
# the challenge over plain HTTP, and a blanket redirect would bounce it to
# HTTPS and break every future renewal.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root $WEBROOT; }

    location / { return 301 https://\$host\$request_uri; }
}

# --- the domain on HTTPS ---------------------------------------------------
server {
    # No http2 directive on purpose. `http2 on;` needs nginx 1.25.1+ and is a
    # hard config error on the 1.18 and 1.24 that Ubuntu 22.04 and 24.04 ship,
    # while the older `listen ... http2` form is deprecated on new ones. There
    # is nothing to gain here either way: the long-lived connection is a
    # websocket, which does not use HTTP/2.
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # Written out here rather than including certbot's options file, which is
    # not always present, and never fetched from the internet at deploy time.
    # No ssl_dhparam: these suites are all ECDHE, which does not use one.
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    include $SNIPPET;

    access_log /var/log/nginx/no-mercy-uno.access.log;
    error_log  /var/log/nginx/no-mercy-uno.error.log;
}
CONF
}

# Ubuntu's default site also claims default_server on port 80; two of those is
# a startup error, not a warning.
if [ -e /etc/nginx/sites-enabled/default ]; then
  sudo rm -f /etc/nginx/sites-enabled/default
  ok "removed nginx's default site (it also claimed default_server)"
fi

CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
if sudo test -f "$CERT_DIR/fullchain.pem"; then
  ok "certificate already present for $DOMAIN"
  write_https
else
  write_http_only
  sudo ln -sf "$SITE" /etc/nginx/sites-enabled/no-mercy-uno
  sudo nginx -t
  sudo systemctl reload nginx || sudo systemctl start nginx
  ok "serving HTTP so the challenge can be answered"

  say "Certificate"
  EMAIL_ARGS=(--register-unsafely-without-email)
  if [ -n "${CERTBOT_EMAIL:-}" ]; then
    EMAIL_ARGS=(--email "$CERTBOT_EMAIL")
  fi
  if ! sudo certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
        --agree-tos --non-interactive "${EMAIL_ARGS[@]}"; then
    warn "certbot failed. The usual causes, in order:"
    warn "  1. port 80 is closed in the Lightsail firewall"
    warn "  2. the A record for $DOMAIN does not point at $PUBLIC_IP yet"
    warn "  3. rate limited after several failed attempts (wait an hour)"
    warn "The site is still up on http://$PUBLIC_IP -- re-run when fixed."
    exit 1
  fi
  ok "certificate issued"
  write_https
fi

sudo ln -sf "$SITE" /etc/nginx/sites-enabled/no-mercy-uno
sudo nginx -t
sudo systemctl reload nginx
ok "nginx serving $DOMAIN over HTTPS, and $PUBLIC_IP over HTTP"

# --- 5. renewal -------------------------------------------------------------
#
# certbot's timer renews the certificate but has no reason to know nginx is
# holding the old one in memory. Without this hook the site keeps serving an
# expired certificate until something else reloads it.
say "Renewal"
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'HOOK'
#!/bin/sh
# Written by deploy/https.sh
systemctl reload nginx
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
ok "nginx reloads automatically after each renewal"
sudo certbot renew --dry-run --cert-name "$DOMAIN" >/dev/null 2>&1 \
  && ok "renewal dry run passed" \
  || warn "renewal dry run failed -- check: sudo certbot renew --dry-run"

# --- 6. tell the app about both addresses ----------------------------------
say "Application config"
if [ ! -f "$ENV_FILE" ]; then
  die "no $ENV_FILE -- run deploy/setup.sh first"
fi

ORIGINS="https://$DOMAIN,http://$DOMAIN,http://$PUBLIC_IP"
if grep -q '^CORS_ORIGINS=' "$ENV_FILE"; then
  sudo sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=$ORIGINS|" "$ENV_FILE"
else
  echo "CORS_ORIGINS=$ORIGINS" | sudo tee -a "$ENV_FILE" >/dev/null
fi
ok "CORS_ORIGINS=$ORIGINS"

# Production marks the session cookie Secure, which is the point of having a
# certificate. It does not lock anyone out of the IP: the client also sends the
# session token as a bearer header, so plain HTTP still works there.
if grep -q '^NODE_ENV=' "$ENV_FILE"; then
  sudo sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" "$ENV_FILE"
else
  echo "NODE_ENV=production" | sudo tee -a "$ENV_FILE" >/dev/null
fi
ok "NODE_ENV=production (session cookie is now Secure)"

if command -v pm2 >/dev/null && pm2 describe no-mercy-uno >/dev/null 2>&1; then
  pm2 restart no-mercy-uno --update-env >/dev/null
  ok "restarted no-mercy-uno"
else
  warn "pm2 process 'no-mercy-uno' not found -- start it with deploy/setup.sh"
fi

# --- done -------------------------------------------------------------------
say "Done"
cat <<DONE
    https://$DOMAIN      <- share this one; voice only works here
    http://$PUBLIC_IP    <- still works, no voice

    Open 443 in the Lightsail firewall if you have not already:
      Lightsail console -> your instance -> Networking -> IPv4 Firewall
      -> Add rule -> HTTPS (TCP 443)

    Voice between people on different networks also needs a TURN relay.
    HTTPS gets the microphone open; TURN is what carries the audio when
    two players are behind NATs that STUN cannot punch through.
    See docs/DEPLOY.md.
DONE

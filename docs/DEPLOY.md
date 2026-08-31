# Deploying to Lightsail (PM2 + nginx)

Target: `uno.bunkcode.online` on an Ubuntu Lightsail instance you already run
with PM2 and nginx. No Docker.

> **Just want it running?** [QUICKSTART.md](QUICKSTART.md) is one script plus an
> nginx block. It skips Google sign-in, HTTPS and voice. Come back here when you
> want those.

Three processes end up on the box:

```
nginx        :80 / :443    TLS, reverse proxy, websocket upgrade
node (pm2)   :3000         API + websockets + the built client
coturn       :3478 + UDP   voice relay
```

The database is a single SQLite file. There is no database server to run.

---

## 1. Prerequisites

```sh
node -v          # needs 22+
sudo npm i -g pnpm pm2
sudo apt update && sudo apt install -y nginx coturn certbot python3-certbot-nginx
```

Point an A record for `uno.bunkcode.online` at the instance's **static IP**.
Allocate a static IP first if you have not — a Lightsail instance's default
public IP changes when it is stopped and started.

---

## 2. Firewall

Open these in the **Lightsail networking tab**, not just `ufw`. The UDP relay
range is the one people forget, and without it TURN accepts the handshake and
then relays nothing.

| Port | Protocol | Why |
|---|---|---|
| 80 | TCP | HTTP, and certbot's challenge |
| 443 | TCP | HTTPS — **mandatory**, `getUserMedia` refuses an insecure origin |
| 3478 | TCP + UDP | TURN |
| 5349 | TCP + UDP | TURN over TLS (optional) |
| 49160–49360 | **UDP** | TURN relay range, matching `turnserver.conf` |

---

## 3. Google OAuth

Google Cloud Console → APIs & Services → Credentials → **OAuth 2.0 Client ID**
(Web application). Authorised JavaScript origins:

```
https://uno.bunkcode.online
http://localhost:5173      (development only)
```

Copy the client ID into `GOOGLE_CLIENT_ID`.

---

## 3b. Swap (do this before the first build)

A 2 GB Lightsail instance has no swap by default, and both `pnpm install` and
the Vite build will push it over. The symptom is a bare `Killed` with no other
output — that is the kernel OOM killer, not a broken command.

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h        # confirm the swap line is non-zero
```

Builds are slower with swap than with real memory, but they finish. This is a
one-off; the running server needs well under 200 MB.

---

## 4. Get the code and build

```sh
sudo mkdir -p /var/www && cd /var/www
sudo git clone <your-repo> no-mercy-uno
sudo chown -R $USER:$USER no-mercy-uno
cd no-mercy-uno

pnpm install --frozen-lockfile
pnpm --filter @nmu/server exec prisma generate
pnpm --filter @nmu/web build
pnpm --filter @nmu/server build
```

`pnpm --filter @nmu/server build` bundles `@nmu/engine` and `@nmu/shared`
inline, so the server is one file: `apps/server/dist/index.js`.

---

## 5. Secrets

```sh
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 32      # TURN_SECRET
```

`TURN_SECRET` must appear **twice, identically**: as `TURN_SECRET` in
`apps/server/.env`, and as `static-auth-secret` in `/etc/turnserver.conf`. The
app signs `<expiry>:<userId>` with it and coturn recomputes the same HMAC. If
they differ, relayed connections are rejected and voice fails **only** for the
people who needed the relay — which is a genuinely miserable thing to debug
from the outside.

---

## 6. Configure the app

```sh
cp apps/server/.env.example apps/server/.env
```

```sh
NODE_ENV=production
PORT=3000
HOST=127.0.0.1                 # nginx is the only thing that should reach it

DATABASE_URL=file:/var/www/no-mercy-uno/data/nmu.db
WEB_DIST=/var/www/no-mercy-uno/apps/web/dist

GOOGLE_CLIENT_ID=...apps.googleusercontent.com
SESSION_SECRET=...
CORS_ORIGINS=https://uno.bunkcode.online

STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:uno.bunkcode.online:3478
TURN_SECRET=...
TURN_TTL_SECONDS=3600
```

`HOST=127.0.0.1` matters: bound to `0.0.0.0` the Node process is reachable on
port 3000 directly, bypassing nginx and therefore TLS.

`NODE_ENV=production` also removes the development sign-in route entirely — the
handler is never registered, so it cannot be re-enabled by a stray variable.

Create the database directory and schema:

```sh
mkdir -p /var/www/no-mercy-uno/data
cd apps/server && pnpm exec prisma db push && cd ../..
```

---

## 7. coturn

```sh
sudo cp deploy/coturn.conf /etc/turnserver.conf
sudo nano /etc/turnserver.conf
```

Replace two placeholders:

- `external-ip=$PUBLIC_IP/$PRIVATE_IP` → the instance's real addresses, e.g.
  `external-ip=13.234.56.78/172.26.5.10`. **Lightsail gives the box a private
  IP behind a mapped public one**, so coturn must be told the public address
  explicitly or every candidate it hands out is unroutable.
- `static-auth-secret=$TURN_SECRET` → the secret from step 5.

Find the private IP with `hostname -I` and the public one in the Lightsail
console.

```sh
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable --now coturn
sudo systemctl status coturn
```

---

## 8. nginx

```sh
sudo cp deploy/nginx.conf /etc/nginx/sites-available/no-mercy-uno
sudo ln -s /etc/nginx/sites-available/no-mercy-uno /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d uno.bunkcode.online
```

certbot fills in the TLS lines and sets up renewal.

The site config has a dedicated `location /socket.io/` block with the HTTP/1.1
upgrade headers, `proxy_buffering off`, and 24-hour timeouts. **Do not drop
it.** nginx's default `proxy_read_timeout` is 60 seconds, which would silently
disconnect every player a minute after the table goes quiet — indistinguishable
from a flaky connection.

---

## 9. Preflight

From the repo root, before starting anything:

```sh
pnpm preflight
```

It checks the mistakes that fail *quietly*: a `TURN_SECRET` that does not match
coturn's, an unreplaced `$PUBLIC_IP`, a `CORS_ORIGINS` that does not match the
site domain, `NODE_ENV` left on development. None of these crash anything —
they just break one thing for some people. Exits non-zero until it is happy.

---

## 10. Start with PM2

```sh
sudo mkdir -p /var/log/no-mercy-uno && sudo chown $USER /var/log/no-mercy-uno

pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup        # run the command it prints, so it survives a reboot

pm2 logs no-mercy-uno
```

**The config pins `instances: 1` and `exec_mode: 'fork'`, and that is a
correctness requirement, not tuning.** Rooms live in an in-process Map and
Socket.IO has no Redis adapter here. Under cluster mode with two or more
workers, two players who joined the same room could land on different
processes: each would see a room containing only themselves, neither could
start a game, and every broadcast would reach half the table.

---

## 11. Verify, in this order

```sh
curl -s https://uno.bunkcode.online/api/health          # {"ok":true,...}
```

Then in a browser:

1. The page loads and Google sign-in works.
2. `https://uno.bunkcode.online/api/auth/dev` returns **404**. If it returns a
   token, `NODE_ENV` is not `production` and anyone can sign in as anyone.
3. Open a room on two devices and play a hand — that exercises the websocket
   path through nginx.
4. `https://uno.bunkcode.online/api/voice/ice` (signed in) must show
   `"hasTurn": true` and a `username` of `<unix-timestamp>:<userId>`.
5. Paste those `urls`, `username` and `credential` into <https://icetest.info>,
   or open `chrome://webrtc-internals` during a call. You are looking for a
   candidate of type **`relay`**. If only `host` and `srflx` appear, TURN is
   not actually working and voice will fail for exactly the people on the worst
   networks.
6. Two phones on **different networks** — one on wifi, one on mobile data.
   That is the case STUN cannot solve and the reason coturn exists.

---

## Updating

```sh
cd /var/www/no-mercy-uno
git pull
pnpm install --frozen-lockfile
pnpm --filter @nmu/server exec prisma generate
pnpm --filter @nmu/web build
pnpm --filter @nmu/server build
cd apps/server && pnpm exec prisma db push && cd ../..
pm2 reload no-mercy-uno
```

`pm2 reload` is graceful — the server closes its socket server and disconnects
Prisma on SIGTERM. Any game in progress is still lost, because rooms are in
memory. Deploy between games.

---

## Backups

The whole database is one file:

```sh
sqlite3 /var/www/no-mercy-uno/data/nmu.db ".backup '/home/ubuntu/nmu-$(date +%F).db'"
```

Use `.backup` rather than `cp` — it takes a consistent snapshot even while the
server is writing.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Killed` during install or build, no other output | Out of memory. Add swap — see step 3b. |
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | The lockfile contains a package published within the policy window. See below. |
| Page loads, but the game never starts | Websocket blocked. Check the `location /socket.io/` block is present and `nginx -t` passes. |
| Everyone disconnects ~60s after going quiet | `proxy_read_timeout` reverted to the default. |
| Players in one room cannot see each other | PM2 running more than one instance. `pm2 describe no-mercy-uno` and check `instances`. |
| Microphone never opens | Not on HTTPS, or the certificate is not valid. |
| Voice connects for some people, not others | TURN. Check the secret matches and the UDP range is open in the **Lightsail** firewall. |
| `/api/auth/dev` returns a token | `NODE_ENV` is not `production`. Fix immediately — it is passwordless sign-in as anyone. |
| Server restart-loops on boot | Bad `.env`. `pm2 logs no-mercy-uno` shows the validation error; the process refuses to start rather than run misconfigured. |

---

## When pnpm rejects the lockfile

```
ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
  <pkg>@<version> was published at ..., within the minimumReleaseAge cutoff
```

pnpm refuses packages published too recently — a supply-chain guard against a
freshly compromised release. It fires when a lockfile is generated on a dev
machine the same day one of its transitive dependencies shipped.

The repo guards against this in two ways:

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so the policy is
  declared in the repo rather than only on the server.
- `package.json` pins `electron-to-chromium` through `pnpm.overrides`. It is a
  build-time data table pulled in by `browserslist` (via Vite) that publishes
  several times a week, which makes it the most likely package to trip this.

**If it happens again with a different package**, in order of preference:

1. Pin it. Find a version old enough and add it to `pnpm.overrides` in
   `package.json`, regenerate the lockfile locally, commit, and redeploy. This
   keeps `--frozen-lockfile` meaningful.
2. Wait. The cutoff is a rolling window, so the same lockfile passes tomorrow.
3. Last resort, on the server only:
   ```sh
   pnpm install --frozen-lockfile --config.minimumReleaseAge=0
   ```
   This bypasses the guard. Only do it when you know what the package is and
   why it is new.

Do **not** fix it by running `pnpm install` without `--frozen-lockfile` on the
server. That rewrites the lockfile on the box, so what you deploy stops
matching what you tested.

---

## Costs to watch

TURN relays real bandwidth, and Lightsail bills egress beyond the plan's
allowance. Only connections that cannot go peer-to-peer are relayed, and audio
is capped at 128 kbps per stream by `max-bps` in the coturn config. For a group
this size it is small, but it is the one line item that scales with use.

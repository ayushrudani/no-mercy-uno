# Deploying

Ubuntu box with nginx and PM2 already on it. One script, one nginx block.

---

## 1. Run the setup script

```sh
cd /var/www/no-mercy-uno
git pull
bash deploy/setup.sh
```

It adds swap if missing, installs, builds the client, writes
`apps/server/.env` with a generated secret, creates the SQLite database, and
starts the server under PM2 on **127.0.0.1:3000**.

Safe to re-run. It never overwrites an existing `.env`.

## 2. Point nginx at port 3000

Add this to your site config:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 24h;
    proxy_buffering off;
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
```

**The four lines after `proxy_pass` are the ones that matter.** Without
`Upgrade`/`Connection` the websocket never connects and the game never starts.
Without the long `proxy_read_timeout`, nginx's 60-second default silently
disconnects everyone a minute after the table goes quiet — which looks exactly
like bad wifi.

## 3. Tell the app its address

In `apps/server/.env`, set `CORS_ORIGINS` to whatever you type in the browser:

```sh
CORS_ORIGINS=http://uno.bunkcode.online
```

```sh
pm2 restart no-mercy-uno
```

Open the site, type a name, create a room, share the code.

---

## Updating

```sh
cd /var/www/no-mercy-uno
git pull
pnpm --filter @nmu/web build     # only if the client changed
pm2 restart no-mercy-uno
```

**The server is never compiled.** PM2 runs the TypeScript straight from `src`
through `tsx`, so a server-only change needs nothing but the restart.

The client is built once because a browser cannot load `.tsx` files — something
has to turn them into JavaScript. The only way to skip that is to run Vite's
dev server permanently, which holds the whole module graph in memory and turns
every page load into hundreds of requests instead of two. More setup and
slower, not less.

---

## What this setup gives up

**Anyone who reaches the site can sign in as any name.** The script sets
`NODE_ENV=development`, which keeps the name-only sign-in enabled so you do not
have to set up Google OAuth. There is no password. Fine for a link you send
five friends; not fine if it spreads.

**Voice chat will not work.** Browsers refuse microphone access on a plain
`http://` origin. That is a browser rule, not something the app can opt out of.
Cards, chat and reactions all work.

**Games are lost on restart.** Rooms live in memory. Deploy between games, not
during one. Match history in SQLite survives.

The next section fixes the first two.

---

## Optional: HTTPS, Google sign-in, voice

Do these when you want them. Nothing above changes.

### HTTPS

```sh
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d uno.bunkcode.online
```

certbot edits your nginx config and sets up renewal. Then update
`CORS_ORIGINS` to the `https://` address and `pm2 restart no-mercy-uno`.

This alone makes voice possible — the microphone works on a secure origin.

### Google sign-in

Google Cloud Console → APIs & Services → Credentials → **OAuth 2.0 Client ID**
(Web application). Authorised JavaScript origins:

```
https://uno.bunkcode.online
```

Put the id in `apps/server/.env`:

```sh
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
NODE_ENV=production
```

`NODE_ENV=production` removes the name-only sign-in route entirely — the
handler is never registered, so it cannot be re-enabled by a stray variable.
Restart, then check `curl https://uno.bunkcode.online/api/auth/dev` returns
**404**.

### Voice across different networks

STUN alone connects many pairs. It cannot connect people behind symmetric or
carrier-grade NAT — which is most phones on mobile data. Those need a relay.

```sh
sudo apt install -y coturn
sudo cp deploy/coturn.conf /etc/turnserver.conf
sudo nano /etc/turnserver.conf
```

Replace two placeholders:

- `external-ip=$PUBLIC_IP/$PRIVATE_IP` → the real addresses. **Lightsail gives
  the box a private IP behind a mapped public one**, so coturn must be told the
  public address explicitly or every candidate it hands out is unroutable.
  `hostname -I` gives the private one; the console gives the public one.
- `static-auth-secret=$TURN_SECRET` → `openssl rand -hex 32`

```sh
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable --now coturn
```

Add the same secret to `apps/server/.env`:

```sh
TURN_URLS=turn:uno.bunkcode.online:3478
TURN_SECRET=<the same value>
```

**The secret must be identical in both places.** The app signs
`<expiry>:<userId>` with it and coturn recomputes the same HMAC. If they
differ, relayed connections are rejected and voice fails **only** for the
people who needed the relay — which is miserable to debug from the outside.

Open in the **Lightsail networking tab** (not just `ufw`): TCP+UDP 3478, and
**UDP 49160–49360**. The UDP range is the one people forget, and without it
TURN accepts the handshake and then relays nothing.

Check it with `pnpm preflight`, then confirm
`https://uno.bunkcode.online/api/voice/ice` shows `"hasTurn": true`. During a
call, `chrome://webrtc-internals` should show a candidate of type **`relay`**.

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

| Symptom | Fix |
|---|---|
| `Killed` during install | Out of memory. The script adds swap — re-run it. |
| Site loads, game never starts | The `Upgrade`/`Connection` lines are missing from nginx. |
| Everyone drops ~60s after going quiet | `proxy_read_timeout` is at nginx's default. |
| Blank page or 404 on everything | `pm2 logs no-mercy-uno` — usually a bad `.env`. |
| API calls fail from the browser | `CORS_ORIGINS` does not match the address you are opening. |
| Players in one room cannot see each other | PM2 running more than one instance. Rooms are in-process with no Redis adapter, so a second worker splits the table. Check `pm2 describe no-mercy-uno`. |
| Microphone never opens | Not on HTTPS. |
| Voice works for some people, not others | TURN. Check the secret matches and the UDP range is open in the **Lightsail** firewall. |
| `/api/auth/dev` returns a token in production | `NODE_ENV` is not `production`. That is passwordless sign-in as anyone. |

### `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`

pnpm refuses packages published in the last day — a guard against a freshly
compromised release. It fires when a lockfile is generated the same day one of
its transitive dependencies shipped.

The repo already guards against this: `pnpm-workspace.yaml` declares
`minimumReleaseAge: 1440`, and `package.json` pins `electron-to-chromium` (a
build-time data table pulled in by Vite that publishes several times a week, so
it is the most likely offender).

If it happens with a different package: pin that one the same way in
`pnpm.overrides`, regenerate the lockfile locally, commit, redeploy. Or wait a
day — the cutoff is a rolling window. As a last resort, on the server only,
`pnpm install --frozen-lockfile --config.minimumReleaseAge=0`.

Do **not** run `pnpm install` without `--frozen-lockfile` on the server. That
rewrites the lockfile on the box, so what you run stops matching what you
tested.

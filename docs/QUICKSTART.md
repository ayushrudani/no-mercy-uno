# Quickstart — get it running behind nginx

The short path. No Google OAuth, no TURN, no certificates. Good enough for a
private game among friends on a URL you don't hand out.

For the full production setup (Google sign-in, HTTPS, working voice) see
[DEPLOY.md](DEPLOY.md).

---

## 1. Run the setup script

```sh
cd /var/www/no-mercy-uno
git pull
bash deploy/setup.sh
```

It adds swap if missing, installs, builds the client, writes
`apps/server/.env` with a generated secret, creates the SQLite database, and
starts the server under PM2 on **127.0.0.1:3000**. Safe to re-run — it never
overwrites an existing `.env`.

It finishes by printing the nginx block to paste.

### Why there is still one build

The **server is not compiled** — PM2 runs the TypeScript directly through
`tsx`, so a `git pull` needs no rebuild at all.

The **client is built once**, and that part is not avoidable: a browser cannot
load `.tsx` files, so something has to turn them into JavaScript. The only way
to skip it is to run Vite's dev server permanently, which holds the whole
module graph in memory and makes every page load hundreds of requests instead
of two — more setup and slower, not less.

## 2. Point nginx at port 3000

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

In `apps/server/.env`:

```sh
CORS_ORIGINS=http://uno.bunkcode.online
```

Whatever you actually type into the browser. Then:

```sh
pm2 restart no-mercy-uno
```

Open the site, type a name, create a room, share the code.

---

## Updating later

```sh
cd /var/www/no-mercy-uno
git pull
pnpm --filter @nmu/web build     # only if the client changed
pm2 restart no-mercy-uno
```

Server-only changes need just the restart — there is nothing to compile.

---

## What this setup gives up

Three things, deliberately:

**Anyone who reaches the site can sign in as any name.** The script sets
`NODE_ENV=development`, which keeps the name-only sign-in enabled so you don't
have to set up Google OAuth. There is no password. Fine for a URL you share
with five friends; not fine if it gets indexed or passed around.

**Voice chat will not work.** Browsers refuse microphone access on a plain
`http://` origin — that is a browser rule, not something the app can opt out
of. Everything else (cards, chat, reactions) works fine.

**Games are lost on restart.** Rooms live in memory. Deploy between games, not
during one. Match history in SQLite survives.

To fix the first two, run certbot for a certificate and follow
[DEPLOY.md](DEPLOY.md) from step 3 — Google sign-in and voice both come back
once the site is on HTTPS.

---

## If something breaks

| Symptom | Fix |
|---|---|
| `Killed` during the build | Out of memory — the script adds swap, so re-run it |
| Site loads but the game never starts | The `Upgrade`/`Connection` lines are missing from nginx |
| Everyone drops ~60s after going quiet | `proxy_read_timeout` is at nginx's default |
| Blank page / 404 on everything | `pm2 logs no-mercy-uno` — usually a bad `.env` |
| API calls fail from the browser | `CORS_ORIGINS` doesn't match the address you're opening |
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | See the section at the end of [DEPLOY.md](DEPLOY.md) |

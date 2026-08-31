# Deploying

Ubuntu box with nginx and PM2 already on it. One script, one nginx block.

Currently deployed against the instance's static IP, **http://13.232.9.123** —
no domain, no certificate. See [Adding a domain](#optional-adding-a-domain) for
what that unlocks.

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

## 2. Install the nginx site

```sh
sudo cp deploy/nginx.conf /etc/nginx/sites-available/no-mercy-uno
sudo ln -sf /etc/nginx/sites-available/no-mercy-uno /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The shipped config already has `server_name 13.232.9.123`. If your IP differs,
change that one line.

**The websocket block is the part that matters.** Without the
`Upgrade`/`Connection` headers the game never starts; without the 24-hour
`proxy_read_timeout`, nginx's 60-second default silently disconnects everyone
a minute after the table goes quiet — which looks exactly like bad wifi.

## 3. Open it

**http://13.232.9.123**

Type a name, create a room, share the code and the link.

`CORS_ORIGINS` is set for you — the setup script asks the instance metadata
service for its own public IP and writes it into `.env`. If you ever move the
box or change the IP, re-run the script.

### Firewall

Open **port 80 (TCP)** in the Lightsail networking tab. That is the only port
the browser needs; the Node process stays on `127.0.0.1:3000` where only nginx
can reach it.

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

### One-off: upgrading from the Google sign-in build

Accounts changed shape. `User` lost `googleSub` and `email` and gained
`username`, `passwordHash` and `mustResetPassword`, and the new columns are
required with no sensible default for an existing row — so the old accounts
cannot be carried across. There were only ever a handful of them and they
signed in with Google, which no longer exists here, so the fix is to drop them
and sign up again:

```sh
cd /var/www/no-mercy-uno/apps/server
cp prisma/dev.db prisma/dev.db.bak          # keep the old match history
pnpm exec prisma db push --accept-data-loss
pm2 restart no-mercy-uno
```

`--accept-data-loss` is what makes Prisma go ahead with a change it cannot
migrate row by row. Without the flag it stops and explains, which is the
behaviour you want on every *other* deploy — do not put it in a script.

Match rows survive the push, but they point at user ids that no longer exist,
so the record panel will read empty until new games are played. On a fresh box
with no database yet, none of this applies: plain `prisma db push` is enough.

---

## What this setup gives up

**Voice chat will not work.** Browsers refuse microphone access on a plain
`http://` origin, and you cannot get a certificate for a bare IP — a public CA
will only issue for a domain. That is a browser and CA rule, not something the
app can opt out of. Cards, chat and reactions all work.

**Games are lost on restart.** Rooms live in memory. Deploy between games, not
during one. Match history in SQLite survives.

A domain fixes the first. See below.

Accounts are unaffected by any of this: signing up needs `SIGNUP_CODE`, so the
site is closed to whoever stumbles onto the IP even without HTTPS.

---

## Optional: adding a domain

Everything above keeps working. A domain buys you HTTPS, which buys you voice
chat — not possible on a bare IP.

### HTTPS

Point an A record at `13.232.9.123`, then:

```sh
sudo sed -i 's/server_name 13.232.9.123;/server_name your.domain;/' /etc/nginx/sites-available/no-mercy-uno
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain
```

certbot rewrites the config for TLS and sets up renewal. Then set
`CORS_ORIGINS=https://your.domain` in `apps/server/.env` and
`pm2 restart no-mercy-uno`.

This alone makes voice possible — the microphone works on a secure origin.

### Accounts

There is no OAuth and no email. Accounts are a username and a password, and
creating one requires the signup code — which is what keeps the server to the
people it was built for, since it sits on a public IP with no domain in front
of it.

The code lives in `apps/server/.env`:

```sh
SIGNUP_CODE=94997749
```

Change it and `pm2 restart no-mercy-uno` to cut off new signups. Existing
accounts keep working; the code is only checked when creating one.

**Every new account must change its password before it can play.** Signing up
returns a token that authorises exactly one thing — setting a new password —
and the socket refuses it, so a fresh account cannot join a room until that is
done. The password typed at signup is a one-time password by design, which
means you can hand someone a temporary one over chat without it becoming their
real one.

Passwords are hashed with scrypt (node's built-in — no native module to rebuild
on the box). Nothing is recoverable: there is no reset email, so a forgotten
password means deleting the row and signing up again.

```sh
cd ~/no-mercy-uno/apps/server
pnpm exec prisma studio   # or: sqlite3 prisma/dev.db
```

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
TURN_URLS=turn:your.domain:3478
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
`https://your.domain/api/voice/ice` shows `"hasTurn": true`. During a
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
| Anyone can create an account | `SIGNUP_CODE` is still the default. Change it in `apps/server/.env` and restart. |
| A new account cannot join a room | Working as intended — it must change its password first. The socket rejects a reset-scoped token. |
| Someone forgot their password | There is no reset email. Delete their row and have them sign up again. |
| Fullscreen button missing on a phone | iOS Safari has no fullscreen API for normal elements, so the button hides itself. Android Chrome has both fullscreen and the landscape lock. |

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

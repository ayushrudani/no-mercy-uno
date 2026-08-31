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
bash deploy/update.sh
```

Pulls, installs, backs up the database, syncs the schema, rebuilds the client
and restarts PM2.

**Use the script rather than doing it by hand.** The manual version --
`git pull`, build, `pm2 restart` -- is silently wrong whenever
`prisma/schema.prisma` has changed, and it fails in a way that does not look
like a database problem:

```
Invalid `db().user.create()` invocation
  Argument `googleSub` is missing.
```

The generated Prisma client is what validates a query, so a client left over
from the previous schema rejects the write before SQLite ever sees it, naming a
column that no longer exists in the schema you are reading. `git pull` updates
the schema file; nothing regenerates the client. `prisma db push` does, as its
final step, which is why it is in the script.

When `db push` refuses, it is one of two different situations and they need
different flags — the script prints which:

| Refusal | Flag | Cost |
|---|---|---|
| A column or table is being dropped | `--accept-data-loss` | That column |
| A new **required** column has no value for rows that already exist | none — empty that one table, then re-run | Just that table |

The second is not a permissions problem. There is no value Prisma could write
into the existing rows, so `--accept-data-loss` cannot help and will simply
fail again. Clearing the table that is blocking it is enough, and costs only
that table — `--force-reset` exists for this but drops **everything**.

The database is copied to `data/nmu.db.bak` before either path touches it.

**The server is never compiled.** PM2 runs the TypeScript straight from `src`
through `tsx`, so a code-only change needs nothing but the restart -- but a
*schema* change needs the database step above.

The client is built once because a browser cannot load `.tsx` files — something
has to turn them into JavaScript. The only way to skip that is to run Vite's
dev server permanently, which holds the whole module graph in memory and turns
every page load into hundreds of requests instead of two. More setup and
slower, not less.

### One-off: upgrading from the Google sign-in build

Accounts changed shape: `User` lost `googleSub` and `email` and gained
`username`, `passwordHash` and `mustResetPassword`.

The two new columns are **required with no default**, and Prisma cannot invent
values for the accounts already in the table, so a plain push stops:

```
Added the required column `passwordHash` to the `User` table without a default
value. There are 2 rows in this table, it is not possible to execute this step.
```

`--accept-data-loss` does not help — that flag permits *dropping* things, and
this is impossible rather than forbidden. Empty the table instead, which needs
no destructive flag and leaves every other table alone:

```sh
cd /var/www/no-mercy-uno/apps/server
echo 'DELETE FROM User;' | pnpm exec prisma db execute --stdin --schema prisma/schema.prisma
cd .. && bash deploy/update.sh
```

The old accounts go. They signed in with Google, which this build no longer
has, so not one of them could log in again anyway. `MatchPlayer` rows cascade
away with them; the `Match` rows survive, pointing at nobody, so the record
panel reads empty until new games are played.

`bash deploy/update.sh --force-reset` also works but is a bigger hammer — it
drops **every** table, not just `User`. Recent Prisma versions also refuse
`--force-reset` without an interactive confirmation, so expect a prompt.

Either way the database is copied to `data/nmu.db.bak` first. Sign up again
afterwards with the code from `SIGNUP_CODE`.

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

## Adding a domain and HTTPS

One script, safe to re-run:

```sh
cd /var/www/no-mercy-uno
bash deploy/https.sh uno.bunkcode.online
```

It checks the domain actually resolves to this box before touching anything,
installs nginx and certbot if missing, gets a Let's Encrypt certificate over
the webroot challenge, writes the nginx config, sets renewal up, points
`CORS_ORIGINS` at both addresses, flips `NODE_ENV` to production and restarts
PM2.

**Open 443 first**, or the certificate will issue and then nothing will connect:
Lightsail console → your instance → Networking → IPv4 Firewall → add HTTPS
(TCP 443). Port 80 must stay open too — that is how renewals are validated.

Afterwards:

| | |
|---|---|
| `https://uno.bunkcode.online` | full site. **Voice only works here.** |
| `http://uno.bunkcode.online` | redirects to HTTPS |
| `http://13.232.9.123` | still works, plain HTTP, no voice |

### Why the IP is not redirected to HTTPS

No public CA will issue a certificate for a bare IP address, so a redirect
there could only ever land on a certificate warning. Plain HTTP on the IP is
the honest fallback — everything works except the microphone, which browsers
refuse to open on an insecure origin.

Signing in works on both. The client sends the session token as a bearer header
as well as relying on the cookie, which matters because `NODE_ENV=production`
marks that cookie `Secure` and a browser will not send a Secure cookie back
over plain HTTP. Without the header, a reload on the IP would look like being
signed out.

### Renewal

certbot's timer handles it. The script installs a deploy hook at
`/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`, because certbot has no
reason to know nginx is holding the old certificate in memory — without it the
site keeps serving an expired one until something else reloads.

Check it any time:

```sh
sudo certbot renew --dry-run
```

### If certbot fails

In order of likelihood:

1. **Port 80 closed** in the Lightsail firewall. The challenge is fetched over
   plain HTTP.
2. **DNS not pointing here.** The script warns before it tries, but a record
   changed minutes ago may still be cached.
3. **Rate limited** after several failed attempts — five per hour per domain.
   Wait an hour.

The site stays up on the IP throughout. Fix and re-run.

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

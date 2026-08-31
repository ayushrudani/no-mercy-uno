# No Mercy UNO

Multiplayer **UNO Show 'Em No Mercy** for a friend group spread across cities.
Username/password accounts behind an invite code, password-protected rooms,
live voice chat, phone-first with a fullscreen landscape mode.

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — **get it running behind nginx in one script**
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — the full setup: accounts, HTTPS, working voice
- [`docs/PLAN.md`](docs/PLAN.md) — architecture, rules, and what is done

---

## Running locally

```sh
pnpm install
pnpm db:push        # creates the SQLite schema
pnpm dev            # server on :3000, client on :5173
```

Open **http://localhost:5173** — not `127.0.0.1`, because Vite binds IPv6
loopback only.

Create an account from the landing page. Signup asks for a **signup code**,
which defaults to `94997749` and is set by `SIGNUP_CODE` in
`apps/server/.env`. There is no OAuth and no email.

Every new account has to change its password before it can play: signup hands
back a token that authorises only the password change, and the socket refuses
it. The password you type at signup is a one-time password by design.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server and client with hot reload |
| `pnpm test` | Every test in the workspace |
| `pnpm typecheck` | Typecheck all four packages |
| `pnpm build` | Production build |
| `pnpm preflight` | Check the deploy config before shipping |
| `FUZZ_GAMES=200 pnpm test` | The full engine fuzz sweep (slow) |

## Layout

```
packages/
  engine/     the rules, as a pure function. no I/O, no clock, no Math.random
  shared/     types + zod schemas for every socket message
apps/
  server/     fastify + socket.io + prisma
  web/        react + vite
deploy/       nginx.conf, ecosystem.config.cjs, coturn.conf, preflight.mjs
```

## The two ideas the rest hangs off

**The engine is a pure reducer.** `(state, action) -> { state, events }` with a
seeded RNG in the state, so an entire game is reproducible from a seed plus its
action list. That is what makes the fuzz harness possible — it plays thousands
of complete games and re-checks every invariant after every single action. It
has caught real bugs that no hand-written test would have: a stale UNO call
surviving a 7-0 hand swap, for one.

**The server is authoritative and redacts per player.** You receive your hand;
everyone else is `{ id, name, cardCount }`. Cheating by opening devtools is not
possible because the data was never sent. Every legality decision is the
server's, and the client's card highlighting reads `playableCardIds` straight
out of the redacted snapshot, so the two can never disagree.

## Testing tools

```sh
cd apps/server

# a bot that joins a room and plays
pnpm exec tsx scripts/bot.ts <ROOM_CODE> <password> [name]

# host a table with custom rules -- a small hand is the quick way to reach
# situations that only happen near the end of a hand
BOT_CREATE=1 BOT_HAND_SIZE=3 BOT_START_AT=2 pnpm exec tsx scripts/bot.ts X pw Host

# end-to-end check against a running server
pnpm smoke
```

## Known unproven

Two things have never been exercised for real, and should not be assumed
working:

1. **Voice audio between two real peers.** The signalling, ICE credentials and
   negotiation logic are tested; the audio path is not.
2. **The deployment.** The nginx, PM2 and coturn configs are written and pass
   `pnpm preflight`, but have never run on the actual box.

# No Mercy UNO — Web App Plan

Multiplayer UNO No Mercy for a friend group spread across cities.
Username/password login behind a signup code, password-protected rooms, live voice chat, phone-first with an optional fullscreen landscape lock.

## Status

| Phase | State |
|---|---|
| 0. Monorepo scaffold | done |
| 1. Engine (official deck + rules, 7-0, UNO call) | done — 123 tests incl. a fuzz sweep |
| 2. Server (auth, rooms, sockets, redaction, turn clock) | done — 58 tests |
| 3. Web client (table, hand, play/draw) | done — 42 tests |
| 4. Polish (animations, sound, chat, card art) | done |
| 5. Voice (WebRTC mesh, TURN credentials) | code done; **audio never tested between two real peers** |
| 6. Profiles, history, reconnect grace, network alerts | done |
| 7. Lightsail deploy | configs written and preflighted; **never run on the real box** |

Two things are genuinely unproven and should not be assumed working: the voice
audio path, and the deployment itself. Everything else has been exercised
either by tests or by playing real games in a browser — including the
production server bundle serving the built client locally.

---

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + TypeScript project refs | Engine shared between server and client, one `pnpm dev` |
| Game engine | Pure TypeScript, zero deps, seeded RNG | Deterministic -> unit testable, replayable, no framework lock |
| Server | Node 22 + Fastify + Socket.IO | Fastify for REST/auth, Socket.IO for realtime + voice signaling + auto-reconnect |
| DB | **SQLite** + Prisma | Users, profiles, match history. Swapped from Postgres: one friend group's writes are tiny, so it removes a container from the box and makes backups "copy one file". Prisma keeps a Postgres move to a provider swap. |
| Cache/State | In-process Map (v1), Redis adapter (later) | A single Lightsail box needs no Redis until we scale past one process |
| Auth | Username + password (scrypt) behind a signup code -> our own JWT (httpOnly cookie), scoped so a new account can only change its password | No OAuth setup, no email, nothing to configure in a console |
| Frontend | React 19 + Vite + TypeScript | Fast HMR, small build |
| Styling | Tailwind CSS v4 | Fast iteration on a heavily custom UI |
| Animation | Framer Motion (`layoutId` for card flight) | Cards physically travel hand -> pile; this is 80% of the "feel" |
| Client state | Zustand + Immer | Simple, no boilerplate, fine for one room's state |
| Voice | WebRTC audio mesh, signaling over Socket.IO, coturn for TURN | Free, low latency, no SFU cost. Mesh is fine at <= 8 players |
| Audio FX | Howler.js | Sprite sheet, handles mobile audio unlock |
| Validation | Zod on every socket payload | Server trusts nothing from a client |
| Tests | Vitest (engine), Playwright (one 4-player e2e smoke) | Engine correctness is where the bugs live |
| Deploy | PM2 + nginx + certbot on AWS Lightsail | Matches the box that already exists. HTTPS is MANDATORY — mic access requires a secure origin |

### Repo layout

```
no-mercy-uno/
├─ packages/
│  ├─ engine/       # pure game rules, no I/O. The heart.
│  └─ shared/       # types + zod schemas for every socket event
├─ apps/
│  ├─ server/       # fastify + socket.io + prisma
│  └─ web/          # react client
├─ deploy/          # nginx.conf, ecosystem.config.cjs, coturn.conf, preflight
└─ docs/
```

---

## 2. Architecture

**Authoritative server.** The client is a renderer, not a rule-keeper.

```
Browser A ─┐
Browser B ─┼─ WSS ─> Socket.IO ─> RoomManager ─> Engine.reduce(state, action)
Browser C ─┘                            │
                                        └─> redactFor(playerId) ─> per-socket state

Browser A <──────── WebRTC audio ────────> Browser B   (peer-to-peer, never via server)
```

Two rules make everything else fall into place:

1. **Redaction.** Each player receives only their own hand. Everyone else is
   `{ id, name, avatar, cardCount, isEliminated }`. Cheating by opening devtools
   becomes impossible — the data is not on their machine.
2. **Engine is a pure reducer.** `(state, action) -> { state, events[] }`.
   No sockets, no `Date.now()`, no `Math.random` (seeded RNG lives in state).
   The entire game is testable without a network, and any desync can be replayed
   from the action log.

Voice audio is peer-to-peer and never touches the server — only the tiny
SDP/ICE handshake goes through Socket.IO.

---

## 3. Game engine — UNO No Mercy

### Deck — confirmed official composition (168 cards)

144 coloured (36 per colour) + 24 wild.

| Card | Per colour | Total |
|---|---|---|
| Numbers 0–9 (**two copies of each**, including two 0s) | 20 | 80 |
| Draw 2 | 3 | 12 |
| Draw 4 (coloured) | 2 | 8 |
| Skip | 3 | 12 |
| Skip Everyone | 2 | 8 |
| Reverse | 3 | 12 |
| Discard All | 3 | 12 |
| **Wild Reverse Draw 4** | — | 8 |
| **Wild Draw 6** | — | 4 |
| **Wild Draw 10** | — | 4 |
| **Wild Color Roulette** | — | 8 |

Note what is *absent*: there is **no plain Wild** and **no standalone Wild Draw 4**.
Reverse Draw 4 *is* the +4 wild, and it is a wild card, not a coloured one.

### Card model

```ts
type Color = 'red' | 'yellow' | 'green' | 'blue';

type Card =
  | { id: string; k: 'number';       color: Color; n: 0|1|2|3|4|5|6|7|8|9 }
  | { id: string; k: 'draw';         color: Color; amount: 2 | 4 }
  | { id: string; k: 'skip';         color: Color }
  | { id: string; k: 'skipEveryone'; color: Color }
  | { id: string; k: 'reverse';      color: Color }
  | { id: string; k: 'discardAll';   color: Color }
  | { id: string; k: 'wildReverseDraw4' }          // the +4 wild
  | { id: string; k: 'wildDraw'; amount: 6 | 10 }
  | { id: string; k: 'wildColorRoulette' };
```

Every card carries a stable `id`. The client plays *"card id X"*, never a
description — and Framer Motion uses the same id as its `layoutId`, so a card
animates continuously from hand to pile with no bookkeeping.

Deck composition lives in one table in `engine/src/deck.ts`.

### Rules implemented

- **Stacking, equal-or-higher only.** `pendingDraw` accumulates while
  `pendingTier` records the last value played. A stack card must be **>= the
  current tier**: on a +4 you may play +4/+6/+10 but *not* a +2. On a +10, only
  a +10 saves you. The first player who cannot or will not stack eats the pile.
  Stacking is matched on **value, not colour**.
- **Wild Color Roulette is outside the stacking system entirely** — it cannot be
  played onto a pending draw, and nothing can be stacked onto it. The target
  names a colour, reveals cards one at a time until that colour appears (keeping
  all of them), and forfeits their turn. The named colour becomes active.
- **Skip Everyone** — turn returns to the player who played it.
- **Discard All** — discard every card of that colour from your hand at once.
  Can win you the round outright.
- **Reverse Draw 4** — flips direction, then hits the new next player for 4.
  **Two-player special case:** the flip returns the turn to *you*, so **you** eat
  the 4 unless you can stack a +4/+6/+10 to bounce it back.
- **Elimination at 25 cards**, checked immediately whenever a hand grows. You
  stay in the room as a spectator (and stay on voice, to heckle).
- **Rounds.** A round ends when someone empties their hand; a fresh round is
  dealt to everyone still alive. The game ends when one player remains.

### House rules (room toggles, both on by default)

Neither is part of official UNO No Mercy, so both default **off** in the engine
and **on** in the default room settings. The lobby exposes a switch for each.

- **7-0.** Playing a 7 swaps your hand with a player you choose; playing a 0
  passes every hand one seat in the direction of play. Play your *last* card as
  a 7 and you do not go out — you take their hand and they get your empty one,
  so **they** go out. The swap resolves before the round-end check, which is
  what makes that work.
- **Call UNO.** A button appears once you are down to two cards. Play your
  second-to-last card without pressing it and you immediately draw 2.
  - The button is live **whoever's turn it is** — you press it before playing,
    which is usually while someone else is still moving.
  - The penalty is **automatic**, not catch-based. On a phone everyone is
    looking at their own hand, so "you have to catch them" means nobody is ever
    penalised.
  - Discard All can drop you from four cards to one in a single play, with no
    chance to have called at two. The rule still applies, which is what makes
    Discard All risky.
  - The turn clock calls on behalf of an absent player before auto-playing: the
    server should not fine someone for a button they were not there to press.

### Turn state machine

```
        ┌───────────────────────────────────────────────┐
        v                                               │
   AwaitingPlay ──play──> ResolveEffect ──> AdvanceTurn ─┘
        │  │                    ^
        │  └──draw──> AwaitingPlayDrawnCard ──play/pass──┘
        │
        └──timeout──> AutoAction (draw, then pass)
```

### Turn timeout system

- Server-owned deadline (`turnEndsAt: epochMs`) ships with every state update;
  the client renders a countdown ring from it, so there is no clock drift.
- Default 30s. On expiry the server auto-draws and passes — a player who walks
  away or loses signal never freezes the table.
- Configurable per room (15 / 30 / 60 / off).

---

## 4. Rooms, auth & profiles

**Flow:** sign in or sign up -> forced first password change -> lobby -> Create Room (name + password + settings)
or Join Room (6-char code + password) -> waiting room -> host starts.

- Room code: 6 uppercase chars with ambiguous glyphs removed (no O/0/I/1).
- Password: bcrypt-hashed, never leaves the server, rate-limited on join.
- Host controls: kick, transfer host, turn timer, max players (2–8), start game.
- Reconnect: the JWT identifies you; the server re-attaches your socket to your
  seat and replays current state. Refresh, tab close, or an incoming phone call
  mid-game costs you nothing.
- Profile settings: display name, change password, avatar (initials or picked emoji/colour),
  card-back skin, SFX volume, mic default on/off, preferred turn timer.
- Match history: who played, who won, final card counts, duration.

---

## 5. Voice chat

- **Mesh WebRTC**, audio only. Each client holds N-1 `RTCPeerConnection`s.
  At 6 players that is 5 up + 5 down streams — comfortable on mobile.
- Signalling (`voice:offer` / `voice:answer` / `voice:ice`) rides the existing
  Socket.IO connection. No extra infrastructure.
- **coturn on the same Lightsail box — non-negotiable.** You are on different
  ISPs in different cities; a meaningful share of NAT combinations will not
  connect without a TURN relay.
- Controls: mic mute toggle, speaker (output) mute toggle, per-player volume
  slider, live speaking indicator (Web Audio `AnalyserNode` ring around the
  avatar), optional push-to-talk.
- Constraints: `echoCancellation`, `noiseSuppression`, `autoGainControl` all on.
- Mic permission is requested *in the waiting room*, never mid-game.

---

## 6. Network quality & alerts

- Heartbeat ping every 3s; the client tracks a rolling RTT.
- Status pill: green < 150ms, amber 150–400ms, red > 400ms or packet loss.
- Toast on degradation: "Slow connection — you may lag." A full-screen
  "Reconnecting…" overlay on socket drop, with automatic retry and backoff.
- On reconnect the server sends a full state snapshot, never a diff.

---

## 7. UI / UX

- **Landscape enforced.** Portrait shows a rotate-your-phone screen; the table
  layout needs the width.
- Table view: opponents fanned around the top arc with avatar, card count,
  speaking ring and turn timer; discard pile + draw stack centre; your hand as
  a scrollable fanned row along the bottom.
- Playable cards lift and glow; unplayable ones dim. No guessing.
- Custom card design — bold, high contrast, readable at phone size, with
  distinct silhouettes for +2 / +4 / +6 / +10 so you can read the threat at a
  glance.
- Big moments get theatre: Draw 10 slams down, Skip Everyone sweeps the table,
  elimination gets a full-screen sting.
- Chat panel (collapsible drawer) plus a quick reaction bar of emoji that float
  over the table.
- Safe-area insets for notched phones. Haptics when your turn starts.

---

## 8. Build order

| Phase | Deliverable | Definition of done |
|---|---|---|
| 0 | Monorepo scaffold, TS config, lint | `pnpm dev` boots server + web |
| 1 | **Engine** — deck, reducer, all No Mercy rules | Vitest suite green, incl. a 10k-random-game fuzz run that never throws |
| 2 | Server — auth, rooms, socket protocol, redaction, timeouts | 4 CLI clients can play a full game |
| 3 | Web — table, hand, play/draw, turn indicator | Playable end to end; ugly but correct |
| 4 | Polish — animations, sounds, chat, reactions, card art | Feels like a game |
| 5 | Voice — mesh, coturn, mic/speaker controls | 4 people in different cities can hear each other |
| 6 | Profiles, history, reconnect hardening, network alerts | Survives a phone dying mid-game |
| 7 | Deploy to Lightsail — nginx + certbot, PM2, coturn | Live at your domain, mic works |

Engine before server before UI is deliberate: a rule bug found in phase 1 costs
minutes; the same bug found once it's tangled into animations costs days.

That ordering paid for itself twice. The fuzz harness caught a stale UNO call
surviving a 7-0 hand swap — a bug that would have silently excused a player's
next failure to call — and it caught it seconds after the rule was written,
before any of it reached the UI.

---

## 9. Lightsail deployment

```
Lightsail instance (Ubuntu, 2GB)
├─ nginx        :80 / :443              certbot TLS, reverse proxy, websocket upgrade
├─ node (pm2)   :3000  (127.0.0.1)      API + websockets + serves the built client
└─ coturn       :3478 / :5349 + UDP 49160-49360

The SQLite file lives at /var/www/no-mercy-uno/data/nmu.db -- outside the repo,
so a git pull never touches it.
```

**PM2 must run exactly one instance in fork mode.** Rooms are an in-process Map
and Socket.IO has no Redis adapter, so two workers would put players from the
same room on different processes: each would see a room containing only
themselves. `pnpm preflight` checks for this.

- Static IP + DNS A record. Open firewall ports 80/443/3478/5349 and the TURN
  UDP range in the Lightsail console.
- Sticky sessions are irrelevant at one instance; when we scale, add the Redis
  Socket.IO adapter.
- Secrets live in `.env` on the box, never committed.

---

## 10. Settled

- Deck: official 168, table above. Max players: **8**. Domain: **uno.bunkcode.online**.

## 11. Judgement calls made (flip any of these in `engine/src/config.ts`)

These were not specified, so the engine takes a defensible default and exposes a
flag rather than hard-coding an assumption:

| Question | Default taken | Flag |
|---|---|---|
| Must a stacked draw card match colour? | No — value only | `stackRequiresColorMatch: false` |
| Who names the colour on Color Roulette? | The **target**, and it becomes the active colour | `rouletteColorChosenBy: 'target'` |
| Opening flip is an action card | Re-flip until a plain number card | `openingMustBeNumber: true` |
| Can't play on your turn | Draw 1; play it immediately if legal | `drawOneThenPlay: true` |
| "UNO" call + penalty | Implemented; engine default off, rooms default on | `unoCall`, `unoPenalty: 2` |
| 7 swaps hands / 0 rotates them | Implemented; engine default off, rooms default on | `sevenZero` |
| Round winner scoring | None — rounds only exist to reset hands | `scoring: 'none'` |

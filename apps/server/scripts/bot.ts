/**
 * A bot player, for testing a table without needing a second human.
 *
 *   pnpm exec tsx scripts/bot.ts <ROOM_CODE> <password> [name]
 *
 * Signs in through the development auth route, joins the room, and plays a
 * legal move whenever it is its turn. Deliberately simple: it plays the first
 * legal card and keeps wilds for last, which is enough to exercise every code
 * path in the client without pretending to be a good opponent.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { Ack, Card, Color, GameSnapshot, RoomView } from '@nmu/shared';

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const [rawCode, rawPassword, name = 'Rohit'] = process.argv.slice(2);
if (!rawCode || !rawPassword) {
  console.error('usage: tsx scripts/bot.ts <ROOM_CODE> <password> [name]');
  process.exit(1);
}
const code = rawCode.toUpperCase();
const password = rawPassword;

const URL = process.env['BOT_URL'] ?? 'http://127.0.0.1:3000';
const COLORS: Color[] = ['red', 'yellow', 'green', 'blue'];

const needsColor = (c: Card) => c.k === 'wildReverseDraw4' || c.k === 'wildDraw';
const isWild = (c: Card) => needsColor(c) || c.k === 'wildColorRoulette';

/** Whichever colour the bot holds most of. */
function bestColor(hand: Card[]): Color {
  const counts: Record<Color, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) if (!isWild(c)) counts[(c as { color: Color }).color]++;
  return COLORS.reduce((a, b) => (counts[b] > counts[a] ? b : a), 'red' as Color);
}

async function main(): Promise<void> {
  const res = await fetch(`${URL}/api/auth/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`dev sign-in failed: ${res.status} ${await res.text()}`);
  const { token, user } = (await res.json()) as { token: string; user: { id: string } };

  const socket: Socket = io(URL, { auth: { token }, transports: ['websocket'] });

  const emit = <T>(event: string, payload?: unknown): Promise<T> =>
    new Promise((ok, no) => {
      const cb = (ack: Ack<T>) => (ack.ok ? ok(ack.data) : no(new Error(ack.error.message)));
      if (payload === undefined) socket.emit(event, cb);
      else socket.emit(event, payload, cb);
    });

  /**
   * Host mode, for setting up a specific scenario by hand.
   *
   *   BOT_CREATE=1 BOT_HAND_SIZE=3 BOT_START_AT=2 tsx scripts/bot.ts X PW Host
   *
   * A small hand size is the practical way to reach two cards quickly when you
   * want to look at something that only happens near the end of a hand.
   */
  const creating = process.env['BOT_CREATE'] === '1';
  const startAt = Number(process.env['BOT_START_AT'] ?? 0);
  let started = false;

  socket.on('connect', async () => {
    try {
      if (creating) {
        const rules: Record<string, unknown> = {};
        const handSize = process.env['BOT_HAND_SIZE'];
        if (handSize) rules['handSize'] = Number(handSize);
        if (process.env['BOT_SEVEN_ZERO']) rules['sevenZero'] = process.env['BOT_SEVEN_ZERO'] === '1';
        if (process.env['BOT_UNO_CALL']) rules['unoCall'] = process.env['BOT_UNO_CALL'] === '1';

        const res = await emit<{ code: string }>('room:create', {
          settings: {
            name: `${name}'s test table`,
            maxPlayers: 4,
            turnSeconds: 0,
            rules,
          },
          password,
        });
        console.log(`[${name}] created room ${res.code}`);
      } else {
        await emit('room:join', { code, password });
        console.log(`[${name}] joined ${code}`);
      }
    } catch (err) {
      console.error(`[${name}] could not ${creating ? 'create' : 'join'}:`, (err as Error).message);
      process.exit(1);
    }
  });

  socket.on('room:state', (room: RoomView) => {
    console.log(`[${name}] room ${room.status} · ${room.members.map((m) => m.displayName).join(', ')}`);
    if (creating && !started && startAt > 0 && room.status === 'waiting' && room.members.length >= startAt) {
      started = true;
      emit('room:start')
        .then(() => console.log(`[${name}] started the game`))
        .catch((err: Error) => console.error(`[${name}] could not start:`, err.message));
    }
  });

  let acting = false;
  let latest: GameSnapshot | null = null;

  /**
   * Drive from the newest snapshot rather than from the event that woke us.
   *
   * A draw produces a new state *while* the previous action is still in flight
   * (phase becomes awaitingDrawnCardDecision, still our turn). Acting on the
   * event directly meant that state arrived with `acting` still set, got
   * dropped, and -- since nothing else would change -- the bot sat there
   * forever. Re-checking after each action closes that gap.
   */
  socket.on('game:state', (snap: GameSnapshot) => {
    latest = snap;
    // Call UNO as soon as it is offered; the bot should not be handing out
    // free penalties to itself while we are testing something else.
    if (snap.view.you?.canCallUno) {
      emit('game:callUno').catch(() => undefined);
    }
    void act();
  });

  async function act(): Promise<void> {
    if (acting) return;
    const snap = latest;
    if (!snap) return;

    const { view } = snap;
    if (view.turnPlayerId !== user.id || !view.you) return;
    acting = true;

    // A small pause so the browser's animations and turn ring are watchable.
    await new Promise((r) => setTimeout(r, 900));

    try {
      if (view.phase.t === 'awaitingRouletteColor') {
        await emit('game:rouletteColor', { color: bestColor(view.you.hand) });
        console.log(`[${name}] named a colour for roulette`);
      } else if (view.phase.t === 'awaitingSwapTarget') {
        // Under the 7-0 rule a 7 halts play until its owner names a target.
        // Take the smallest hand on the table.
        const target = view.players
          .filter((p) => !p.eliminated && p.id !== user.id)
          .sort((a, b) => a.cardCount - b.cardCount)[0];
        if (target) {
          await emit('game:swapTarget', { targetId: target.id });
          console.log(`[${name}] swapped hands with ${target.id} (${target.cardCount} cards)`);
        }
      } else if (view.phase.t === 'awaitingDrawnCardDecision') {
        const playable = view.you.playableCardIds[0];
        if (playable) {
          const card = view.you.hand.find((c) => c.id === playable)!;
          await emit('game:play', needsColor(card)
            ? { cardId: card.id, color: bestColor(view.you.hand) }
            : { cardId: card.id });
        } else {
          await emit('game:pass');
        }
      } else {
        // Prefer a coloured card, so wilds are held back for when they matter.
        const ids = new Set(view.you.playableCardIds);
        const options = view.you.hand.filter((c) => ids.has(c.id));
        const choice = options.find((c) => !isWild(c)) ?? options[0];

        if (!choice) {
          await emit('game:draw');
          console.log(`[${name}] drew${view.pendingDraw > 0 ? ` ${view.pendingDraw} (ate the stack)` : ''}`);
        } else {
          await emit('game:play', needsColor(choice)
            ? { cardId: choice.id, color: bestColor(view.you.hand) }
            : { cardId: choice.id });
          console.log(`[${name}] played ${choice.k}`);
        }
      }
    } catch (err) {
      console.error(`[${name}] move rejected:`, (err as Error).message);
    } finally {
      acting = false;
    }

    // A state may have landed while we were mid-action; act on it now.
    if (latest !== snap) void act();
  }

  socket.on('game:over', (p: { winnerId: string }) => {
    console.log(`[${name}] game over, winner ${p.winnerId === user.id ? name : p.winnerId}`);
  });

  socket.on('connect_error', (err) => console.error(`[${name}] connect error:`, err.message));

  process.on('SIGINT', () => {
    socket.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

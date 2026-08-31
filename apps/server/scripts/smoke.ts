/**
 * End-to-end smoke test against a running server.
 *
 * Seeds two accounts, mints real session tokens, connects two socket clients,
 * and drives create -> join -> start -> play. Verifies the thing unit tests
 * cannot: that authentication, room routing and per-player redaction actually
 * line up over a real socket.
 *
 *   pnpm exec tsx scripts/smoke.ts
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { io, type Socket } from 'socket.io-client';
import type { Ack, GameSnapshot, RoomView } from '@nmu/shared';

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const { signSession } = await import('../src/auth/tokens.js');

const URL = process.env['SMOKE_URL'] ?? 'http://localhost:3000';
const prisma = new PrismaClient();

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!cond) failures++;
}

async function seedUser(sub: string, name: string): Promise<{ id: string; token: string }> {
  const user = await prisma.user.upsert({
    where: { googleSub: sub },
    update: { displayName: name },
    create: { googleSub: sub, email: `${sub}@smoke.test`, displayName: name },
  });
  return { id: user.id, token: await signSession(user.id) };
}

function connect(token: string): Promise<Socket> {
  return new Promise((res, rej) => {
    const socket = io(URL, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => res(socket));
    socket.on('connect_error', rej);
    setTimeout(() => rej(new Error('connect timed out')), 8000);
  });
}

function emit<T>(socket: Socket, event: string, payload?: unknown): Promise<Ack<T>> {
  return new Promise((res, rej) => {
    const args = payload === undefined ? [] : [payload];
    socket.emit(event, ...args, (ack: Ack<T>) => res(ack));
    setTimeout(() => rej(new Error(`${event} timed out`)), 8000);
  });
}

/** Wait for the next occurrence of an event. */
function next<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${event} never arrived`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(t);
      res(payload);
    });
  });
}

async function main(): Promise<void> {
  console.log(`\nsmoke test against ${URL}\n`);

  const alice = await seedUser('smoke-alice', 'Alice');
  const bob = await seedUser('smoke-bob', 'Bob');

  // --- auth ---------------------------------------------------------------
  let rejected = false;
  try {
    await connect('garbage.token.here');
  } catch {
    rejected = true;
  }
  check('a bogus session token is refused at the handshake', rejected);

  const aliceSock = await connect(alice.token);
  const bobSock = await connect(bob.token);
  check('both clients connect with a valid session', aliceSock.connected && bobSock.connected);

  // --- room ---------------------------------------------------------------
  const created = await emit<{ code: string }>(aliceSock, 'room:create', {
    settings: { name: 'Smoke', maxPlayers: 4, turnSeconds: 30, rules: {} },
    password: 'hunter2',
  });
  check('host creates a room', created.ok, created.ok ? created.data.code : JSON.stringify(created));
  if (!created.ok) throw new Error('cannot continue');
  const code = created.data.code;

  const wrongPw = await emit(bobSock, 'room:join', { code, password: 'nope' });
  check('a wrong password is rejected', !wrongPw.ok && wrongPw.error.code === 'bad_password');

  const roomStatePromise = next<RoomView>(aliceSock, 'room:state');
  const joined = await emit<{ code: string }>(bobSock, 'room:join', { code, password: 'hunter2' });
  check('the right password gets you in', joined.ok);
  const roomState = await roomStatePromise;
  check('the host is told about the new member', roomState.members.length === 2,
    roomState.members.map((m) => m.displayName).join(', '));

  const notHost = await emit(bobSock, 'room:start');
  check('a non-host cannot start the game', !notHost.ok && notHost.error.code === 'not_host');

  // --- game ---------------------------------------------------------------
  const aliceState = next<GameSnapshot>(aliceSock, 'game:state');
  const bobState = next<GameSnapshot>(bobSock, 'game:state');
  const started = await emit(aliceSock, 'room:start');
  check('the host starts the game', started.ok, started.ok ? '' : JSON.stringify(started));

  const [aSnap, bSnap] = await Promise.all([aliceState, bobState]);
  check('each player is dealt seven cards',
    aSnap.view.you?.hand.length === 7 && bSnap.view.you?.hand.length === 7);
  check('a turn deadline is published with the opening state',
    typeof aSnap.turnEndsAt === 'number' && aSnap.turnEndsAt > aSnap.serverNow,
    `endsAt=${aSnap.turnEndsAt} now=${aSnap.serverNow}`);

  // The property that matters most: neither payload contains the other's hand.
  const aliceIds = new Set(aSnap.view.you!.hand.map((c) => c.id));
  const bobIds = new Set(bSnap.view.you!.hand.map((c) => c.id));
  const overlap = [...aliceIds].filter((id) => bobIds.has(id));
  check('the two hands are disjoint', overlap.length === 0, `overlap=${overlap.length}`);
  check("no opponent hand is present in the payload",
    !JSON.stringify(bSnap.view.players).includes('"hand"'));
  check('opponents appear only as card counts',
    bSnap.view.players.every((p) => p.cardCount === 7));

  // --- playing ------------------------------------------------------------
  const actorId = aSnap.view.turnPlayerId;
  const actorSock = actorId === alice.id ? aliceSock : bobSock;
  const idleSock = actorId === alice.id ? bobSock : aliceSock;
  const idleId = actorId === alice.id ? bob.id : alice.id;

  const outOfTurn = await emit(idleSock, 'game:draw');
  check('a player cannot act out of turn', !outOfTurn.ok, JSON.stringify(outOfTurn));

  const bogus = await emit(actorSock, 'game:play', { cardId: 'does-not-exist' });
  check('an unknown card id is refused as illegal_move',
    !bogus.ok && bogus.error.code === 'illegal_move');

  const actorSnap = actorId === alice.id ? aSnap : bSnap;
  const playable = actorSnap.view.you!.playableCardIds;
  const eventsPromise = next<unknown[]>(idleSock, 'game:events');
  if (playable.length > 0) {
    const card = actorSnap.view.you!.hand.find((c) => c.id === playable[0])!;
    const needsColor = card.k === 'wildReverseDraw4' || card.k === 'wildDraw' || card.k === 'wildColorRoulette';
    const res = await emit(actorSock, 'game:play', {
      cardId: card.id,
      ...(needsColor ? { color: 'red' } : {}),
    });
    check('the actor plays a legal card', res.ok, res.ok ? card.k : JSON.stringify(res));
  } else {
    const res = await emit(actorSock, 'game:draw');
    check('the actor draws when nothing is legal', res.ok);
  }
  const events = await eventsPromise;
  check('the other player receives narration events', Array.isArray(events) && events.length > 0);

  // --- chat and voice -----------------------------------------------------
  const chatPromise = next<{ text: string }>(idleSock, 'chat:message');
  await emit(actorSock, 'chat:send', { text: 'draw ten, my friend' });
  check('chat reaches the room', (await chatPromise).text === 'draw ten, my friend');

  const badReaction = await emit(actorSock, 'chat:react', { reaction: '<script>' });
  check('an off-list reaction is rejected', !badReaction.ok);

  const voiceA = await emit<{ userIds: string[] }>(actorSock, 'voice:join');
  const voiceB = await emit<{ userIds: string[] }>(idleSock, 'voice:join');
  check('the first on voice sees no peers', voiceA.ok && voiceA.data.userIds.length === 0);
  check('the second is told to offer to the first',
    voiceB.ok && voiceB.data.userIds.length === 1);

  const offerPromise = next<{ from: string; data: string }>(actorSock, 'voice:offer');
  idleSock.emit('voice:offer', { to: actorId, data: 'v=0 fake-sdp' });
  const offer = await offerPromise;
  check('SDP is relayed to the named peer', offer.from === idleId && offer.data === 'v=0 fake-sdp');

  // --- reconnect ----------------------------------------------------------
  idleSock.disconnect();
  const back = await connect(actorId === alice.id ? bob.token : alice.token);
  const restored = await next<GameSnapshot>(back, 'game:state');
  check('a reconnecting player is put back at their seat with their hand',
    (restored.view.you?.hand.length ?? 0) > 0,
    `${restored.view.you?.hand.length} cards`);

  aliceSock.disconnect();
  actorSock.disconnect();
  back.disconnect();
  await prisma.$disconnect();

  console.log(failures === 0 ? '\nall smoke checks passed\n' : `\n${failures} check(s) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nsmoke test crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});

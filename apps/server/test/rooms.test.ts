/**
 * Room lifecycle tests.
 *
 * A fake clock and a recording transport mean the whole flow -- create, join,
 * start, play, time out, disconnect, finish -- runs synchronously with no
 * socket, no database and no waiting on real timers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentActorId, legalMovesFor, type GameState } from '@nmu/engine';
import { DEFAULT_ROOM_SETTINGS, type RoomSettings, type RoomView } from '@nmu/shared';
import { Room, RoomError, type Clock, type MatchResult, type RoomTransport } from '../src/rooms/Room.js';
import { RoomManager } from '../src/rooms/RoomManager.js';
import { hashPassword } from '../src/auth/password.js';

// --- fakes ----------------------------------------------------------------

class FakeClock implements Clock {
  private t = 1_700_000_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  /** Advance time, firing anything due. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
  get pending(): number {
    return this.timers.length;
  }
}

interface Sent {
  target: string;
  scope: 'room' | 'user';
  event: string;
  args: unknown[];
}

class RecordingTransport implements RoomTransport {
  sent: Sent[] = [];
  toRoom(code: string, event: string, ...args: unknown[]): void {
    this.sent.push({ target: code, scope: 'room', event, args });
  }
  toUser(userId: string, event: string, ...args: unknown[]): void {
    this.sent.push({ target: userId, scope: 'user', event, args });
  }
  last(event: string): Sent | undefined {
    return [...this.sent].reverse().find((s) => s.event === event);
  }
  clear(): void {
    this.sent = [];
  }
}

const profile = (id: string) => ({ userId: id, displayName: id.toUpperCase(), avatarUrl: null });

/**
 * Base settings for tests.
 *
 * Rules are pinned to the engine defaults rather than inherited from
 * DEFAULT_ROOM_SETTINGS: a product default is free to change, and when
 * `sevenZero` was switched on it silently altered every seeded game and broke a
 * test that had nothing to do with house rules. Tests that care about a rule
 * now say so.
 */
const settings = (over: Partial<RoomSettings> = {}): RoomSettings => ({
  ...DEFAULT_ROOM_SETTINGS,
  rules: {},
  ...over,
});

/**
 * A room with a fake clock and a fixed RNG seed. The seed matters: without it
 * every run deals a different game, and any assertion about how a game unfolds
 * would pass or fail at random.
 */
async function makeRoom(
  memberIds: string[] = ['alice', 'bob', 'carol'],
  over: Partial<RoomSettings> = {},
  onMatchFinished?: (r: MatchResult) => void,
  seed = 20260831,
) {
  const clock = new FakeClock();
  const transport = new RecordingTransport();
  const room = new Room({
    code: 'ABC234',
    host: profile(memberIds[0]!),
    settings: settings(over),
    passwordHash: await hashPassword('hunter2'),
    transport,
    clock,
    onMatchFinished,
    seed,
  });
  for (const id of memberIds.slice(1)) room.join(profile(id));
  transport.clear();
  return { room, clock, transport };
}

const roomView = (t: RecordingTransport): RoomView => t.last('room:state')!.args[0] as RoomView;

// --- tests ----------------------------------------------------------------

describe('membership', () => {
  it('seats the host first and marks them host', async () => {
    const { transport, room } = await makeRoom(['alice', 'bob']);
    room.broadcastRoom();
    const view = roomView(transport);
    expect(view.members.map((m) => m.id)).toEqual(['alice', 'bob']);
    expect(view.members[0]!.isHost).toBe(true);
    expect(view.hostId).toBe('alice');
  });

  it('refuses to seat more than the room allows', async () => {
    const { room } = await makeRoom(['alice', 'bob'], { maxPlayers: 2 });
    expect(() => room.join(profile('carol'))).toThrow(RoomError);
    expect(() => room.join(profile('carol'))).toThrow(/full/);
  });

  it('lets only the host change settings or start', async () => {
    const { room } = await makeRoom();
    expect(() => room.updateSettings('bob', settings({ turnSeconds: 15 }))).toThrow(/only the host/);
    expect(() => room.start('bob')).toThrow(/only the host/);
  });

  it('hands the host role on when the host leaves the lobby', async () => {
    const { room, transport } = await makeRoom();
    room.leave('alice');
    expect(roomView(transport).hostId).toBe('bob');
  });

  it('needs at least two players to start', async () => {
    const { room } = await makeRoom(['alice']);
    expect(() => room.start('alice')).toThrow(/at least 2/);
  });
});

describe('starting a game', () => {
  it('deals to every seated member and pushes a redacted state to each', async () => {
    const { room, transport } = await makeRoom();
    room.start('alice');

    const states = transport.sent.filter((s) => s.event === 'game:state');
    expect(states.map((s) => s.target).sort()).toEqual(['alice', 'bob', 'carol']);

    for (const s of states) {
      const snap = s.args[0] as { view: { you: { hand: unknown[] } | null; players: { cardCount: number }[] } };
      expect(snap.view.you?.hand).toHaveLength(7);
      expect(snap.view.players.map((p) => p.cardCount)).toEqual([7, 7, 7]);
      // The critical property: no opponent hand anywhere in the payload.
      expect(JSON.stringify(snap.view.players)).not.toContain('"hand"');
    }
  });

  it('locks settings once a game is running', async () => {
    const { room } = await makeRoom();
    room.start('alice');
    expect(() => room.updateSettings('alice', settings({ turnSeconds: 60 }))).toThrow(/locked/);
  });

  it('seats a latecomer as a spectator with no hand', async () => {
    const { room, transport } = await makeRoom();
    room.start('alice');
    transport.clear();

    room.join(profile('dave'));
    const snap = transport.sent.find((s) => s.event === 'game:state' && s.target === 'dave');
    expect((snap!.args[0] as { view: { you: unknown } }).view.you).toBeNull();
  });
});

describe('turn clock', () => {
  it('publishes an absolute deadline rather than a duration', async () => {
    const { room, transport, clock } = await makeRoom(['alice', 'bob'], { turnSeconds: 30 });
    room.start('alice');
    const snap = transport.last('game:state')!.args[0] as { turnEndsAt: number; serverNow: number };
    expect(snap.turnEndsAt).toBe(clock.now() + 30_000);
    expect(snap.serverNow).toBe(clock.now());
  });

  it('auto-plays for a player who runs out of time', async () => {
    const { room, transport, clock } = await makeRoom(['alice', 'bob'], { turnSeconds: 30 });
    room.start('alice');
    const before = transport.last('game:state')!.args[0] as { view: { turnPlayerId: string } };
    transport.clear();

    clock.advance(30_001);

    const after = transport.last('game:state')!.args[0] as { view: { turnPlayerId: string } };
    expect(after.view.turnPlayerId).not.toBe(before.view.turnPlayerId);
    expect(transport.sent.some((s) => s.event === 'game:events')).toBe(true);
  });

  it('keeps re-arming so play advances turn after turn', async () => {
    const { room, clock, transport } = await makeRoom(['alice', 'bob', 'carol'], { turnSeconds: 15 });
    room.start('alice');
    for (let i = 0; i < 60; i++) clock.advance(15_001);

    // Auto-players shed cards rather than hoarding them, so rounds keep ending
    // and nobody reaches 25 -- the game does not finish itself, but the clock
    // must never stall while somebody is still connected.
    expect(currentGame(room).round).toBeGreaterThan(1);
    expect(clock.pending).toBe(1);
    expect(transport.sent.filter((s) => s.event === 'game:events').length).toBeGreaterThan(30);
  });

  it('stops the clock once every player has gone, so an abandoned room goes idle', async () => {
    const { room, clock } = await makeRoom(['alice', 'bob'], { turnSeconds: 15 });
    room.start('alice');
    expect(clock.pending).toBe(1);

    room.markDisconnected('alice');
    room.markDisconnected('bob');
    clock.advance(15_001);

    // Nothing left to re-arm for. Without this the room would auto-play
    // forever, keep touching its activity timestamp, and never be reclaimed.
    expect(clock.pending).toBe(0);
    const idleBefore = room.idleMs;
    clock.advance(600_000);
    expect(room.idleMs).toBeGreaterThan(idleBefore);
    expect(room.isEmpty).toBe(true);
  });

  it('restarts the clock when a player comes back', async () => {
    const { room, clock } = await makeRoom(['alice', 'bob'], { turnSeconds: 15 });
    room.start('alice');
    room.markDisconnected('alice');
    room.markDisconnected('bob');
    clock.advance(15_001);
    expect(clock.pending).toBe(0);

    room.join(profile('alice'));
    expect(clock.pending).toBe(1);
  });

  it('arms no timer when the clock is switched off', async () => {
    const { room, clock } = await makeRoom(['alice', 'bob'], { turnSeconds: 0 });
    room.start('alice');
    expect(clock.pending).toBe(0);
  });

  it('does not act on a stale actor if the turn already moved', async () => {
    const { room, clock, transport } = await makeRoom(['alice', 'bob'], { turnSeconds: 30 });
    room.start('alice');

    // Alice acts with 10s left; the timer scheduled for her must not fire on
    // Bob's turn and play a card for the wrong person.
    clock.advance(20_000);
    const state = currentGame(room);
    const actor = currentActorId(state)!;
    room.applyAction(actor, { t: 'draw', playerId: actor });
    const afterMove = transport.last('game:state')!.args[0] as { view: { turnPlayerId: string } };

    clock.advance(10_002);
    const afterStale = transport.last('game:state')!.args[0] as { view: { turnPlayerId: string } };
    expect(afterStale.view.turnPlayerId).toBe(afterMove.view.turnPlayerId);
  });
});

describe('playing', () => {
  it('rejects a move from someone who is not the actor', async () => {
    const { room } = await makeRoom();
    room.start('alice');
    const state = currentGame(room);
    const actor = currentActorId(state)!;
    const other = ['alice', 'bob', 'carol'].find((id) => id !== actor)!;
    expect(() => room.applyAction(other, { t: 'draw', playerId: other })).toThrow(RoomError);
  });

  it('surfaces an illegal move as a structured error, not a crash', async () => {
    const { room } = await makeRoom();
    room.start('alice');
    const actor = currentActorId(currentGame(room))!;
    try {
      room.applyAction(actor, { t: 'play', playerId: actor, cardId: 'nope' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoomError);
      expect((err as RoomError).code).toBe('illegal_move');
    }
  });

  it('broadcasts narration events for the UI to animate', async () => {
    const { room, transport } = await makeRoom();
    room.start('alice');
    transport.clear();

    const state = currentGame(room);
    const actor = currentActorId(state)!;
    const legal = legalMovesFor(state, actor);
    if (legal.length > 0) {
      const card = legal[0]!;
      room.applyAction(actor, {
        t: 'play',
        playerId: actor,
        cardId: card.id,
        ...('color' in card ? {} : { color: 'red' as const }),
      });
    } else {
      room.applyAction(actor, { t: 'draw', playerId: actor });
    }
    expect(transport.last('game:events')).toBeDefined();
  });
});

describe('disconnect and reconnect', () => {
  it('keeps the seat and marks the player offline', async () => {
    const { room, transport } = await makeRoom();
    room.start('alice');
    room.markDisconnected('bob');

    const view = roomView(transport);
    const bob = view.members.find((m) => m.id === 'bob')!;
    expect(bob.connected).toBe(false);
    expect(bob.seat).toBe(1);
  });

  it('restores the hand on rejoin', async () => {
    const { room, transport } = await makeRoom();
    room.start('alice');
    room.markDisconnected('bob');
    transport.clear();

    room.join(profile('bob'));
    const snap = transport.sent.find((s) => s.event === 'game:state' && s.target === 'bob');
    const view = (snap!.args[0] as { view: { you: { hand: unknown[] } | null } }).view;
    expect(view.you?.hand).toHaveLength(7);
    expect(roomView(transport).members.find((m) => m.id === 'bob')!.connected).toBe(true);
  });

  it('holds a seat for a player who walks out mid-game', async () => {
    const { room, transport } = await makeRoom();
    room.start('alice');
    room.leave('bob');
    // The engine still has three players; removing a seat would corrupt it.
    expect(currentGame(room).players).toHaveLength(3);
    expect(roomView(transport).members.map((m) => m.id)).toEqual(['alice', 'carol']);
  });
});

describe('reconnect grace', () => {
  it('keeps a disconnected lobby member during the grace period', async () => {
    const { room, clock, transport } = await makeRoom(['alice', 'bob']);
    room.markDisconnected('bob');

    clock.advance(60_000);
    expect(room.evictStale(120_000)).toEqual([]);
    expect(roomView(transport).members.map((m) => m.id)).toEqual(['alice', 'bob']);
  });

  it('drops them once the grace period expires', async () => {
    const { room, clock, transport } = await makeRoom(['alice', 'bob']);
    room.markDisconnected('bob');

    clock.advance(121_000);
    expect(room.evictStale(120_000)).toEqual(['bob']);
    expect(roomView(transport).members.map((m) => m.id)).toEqual(['alice']);
  });

  it('never evicts a seated player mid-game', async () => {
    const { room, clock } = await makeRoom(['alice', 'bob', 'carol']);
    room.start('alice');
    room.markDisconnected('bob');
    clock.advance(10 * 60_000);

    // Removing a seat would leave the engine holding a player nobody can act
    // for. The turn clock already covers an absent player.
    expect(room.evictStale(120_000)).toEqual([]);
    expect(currentGame(room).players).toHaveLength(3);
  });

  it('hands the host role on when the host is the one evicted', async () => {
    const { room, clock, transport } = await makeRoom(['alice', 'bob']);
    room.markDisconnected('alice');
    clock.advance(121_000);

    expect(room.evictStale(120_000)).toEqual(['alice']);
    expect(roomView(transport).hostId).toBe('bob');
  });

  it('leaves connected members alone', async () => {
    const { room, clock } = await makeRoom(['alice', 'bob']);
    clock.advance(10 * 60_000);
    expect(room.evictStale(120_000)).toEqual([]);
  });

  it('does not evict someone who reconnected in time', async () => {
    const { room, clock } = await makeRoom(['alice', 'bob']);
    room.markDisconnected('bob');
    clock.advance(60_000);
    room.join(profile('bob'));
    clock.advance(200_000);
    expect(room.evictStale(120_000)).toEqual([]);
  });
});

describe('chat', () => {
  it('broadcasts a message with the sender name attached', async () => {
    const { room, transport } = await makeRoom();
    room.chat('bob', 'draw ten, my friend');
    const msg = transport.last('chat:message')!.args[0] as { userId: string; displayName: string; text: string };
    expect(msg).toMatchObject({ userId: 'bob', displayName: 'BOB', text: 'draw ten, my friend' });
  });

  it('rate limits a spammer but lets the bucket refill', async () => {
    const { room, clock } = await makeRoom();
    for (let i = 0; i < 5; i++) room.chat('bob', `msg ${i}`);
    expect(() => room.chat('bob', 'one too many')).toThrow(/slow down/);
    clock.advance(4_000);
    expect(() => room.chat('bob', 'ok now')).not.toThrow();
  });

  it('refuses chat from a non-member', async () => {
    const { room } = await makeRoom();
    expect(() => room.chat('mallory', 'hello')).toThrow(/not in this room/);
  });
});

describe('voice signalling', () => {
  it('tells a newcomer which peers to offer to', async () => {
    const { room } = await makeRoom();
    expect(room.joinVoice('alice')).toEqual([]);
    expect(room.joinVoice('bob')).toEqual(['alice']);
    expect(room.joinVoice('carol').sort()).toEqual(['alice', 'bob']);
  });

  it('relays only between two members of the same room', async () => {
    const { room } = await makeRoom();
    expect(room.canSignal('alice', 'bob')).toBe(true);
    expect(room.canSignal('alice', 'mallory')).toBe(false);
    expect(room.canSignal('alice', 'alice')).toBe(false);
  });

  it('broadcasts mic state changes', async () => {
    const { room, transport } = await makeRoom();
    room.setMic('bob', true);
    expect(transport.last('voice:state')!.args[0]).toEqual({ userId: 'bob', micOn: true });
  });

  it('drops a disconnected player off voice', async () => {
    const { room, transport } = await makeRoom();
    room.joinVoice('bob');
    room.setMic('bob', true);
    room.markDisconnected('bob');
    expect(transport.last('voice:left')!.args[0]).toEqual({ userId: 'bob' });
    expect(roomView(transport).members.find((m) => m.id === 'bob')!.micOn).toBe(false);
  });
});

describe('finishing', () => {
  it('rejects an out-of-turn move without leaking a user id', async () => {
    const { room } = await makeRoom();
    room.start('alice');
    const actor = currentActorId(currentGame(room))!;
    const other = ['alice', 'bob', 'carol'].find((id) => id !== actor)!;
    try {
      room.applyAction(other, { t: 'draw', playerId: other });
      expect.unreachable('should have thrown');
    } catch (err) {
      // This message is shown verbatim in a toast, so it must read as English
      // and must not contain an internal identifier.
      expect((err as RoomError).message).toBe('it is not your turn');
      expect((err as RoomError).message).not.toContain(other);
    }
  });

  it('does not count an auto-played turn as room activity', async () => {
    const { room, clock } = await makeRoom(['alice', 'bob'], { turnSeconds: 15 });
    room.start('alice');
    const idleAtStart = room.idleMs;
    clock.advance(15_001);
    expect(room.idleMs).toBeGreaterThan(idleAtStart);
  });

  it('reports standings winner-first and hands a match record to the callback', async () => {
    const finished = vi.fn();
    const { room, clock } = await makeRoom(['alice', 'bob', 'carol'], { turnSeconds: 15 }, finished);
    room.start('alice');
    for (let i = 0; i < 600; i++) clock.advance(15_001);

    expect(finished).toHaveBeenCalledOnce();
    const result = finished.mock.calls[0]![0] as MatchResult;
    expect(result.roomCode).toBe('ABC234');
    expect(result.players).toHaveLength(3);
    expect(result.winnerId).not.toBeNull();
    expect(result.players.find((p) => p.userId === result.winnerId)!.finalPlace).toBe(1);
    expect(result.rounds).toBeGreaterThan(0);
  });

  it('returns to the lobby for a rematch', async () => {
    const finished = vi.fn();
    const { room, clock, transport } = await makeRoom(['alice', 'bob'], { turnSeconds: 15 }, finished);
    room.start('alice');
    for (let i = 0; i < 600; i++) clock.advance(15_001);
    expect(roomView(transport).status).toBe('finished');

    room.resetToLobby('alice');
    expect(roomView(transport).status).toBe('waiting');
    expect(clock.pending).toBe(0);
    room.start('alice');
    expect(roomView(transport).status).toBe('playing');
  });
});

describe('room settings reach the engine', () => {
  it('ships 7-0 on by default, because that is how this group plays', () => {
    expect(DEFAULT_ROOM_SETTINGS.rules.sevenZero).toBe(true);
  });

  it('passes the 7-0 flag through to the game config', async () => {
    const { room } = await makeRoom(['alice', 'bob'], { rules: { sevenZero: true } });
    room.start('alice');
    expect(currentGame(room).config.sevenZero).toBe(true);
  });

  it('leaves it off when the room turns it off', async () => {
    const { room } = await makeRoom(['alice', 'bob'], { rules: { sevenZero: false } });
    room.start('alice');
    expect(currentGame(room).config.sevenZero).toBe(false);
  });

  it('forwards the other rule overrides too', async () => {
    const { room } = await makeRoom(['alice', 'bob'], {
      rules: { eliminationAt: 15, stackRequiresColorMatch: true },
    });
    room.start('alice');
    const config = currentGame(room).config;
    expect(config.eliminationAt).toBe(15);
    expect(config.stackRequiresColorMatch).toBe(true);
  });
});

describe('RoomManager', () => {
  let transport: RecordingTransport;
  let clock: FakeClock;
  let manager: RoomManager;

  beforeEach(() => {
    transport = new RecordingTransport();
    clock = new FakeClock();
    manager = new RoomManager({ transport, clock, roomTtlMs: 60_000, graceMs: 120_000, seed: 20260831 });
  });

  it('issues codes from the unambiguous alphabet', async () => {
    const room = await manager.create(profile('alice'), settings(), 'pw');
    expect(room.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(room.code).not.toMatch(/[O0I1]/);
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const room = await manager.create(profile('alice'), settings(), 'hunter2');
    await expect(manager.join(room.code, 'nope', profile('bob'))).rejects.toThrow(/wrong room password/);
    await expect(manager.join(room.code, 'hunter2', profile('bob'))).resolves.toBeDefined();
  });

  it('lets an existing member back in without the password', async () => {
    const room = await manager.create(profile('alice'), settings(), 'hunter2');
    await manager.join(room.code, 'hunter2', profile('bob'));
    room.markDisconnected('bob');
    // Reconnecting from a phone that lost signal must not demand the password.
    await expect(manager.join(room.code, 'wrong', profile('bob'))).resolves.toBeDefined();
  });

  it('accepts a lowercase code', async () => {
    const room = await manager.create(profile('alice'), settings(), 'pw');
    expect(manager.get(room.code.toLowerCase())?.code).toBe(room.code);
  });

  it('reports 404 for an unknown code', async () => {
    await expect(manager.join('ZZZZZZ', 'pw', profile('bob'))).rejects.toThrow(/no room with that code/);
  });

  it('finds the room a user is sitting in', async () => {
    const room = await manager.create(profile('alice'), settings(), 'pw');
    expect(manager.findByUser('alice')?.code).toBe(room.code);
    expect(manager.findByUser('nobody')).toBeUndefined();
  });

  it('reports evicted players from the sweep', async () => {
    const room = await manager.create(profile('alice'), settings(), 'pw');
    await manager.join(room.code, 'pw', profile('bob'));
    room.markDisconnected('bob');

    clock.advance(30_000);
    expect(manager.sweep().playersEvicted).toBe(0);

    clock.advance(200_000);
    expect(manager.sweep().playersEvicted).toBe(1);
  });

  it('reclaims a room once everyone is gone and it has gone stale', async () => {
    const room = await manager.create(profile('alice'), settings(), 'pw');
    expect(manager.sweep().roomsRemoved).toBe(0);

    room.markDisconnected('alice');
    clock.advance(30_000);
    expect(manager.sweep().roomsRemoved).toBe(0); // still inside the TTL

    clock.advance(61_000);
    expect(manager.sweep().roomsRemoved).toBe(1);
    expect(manager.size).toBe(0);
  });
});

/** Reach into the room for its engine state. Tests only. */
function currentGame(room: Room): GameState {
  return (room as unknown as { game: GameState }).game;
}

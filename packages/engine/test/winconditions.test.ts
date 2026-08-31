/**
 * How a game ends.
 *
 * One deal, played to the finish. Emptying your hand ends YOUR game and nobody
 * else's: you take the next place, keep your seat, and the rest play on for
 * second, third and so on. The last player still holding cards comes last.
 *
 * There is no re-deal. An earlier design ended the round and dealt everyone a
 * fresh seven, which made going out look like the game had restarted.
 */

import { describe, expect, it } from 'vitest';
import { activeSeats, currentActorId, reduce } from '../src/engine.js';
import type { GameState } from '../src/types.js';
import { fillerPile, handOf, makeState, num } from './helpers.js';

const play = (s: GameState, p: number, cardId: string) =>
  reduce(s, { t: 'play', playerId: 'p' + p, cardId });

const places = (s: GameState) => s.players.map((p) => p.place);

describe('going out', () => {
  it('takes first place and does NOT re-deal anyone', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2), num('blue', 3)], [num('green', 4), num('green', 5)]],
      top: num('red', 5),
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);

    expect(state.players[0]!.place).toBe(1);
    expect(events).toContainEqual({ t: 'playerFinished', playerId: 'p0', place: 1 });

    // The others keep the hands they had. Nobody gets fresh cards.
    expect(handOf(state, 1)).toHaveLength(2);
    expect(handOf(state, 2)).toHaveLength(2);
    expect(state.round).toBe(1);
    expect(state.phase.t).not.toBe('gameOver');
  });

  it('takes the finished player out of the turn order', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2), num('blue', 3)], [num('green', 4), num('green', 5)]],
      top: num('red', 5),
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);

    expect(activeSeats(state)).toEqual([1, 2]);
    expect(currentActorId(state)).not.toBe('p0');
  });

  it('hands out places in the order people go out', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('red', 2)], [num('red', 3), num('red', 4)]],
      top: num('red', 5),
    });
    let st = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(places(st)).toEqual([1, null, null]);

    // p1 is next in order and goes out too, taking second.
    st = play(st, 1, handOf(st, 1)[0]!.id).state;
    expect(places(st)).toEqual([1, 2, 3]);
  });

  it('ends the game when one player is left, and they come last', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('red', 2), num('red', 3)]],
      top: num('red', 5),
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);

    expect(state.phase.t).toBe('gameOver');
    expect(state.winnerId).toBe('p0');
    expect(places(state)).toEqual([1, 2]);
    expect(events).toContainEqual({ t: 'playerFinished', playerId: 'p1', place: 2 });
    expect(events).toContainEqual({ t: 'gameEnded', winnerId: 'p0' });
  });

  it('makes the first player out the winner, not the last one standing', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('red', 2)], [num('red', 3)]],
      top: num('red', 5),
    });
    let st = play(s, 0, handOf(s, 0)[0]!.id).state;
    st = play(st, 1, handOf(st, 1)[0]!.id).state;

    expect(st.phase.t).toBe('gameOver');
    // p2 was left holding a card, so p0 -- first out -- wins.
    expect(st.winnerId).toBe('p0');
    expect(st.players[2]!.place).toBe(3);
  });

  it('keeps a finished player in the game state as a spectator', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2), num('blue', 3)], [num('green', 4), num('green', 5)]],
      top: num('red', 5),
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);

    // Still seated, not eliminated -- they simply have no cards and no turns.
    expect(state.players).toHaveLength(3);
    expect(state.players[0]!.eliminated).toBe(false);
    expect(handOf(state, 0)).toHaveLength(0);
  });
});

describe('knock-out at 25, when a room turns it on', () => {
  const KNOCKOUT = { eliminationAt: 25 };

  it('removes the player and leaves them unplaced', () => {
    const s = makeState({
      hands: [[num('red', 1)], Array.from({ length: 20 }, () => num('blue', 9)), [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 6,
      pendingTier: 6,
      drawPile: fillerPile(40),
      config: KNOCKOUT,
    });
    const { state, events } = reduce(s, { t: 'draw', playerId: 'p1' });

    expect(state.players[1]!.eliminated).toBe(true);
    // No place: they never went out, so they rank below everyone who did.
    expect(state.players[1]!.place).toBeNull();
    expect(events.some((e) => e.t === 'eliminated')).toBe(true);
  });

  it('ends the game when knock-out leaves one player', () => {
    const s = makeState({
      hands: [[num('red', 1)], Array.from({ length: 24 }, () => num('blue', 9))],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 2,
      pendingTier: 2,
      drawPile: fillerPile(10),
      config: KNOCKOUT,
    });
    const { state } = reduce(s, { t: 'draw', playerId: 'p1' });
    expect(state.phase.t).toBe('gameOver');
    expect(state.players[0]!.place).toBe(1);
    expect(state.winnerId).toBe('p0');
  });
});

describe('with knock-out off (the default)', () => {
  it('never removes anyone, however many cards they hold', () => {
    const huge = Array.from({ length: 40 }, () => num('blue', 9));
    const s = makeState({
      hands: [[num('red', 1)], huge, [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 10,
      pendingTier: 10,
      drawPile: fillerPile(40),
    });
    const { state, events } = reduce(s, { t: 'draw', playerId: 'p1' });
    expect(state.players[1]!.eliminated).toBe(false);
    expect(handOf(state, 1).length).toBeGreaterThan(45);
    expect(events.some((e) => e.t === 'eliminated')).toBe(false);
  });
});

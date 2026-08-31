/**
 * How a game ends.
 *
 * Two mutually sensible modes:
 *
 *  - **Knock-out** (`eliminationAt: 25`) — the official No Mercy rule. Reach 25
 *    cards and you are out; last player standing wins.
 *  - **First to N rounds** (`roundsToWin: 3`) — nobody is ever removed, so
 *    nobody spends the evening spectating.
 *
 * Turning knock-out off without setting `roundsToWin` leaves a game with no end
 * condition at all, which is the trap these tests exist to catch.
 */

import { describe, expect, it } from 'vitest';
import { reduce } from '../src/engine.js';
import type { GameState } from '../src/types.js';
import { fillerPile, handOf, makeState, num } from './helpers.js';

const play = (s: GameState, p: number, cardId: string) =>
  reduce(s, { t: 'play', playerId: 'p' + p, cardId });

describe('knock-out mode (official)', () => {
  const KNOCKOUT = { eliminationAt: 25, roundsToWin: 0 };

  it('removes a player who reaches the limit', () => {
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
    expect(events.some((e) => e.t === 'eliminated')).toBe(true);
  });

  it('ends when one player is left', () => {
    const s = makeState({
      hands: [[num('red', 1)], Array.from({ length: 24 }, () => num('blue', 9))],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 2,
      pendingTier: 2,
      drawPile: fillerPile(10),
      config: KNOCKOUT,
    });
    const { state, events } = reduce(s, { t: 'draw', playerId: 'p1' });
    expect(state.phase.t).toBe('gameOver');
    expect(state.winnerId).toBe('p0');
    expect(events).toContainEqual({ t: 'gameEnded', winnerId: 'p0' });
  });

  it('keeps dealing rounds until someone is knocked out', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2)], [num('green', 3)]],
      top: num('red', 5),
      config: KNOCKOUT,
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(events).toContainEqual({ t: 'roundEnded', winnerId: 'p0' });
    expect(state.phase.t).not.toBe('gameOver');
    expect(state.round).toBe(2);
  });
});

describe('knock-out off', () => {
  const NO_KNOCKOUT = { eliminationAt: 0, roundsToWin: 3 };

  it('never removes anyone, however many cards they hold', () => {
    const huge = Array.from({ length: 40 }, () => num('blue', 9));
    const s = makeState({
      hands: [[num('red', 1)], huge, [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 10,
      pendingTier: 10,
      drawPile: fillerPile(40),
      config: NO_KNOCKOUT,
    });
    const { state, events } = reduce(s, { t: 'draw', playerId: 'p1' });
    expect(state.players[1]!.eliminated).toBe(false);
    expect(handOf(state, 1).length).toBeGreaterThan(45);
    expect(events.some((e) => e.t === 'eliminated')).toBe(false);
  });

  it('ends the game when someone reaches the round target', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2)], [num('green', 3)]],
      top: num('red', 5),
      config: NO_KNOCKOUT,
    });
    // Two wins already; this one takes them to three.
    s.players[0]!.roundsWon = 2;

    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.phase.t).toBe('gameOver');
    expect(state.winnerId).toBe('p0');
    // The round win is still reported before the game win.
    expect(events).toContainEqual({ t: 'roundEnded', winnerId: 'p0' });
    expect(events).toContainEqual({ t: 'gameEnded', winnerId: 'p0' });
  });

  it('deals another round when the target is not reached yet', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2)], [num('green', 3)]],
      top: num('red', 5),
      config: NO_KNOCKOUT,
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.phase.t).not.toBe('gameOver');
    expect(state.players[0]!.roundsWon).toBe(1);
    expect(state.round).toBe(2);
  });

  it('counts each player rounds separately', () => {
    // p1 needs a card that is actually playable on the top card, or the move is
    // refused and the test proves nothing.
    const s = makeState({
      hands: [[num('red', 1)], [num('red', 2)], [num('green', 3)]],
      top: num('red', 5),
      turnIndex: 1,
      config: NO_KNOCKOUT,
    });
    s.players[0]!.roundsWon = 2;
    s.players[1]!.roundsWon = 2;

    // p1 going out must be credited to p1, however close p0 was.
    const { state } = play(s, 1, handOf(s, 1)[0]!.id);
    expect(state.winnerId).toBe('p1');
    expect(state.players[0]!.roundsWon).toBe(2);
    expect(state.players[1]!.roundsWon).toBe(3);
  });
});

describe('both switched off', () => {
  it('never ends, which is why the room settings must not allow it', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2)], [num('green', 3)]],
      top: num('red', 5),
      config: { eliminationAt: 0, roundsToWin: 0 },
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    // A round ended and a new one was dealt, but the game did not finish.
    expect(state.phase.t).not.toBe('gameOver');
    expect(state.round).toBe(2);
  });
});

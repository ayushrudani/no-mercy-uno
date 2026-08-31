/**
 * The 7-0 house rule.
 *
 * 7 = swap hands with a player of your choice. 0 = every hand moves one seat in
 * the direction of play. Neither is part of official UNO No Mercy, so both sit
 * behind `sevenZero` and must be completely inert when it is off.
 */

import { describe, expect, it } from 'vitest';
import { currentActorId, reduce, swapCandidates } from '../src/engine.js';
import { IllegalMoveError, type Color, type GameState } from '../src/types.js';
import { handOf, makeState, num, skip } from './helpers.js';

const ON = { sevenZero: true };

const play = (s: GameState, p: number, cardId: string, color?: Color) =>
  reduce(s, { t: 'play', playerId: 'p' + p, cardId, ...(color ? { color } : {}) });

const sizes = (s: GameState) => s.players.map((p) => p.hand.length);

describe('with the rule off', () => {
  it('treats a 7 as an ordinary number card', () => {
    const s = makeState({
      hands: [[num('red', 7), num('red', 1)], [num('blue', 2), num('blue', 3)], [num('green', 4)]],
      top: num('red', 5),
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.phase.t).toBe('awaitingPlay');
    expect(state.turnIndex).toBe(1);
    expect(sizes(state)).toEqual([1, 2, 1]);
  });

  it('treats a 0 as an ordinary number card', () => {
    const s = makeState({
      hands: [[num('red', 0), num('red', 1)], [num('blue', 2), num('blue', 3)], [num('green', 4)]],
      top: num('red', 5),
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(sizes(state)).toEqual([1, 2, 1]);
  });
});

describe('playing a 7', () => {
  it('asks the player who to swap with', () => {
    const s = makeState({
      hands: [[num('red', 7), num('red', 1)], [num('blue', 2), num('blue', 3)], [num('green', 4)]],
      top: num('red', 5),
      config: ON,
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.phase).toEqual({ t: 'awaitingSwapTarget', playerId: 'p0' });
    expect(currentActorId(state)).toBe('p0');
    expect(swapCandidates(state, 'p0').sort()).toEqual(['p1', 'p2']);
  });

  it('swaps the chosen hand and passes the turn on', () => {
    const s = makeState({
      hands: [[num('red', 7), num('red', 1)], [num('blue', 2), num('blue', 3)], [num('green', 4)]],
      top: num('red', 5),
      config: ON,
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    const { state, events } = reduce(mid, { t: 'chooseSwapTarget', playerId: 'p0', targetId: 'p2' });

    // p0 had one card left after playing the 7; p2 had one. The swap trades them.
    expect(handOf(state, 0)).toHaveLength(1);
    expect(handOf(state, 0)[0]).toMatchObject({ color: 'green', n: 4 });
    expect(handOf(state, 2)[0]).toMatchObject({ color: 'red', n: 1 });
    expect(events.some((e) => e.t === 'handsSwapped')).toBe(true);
    expect(state.phase.t).toBe('awaitingPlay');
    expect(state.turnIndex).toBe(1);
  });

  it('reports what each side gained and lost', () => {
    const s = makeState({
      hands: [
        [num('red', 7), num('red', 1)],
        [num('blue', 2), num('blue', 3), num('blue', 4), num('blue', 5)],
        [num('green', 4)],
      ],
      top: num('red', 5),
      config: ON,
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    const { events } = reduce(mid, { t: 'chooseSwapTarget', playerId: 'p0', targetId: 'p1' });
    expect(events).toContainEqual({
      t: 'handsSwapped',
      playerId: 'p0',
      targetId: 'p1',
      gained: 4,
      lost: 1,
    });
  });

  it('skips the picker when only one opponent is left', () => {
    const s = makeState({
      hands: [[num('red', 7), num('red', 1)], [num('blue', 2), num('blue', 3)]],
      top: num('red', 5),
      config: ON,
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    // A picker with a single option is just a click for its own sake.
    expect(state.phase.t).toBe('awaitingPlay');
    expect(sizes(state)).toEqual([2, 1]);
  });

  it('refuses a swap with yourself or with someone who is out', () => {
    const s = makeState({
      hands: [[num('red', 7), num('red', 1)], [num('blue', 2)], [], [num('green', 9)]],
      top: num('red', 5),
      eliminated: [2],
      config: ON,
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(() => reduce(mid, { t: 'chooseSwapTarget', playerId: 'p0', targetId: 'p0' })).toThrow(
      IllegalMoveError,
    );
    expect(() => reduce(mid, { t: 'chooseSwapTarget', playerId: 'p0', targetId: 'p2' })).toThrow(
      /that player is out/,
    );
    expect(swapCandidates(mid, 'p0')).not.toContain('p2');
  });

  it('lets nobody else answer the swap', () => {
    const s = makeState({
      hands: [[num('red', 7), num('red', 1)], [num('blue', 2)], [num('green', 9)]],
      top: num('red', 5),
      config: ON,
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(() => reduce(mid, { t: 'chooseSwapTarget', playerId: 'p1', targetId: 'p0' })).toThrow(
      /only the player who played the 7/,
    );
  });

  it('blocks ordinary play until the swap is resolved', () => {
    const s = makeState({
      hands: [[num('red', 7), num('red', 1)], [num('red', 2)], [num('green', 9)]],
      top: num('red', 5),
      config: ON,
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(() => play(mid, 0, handOf(mid, 0)[0]!.id)).toThrow(IllegalMoveError);
  });

  /**
   * The famous outcome: play your last card as a 7, take a full hand, and hand
   * your empty one over. They go out, not you.
   */
  it('can hand the round to the person you swapped with', () => {
    const s = makeState({
      hands: [[num('red', 7)], [num('blue', 2), num('blue', 3)], [num('green', 9)]],
      top: num('red', 5),
      config: ON,
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(mid.phase.t).toBe('awaitingSwapTarget');
    // Not out yet -- the swap has to resolve first.
    expect(mid.winnerId).toBeNull();

    const { events } = reduce(mid, { t: 'chooseSwapTarget', playerId: 'p0', targetId: 'p1' });
    expect(events).toContainEqual({ t: 'roundEnded', winnerId: 'p1' });
  });

  it('auto-picks the smallest hand on timeout', () => {
    const s = makeState({
      hands: [
        [num('red', 7), num('red', 1)],
        [num('blue', 2), num('blue', 3), num('blue', 4)],
        [num('green', 9)],
      ],
      top: num('red', 5),
      config: ON,
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    const { state } = reduce(mid, { t: 'timeout', playerId: 'p0' });
    // p2 held the single card, so that is the hand worth taking.
    expect(handOf(state, 0)).toHaveLength(1);
    expect(handOf(state, 2)).toHaveLength(1);
  });
});

describe('playing a 0', () => {
  it('passes every hand one seat in the direction of play', () => {
    const s = makeState({
      hands: [
        [num('red', 0), num('red', 1)],
        [num('blue', 2), num('blue', 3), num('blue', 4)],
        [num('green', 9)],
      ],
      top: num('red', 5),
      config: ON,
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);

    // Clockwise: p0's hand moves to p1, p1's to p2, p2's to p0.
    expect(handOf(state, 0)[0]).toMatchObject({ color: 'green', n: 9 });
    expect(handOf(state, 1)[0]).toMatchObject({ color: 'red', n: 1 });
    expect(handOf(state, 2)[0]).toMatchObject({ color: 'blue', n: 2 });
    expect(events).toContainEqual({ t: 'handsRotated', direction: 1 });
  });

  it('rotates the other way when play is reversed', () => {
    const s = makeState({
      hands: [[num('red', 0), num('red', 1)], [num('blue', 2)], [num('green', 9)]],
      top: num('red', 5),
      direction: -1,
      config: ON,
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(handOf(state, 0)[0]).toMatchObject({ color: 'blue', n: 2 });
    expect(handOf(state, 2)[0]).toMatchObject({ color: 'red', n: 1 });
  });

  it('skips eliminated players', () => {
    const s = makeState({
      hands: [[num('red', 0), num('red', 1)], [], [num('green', 9)]],
      top: num('red', 5),
      eliminated: [1],
      config: ON,
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(handOf(state, 1)).toHaveLength(0);
    expect(handOf(state, 0)[0]).toMatchObject({ color: 'green', n: 9 });
    expect(handOf(state, 2)[0]).toMatchObject({ color: 'red', n: 1 });
  });

  it('conserves every card', () => {
    const s = makeState({
      hands: [
        [num('red', 0), num('red', 1)],
        [num('blue', 2), num('blue', 3), num('blue', 4)],
        [num('green', 9), skip('green')],
      ],
      top: num('red', 5),
      config: ON,
    });
    const playedId = handOf(s, 0)[0]!.id;
    const before = s.players
      .flatMap((p) => p.hand.map((c) => c.id))
      .filter((id) => id !== playedId)
      .sort();

    const { state } = play(s, 0, playedId);
    const after = state.players.flatMap((p) => p.hand.map((c) => c.id)).sort();
    expect(after).toEqual(before);
  });
});

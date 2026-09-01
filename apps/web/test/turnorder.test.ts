/**
 * Reading the running order off the table view.
 */

import { describe, expect, it } from 'vitest';
import { nextPlayerId, turnOrderFrom, type TurnOrderView } from '../src/lib/turnorder.js';

const table = (
  seats: string[],
  turnPlayerId: string | null,
  direction: 1 | -1 = 1,
  out: Record<string, 'finished' | 'eliminated'> = {},
): TurnOrderView => ({
  seats,
  turnPlayerId,
  direction,
  players: seats.map((id) => ({
    id,
    eliminated: out[id] === 'eliminated',
    place: out[id] === 'finished' ? 1 : null,
  })),
});

const FOUR = ['a', 'b', 'c', 'd'];

describe('nextPlayerId', () => {
  it('is the seat clockwise when play runs clockwise', () => {
    expect(nextPlayerId(table(FOUR, 'a'))).toBe('b');
    expect(nextPlayerId(table(FOUR, 'd'))).toBe('a');
  });

  it('is the seat the other way once play is reversed', () => {
    expect(nextPlayerId(table(FOUR, 'a', -1))).toBe('d');
    expect(nextPlayerId(table(FOUR, 'c', -1))).toBe('b');
  });

  it('skips a player who has already gone out', () => {
    expect(nextPlayerId(table(FOUR, 'a', 1, { b: 'finished' }))).toBe('c');
  });

  it('skips a player who was knocked out', () => {
    expect(nextPlayerId(table(FOUR, 'a', 1, { b: 'eliminated' }))).toBe('c');
  });

  it('skips several in a row', () => {
    expect(nextPlayerId(table(FOUR, 'a', 1, { b: 'finished', c: 'eliminated' }))).toBe('d');
  });

  it('wraps the whole way round', () => {
    expect(nextPlayerId(table(FOUR, 'b', -1, { a: 'finished', d: 'finished' }))).toBe('c');
  });

  /** Nothing sensible to point at when one player is left. */
  it('is null when nobody else is still in', () => {
    expect(nextPlayerId(table(FOUR, 'a', 1, { b: 'finished', c: 'finished', d: 'finished' }))).toBeNull();
  });

  it('is null between turns and for an unknown seat', () => {
    expect(nextPlayerId(table(FOUR, null))).toBeNull();
    expect(nextPlayerId(table(FOUR, 'zz'))).toBeNull();
    expect(nextPlayerId(table([], 'a'))).toBeNull();
  });

  it('handles a two-player table', () => {
    expect(nextPlayerId(table(['a', 'b'], 'a'))).toBe('b');
    expect(nextPlayerId(table(['a', 'b'], 'a', -1))).toBe('b');
  });
});

describe('turnOrderFrom', () => {
  it('starts with whoever is on turn', () => {
    expect(turnOrderFrom(table(FOUR, 'c'))).toEqual(['c', 'd', 'a', 'b']);
  });

  it('runs backwards when reversed', () => {
    expect(turnOrderFrom(table(FOUR, 'c', -1))).toEqual(['c', 'b', 'a', 'd']);
  });

  it('leaves out anyone no longer playing', () => {
    expect(turnOrderFrom(table(FOUR, 'a', 1, { c: 'finished' }))).toEqual(['a', 'b', 'd']);
  });

  /**
   * Only meaningful while the player on turn is still in the game -- the
   * server never leaves the turn on someone who has gone out, so the case
   * where the order does not begin with them cannot arise in practice.
   */
  it('agrees with nextPlayerId', () => {
    for (const dir of [1, -1] as const) {
      for (const turn of FOUR.filter((id) => id !== 'b')) {
        const view = table(FOUR, turn, dir, { b: 'finished' });
        const order = turnOrderFrom(view);
        expect(order[0], `${turn} dir ${dir}`).toBe(turn);
        expect(order[1] ?? null, `${turn} dir ${dir}`).toBe(nextPlayerId(view));
      }
    }
  });

  it('is empty between turns', () => {
    expect(turnOrderFrom(table(FOUR, null))).toEqual([]);
  });
});

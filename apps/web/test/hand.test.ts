/**
 * Hand ordering and the no-scroll layout.
 */

import { describe, expect, it } from 'vitest';
import type { Card } from '@nmu/shared';
import { chunkRows, isHandSort, layoutHand, sortHand } from '../src/lib/hand.js';

let seq = 0;
const id = () => `c${seq++}`;

const N = (color: 'red' | 'yellow' | 'green' | 'blue', n: number): Card =>
  ({ id: id(), k: 'number', color, n }) as Card;
const SKIP = (color: 'red' | 'yellow' | 'green' | 'blue'): Card =>
  ({ id: id(), k: 'skip', color }) as Card;
const SKIP_ALL = (color: 'red' | 'yellow' | 'green' | 'blue'): Card =>
  ({ id: id(), k: 'skipEveryone', color }) as Card;
const REV = (color: 'red' | 'yellow' | 'green' | 'blue'): Card =>
  ({ id: id(), k: 'reverse', color }) as Card;
const DRAW = (color: 'red' | 'yellow' | 'green' | 'blue', amount: number): Card =>
  ({ id: id(), k: 'draw', color, amount }) as Card;
const DISCARD_ALL = (color: 'red' | 'yellow' | 'green' | 'blue'): Card =>
  ({ id: id(), k: 'discardAll', color }) as Card;
const ROULETTE = (): Card => ({ id: id(), k: 'wildColorRoulette' }) as Card;
const WILD_DRAW = (amount: number): Card => ({ id: id(), k: 'wildDraw', amount }) as Card;
const REV4 = (): Card => ({ id: id(), k: 'wildReverseDraw4' }) as Card;

/** Compact, readable shape of an ordered hand. */
const shape = (cards: Card[]) =>
  cards.map((c) => {
    if (c.k === 'number') return `${c.color[0]}${c.n}`;
    if (c.k === 'draw') return `${c.color[0]}+${c.amount}`;
    if (c.k === 'wildDraw') return `W+${c.amount}`;
    if (c.k === 'wildReverseDraw4') return 'W-rev4';
    if (c.k === 'wildColorRoulette') return 'W-roul';
    return `${(c as { color: string }).color[0]}-${c.k}`;
  });

describe('sortHand', () => {
  it('leaves the dealt order completely alone', () => {
    const hand = [N('blue', 9), ROULETTE(), N('red', 1)];
    expect(sortHand(hand, 'dealt')).toEqual(hand);
  });

  it('does not mutate the hand it is given', () => {
    const hand = [N('blue', 9), N('red', 1)];
    const before = hand.map((c) => c.id);
    sortHand(hand, 'color');
    expect(hand.map((c) => c.id)).toEqual(before);
  });

  it('groups by colour in rainbow order', () => {
    const hand = [N('blue', 1), N('green', 1), N('red', 1), N('yellow', 1)];
    expect(shape(sortHand(hand, 'color'))).toEqual(['r1', 'y1', 'g1', 'b1']);
  });

  it('puts numbers before actions inside a colour', () => {
    const hand = [SKIP('red'), N('red', 7), DRAW('red', 2), N('red', 0), REV('red')];
    expect(shape(sortHand(hand, 'color'))).toEqual(['r0', 'r7', 'r-skip', 'r-reverse', 'r+2']);
  });

  it('orders numbers by value, not by string', () => {
    const hand = [N('red', 9), N('red', 10 - 9), N('red', 0)];
    expect(shape(sortHand(hand, 'color'))).toEqual(['r0', 'r1', 'r9']);
  });

  it('orders draws by how much they hurt', () => {
    const hand = [DRAW('red', 10), DRAW('red', 2), DRAW('red', 4)];
    expect(shape(sortHand(hand, 'color'))).toEqual(['r+2', 'r+4', 'r+10']);
  });

  it('puts discard-all last within its colour', () => {
    const hand = [DISCARD_ALL('red'), N('red', 5), DRAW('red', 10), SKIP_ALL('red')];
    expect(shape(sortHand(hand, 'color'))).toEqual(['r5', 'r-skipEveryone', 'r+10', 'r-discardAll']);
  });

  /** Wilds play on anything, so they belong at the end where you look last. */
  it('puts every wild after every coloured card', () => {
    const hand = [REV4(), N('blue', 3), ROULETTE(), N('red', 1), WILD_DRAW(6)];
    expect(shape(sortHand(hand, 'color'))).toEqual(['r1', 'b3', 'W-roul', 'W+6', 'W-rev4']);
  });

  it('orders the wilds among themselves', () => {
    const hand = [REV4(), WILD_DRAW(10), ROULETTE(), WILD_DRAW(6)];
    expect(shape(sortHand(hand, 'color'))).toEqual(['W-roul', 'W+6', 'W+10', 'W-rev4']);
  });

  it('keeps identical cards in a stable order', () => {
    const a = N('red', 5);
    const b = N('red', 5);
    const c = N('red', 5);
    const once = sortHand([c, a, b], 'color').map((x) => x.id);
    const twice = sortHand([b, c, a], 'color').map((x) => x.id);
    expect(once).toEqual(twice);
  });

  it('never loses or duplicates a card', () => {
    const hand = [
      N('green', 4), REV4(), DRAW('yellow', 4), N('red', 0), ROULETTE(),
      SKIP('blue'), N('green', 4), DISCARD_ALL('red'), WILD_DRAW(6), REV('yellow'),
    ];
    const sorted = sortHand(hand, 'color');
    expect(sorted).toHaveLength(hand.length);
    expect(sorted.map((c) => c.id).sort()).toEqual(hand.map((c) => c.id).sort());
  });

  it('handles an empty hand', () => {
    expect(sortHand([], 'color')).toEqual([]);
    expect(sortHand([], 'dealt')).toEqual([]);
  });

  it('recognises only the sorts it supports', () => {
    expect(isHandSort('color')).toBe(true);
    expect(isHandSort('dealt')).toBe(true);
    expect(isHandSort('rank')).toBe(false);
    expect(isHandSort('')).toBe(false);
  });
});

describe('layoutHand', () => {
  const opts = { width: 800, cardWidth: 60, gap: 6, minStep: 14, maxRows: 2 };

  it('gives an empty hand no rows', () => {
    expect(layoutHand({ ...opts, count: 0 })).toEqual({ rows: [], step: 66 });
  });

  it('does not overlap when there is room to spare', () => {
    const { rows, step } = layoutHand({ ...opts, count: 5 });
    expect(rows).toEqual([5]);
    expect(step).toBe(66); // cardWidth + gap
  });

  it('assumes everything fits before the container is measured', () => {
    const { rows, step } = layoutHand({ ...opts, count: 30, width: 0 });
    expect(rows).toEqual([30]);
    expect(step).toBe(66);
  });

  it('overlaps just enough to fit one row', () => {
    const { rows, step } = layoutHand({ ...opts, count: 20 });
    expect(rows).toEqual([20]);
    // 19 gaps across 800-60 = 740px.
    expect(step).toBeCloseTo(740 / 19, 5);
    expect(step).toBeLessThan(66);
  });

  /** The whole point: the last card's right edge lands inside the container. */
  it('always fits the row within the width', () => {
    for (const count of [2, 7, 13, 25, 40, 60]) {
      const { rows, step } = layoutHand({ ...opts, count });
      for (const n of rows) {
        if (n <= 1) continue;
        const used = (n - 1) * step + opts.cardWidth;
        expect(used, `count=${count} row=${n}`).toBeLessThanOrEqual(opts.width + 0.001);
      }
    }
  });

  it('prefers one row while the cards stay readable', () => {
    // 40 cards over 740px is 18.9px each -- still above minStep.
    expect(layoutHand({ ...opts, count: 40 }).rows).toEqual([40]);
  });

  it('adds a second row only once a single row would be unreadable', () => {
    const { rows, step } = layoutHand({ ...opts, count: 60 });
    expect(rows).toEqual([30, 30]);
    expect(step).toBeGreaterThanOrEqual(opts.minStep);
  });

  it('balances the rows it does use', () => {
    const { rows } = layoutHand({ ...opts, count: 61 });
    expect(rows).toEqual([31, 30]);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(61);
  });

  it('keeps every card even when it runs out of room entirely', () => {
    const { rows, step } = layoutHand({ ...opts, count: 200, width: 300 });
    expect(rows.reduce((a, b) => a + b, 0)).toBe(200);
    expect(rows).toHaveLength(2);
    // Below minStep, but positive -- overlapping hard beats a scrollbar.
    expect(step).toBeGreaterThan(0);
  });

  it('handles a single card', () => {
    expect(layoutHand({ ...opts, count: 1 })).toEqual({ rows: [1], step: 66 });
  });

  it('handles a container narrower than one card', () => {
    const { rows, step } = layoutHand({ ...opts, count: 4, width: 40 });
    expect(rows.reduce((a, b) => a + b, 0)).toBe(4);
    expect(step).toBeGreaterThan(0);
  });

  /** A phone in landscape: the case this was built for. */
  it('fits a 25-card hand on a phone without a second row', () => {
    const { rows, step } = layoutHand({
      count: 25,
      width: 820,
      cardWidth: 42,
      gap: 4,
      minStep: 12,
      maxRows: 2,
    });
    expect(rows).toEqual([25]);
    expect(step).toBeGreaterThan(12);
  });
});

describe('chunkRows', () => {
  it('splits into the given row sizes', () => {
    expect(chunkRows([1, 2, 3, 4, 5], [3, 2])).toEqual([[1, 2, 3], [4, 5]]);
  });

  it('handles a single row', () => {
    expect(chunkRows([1, 2, 3], [3])).toEqual([[1, 2, 3]]);
  });

  it('handles no rows', () => {
    expect(chunkRows([], [])).toEqual([]);
  });

  it('round-trips with layoutHand for any count', () => {
    for (const count of [1, 5, 25, 61]) {
      const items = Array.from({ length: count }, (_, i) => i);
      const { rows } = layoutHand({
        count, width: 800, cardWidth: 60, gap: 6, minStep: 14, maxRows: 2,
      });
      expect(chunkRows(items, rows).flat()).toEqual(items);
    }
  });
});

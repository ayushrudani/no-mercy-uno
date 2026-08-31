import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/config.js';
import { canPlay, drawValue, isWild, sameFace, type TableView } from '../src/rules.js';
import { discardAll, draw, num, rev, roulette, skip, skipAll, wildDraw, wildRevD4 } from './helpers.js';

const view = (over: Partial<TableView> = {}): TableView => ({
  top: num('red', 5),
  activeColor: 'red',
  pendingDraw: 0,
  pendingTier: 0,
  config: makeConfig(),
  ...over,
});

describe('drawValue', () => {
  it('scores the four stackable values', () => {
    expect(drawValue(draw('red', 2))).toBe(2);
    expect(drawValue(draw('red', 4))).toBe(4);
    expect(drawValue(wildDraw(6))).toBe(6);
    expect(drawValue(wildDraw(10))).toBe(10);
  });

  it('counts Wild Reverse Draw 4 as the +4 wild', () => {
    expect(drawValue(wildRevD4())).toBe(4);
  });

  it('gives Color Roulette no value, so it can never join a stack', () => {
    expect(drawValue(roulette())).toBeNull();
  });

  it('gives non-draw cards no value', () => {
    expect(drawValue(num('red', 5))).toBeNull();
    expect(drawValue(skipAll('red'))).toBeNull();
    expect(drawValue(discardAll('red'))).toBeNull();
  });
});

describe('isWild', () => {
  it('classifies all four wild kinds', () => {
    expect(isWild(wildRevD4())).toBe(true);
    expect(isWild(wildDraw(10))).toBe(true);
    expect(isWild(roulette())).toBe(true);
    expect(isWild(num('red', 1))).toBe(false);
    expect(isWild(draw('red', 4))).toBe(false);
  });
});

describe('sameFace', () => {
  it('matches numbers by digit and draws by amount', () => {
    expect(sameFace(num('red', 7), num('blue', 7))).toBe(true);
    expect(sameFace(num('red', 7), num('blue', 8))).toBe(false);
    expect(sameFace(draw('red', 2), draw('blue', 2))).toBe(true);
    expect(sameFace(draw('red', 2), draw('blue', 4))).toBe(false);
  });

  it('does not equate a coloured Draw 4 with a Wild Reverse Draw 4', () => {
    expect(sameFace(draw('red', 4), wildRevD4())).toBe(false);
  });
});

describe('canPlay with no stack pending', () => {
  it('accepts a colour match', () => {
    expect(canPlay(num('red', 9), view())).toBe(true);
  });

  it('accepts a face match across colours', () => {
    expect(canPlay(num('blue', 5), view())).toBe(true);
    expect(canPlay(skip('blue'), view({ top: skip('red') }))).toBe(true);
    expect(canPlay(rev('green'), view({ top: rev('red') }))).toBe(true);
  });

  it('rejects a card matching neither colour nor face', () => {
    expect(canPlay(num('blue', 9), view())).toBe(false);
    expect(canPlay(skip('blue'), view())).toBe(false);
  });

  it('accepts any wild', () => {
    expect(canPlay(wildRevD4(), view())).toBe(true);
    expect(canPlay(wildDraw(10), view())).toBe(true);
    expect(canPlay(roulette(), view())).toBe(true);
  });

  it('follows the active colour rather than the top card when a wild set it', () => {
    const v = view({ top: wildRevD4(), activeColor: 'green' });
    expect(canPlay(num('green', 2), v)).toBe(true);
    expect(canPlay(num('red', 2), v)).toBe(false);
  });
});

describe('canPlay with a stack pending -- equal or higher only', () => {
  it('lets +2 be answered by anything from +2 up', () => {
    const v = view({ pendingDraw: 2, pendingTier: 2 });
    expect(canPlay(draw('blue', 2), v)).toBe(true);
    expect(canPlay(draw('blue', 4), v)).toBe(true);
    expect(canPlay(wildDraw(6), v)).toBe(true);
    expect(canPlay(wildDraw(10), v)).toBe(true);
    expect(canPlay(wildRevD4(), v)).toBe(true);
  });

  it('refuses a +2 played onto a +4', () => {
    const v = view({ pendingDraw: 4, pendingTier: 4 });
    expect(canPlay(draw('red', 2), v)).toBe(false);
    expect(canPlay(draw('red', 4), v)).toBe(true);
    expect(canPlay(wildRevD4(), v)).toBe(true);
  });

  it('leaves only a +10 as an answer to a +10', () => {
    const v = view({ pendingDraw: 10, pendingTier: 10 });
    expect(canPlay(draw('red', 4), v)).toBe(false);
    expect(canPlay(wildDraw(6), v)).toBe(false);
    expect(canPlay(wildRevD4(), v)).toBe(false);
    expect(canPlay(wildDraw(10), v)).toBe(true);
  });

  it('refuses every non-draw card, including Color Roulette', () => {
    const v = view({ pendingDraw: 2, pendingTier: 2 });
    expect(canPlay(roulette(), v)).toBe(false);
    expect(canPlay(num('red', 5), v)).toBe(false);
    expect(canPlay(skipAll('red'), v)).toBe(false);
    expect(canPlay(discardAll('red'), v)).toBe(false);
  });

  it('ignores colour when stacking by default', () => {
    const v = view({ pendingDraw: 2, pendingTier: 2, activeColor: 'red' });
    expect(canPlay(draw('green', 2), v)).toBe(true);
  });

  it('honours the colour-match flag when a room turns it on', () => {
    const v = view({
      pendingDraw: 2,
      pendingTier: 2,
      activeColor: 'red',
      config: makeConfig({ stackRequiresColorMatch: true }),
    });
    expect(canPlay(draw('green', 2), v)).toBe(false);
    expect(canPlay(draw('red', 2), v)).toBe(true);
    // A wild has no colour to clash, so it stays legal.
    expect(canPlay(wildDraw(6), v)).toBe(true);
  });
});

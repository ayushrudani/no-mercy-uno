import { describe, expect, it } from 'vitest';
import { buildDeck, CARDS_PER_COLOR, DECK_SIZE } from '../src/deck.js';
import { COLORS, type Card, type Color } from '../src/types.js';
import { isWild } from '../src/rules.js';

const deck = buildDeck();

const countWhere = (pred: (c: Card) => boolean) => deck.filter(pred).length;
const perColor = (color: Color, pred: (c: Card) => boolean) =>
  deck.filter((c) => !isWild(c) && (c as { color: Color }).color === color && pred(c)).length;

describe('official 168-card deck', () => {
  it('has exactly 168 cards', () => {
    expect(deck).toHaveLength(DECK_SIZE);
  });

  it('gives every card a unique id', () => {
    expect(new Set(deck.map((c) => c.id)).size).toBe(DECK_SIZE);
  });

  it('has 36 cards in each colour, 144 coloured in total', () => {
    for (const color of COLORS) {
      expect(perColor(color, () => true), `${color} count`).toBe(CARDS_PER_COLOR);
    }
    expect(countWhere((c) => !isWild(c))).toBe(144);
  });

  it('has 24 wild cards', () => {
    expect(countWhere(isWild)).toBe(24);
  });

  describe('per-colour composition', () => {
    for (const color of COLORS) {
      it(`${color}: 20 numbers (two of each digit, including two zeros)`, () => {
        expect(perColor(color, (c) => c.k === 'number')).toBe(20);
        for (let n = 0; n <= 9; n++) {
          expect(perColor(color, (c) => c.k === 'number' && c.n === n), `digit ${n}`).toBe(2);
        }
      });

      it(`${color}: 3 Draw 2, 2 Draw 4`, () => {
        expect(perColor(color, (c) => c.k === 'draw' && c.amount === 2)).toBe(3);
        expect(perColor(color, (c) => c.k === 'draw' && c.amount === 4)).toBe(2);
      });

      it(`${color}: 3 Skip, 2 Skip Everyone, 3 Reverse, 3 Discard All`, () => {
        expect(perColor(color, (c) => c.k === 'skip')).toBe(3);
        expect(perColor(color, (c) => c.k === 'skipEveryone')).toBe(2);
        expect(perColor(color, (c) => c.k === 'reverse')).toBe(3);
        expect(perColor(color, (c) => c.k === 'discardAll')).toBe(3);
      });
    }
  });

  describe('wild composition', () => {
    it('8 Wild Reverse Draw 4', () => {
      expect(countWhere((c) => c.k === 'wildReverseDraw4')).toBe(8);
    });
    it('4 Wild Draw 6 and 4 Wild Draw 10', () => {
      expect(countWhere((c) => c.k === 'wildDraw' && c.amount === 6)).toBe(4);
      expect(countWhere((c) => c.k === 'wildDraw' && c.amount === 10)).toBe(4);
    });
    it('8 Wild Color Roulette', () => {
      expect(countWhere((c) => c.k === 'wildColorRoulette')).toBe(8);
    });
    it('contains no plain Wild and no standalone Wild Draw 4', () => {
      // Reverse Draw 4 IS the +4 wild in No Mercy; there is no other.
      expect(deck.some((c) => (c as { k: string }).k === 'wild')).toBe(false);
      expect(countWhere((c) => c.k === 'wildDraw' && (c.amount as number) === 4)).toBe(0);
    });
  });
});

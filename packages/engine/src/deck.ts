/**
 * The official UNO Show 'Em No Mercy deck: 168 cards.
 *
 * 144 coloured (36 per colour) + 24 wild. If a count ever needs correcting,
 * this table is the only place to change.
 */

import { COLORS, type Card, type Color, type Digit } from './types.js';

/** Per-colour composition. Sums to 36. */
const COLORED_SPEC = [
  // Numbers 0-9, two copies of each -- note there are TWO zeros, unlike classic UNO.
  ...Array.from({ length: 10 }, (_, n) => ({ k: 'number' as const, n: n as Digit, count: 2 })),
  { k: 'draw' as const, amount: 2 as const, count: 3 },
  { k: 'draw' as const, amount: 4 as const, count: 2 },
  { k: 'skip' as const, count: 3 },
  { k: 'skipEveryone' as const, count: 2 },
  { k: 'reverse' as const, count: 3 },
  { k: 'discardAll' as const, count: 3 },
];

/** Wild composition. Sums to 24. */
const WILD_SPEC = [
  { k: 'wildReverseDraw4' as const, count: 8 },
  { k: 'wildDraw' as const, amount: 6 as const, count: 4 },
  { k: 'wildDraw' as const, amount: 10 as const, count: 4 },
  { k: 'wildColorRoulette' as const, count: 8 },
];

export const DECK_SIZE = 168;
export const CARDS_PER_COLOR = 36;

/**
 * How many decks a table of this size plays with.
 *
 * One deck per four players. Eight people cannot share 168 cards in No Mercy:
 * a single +10 into a +6 puts sixteen cards in one hand, and with knock-out off
 * nobody is ever removed to give theirs back. The deck emptied every few
 * minutes, and the only escape the engine had was to re-deal -- which players
 * quite reasonably read as the game restarting itself.
 */
export function decksForPlayers(players: number): number {
  return Math.max(1, Math.ceil(players / 4));
}

/**
 * Build a fresh, ordered deck. Ids are stable and unique across the deck, which
 * is what lets the client address a card ("play id X") and animate it by
 * layoutId without any extra bookkeeping.
 *
 * `copy` distinguishes the decks at a table playing with more than one. Without
 * it every deck would mint the same ids, two different cards would answer to
 * "red-5#3", and both addressing a card and animating it by layoutId would
 * quietly target the wrong one. Copy 0 is unsuffixed so existing ids are
 * unchanged.
 */
export function buildDeck(copy = 0): Card[] {
  const cards: Card[] = [];
  let seq = 0;
  const suffix = copy > 0 ? `/${copy}` : '';
  const id = (prefix: string) => `${prefix}#${seq++}${suffix}`;

  for (const color of COLORS) {
    const c = color as Color;
    for (const spec of COLORED_SPEC) {
      for (let i = 0; i < spec.count; i++) {
        switch (spec.k) {
          case 'number':
            cards.push({ id: id(`${c}-${spec.n}`), k: 'number', color: c, n: spec.n });
            break;
          case 'draw':
            cards.push({ id: id(`${c}-d${spec.amount}`), k: 'draw', color: c, amount: spec.amount });
            break;
          case 'skip':
            cards.push({ id: id(`${c}-skip`), k: 'skip', color: c });
            break;
          case 'skipEveryone':
            cards.push({ id: id(`${c}-skipall`), k: 'skipEveryone', color: c });
            break;
          case 'reverse':
            cards.push({ id: id(`${c}-rev`), k: 'reverse', color: c });
            break;
          case 'discardAll':
            cards.push({ id: id(`${c}-disall`), k: 'discardAll', color: c });
            break;
        }
      }
    }
  }

  for (const spec of WILD_SPEC) {
    for (let i = 0; i < spec.count; i++) {
      switch (spec.k) {
        case 'wildReverseDraw4':
          cards.push({ id: id('w-revd4'), k: 'wildReverseDraw4' });
          break;
        case 'wildDraw':
          cards.push({ id: id(`w-d${spec.amount}`), k: 'wildDraw', amount: spec.amount });
          break;
        case 'wildColorRoulette':
          cards.push({ id: id('w-roulette'), k: 'wildColorRoulette' });
          break;
      }
    }
  }

  return cards;
}

/** `count` decks, each with its own id space. */
export function buildDecks(count: number): Card[] {
  const cards: Card[] = [];
  for (let copy = 0; copy < count; copy++) cards.push(...buildDeck(copy));
  return cards;
}

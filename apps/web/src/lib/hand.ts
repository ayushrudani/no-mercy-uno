/**
 * Ordering and laying out the cards in your hand.
 *
 * Both are pure functions of the hand and the space available, so the awkward
 * cases -- 30 cards on a phone, a hand of one, a container that has not been
 * measured yet -- are settled in tests rather than discovered mid-game.
 */

import { handSortSchema, type Card, type Color, type HandSort } from '@nmu/shared';

export type { HandSort };

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export const HAND_SORTS = handSortSchema.options;

export function isHandSort(value: string): value is HandSort {
  return handSortSchema.safeParse(value).success;
}

/** Rainbow order. Matches the order the colour picker offers them. */
const COLOR_ORDER: Record<Color, number> = { red: 0, yellow: 1, green: 2, blue: 3 };

/**
 * Rank within one colour: plain numbers first in value order, then the action
 * cards from least to most violent.
 *
 * Putting the numbers first matters more than it sounds. The card you reach for
 * under time pressure is a plain match on colour or number, and having those in
 * a predictable block at the front of each colour is most of the value of
 * sorting at all.
 */
function rankWithinColor(card: Card): number {
  switch (card.k) {
    case 'number':
      return card.n;
    case 'skip':
      return 10;
    case 'skipEveryone':
      return 11;
    case 'reverse':
      return 12;
    case 'draw':
      return 20 + card.amount;
    case 'discardAll':
      return 40;
    default:
      return 50;
  }
}

/** Wilds sort among themselves, after every coloured card. */
function rankWild(card: Card): number {
  switch (card.k) {
    case 'wildColorRoulette':
      return 0;
    case 'wildDraw':
      return 1 + card.amount;
    case 'wildReverseDraw4':
      return 20;
    default:
      return 30;
  }
}

const isWild = (c: Card) =>
  c.k === 'wildReverseDraw4' || c.k === 'wildDraw' || c.k === 'wildColorRoulette';

/**
 * Order a hand for display.
 *
 * `dealt` returns the server's order untouched: cards stay where you last saw
 * them, and a card you just drew appears at the end rather than jumping into
 * the middle of the fan.
 *
 * `color` groups by colour and then by rank, with wilds last -- they play on
 * anything, so they are the cards you look for when nothing else works.
 *
 * Never mutates its input; the hand comes from the store.
 */
export function sortHand(hand: readonly Card[], sort: HandSort): Card[] {
  if (sort === 'dealt') return [...hand];

  return [...hand].sort((a, b) => {
    const aWild = isWild(a);
    const bWild = isWild(b);
    if (aWild !== bWild) return aWild ? 1 : -1;

    if (aWild && bWild) {
      const byRank = rankWild(a) - rankWild(b);
      // Card ids break every tie, so the order is stable across re-renders
      // instead of shuffling identical cards around on each update.
      return byRank !== 0 ? byRank : a.id.localeCompare(b.id);
    }

    const colorA = COLOR_ORDER[(a as { color: Color }).color];
    const colorB = COLOR_ORDER[(b as { color: Color }).color];
    if (colorA !== colorB) return colorA - colorB;

    const byRank = rankWithinColor(a) - rankWithinColor(b);
    return byRank !== 0 ? byRank : a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface HandLayout {
  /** Number of cards on each row, in order. */
  rows: number[];
  /**
   * Distance between the left edges of neighbouring cards, in px.
   *
   * Anything less than the card width means they overlap. The visible sliver of
   * a covered card is exactly this, which is why the corner index sits in the
   * top-left of every card.
   */
  step: number;
}

export interface HandLayoutOptions {
  count: number;
  /** Usable width in px. 0 while the container is still unmeasured. */
  width: number;
  cardWidth: number;
  /** Breathing room between cards when they all fit without overlapping. */
  gap: number;
  /** Narrowest sliver that still shows a card's corner index. */
  minStep: number;
  /** Vertical space is scarce on a phone in landscape, so this stays small. */
  maxRows: number;
}

/** Spread `count` over `rows` rows, fullest first, differing by at most one. */
function distribute(count: number, rows: number): number[] {
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Fit a whole hand into the space available, without scrolling.
 *
 * The hand used to be a horizontal scroller, which meant a big hand hid most of
 * itself: you cannot plan a turn against cards that are off-screen, and on a
 * touch device the scroll fought with tapping a card.
 *
 * So cards overlap instead, by however much they have to. One row is always
 * preferred -- a fan reads as one hand, two rows read as two piles -- and a
 * second row is only used when overlapping alone would squeeze cards past
 * `minStep` and make the corner indices unreadable.
 */
export function layoutHand({
  count,
  width,
  cardWidth,
  gap,
  minStep,
  maxRows,
}: HandLayoutOptions): HandLayout {
  const loose = cardWidth + gap;
  if (count <= 0) return { rows: [], step: loose };

  // Unmeasured container: assume everything fits rather than guess an overlap
  // and animate out of it a frame later.
  if (width <= 0) return { rows: [count], step: loose };

  for (let rows = 1; rows <= maxRows; rows++) {
    const perRow = Math.ceil(count / rows);
    if (perRow <= 1) return { rows: distribute(count, Math.min(rows, count)), step: loose };

    // The last card's right edge must land on `width`, so the first n-1 cards
    // each take `step` and the last one takes its full width.
    const step = (width - cardWidth) / (perRow - 1);
    if (step >= loose) return { rows: distribute(count, rows), step: loose };
    if (step >= minStep) return { rows: distribute(count, rows), step };
  }

  // Even at maxRows the cards are tighter than minStep. Hold the floor and let
  // them overlap harder rather than reintroducing a scrollbar -- a hand this
  // size is already a lost game, and seeing all of it still beats seeing part.
  const perRow = Math.ceil(count / maxRows);
  const step = perRow > 1 ? Math.max((width - cardWidth) / (perRow - 1), 1) : loose;
  return { rows: distribute(count, maxRows), step };
}

/** Split a hand into the rows a layout describes. */
export function chunkRows<T>(items: readonly T[], rows: number[]): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (const size of rows) {
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * Card predicates. Pure functions over a card and the visible table state --
 * no game state mutation lives here, which keeps legality testable in isolation
 * and lets the client reuse the exact same "is this playable?" logic to grey
 * out cards without ever disagreeing with the server.
 */

import type { Card, Color, ColoredCard, DrawAmount, GameConfig } from './types.js';

export function isWild(card: Card): card is Extract<Card, { k: `wild${string}` }> {
  return card.k === 'wildReverseDraw4' || card.k === 'wildDraw' || card.k === 'wildColorRoulette';
}

export function isColored(card: Card): card is ColoredCard {
  return !isWild(card);
}

/** Wilds that require the player to name a colour when they play it. */
export function needsColorChoice(card: Card): boolean {
  return card.k === 'wildReverseDraw4' || card.k === 'wildDraw';
}

/**
 * How many cards this card adds to a draw stack, or null if it is not a stack
 * card at all.
 *
 * Color Roulette deliberately returns null: it has no fixed value, so it can
 * neither join a stack nor be stacked upon.
 */
export function drawValue(card: Card): DrawAmount | null {
  if (card.k === 'draw') return card.amount;
  if (card.k === 'wildDraw') return card.amount;
  if (card.k === 'wildReverseDraw4') return 4;
  return null;
}

/** Do two cards show the same face, ignoring colour? */
export function sameFace(a: Card, b: Card): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'number' && b.k === 'number') return a.n === b.n;
  if (a.k === 'draw' && b.k === 'draw') return a.amount === b.amount;
  if (a.k === 'wildDraw' && b.k === 'wildDraw') return a.amount === b.amount;
  return true;
}

export interface TableView {
  top: Card;
  activeColor: Color;
  pendingDraw: number;
  pendingTier: 0 | DrawAmount;
  config: GameConfig;
}

/**
 * Is `card` legal right now?
 *
 * Two distinct modes:
 *
 * 1. A stack is pending -- only draw cards worth >= the current tier are legal.
 *    Everything else, Color Roulette included, is refused. This is the rule that
 *    makes a +10 genuinely terrifying: nothing but another +10 answers it.
 * 2. No stack -- wilds are always legal; a coloured card must match either the
 *    active colour or the top card's face.
 */
export function canPlay(card: Card, view: TableView): boolean {
  const { top, activeColor, pendingDraw, pendingTier, config } = view;

  if (pendingDraw > 0) {
    const value = drawValue(card);
    if (value === null) return false;
    if (value < pendingTier) return false;
    if (config.stackRequiresColorMatch && isColored(card) && card.color !== activeColor) {
      return false;
    }
    return true;
  }

  if (isWild(card)) return true;
  if (card.color === activeColor) return true;
  return isColored(top) && sameFace(card, top);
}

/** Every legal card in a hand, in hand order. */
export function legalCards(hand: readonly Card[], view: TableView): Card[] {
  return hand.filter((c) => canPlay(c, view));
}

export function hasLegalCard(hand: readonly Card[], view: TableView): boolean {
  return hand.some((c) => canPlay(c, view));
}

/**
 * Ranking used by the timeout auto-player: shed the least valuable legal card.
 * Lower sorts first. Keeping wilds and big draws back is what a human would do,
 * so an auto-played turn does not feel like a punishment beyond losing tempo.
 */
export function cardShedPriority(card: Card): number {
  switch (card.k) {
    case 'number':
      return 0;
    case 'skip':
    case 'reverse':
      return 1;
    case 'discardAll':
      return 2;
    case 'skipEveryone':
      return 3;
    case 'draw':
      return 4 + card.amount;
    case 'wildColorRoulette':
      return 20;
    case 'wildReverseDraw4':
      return 21;
    case 'wildDraw':
      return 22 + card.amount;
  }
}

/** The colour a bot/auto-play should name: whichever it holds most of. */
export function bestColorFor(hand: readonly Card[]): Color {
  const counts: Record<Color, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) if (isColored(c)) counts[c.color]++;
  let best: Color = 'red';
  for (const c of ['red', 'yellow', 'green', 'blue'] as const) {
    if (counts[c] > counts[best]) best = c;
  }
  return best;
}

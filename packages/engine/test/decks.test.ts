/**
 * Deck sizing and what happens when the cards run out.
 *
 * The behaviour being pinned down here replaced re-dealing the table. With
 * eight players a single 168-card deck emptied every few minutes, and the
 * re-deal that unwedged it was indistinguishable from the game restarting
 * itself.
 */

import { describe, expect, it } from 'vitest';
import { buildDeck, buildDecks, decksForPlayers, DECK_SIZE } from '../src/deck.js';
import { createGame, reduce } from '../src/engine.js';
import type { GameState } from '../src/types.js';
import { handOf, makeState, num } from './helpers.js';

const census = (s: GameState) =>
  s.drawPile.length + s.discardPile.length + s.players.reduce((n, p) => n + p.hand.length, 0);

const ids = (s: GameState) =>
  [...s.drawPile, ...s.discardPile, ...s.players.flatMap((p) => p.hand)].map((c) => c.id);

describe('decksForPlayers', () => {
  it('gives small tables one deck', () => {
    for (const n of [2, 3, 4]) expect(decksForPlayers(n), `${n} players`).toBe(1);
  });

  /** Eight people cannot share 168 cards once +10s start landing. */
  it('gives a big table two', () => {
    for (const n of [5, 6, 7, 8]) expect(decksForPlayers(n), `${n} players`).toBe(2);
  });

  it('never returns zero', () => {
    expect(decksForPlayers(0)).toBe(1);
    expect(decksForPlayers(1)).toBe(1);
  });
});

describe('building more than one deck', () => {
  it('builds a full deck per copy', () => {
    expect(buildDeck()).toHaveLength(DECK_SIZE);
    expect(buildDecks(2)).toHaveLength(DECK_SIZE * 2);
    expect(buildDecks(3)).toHaveLength(DECK_SIZE * 3);
  });

  /**
   * The reason copies have their own id space. Two cards answering to the same
   * id would break both "play this card" and the client's layoutId animation,
   * and it would do so silently.
   */
  it('gives every card across every deck a unique id', () => {
    const all = buildDecks(3).map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves the first deck ids untouched', () => {
    expect(buildDecks(2).slice(0, DECK_SIZE).map((c) => c.id)).toEqual(
      buildDeck().map((c) => c.id),
    );
  });

  it('keeps the composition identical in every copy', () => {
    const shape = (cards: ReturnType<typeof buildDeck>) =>
      cards.map((c) => c.k).sort().join(',');
    expect(shape(buildDeck(1))).toBe(shape(buildDeck(0)));
  });
});

describe('the opening deal', () => {
  it('scales the pool to the number of players', () => {
    expect(census(createGame(['a', 'b'], 1))).toBe(DECK_SIZE);
    expect(census(createGame(['a', 'b', 'c', 'd'], 1))).toBe(DECK_SIZE);
    expect(census(createGame(['a', 'b', 'c', 'd', 'e'], 1))).toBe(DECK_SIZE * 2);
  });

  it('records how many decks are in play', () => {
    expect(createGame(['a', 'b'], 1).decksInPlay).toBe(1);
    expect(createGame(Array.from({ length: 8 }, (_, i) => `p${i}`), 1).decksInPlay).toBe(2);
  });

  it('deals a full table of eight without running dry', () => {
    const game = createGame(Array.from({ length: 8 }, (_, i) => `p${i}`), 1);
    expect(game.players.every((p) => p.hand.length === game.config.handSize)).toBe(true);
    expect(game.drawPile.length).toBeGreaterThan(200);
  });
});

describe('running out of cards', () => {
  /**
   * The exhausted table: nothing in the draw pile and nothing to recycle,
   * because every other card is in a hand.
   */
  const exhausted = () =>
    makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 3), num('blue', 4)]],
      top: num('red', 5),
      drawPile: [],
    });

  it('shuffles in another deck instead of re-dealing', () => {
    const before = exhausted();
    const { state, events } = reduce(before, { t: 'draw', playerId: 'p0' });

    expect(events.some((e) => e.t === 'deckExtended')).toBe(true);
    expect(events.some((e) => e.t === 'roundStalemate')).toBe(false);
    expect(events.some((e) => e.t === 'roundStarted')).toBe(false);
  });

  it('leaves everyone holding the cards they already had', () => {
    const before = exhausted();
    const keptByOpponent = handOf(before, 1).map((c) => c.id);

    const { state } = reduce(before, { t: 'draw', playerId: 'p0' });

    // The opponent is untouched, and the drawing player gained exactly one.
    expect(handOf(state, 1).map((c) => c.id)).toEqual(keptByOpponent);
    expect(handOf(state, 0)).toHaveLength(3);
  });

  it('grows the pool by exactly one deck', () => {
    const before = exhausted();
    const { state } = reduce(before, { t: 'draw', playerId: 'p0' });

    expect(state.decksInPlay).toBe(before.decksInPlay + 1);
    expect(census(state)).toBe(census(before) + DECK_SIZE);
  });

  it('does not duplicate a single card id', () => {
    const { state } = reduce(exhausted(), { t: 'draw', playerId: 'p0' });
    expect(new Set(ids(state)).size).toBe(ids(state).length);
  });

  it('keeps the game going rather than ending it', () => {
    const { state } = reduce(exhausted(), { t: 'draw', playerId: 'p0' });
    expect(state.phase.t).not.toBe('gameOver');
    expect(state.round).toBe(1);
  });

  /** A pending stack is the usual way a table gets drained. */
  it('covers a big pending draw that outlasts the pool', () => {
    const before = makeState({
      hands: [[num('red', 1)], [num('blue', 3)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 10,
      pendingTier: 10,
      drawPile: [],
    });
    const { state, events } = reduce(before, { t: 'draw', playerId: 'p1' });

    expect(events.some((e) => e.t === 'deckExtended')).toBe(true);
    expect(handOf(state, 1)).toHaveLength(11);
    expect(new Set(ids(state)).size).toBe(ids(state).length);
  });
});

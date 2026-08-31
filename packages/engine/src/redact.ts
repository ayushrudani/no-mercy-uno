/**
 * Per-player views of the game state.
 *
 * The server must never send a full `GameState` to a client: it contains every
 * opponent's hand and the exact order of the draw pile. Opening devtools would
 * be a total-information cheat. Every socket emit goes through `redactFor`.
 */

import { currentActorId, legalMovesFor, tableView, topCard } from './engine.js';
import type { Card, Color, DrawAmount, GameState, Phase } from './types.js';

export interface OpponentView {
  id: string;
  cardCount: number;
  eliminated: boolean;
  /** Finishing position once they have gone out; null while still playing. */
  place: number | null;
  /** Public on purpose: the table needs to see who remembered to call. */
  calledUno: boolean;
}

export interface PlayerGameView {
  /** The viewer, or null when they are a spectator. */
  you: {
    id: string;
    hand: Card[];
    /** Ids from `hand` that are legal right now -- the UI lights these up. */
    playableCardIds: string[];
    eliminated: boolean;
    /** Finishing position once they have gone out; null while still playing. */
    place: number | null;
    calledUno: boolean;
    /** Show the UNO button. */
    canCallUno: boolean;
  } | null;
  players: OpponentView[];
  /** Seating order by player id, so the client can lay out the table. */
  seats: string[];
  turnPlayerId: string | null;
  direction: 1 | -1;
  top: Card;
  activeColor: Color;
  drawPileCount: number;
  discardPileCount: number;
  pendingDraw: number;
  pendingTier: 0 | DrawAmount;
  phase: Phase;
  round: number;
  winnerId: string | null;
}

export function redactFor(state: GameState, viewerId: string | null): PlayerGameView {
  const viewer = viewerId ? state.players.find((p) => p.id === viewerId) ?? null : null;

  return {
    you: viewer
      ? {
          id: viewer.id,
          hand: viewer.hand,
          playableCardIds: legalMovesFor(state, viewer.id).map((c) => c.id),
          eliminated: viewer.eliminated,
          place: viewer.place,
          calledUno: viewer.calledUno,
          /** The button is live only while holding exactly two cards. */
          canCallUno:
            state.config.unoCall && viewer.hand.length === 2 && !viewer.calledUno && !viewer.eliminated,
        }
      : null,
    players: state.players.map((p) => ({
      id: p.id,
      cardCount: p.hand.length,
      eliminated: p.eliminated,
      place: p.place,
      calledUno: p.calledUno,
    })),
    seats: state.players.map((p) => p.id),
    turnPlayerId: currentActorId(state),
    direction: state.direction,
    top: topCard(state),
    activeColor: state.activeColor,
    drawPileCount: state.drawPile.length,
    discardPileCount: state.discardPile.length,
    pendingDraw: state.pendingDraw,
    pendingTier: state.pendingTier,
    phase: state.phase,
    round: state.round,
    winnerId: state.winnerId,
  };
}

/** Convenience for a spectator (eliminated player or watcher). */
export function spectatorView(state: GameState): PlayerGameView {
  return redactFor(state, null);
}

export { tableView };

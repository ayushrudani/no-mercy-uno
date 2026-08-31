/**
 * What the local player is allowed to do right now.
 *
 * Extracted from the Table component and kept pure so it can be tested without
 * a DOM. It exists because these checks got this wrong once: `phase` is global
 * to the table, so testing it alone showed a Pass button to every player
 * whenever *anyone* drew a card. Every branch here must be scoped to the
 * viewer, and the tests assert exactly that.
 */

import type { PlayerGameView } from '@nmu/shared';

export interface TurnActions {
  /** It is this player's turn to act at all. */
  isMyTurn: boolean;
  /** Show the draw / take-the-stack button. */
  canDraw: boolean;
  /** They drew a card and must now play it or pass. */
  mustDecideDrawn: boolean;
  /** Color Roulette landed on them and is waiting for a colour. */
  mustNameRouletteColor: boolean;
  /** They played a 7 under the 7-0 rule and must choose whose hand to take. */
  mustChooseSwapTarget: boolean;
  /** Label for the draw button; a pending stack changes what it means. */
  drawLabel: string;
  /** Cards they may legally play, as a set for fast lookup during render. */
  playableIds: Set<string>;
  /** They are out and watching. */
  isSpectator: boolean;
  /**
   * Show the UNO button. Deliberately independent of whose turn it is: you
   * press it while holding two cards, which is usually before your turn.
   */
  canCallUno: boolean;
}

export function turnActions(view: PlayerGameView, myId: string): TurnActions {
  const me = view.you;
  const isMyTurn = view.turnPlayerId === myId;

  return {
    isMyTurn,
    canDraw: isMyTurn && view.phase.t === 'awaitingPlay',
    mustDecideDrawn: isMyTurn && view.phase.t === 'awaitingDrawnCardDecision',
    mustNameRouletteColor:
      view.phase.t === 'awaitingRouletteColor' && view.phase.targetId === myId,
    mustChooseSwapTarget:
      view.phase.t === 'awaitingSwapTarget' && view.phase.playerId === myId,
    drawLabel: view.pendingDraw > 0 ? `Take ${view.pendingDraw}` : 'Draw',
    playableIds: new Set(isMyTurn ? (me?.playableCardIds ?? []) : []),
    isSpectator: !me || me.eliminated,
    canCallUno: me?.canCallUno ?? false,
  };
}

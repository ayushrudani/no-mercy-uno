/**
 * Deriving a player's record from their match history.
 *
 * Computed on the client from the matches already fetched, rather than as a
 * second endpoint: it is one pass over at most a few dozen rows, and a separate
 * aggregate query could drift out of step with the list shown beside it.
 */

import type { MatchSummary } from './api.js';

export interface Stats {
  played: number;
  won: number;
  /** Whole-number percentage, 0 when nothing has been played. */
  winRate: number;
  roundsWon: number;
  /** Lowest (best) finishing position achieved, or null. */
  bestPlace: number | null;
}

export function summarise(matches: readonly MatchSummary[], userId: string): Stats {
  let played = 0;
  let won = 0;
  let roundsWon = 0;
  let bestPlace: number | null = null;

  for (const match of matches) {
    const me = match.players.find((p) => p.userId === userId);
    if (!me) continue;

    // Only finished games count. An abandoned game has no winner, and letting
    // it into the denominator would quietly depress everyone's win rate.
    if (!match.endedAt) continue;

    played++;
    roundsWon += me.roundsWon;
    if (match.winnerId === userId) won++;
    if (me.finalPlace !== null && (bestPlace === null || me.finalPlace < bestPlace)) {
      bestPlace = me.finalPlace;
    }
  }

  return {
    played,
    won,
    winRate: played === 0 ? 0 : Math.round((won / played) * 100),
    roundsWon,
    bestPlace,
  };
}

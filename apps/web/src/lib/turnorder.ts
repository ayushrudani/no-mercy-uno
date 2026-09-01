/**
 * Who plays next, and which way play is going.
 *
 * The table showed whose turn it was and a small arrow for the direction, and
 * that was not enough to follow a game: with six or eight people you cannot
 * tell who is about to be hit by the +10 you are considering, and after a
 * reverse nobody is sure which way things now run.
 *
 * Kept as a pure function of the view so the awkward cases -- a player who has
 * already gone out, a reversed table, a table down to one -- are settled in
 * tests rather than discovered mid-game.
 */

export interface SeatedPlayer {
  id: string;
  eliminated: boolean;
  /** Finishing position once they have gone out; null while still playing. */
  place: number | null;
}

export interface TurnOrderView {
  /** Seating order by player id. */
  seats: readonly string[];
  players: readonly SeatedPlayer[];
  turnPlayerId: string | null;
  direction: 1 | -1;
}

/** Still taking turns: not knocked out, and not already finished. */
function stillPlaying(view: TurnOrderView, id: string): boolean {
  const player = view.players.find((p) => p.id === id);
  return !!player && !player.eliminated && player.place === null;
}

/**
 * The seat that acts after the current one, if nothing changes it.
 *
 * "If nothing changes" is the honest caveat: a skip or a reverse in the card
 * about to be played will move it. This answers the question a player actually
 * has while choosing a card -- who is sitting downstream of me right now.
 *
 * Returns null when there is no meaningful answer: nobody is on turn, or the
 * current player is the last one still in.
 */
export function nextPlayerId(view: TurnOrderView): string | null {
  const { seats, turnPlayerId, direction } = view;
  if (!turnPlayerId || seats.length === 0) return null;

  const at = seats.indexOf(turnPlayerId);
  if (at < 0) return null;

  const n = seats.length;
  for (let step = 1; step <= n; step++) {
    // Normalised twice: a negative direction takes the index below zero, and
    // JavaScript's % keeps the sign of the dividend.
    const index = (((at + step * direction) % n) + n) % n;
    const id = seats[index];
    if (id && id !== turnPlayerId && stillPlaying(view, id)) return id;
  }
  return null;
}

/**
 * Everyone still in, in the order they will actually play from here.
 *
 * Starts with whoever is on turn. Used to render the running order, which is
 * the only way a table of eight reads as a sequence rather than a row of
 * avatars.
 */
export function turnOrderFrom(view: TurnOrderView): string[] {
  const { seats, turnPlayerId, direction } = view;
  if (!turnPlayerId || seats.length === 0) return [];

  const at = seats.indexOf(turnPlayerId);
  if (at < 0) return [];

  const n = seats.length;
  const out: string[] = [];
  for (let step = 0; step < n; step++) {
    const index = (((at + step * direction) % n) + n) % n;
    const id = seats[index];
    if (id && stillPlaying(view, id)) out.push(id);
  }
  return out;
}

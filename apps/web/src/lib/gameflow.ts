/**
 * Moving between one game and the next.
 *
 * Small, but it earned its own module by being wrong: the win overlay used to
 * be cleared by whoever pressed "Play again", which meant it was cleared on
 * exactly one client. Everyone else kept a result screen pinned over a game
 * that had already restarted underneath, so from their side the host had
 * pressed the button and nothing had happened.
 *
 * The rule below makes the overlay a function of the server's snapshot instead
 * of a local click, which is the only version that can be right for every
 * player at once.
 */

/** What the client is showing on top of the table, if anything. */
export interface GameFlowState {
  /** Set by `game:over`, on every client. */
  hasResultOverlay: boolean;
}

/** The part of an incoming snapshot this decision depends on. */
export interface IncomingSnapshot {
  phase: { t: string };
}

/**
 * Should the result overlay come down now that this snapshot has arrived?
 *
 * True only when a result is on screen *and* the snapshot describes a game
 * still in progress — that combination can only mean a new game has started.
 * A snapshot of the finished game keeps the overlay, so the ordinary flurry of
 * updates around a win does not flash it away.
 */
export function shouldClearResult(
  state: GameFlowState,
  snapshot: IncomingSnapshot,
): boolean {
  return state.hasResultOverlay && snapshot.phase.t !== 'gameOver';
}

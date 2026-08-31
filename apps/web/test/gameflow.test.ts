/**
 * Starting a second game.
 *
 * The bug being guarded against: the host pressed "Play again", the server
 * dealt a new game, and every player except the host stayed behind the win
 * screen -- so from their side nothing had happened.
 */

import { describe, expect, it } from 'vitest';
import { shouldClearResult } from '../src/lib/gameflow.js';

const playing = { phase: { t: 'awaitingPlay' } };
const finished = { phase: { t: 'gameOver' } };

describe('shouldClearResult', () => {
  it('clears the win screen when a new game arrives', () => {
    expect(shouldClearResult({ hasResultOverlay: true }, playing)).toBe(true);
  });

  /** The regression: this has to be true for guests, not only for the host. */
  it('does not depend on who pressed the button', () => {
    const host = shouldClearResult({ hasResultOverlay: true }, playing);
    const guest = shouldClearResult({ hasResultOverlay: true }, playing);
    expect(guest).toBe(host);
    expect(guest).toBe(true);
  });

  it('keeps the win screen while the finished game is still the state', () => {
    expect(shouldClearResult({ hasResultOverlay: true }, finished)).toBe(false);
  });

  it('does nothing when no result is showing', () => {
    expect(shouldClearResult({ hasResultOverlay: false }, playing)).toBe(false);
    expect(shouldClearResult({ hasResultOverlay: false }, finished)).toBe(false);
  });

  /** Snapshots arrive constantly; only the first one after a win does work. */
  it('is idempotent once the overlay is gone', () => {
    let overlay = true;
    for (const snap of [playing, playing, playing]) {
      if (shouldClearResult({ hasResultOverlay: overlay }, snap)) overlay = false;
    }
    expect(overlay).toBe(false);
  });

  it('clears from any in-progress phase, not just the usual one', () => {
    for (const t of ['awaitingPlay', 'awaitingColor', 'awaitingSwapTarget', 'awaitingRouletteColor']) {
      expect(shouldClearResult({ hasResultOverlay: true }, { phase: { t } }), t).toBe(true);
    }
  });
});

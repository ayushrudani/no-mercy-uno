/**
 * Deciding when to tell the player their connection is bad.
 *
 * Kept as a pure reducer so the hysteresis can be tested directly. The naive
 * version -- warn whenever one round-trip is slow -- fires constantly on mobile
 * data and teaches people to ignore the warning, which is worse than never
 * warning at all. So a warning needs several consecutive bad samples, and
 * clearing it needs several consecutive good ones.
 */

/** RTT above this counts as a bad sample. */
export const SLOW_RTT_MS = 400;
/** Consecutive samples needed to raise, and to clear, a warning. */
export const SLOW_SAMPLES = 3;

export interface NetState {
  badRun: number;
  goodRun: number;
  warned: boolean;
}

export const initialNetState: NetState = { badRun: 0, goodRun: 0, warned: false };

export type NetEvent = 'degraded' | 'recovered' | null;

export interface NetVerdict {
  state: NetState;
  /** Non-null exactly on the transition, so a caller can toast once. */
  event: NetEvent;
}

export function nextNetState(state: NetState, rtt: number): NetVerdict {
  if (rtt > SLOW_RTT_MS) {
    const badRun = state.badRun + 1;
    const next: NetState = { badRun, goodRun: 0, warned: state.warned };
    if (badRun >= SLOW_SAMPLES && !state.warned) {
      return { state: { ...next, warned: true }, event: 'degraded' };
    }
    return { state: next, event: null };
  }

  const goodRun = state.goodRun + 1;
  const next: NetState = { badRun: 0, goodRun, warned: state.warned };
  if (goodRun >= SLOW_SAMPLES && state.warned) {
    return { state: { ...next, warned: false }, event: 'recovered' };
  }
  return { state: next, event: null };
}

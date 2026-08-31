/**
 * Seeded PRNG (mulberry32).
 *
 * The engine must never touch Math.random: a game has to be reproducible from
 * its seed plus its action list, both so tests are deterministic and so a
 * desync can be replayed exactly as it happened.
 *
 * These helpers take and return the RNG state explicitly rather than closing
 * over it, so the caller keeps it in `GameState` where it belongs.
 */

export interface Rolled {
  value: number;
  state: number;
}

/** Advance the generator once, returning a float in [0, 1) and the next state. */
export function roll(state: number): Rolled {
  let a = (state + 0x6d2b79f5) | 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: a };
}

/** Integer in [0, maxExclusive). */
export function rollInt(state: number, maxExclusive: number): Rolled {
  const r = roll(state);
  return { value: Math.floor(r.value * maxExclusive), state: r.state };
}

/**
 * Fisher-Yates. Returns a new array and the advanced state; the input is not
 * mutated, so callers cannot accidentally share a shuffled reference.
 */
export function shuffle<T>(items: readonly T[], state: number): { items: T[]; state: number } {
  const out = items.slice();
  let s = state;
  for (let i = out.length - 1; i > 0; i--) {
    const r = rollInt(s, i + 1);
    s = r.state;
    const j = r.value;
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return { items: out, state: s };
}

/** Derive a seed from a string, so a room code can seed a game. */
export function seedFromString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

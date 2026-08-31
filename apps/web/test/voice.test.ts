/**
 * Voice negotiation rules that can be checked without a browser.
 */

import { describe, expect, it } from 'vitest';
import { isPolitePeer, SILENCE_FLOOR } from '../src/lib/voice.js';
import { speakingRing } from '../src/components/Voice.js';

describe('perfect-negotiation politeness', () => {
  /**
   * The property that matters: for any pair, exactly one side is polite. If
   * both were polite each would roll back its own offer and nobody would
   * connect; if neither were, each would ignore the other and the connection
   * would sit wedged in have-local-offer forever.
   */
  it('is exactly asymmetric for every pair', () => {
    const ids = ['alice', 'bob', 'carol', 'cmtguc2ox0000', 'Z', 'a', '0', 'zzz'];
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        expect(isPolitePeer(a, b), `${a} vs ${b}`).toBe(!isPolitePeer(b, a));
      }
    }
  });

  it('agrees regardless of which side computes it', () => {
    expect(isPolitePeer('bob', 'alice')).toBe(true);
    expect(isPolitePeer('alice', 'bob')).toBe(false);
  });

  it('is stable across repeated calls', () => {
    const first = isPolitePeer('user-1', 'user-2');
    for (let i = 0; i < 20; i++) expect(isPolitePeer('user-1', 'user-2')).toBe(first);
  });
});

describe('speaking ring', () => {
  it('shows nothing when the mic is off, however loud the level', () => {
    expect(speakingRing(1, false)).toBe('');
  });

  it('shows nothing at silence', () => {
    expect(speakingRing(0, true)).toBe('');
  });

  it('grows with loudness', () => {
    const quiet = speakingRing(0.2, true);
    const loud = speakingRing(0.9, true);
    expect(quiet).not.toBe('');
    expect(loud).not.toBe('');

    const spread = (s: string) => Number(/0 0 0 (\d+)px/.exec(s)![1]);
    expect(spread(loud)).toBeGreaterThan(spread(quiet));
  });
});

describe('silence floor', () => {
  it('is low enough to catch speech but above room hiss', () => {
    expect(SILENCE_FLOOR).toBeGreaterThan(0);
    expect(SILENCE_FLOOR).toBeLessThan(0.05);
  });
});

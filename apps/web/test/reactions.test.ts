/**
 * Reaction expiry.
 *
 * The list reactions arrive in is append-only and capped at 20 -- nothing is
 * ever removed from it. That is why emoji used to sit on the table for ever:
 * AnimatePresence only plays its exit animation when an item leaves the
 * rendered list, and none ever did. Expiry by age is what makes them leave.
 */

import { describe, expect, it } from 'vitest';
import type { ReactionMessage } from '@nmu/shared';
import { liveReactions, REACTION_LIFETIME_MS } from '../src/components/Chat.js';

const NOW = 1_700_000_000_000;

const at = (offsetMs: number, userId = 'p1'): ReactionMessage => ({
  userId,
  reaction: '🔥',
  at: NOW - offsetMs,
});

describe('liveReactions', () => {
  it('keeps one that just arrived', () => {
    expect(liveReactions([at(0)], NOW)).toHaveLength(1);
  });

  it('drops one older than the lifetime', () => {
    expect(liveReactions([at(REACTION_LIFETIME_MS + 1)], NOW)).toHaveLength(0);
  });

  it('keeps one right on the edge and drops it a tick later', () => {
    const r = at(REACTION_LIFETIME_MS - 1);
    expect(liveReactions([r], NOW)).toHaveLength(1);
    expect(liveReactions([r], NOW + 2)).toHaveLength(0);
  });

  it('drops only the expired ones from a mixed list', () => {
    const live = liveReactions([at(5000), at(100), at(9000), at(500)], NOW);
    expect(live).toHaveLength(2);
    expect(live.every((r) => NOW - r.at < REACTION_LIFETIME_MS)).toBe(true);
  });

  /**
   * The whole point: an append-only list that never shrinks must still end up
   * showing nothing once everything in it is old.
   */
  it('shows nothing once every reaction has aged out', () => {
    const backlog = Array.from({ length: 20 }, (_, i) => at(10_000 + i * 100));
    expect(liveReactions(backlog, NOW)).toEqual([]);
  });

  it('caps at six so a spam burst cannot cover the table', () => {
    const burst = Array.from({ length: 15 }, (_, i) => at(i, `p${i}`));
    expect(liveReactions(burst, NOW)).toHaveLength(6);
  });

  it('keeps the newest six from a burst, not the oldest', () => {
    const burst = Array.from({ length: 10 }, (_, i) => at(i * 10, `p${i}`));
    const live = liveReactions(burst, NOW);
    // slice(-6) keeps the tail of the incoming order.
    expect(live.map((r) => r.userId)).toEqual(['p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
  });

  it('honours a custom lifetime', () => {
    expect(liveReactions([at(500)], NOW, 400)).toHaveLength(0);
    expect(liveReactions([at(300)], NOW, 400)).toHaveLength(1);
  });
});

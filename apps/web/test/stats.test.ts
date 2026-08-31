import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '../src/lib/api.js';
import { summarise } from '../src/lib/stats.js';

const ME = 'me';

function match(over: Partial<MatchSummary> = {}): MatchSummary {
  return {
    id: Math.random().toString(36).slice(2),
    roomCode: 'ABC234',
    startedAt: '2026-08-31T10:00:00Z',
    endedAt: '2026-08-31T10:40:00Z',
    rounds: 3,
    winnerId: ME,
    players: [
      { userId: ME, seat: 0, roundsWon: 2, finalPlace: 1, user: { id: ME, displayName: 'Ayush', avatarUrl: null } },
      { userId: 'them', seat: 1, roundsWon: 1, finalPlace: 2, user: { id: 'them', displayName: 'Rohit', avatarUrl: null } },
    ],
    ...over,
  };
}

describe('summarise', () => {
  it('is all zeroes with no history', () => {
    expect(summarise([], ME)).toEqual({
      played: 0,
      won: 0,
      winRate: 0,
      roundsWon: 0,
      bestPlace: null,
    });
  });

  it('counts wins and rounds', () => {
    const s = summarise([match(), match({ winnerId: 'them' })], ME);
    expect(s.played).toBe(2);
    expect(s.won).toBe(1);
    expect(s.winRate).toBe(50);
    expect(s.roundsWon).toBe(4);
  });

  /**
   * An abandoned game has no winner. Counting it would put a loss in everyone's
   * record for a game nobody actually lost.
   */
  it('ignores games that never finished', () => {
    const s = summarise([match(), match({ endedAt: null, winnerId: null })], ME);
    expect(s.played).toBe(1);
    expect(s.winRate).toBe(100);
  });

  it('ignores games you were not in', () => {
    const other = match({
      winnerId: 'them',
      players: [
        { userId: 'them', seat: 0, roundsWon: 1, finalPlace: 1, user: { id: 'them', displayName: 'Rohit', avatarUrl: null } },
      ],
    });
    expect(summarise([other], ME).played).toBe(0);
  });

  it('keeps the best finish, not the most recent', () => {
    const third = match({
      winnerId: 'them',
      players: [
        { userId: ME, seat: 0, roundsWon: 0, finalPlace: 3, user: { id: ME, displayName: 'Ayush', avatarUrl: null } },
      ],
    });
    expect(summarise([third, match()], ME).bestPlace).toBe(1);
    expect(summarise([match(), third], ME).bestPlace).toBe(1);
  });

  it('rounds the win rate to a whole percent', () => {
    const games = [match(), match({ winnerId: 'them' }), match({ winnerId: 'them' })];
    expect(summarise(games, ME).winRate).toBe(33);
  });

  it('copes with a null finalPlace', () => {
    const m = match({
      players: [
        { userId: ME, seat: 0, roundsWon: 1, finalPlace: null, user: { id: ME, displayName: 'Ayush', avatarUrl: null } },
      ],
    });
    expect(summarise([m], ME).bestPlace).toBeNull();
  });
});

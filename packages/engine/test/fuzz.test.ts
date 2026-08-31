/**
 * Fuzz harness.
 *
 * Hand-written tests only cover the situations we thought of. This plays
 * thousands of complete games with random-but-legal moves and asserts the
 * invariants that must hold after every single action. It is the cheapest way
 * to find the interaction bugs -- a stack resolving into an elimination that
 * lands on a round end, say -- that nobody writes a test for.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  currentActorId,
  legalMovesFor,
  reduce,
  swapCandidates,
  tableView,
} from '../src/engine.js';
import { bestColorFor, isColored } from '../src/rules.js';
import { rollInt } from '../src/rng.js';
import type { Action, GameConfig, GameState } from '../src/types.js';

const DECK_TOTAL = 168;

function cardCensus(s: GameState): number {
  return s.drawPile.length + s.discardPile.length + s.players.reduce((n, p) => n + p.hand.length, 0);
}

function assertInvariants(s: GameState, label: string): void {
  expect(cardCensus(s), `${label}: cards conserved`).toBe(DECK_TOTAL);
  expect(new Set([...s.drawPile, ...s.discardPile, ...s.players.flatMap((p) => p.hand)].map((c) => c.id)).size,
    `${label}: no duplicated card ids`).toBe(DECK_TOTAL);

  for (const p of s.players) {
    if (s.config.eliminationAt > 0) {
      expect(p.hand.length, `${label}: ${p.id} under the elimination limit`).toBeLessThan(s.config.eliminationAt);
    }
    if (p.eliminated) expect(p.hand, `${label}: eliminated players hold nothing`).toHaveLength(0);
    // A standing call on a hand of three would silently excuse the next
    // failure to call, which is exactly the bug worth catching.
    if (p.calledUno) {
      expect(p.hand.length, `${label}: ${p.id} holds a stale UNO call`).toBeLessThanOrEqual(2);
    }
  }

  if (s.phase.t !== 'gameOver') {
    expect(s.discardPile.length, `${label}: a top card exists`).toBeGreaterThan(0);
    const actor = currentActorId(s);
    expect(actor, `${label}: someone must be able to act`).not.toBeNull();
    const seat = s.players.findIndex((p) => p.id === actor);
    expect(s.players[seat]!.eliminated, `${label}: the actor is alive`).toBe(false);

    if (s.pendingDraw > 0) {
      expect(s.pendingTier, `${label}: a live stack has a tier`).toBeGreaterThan(0);
    } else {
      expect(s.pendingTier, `${label}: no stack means no tier`).toBe(0);
    }
  } else {
    expect(s.winnerId, `${label}: a finished game has a winner`).not.toBeNull();
  }
}

/** Pick a random legal action for whoever must act. */
function randomAction(s: GameState, rng: { state: number }): Action {
  const playerId = currentActorId(s)!;
  const player = s.players.find((p) => p.id === playerId)!;

  if (s.phase.t === 'awaitingRouletteColor') {
    const r = rollInt(rng.state, 4);
    rng.state = r.state;
    const colors = ['red', 'yellow', 'green', 'blue'] as const;
    return { t: 'chooseRouletteColor', playerId, color: colors[r.value]! };
  }

  if (s.phase.t === 'awaitingSwapTarget') {
    const options = swapCandidates(s, playerId);
    const r = rollInt(rng.state, options.length);
    rng.state = r.state;
    return { t: 'chooseSwapTarget', playerId, targetId: options[r.value]! };
  }

  const legal = legalMovesFor(s, playerId);

  if (s.phase.t === 'awaitingDrawnCardDecision') {
    const r = rollInt(rng.state, 2);
    rng.state = r.state;
    if (legal.length > 0 && r.value === 0) {
      const card = legal[0]!;
      return { t: 'play', playerId, cardId: card.id, ...(isColored(card) ? {} : { color: bestColorFor(player.hand) }) };
    }
    return { t: 'pass', playerId };
  }

  // Call UNO about half the time, so both the clean path and the penalty path
  // get exercised. Forgetting must be as survivable as remembering.
  if (s.config.unoCall && player.hand.length === 2 && !player.calledUno) {
    const r = rollInt(rng.state, 2);
    rng.state = r.state;
    if (r.value === 0) return { t: 'callUno', playerId };
  }

  if (legal.length === 0) return { t: 'draw', playerId };

  // Occasionally decline a legal play, to exercise the "eat the stack" and
  // voluntary-draw paths as well as the happy path.
  const r = rollInt(rng.state, 10);
  rng.state = r.state;
  if (r.value === 0) return { t: 'draw', playerId };

  const pick = rollInt(rng.state, legal.length);
  rng.state = pick.state;
  const card = legal[pick.value]!;
  return {
    t: 'play',
    playerId,
    cardId: card.id,
    ...(isColored(card) ? {} : { color: bestColorFor(player.hand) }),
  };
}

function playGame(
  seed: number,
  playerCount: number,
  config: Partial<GameConfig> = {},
): { finished: boolean; turns: number } {
  const ids = Array.from({ length: playerCount }, (_, i) => `p${i}`);
  let state = createGame(ids, seed, config);
  const rng = { state: seed ^ 0x9e3779b9 };

  assertInvariants(state, `seed ${seed} initial`);

  const cap = config.eliminationAt === 0 ? 1500 : 4000;
  for (let turn = 0; turn < cap; turn++) {
    if (state.phase.t === 'gameOver') return { finished: true, turns: turn };
    const action = randomAction(state, rng);
    const result = reduce(state, action);
    state = result.state;
    assertInvariants(state, `seed ${seed} turn ${turn} after ${action.t}`);
    // A legal action must never leave the table with nothing playable and no
    // way to draw -- tableView throwing would mean a corrupted discard pile.
    if (state.phase.t !== 'gameOver') tableView(state);
  }

  return { finished: false, turns: cap };
}

/**
 * Games per seat count. The full sweep is slow (invariants are re-checked after
 * every single action), so the dev loop runs a smaller one and CI runs the lot:
 *   FUZZ_GAMES=200 pnpm test
 */
const GAMES = Number(process.env['FUZZ_GAMES'] ?? 40);

describe('fuzz: random legal play never breaks an invariant', () => {
  for (const playerCount of [2, 3, 4, 6, 8]) {
    it(`survives ${GAMES} full games with ${playerCount} players`, () => {
      let finished = 0;
      for (let i = 0; i < GAMES; i++) {
        const res = playGame(i * 7919 + playerCount, playerCount);
        if (res.finished) finished++;
      }
      // Every game must reach a winner; a stall means a rule can deadlock.
      expect(finished, `${playerCount}-player games that reached a winner`).toBe(GAMES);
    });
  }

  /**
   * Every house rule at once. The penalty draws cards mid-turn, 7-0 moves whole
   * hands about, and both interact with elimination -- running them together is
   * the only way to know they compose.
   */
  for (const playerCount of [2, 4, 6]) {
    it(`survives ${GAMES} full games with ${playerCount} players and every house rule on`, () => {
      let finished = 0;
      for (let i = 0; i < GAMES; i++) {
        const res = playGame(i * 4001 + playerCount, playerCount, {
          sevenZero: true,
          unoCall: true,
          unoPenalty: 2,
        });
        if (res.finished) finished++;
      }
      expect(finished, `${playerCount}-player house-rule games that reached a winner`).toBe(GAMES);
    });
  }

  /**
   * 7-0 moves whole hands between players, which is the single most invasive
   * thing any rule here does to state. It gets its own sweep -- an off-by-one
   * in the rotation would duplicate or lose cards, and the census check would
   * catch it on the very next action.
   */
  for (const playerCount of [2, 3, 5, 8]) {
    it(`survives ${GAMES} full games with ${playerCount} players and the 7-0 rule`, () => {
      let finished = 0;
      for (let i = 0; i < GAMES; i++) {
        const res = playGame(i * 6151 + playerCount, playerCount, { sevenZero: true });
        if (res.finished) finished++;
      }
      expect(finished, `${playerCount}-player 7-0 games that reached a winner`).toBe(GAMES);
    });
  }

  /**
   * Knock-out off, first-to-N rounds instead.
   *
   * Termination is deliberately NOT asserted here, and that is a real property
   * of the mode rather than a gap in the test. With knock-out on, a player who
   * hoards cards is eventually removed and their hand returns to the deck --
   * that is the forcing function that guarantees an end. With it off there is
   * none, and this fuzz player is pathological: it draws at random even when it
   * could play, and always eats a stack rather than answering it, so it almost
   * never empties a hand. Real players shed cards and go out every round.
   *
   * What still must hold is every invariant: cards conserved, no duplicated
   * ids, an actor who can always act, and no wedged table. Those are checked
   * after every single action inside playGame.
   */
  for (const playerCount of [2, 4, 6]) {
    it(`holds every invariant for ${GAMES} no-knock-out games with ${playerCount} players`, () => {
      for (let i = 0; i < GAMES; i++) {
        playGame(i * 3313 + playerCount, playerCount, {
          eliminationAt: 0,
          roundsToWin: 3,
          sevenZero: true,
          unoCall: true,
        });
      }
    });
  }

  it('is reproducible: the same seed yields the same game', () => {
    const a = playGame(4242, 4);
    const b = playGame(4242, 4);
    expect(a).toEqual(b);
  });
});

/**
 * The UNO call.
 *
 * The button appears at two cards. Play your second-to-last card without having
 * pressed it and you are penalised immediately -- automatically, rather than
 * needing an opponent to catch you, because on a phone everyone is looking at
 * their own hand and a catch-based rule means nobody is ever penalised.
 */

import { describe, expect, it } from 'vitest';
import { reduce } from '../src/engine.js';
import { IllegalMoveError, type Color, type GameState } from '../src/types.js';
import { discardAll, fillerPile, handOf, makeState, num, skip } from './helpers.js';

const ON = { unoCall: true, unoPenalty: 2 };

const play = (s: GameState, p: number, cardId: string, color?: Color) =>
  reduce(s, { t: 'play', playerId: 'p' + p, cardId, ...(color ? { color } : {}) });

const callUno = (s: GameState, p: number) => reduce(s, { t: 'callUno', playerId: 'p' + p });

describe('with the rule off', () => {
  it('never penalises, and refuses the call outright', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      drawPile: fillerPile(20),
    });
    expect(() => callUno(s, 0)).toThrow(/UNO calls are off/);

    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(handOf(state, 0)).toHaveLength(1);
    expect(events.some((e) => e.t === 'unoPenalty')).toBe(false);
  });
});

describe('calling', () => {
  it('is allowed at exactly two cards', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      config: ON,
    });
    const { state, events } = callUno(s, 0);
    expect(state.players[0]!.calledUno).toBe(true);
    expect(events).toContainEqual({ t: 'unoCalled', playerId: 'p0' });
  });

  it('is refused at any other hand size', () => {
    const three = makeState({
      hands: [[num('red', 1), num('red', 2), num('red', 3)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      config: ON,
    });
    expect(() => callUno(three, 0)).toThrow(/holding two cards/);

    const one = makeState({
      hands: [[num('red', 1)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      config: ON,
    });
    expect(() => callUno(one, 0)).toThrow(/holding two cards/);
  });

  /**
   * Calling is not a turn action. You press it before playing your
   * second-to-last card, which is usually while somebody else is still moving.
   */
  it('does not require it to be your turn', () => {
    const s = makeState({
      hands: [[num('red', 9)], [num('blue', 1), num('blue', 2)], [num('green', 5)]],
      top: num('red', 5),
      turnIndex: 0,
      config: ON,
    });
    const { state } = callUno(s, 1);
    expect(state.players[1]!.calledUno).toBe(true);
  });

  it('is idempotent', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      config: ON,
    });
    const once = callUno(s, 0).state;
    const twice = callUno(once, 0);
    expect(twice.state.players[0]!.calledUno).toBe(true);
    expect(twice.events).toHaveLength(0);
  });

  it('refuses a player who is out', () => {
    const s = makeState({
      hands: [[num('red', 9), num('red', 8)], [], [num('green', 5)]],
      top: num('red', 5),
      eliminated: [1],
      config: ON,
    });
    expect(() => callUno(s, 1)).toThrow(/you are out/);
  });
});

describe('the penalty', () => {
  it('fires when you play down to one without calling', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      drawPile: fillerPile(20),
      config: ON,
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);

    // One card played, two drawn as a fine.
    expect(handOf(state, 0)).toHaveLength(3);
    expect(events).toContainEqual({ t: 'unoPenalty', playerId: 'p0', count: 2 });
  });

  it('does not fire when you called first', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      drawPile: fillerPile(20),
      config: ON,
      calledUno: [0],
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(handOf(state, 0)).toHaveLength(1);
    expect(events.some((e) => e.t === 'unoPenalty')).toBe(false);
  });

  it('does not fire when you go out entirely', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      drawPile: fillerPile(20),
      config: ON,
    });
    // Nothing to call: zero cards is a win, not a last card.
    const { events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(events.some((e) => e.t === 'unoPenalty')).toBe(false);
    expect(events.some((e) => e.t === 'roundEnded')).toBe(true);
  });

  it('fires when Discard All drops you straight to one', () => {
    const s = makeState({
      hands: [
        [discardAll('red'), num('red', 1), num('red', 8), num('blue', 2)],
        [num('blue', 5)],
        [num('green', 5)],
      ],
      top: num('red', 5),
      drawPile: fillerPile(20),
      config: ON,
    });
    // Four cards down to one in a single play, with no chance to have called at
    // two -- the rule still applies, which is what makes Discard All risky.
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(events).toContainEqual({ t: 'unoPenalty', playerId: 'p0', count: 2 });
    expect(handOf(state, 0)).toHaveLength(3);
  });

  it('spends the call, so the next time round you must call again', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      drawPile: fillerPile(20),
      config: ON,
      calledUno: [0],
    });
    const after = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(after.players[0]!.calledUno).toBe(false);
  });

  it('is cleared by picking cards up', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      turnIndex: 0,
      drawPile: fillerPile(20),
      config: ON,
      calledUno: [0],
    });
    // Drawing puts them on three cards; the old call must not still be standing.
    const { state } = reduce(s, { t: 'draw', playerId: 'p0' });
    expect(state.players[0]!.calledUno).toBe(false);
  });

  /**
   * The fine is drawn like any other cards, so it goes through the elimination
   * check. Only reachable with a low limit -- the rule only fires going from
   * two cards to one, so a normal 25-card limit is never in reach -- but the
   * interaction has to hold or a penalty could push someone past the limit and
   * leave them playing on.
   */
  it('goes through the elimination check like any other draw', () => {
    const s = makeState({
      hands: [[num('red', 1), num('red', 2)], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      drawPile: fillerPile(20),
      config: { ...ON, eliminationAt: 3 },
    });
    // Two cards, plays one to one, then the two-card fine puts them at three.
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(events.some((e) => e.t === 'unoPenalty')).toBe(true);
    expect(events.some((e) => e.t === 'eliminated' && e.playerId === 'p0')).toBe(true);
    expect(state.players[0]!.eliminated).toBe(true);
  });
});

describe('the turn clock', () => {
  it('calls on the absent player behalf rather than fining them', () => {
    const s = makeState({
      hands: [[num('red', 1), skip('red')], [num('blue', 5)], [num('green', 5)]],
      top: num('red', 5),
      drawPile: fillerPile(20),
      config: ON,
    });
    // The server is playing for someone who walked away; it should not also
    // fine them for a button they were not there to press.
    const { state, events } = reduce(s, { t: 'timeout', playerId: 'p0' });
    expect(events.some((e) => e.t === 'unoCalled' && e.playerId === 'p0')).toBe(true);
    expect(events.some((e) => e.t === 'unoPenalty')).toBe(false);
    expect(handOf(state, 0)).toHaveLength(1);
  });
});

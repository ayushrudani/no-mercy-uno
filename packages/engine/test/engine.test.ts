import { describe, expect, it } from 'vitest';
import { createGame, currentActorId, reduce, topCard } from '../src/engine.js';
import { redactFor } from '../src/redact.js';
import { IllegalMoveError, type Color, type GameState } from '../src/types.js';
import {
  discardAll,
  draw,
  fillerPile,
  handOf,
  makeState,
  num,
  rev,
  roulette,
  skip,
  skipAll,
  wildDraw,
  wildRevD4,
} from './helpers.js';

const play = (s: GameState, p: number, cardId: string, color?: Color) =>
  reduce(s, { t: 'play', playerId: `p${p}`, cardId, ...(color ? { color } : {}) });
const drawAct = (s: GameState, p: number) => reduce(s, { t: 'draw', playerId: `p${p}` });

describe('createGame', () => {
  it('deals seven cards to each player and opens on a number card', () => {
    const g = createGame(['a', 'b', 'c', 'd'], 42);
    for (const p of g.players) expect(p.hand).toHaveLength(7);
    expect(topCard(g).k).toBe('number');
    expect(g.turnIndex).toBe(0);
    expect(g.direction).toBe(1);
  });

  it('conserves all 168 cards across piles and hands', () => {
    const g = createGame(['a', 'b', 'c'], 7);
    const total = g.drawPile.length + g.discardPile.length + g.players.reduce((n, p) => n + p.hand.length, 0);
    expect(total).toBe(168);
  });

  it('is deterministic for a given seed', () => {
    const a = createGame(['a', 'b', 'c'], 999);
    const b = createGame(['a', 'b', 'c'], 999);
    expect(a).toEqual(b);
  });

  it('rejects player counts outside 2-8', () => {
    expect(() => createGame(['a'], 1)).toThrow();
    expect(() => createGame(Array.from({ length: 9 }, (_, i) => `p${i}`), 1)).toThrow();
  });
});

describe('basic turn flow', () => {
  it('passes the turn on after a number card', () => {
    const s = makeState({ hands: [[num('red', 3), num('yellow', 0)], [num('blue', 1)], [num('green', 1)]], top: num('red', 5) });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.turnIndex).toBe(1);
    expect(topCard(state).k).toBe('number');
    expect(state.activeColor).toBe('red');
  });

  it('refuses a play out of turn', () => {
    const s = makeState({ hands: [[num('red', 3)], [num('red', 1)], [num('green', 1)]], top: num('red', 5) });
    expect(() => play(s, 1, handOf(s, 1)[0]!.id)).toThrow(IllegalMoveError);
  });

  it('refuses an illegal card', () => {
    const s = makeState({ hands: [[num('blue', 3)], [num('red', 1)], [num('green', 1)]], top: num('red', 5) });
    expect(() => play(s, 0, handOf(s, 0)[0]!.id)).toThrow(/does not match/);
  });

  it('draws one and offers it when it is playable', () => {
    const s = makeState({
      hands: [[num('blue', 9)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [num('red', 7)],
    });
    const { state } = drawAct(s, 0);
    expect(handOf(state, 0)).toHaveLength(2);
    expect(state.phase.t).toBe('awaitingDrawnCardDecision');
    expect(state.turnIndex).toBe(0);
  });

  it('passes the turn when the drawn card is unplayable', () => {
    const s = makeState({
      hands: [[num('blue', 9)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [num('green', 8)],
    });
    const { state } = drawAct(s, 0);
    expect(state.turnIndex).toBe(1);
    expect(state.phase.t).toBe('awaitingPlay');
  });

  it('allows only the drawn card to be played after drawing', () => {
    const s = makeState({
      hands: [[num('red', 9)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [num('red', 7)],
    });
    const after = drawAct(s, 0).state;
    expect(() => play(after, 0, handOf(after, 0)[0]!.id)).toThrow(/only the card just drawn/);
  });

  it('lets a player pass after drawing', () => {
    const s = makeState({
      hands: [[num('blue', 9)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [num('red', 7)],
    });
    const after = drawAct(s, 0).state;
    const { state } = reduce(after, { t: 'pass', playerId: 'p0' });
    expect(state.turnIndex).toBe(1);
  });
});

describe('Skip and Reverse', () => {
  it('Skip jumps the next player', () => {
    const s = makeState({ hands: [[skip('red'), num('yellow', 0)], [num('red', 1)], [num('green', 1)]], top: num('red', 5) });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.turnIndex).toBe(2);
    expect(events).toContainEqual({ t: 'skipped', playerIds: ['p1'] });
  });

  it('Reverse flips direction with three or more players', () => {
    const s = makeState({ hands: [[rev('red'), num('yellow', 0)], [num('red', 1)], [num('green', 1)]], top: num('red', 5) });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.direction).toBe(-1);
    expect(state.turnIndex).toBe(2);
  });

  it('Reverse acts as a Skip in a two-player game', () => {
    const s = makeState({ hands: [[rev('red'), num('red', 2)], [num('red', 1)]], top: num('red', 5) });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.turnIndex).toBe(0);
  });

  it('Skip Everyone returns the turn to the player who threw it', () => {
    const s = makeState({
      hands: [[skipAll('red'), num('red', 2)], [num('red', 1)], [num('green', 1)], [num('red', 4)]],
      top: num('red', 5),
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.turnIndex).toBe(0);
    expect(events).toContainEqual({ t: 'skipped', playerIds: ['p1', 'p2', 'p3'] });
  });
});

describe('Discard All', () => {
  it('sheds every card of that colour in one play', () => {
    const s = makeState({
      hands: [
        [discardAll('red'), num('red', 1), num('red', 8), num('blue', 2), wildDraw(6)],
        [num('red', 1)],
        [num('green', 1)],
      ],
      top: num('red', 5),
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(handOf(state, 0).map((c) => c.k)).toEqual(['number', 'wildDraw']);
    expect(handOf(state, 0)[0]).toMatchObject({ color: 'blue' });
    expect(events).toContainEqual({ t: 'discardedAll', playerId: 'p0', color: 'red', count: 2 });
  });

  it('leaves the Discard All itself on top so the colour stays put', () => {
    const s = makeState({
      hands: [[discardAll('red'), num('red', 1), num('blue', 2)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(topCard(state).k).toBe('discardAll');
    expect(state.activeColor).toBe('red');
  });

  it('can take first place outright', () => {
    const s = makeState({
      hands: [
        [discardAll('red'), num('red', 1)],
        [num('red', 1), num('red', 8)],
        [num('green', 1), num('green', 9)],
      ],
      top: num('red', 5),
    });
    const { events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(events).toContainEqual({ t: 'playerFinished', playerId: 'p0', place: 1 });
  });
});

describe('draw stacking', () => {
  it('accumulates and raises the tier', () => {
    const s = makeState({
      hands: [
        [draw('red', 2), num('yellow', 0)],
        [draw('blue', 4), num('yellow', 0)],
        [wildDraw(10), num('yellow', 0)],
      ],
      top: num('red', 5),
    });
    let st = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(st.pendingDraw).toBe(2);
    expect(st.pendingTier).toBe(2);
    expect(st.turnIndex).toBe(1);

    st = play(st, 1, handOf(st, 1)[0]!.id).state;
    expect(st.pendingDraw).toBe(6);
    expect(st.pendingTier).toBe(4);
    expect(st.turnIndex).toBe(2);

    st = play(st, 2, handOf(st, 2)[0]!.id, 'green').state;
    expect(st.pendingDraw).toBe(16);
    expect(st.pendingTier).toBe(10);
  });

  it('refuses a lower-value stack card', () => {
    const s = makeState({
      hands: [[num('red', 1)], [draw('blue', 2)], [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 4,
      pendingTier: 4,
    });
    expect(() => play(s, 1, handOf(s, 1)[0]!.id)).toThrow(/only \+4 or higher/);
  });

  it('makes the player who breaks the chain eat the whole pile', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 9)], [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 16,
      pendingTier: 10,
      drawPile: fillerPile(30),
    });
    const { state, events } = drawAct(s, 1);
    expect(handOf(state, 1)).toHaveLength(17);
    expect(state.pendingDraw).toBe(0);
    expect(state.pendingTier).toBe(0);
    expect(state.turnIndex).toBe(2);
    expect(events).toContainEqual({ t: 'drew', playerId: 'p1', count: 16, reason: 'stack' });
  });
});

describe('Wild Reverse Draw 4', () => {
  it('reverses and hits the new next player for four', () => {
    const s = makeState({
      hands: [[wildRevD4(), num('yellow', 0)], [num('red', 1)], [num('green', 1)], [num('red', 4)]],
      top: num('red', 5),
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id, 'green');
    expect(state.direction).toBe(-1);
    expect(state.activeColor).toBe('green');
    expect(state.pendingDraw).toBe(4);
    expect(state.pendingTier).toBe(4);
    // Direction is now anticlockwise, so the target is seat 3.
    expect(state.turnIndex).toBe(3);
  });

  it('two players: the +4 bounces straight back at whoever threw it', () => {
    const s = makeState({ hands: [[wildRevD4(), num('red', 2)], [num('red', 1)]], top: num('red', 5) });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id, 'blue');
    expect(state.turnIndex).toBe(0);
    expect(state.pendingDraw).toBe(4);
  });

  it('two players: the thrower can stack again to redirect it', () => {
    const s = makeState({
      hands: [[wildRevD4(), wildDraw(6), num('yellow', 0)], [num('red', 1)]],
      top: num('red', 5),
    });
    const first = play(s, 0, handOf(s, 0)[0]!.id, 'blue').state;
    expect(first.turnIndex).toBe(0);
    const second = play(first, 0, handOf(first, 0)[0]!.id, 'green').state;
    expect(second.pendingDraw).toBe(10);
    expect(second.turnIndex).toBe(1);
  });
});

describe('Wild Color Roulette', () => {
  it('hands the colour choice to the target and stops the turn there', () => {
    const s = makeState({
      hands: [[roulette(), num('red', 2)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.phase).toEqual({ t: 'awaitingRouletteColor', targetId: 'p1' });
    expect(currentActorId(state)).toBe('p1');
  });

  it('draws until the named colour appears, keeping everything revealed', () => {
    const s = makeState({
      hands: [[roulette(), num('red', 2)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      // popped from the end: blue, blue, wild, GREEN -> stops on green, 4 kept
      drawPile: [num('green', 7), wildDraw(6), num('blue', 2), num('blue', 4)],
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    const { state, events } = reduce(mid, { t: 'chooseRouletteColor', playerId: 'p1', color: 'green' });
    expect(handOf(state, 1)).toHaveLength(5);
    expect(state.activeColor).toBe('green');
    expect(events).toContainEqual({ t: 'drew', playerId: 'p1', count: 4, reason: 'roulette' });
  });

  it('forfeits the target turn, passing play to the seat after them', () => {
    const s = makeState({
      hands: [[roulette(), num('red', 2)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [num('green', 7)],
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    const { state } = reduce(mid, { t: 'chooseRouletteColor', playerId: 'p1', color: 'green' });
    expect(state.turnIndex).toBe(2);
    expect(state.phase.t).toBe('awaitingPlay');
  });

  it('cannot be played onto a pending stack', () => {
    const s = makeState({
      hands: [[num('red', 1)], [roulette()], [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 2,
      pendingTier: 2,
    });
    expect(() => play(s, 1, handOf(s, 1)[0]!.id)).toThrow(IllegalMoveError);
  });

  it('does not let the target stack a draw card in response', () => {
    const s = makeState({
      hands: [[roulette(), num('red', 2)], [wildDraw(10)], [num('green', 1)]],
      top: num('red', 5),
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    expect(() => play(mid, 1, handOf(mid, 1)[0]!.id, 'red')).toThrow(/colour must be named/);
  });

  it('lets the player pick instead when the room flips the flag', () => {
    const s = makeState({
      hands: [[roulette(), num('red', 2)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [num('blue', 7)],
      config: { rouletteColorChosenBy: 'player' },
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id, 'blue');
    expect(state.phase.t).toBe('awaitingPlay');
    expect(state.activeColor).toBe('blue');
    expect(handOf(state, 1)).toHaveLength(2);
  });
});

describe('elimination at 25 cards', () => {
  it('eliminates a player whose hand reaches the limit and recycles it', () => {
    const s = makeState({
      hands: [[num('red', 1)], Array.from({ length: 20 }, () => num('blue', 9)), [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 6,
      pendingTier: 6,
      drawPile: fillerPile(40),
      config: { eliminationAt: 25 },
    });
    const { state, events } = drawAct(s, 1);
    expect(state.players[1]!.eliminated).toBe(true);
    expect(handOf(state, 1)).toHaveLength(0);
    expect(events.some((e) => e.t === 'eliminated' && e.playerId === 'p1')).toBe(true);
    expect(state.turnIndex).not.toBe(1);
  });

  it('ends the game when only one player is left standing', () => {
    const s = makeState({
      hands: [[num('red', 1)], Array.from({ length: 24 }, () => num('blue', 9))],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 2,
      pendingTier: 2,
      drawPile: fillerPile(10),
      config: { eliminationAt: 25 },
    });
    const { state, events } = drawAct(s, 1);
    expect(state.phase.t).toBe('gameOver');
    expect(state.winnerId).toBe('p0');
    expect(events).toContainEqual({ t: 'gameEnded', winnerId: 'p0' });
  });

  it('skips eliminated seats when passing the turn', () => {
    const s = makeState({
      hands: [[num('red', 1), num('yellow', 0)], [], [num('green', 1)]],
      top: num('red', 5),
      eliminated: [1],
    });
    const { state } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(state.turnIndex).toBe(2);
  });
});

describe('rounds', () => {
  it('places the player who goes out and leaves everyone else mid-hand', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 2), num('blue', 8)], [num('green', 3), num('green', 9)]],
      top: num('red', 5),
    });
    const { state, events } = play(s, 0, handOf(s, 0)[0]!.id);
    expect(events).toContainEqual({ t: 'playerFinished', playerId: 'p0', place: 1 });
    // One deal only: the survivors keep the cards they were holding.
    expect(state.round).toBe(1);
    expect(handOf(state, 1)).toHaveLength(2);
    expect(handOf(state, 2)).toHaveLength(2);
  });
});

describe('reshuffling', () => {
  it('recycles the discard pile when the draw pile runs out', () => {
    const s = makeState({
      hands: [[num('blue', 9)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [],
    });
    s.discardPile = [num('green', 1), num('yellow', 2), num('blue', 3), num('red', 5)];
    const { state, events } = drawAct(s, 0);
    expect(events.some((e) => e.t === 'reshuffled')).toBe(true);
    expect(state.discardPile).toHaveLength(1);
    expect(handOf(state, 0)).toHaveLength(2);
  });
});

describe('timeout auto-play', () => {
  it('eats a pending stack rather than freezing the table', () => {
    const s = makeState({
      hands: [[num('red', 1)], [num('blue', 9)], [num('green', 1)]],
      top: num('red', 5),
      turnIndex: 1,
      pendingDraw: 6,
      pendingTier: 6,
      drawPile: fillerPile(20),
    });
    const { state } = reduce(s, { t: 'timeout', playerId: 'p1' });
    expect(handOf(state, 1)).toHaveLength(7);
    expect(state.turnIndex).toBe(2);
  });

  it('sheds the cheapest legal card and holds the good ones back', () => {
    const s = makeState({
      hands: [[wildDraw(10), num('red', 3), skip('red')], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
    });
    const { state } = reduce(s, { t: 'timeout', playerId: 'p0' });
    expect(topCard(state)).toMatchObject({ k: 'number', n: 3 });
    expect(handOf(state, 0).map((c) => c.k).sort()).toEqual(['skip', 'wildDraw']);
  });

  it('draws when nothing is legal', () => {
    const s = makeState({
      hands: [[num('blue', 9)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: [num('green', 8)],
    });
    const { state } = reduce(s, { t: 'timeout', playerId: 'p0' });
    expect(handOf(state, 0)).toHaveLength(2);
    expect(state.turnIndex).toBe(1);
  });

  it('names a colour for a stalled Color Roulette', () => {
    const s = makeState({
      hands: [[roulette(), num('red', 2)], [num('blue', 1), num('blue', 4)], [num('green', 1)]],
      top: num('red', 5),
      drawPile: fillerPile(10, 'blue'),
    });
    const mid = play(s, 0, handOf(s, 0)[0]!.id).state;
    const { state } = reduce(mid, { t: 'timeout', playerId: 'p1' });
    expect(state.activeColor).toBe('blue');
    expect(state.phase.t).toBe('awaitingPlay');
  });
});

describe('redaction', () => {
  it('shows a player their own hand and only counts for everyone else', () => {
    const g = createGame(['a', 'b', 'c'], 5);
    const view = redactFor(g, 'b');
    expect(view.you?.hand).toHaveLength(7);
    expect(view.players.map((p) => p.cardCount)).toEqual([7, 7, 7]);
    expect(JSON.stringify(view)).not.toContain('"drawPile"');
    const leaked = view.players as unknown as Array<Record<string, unknown>>;
    for (const p of leaked) expect(p['hand']).toBeUndefined();
  });

  it('gives a spectator no hand at all', () => {
    const g = createGame(['a', 'b'], 5);
    const view = redactFor(g, null);
    expect(view.you).toBeNull();
  });

  it('marks playable cards for the player to act', () => {
    const s = makeState({
      hands: [[num('red', 1), num('blue', 9), wildDraw(6)], [num('red', 1)], [num('green', 1)]],
      top: num('red', 5),
    });
    const view = redactFor(s, 'p0');
    expect(view.you?.playableCardIds).toHaveLength(2);
    expect(redactFor(s, 'p1').you?.playableCardIds).toHaveLength(0);
  });
});

describe('purity', () => {
  it('never mutates the state passed in', () => {
    const g = createGame(['a', 'b', 'c'], 77);
    const snapshot = structuredClone(g);
    reduce(g, { t: 'timeout', playerId: 'a' });
    expect(g).toEqual(snapshot);
  });
});

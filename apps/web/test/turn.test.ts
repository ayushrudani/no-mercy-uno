/**
 * Every one of these is really the same assertion: a control only appears for
 * the player it belongs to. `phase` is global to the table, so any check that
 * looks at phase alone leaks a button to everyone.
 */

import { describe, expect, it } from 'vitest';
import type { Card, PlayerGameView } from '@nmu/shared';
import { turnActions } from '../src/lib/turn.js';

const card = (id: string): Card => ({ id, k: 'number', color: 'red', n: 5 });

function view(over: Partial<PlayerGameView> = {}): PlayerGameView {
  return {
    you: {
      id: 'me',
      hand: [card('c1'), card('c2')],
      playableCardIds: ['c1'],
      eliminated: false,
      calledUno: false,
      canCallUno: false,
    },
    players: [
      { id: 'me', cardCount: 2, eliminated: false, roundsWon: 0, calledUno: false },
      { id: 'them', cardCount: 5, eliminated: false, roundsWon: 0, calledUno: false },
    ],
    seats: ['me', 'them'],
    turnPlayerId: 'me',
    direction: 1,
    top: card('top'),
    activeColor: 'red',
    drawPileCount: 100,
    discardPileCount: 3,
    pendingDraw: 0,
    pendingTier: 0,
    phase: { t: 'awaitingPlay' },
    round: 1,
    winnerId: null,
    ...over,
  };
}

describe('on your own turn', () => {
  it('offers draw and lists your playable cards', () => {
    const a = turnActions(view(), 'me');
    expect(a.isMyTurn).toBe(true);
    expect(a.canDraw).toBe(true);
    expect([...a.playableIds]).toEqual(['c1']);
    expect(a.drawLabel).toBe('Draw');
  });

  it('renames the draw button when a stack is pending', () => {
    const a = turnActions(view({ pendingDraw: 16, pendingTier: 10 }), 'me');
    expect(a.drawLabel).toBe('Take 16');
  });

  it('offers pass only after you have drawn', () => {
    expect(turnActions(view(), 'me').mustDecideDrawn).toBe(false);
    const drawn = view({ phase: { t: 'awaitingDrawnCardDecision', cardId: 'c2' } });
    expect(turnActions(drawn, 'me').mustDecideDrawn).toBe(true);
  });
});

describe('on someone else\'s turn', () => {
  it('offers nothing', () => {
    const a = turnActions(view({ turnPlayerId: 'them' }), 'me');
    expect(a.isMyTurn).toBe(false);
    expect(a.canDraw).toBe(false);
    expect(a.mustDecideDrawn).toBe(false);
    expect(a.playableIds.size).toBe(0);
  });

  /**
   * The regression. `awaitingDrawnCardDecision` is a property of the table, not
   * of a player: when an opponent drew, every client showed a Pass button that
   * sent a move the server was bound to reject.
   */
  it('does NOT offer pass when the OTHER player is the one deciding', () => {
    const a = turnActions(
      view({ turnPlayerId: 'them', phase: { t: 'awaitingDrawnCardDecision', cardId: 'x' } }),
      'me',
    );
    expect(a.mustDecideDrawn).toBe(false);
  });

  it('does not light up cards just because they are legal for you in principle', () => {
    const a = turnActions(view({ turnPlayerId: 'them' }), 'me');
    expect(a.playableIds.size).toBe(0);
  });
});

describe('Color Roulette', () => {
  it('asks only the target for a colour', () => {
    const pending = view({
      turnPlayerId: 'them',
      phase: { t: 'awaitingRouletteColor', targetId: 'me' },
    });
    expect(turnActions(pending, 'me').mustNameRouletteColor).toBe(true);
    expect(turnActions(pending, 'them').mustNameRouletteColor).toBe(false);
  });

  it('does not offer draw while a roulette is unresolved', () => {
    const pending = view({ phase: { t: 'awaitingRouletteColor', targetId: 'me' } });
    expect(turnActions(pending, 'me').canDraw).toBe(false);
  });
});

describe('the UNO button', () => {
  /**
   * The whole point: you press it *before* playing your second-to-last card,
   * which is usually while somebody else is still moving. Gating it on your
   * turn would make the rule impossible to satisfy.
   */
  it('shows regardless of whose turn it is', () => {
    const armed = {
      id: 'me',
      hand: [card('c1'), card('c2')],
      playableCardIds: [],
      eliminated: false,
      calledUno: false,
      canCallUno: true,
    };
    expect(turnActions(view({ you: armed }), 'me').canCallUno).toBe(true);
    expect(turnActions(view({ you: armed, turnPlayerId: 'them' }), 'me').canCallUno).toBe(true);
  });

  it('follows the server, which is the only thing that knows the rule is on', () => {
    expect(turnActions(view(), 'me').canCallUno).toBe(false);
  });

  it('is off for a spectator with no seat', () => {
    expect(turnActions(view({ you: null, turnPlayerId: 'them' }), 'watcher').canCallUno).toBe(false);
  });
});

describe('spectators', () => {
  it('treats an eliminated player as a spectator', () => {
    const out = view({
      you: { id: 'me', hand: [], playableCardIds: [], eliminated: true, calledUno: false, canCallUno: false },
      turnPlayerId: 'them',
    });
    expect(turnActions(out, 'me').isSpectator).toBe(true);
  });

  it('treats a viewer with no seat as a spectator', () => {
    expect(turnActions(view({ you: null, turnPlayerId: 'them' }), 'watcher').isSpectator).toBe(true);
  });
});

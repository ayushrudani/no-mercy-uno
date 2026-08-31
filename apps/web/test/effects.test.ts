/**
 * The event -> sound/banner mapping.
 *
 * These matter because the banner is framed from the viewer's perspective: the
 * same +10 is a disaster or a gift depending on who it landed on, and getting
 * that backwards is the kind of thing nobody notices until mid-game.
 */

import { describe, expect, it } from 'vitest';
import type { Card, GameEvent } from '@nmu/shared';
import { effectFor } from '../src/lib/effects.js';

const ME = 'me';
const name = (id: string) => (id === 'them' ? 'Rohit' : 'Ayush');
const of = (e: GameEvent) => effectFor(e, ME, name);

const num: Card = { id: 'n', k: 'number', color: 'red', n: 5 };
const wildDraw10: Card = { id: 'w', k: 'wildDraw', amount: 10 };
const wildDraw6: Card = { id: 'w6', k: 'wildDraw', amount: 6 };
const draw2: Card = { id: 'd2', k: 'draw', color: 'red', amount: 2 };
const revD4: Card = { id: 'r4', k: 'wildReverseDraw4' };
const skipAll: Card = { id: 's', k: 'skipEveryone', color: 'blue' };
const discardAll: Card = { id: 'da', k: 'discardAll', color: 'green' };
const roulette: Card = { id: 'ro', k: 'wildColorRoulette' };

describe('playing a card', () => {
  it('gives a plain number a flip and no banner', () => {
    const r = of({ t: 'played', playerId: ME, card: num });
    expect(r.sound).toBe('flip');
    expect(r.moment).toBeNull();
  });

  it('slams for +6 and +10 but not for smaller draws', () => {
    expect(of({ t: 'played', playerId: 'them', card: wildDraw10 }).sound).toBe('slam');
    expect(of({ t: 'played', playerId: 'them', card: wildDraw6 }).sound).toBe('slam');
    expect(of({ t: 'played', playerId: 'them', card: draw2 }).sound).toBe('flip');
    // Reverse Draw 4 is only +4, so it stays under the slam threshold.
    expect(of({ t: 'played', playerId: 'them', card: revD4 }).sound).toBe('flip');
  });

  it('names who threw a big draw when it was not you', () => {
    const r = of({ t: 'played', playerId: 'them', card: wildDraw10 });
    expect(r.moment).toMatchObject({ text: '+10', sub: 'from Rohit', tone: 'danger' });
  });

  it('says so when the big draw was yours', () => {
    const r = of({ t: 'played', playerId: ME, card: wildDraw10 });
    expect(r.moment?.sub).toBe('you dropped it');
  });

  it('announces Skip Everyone and Discard All', () => {
    expect(of({ t: 'played', playerId: 'them', card: skipAll }).moment?.text).toBe('SKIP EVERYONE');
    const da = of({ t: 'played', playerId: ME, card: discardAll });
    expect(da.moment).toMatchObject({ text: 'DISCARD ALL', sub: 'every green card gone' });
  });

  it('flags Color Roulette as danger', () => {
    expect(of({ t: 'played', playerId: 'them', card: roulette }).moment).toMatchObject({
      text: 'COLOR ROULETTE',
      tone: 'danger',
    });
  });
});

describe('eating a stack', () => {
  it('is a disaster when it is you', () => {
    const r = of({ t: 'drew', playerId: ME, count: 16, reason: 'stack' });
    expect(r.moment).toMatchObject({ text: '+16', sub: 'you take the stack', tone: 'danger' });
  });

  it('is good news when it is someone else', () => {
    const r = of({ t: 'drew', playerId: 'them', count: 16, reason: 'stack' });
    expect(r.moment).toMatchObject({ text: '+16', sub: 'Rohit takes the stack', tone: 'good' });
  });

  it('stays quiet for an ordinary one-card draw', () => {
    const r = of({ t: 'drew', playerId: ME, count: 1, reason: 'turn' });
    expect(r.sound).toBe('draw');
    expect(r.moment).toBeNull();
  });
});

describe('elimination and endings', () => {
  it('addresses you directly when you are knocked out', () => {
    const r = of({ t: 'eliminated', playerId: ME, handSize: 25 });
    expect(r.moment).toMatchObject({ text: 'YOU ARE OUT', sub: '25 cards', tone: 'danger' });
    expect(r.sound).toBe('eliminate');
  });

  it('names the victim otherwise, and reads it as good for you', () => {
    const r = of({ t: 'eliminated', playerId: 'them', handSize: 26 });
    expect(r.moment).toMatchObject({ text: 'Rohit IS OUT', tone: 'good' });
  });

  it('plays a fanfare when the game ends', () => {
    expect(of({ t: 'gameEnded', winnerId: ME }).sound).toBe('win');
  });

  it('marks a round you went out on as good', () => {
    expect(of({ t: 'roundEnded', winnerId: ME }).moment).toMatchObject({
      text: 'YOU WENT OUT',
      tone: 'good',
    });
  });
});

describe('quiet events', () => {
  it('produces nothing for bookkeeping the player does not need to see', () => {
    expect(of({ t: 'colorChosen', playerId: ME, color: 'red' })).toEqual({ sound: null, moment: null });
    expect(of({ t: 'turnPassed', playerId: ME })).toEqual({ sound: null, moment: null });
  });

  it('still makes a sound for shuffles and skips, without a banner', () => {
    expect(of({ t: 'reshuffled', count: 40 })).toMatchObject({ sound: 'shuffle', moment: null });
    expect(of({ t: 'skipped', playerIds: ['them'] })).toMatchObject({ sound: 'skip', moment: null });
  });
});

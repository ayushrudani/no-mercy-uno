/**
 * Turns the server's narration into sound and on-screen moments.
 *
 * The engine already emits exactly the events worth reacting to, so this is a
 * pure mapping rather than a second interpretation of the rules. Anything the
 * player should notice -- a Draw 10 landing, someone knocked out, direction
 * flipping -- has an event; if a moment needs a new effect, the engine should
 * emit for it rather than this file inferring it from state diffs.
 */

import { useEffect, useRef, useState } from 'react';
import type { GameEvent } from '@nmu/shared';
import { sound, type SoundName } from './sound.js';

export interface Moment {
  id: number;
  text: string;
  sub?: string;
  tone: 'neutral' | 'danger' | 'good';
  /** Milliseconds to stay on screen. Defaults to MOMENT_MS. */
  hold?: number;
}

/** Draw cards worth this much or more get the full slam treatment. */
const BIG_DRAW = 6;

export interface EffectResult {
  sound: SoundName | null;
  moment: Omit<Moment, 'id'> | null;
}

export function effectFor(e: GameEvent, myId: string, nameOf: (id: string) => string): EffectResult {
  switch (e.t) {
    case 'roundStarted':
      return { sound: 'deal', moment: null };

    case 'played': {
      const c = e.card;
      const mine = e.playerId === myId;

      if (c.k === 'skipEveryone') {
        return {
          sound: 'skip',
          moment: { text: 'SKIP EVERYONE', sub: `${nameOf(e.playerId)} goes again`, tone: 'neutral' },
        };
      }
      if (c.k === 'discardAll') {
        return {
          sound: 'flip',
          moment: { text: 'DISCARD ALL', sub: `every ${c.color} card gone`, tone: 'good' },
        };
      }
      if (c.k === 'wildColorRoulette') {
        return { sound: 'stack', moment: { text: 'COLOR ROULETTE', tone: 'danger' } };
      }

      const value = c.k === 'draw' || c.k === 'wildDraw' ? c.amount : c.k === 'wildReverseDraw4' ? 4 : 0;
      if (value >= BIG_DRAW) {
        return {
          sound: 'slam',
          // Framed from the victim's side: "+10" is only dramatic if you know
          // whether it is aimed at you.
          moment: { text: `+${value}`, sub: mine ? 'you dropped it' : `from ${nameOf(e.playerId)}`, tone: 'danger' },
        };
      }
      return { sound: 'flip', moment: null };
    }

    case 'drew':
      if (e.reason === 'stack') {
        return {
          sound: 'slam',
          moment: {
            text: `+${e.count}`,
            sub: `${e.playerId === myId ? 'you take' : `${nameOf(e.playerId)} takes`} the stack`,
            tone: e.playerId === myId ? 'danger' : 'good',
          },
        };
      }
      if (e.reason === 'roulette') {
        return {
          sound: 'draw',
          moment: { text: `+${e.count}`, sub: 'roulette', tone: e.playerId === myId ? 'danger' : 'good' },
        };
      }
      return { sound: 'draw', moment: null };

    case 'stackGrew':
      return { sound: 'stack', moment: null };

    case 'skipped':
      return { sound: 'skip', moment: null };

    case 'reversed':
      return { sound: 'reverse', moment: { text: e.direction === 1 ? '↻' : '↺', sub: 'reversed', tone: 'neutral' } };

    case 'discardedAll':
      return { sound: 'flip', moment: null };

    case 'reshuffled':
      return { sound: 'shuffle', moment: null };

    /**
     * The cards ran out and another deck joined the game. Worth saying out
     * loud: the alternative reading is that something went wrong.
     */
    case 'deckExtended':
      return {
        sound: 'shuffle',
        moment: {
          text: 'New deck shuffled in',
          sub: `${e.decks} decks in play`,
          tone: 'neutral',
        },
      };

    case 'handsSwapped': {
      const mine = e.playerId === myId;
      const theirs = e.targetId === myId;
      if (!mine && !theirs) {
        return {
          sound: 'swap',
          moment: {
            text: 'HANDS SWAPPED',
            sub: `${nameOf(e.playerId)} ↔ ${nameOf(e.targetId)}`,
            tone: 'neutral',
          },
        };
      }
      // Framed by what it did to your hand: taking 9 cards for 1 is a disaster
      // even though the event itself is neutral.
      const gained = mine ? e.gained : e.lost;
      const lost = mine ? e.lost : e.gained;
      const other = mine ? e.targetId : e.playerId;
      return {
        sound: 'swap',
        moment: {
          text: gained > lost ? `+${gained - lost}` : `−${lost - gained}`,
          sub: `swapped with ${nameOf(other)}`,
          tone: gained > lost ? 'danger' : 'good',
        },
      };
    }

    case 'unoCalled':
      return {
        sound: 'uno',
        moment: {
          text: 'UNO!',
          sub: e.playerId === myId ? 'called' : nameOf(e.playerId),
          tone: e.playerId === myId ? 'good' : 'danger',
        },
      };

    case 'unoPenalty':
      return {
        sound: 'slam',
        moment: {
          text: `+${e.count}`,
          sub: e.playerId === myId ? 'you forgot to call UNO' : `${nameOf(e.playerId)} forgot UNO`,
          tone: e.playerId === myId ? 'danger' : 'good',
        },
      };

    case 'handsRotated':
      return {
        sound: 'swap',
        moment: {
          text: 'EVERYONE SWAPS',
          sub: e.direction === 1 ? 'hands pass left' : 'hands pass right',
          tone: 'neutral',
        },
      };

    case 'eliminated':
      return {
        sound: 'eliminate',
        moment: {
          text: e.playerId === myId ? 'YOU ARE OUT' : `${nameOf(e.playerId)} IS OUT`,
          sub: `${e.handSize} cards`,
          tone: e.playerId === myId ? 'danger' : 'good',
        },
      };

    case 'roundStalemate':
      return {
        sound: 'shuffle',
        moment: { text: 'STALEMATE', sub: 'deck ran dry — redealing', tone: 'neutral' },
      };

    case 'playerFinished': {
      const ordinal = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'][e.place] ?? `#${e.place}`;
      const mine = e.playerId === myId;
      return {
        sound: e.place === 1 ? 'win' : 'round',
        moment: {
          text: mine ? `YOU FINISHED ${ordinal}` : `${nameOf(e.playerId)} — ${ordinal}`,
          // Spelled out because going out and then watching reads as being
          // kicked unless it is clear you have banked a place.
          sub: mine ? 'you are done — others play on' : 'out of cards',
          tone: mine ? 'good' : 'neutral',
          hold: e.place === 1 ? 2600 : 1800,
        },
      };
    }

    case 'gameEnded':
      return { sound: 'win', moment: null };

    case 'colorChosen':
    case 'turnPassed':
      return { sound: null, moment: null };
  }
}

const MOMENT_MS = 1600;

/**
 * Consume new events, play their sounds, and surface the most recent one worth
 * showing. Returns the moment to render, or null.
 */
export function useGameEffects(
  events: { id: number; e: GameEvent }[],
  myId: string,
  nameOf: (id: string) => string,
): Moment | null {
  const seenUpTo = useRef(0);
  const [moment, setMoment] = useState<Moment | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // nameOf changes identity every render; keeping it in a ref avoids making it
  // an effect dependency, which would replay effects on unrelated updates.
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;

  useEffect(() => {
    const fresh = events.filter((x) => x.id > seenUpTo.current);
    if (fresh.length === 0) return;
    seenUpTo.current = events[events.length - 1]!.id;

    let latest: Moment | null = null;
    for (const { id, e } of fresh) {
      const { sound: s, moment: m } = effectFor(e, myId, nameRef.current);
      if (s) sound.play(s);
      if (m) latest = { id, ...m };
    }

    if (latest) {
      setMoment(latest);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMoment(null), latest.hold ?? MOMENT_MS);
    }
  }, [events, myId]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return moment;
}

/** A soft chime the first time a turn becomes yours, and not on every re-render. */
export function useTurnChime(isMyTurn: boolean): void {
  const was = useRef(false);
  useEffect(() => {
    if (isMyTurn && !was.current) sound.play('turn');
    was.current = isMyTurn;
  }, [isMyTurn]);
}

/**
 * Test scaffolding: build a fully-controlled GameState so a rule can be
 * exercised in isolation, without dealing a real hand and hoping the right
 * cards show up.
 */

import { makeConfig } from '../src/config.js';
import { buildDeck } from '../src/deck.js';
import type { Card, Color, Digit, GameConfig, GameState, PlayerState } from '../src/types.js';

let uid = 0;
const nextId = (p: string) => `${p}~t${uid++}`;

// Card constructors -------------------------------------------------------

export const num = (color: Color, n: Digit): Card => ({ id: nextId(`${color}${n}`), k: 'number', color, n });
export const draw = (color: Color, amount: 2 | 4): Card => ({ id: nextId(`${color}d${amount}`), k: 'draw', color, amount });
export const skip = (color: Color): Card => ({ id: nextId(`${color}skip`), k: 'skip', color });
export const skipAll = (color: Color): Card => ({ id: nextId(`${color}skipall`), k: 'skipEveryone', color });
export const rev = (color: Color): Card => ({ id: nextId(`${color}rev`), k: 'reverse', color });
export const discardAll = (color: Color): Card => ({ id: nextId(`${color}disall`), k: 'discardAll', color });
export const wildRevD4 = (): Card => ({ id: nextId('wrd4'), k: 'wildReverseDraw4' });
export const wildDraw = (amount: 6 | 10): Card => ({ id: nextId(`wd${amount}`), k: 'wildDraw', amount });
export const roulette = (): Card => ({ id: nextId('wroul'), k: 'wildColorRoulette' });

// State builder -----------------------------------------------------------

export interface StateSpec {
  hands: Card[][];
  top: Card;
  activeColor?: Color;
  turnIndex?: number;
  direction?: 1 | -1;
  pendingDraw?: number;
  pendingTier?: GameState['pendingTier'];
  drawPile?: Card[];
  eliminated?: number[];
  /** Seats that have already pressed UNO. */
  calledUno?: number[];
  /** Finishing positions, indexed by seat. */
  places?: (number | null)[];
  config?: Partial<GameConfig>;
  seed?: number;
}

/** A deck with all of `exclude` removed, so drawn cards are predictable-ish. */
export function fillerPile(size: number, color: Color = 'blue'): Card[] {
  return Array.from({ length: size }, () => num(color, 3));
}

export function makeState(spec: StateSpec): GameState {
  const players: PlayerState[] = spec.hands.map((hand, i) => ({
    id: `p${i}`,
    hand,
    eliminated: spec.eliminated?.includes(i) ?? false,
    place: spec.places?.[i] ?? null,
    calledUno: spec.calledUno?.includes(i) ?? false,
  }));

  const activeColor =
    spec.activeColor ?? ('color' in spec.top ? (spec.top as { color: Color }).color : 'red');

  return {
    players,
    turnIndex: spec.turnIndex ?? 0,
    direction: spec.direction ?? 1,
    drawPile: spec.drawPile ?? buildDeck(),
    discardPile: [spec.top],
    activeColor,
    pendingDraw: spec.pendingDraw ?? 0,
    pendingTier: spec.pendingTier ?? 0,
    phase: { t: 'awaitingPlay' },
    rngState: spec.seed ?? 12345,
    round: 1,
    winnerId: null,
    config: makeConfig(spec.config ?? {}),
  };
}

export const handOf = (s: GameState, i: number) => s.players[i]!.hand;
export const idsOf = (cards: readonly Card[]) => cards.map((c) => c.id);

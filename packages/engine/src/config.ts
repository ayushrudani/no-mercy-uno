import type { GameConfig } from './types.js';

/**
 * Defaults for the rules the official rulebook leaves open. Each one is a
 * judgement call, documented in docs/PLAN.md section 11; a room can override any
 * of them without touching engine code.
 */
export const DEFAULT_CONFIG: GameConfig = {
  handSize: 7,
  // The official rule. Rooms can set this to 0 and use roundsToWin instead,
  // which is kinder when one bad hand would otherwise bench a friend for the
  // rest of the evening.
  eliminationAt: 25,
  roundsToWin: 0,
  stackRequiresColorMatch: false,
  rouletteColorChosenBy: 'target',
  openingMustBeNumber: true,
  drawOneThenPlay: true,
  // Off here so the engine models official No Mercy; rooms turn it on, and this
  // project's default room settings do.
  unoCall: false,
  unoPenalty: 2,
  // Off by default because it is not an official No Mercy rule; rooms turn it
  // on, and this project's default room settings do.
  sevenZero: false,
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

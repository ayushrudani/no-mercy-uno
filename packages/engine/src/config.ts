import type { GameConfig } from './types.js';

/**
 * Defaults for the rules the official rulebook leaves open. Each one is a
 * judgement call, documented in docs/PLAN.md section 11; a room can override any
 * of them without touching engine code.
 */
export const DEFAULT_CONFIG: GameConfig = {
  handSize: 7,
  // Off by default. Going out is how you win; knock-out is an extra house
  // rule for groups who want the 25-card cliff as well.
  eliminationAt: 0,
  dealOnce: true,
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

/**
 * Core types for UNO Show 'Em No Mercy.
 *
 * Everything here is plain data. The engine never imports a socket, a clock or
 * a random source -- randomness lives in `GameState.rng` as a seeded integer,
 * which is what makes a whole game reproducible from (seed, actions[]).
 */

export type Color = 'red' | 'yellow' | 'green' | 'blue';

export const COLORS: readonly Color[] = ['red', 'yellow', 'green', 'blue'] as const;

/** Values that can appear on a draw card, and therefore in a stack. */
export type DrawAmount = 2 | 4 | 6 | 10;

export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * The nine card kinds in the 168-card deck.
 *
 * Note there is no plain Wild and no standalone "Wild Draw 4": Reverse Draw 4
 * IS the +4 wild.
 */
export type Card =
  | { id: string; k: 'number'; color: Color; n: Digit }
  | { id: string; k: 'draw'; color: Color; amount: 2 | 4 }
  | { id: string; k: 'skip'; color: Color }
  | { id: string; k: 'skipEveryone'; color: Color }
  | { id: string; k: 'reverse'; color: Color }
  | { id: string; k: 'discardAll'; color: Color }
  | { id: string; k: 'wildReverseDraw4' }
  | { id: string; k: 'wildDraw'; amount: 6 | 10 }
  | { id: string; k: 'wildColorRoulette' };

export type CardKind = Card['k'];

/** A card that carries a colour on its face (i.e. is not a wild). */
export type ColoredCard = Extract<Card, { color: Color }>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Rule toggles for cases the official rulebook leaves ambiguous. Defaults are
 * in `config.ts`; a room may override any of them.
 */
export interface GameConfig {
  /** Hand size dealt at the start of each round. */
  handSize: number;
  /**
   * Hand size at which a player is knocked out. **0 disables knock-out.**
   *
   * Optional and off by default. A player knocked out this way is ranked below
   * everyone who managed to go out properly.
   */
  eliminationAt: number;
  /**
   * Hands dealt to each player at the start.
   *
   * There is only ever one deal. Play runs until every hand is empty, and the
   * order people go out in is the finishing order.
   */
  dealOnce: true;
  /** Must a stacked draw card also match the active colour? Official: no. */
  stackRequiresColorMatch: boolean;
  /** Who names the colour when Color Roulette resolves. */
  rouletteColorChosenBy: 'target' | 'player';
  /** Re-flip the opening card until it is a plain number card. */
  openingMustBeNumber: boolean;
  /** On a turn with no legal play: draw one, and play it if it is legal. */
  drawOneThenPlay: boolean;
  /**
   * Enforce calling UNO. The button appears once you are down to two cards;
   * play your second-to-last card without having pressed it and you are
   * penalised immediately.
   */
  unoCall: boolean;
  /** Cards drawn for failing to call. */
  unoPenalty: number;
  /**
   * House rule: playing a 7 swaps your hand with a player of your choice, and
   * playing a 0 passes every hand around in the direction of play.
   *
   * Not part of official UNO No Mercy, which is why it defaults off here -- but
   * it is the most common house rule and rooms turn it on.
   */
  sevenZero: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PlayerState {
  id: string;
  hand: Card[];
  /** Eliminated players stay seated (as spectators) but never take a turn. */
  eliminated: boolean;
  /**
   * Finishing position, 1 for the first player to empty their hand.
   *
   * null while they are still playing. Emptying your hand ends YOUR game, not
   * everyone's -- you keep your seat and watch while the rest play on for
   * second, third and so on.
   */
  place: number | null;
  /**
   * They have pressed UNO while holding two cards.
   *
   * Cleared whenever the hand grows back past one, so it can never carry over
   * and excuse a later failure to call.
   */
  calledUno: boolean;
}

export type Phase =
  /** Current player must play a legal card, or draw. */
  | { t: 'awaitingPlay' }
  /**
   * Current player drew a card with no legal play available and may now play
   * that specific card, or pass.
   */
  | { t: 'awaitingDrawnCardDecision'; cardId: string }
  /** Color Roulette landed on `targetId`, who must name a colour. */
  | { t: 'awaitingRouletteColor'; targetId: string }
  /** A 7 was played under the 7-0 rule; its player must pick who to swap with. */
  | { t: 'awaitingSwapTarget'; playerId: string }
  /** One player remains. `winnerId` on the state is set. */
  | { t: 'gameOver' };

export interface GameState {
  /** Seating order. Index into this array is a seat, and never changes. */
  players: PlayerState[];
  /** Seat whose turn it is. */
  turnIndex: number;
  /** +1 clockwise, -1 counter-clockwise. */
  direction: 1 | -1;
  /**
   * How many decks are in circulation.
   *
   * Starts from the player count and grows when the cards run out. Also the id
   * space for the next deck added, so no two cards can ever share an id.
   */
  decksInPlay: number;
  drawPile: Card[];
  /** Last element is the visible top card. */
  discardPile: Card[];
  /** The colour currently in force (a wild sets this explicitly). */
  activeColor: Color;
  /** Total cards the next non-stacking player must eat. 0 when no stack. */
  pendingDraw: number;
  /** Minimum value a card must have to join the stack. 0 when no stack. */
  pendingTier: 0 | DrawAmount;
  phase: Phase;
  /** Seeded PRNG state. Mutated only through `rng.ts`. */
  rngState: number;
  round: number;
  /** Set once a single player remains. */
  winnerId: string | null;
  config: GameConfig;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  /** Play `cardId`. `color` is required for a wild, ignored otherwise. */
  | { t: 'play'; playerId: string; cardId: string; color?: Color }
  /**
   * Draw. With a stack pending this eats the whole stack and ends the turn;
   * otherwise it draws a single card.
   */
  | { t: 'draw'; playerId: string }
  /** Decline to play the card just drawn. */
  | { t: 'pass'; playerId: string }
  /** Name the colour for a pending Color Roulette. */
  | { t: 'chooseRouletteColor'; playerId: string; color: Color }
  /** Pick whose hand to take after playing a 7. */
  | { t: 'chooseSwapTarget'; playerId: string; targetId: string }
  /**
   * Call UNO. Deliberately not a turn action -- you press it while holding two
   * cards, which is usually before your turn comes round.
   */
  | { t: 'callUno'; playerId: string }
  /** Turn clock expired: the server plays the safest legal move for them. */
  | { t: 'timeout'; playerId: string };

// ---------------------------------------------------------------------------
// Events -- the narration the UI animates and the server logs
// ---------------------------------------------------------------------------

export type GameEvent =
  | { t: 'roundStarted'; round: number; dealt: number }
  | { t: 'played'; playerId: string; card: Card }
  | { t: 'colorChosen'; playerId: string; color: Color }
  | { t: 'drew'; playerId: string; count: number; reason: 'turn' | 'stack' | 'roulette' }
  | { t: 'discardedAll'; playerId: string; color: Color; count: number }
  | { t: 'skipped'; playerIds: string[] }
  | { t: 'reversed'; direction: 1 | -1 }
  | { t: 'stackGrew'; total: number; tier: DrawAmount }
  | { t: 'reshuffled'; count: number }
  | { t: 'handsSwapped'; playerId: string; targetId: string; gained: number; lost: number }
  | { t: 'handsRotated'; direction: 1 | -1 }
  | { t: 'unoCalled'; playerId: string }
  | { t: 'unoPenalty'; playerId: string; count: number }
  | { t: 'eliminated'; playerId: string; handSize: number }
  | { t: 'playerFinished'; playerId: string; place: number }
  /** The cards ran out, so another deck was shuffled in. */
  | { t: 'deckExtended'; decks: number; added: number }
  /** Nobody could move and the deck was spent. */
  | { t: 'roundStalemate' }
  | { t: 'gameEnded'; winnerId: string }
  | { t: 'turnPassed'; playerId: string };

export interface ReduceResult {
  state: GameState;
  events: GameEvent[];
}

/** Thrown for an illegal action. The server catches it and replies with an error. */
export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalMoveError';
  }
}

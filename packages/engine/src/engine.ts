/**
 * The UNO No Mercy rules engine.
 *
 * A single pure entry point: `reduce(state, action) -> { state, events }`.
 * No I/O, no clock, no Math.random. The reducer clones the incoming state and
 * mutates the clone, so callers never observe a half-applied move and the
 * caller's state object is never touched.
 */

import { buildDeck } from './deck.js';
import { DEFAULT_CONFIG, MAX_PLAYERS, MIN_PLAYERS } from './config.js';
import { shuffle } from './rng.js';
import {
  bestColorFor,
  canPlay,
  cardShedPriority,
  drawValue,
  hasLegalCard,
  isColored,
  legalCards,
  needsColorChoice,
  type TableView,
} from './rules.js';
import {
  IllegalMoveError,
  type Action,
  type Card,
  type Color,
  type DrawAmount,
  type GameConfig,
  type GameEvent,
  type GameState,
  type PlayerState,
  type ReduceResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Queries (safe to call from the client too)
// ---------------------------------------------------------------------------

export function topCard(state: GameState): Card {
  const top = state.discardPile[state.discardPile.length - 1];
  if (!top) throw new Error('discard pile is empty; game was not initialised');
  return top;
}

export function tableView(state: GameState): TableView {
  return {
    top: topCard(state),
    activeColor: state.activeColor,
    pendingDraw: state.pendingDraw,
    pendingTier: state.pendingTier,
    config: state.config,
  };
}

export function activeSeats(state: GameState): number[] {
  const out: number[] = [];
  for (let i = 0; i < state.players.length; i++) {
    if (!state.players[i]!.eliminated) out.push(i);
  }
  return out;
}

export function activeCount(state: GameState): number {
  return activeSeats(state).length;
}

export function seatOf(state: GameState, playerId: string): number {
  const i = state.players.findIndex((p) => p.id === playerId);
  if (i < 0) throw new IllegalMoveError(`unknown player ${playerId}`);
  return i;
}

/**
 * Who is expected to act right now. Usually the seat at `turnIndex`, but a
 * pending Color Roulette hands the floor to its target.
 */
export function currentActorId(state: GameState): string | null {
  if (state.phase.t === 'gameOver') return null;
  if (state.phase.t === 'awaitingRouletteColor') return state.phase.targetId;
  if (state.phase.t === 'awaitingSwapTarget') return state.phase.playerId;
  return state.players[state.turnIndex]?.id ?? null;
}

/** Legal cards for a player, or [] when it is not their turn. */
export function legalMovesFor(state: GameState, playerId: string): Card[] {
  if (currentActorId(state) !== playerId) return [];
  const player = state.players[seatOf(state, playerId)]!;
  if (state.phase.t === 'awaitingDrawnCardDecision') {
    const drawn = player.hand.find((c) => c.id === (state.phase as { cardId: string }).cardId);
    return drawn && canPlay(drawn, tableView(state)) ? [drawn] : [];
  }
  if (state.phase.t !== 'awaitingPlay') return [];
  return legalCards(player.hand, tableView(state));

}

// ---------------------------------------------------------------------------
// Internal mutation helpers -- operate on a cloned draft
// ---------------------------------------------------------------------------

/** Move the discard pile (minus its top card) back under the draw pile. */
function reshuffle(s: GameState, events: GameEvent[]): void {
  if (s.discardPile.length <= 1) return;
  const top = s.discardPile.pop()!;
  const recycled = s.discardPile;
  const res = shuffle([...s.drawPile, ...recycled], s.rngState);
  s.drawPile = res.items;
  s.rngState = res.state;
  s.discardPile = [top];
  events.push({ t: 'reshuffled', count: recycled.length });
}

/** Pop one card, recycling the discard pile if the draw pile has run dry. */
function drawOne(s: GameState, events: GameEvent[]): Card | null {
  if (s.drawPile.length === 0) reshuffle(s, events);
  return s.drawPile.pop() ?? null;
}

/**
 * Hand `count` cards to a seat, then check elimination.
 *
 * Elimination is checked here rather than at the top of the reducer because
 * this is the only place a hand can grow -- keeping the check adjacent to the
 * cause means no code path can add cards and forget to enforce the 25 limit.
 */
function giveCards(s: GameState, seat: number, count: number, events: GameEvent[]): number {
  const player = s.players[seat]!;
  let given = 0;
  for (let i = 0; i < count; i++) {
    const card = drawOne(s, events);
    if (!card) break;
    player.hand.push(card);
    given++;
  }
  syncUnoFlag(player);
  return given;
}

/**
 * Drop a standing UNO call once the hand is no longer down to the wire.
 *
 * Must be applied everywhere a hand changes size, not just where cards are
 * drawn. 7-0 reassigns whole hands directly, and without this a player who
 * called at two cards and was then handed a 21-card hand kept the call
 * standing -- which would silently excuse their next failure to call. The fuzz
 * invariant caught exactly that.
 */
function syncUnoFlag(player: PlayerState): void {
  if (player.hand.length > 1) player.calledUno = false;
}

/**
 * Reveal cards one at a time until `color` shows up; every revealed card is
 * kept. Guarded by the total card count so an exhausted deck cannot spin.
 */
function drawUntilColor(s: GameState, seat: number, color: Color, events: GameEvent[]): number {
  const player = s.players[seat]!;
  const ceiling = s.drawPile.length + s.discardPile.length;
  let drawn = 0;
  for (let i = 0; i < ceiling; i++) {
    const card = drawOne(s, events);
    if (!card) break;
    player.hand.push(card);
    drawn++;
    if (isColored(card) && card.color === color) break;
  }
  return drawn;
}

function checkElimination(s: GameState, seat: number, events: GameEvent[]): void {
  const player = s.players[seat]!;
  if (player.eliminated || player.hand.length < s.config.eliminationAt) return;

  player.eliminated = true;
  events.push({ t: 'eliminated', playerId: player.id, handSize: player.hand.length });

  // Return their hand to the draw pile rather than the discard pile, so the
  // visible top card -- and therefore the active colour -- is left untouched.
  const res = shuffle([...s.drawPile, ...player.hand], s.rngState);
  s.drawPile = res.items;
  s.rngState = res.state;
  player.hand = [];
}

/** Seat `steps` active players away from `from`, honouring direction. */
function seatAfter(s: GameState, from: number, steps: number): number {
  const n = s.players.length;
  const alive = activeCount(s);
  if (alive === 0) return from;
  let idx = from;
  let moved = 0;
  let guard = 0;
  const limit = n * (steps + 1) + n;
  while (moved < steps && guard++ < limit) {
    idx = (idx + s.direction + n) % n;
    if (!s.players[idx]!.eliminated) moved++;
  }
  return idx;
}

function advance(s: GameState, steps: number): void {
  s.turnIndex = seatAfter(s, s.turnIndex, steps);
}

/** If the seat holding the turn got eliminated, hand the turn to the next one. */
function normalizeTurn(s: GameState): void {
  if (!s.players[s.turnIndex]?.eliminated) return;
  s.turnIndex = seatAfter(s, s.turnIndex, 1);
}

/** How many seats a reverse should move: in a two-player game it acts as a skip. */
function reverseSteps(s: GameState): number {
  return activeCount(s) === 2 ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Round / game lifecycle
// ---------------------------------------------------------------------------

/** Collect every card in play, reshuffle, deal a fresh hand to each survivor. */
function startRound(s: GameState, leadSeat: number, events: GameEvent[]): void {
  const all: Card[] = [...s.drawPile, ...s.discardPile];
  for (const p of s.players) {
    all.push(...p.hand);
    p.hand = [];
    p.calledUno = false;
  }

  const res = shuffle(all, s.rngState);
  s.drawPile = res.items;
  s.rngState = res.state;
  s.discardPile = [];
  s.pendingDraw = 0;
  s.pendingTier = 0;
  s.direction = 1;
  s.round += 1;

  for (const seat of activeSeats(s)) {
    giveCards(s, seat, s.config.handSize, events);
  }

  // Flip the opening card. An action card as the opener would have to resolve
  // against nobody, so re-flip until a plain number turns up.
  let opener = drawOne(s, events);
  if (s.config.openingMustBeNumber) {
    let guard = 0;
    while (opener && opener.k !== 'number' && guard++ < 200) {
      s.drawPile.unshift(opener); // bury it and try again
      opener = drawOne(s, events);
    }
  }
  if (!opener) throw new Error('deck exhausted while dealing');

  s.discardPile = [opener];
  s.activeColor = isColored(opener) ? opener.color : 'red';
  s.turnIndex = s.players[leadSeat]!.eliminated ? seatAfter(s, leadSeat, 1) : leadSeat;
  s.phase = { t: 'awaitingPlay' };

  events.push({ t: 'roundStarted', round: s.round, dealt: s.config.handSize });
}

/** Called after a play empties a hand, and after any elimination. */
function checkRoundOrGameEnd(s: GameState, events: GameEvent[]): boolean {
  const alive = activeSeats(s);

  if (alive.length <= 1) {
    const winner = alive[0];
    s.winnerId = winner !== undefined ? s.players[winner]!.id : null;
    s.phase = { t: 'gameOver' };
    if (s.winnerId) events.push({ t: 'gameEnded', winnerId: s.winnerId });
    return true;
  }

  const wentOut = alive.find((seat) => s.players[seat]!.hand.length === 0);
  if (wentOut !== undefined) {
    const winner = s.players[wentOut]!;
    winner.roundsWon += 1;
    events.push({ t: 'roundEnded', winnerId: winner.id });
    startRound(s, wentOut, events);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createGame(
  playerIds: readonly string[],
  seed: number,
  configOverrides: Partial<GameConfig> = {},
): GameState {
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    throw new Error(`need ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${playerIds.length}`);
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new Error('duplicate player ids');
  }

  const config: GameConfig = { ...DEFAULT_CONFIG, ...configOverrides };
  const players: PlayerState[] = playerIds.map((id) => ({
    id,
    hand: [],
    eliminated: false,
    roundsWon: 0,
    calledUno: false,
  }));

  const state: GameState = {
    players,
    turnIndex: 0,
    direction: 1,
    drawPile: buildDeck(),
    discardPile: [],
    activeColor: 'red',
    pendingDraw: 0,
    pendingTier: 0,
    phase: { t: 'awaitingPlay' },
    rngState: seed >>> 0,
    round: 0,
    winnerId: null,
    config,
  };

  startRound(state, 0, []);
  return state;
}

// ---------------------------------------------------------------------------
// Card effects
// ---------------------------------------------------------------------------

/**
 * Apply the effect of a card that has already left the actor's hand and been
 * placed on the discard pile. Responsible for direction, the draw stack and
 * handing the turn on.
 *
 * Returns `true` when the card left a decision pending -- currently only a 7
 * under the 7-0 rule, which cannot finish resolving until its player names
 * whose hand to take.
 */
function applyEffect(
  s: GameState,
  card: Card,
  actorSeat: number,
  chosen: Color | undefined,
  events: GameEvent[],
): boolean {
  const bumpStack = (amount: DrawAmount) => {
    s.pendingDraw += amount;
    s.pendingTier = amount;
    events.push({ t: 'stackGrew', total: s.pendingDraw, tier: amount });
  };

  switch (card.k) {
    case 'number': {
      if (s.config.sevenZero && card.n === 7) {
        // Choosing a target only makes sense with someone to choose between.
        // With two players left the swap is forced, so resolve it immediately
        // rather than showing a picker with one option.
        const others = activeSeats(s).filter((i) => i !== actorSeat);
        if (others.length === 1) {
          swapHands(s, actorSeat, others[0]!, events);
          advance(s, 1);
        } else if (others.length === 0) {
          advance(s, 1);
        } else {
          s.phase = { t: 'awaitingSwapTarget', playerId: s.players[actorSeat]!.id };
          return true;
        }
        break;
      }
      if (s.config.sevenZero && card.n === 0) {
        rotateHands(s, events);
        advance(s, 1);
        break;
      }
      advance(s, 1);
      break;
    }

    case 'skip': {
      const victim = seatAfter(s, s.turnIndex, 1);
      events.push({ t: 'skipped', playerIds: [s.players[victim]!.id] });
      advance(s, 2);
      break;
    }

    case 'reverse': {
      s.direction = (s.direction * -1) as 1 | -1;
      events.push({ t: 'reversed', direction: s.direction });
      advance(s, reverseSteps(s));
      break;
    }

    case 'skipEveryone': {
      // The turn travels all the way around and lands back on the player.
      const others = activeSeats(s).filter((i) => i !== actorSeat);
      events.push({ t: 'skipped', playerIds: others.map((i) => s.players[i]!.id) });
      advance(s, activeCount(s));
      break;
    }

    case 'discardAll': {
      const player = s.players[actorSeat]!;
      const batch = player.hand.filter((c) => isColored(c) && c.color === card.color);
      player.hand = player.hand.filter((c) => !(isColored(c) && c.color === card.color));
      // Batch goes under the played card so the top card -- and the colour it
      // dictates -- stays the Discard All itself.
      s.discardPile.pop();
      s.discardPile.push(...batch, card);
      events.push({ t: 'discardedAll', playerId: player.id, color: card.color, count: batch.length });
      advance(s, 1);
      break;
    }

    case 'draw': {
      bumpStack(card.amount);
      advance(s, 1);
      break;
    }

    case 'wildDraw': {
      s.activeColor = chosen!;
      events.push({ t: 'colorChosen', playerId: s.players[actorSeat]!.id, color: chosen! });
      bumpStack(card.amount);
      advance(s, 1);
      break;
    }

    case 'wildReverseDraw4': {
      s.activeColor = chosen!;
      events.push({ t: 'colorChosen', playerId: s.players[actorSeat]!.id, color: chosen! });
      s.direction = (s.direction * -1) as 1 | -1;
      events.push({ t: 'reversed', direction: s.direction });
      bumpStack(4);
      // Two players: the flip bounces the turn straight back, so the player who
      // threw it eats their own +4 unless they can stack again.
      advance(s, reverseSteps(s));
      break;
    }

    case 'wildColorRoulette': {
      const target = seatAfter(s, s.turnIndex, 1);
      s.turnIndex = target;
      if (s.config.rouletteColorChosenBy === 'player') {
        resolveRoulette(s, target, chosen!, events);
      } else {
        s.phase = { t: 'awaitingRouletteColor', targetId: s.players[target]!.id };
      }
      break;
    }
  }
  return false;
}

/**
 * The 7 half of 7-0: two players exchange hands outright.
 *
 * Note this can hand someone an empty hand -- playing a 7 as your last card
 * gives your opponent nothing, so THEY go out, not you. That is checked after
 * the swap by the normal round-end path, which is why the swap must resolve
 * before that check runs.
 */
function swapHands(s: GameState, seatA: number, seatB: number, events: GameEvent[]): void {
  const a = s.players[seatA]!;
  const b = s.players[seatB]!;
  const mine = a.hand;
  const theirs = b.hand;
  a.hand = theirs;
  b.hand = mine;
  syncUnoFlag(a);
  syncUnoFlag(b);
  events.push({
    t: 'handsSwapped',
    playerId: a.id,
    targetId: b.id,
    gained: theirs.length,
    lost: mine.length,
  });
  checkElimination(s, seatA, events);
  checkElimination(s, seatB, events);
}

/** The 0 half of 7-0: every hand moves one seat in the direction of play. */
function rotateHands(s: GameState, events: GameEvent[]): void {
  const seats = activeSeats(s);
  if (seats.length < 2) return;

  // Walking the seats in play order means the hands travel the way the turn
  // does, which is what players expect to see.
  const ordered = s.direction === 1 ? seats : [...seats].reverse();
  const hands = ordered.map((seat) => s.players[seat]!.hand);
  ordered.forEach((seat, i) => {
    const from = (i - 1 + hands.length) % hands.length;
    const player = s.players[seat]!;
    player.hand = hands[from]!;
    syncUnoFlag(player);
  });

  events.push({ t: 'handsRotated', direction: s.direction });
  for (const seat of ordered) checkElimination(s, seat, events);
}

/**
 * Penalise a player who finished their turn on one card without calling UNO.
 *
 * Applied automatically rather than requiring an opponent to catch them: this
 * is a phone game where everyone is looking at their own hand, and a
 * catch-based rule would just mean nobody is ever penalised.
 *
 * Runs only when a turn resolves with exactly one card left. Zero means they
 * went out and there was nothing to call.
 */
function enforceUnoCall(s: GameState, seat: number, events: GameEvent[]): void {
  if (!s.config.unoCall) return;
  const player = s.players[seat]!;
  if (player.eliminated || player.hand.length !== 1) return;

  if (player.calledUno) {
    // Spent: the next time they reach one card they must call again.
    player.calledUno = false;
    return;
  }

  const given = giveCards(s, seat, s.config.unoPenalty, events);
  events.push({ t: 'unoPenalty', playerId: player.id, count: given });
  checkElimination(s, seat, events);
}

/** Target names a colour, draws until it appears, and forfeits their turn. */
function resolveRoulette(s: GameState, targetSeat: number, color: Color, events: GameEvent[]): void {
  const target = s.players[targetSeat]!;
  events.push({ t: 'colorChosen', playerId: target.id, color });
  const drawn = drawUntilColor(s, targetSeat, color, events);
  events.push({ t: 'drew', playerId: target.id, count: drawn, reason: 'roulette' });
  s.activeColor = color;
  checkElimination(s, targetSeat, events);
  s.turnIndex = targetSeat;
  advance(s, 1);
  s.phase = { t: 'awaitingPlay' };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function assertActor(s: GameState, playerId: string): number {
  const actor = currentActorId(s);
  if (actor === null) throw new IllegalMoveError('the game is over');
  if (actor !== playerId) throw new IllegalMoveError('it is not your turn');
  return seatOf(s, playerId);
}

export function reduce(state: GameState, action: Action): ReduceResult {
  const s: GameState = structuredClone(state);
  const events: GameEvent[] = [];

  switch (action.t) {
    case 'play':
      applyPlay(s, action.playerId, action.cardId, action.color, events);
      break;
    case 'draw':
      applyDraw(s, action.playerId, events);
      break;
    case 'pass':
      applyPass(s, action.playerId, events);
      break;
    case 'chooseRouletteColor':
      applyRouletteChoice(s, action.playerId, action.color, events);
      break;
    case 'chooseSwapTarget':
      applySwapChoice(s, action.playerId, action.targetId, events);
      break;
    case 'callUno':
      applyCallUno(s, action.playerId, events);
      break;
    case 'timeout':
      return applyTimeout(state, action.playerId);
  }

  return { state: s, events };
}

function applyPlay(
  s: GameState,
  playerId: string,
  cardId: string,
  color: Color | undefined,
  events: GameEvent[],
): void {
  const seat = assertActor(s, playerId);
  const player = s.players[seat]!;

  if (s.phase.t === 'awaitingRouletteColor') {
    throw new IllegalMoveError('a colour must be named for Color Roulette first');
  }
  if (s.phase.t === 'awaitingSwapTarget') {
    throw new IllegalMoveError('choose whose hand to take first');
  }
  if (s.phase.t === 'awaitingDrawnCardDecision' && s.phase.cardId !== cardId) {
    throw new IllegalMoveError('only the card just drawn may be played');
  }

  const index = player.hand.findIndex((c) => c.id === cardId);
  if (index < 0) throw new IllegalMoveError('card not in hand');
  const card = player.hand[index]!;

  if (!canPlay(card, tableView(s))) {
    throw new IllegalMoveError(
      s.pendingDraw > 0
        ? `a stack of ${s.pendingDraw} is pending; only +${s.pendingTier} or higher may be played`
        : 'card does not match the active colour or the top card',
    );
  }
  if (needsColorChoice(card) && !color) {
    throw new IllegalMoveError('a colour must be named when playing this wild');
  }
  if (
    card.k === 'wildColorRoulette' &&
    s.config.rouletteColorChosenBy === 'player' &&
    !color
  ) {
    throw new IllegalMoveError('a colour must be named when playing Color Roulette');
  }

  player.hand.splice(index, 1);
  s.discardPile.push(card);
  s.phase = { t: 'awaitingPlay' };
  events.push({ t: 'played', playerId, card });

  if (isColored(card)) s.activeColor = card.color;

  // A 7 still waiting on a target has not finished resolving. Checking for a
  // round end now would declare the player out before the swap that is about
  // to hand them someone else's cards.
  const deferred = applyEffect(s, card, seat, color, events);
  if (deferred) return;

  // After effects, because Discard All can drop a hand straight to one.
  enforceUnoCall(s, seat, events);

  if (checkRoundOrGameEnd(s, events)) return;
  normalizeTurn(s);
}

function applyDraw(s: GameState, playerId: string, events: GameEvent[]): void {
  const seat = assertActor(s, playerId);
  const player = s.players[seat]!;

  if (s.phase.t === 'awaitingSwapTarget') {
    throw new IllegalMoveError('choose whose hand to take first');
  }
  if (s.phase.t !== 'awaitingPlay') {
    throw new IllegalMoveError('you have already drawn this turn');
  }

  // Eating a pending stack: take the lot, turn over.
  if (s.pendingDraw > 0) {
    const count = s.pendingDraw;
    const given = giveCards(s, seat, count, events);
    events.push({ t: 'drew', playerId, count: given, reason: 'stack' });
    s.pendingDraw = 0;
    s.pendingTier = 0;
    checkElimination(s, seat, events);
    if (checkRoundOrGameEnd(s, events)) return;
    advance(s, 1);
    normalizeTurn(s);
    return;
  }

  const given = giveCards(s, seat, 1, events);
  events.push({ t: 'drew', playerId, count: given, reason: 'turn' });
  checkElimination(s, seat, events);
  if (checkRoundOrGameEnd(s, events)) return;

  const drawn = player.hand[player.hand.length - 1];
  if (s.config.drawOneThenPlay && given > 0 && drawn && canPlay(drawn, tableView(s))) {
    s.phase = { t: 'awaitingDrawnCardDecision', cardId: drawn.id };
    return;
  }

  events.push({ t: 'turnPassed', playerId });
  advance(s, 1);
  normalizeTurn(s);
}

function applyPass(s: GameState, playerId: string, events: GameEvent[]): void {
  assertActor(s, playerId);
  if (s.phase.t !== 'awaitingDrawnCardDecision') {
    throw new IllegalMoveError('you may only pass immediately after drawing');
  }
  s.phase = { t: 'awaitingPlay' };
  events.push({ t: 'turnPassed', playerId });
  advance(s, 1);
  normalizeTurn(s);
}

function applyRouletteChoice(s: GameState, playerId: string, color: Color, events: GameEvent[]): void {
  if (s.phase.t !== 'awaitingRouletteColor') {
    throw new IllegalMoveError('no Color Roulette is pending');
  }
  if (s.phase.targetId !== playerId) {
    throw new IllegalMoveError('only the target names the colour');
  }
  const seat = seatOf(s, playerId);
  resolveRoulette(s, seat, color, events);
  if (checkRoundOrGameEnd(s, events)) return;
  normalizeTurn(s);
}

function applySwapChoice(s: GameState, playerId: string, targetId: string, events: GameEvent[]): void {
  if (s.phase.t !== 'awaitingSwapTarget') {
    throw new IllegalMoveError('no hand swap is pending');
  }
  if (s.phase.playerId !== playerId) {
    throw new IllegalMoveError('only the player who played the 7 chooses');
  }
  if (targetId === playerId) throw new IllegalMoveError('choose someone else');

  const targetSeat = seatOf(s, targetId);
  if (s.players[targetSeat]!.eliminated) {
    throw new IllegalMoveError('that player is out');
  }

  const actorSeat = seatOf(s, playerId);
  swapHands(s, actorSeat, targetSeat, events);
  s.phase = { t: 'awaitingPlay' };
  enforceUnoCall(s, actorSeat, events);
  advance(s, 1);

  if (checkRoundOrGameEnd(s, events)) return;
  normalizeTurn(s);
}

/**
 * Press UNO.
 *
 * Legal while holding exactly two cards, and deliberately NOT gated on whose
 * turn it is -- you press it before playing your second-to-last card, which is
 * often while somebody else is still thinking.
 */
function applyCallUno(s: GameState, playerId: string, events: GameEvent[]): void {
  const seat = seatOf(s, playerId);
  const player = s.players[seat]!;

  if (player.eliminated) throw new IllegalMoveError('you are out');
  if (!s.config.unoCall) throw new IllegalMoveError('UNO calls are off in this room');
  if (player.hand.length !== 2) {
    throw new IllegalMoveError('you can only call UNO holding two cards');
  }
  if (player.calledUno) return;

  player.calledUno = true;
  events.push({ t: 'unoCalled', playerId });
}

/** Everyone still in the game who is not `playerId` -- the swap candidates. */
export function swapCandidates(state: GameState, playerId: string): string[] {
  return activeSeats(state)
    .map((seat) => state.players[seat]!.id)
    .filter((id) => id !== playerId);
}

/**
 * Turn clock expired. Plays the least valuable legal move on the player's
 * behalf so an absent player costs the table tempo but never a deadlock.
 */
function applyTimeout(state: GameState, playerId: string): ReduceResult {
  const actor = currentActorId(state);
  if (actor !== playerId) throw new IllegalMoveError('it is not your turn');
  const player = state.players[seatOf(state, playerId)]!;

  if (state.phase.t === 'awaitingRouletteColor') {
    return reduce(state, { t: 'chooseRouletteColor', playerId, color: bestColorFor(player.hand) });
  }
  if (state.phase.t === 'awaitingSwapTarget') {
    // Take the smallest hand on the table: the move a human would make.
    const best = swapCandidates(state, playerId).reduce((a, b) => {
      const ha = state.players[seatOf(state, a)]!.hand.length;
      const hb = state.players[seatOf(state, b)]!.hand.length;
      return hb < ha ? b : a;
    });
    return reduce(state, { t: 'chooseSwapTarget', playerId, targetId: best });
  }
  if (state.phase.t === 'awaitingDrawnCardDecision') {
    return reduce(state, { t: 'pass', playerId });
  }
  if (state.pendingDraw > 0) {
    return reduce(state, { t: 'draw', playerId });
  }
  if (!hasLegalCard(player.hand, tableView(state))) {
    return reduce(state, { t: 'draw', playerId });
  }

  // Call first if this move would leave one card: the server playing for an
  // absent player should not also fine them for it.
  if (state.config.unoCall && player.hand.length === 2 && !player.calledUno) {
    const called = reduce(state, { t: 'callUno', playerId });
    const next = applyTimeout(called.state, playerId);
    return { state: next.state, events: [...called.events, ...next.events] };
  }

  const choice = legalCards(player.hand, tableView(state)).sort(
    (a, b) => cardShedPriority(a) - cardShedPriority(b),
  )[0]!;

  const needsColor = needsColorChoice(choice) || choice.k === 'wildColorRoulette';
  return reduce(state, {
    t: 'play',
    playerId,
    cardId: choice.id,
    ...(needsColor ? { color: bestColorFor(player.hand) } : {}),
  });
}

export { drawValue };

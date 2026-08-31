/**
 * A single room: its members, its game, and its turn clock.
 *
 * The transport is injected rather than importing socket.io directly, so the
 * whole lifecycle -- join, start, play, timeout, eliminate, finish -- can be
 * driven in tests with a fake clock and no network at all.
 */

import {
  createGame,
  currentActorId,
  redactFor,
  reduce,
  IllegalMoveError,
  type Action,
  type GameConfig,
  type GameEvent,
  type GameState,
} from '@nmu/engine';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type ChatMessage,
  type Reaction,
  type RoomMember,
  type RoomSettings,
  type RoomStatus,
  type RoomView,
  type ServerToClientEvents,
} from '@nmu/shared';
import { randomUUID } from 'node:crypto';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface RoomTransport {
  toRoom<E extends keyof ServerToClientEvents>(
    code: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  toUser<E extends keyof ServerToClientEvents>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
}

export interface MemberProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

interface Member extends MemberProfile {
  seat: number;
  connected: boolean;
  micOn: boolean;
  onVoice: boolean;
  /** Set when they disconnect, so the grace period can be measured. */
  disconnectedAt: number | null;
  /** True once they walk out; they keep their seat until the game ends. */
  departed: boolean;
  /** Simple token bucket, refilled on use. */
  chatTokens: number;
  chatRefilledAt: number;
}

export interface MatchResult {
  roomCode: string;
  startedAt: number;
  endedAt: number;
  rounds: number;
  winnerId: string | null;
  /** Seat order, with rounds won and final placing. */
  players: { userId: string; seat: number; roundsWon: number; finalPlace: number }[];
}

export class RoomError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'bad_password'
      | 'room_full'
      | 'already_started'
      | 'not_host'
      | 'not_in_room'
      | 'bad_request'
      | 'rate_limited'
      | 'illegal_move',
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

const CHAT_BURST = 5;
const CHAT_REFILL_MS = 2_000;

export interface RoomOptions {
  code: string;
  host: MemberProfile;
  settings: RoomSettings;
  passwordHash: string;
  transport: RoomTransport;
  clock?: Clock;
  onMatchFinished?: ((result: MatchResult) => void) | undefined;
  /**
   * Fixed RNG seed. Left unset in production so every game is different;
   * supplied by tests so a shuffle-dependent assertion cannot flake.
   */
  seed?: number | undefined;
}

export class Room {
  readonly code: string;
  readonly createdAt: number;

  private settings: RoomSettings;
  private readonly passwordHash: string;
  private hostId: string;
  private status: RoomStatus = 'waiting';

  private readonly members = new Map<string, Member>();
  private nextSeat = 0;

  private game: GameState | null = null;
  private gameStartedAt = 0;
  /** Order players were knocked out, so standings can be reconstructed. */
  private eliminationOrder: string[] = [];

  private turnHandle: unknown = null;
  private turnEndsAt: number | null = null;

  private lastActivityAt: number;

  private readonly transport: RoomTransport;
  private readonly clock: Clock;
  private readonly onMatchFinished: ((result: MatchResult) => void) | undefined;
  /** Fixed RNG seed, for deterministic tests. Random per game when absent. */
  private readonly seed: number | undefined;

  constructor(opts: RoomOptions) {
    this.transport = opts.transport;
    this.clock = opts.clock ?? systemClock;
    this.onMatchFinished = opts.onMatchFinished;
    this.seed = opts.seed;

    this.code = opts.code;
    this.settings = opts.settings;
    this.passwordHash = opts.passwordHash;
    this.hostId = opts.host.userId;
    this.createdAt = this.clock.now();
    this.lastActivityAt = this.createdAt;
    this.addMember(opts.host);
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  get passwordDigest(): string {
    return this.passwordHash;
  }

  get memberCount(): number {
    return [...this.members.values()].filter((m) => !m.departed).length;
  }

  get idleMs(): number {
    return this.clock.now() - this.lastActivityAt;
  }

  get isEmpty(): boolean {
    return [...this.members.values()].every((m) => m.departed || !m.connected);
  }

  has(userId: string): boolean {
    const m = this.members.get(userId);
    return !!m && !m.departed;
  }

  private touch(): void {
    this.lastActivityAt = this.clock.now();
  }

  private addMember(profile: MemberProfile): Member {
    const member: Member = {
      ...profile,
      seat: this.nextSeat++,
      connected: true,
      micOn: false,
      onVoice: false,
      disconnectedAt: null,
      departed: false,
      chatTokens: CHAT_BURST,
      chatRefilledAt: this.clock.now(),
    };
    this.members.set(profile.userId, member);
    return member;
  }

  /**
   * Join, or rejoin. A returning player reclaims their existing seat rather
   * than being appended, which is the whole reason a refresh mid-game is
   * survivable.
   */
  join(profile: MemberProfile): void {
    const existing = this.members.get(profile.userId);
    if (existing) {
      existing.connected = true;
      existing.departed = false;
      existing.disconnectedAt = null;
      existing.displayName = profile.displayName;
      existing.avatarUrl = profile.avatarUrl;
      this.touch();
      if (this.status === 'playing' && this.turnHandle === null) this.armTurnTimer();
      this.broadcastRoom();
      this.pushGameTo(profile.userId);
      return;
    }

    if (this.status === 'playing') {
      // Newcomers may watch, but seats are fixed once the deck is dealt.
      const spectator = this.addMember(profile);
      spectator.seat = -1;
      this.touch();
      this.broadcastRoom();
      this.pushGameTo(profile.userId);
      return;
    }

    if (this.memberCount >= this.settings.maxPlayers) {
      throw new RoomError('room_full', 'this room is full');
    }

    this.addMember(profile);
    this.touch();
    this.broadcastRoom();
  }

  /** A socket dropped. The seat is held; the turn clock covers their turns. */
  markDisconnected(userId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    m.connected = false;
    m.disconnectedAt = this.clock.now();
    m.onVoice = false;
    m.micOn = false;
    this.transport.toRoom(this.code, 'voice:left', { userId });
    this.broadcastRoom();
  }

  /** An explicit "leave". Mid-game the seat is kept so the engine stays valid. */
  leave(userId: string): void {
    const m = this.members.get(userId);
    if (!m) return;

    if (this.status === 'playing' && m.seat >= 0) {
      m.departed = true;
      m.connected = false;
      m.onVoice = false;
      this.transport.toRoom(this.code, 'voice:left', { userId });
      this.reassignHostIfNeeded();
      this.broadcastRoom();
      // Their turns now resolve on the clock rather than stalling the table.
      this.armTurnTimer();
      return;
    }

    this.members.delete(userId);
    this.transport.toRoom(this.code, 'voice:left', { userId });
    this.reassignHostIfNeeded();
    this.touch();
    this.broadcastRoom();
  }

  /**
   * Drop players who disconnected and never came back.
   *
   * Only in the waiting room. During a game a seat must persist -- removing one
   * would leave the engine holding a player nobody can act for, and the turn
   * clock already covers an absent player. But in a lobby a ghost occupies a
   * slot and, if they were the host, blocks the game from ever starting.
   *
   * Returns the ids evicted, so the caller can log it.
   */
  evictStale(graceMs: number): string[] {
    if (this.status === 'playing') return [];

    const now = this.clock.now();
    const stale = [...this.members.values()].filter(
      (m) => !m.connected && m.disconnectedAt !== null && now - m.disconnectedAt > graceMs,
    );
    if (stale.length === 0) return [];

    for (const m of stale) {
      this.members.delete(m.userId);
      this.transport.toRoom(this.code, 'voice:left', { userId: m.userId });
    }
    this.reassignHostIfNeeded();
    this.broadcastRoom();
    return stale.map((m) => m.userId);
  }

  kick(hostId: string, targetId: string): void {
    this.assertHost(hostId);
    if (targetId === hostId) throw new RoomError('bad_request', 'the host cannot kick themselves');
    if (!this.members.has(targetId)) throw new RoomError('not_found', 'no such member');
    this.leave(targetId);
  }

  transferHost(hostId: string, targetId: string): void {
    this.assertHost(hostId);
    const target = this.members.get(targetId);
    if (!target || target.departed) throw new RoomError('not_found', 'no such member');
    this.hostId = targetId;
    this.touch();
    this.broadcastRoom();
  }

  private reassignHostIfNeeded(): void {
    const host = this.members.get(this.hostId);
    if (host && !host.departed) return;
    const next = [...this.members.values()].find((m) => !m.departed);
    if (next) this.hostId = next.userId;
  }

  private assertHost(userId: string): void {
    if (this.hostId !== userId) throw new RoomError('not_host', 'only the host can do that');
  }

  updateSettings(hostId: string, settings: RoomSettings): void {
    this.assertHost(hostId);
    if (this.status === 'playing') {
      throw new RoomError('already_started', 'settings are locked once a game starts');
    }
    if (settings.maxPlayers < this.memberCount) {
      throw new RoomError('bad_request', `there are already ${this.memberCount} players in the room`);
    }
    this.settings = settings;
    this.touch();
    this.broadcastRoom();
  }

  // -------------------------------------------------------------------------
  // Game lifecycle
  // -------------------------------------------------------------------------

  start(hostId: string): void {
    this.assertHost(hostId);
    if (this.status === 'playing') throw new RoomError('already_started', 'the game is already running');

    const seated = this.seatedMembers();
    if (seated.length < MIN_PLAYERS) {
      throw new RoomError('bad_request', `at least ${MIN_PLAYERS} players are needed`);
    }
    if (seated.length > MAX_PLAYERS) {
      throw new RoomError('bad_request', `at most ${MAX_PLAYERS} players can play`);
    }

    // Re-index seats so the engine's player array is contiguous.
    seated.forEach((m, i) => (m.seat = i));

    const seed = this.seed ?? (parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16) >>> 0);
    this.game = createGame(seated.map((m) => m.userId), seed, this.engineConfig());
    this.status = 'playing';
    this.gameStartedAt = this.clock.now();
    this.eliminationOrder = [];
    this.touch();

    this.armTurnTimer();
    this.broadcastRoom();
    this.broadcastGame([]);
  }

  private engineConfig(): Partial<GameConfig> {
    // Built key by key: `exactOptionalPropertyTypes` means an explicit
    // `undefined` is not the same as an absent key, and spreading the parsed
    // overrides would smuggle undefineds into the engine's defaults.
    const r = this.settings.rules;
    const out: Partial<GameConfig> = {};
    if (r.sevenZero !== undefined) out.sevenZero = r.sevenZero;
    if (r.unoCall !== undefined) out.unoCall = r.unoCall;
    if (r.unoPenalty !== undefined) out.unoPenalty = r.unoPenalty;
    if (r.stackRequiresColorMatch !== undefined) out.stackRequiresColorMatch = r.stackRequiresColorMatch;
    if (r.rouletteColorChosenBy !== undefined) out.rouletteColorChosenBy = r.rouletteColorChosenBy;
    if (r.eliminationAt !== undefined) out.eliminationAt = r.eliminationAt;
    if (r.handSize !== undefined) out.handSize = r.handSize;
    return out;
  }

  private seatedMembers(): Member[] {
    return [...this.members.values()]
      .filter((m) => !m.departed && m.seat >= 0)
      .sort((a, b) => a.seat - b.seat);
  }

  /**
   * Apply a game action on behalf of a user. Throws RoomError if illegal.
   *
   * `system` marks a turn the server played itself on the clock, which is
   * deliberately not treated as room activity.
   */
  applyAction(userId: string, action: Action, system = false): void {
    if (!this.game || this.status !== 'playing') {
      throw new RoomError('bad_request', 'no game is running');
    }
    if (!this.has(userId) && !this.members.has(userId)) {
      throw new RoomError('not_in_room', 'you are not in this room');
    }

    let result;
    try {
      result = reduce(this.game, action);
    } catch (err) {
      if (err instanceof IllegalMoveError) throw new RoomError('illegal_move', err.message);
      throw err;
    }

    this.game = result.state;
    this.recordEliminations(result.events);
    // Only a human action counts as activity. Auto-played turns must not keep
    // an abandoned room looking alive, or the sweeper would never reclaim it.
    if (!system) this.touch();

    if (this.game.phase.t === 'gameOver') {
      this.clearTurnTimer();
      this.broadcastGame(result.events);
      this.finishGame();
    } else {
      // Arm before broadcasting so the snapshot carries this turn's deadline.
      this.armTurnTimer();
      this.broadcastGame(result.events);
    }
  }

  private recordEliminations(events: GameEvent[]): void {
    for (const e of events) {
      if (e.t === 'eliminated' && !this.eliminationOrder.includes(e.playerId)) {
        this.eliminationOrder.push(e.playerId);
      }
    }
  }

  private finishGame(): void {
    const game = this.game;
    if (!game) return;

    this.clearTurnTimer();
    this.status = 'finished';

    const winnerId = game.winnerId;

    /**
     * Standings come straight from the finishing order: first player to empty
     * their hand is 1st, and so on down to whoever was left holding cards.
     *
     * Anyone knocked out at 25 never went out, so they have no place and are
     * appended below everyone who did -- most recently knocked out first.
     */
    const placed = [...game.players]
      .filter((p) => p.place !== null)
      .sort((a, b) => a.place! - b.place!)
      .map((p) => p.id);
    const knockedOut = [...this.eliminationOrder].reverse();
    const standings = [...placed, ...knockedOut.filter((id) => !placed.includes(id))];

    if (winnerId) {
      this.transport.toRoom(this.code, 'game:over', { winnerId, standings });
    }

    this.onMatchFinished?.({
      roomCode: this.code,
      startedAt: this.gameStartedAt,
      endedAt: this.clock.now(),
      rounds: game.round,
      winnerId,
      players: game.players.map((p, seat) => ({
        userId: p.id,
        seat,
        // Kept for history: 1 means they went out rather than being left
        // holding cards or knocked out.
        roundsWon: p.place === 1 ? 1 : 0,
        finalPlace: p.place ?? (standings.indexOf(p.id) >= 0 ? standings.indexOf(p.id) + 1 : standings.length + 1),
      })),
    });

    // Drop anyone who walked out mid-game, and free the seats for a rematch.
    for (const m of [...this.members.values()]) {
      if (m.departed) this.members.delete(m.userId);
    }
    this.reassignHostIfNeeded();
    this.broadcastRoom();
  }

  /** Wipe the finished game so the same room can deal a rematch. */
  resetToLobby(hostId: string): void {
    this.assertHost(hostId);
    this.clearTurnTimer();
    this.game = null;
    this.status = 'waiting';
    this.eliminationOrder = [];
    this.seatedMembers().forEach((m, i) => (m.seat = i));
    this.touch();
    this.broadcastRoom();
  }

  // -------------------------------------------------------------------------
  // Turn clock
  // -------------------------------------------------------------------------

  private clearTurnTimer(): void {
    if (this.turnHandle !== null) this.clock.clearTimeout(this.turnHandle);
    this.turnHandle = null;
    this.turnEndsAt = null;
  }

  /**
   * (Re)arm the clock for whoever must act.
   *
   * The deadline is an absolute timestamp shipped to clients, not a duration,
   * so every player's countdown agrees even if delivery was slow.
   */
  private armTurnTimer(): void {
    this.clearTurnTimer();
    if (!this.game || this.status !== 'playing') return;

    const seconds = this.settings.turnSeconds;
    const actor = currentActorId(this.game);
    if (seconds === 0 || !actor) return;

    // With nobody connected there is no one to time out. Left running, the
    // clock would auto-play an abandoned game indefinitely -- and because
    // auto-players shed cards fast, rounds just reset and it would never end.
    if (!this.hasLiveMember()) return;

    this.turnEndsAt = this.clock.now() + seconds * 1000;
    this.turnHandle = this.clock.setTimeout(() => this.onTurnExpired(actor), seconds * 1000);
  }

  private hasLiveMember(): boolean {
    return [...this.members.values()].some((m) => m.connected && !m.departed);
  }

  private onTurnExpired(expectedActor: string): void {
    this.turnHandle = null;
    if (!this.game || this.status !== 'playing') return;
    // The turn may have moved on between scheduling and firing; acting on a
    // stale actor would play a card for the wrong person.
    if (currentActorId(this.game) !== expectedActor) {
      this.armTurnTimer();
      return;
    }
    try {
      this.applyAction(expectedActor, { t: 'timeout', playerId: expectedActor }, true);
    } catch {
      // A timeout should never be illegal, but it must never crash the room.
      this.armTurnTimer();
    }
  }

  // -------------------------------------------------------------------------
  // Chat and voice
  // -------------------------------------------------------------------------

  chat(userId: string, text: string): ChatMessage {
    const member = this.requireMember(userId);
    this.spendChatToken(member);
    const msg: ChatMessage = {
      id: randomUUID(),
      userId,
      displayName: member.displayName,
      text,
      at: this.clock.now(),
    };
    this.touch();
    this.transport.toRoom(this.code, 'chat:message', msg);
    return msg;
  }

  react(userId: string, reaction: Reaction): void {
    const member = this.requireMember(userId);
    this.spendChatToken(member);
    this.transport.toRoom(this.code, 'chat:reaction', {
      userId: member.userId,
      reaction,
      at: this.clock.now(),
    });
  }

  private spendChatToken(member: Member): void {
    const now = this.clock.now();
    const refilled = Math.floor((now - member.chatRefilledAt) / CHAT_REFILL_MS);
    if (refilled > 0) {
      member.chatTokens = Math.min(CHAT_BURST, member.chatTokens + refilled);
      member.chatRefilledAt = now;
    }
    if (member.chatTokens <= 0) throw new RoomError('rate_limited', 'slow down a moment');
    member.chatTokens--;
  }

  /** Peers already on voice, which the newcomer sends WebRTC offers to. */
  joinVoice(userId: string): string[] {
    const member = this.requireMember(userId);
    const peers = [...this.members.values()]
      .filter((m) => m.onVoice && m.userId !== userId)
      .map((m) => m.userId);
    member.onVoice = true;
    this.transport.toRoom(this.code, 'voice:peers', { userIds: [...peers, userId] });
    return peers;
  }

  leaveVoice(userId: string): void {
    const member = this.members.get(userId);
    if (!member) return;
    member.onVoice = false;
    member.micOn = false;
    this.transport.toRoom(this.code, 'voice:left', { userId });
    this.broadcastRoom();
  }

  setMic(userId: string, micOn: boolean): void {
    const member = this.requireMember(userId);
    member.micOn = micOn;
    this.transport.toRoom(this.code, 'voice:state', { userId, micOn });
  }

  /** Both parties must be in this room before any SDP or ICE is relayed. */
  canSignal(from: string, to: string): boolean {
    return this.members.has(from) && this.members.has(to) && from !== to;
  }

  private requireMember(userId: string): Member {
    const m = this.members.get(userId);
    if (!m) throw new RoomError('not_in_room', 'you are not in this room');
    return m;
  }

  // -------------------------------------------------------------------------
  // Views and broadcasting
  // -------------------------------------------------------------------------

  view(): RoomView {
    const members: RoomMember[] = [...this.members.values()]
      .filter((m) => !m.departed)
      .sort((a, b) => a.seat - b.seat)
      .map((m) => ({
        id: m.userId,
        displayName: m.displayName,
        avatarUrl: m.avatarUrl,
        seat: m.seat,
        connected: m.connected,
        micOn: m.micOn,
        isHost: m.userId === this.hostId,
      }));

    return {
      code: this.code,
      status: this.status,
      settings: this.settings,
      hostId: this.hostId,
      members,
    };
  }

  broadcastRoom(): void {
    this.transport.toRoom(this.code, 'room:state', this.view());
  }

  /**
   * Push the game to every member individually. This is the anti-cheat seam:
   * each socket gets a state redacted to that player, so an opponent's hand is
   * never on their machine to begin with.
   */
  broadcastGame(events: GameEvent[]): void {
    if (!this.game) return;
    const now = this.clock.now();
    for (const member of this.members.values()) {
      this.transport.toUser(member.userId, 'game:state', {
        view: redactFor(this.game, member.seat >= 0 ? member.userId : null),
        turnEndsAt: this.turnEndsAt,
        serverNow: now,
      });
    }
    if (events.length > 0) this.transport.toRoom(this.code, 'game:events', events);
  }

  private pushGameTo(userId: string): void {
    if (!this.game) return;
    const member = this.members.get(userId);
    this.transport.toUser(userId, 'game:state', {
      view: redactFor(this.game, member && member.seat >= 0 ? userId : null),
      turnEndsAt: this.turnEndsAt,
      serverNow: this.clock.now(),
    });
  }

  /** Called by the manager when reclaiming the room. */
  dispose(): void {
    this.clearTurnTimer();
  }
}

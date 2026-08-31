/**
 * Owns every live room.
 *
 * Rooms live in memory only: a room is a transient thing that exists for one
 * evening, and persisting one would mean reconciling engine state across a
 * restart for no real benefit. Only finished matches reach the database.
 */

import type { RoomSettings } from '@nmu/shared';
import { generateRoomCode } from './codes.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  Room,
  RoomError,
  systemClock,
  type Clock,
  type MatchResult,
  type MemberProfile,
  type RoomTransport,
} from './Room.js';

export interface RoomManagerOptions {
  transport: RoomTransport;
  clock?: Clock;
  roomTtlMs?: number;
  /** How long a disconnected lobby member keeps their slot. */
  graceMs?: number;
  onMatchFinished?: ((result: MatchResult) => void) | undefined;
  /** Fixed RNG seed for every room. Tests only. */
  seed?: number | undefined;
}

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 2 * 60 * 1000;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly clock: Clock;
  private readonly roomTtlMs: number;
  private readonly graceMs: number;

  constructor(private readonly opts: RoomManagerOptions) {
    this.clock = opts.clock ?? systemClock;
    this.roomTtlMs = opts.roomTtlMs ?? DEFAULT_TTL_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  require(code: string): Room {
    const room = this.get(code);
    if (!room) throw new RoomError('not_found', 'no room with that code');
    return room;
  }

  /** The room a user currently sits in, if any. */
  findByUser(userId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.has(userId)) return room;
    }
    return undefined;
  }

  async create(host: MemberProfile, settings: RoomSettings, password: string): Promise<Room> {
    const code = this.allocateCode();
    const room = new Room({
      code,
      host,
      settings,
      passwordHash: await hashPassword(password),
      transport: this.opts.transport,
      clock: this.clock,
      onMatchFinished: this.opts.onMatchFinished,
      seed: this.opts.seed,
    });
    this.rooms.set(code, room);
    return room;
  }

  async join(code: string, password: string, profile: MemberProfile): Promise<Room> {
    const room = this.require(code);

    // A member who is already seated is reconnecting, not joining -- do not
    // make someone re-enter the password because their phone lost signal.
    if (!room.has(profile.userId)) {
      const ok = await verifyPassword(password, room.passwordDigest);
      if (!ok) throw new RoomError('bad_password', 'wrong room password');
    }

    room.join(profile);
    return room;
  }

  destroy(code: string): void {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return;
    room.dispose();
    this.rooms.delete(room.code);
  }

  /**
   * Housekeeping, run on an interval: drop players who never reconnected, then
   * reclaim rooms nobody is left in.
   */
  sweep(): { roomsRemoved: number; playersEvicted: number } {
    let roomsRemoved = 0;
    let playersEvicted = 0;

    for (const room of [...this.rooms.values()]) {
      playersEvicted += room.evictStale(this.graceMs).length;
      if (room.isEmpty && room.idleMs > this.roomTtlMs) {
        this.destroy(room.code);
        roomsRemoved++;
      }
    }
    return { roomsRemoved, playersEvicted };
  }

  disposeAll(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = generateRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate a unique room code');
  }
}

export { RoomError };

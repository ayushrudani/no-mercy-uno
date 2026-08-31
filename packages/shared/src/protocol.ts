/**
 * The wire contract between browser and server.
 *
 * Every client-to-server payload has a zod schema and the server parses it
 * before doing anything else -- a client is an untrusted input source, and the
 * engine should never see a shape it did not expect. The typed event maps at
 * the bottom mean a payload mismatch fails at compile time on both sides
 * instead of surfacing as a confusing runtime bug during a game night.
 */

import { z } from 'zod';
import type { Card, Color, GameEvent, OpponentView, PlayerGameView } from '@nmu/engine';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Room codes omit O/0/I/1 so they survive being read aloud or typed badly. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`), 'invalid room code');

export const colorSchema = z.enum(['red', 'yellow', 'green', 'blue']);

export const displayNameSchema = z.string().trim().min(1).max(24);

/**
 * Usernames are the login identity, so they are normalised hard: lower case,
 * letters/digits/underscore/dot only. Two accounts that differ by case would be
 * indistinguishable when read aloud, which is how you end up joining a room as
 * the wrong person.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'username must be at least 3 characters')
  .max(20, 'username must be at most 20 characters')
  .regex(/^[a-z0-9_.]+$/, 'username may only use letters, numbers, _ and .');

/**
 * Passwords are checked for length only.
 *
 * Composition rules ("one capital, one symbol") push people towards
 * `Password1!` and are not worth the friction for a private game among
 * friends. The upper bound exists because scrypt hashes whatever it is given
 * and an unbounded password is a free way to burn server CPU.
 */
export const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password must be at most 128 characters');

export const chatTextSchema = z.string().trim().min(1).max(500);

/** Turn clock in seconds; 0 disables it. */
export const turnSecondsSchema = z.union([
  z.literal(0),
  z.literal(15),
  z.literal(30),
  z.literal(60),
]);

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/** Reactions are a fixed set: an open emoji field is an abuse surface. */
export const REACTIONS = ['👏', '😂', '😱', '😭', '🔥', '💀', '🤡', '🎉', '👀', '🖕'] as const;
export const reactionSchema = z.enum(REACTIONS);
export type Reaction = (typeof REACTIONS)[number];

// ---------------------------------------------------------------------------
// Room settings
// ---------------------------------------------------------------------------

/** The subset of engine rule flags a host may change from the room screen. */
export const ruleOverridesSchema = z.object({
  /** 7 swaps hands with a player you pick; 0 passes every hand around. */
  sevenZero: z.boolean().optional(),
  /** Press UNO at two cards or be penalised when you play down to one. */
  unoCall: z.boolean().optional(),
  unoPenalty: z.number().int().min(1).max(10).optional(),
  stackRequiresColorMatch: z.boolean().optional(),
  rouletteColorChosenBy: z.enum(['target', 'player']).optional(),
  /** 0 turns knock-out off entirely. */
  eliminationAt: z.union([z.literal(0), z.number().int().min(10).max(40)]).optional(),
  handSize: z.number().int().min(3).max(12).optional(),
});
export type RuleOverrides = z.infer<typeof ruleOverridesSchema>;

export const roomSettingsSchema = z.object({
  name: z.string().trim().min(1).max(40),
  maxPlayers: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
  turnSeconds: turnSecondsSchema,
  rules: ruleOverridesSchema.default({}),
});
export type RoomSettings = z.infer<typeof roomSettingsSchema>;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  name: 'No Mercy',
  maxPlayers: 6,
  turnSeconds: 30,
  // On by default: it is not an official No Mercy rule, but it is how this
  // group plays. The lobby exposes a toggle.
  // Knock-out off by default. Emptying your hand wins you a place and the
  // others play on for second and third; the 25-card cliff is an extra house
  // rule rather than the way the game ends.
  rules: { sevenZero: true, unoCall: true, unoPenalty: 2, eliminationAt: 0 },
};

// ---------------------------------------------------------------------------
// Client -> server payloads
// ---------------------------------------------------------------------------

export const createRoomSchema = z.object({
  settings: roomSettingsSchema,
  password: z.string().min(1).max(64),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export const joinRoomSchema = z.object({
  code: roomCodeSchema,
  password: z.string().min(1).max(64),
});
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;

export const playCardSchema = z.object({
  cardId: z.string().min(1).max(64),
  color: colorSchema.optional(),
});

export const rouletteColorSchema = z.object({ color: colorSchema });

export const swapTargetSchema = z.object({ targetId: z.string().min(1).max(64) });

export const targetUserSchema = z.object({ userId: z.string().min(1).max(64) });

export const chatSendSchema = z.object({ text: chatTextSchema });

export const reactSchema = z.object({ reaction: reactionSchema });

export const profileUpdateSchema = z.object({
  displayName: displayNameSchema.optional(),
  cardBack: z.string().trim().min(1).max(32).optional(),
  sfxVolume: z.number().int().min(0).max(100).optional(),
  micDefaultOn: z.boolean().optional(),
  preferredTurnSeconds: turnSecondsSchema.optional(),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

// Voice signalling. SDP and ICE blobs are relayed verbatim between peers; the
// server never interprets them, it only checks they are strings of sane size
// and that the sender is in the same room as the recipient.
export const voiceSignalSchema = z.object({
  to: z.string().min(1).max(64),
  data: z.string().min(1).max(64_000),
});
export const voiceStateSchema = z.object({ micOn: z.boolean() });

// ---------------------------------------------------------------------------
// Server -> client payloads
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface RoomMember extends PublicUser {
  seat: number;
  connected: boolean;
  /** True once they have a live microphone track. */
  micOn: boolean;
  isHost: boolean;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

/** The lobby / waiting-room view. Sent to everyone in the room. */
export interface RoomView {
  code: string;
  status: RoomStatus;
  settings: RoomSettings;
  hostId: string;
  members: RoomMember[];
}

/**
 * A redacted game snapshot plus the clock. `turnEndsAt` is an absolute server
 * timestamp rather than a remaining duration so a slow or delayed delivery
 * cannot make one client's countdown drift away from another's.
 */
export interface GameSnapshot {
  view: PlayerGameView;
  turnEndsAt: number | null;
  serverNow: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  text: string;
  at: number;
}

export interface ReactionMessage {
  userId: string;
  reaction: Reaction;
  at: number;
}

export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'bad_password'
  | 'room_full'
  | 'already_started'
  | 'not_host'
  | 'illegal_move'
  | 'not_in_room'
  | 'rate_limited'
  | 'bad_request'
  | 'internal';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export type Ack<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };

// ---------------------------------------------------------------------------
// Typed socket event maps
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'room:state': (room: RoomView) => void;
  'game:state': (snapshot: GameSnapshot) => void;
  /** Narration for the previous transition, for animation and sound. */
  'game:events': (events: GameEvent[]) => void;
  'game:over': (payload: { winnerId: string; standings: string[] }) => void;
  'chat:message': (msg: ChatMessage) => void;
  'chat:reaction': (msg: ReactionMessage) => void;
  /** Peers currently on voice. The newcomer offers to each existing peer. */
  'voice:peers': (payload: { userIds: string[] }) => void;
  'voice:offer': (payload: { from: string; data: string }) => void;
  'voice:answer': (payload: { from: string; data: string }) => void;
  'voice:ice': (payload: { from: string; data: string }) => void;
  'voice:state': (payload: { userId: string; micOn: boolean }) => void;
  'voice:left': (payload: { userId: string }) => void;
  error: (err: ErrorPayload) => void;
}

export interface ClientToServerEvents {
  'room:create': (input: CreateRoomInput, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:join': (input: JoinRoomInput, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:leave': (ack: (r: Ack<null>) => void) => void;
  'room:settings': (input: RoomSettings, ack: (r: Ack<null>) => void) => void;
  'room:kick': (input: { userId: string }, ack: (r: Ack<null>) => void) => void;
  'room:transferHost': (input: { userId: string }, ack: (r: Ack<null>) => void) => void;
  'room:start': (ack: (r: Ack<null>) => void) => void;

  'game:play': (input: { cardId: string; color?: Color }, ack: (r: Ack<null>) => void) => void;
  'game:draw': (ack: (r: Ack<null>) => void) => void;
  'game:pass': (ack: (r: Ack<null>) => void) => void;
  'game:rouletteColor': (input: { color: Color }, ack: (r: Ack<null>) => void) => void;
  /** After playing a 7 under the 7-0 rule: whose hand to take. */
  'game:swapTarget': (input: { targetId: string }, ack: (r: Ack<null>) => void) => void;
  /** Press UNO. Not a turn action -- valid whenever you hold two cards. */
  'game:callUno': (ack: (r: Ack<null>) => void) => void;

  'chat:send': (input: { text: string }, ack: (r: Ack<null>) => void) => void;
  'chat:react': (input: { reaction: Reaction }, ack: (r: Ack<null>) => void) => void;

  'voice:join': (ack: (r: Ack<{ userIds: string[] }>) => void) => void;
  'voice:leave': (ack: (r: Ack<null>) => void) => void;
  'voice:offer': (input: { to: string; data: string }) => void;
  'voice:answer': (input: { to: string; data: string }) => void;
  'voice:ice': (input: { to: string; data: string }) => void;
  'voice:state': (input: { micOn: boolean }) => void;

  /** Round-trip probe. The client measures RTT from its own send time. */
  'net:ping': (ack: (serverNow: number) => void) => void;
}

export interface SocketData {
  userId: string;
  displayName: string;
  roomCode: string | null;
}

export type { Card, Color, GameEvent, OpponentView, PlayerGameView };
